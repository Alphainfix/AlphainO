/**
 * The picture index: the vault's pictures (screenshots, photos, diagrams),
 * each embedded as an image by note search's embedding model, so that a
 * description in words finds a picture by what it shows.
 *
 * - It runs only while its setting is on and the model takes pictures
 *   (Gemini Embedding 2, EmbeddingGemma 2 in Ollama): a text-only model has
 *   nothing to compare a picture with.
 * - It waits for the notes: both use the provider's limits, and finding
 *   notes comes first.
 * - A picture is read, shrunk to a JPEG and embedded once, and again only
 *   when its file changes or the model does (one vector per picture: going
 *   back to an earlier model embeds the pictures again).
 * - Pictures in hidden or excluded folders are left out, also from a batch
 *   already under way. Pictures that cannot be decoded here (HEIC), that are
 *   too big, or that the model refuses are counted as left out and not tried
 *   again until they change; a file that could not be read for the moment
 *   (iCloud still downloading it, say) is tried again later.
 */
import type { App, EventRef, TAbstractFile, TFile, Vault } from 'obsidian';
import { int8Cosine } from '@beaver/agent-llm/embeddings';
import { describeEmbeddingFailure } from '@beaver/agent-llm/embeddingHealth';
import { embeddingFailureBlame, indexingResumesAt } from '@beaver/agent-llm/fulltextIndexer';
import { isModelRequestError } from '@beaver/agent-llm/sse';
import { t } from '../i18n';
import type { NoteEmbedder } from './embedder';
import { extensionOf, INDEX_IMAGE, isPicturePath, prepareImage, READABLE_IMAGE_EXTENSIONS, UnreadableImageError, type PreparedImage } from './imagePrep';
import { IdbImageStore, imageDatabaseName, type ImageStore, type ImageStoreOp, type StoredImage } from './imageStore';
import { SearchUnavailableError } from './noteIndex';
import { hasHiddenSegment, isExcludedPath, isUnderFolder, normalizeFolderPath } from './paths';
import { yieldToEventLoop } from './text';

export const IMAGE_SCHEMA_VERSION = 1;
const DEFAULT_DEBOUNCE_MS = 3000;
/** Pictures bigger than this are left out: a scan or a raw photo, not worth reading. */
const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** Gemini takes at most 6 pictures to a request. */
const DEFAULT_BATCH = 6;
const STATUS_THROTTLE_MS = 200;
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;
const MAX_QUERY_CHARS = 2000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
/** Pictures refused one after another before the provider, not the pictures, is blamed. */
const MAX_REFUSALS_IN_A_ROW = 5;
const DEFAULT_READ_RETRY_MS = 60_000;
const MAX_READ_RETRY_MS = 30 * 60_000;

type Timer = ReturnType<typeof setTimeout>;

export interface ImageIndexOptions {
    app: App;
    /** Where the index is kept. Default: IndexedDB, named for this vault. */
    store?: ImageStore;
    /** Note search's embedding model; pictures are indexed only when it takes them. */
    embedder?: NoteEmbedder | null;
    /** The setting. Default off. */
    enabled?: boolean;
    /** Folders (vault paths) left out. */
    excludedFolders?: readonly string[];
    /** Turns a picture file into what is sent. Default: decoded and shrunk in the app (`prepareImage`). */
    prepare?: (bytes: ArrayBuffer, extension: string) => Promise<PreparedImage>;
    /** Resolves when pictures may use the provider: once the notes are indexed. Default: at once. */
    waitForTurn?: () => Promise<void>;
    /** Quiet time after a picture's last change before it is read again, in ms. Default 3000. */
    debounceMs?: number;
    /** Pictures bigger than this many bytes are left out. Default 25 MiB. */
    maxImageBytes?: number;
    /** Pictures per embedding request. Default 6. */
    batchSize?: number;
    /** First wait before reading again a file that could not be read for the moment, in ms; it doubles each time. Default 60 s. */
    readRetryMs?: number;
    /** Where unexpected failures are reported. Default: the console. */
    log?: (message: string, error?: unknown) => void;
}

export type ImageIndexState = 'off' | 'idle' | 'indexing' | 'paused' | 'error';

export interface ImageIndexStatus {
    state: ImageIndexState;
    /** Why it is off: the setting, no embedding model, or a model that embeds text only. */
    offReason: 'disabled' | 'no-model' | 'text-only' | null;
    /** The model the vectors belong to; null while off. */
    model: string | null;
    /** Pictures with a vector from this model. */
    imagesIndexed: number;
    /** Pictures considered: outside hidden and excluded folders, of any picture format. */
    imagesTotal: number;
    /** Pictures waiting to be read and embedded. */
    pending: number;
    /** Pictures left out: a format that cannot be read here, too big, or refused. */
    skipped: number;
    /** Pictures that could not be read for the moment and are tried again later (part of `pending`). */
    retrying: number;
    /** Why the index is paused or in error, as a sentence for the user. */
    lastError: string | null;
    /** When a paused index tries again, in ms since the epoch; null when it waits for the user. */
    retryAt: number | null;
}

export interface ImageHit {
    /** Path of the picture in the vault. */
    path: string;
    /** Its file name. */
    name: string;
    /** Cosine similarity between the description and the picture. */
    similarity: number;
}

export interface ImageSearchResponse {
    hits: ImageHit[];
    /** What the caller should know about the answer: pictures still being indexed. */
    warnings: string[];
}

interface Entry {
    path: string;
    mtime: number;
    size: number;
    vec: Int8Array | null;
    model: string;
    error?: string;
}

function isFile(file: TAbstractFile | null | undefined): file is TFile {
    return !!file && 'extension' in file && 'stat' in file;
}

function isFolder(file: TAbstractFile): boolean {
    return 'children' in file;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function appIdOf(app: App): string {
    const id = (app as unknown as { appId?: unknown }).appId;
    return typeof id === 'string' && id !== '' ? id : app.vault.getName();
}

/** The vector inside a stored value, whichever realm made it. */
function asInt8(value: unknown): Int8Array | null {
    if (value instanceof Int8Array) return value;
    if (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Int8Array]') {
        const view = value as Int8Array;
        return new Int8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    }
    return null;
}

/** A failure that waiting cannot fix: the key, the model name or the address is wrong. */
function isHardFailure(error: unknown): boolean {
    return isModelRequestError(error) && (error.status === 401 || error.status === 403 || error.status === 404 || error.code === 'invalid_api_key');
}

function nameOf(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

export class ImageIndex {
    private readonly vault: Vault;
    private readonly store: ImageStore;
    private embedder: NoteEmbedder | null;
    private enabled: boolean;
    private excluded: string[];
    private readonly prepare: (bytes: ArrayBuffer, extension: string) => Promise<PreparedImage>;
    private readonly waitForTurn: () => Promise<void>;
    private readonly debounceMs: number;
    private readonly maxImageBytes: number;
    private readonly batchSize: number;
    private readonly readRetryMs: number;
    private readonly log: (message: string, error?: unknown) => void;

    private running = false;
    private loaded = false;
    private startPromise: Promise<void> | null = null;
    /** Bumped by stop and rebuild: work from before ends quietly. */
    private epoch = 0;
    /** Bumped when the model changes: vectors on their way from the old one are dropped. */
    private modelEpoch = 0;
    private entries = new Map<string, Entry>();
    private timers = new Map<string, Timer>();
    /** Pictures being read or embedded now. */
    private inFlight = new Set<string>();
    private pumping = false;
    private pumpPromise: Promise<void> | null = null;
    private abort: AbortController | null = null;
    private paused = false;
    private retryAt: number | null = null;
    private retryTimer: Timer | null = null;
    private consecutiveFailures = 0;
    private refusalsInARow = 0;
    private lastError: string | null = null;
    private fatal: string | null = null;
    private storageError: string | null = null;
    private writes: Promise<void> = Promise.resolve();
    private refs: EventRef[] = [];
    private readonly listeners = new Set<(status: ImageIndexStatus) => void>();
    private lastEmitAt = 0;
    /** A status held back by the throttle, sent when it ends. */
    private emitTimer: Timer | null = null;
    private idleWaiters: Array<() => void> = [];
    /** Files that could not be read for the moment: how often, and not before when. */
    private deferred = new Map<string, { count: number; until: number }>();
    private deferTimer: Timer | null = null;

    constructor(options: ImageIndexOptions) {
        this.vault = options.app.vault;
        this.store = options.store ?? new IdbImageStore(imageDatabaseName(appIdOf(options.app)));
        this.embedder = options.embedder ?? null;
        this.enabled = options.enabled ?? false;
        this.excluded = (options.excludedFolders ?? []).map(normalizeFolderPath).filter((folder) => folder !== '');
        // The main window's document: a popout window that closes would take its canvas along.
        this.prepare = options.prepare ?? ((bytes, extension) => prepareImage(bytes, extension, { ...INDEX_IMAGE, doc: document }));
        this.waitForTurn = options.waitForTurn ?? (() => Promise.resolve());
        this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
        this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
        this.readRetryMs = Math.max(1, options.readRetryMs ?? DEFAULT_READ_RETRY_MS);
        this.log = options.log ?? ((message, error) => console.warn(`[AlphainO] ${message}`, error ?? ''));
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /**
     * Loads the stored index and starts following the vault. Resolves when the
     * index is loaded and the work is queued. `register` receives each vault
     * listener, so Obsidian can remove them when the plugin unloads.
     */
    start(register?: (ref: EventRef) => void): Promise<void> {
        if (this.startPromise && !this.fatal) return this.startPromise;
        if (this.startPromise) {
            this.store.close();
            this.reset();
        }
        this.running = true;
        this.fatal = null;
        const epoch = ++this.epoch;
        this.startPromise = this.load(epoch, register);
        this.emit(true);
        return this.startPromise;
    }

    private async load(epoch: number, register?: (ref: EventRef) => void): Promise<void> {
        try {
            await this.store.open();
            const stored = await this.store.load();
            if (!this.alive(epoch)) return;
            for (const image of stored.images) {
                this.entries.set(image.path, {
                    path: image.path,
                    mtime: image.mtime,
                    size: image.size,
                    vec: asInt8(image.embedding),
                    model: image.model ?? '',
                    ...(image.error ? { error: image.error } : {}),
                });
            }
            if (stored.meta?.schema !== IMAGE_SCHEMA_VERSION) {
                await this.persist([{ type: 'meta', meta: { key: 'images', schema: IMAGE_SCHEMA_VERSION, model: null } }]);
            }
        } catch (error) {
            if (!this.alive(epoch)) return;
            this.fatal = t('Could not load the picture index: {reason}', { reason: errorText(error) });
            this.log('Could not load the picture index.', error);
            this.emit(true);
            this.releaseIdleWaiters();
            return;
        }
        if (!this.alive(epoch)) return;
        this.loaded = true;
        this.listen(register);
        this.reconcile();
        this.kick();
        this.emit(true);
        this.releaseIdleWaiters();
    }

    /** Stops following the vault, ends work in flight and saves what is pending. */
    async stop(): Promise<void> {
        if (!this.running && !this.startPromise) return;
        this.running = false;
        this.epoch += 1;
        this.abort?.abort();
        this.clearTimers();
        this.clearPause();
        for (const ref of this.refs) this.vault.offref(ref);
        this.refs = [];
        try {
            await this.startPromise;
        } catch {
            // reported by load
        }
        await this.pumpPromise;
        await this.writes;
        this.store.close();
        this.reset();
        this.startPromise = null;
        this.loaded = false;
        this.emit(true);
        this.releaseIdleWaiters();
    }

    /** Throws the vectors away and embeds every picture again. */
    async rebuild(): Promise<void> {
        if (!this.running) return;
        if (this.fatal) {
            await this.start();
            return;
        }
        await this.startPromise;
        if (!this.running || !this.loaded) return;
        this.epoch += 1;
        this.abort?.abort();
        this.clearTimers();
        await this.pumpPromise;
        this.entries.clear();
        this.inFlight.clear();
        this.deferred.clear();
        this.clearPause();
        this.consecutiveFailures = 0;
        this.refusalsInARow = 0;
        this.lastError = null;
        this.writes = this.writes.then(() => this.store.clear()).catch((error) => this.storageFailed(error));
        await this.persist([{ type: 'meta', meta: { key: 'images', schema: IMAGE_SCHEMA_VERSION, model: null } }]);
        this.reconcile();
        this.kick();
        this.emit(true);
    }

    /** Tries again now, after a pause. */
    retry(): void {
        // The stored index could not be loaded: load it again.
        if (this.fatal && this.running) {
            void this.start();
            return;
        }
        this.clearPause();
        this.consecutiveFailures = 0;
        this.deferred.clear();
        this.kick();
        this.emit(true);
    }

    /** Resolves when nothing is queued or running and what was made is saved (or the index is off or paused). */
    async whenIdle(): Promise<void> {
        for (;;) {
            if (!this.quiet()) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
            const writes = this.writes;
            await writes;
            if (this.quiet() && writes === this.writes) return;
        }
    }

    /** The setting changed. */
    setEnabled(on: boolean): void {
        if (on === this.enabled) return;
        this.enabled = on;
        if (!this.active()) this.abort?.abort();
        this.kick();
        this.emit(true);
    }

    /** Note search's embedding model changed (or was turned off). */
    setEmbedder(next: NoteEmbedder | null): void {
        const before = this.activeModel();
        this.embedder = next;
        const after = this.activeModel();
        this.clearPause();
        this.consecutiveFailures = 0;
        this.refusalsInARow = 0;
        this.lastError = null;
        if (before !== after) {
            this.modelEpoch += 1;
            this.abort?.abort();
        }
        this.kick();
        this.emit(true);
    }

    /** The folders left out changed. */
    setExcludedFolders(folders: readonly string[]): void {
        const next = folders.map(normalizeFolderPath).filter((folder) => folder !== '');
        const same = next.length === this.excluded.length && next.every((folder, i) => folder === this.excluded[i]);
        this.excluded = next;
        if (same || !this.running || !this.loaded) return;
        this.reconcile();
        // A picture now left out may be in the batch under way: end it before it is sent.
        if ([...this.inFlight].some((path) => !this.considered(path))) this.abort?.abort();
        this.kick();
        this.emit(true);
    }

    /** Whether pictures are indexed and searched now: the setting is on and the model takes pictures. */
    active(): boolean {
        return this.enabled && this.embedder?.embedsImages === true && typeof this.embedder.embedImages === 'function';
    }

    private activeModel(): string | null {
        return this.active() ? (this.embedder?.modelId ?? null) : null;
    }

    // -----------------------------------------------------------------------
    // Status
    // -----------------------------------------------------------------------

    status(): ImageIndexStatus {
        const model = this.activeModel();
        const offReason: ImageIndexStatus['offReason'] = !this.enabled ? 'disabled' : !this.embedder ? 'no-model' : !this.active() ? 'text-only' : null;
        let indexed = 0;
        let skipped = 0;
        let pending = 0;
        for (const entry of this.entries.values()) {
            if (entry.error && (entry.model === '' || entry.model === model)) skipped += 1;
            else if (entry.vec && entry.model === model) indexed += 1;
            else pending += 1;
        }
        for (const path of this.timers.keys()) if (!this.entries.has(path)) pending += 1;
        let retrying = 0;
        for (const path of this.deferred.keys()) if (this.entries.has(path)) retrying += 1;
        let state: ImageIndexState;
        if (!this.running || offReason) state = 'off';
        else if (this.fatal || this.storageError) state = 'error';
        else if (this.paused && pending > 0) state = 'paused';
        else if (this.pumping || this.timers.size > 0 || (this.startPromise !== null && !this.loaded)) state = 'indexing';
        else state = 'idle';
        return {
            state,
            offReason,
            model,
            imagesIndexed: model ? indexed : 0,
            imagesTotal: this.entries.size,
            pending: model ? pending : 0,
            skipped,
            retrying: model ? retrying : 0,
            lastError: this.fatal ?? this.storageError ?? this.lastError,
            retryAt: this.paused ? this.retryAt : null,
        };
    }

    /** Be told when the status changes; returns the unsubscribe. Changes that are only counts are throttled. */
    onStatusChange(listener: (status: ImageIndexStatus) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private emit(force = false): void {
        if (this.listeners.size === 0) return;
        const now = Date.now();
        if (!force && now - this.lastEmitAt < STATUS_THROTTLE_MS) {
            // Held back, not dropped: the last status of a burst is the one that stays on screen.
            this.emitTimer ??= setTimeout(() => {
                this.emitTimer = null;
                this.emit(true);
            }, STATUS_THROTTLE_MS - (now - this.lastEmitAt));
            return;
        }
        if (this.emitTimer) {
            clearTimeout(this.emitTimer);
            this.emitTimer = null;
        }
        this.lastEmitAt = now;
        const status = this.status();
        for (const listener of [...this.listeners]) {
            try {
                listener(status);
            } catch (error) {
                this.log('A status listener failed.', error);
            }
        }
    }

    private quiet(): boolean {
        if (!this.running) return true;
        if (this.startPromise !== null && !this.loaded && !this.fatal) return false;
        return !this.pumping && this.timers.size === 0 && !this.canEmbed();
    }

    private releaseIdleWaiters(): void {
        if (!this.quiet()) return;
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
    }

    private alive(epoch: number): boolean {
        return this.running && epoch === this.epoch;
    }

    // -----------------------------------------------------------------------
    // Following the vault
    // -----------------------------------------------------------------------

    /** Whether a path is a picture this index considers: not hidden, not excluded. */
    private considered(path: string): boolean {
        return isPicturePath(path) && !hasHiddenSegment(path) && !isExcludedPath(path, this.excluded);
    }

    private listen(register?: (ref: EventRef) => void): void {
        const add = (ref: EventRef) => {
            this.refs.push(ref);
            register?.(ref);
        };
        add(this.vault.on('create', (file) => isFile(file) && this.considered(file.path) && this.schedule(file.path)));
        add(this.vault.on('modify', (file) => isFile(file) && this.considered(file.path) && this.schedule(file.path)));
        add(this.vault.on('delete', (file) => this.removed(file.path, isFolder(file))));
        add(this.vault.on('rename', (file, oldPath) => this.renamed(file, oldPath)));
    }

    private schedule(path: string): void {
        const old = this.timers.get(path);
        if (old) clearTimeout(old);
        this.timers.set(
            path,
            setTimeout(() => {
                this.timers.delete(path);
                this.refresh(path);
                this.kick();
                this.emit();
            }, this.debounceMs),
        );
        this.emit();
    }

    /** Reads a picture's file details again: a new or changed file needs a new vector. */
    private refresh(path: string): void {
        if (!this.running || !this.loaded) return;
        const file = this.vault.getAbstractFileByPath(path);
        if (!isFile(file) || !this.considered(path)) {
            this.forget(path);
            return;
        }
        const entry = this.entries.get(path);
        const { mtime, size } = file.stat;
        if (entry && entry.mtime === mtime && entry.size === size) return;
        const next: Entry = { path, mtime, size, vec: null, model: '' };
        this.markUnreadable(next);
        this.entries.set(path, next);
        // A changed file is read again at once, whatever happened to the old one.
        this.deferred.delete(path);
        void this.persist([{ type: 'put', image: this.stored(next) }]);
    }

    /** A picture that will not be read: a format the app cannot open, or too big. */
    private markUnreadable(entry: Entry): void {
        const extension = extensionOf(entry.path);
        if (!READABLE_IMAGE_EXTENSIONS.has(extension)) entry.error = t('{format} pictures cannot be opened here.', { format: extension.toUpperCase() });
        else if (entry.size > this.maxImageBytes) entry.error = t('Too big to read ({size} MB).', { size: Math.round(entry.size / 1048576) });
    }

    private forget(path: string): void {
        if (!this.entries.delete(path)) return;
        void this.persist([{ type: 'delete', path }]);
    }

    private removed(path: string, folder: boolean): void {
        if (!this.running || !this.loaded) return;
        const timer = this.timers.get(path);
        if (timer) clearTimeout(timer);
        this.timers.delete(path);
        if (folder) {
            const ops: ImageStoreOp[] = [];
            for (const key of [...this.entries.keys()]) {
                if (isUnderFolder(key, path)) {
                    this.entries.delete(key);
                    ops.push({ type: 'delete', path: key });
                }
            }
            void this.persist(ops);
        } else {
            this.forget(path);
        }
        this.deferred.delete(path);
        this.emit();
        this.releaseIdleWaiters();
    }

    /** A renamed picture keeps its vector; a renamed folder takes its pictures' vectors along. */
    private renamed(file: TAbstractFile, oldPath: string): void {
        if (!this.running || !this.loaded) return;
        const moves: Array<[string, string]> = [];
        if (isFolder(file)) {
            for (const key of this.entries.keys()) {
                if (isUnderFolder(key, oldPath)) moves.push([key, `${file.path}${key.slice(oldPath.length)}`]);
            }
        } else if (this.entries.has(oldPath) || this.considered(file.path)) {
            moves.push([oldPath, file.path]);
        }
        const ops: ImageStoreOp[] = [];
        for (const [from, to] of moves) {
            const entry = this.entries.get(from);
            this.entries.delete(from);
            ops.push({ type: 'delete', path: from });
            if (!this.considered(to)) continue;
            if (entry) {
                entry.path = to;
                this.entries.set(to, entry);
                ops.push({ type: 'put', image: this.stored(entry) });
            } else {
                this.schedule(to);
            }
        }
        void this.persist(ops);
        if (isFolder(file)) this.reconcile();
        this.kick();
        this.emit();
    }

    /** Brings the entries in line with the vault: new and changed pictures in, removed and excluded ones out. */
    private reconcile(): void {
        const seen = new Set<string>();
        const ops: ImageStoreOp[] = [];
        for (const file of this.vault.getFiles()) {
            if (!this.considered(file.path)) continue;
            seen.add(file.path);
            const entry = this.entries.get(file.path);
            const { mtime, size } = file.stat;
            if (entry && entry.mtime === mtime && entry.size === size) continue;
            const next: Entry = { path: file.path, mtime, size, vec: null, model: '' };
            this.markUnreadable(next);
            this.entries.set(file.path, next);
            ops.push({ type: 'put', image: this.stored(next) });
        }
        for (const path of [...this.entries.keys()]) {
            if (seen.has(path)) continue;
            this.entries.delete(path);
            ops.push({ type: 'delete', path });
        }
        void this.persist(ops);
    }

    // -----------------------------------------------------------------------
    // Embedding
    // -----------------------------------------------------------------------

    /** Whether a picture still needs a vector from the current model. */
    private needs(entry: Entry, model: string): boolean {
        if (entry.error && (entry.model === '' || entry.model === model)) return false;
        return !(entry.vec && entry.model === model);
    }

    /** Whether a file that could not be read for the moment must wait longer. */
    private waiting(path: string, now: number): boolean {
        const later = this.deferred.get(path);
        return later !== undefined && later.until > now;
    }

    private canEmbed(): boolean {
        const model = this.activeModel();
        if (!model || this.paused || !this.loaded) return false;
        const now = Date.now();
        for (const entry of this.entries.values()) if (!this.inFlight.has(entry.path) && !this.waiting(entry.path, now) && this.needs(entry, model)) return true;
        return false;
    }

    /** Comes back for the files that could not be read when the first of them is due. */
    private wakeForDeferred(): void {
        if (this.deferTimer) clearTimeout(this.deferTimer);
        this.deferTimer = null;
        let next = Infinity;
        for (const [path, later] of this.deferred) if (this.entries.has(path)) next = Math.min(next, later.until);
        if (!Number.isFinite(next) || !this.running) return;
        this.deferTimer = setTimeout(() => {
            this.deferTimer = null;
            this.kick();
            this.emit(true);
        }, Math.max(0, next - Date.now()));
    }

    private kick(): void {
        if (this.pumping || !this.running || !this.loaded || !this.canEmbed()) {
            this.releaseIdleWaiters();
            return;
        }
        this.pumping = true;
        const epoch = this.epoch;
        this.pumpPromise = this.pump(epoch)
            .catch((error) => this.log('Picture indexing stopped unexpectedly.', error))
            .finally(() => {
                this.pumping = false;
                this.inFlight.clear();
                this.emit(true);
                // More may have come in while the last batch ran.
                if (this.alive(epoch) && this.canEmbed()) this.kick();
                else this.releaseIdleWaiters();
            });
        this.emit(true);
    }

    private async pump(epoch: number): Promise<void> {
        while (this.alive(epoch) && this.canEmbed()) {
            // The notes first.
            const controller = new AbortController();
            this.abort = controller;
            await Promise.race([
                this.waitForTurn(),
                new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true })),
            ]);
            if (controller.signal.aborted || !this.alive(epoch) || !this.canEmbed()) break;
            const embedder = this.embedder as NoteEmbedder;
            const model = embedder.modelId;
            const modelEpoch = this.modelEpoch;
            const batch: Entry[] = [];
            const now = Date.now();
            for (const entry of this.entries.values()) {
                if (batch.length >= this.batchSize) break;
                if (!this.inFlight.has(entry.path) && !this.waiting(entry.path, now) && this.needs(entry, model)) batch.push(entry);
            }
            for (const entry of batch) this.inFlight.add(entry.path);
            this.emit();
            const ready = await this.read(batch, epoch);
            if (!this.alive(epoch) || controller.signal.aborted) break;
            if (ready.length > 0) {
                const ok = await this.embed(ready, embedder, model, epoch, modelEpoch, controller);
                if (!ok) break;
            }
            for (const entry of batch) this.inFlight.delete(entry.path);
            this.emit();
            await yieldToEventLoop();
        }
        this.abort = null;
    }

    /** Reads and shrinks the pictures of a batch; one that cannot be read is marked and left out. */
    private async read(batch: Entry[], epoch: number): Promise<Array<{ entry: Entry; image: PreparedImage; mtime: number; size: number }>> {
        const ready: Array<{ entry: Entry; image: PreparedImage; mtime: number; size: number }> = [];
        for (const entry of batch) {
            if (!this.alive(epoch)) return ready;
            // Removed, renamed or excluded since the batch was made: not read, not sent.
            if (this.entries.get(entry.path) !== entry || !this.considered(entry.path)) continue;
            const file = this.vault.getAbstractFileByPath(entry.path);
            if (!isFile(file)) {
                this.forget(entry.path);
                continue;
            }
            const { mtime, size } = file.stat;
            try {
                const bytes = await this.vault.readBinary(file);
                const image = await this.prepare(bytes, extensionOf(entry.path));
                this.deferred.delete(entry.path);
                ready.push({ entry, image, mtime, size });
            } catch (error) {
                if (!this.alive(epoch)) return ready;
                if (this.entries.get(entry.path) !== entry) continue;
                if (error instanceof UnreadableImageError) {
                    // The picture itself cannot be decoded here: left out until the file changes.
                    entry.mtime = mtime;
                    entry.size = size;
                    entry.vec = null;
                    entry.model = '';
                    entry.error = error.message;
                    this.deferred.delete(entry.path);
                    void this.persist([{ type: 'put', image: this.stored(entry) }]);
                } else {
                    // The file could not be read just now (still downloading, busy): try it again later, longer each time.
                    const count = (this.deferred.get(entry.path)?.count ?? 0) + 1;
                    const wait = Math.min(this.readRetryMs * 2 ** (count - 1), MAX_READ_RETRY_MS);
                    this.deferred.set(entry.path, { count, until: Date.now() + wait });
                    this.log(`Could not read ${entry.path} for the picture index; trying again later.`, error);
                    this.wakeForDeferred();
                }
            }
        }
        return ready;
    }

    /** Embeds a batch; false when indexing should stop for now (a pause, a stop, a new model). */
    private async embed(
        ready: Array<{ entry: Entry; image: PreparedImage; mtime: number; size: number }>,
        embedder: NoteEmbedder,
        model: string,
        epoch: number,
        modelEpoch: number,
        controller: AbortController,
    ): Promise<boolean> {
        // Excluded or removed while they were being read: they are not sent.
        ready = ready.filter((item) => this.entries.get(item.entry.path) === item.entry && this.considered(item.entry.path));
        if (ready.length === 0) return true;
        try {
            const vectors = await (embedder.embedImages as NonNullable<NoteEmbedder['embedImages']>)(
                ready.map((item) => ({ mimeType: item.image.mimeType, base64: item.image.base64 })),
                controller.signal,
            );
            if (!this.alive(epoch) || modelEpoch !== this.modelEpoch) return false;
            if (vectors.length !== ready.length) throw new Error(`${embedder.label} returned ${vectors.length} embeddings for ${ready.length} pictures.`);
            this.apply(ready, vectors, model);
            this.succeeded();
            return true;
        } catch (error) {
            if (!this.alive(epoch) || modelEpoch !== this.modelEpoch || controller.signal.aborted) return false;
            if (embeddingFailureBlame(error) === 'document' && ready.length > 1) return this.isolate(ready, embedder, model, epoch, modelEpoch, controller);
            if (embeddingFailureBlame(error) === 'document') {
                return this.refused(ready[0], model, error, embedder);
            }
            this.pauseForFailure(error, embedder);
            return false;
        }
    }

    /** The provider refused a batch for what is in it: send the pictures one at a time to find the ones it will not take. */
    private async isolate(
        ready: Array<{ entry: Entry; image: PreparedImage; mtime: number; size: number }>,
        embedder: NoteEmbedder,
        model: string,
        epoch: number,
        modelEpoch: number,
        controller: AbortController,
    ): Promise<boolean> {
        for (const item of ready) {
            if (!this.alive(epoch) || modelEpoch !== this.modelEpoch || controller.signal.aborted) return false;
            if (this.entries.get(item.entry.path) !== item.entry || !this.considered(item.entry.path)) continue;
            try {
                const vectors = await (embedder.embedImages as NonNullable<NoteEmbedder['embedImages']>)(
                    [{ mimeType: item.image.mimeType, base64: item.image.base64 }],
                    controller.signal,
                );
                if (!this.alive(epoch) || modelEpoch !== this.modelEpoch) return false;
                this.apply([item], vectors, model);
                this.refusalsInARow = 0;
            } catch (error) {
                if (!this.alive(epoch) || modelEpoch !== this.modelEpoch || controller.signal.aborted) return false;
                if (embeddingFailureBlame(error) !== 'document') {
                    this.pauseForFailure(error, embedder);
                    return false;
                }
                if (!this.refused(item, model, error, embedder)) return false;
            }
        }
        this.succeeded();
        return true;
    }

    /** Marks a picture the model will not take; false when too many in a row say the setup is wrong. */
    private refused(item: { entry: Entry; mtime: number; size: number }, model: string, error: unknown, embedder: NoteEmbedder): boolean {
        this.refusalsInARow += 1;
        if (this.refusalsInARow >= MAX_REFUSALS_IN_A_ROW) {
            this.pauseForFailure(error, embedder, true);
            return false;
        }
        const { entry } = item;
        if (this.entries.get(entry.path) !== entry) return true;
        entry.mtime = item.mtime;
        entry.size = item.size;
        entry.vec = null;
        entry.model = model;
        entry.error = describeEmbeddingFailure(error, embedder.label);
        void this.persist([{ type: 'put', image: this.stored(entry) }]);
        return true;
    }

    private apply(ready: Array<{ entry: Entry; mtime: number; size: number }>, vectors: Int8Array[], model: string): void {
        const ops: ImageStoreOp[] = [];
        ready.forEach((item, i) => {
            const { entry } = item;
            // Removed, or changed again while it was being embedded: the newer file gets its own turn.
            if (this.entries.get(entry.path) !== entry) return;
            const file = this.vault.getAbstractFileByPath(entry.path);
            if (isFile(file) && (file.stat.mtime !== item.mtime || file.stat.size !== item.size)) {
                entry.mtime = item.mtime;
                entry.size = item.size;
                this.schedule(entry.path);
            }
            entry.mtime = item.mtime;
            entry.size = item.size;
            entry.vec = vectors[i];
            entry.model = model;
            delete entry.error;
            ops.push({ type: 'put', image: this.stored(entry) });
        });
        void this.persist(ops);
    }

    private succeeded(): void {
        this.consecutiveFailures = 0;
        this.refusalsInARow = 0;
        this.lastError = null;
        this.clearPause();
    }

    private pauseForFailure(error: unknown, embedder: NoteEmbedder, hard = false): void {
        this.consecutiveFailures += 1;
        this.lastError = describeEmbeddingFailure(error, embedder.label);
        let retryAt: number | null = null;
        if (!hard && !isHardFailure(error)) {
            // A spent day resumes at its reset; a limit says when to come back; anything else waits longer each time.
            const asked = isModelRequestError(error) && error.retryAfterMs !== undefined ? error.retryAfterMs : 0;
            const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1), BACKOFF_MAX_MS);
            retryAt = indexingResumesAt(error) ?? Date.now() + Math.max(asked, backoff);
        }
        this.clearPause();
        this.paused = true;
        this.retryAt = retryAt;
        if (retryAt !== null) {
            this.retryTimer = setTimeout(() => {
                this.retryTimer = null;
                this.clearPause();
                this.kick();
                this.emit(true);
            }, Math.max(0, retryAt - Date.now()));
        }
        this.emit(true);
    }

    private clearPause(): void {
        this.paused = false;
        this.retryAt = null;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    // -----------------------------------------------------------------------
    // Searching
    // -----------------------------------------------------------------------

    /** The pictures that look most like a description, best first. */
    async search(query: string, options: { limit?: number; folder?: string; signal?: AbortSignal } = {}): Promise<ImageSearchResponse> {
        if (!this.running) throw new SearchUnavailableError(t('Picture search is off.'));
        await this.startPromise;
        if (this.fatal) throw new SearchUnavailableError(this.fatal);
        const status = this.status();
        if (status.offReason === 'disabled') throw new SearchUnavailableError(t('Picture search is turned off in AlphainO’s settings (Note search → Pictures).'));
        if (status.offReason === 'no-model') throw new SearchUnavailableError(t('Picture search needs an embedding model in AlphainO’s settings (Note search).'));
        if (status.offReason === 'text-only') {
            throw new SearchUnavailableError(t('The embedding model in AlphainO’s settings reads text only. Picture search needs Google Gemini or Ollama (EmbeddingGemma 2).'));
        }
        const embedder = this.embedder as NoteEmbedder;
        const model = embedder.modelId;
        const text = query.trim().slice(0, MAX_QUERY_CHARS);
        if (!text) throw new Error('Describe the picture to look for.');
        const vector = await embedder.embedQuery(text, options.signal);
        const folder = options.folder ? normalizeFolderPath(options.folder) : '';
        const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)));
        const scored: ImageHit[] = [];
        for (const entry of this.entries.values()) {
            if (!entry.vec || entry.model !== model) continue;
            if (folder && !isUnderFolder(entry.path, folder)) continue;
            if (!this.considered(entry.path)) continue;
            let similarity: number;
            try {
                similarity = int8Cosine(vector, entry.vec);
            } catch {
                continue;
            }
            scored.push({ path: entry.path, name: nameOf(entry.path), similarity });
        }
        scored.sort((a, b) => b.similarity - a.similarity);
        const warnings: string[] = [];
        const counts = { done: status.imagesIndexed, total: status.imagesTotal - status.skipped };
        if (status.state === 'paused' || status.state === 'error') {
            warnings.push(
                t('Picture indexing has stopped ({reason}): {done} of {total} pictures are indexed, so a picture that is not found may only not be indexed.', {
                    reason: status.lastError ?? t('paused'),
                    ...counts,
                }),
            );
        } else if (status.pending > 0) {
            warnings.push(t('Pictures are still being indexed: {done} of {total} so far, so a picture that is not found may only not be indexed yet.', counts));
        }
        if (status.skipped > 0) {
            warnings.push(
                t('{count} pictures could not be indexed (a format this app cannot open, such as HEIC, too big, or refused by the model) and are never found.', {
                    count: status.skipped,
                }),
            );
        }
        return { hits: scored.slice(0, limit), warnings };
    }

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    private stored(entry: Entry): StoredImage {
        return {
            path: entry.path,
            mtime: entry.mtime,
            size: entry.size,
            embedding: entry.vec,
            model: entry.model,
            ...(entry.error !== undefined ? { error: entry.error } : {}),
        };
    }

    private persist(ops: ImageStoreOp[]): Promise<void> {
        if (ops.length === 0) return this.writes;
        this.writes = this.writes
            .then(() => this.store.write(ops))
            .then(() => {
                if (this.storageError) {
                    this.storageError = null;
                    this.emit(true);
                }
            })
            .catch((error) => this.storageFailed(error));
        return this.writes;
    }

    private storageFailed(error: unknown): void {
        this.storageError = t('Could not save the picture index: {reason}', { reason: errorText(error) });
        this.log('Could not save the picture index.', error);
        this.emit(true);
    }

    private clearTimers(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        if (this.deferTimer) clearTimeout(this.deferTimer);
        this.deferTimer = null;
        if (this.emitTimer) clearTimeout(this.emitTimer);
        this.emitTimer = null;
    }

    private reset(): void {
        this.entries = new Map();
        this.inFlight.clear();
        this.deferred.clear();
        this.clearTimers();
        this.clearPause();
        this.consecutiveFailures = 0;
        this.refusalsInARow = 0;
        this.lastError = null;
        this.storageError = null;
        this.abort = null;
    }
}
