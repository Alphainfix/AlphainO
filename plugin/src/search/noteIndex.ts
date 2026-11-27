/**
 * The search index over the vault's Markdown notes.
 *
 * What it keeps, and where: every note's passages (text, heading path, lines)
 * and their int8 vectors are in memory for searching and in IndexedDB on this
 * computer for the next start. Search is a scan of the passages in memory:
 * cosine similarity for meaning, BM25 for keywords, fused by rank.
 *
 * How it stays current: on start the stored index is checked against the
 * vault (new, deleted and changed notes, including edits made while Obsidian
 * was closed), and while running the vault's create, modify, delete and rename
 * events are followed. A changed note is read again about three seconds after
 * its last change, cut into passages again, and only passages whose text is new
 * are embedded: the vectors of the others are kept. A rename moves a note's
 * records without embedding anything.
 *
 * Two kinds of work, one queue, one thing at a time:
 * - indexing a note (read, hash, cut, store) is local and quick, and keeps
 *   keyword search current whatever the embedding provider is doing;
 * - embedding the passages that have no vector yet is the slow part, batched
 *   across notes, one request at a time, backing off when the provider fails.
 */
import type { App, EventRef, TAbstractFile, TFile, Vault } from 'obsidian';
import { int8Cosine } from '@beaver/agent-llm/embeddings';
import { describeEmbeddingFailure } from '@beaver/agent-llm/embeddingHealth';
import { embeddingFailureBlame, indexingResumesAt } from '@beaver/agent-llm/fulltextIndexer';
import { isModelRequestError } from '@beaver/agent-llm/sse';
import { t } from '../i18n';
import { CHUNKER_VERSION, chunkHash, chunkNote, embeddingText } from './chunker';
import type { NoteEmbedder } from './embedder';
import { IdbIndexStore, indexDatabaseName } from './idbStore';
import { bm25Rank, phraseTest } from './keyword';
import { isIndexablePath, isUnderFolder, normalizeFolderPath, titleOf } from './paths';
import { hashString, normalizeText, parseQuery, queryTerms, trimText, yieldToEventLoop } from './text';
import type {
    IndexMeta,
    IndexState,
    IndexStatus,
    IndexStore,
    NoteInfo,
    NoteSearcher,
    SearchHit,
    SearchOptions,
    SearchResponse,
    StoredChunk,
    StoredIndex,
    StoredNote,
    StoreOp,
} from './types';

/** The layout of the stored records. */
export const SCHEMA_VERSION = 1;

const DEFAULT_DEBOUNCE_MS = 3000;
/** Notes bigger than this are not indexed. */
const DEFAULT_MAX_NOTE_BYTES = 1024 * 1024;
/** Passages per embedding request; the provider cuts it further when its own limit is lower. */
const DEFAULT_EMBED_BATCH = 32;
/** Longest the queue works before it lets the interface breathe, in ms. */
const SLICE_MS = 12;
/** Progress updates are passed on at most this often; changes of state always are. */
const STATUS_THROTTLE_MS = 200;

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
const RESULT_TEXT_CHARS = 1200;
const MAX_QUERY_CHARS = 2000;
/** Passages each ranking contributes to the fusion, and how many of one note it may contribute. */
const CANDIDATES = 60;
const PER_NOTE_IN_RANKING = 3;
/** Passages of one note in the final answer. */
const PER_NOTE_IN_ANSWER = 2;
const RRF_K = 60;
/** Cosine similarity below this is not a match. */
const MIN_SEMANTIC_SIMILARITY = 0.25;

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;
/** Texts refused one after another before the provider, not the texts, is blamed. */
const MAX_REFUSALS_IN_A_ROW = 3;

export class SearchUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SearchUnavailableError';
    }
}

/** A failure of the embedding setup itself (wrong vector length, wrong count): retrying cannot help. */
class EmbeddingSetupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EmbeddingSetupError';
    }
}

export interface NoteIndexOptions {
    app: App;
    /** Where the index is kept. Default: IndexedDB, named for this vault. */
    store?: IndexStore;
    /** The embedding model; without one only keywords are indexed. */
    embedder?: NoteEmbedder | null;
    /** Folders (vault paths) left out of the index. */
    excludedFolders?: readonly string[];
    /** Quiet time after a note's last change before it is indexed again, in ms. Default 3000. */
    debounceMs?: number;
    /** Notes bigger than this many bytes are skipped. Default 1 MiB. */
    maxNoteBytes?: number;
    /** Passages per embedding request. Default 32. */
    embedBatchSize?: number;
    /** Target size of a passage (see `TARGET_UNITS`). */
    chunkUnits?: number;
    /** Where unexpected failures are reported. Default: the console. */
    log?: (message: string, error?: unknown) => void;
}

type Timer = ReturnType<typeof setTimeout>;

/** A passage in memory: what is stored, and what searching reads. */
interface ChunkEntry {
    path: string;
    index: number;
    heading: string[];
    startLine: number;
    endLine: number;
    text: string;
    textHash: string;
    vec: Int8Array | null;
    /** `text` in search form. */
    norm: string;
    /** Title and headings in search form. */
    head: string;
    /** Length for BM25. */
    len: number;
}

interface NoteEntry extends NoteInfo {
    chunks: ChunkEntry[];
}

/** A passage waiting for its vector. */
interface EmbedItem {
    path: string;
    chunk: ChunkEntry;
    text: string;
}

function isMarkdownFile(file: TAbstractFile | null | undefined): file is TFile {
    return !!file && 'extension' in file && String((file as TFile).extension).toLowerCase() === 'md';
}

function isFolder(file: TAbstractFile): boolean {
    return 'children' in file;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function appIdOf(app: App): string {
    // `appId` is not in Obsidian's typings, but every vault has one.
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
    if (error instanceof EmbeddingSetupError) return true;
    return isModelRequestError(error) && (error.status === 401 || error.status === 403 || error.status === 404 || error.code === 'invalid_api_key');
}

function derive(path: string, heading: string[], text: string): Pick<ChunkEntry, 'norm' | 'head' | 'len'> {
    const body = normalizeText(text);
    const head = normalizeText([titleOf(path), ...heading].join(' '));
    // When normalising changed nothing, share the text instead of holding a copy.
    return { norm: body === text ? text : body, head, len: body.length + head.length };
}

/** At most `perNote` passages of one note, `limit` in all, in order. */
function capPerNote<T extends { chunk: ChunkEntry }>(ranked: T[], limit: number, perNote: number): T[] {
    const seen = new Map<string, number>();
    const kept: T[] = [];
    for (const item of ranked) {
        const count = seen.get(item.chunk.path) ?? 0;
        if (count >= perNote) continue;
        seen.set(item.chunk.path, count + 1);
        kept.push(item);
        if (kept.length >= limit) break;
    }
    return kept;
}

export class NoteIndex implements NoteSearcher {
    private readonly vault: Vault;
    private readonly store: IndexStore;
    private embedder: NoteEmbedder | null;
    private excluded: string[];
    private readonly debounceMs: number;
    private readonly maxNoteBytes: number;
    private readonly batchSize: number;
    private readonly chunkUnits: number | undefined;
    private readonly log: (message: string, error?: unknown) => void;

    private running = false;
    private loaded = false;
    private startPromise: Promise<void> | null = null;
    /** Bumped by start, stop and rebuild: work begun under an older one is dropped. */
    private epoch = 0;
    /** Bumped when the embedding model changes: only embedding work in flight is dropped. */
    private modelEpoch = 0;

    private notes = new Map<string, NoteEntry>();
    /** The notes that should be in the index, from the vault and its events. */
    private eligible = new Set<string>();
    /** Notes to read and cut again, in order; `force` reads them even if their stat is unchanged. */
    private dirty = new Map<string, { force: boolean }>();
    /** Notes that have passages without a vector. */
    private needEmbed = new Set<string>();
    /** Notes waiting out their quiet time after a change. */
    private timers = new Map<string, { timer: Timer; force: boolean }>();
    /** Notes that disappeared while Obsidian was closed, by content hash: a note that shows up with the same text is the same note renamed. */
    private adoptable = new Map<string, NoteEntry>();
    private chunkCount = 0;
    /** The vector length, once known. */
    private learnedDimensions: number | null = null;

    private pumping = false;
    /** The note being read and cut right now. */
    private current: string | null = null;
    private pumpPromise: Promise<void> | null = null;
    private abort: AbortController | null = null;
    private paused = false;
    private retryAt: number | null = null;
    private retryTimer: Timer | null = null;
    private consecutiveFailures = 0;
    private refusalsInARow = 0;
    private lastError: string | null = null;
    /** Why the index cannot run at all (the stored index would not load). */
    private fatal: string | null = null;
    /** Why the last write to the store failed. */
    private storageError: string | null = null;

    private writes: Promise<void> = Promise.resolve();
    private refs: EventRef[] = [];
    private readonly listeners = new Set<(status: IndexStatus) => void>();
    private lastEmitAt = 0;
    private idleWaiters: Array<() => void> = [];

    constructor(options: NoteIndexOptions) {
        this.vault = options.app.vault;
        this.store = options.store ?? new IdbIndexStore(indexDatabaseName(appIdOf(options.app)));
        this.embedder = options.embedder ?? null;
        this.excluded = [...(options.excludedFolders ?? [])];
        this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        this.maxNoteBytes = options.maxNoteBytes ?? DEFAULT_MAX_NOTE_BYTES;
        this.batchSize = Math.max(1, options.embedBatchSize ?? DEFAULT_EMBED_BATCH);
        this.chunkUnits = options.chunkUnits;
        this.log = options.log ?? ((message, error) => console.warn(`[AlphainO] ${message}`, error ?? ''));
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /**
     * Loads the stored index and starts following the vault. Resolves when the
     * index is loaded and the work is queued, not when it is finished. Called
     * again after the index failed to load, it tries again.
     * `register` receives each vault listener, so Obsidian can remove them
     * when the plugin unloads.
     */
    start(register?: (ref: EventRef) => void): Promise<void> {
        if (this.startPromise && !this.fatal) return this.startPromise;
        // The last load failed: begin again.
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
            await this.hydrate(stored);
        } catch (error) {
            if (!this.alive(epoch)) return;
            this.fatal = t('Could not load the note index: {reason}', { reason: errorText(error) });
            this.log('Could not load the note index.', error);
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

    /** Stops following the vault, ends work in flight, saves what is pending and releases memory. */
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

    /** Throws away the index and builds it again from the notes. Resolves once the new build is queued. */
    async rebuild(): Promise<void> {
        if (!this.running) return;
        await this.startPromise;
        if (!this.running || !this.loaded) return;
        this.epoch += 1;
        this.abort?.abort();
        this.clearTimers();
        await this.pumpPromise;
        this.reset();
        this.writes = this.writes.then(() => this.store.clear()).catch((error) => this.noteStorageFailure(error));
        await this.persist([{ type: 'meta', meta: this.currentMeta() }]);
        this.reconcile();
        this.kick();
        this.emit(true);
    }

    /**
     * Resolves when nothing is queued or running and everything indexed is
     * saved: the index is current, or paused on the provider.
     */
    async whenIdle(): Promise<void> {
        for (;;) {
            if (!this.quiet()) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
            const writes = this.writes;
            await writes;
            if (this.quiet() && writes === this.writes) return;
        }
    }

    /** Tries embedding again now, after a pause. */
    retry(): void {
        this.clearPause();
        this.consecutiveFailures = 0;
        this.kick();
        this.emit(true);
    }

    /** The embedding model changed (or was turned off). A different model id means every passage is embedded again. */
    setEmbedder(next: NoteEmbedder | null): void {
        const before = this.embedder?.modelId ?? null;
        const after = next?.modelId ?? null;
        this.embedder = next;
        this.clearPause();
        this.consecutiveFailures = 0;
        this.refusalsInARow = 0;
        this.lastError = null;
        if (this.running && this.loaded && before !== after) {
            this.modelEpoch += 1;
            this.abort?.abort();
            this.learnedDimensions = null;
            this.dropVectors();
            this.refreshNeedEmbed();
            const ops: StoreOp[] = [{ type: 'meta', meta: this.currentMeta() }];
            for (const entry of this.notes.values()) ops.push(this.putOp(entry));
            void this.persist(ops);
        } else if (this.running && this.loaded) {
            this.refreshNeedEmbed();
        }
        this.kick();
        this.emit(true);
    }

    /** The folders left out of the index changed. */
    setExcludedFolders(folders: readonly string[]): void {
        const next = folders.map(normalizeFolderPath).filter((folder) => folder !== '');
        const same = next.length === this.excluded.length && next.every((folder, i) => folder === this.excluded[i]);
        this.excluded = next;
        if (same || !this.running || !this.loaded) return;
        this.reconcile();
        this.kick();
        this.emit(true);
    }

    // -----------------------------------------------------------------------
    // Status
    // -----------------------------------------------------------------------

    status(): IndexStatus {
        const waiting = new Set(this.dirty.keys());
        if (this.current !== null) waiting.add(this.current);
        if (this.embedder) for (const path of this.needEmbed) waiting.add(path);
        const notesTotal = this.eligible.size;
        let state: IndexState;
        if (!this.running) state = 'off';
        else if (this.fatal || this.storageError) state = 'error';
        else if (this.paused && this.embedder && this.needEmbed.size > 0) state = 'paused';
        else if (this.pumping || this.dirty.size > 0 || (this.startPromise !== null && !this.loaded)) state = 'indexing';
        else state = 'idle';
        return {
            state,
            model: this.embedder?.modelId ?? null,
            notesIndexed: Math.max(0, notesTotal - waiting.size),
            notesTotal,
            chunks: this.chunkCount,
            pending: waiting.size,
            lastError: this.fatal ?? this.storageError ?? this.lastError,
            retryAt: this.paused ? this.retryAt : null,
        };
    }

    /** Be told when the status changes; returns the unsubscribe. Changes that are only counts are throttled. */
    onStatusChange(listener: (status: IndexStatus) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private emit(force = false): void {
        if (this.listeners.size === 0) return;
        const now = Date.now();
        if (!force && now - this.lastEmitAt < STATUS_THROTTLE_MS) return;
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
        return !this.pumping && this.timers.size === 0 && this.dirty.size === 0 && !this.canEmbed();
    }

    private releaseIdleWaiters(): void {
        if (this.idleWaiters.length === 0 || !this.quiet()) return;
        for (const resolve of this.idleWaiters.splice(0)) resolve();
    }

    private alive(epoch: number): boolean {
        return this.running && epoch === this.epoch;
    }

    // -----------------------------------------------------------------------
    // Loading and reconciling
    // -----------------------------------------------------------------------

    private currentMeta(): IndexMeta {
        return {
            key: 'index',
            schema: SCHEMA_VERSION,
            chunker: CHUNKER_VERSION,
            model: this.embedder?.modelId ?? null,
            dimensions: this.embedder?.dimensions ?? this.learnedDimensions,
        };
    }

    private async hydrate(stored: StoredIndex): Promise<void> {
        const meta = stored.meta;
        if (!meta || meta.schema !== SCHEMA_VERSION || meta.chunker !== CHUNKER_VERSION) {
            // Nothing usable: written by another layout, or never written.
            if (meta || stored.notes.length > 0) await this.store.clear();
            await this.persist([{ type: 'meta', meta: this.currentMeta() }]);
            return;
        }
        const sameModel = this.embedder !== null && meta.model === this.embedder.modelId;
        if (sameModel) this.learnedDimensions = meta.dimensions;
        for (const note of stored.notes) {
            const entry = this.entryFromStored(note, sameModel ? meta : null);
            if (!entry) continue;
            this.notes.set(entry.path, entry);
            this.chunkCount += entry.chunks.length;
        }
        if (meta.model !== (this.embedder?.modelId ?? null)) {
            // Vectors from another model are of no use: the text stays, the vectors go.
            const ops: StoreOp[] = [{ type: 'meta', meta: this.currentMeta() }];
            for (const entry of this.notes.values()) ops.push(this.putOp(entry));
            await this.persist(ops);
        }
    }

    /** A note from the store; null when the record is not usable. `meta` is given when its vectors belong to the model in use. */
    private entryFromStored(note: StoredNote, meta: IndexMeta | null): NoteEntry | null {
        try {
            if (typeof note.path !== 'string' || !Array.isArray(note.chunks)) return null;
            if (typeof note.hash !== 'string' || typeof note.mtime !== 'number' || typeof note.size !== 'number') return null;
            const chunks = note.chunks.map((chunk): ChunkEntry => {
                const embedding = asInt8(chunk.embedding);
                const usable =
                    meta !== null &&
                    embedding !== null &&
                    chunk.model === meta.model &&
                    (meta.dimensions === null || embedding.length === meta.dimensions);
                return {
                    path: note.path,
                    index: chunk.index,
                    heading: chunk.heading,
                    startLine: chunk.startLine,
                    endLine: chunk.endLine,
                    text: chunk.text,
                    textHash: chunk.textHash,
                    vec: usable ? embedding : null,
                    ...derive(note.path, chunk.heading, chunk.text),
                };
            });
            return {
                path: note.path,
                mtime: note.mtime,
                size: note.size,
                hash: note.hash,
                ...(typeof note.embedError === 'string' ? { embedError: note.embedError } : {}),
                chunks,
            };
        } catch {
            return null;
        }
    }

    /**
     * Compares the vault with the index and queues what differs: notes that
     * are new or whose modified time or size changed, and passages without a
     * vector. Notes that are gone (or no longer searched) are dropped now.
     */
    private reconcile(): void {
        this.eligible.clear();
        for (const file of this.vault.getMarkdownFiles()) {
            if (!this.isEligible(file)) continue;
            this.eligible.add(file.path);
            const entry = this.notes.get(file.path);
            if (!entry || entry.mtime !== file.stat.mtime || entry.size !== file.stat.size) this.markDirty(file.path, false);
        }
        for (const path of [...this.notes.keys()]) {
            if (this.eligible.has(path)) continue;
            this.cancelTimer(path);
            this.dirty.delete(path);
            const gone = this.dropNote(path);
            // It may only have been renamed while Obsidian was closed.
            if (gone && gone.hash) this.adoptable.set(gone.hash, gone);
        }
        this.refreshNeedEmbed();
    }

    private isEligible(file: TFile): boolean {
        return file.stat.size <= this.maxNoteBytes && isIndexablePath(file.path, this.excluded);
    }

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    private listen(register?: (ref: EventRef) => void): void {
        for (const ref of this.refs) this.vault.offref(ref);
        this.refs = [];
        const add = (ref: EventRef) => {
            this.refs.push(ref);
            register?.(ref);
        };
        add(this.vault.on('create', (file) => this.guard(() => this.onChange(file, 'create'))));
        add(this.vault.on('modify', (file) => this.guard(() => this.onChange(file, 'modify'))));
        add(this.vault.on('delete', (file) => this.guard(() => this.onDelete(file))));
        add(this.vault.on('rename', (file, oldPath) => this.guard(() => this.onRename(file, oldPath))));
    }

    private guard(action: () => void): void {
        if (!this.running || !this.loaded) return;
        try {
            action();
        } catch (error) {
            this.log('The note index could not handle a vault event.', error);
        }
    }

    private onChange(file: TAbstractFile, kind: 'create' | 'modify'): void {
        if (!isMarkdownFile(file)) return;
        if (!this.isEligible(file)) {
            // Hidden, excluded, or grown past the size limit.
            if (this.eligible.has(file.path) || this.notes.has(file.path)) this.removeNote(file.path);
            return;
        }
        this.eligible.add(file.path);
        const known = this.notes.get(file.path);
        // The vault announces every existing note as created when it first loads.
        if (kind === 'create' && known && known.mtime === file.stat.mtime && known.size === file.stat.size) return;
        this.schedule(file.path, true);
    }

    private onDelete(file: TAbstractFile): void {
        if (isFolder(file)) {
            const prefix = `${file.path}/`;
            for (const path of this.knownPaths()) if (path.startsWith(prefix)) this.removeNote(path);
            return;
        }
        this.removeNote(file.path);
    }

    private onRename(file: TAbstractFile, oldPath: string): void {
        if (isFolder(file)) {
            const prefix = `${oldPath}/`;
            for (const path of this.knownPaths()) {
                if (path.startsWith(prefix)) this.moveNote(path, `${file.path}${path.slice(oldPath.length)}`);
            }
            return;
        }
        this.moveNote(oldPath, file.path);
    }

    private knownPaths(): string[] {
        return [...new Set([...this.notes.keys(), ...this.eligible, ...this.timers.keys(), ...this.dirty.keys()])];
    }

    /** Queues a note to be indexed once it has been quiet for the debounce time. */
    private schedule(path: string, force: boolean): void {
        const pending = this.timers.get(path);
        if (pending) clearTimeout(pending.timer);
        const wantsForce = force || pending?.force === true;
        const timer = setTimeout(() => {
            this.timers.delete(path);
            this.markDirty(path, wantsForce);
            this.kick();
            this.emit();
        }, this.debounceMs);
        this.timers.set(path, { timer, force: wantsForce });
    }

    private cancelTimer(path: string): { force: boolean } | undefined {
        const pending = this.timers.get(path);
        if (!pending) return undefined;
        clearTimeout(pending.timer);
        this.timers.delete(path);
        return { force: pending.force };
    }

    private clearTimers(): void {
        for (const { timer } of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }

    private markDirty(path: string, force: boolean): void {
        this.cancelTimer(path);
        this.dirty.set(path, { force: force || this.dirty.get(path)?.force === true });
    }

    private removeNote(path: string): void {
        this.cancelTimer(path);
        this.dirty.delete(path);
        this.eligible.delete(path);
        this.needEmbed.delete(path);
        this.dropNote(path);
        // The note may have been the last thing waited on (one edited, then deleted before it was read).
        this.releaseIdleWaiters();
    }

    /** Moves a note's records to a new path; nothing is embedded again. */
    private moveNote(oldPath: string, newPath: string): void {
        const entry = this.notes.get(oldPath);
        // A folder rename can be announced for the folder and again for each note in it.
        if (!entry && this.notes.has(newPath)) return;
        const pending = this.cancelTimer(oldPath) ?? this.dirty.get(oldPath);
        this.dirty.delete(oldPath);
        this.eligible.delete(oldPath);
        const needed = this.needEmbed.delete(oldPath);
        const target = this.vault.getAbstractFileByPath(newPath);
        const indexable = isMarkdownFile(target) && this.isEligible(target);
        if (indexable) this.eligible.add(newPath);
        if (entry) {
            this.notes.delete(oldPath);
            if (indexable) {
                this.relocate(entry, newPath);
                this.notes.set(newPath, entry);
                if (needed) this.needEmbed.add(newPath);
                void this.persist([{ type: 'delete', path: oldPath }, this.putOp(entry)]);
            } else {
                // Moved somewhere that is not searched.
                this.chunkCount -= entry.chunks.length;
                void this.persist([{ type: 'delete', path: oldPath }]);
            }
        }
        // A note that was not in the index, or was waiting to be indexed again, is read at its new path.
        if (indexable && (!entry || pending)) this.schedule(newPath, true);
        // Moved out of the index while it waited: nothing may be left to wait for.
        this.releaseIdleWaiters();
    }

    /** Points a note's passages at a new path; the title they are searched under changes with it. */
    private relocate(entry: NoteEntry, newPath: string): void {
        entry.path = newPath;
        for (const chunk of entry.chunks) {
            chunk.path = newPath;
            const derived = derive(newPath, chunk.heading, chunk.text);
            chunk.head = derived.head;
            chunk.len = derived.len;
        }
    }

    // -----------------------------------------------------------------------
    // The queue
    // -----------------------------------------------------------------------

    private canEmbed(): boolean {
        return this.embedder !== null && !this.paused && this.needEmbed.size > 0;
    }

    private kick(): void {
        if (!this.running || !this.loaded || this.fatal || this.pumping) return;
        if (this.dirty.size === 0 && !this.canEmbed()) {
            this.releaseIdleWaiters();
            return;
        }
        this.pumping = true;
        this.pumpPromise = this.pump(this.epoch);
    }

    private async pump(epoch: number): Promise<void> {
        this.emit(true);
        try {
            let sliceStart = Date.now();
            while (this.alive(epoch)) {
                const next = this.takeDirty();
                if (next) {
                    this.current = next.path;
                    try {
                        await this.indexNote(next.path, next.force, epoch);
                    } catch (error) {
                        // Left out until it changes; the notes after it are still indexed.
                        this.log(`Could not index ${next.path}.`, error);
                    } finally {
                        this.current = null;
                    }
                    if (Date.now() - sliceStart >= SLICE_MS) {
                        await yieldToEventLoop();
                        sliceStart = Date.now();
                    }
                    this.emit();
                    continue;
                }
                if (this.canEmbed()) {
                    let carryOn = false;
                    try {
                        carryOn = await this.embedBatch(epoch);
                    } catch (error) {
                        this.log('Could not embed a batch of passages.', error);
                        if (this.embedder) this.pauseForFailure(error, this.embedder);
                    }
                    if (carryOn) {
                        this.emit();
                        continue;
                    }
                }
                break;
            }
        } catch (error) {
            this.log('The note index stopped unexpectedly.', error);
            this.lastError = errorText(error);
        } finally {
            this.pumping = false;
            this.pumpPromise = null;
            if (this.dirty.size === 0) this.adoptable.clear();
            this.emit(true);
            this.releaseIdleWaiters();
        }
    }

    private takeDirty(): { path: string; force: boolean } | null {
        const first = this.dirty.entries().next();
        if (first.done) return null;
        const [path, job] = first.value;
        this.dirty.delete(path);
        return { path, force: job.force };
    }

    /** Reads a note, cuts it into passages and stores them, keeping the vectors of passages whose text did not change. */
    private async indexNote(path: string, force: boolean, epoch: number): Promise<void> {
        const file = this.vault.getAbstractFileByPath(path);
        if (!isMarkdownFile(file) || !this.isEligible(file)) {
            this.eligible.delete(path);
            this.needEmbed.delete(path);
            this.dropNote(path);
            return;
        }
        this.eligible.add(path);
        const existing = this.notes.get(path);
        // Read the stat before the text: a change made while reading then still looks like a change next time.
        const { mtime, size } = file.stat;
        if (!force && existing && existing.mtime === mtime && existing.size === size) return;

        let raw: string;
        try {
            raw = await this.vault.read(file);
        } catch (error) {
            // Deleted or renamed meanwhile: its own event follows.
            this.log(`Could not read ${path}.`, error);
            return;
        }
        if (!this.alive(epoch) || this.vault.getAbstractFileByPath(path) !== file) return;

        const hash = hashString(raw);
        if (existing && existing.hash === hash) {
            // Touched or synced, not edited: only the stat changes.
            existing.mtime = mtime;
            existing.size = size;
            await this.persist([{ type: 'put', note: this.infoOf(existing) }]);
            return;
        }
        const adopted = existing ? undefined : this.adoptable.get(hash);
        if (adopted) {
            // The same text as a note that vanished: it was renamed while Obsidian was closed.
            this.adoptable.delete(hash);
            adopted.mtime = mtime;
            adopted.size = size;
            this.relocate(adopted, path);
            this.notes.set(path, adopted);
            this.chunkCount += adopted.chunks.length;
            this.refreshNeed(adopted);
            await this.persist([this.putOp(adopted)]);
            return;
        }

        const entry = this.buildEntry(path, mtime, size, hash, raw, existing);
        if (existing) this.chunkCount -= existing.chunks.length;
        this.notes.set(path, entry);
        this.chunkCount += entry.chunks.length;
        this.refreshNeed(entry);
        await this.persist([this.putOp(entry)]);
    }

    private buildEntry(path: string, mtime: number, size: number, hash: string, raw: string, previous: NoteEntry | undefined): NoteEntry {
        const reusable = new Map<string, Int8Array>();
        for (const chunk of previous?.chunks ?? []) if (chunk.vec) reusable.set(chunk.textHash, chunk.vec);
        const chunks = chunkNote(raw, { targetUnits: this.chunkUnits }).map((piece): ChunkEntry => {
            const textHash = chunkHash(piece.heading, piece.text);
            return {
                path,
                index: piece.index,
                heading: piece.heading,
                startLine: piece.startLine,
                endLine: piece.endLine,
                text: piece.text,
                textHash,
                vec: reusable.get(textHash) ?? null,
                ...derive(path, piece.heading, piece.text),
            };
        });
        return { path, mtime, size, hash, chunks };
    }

    /** Removes a note's records. Returns what was removed. */
    private dropNote(path: string): NoteEntry | undefined {
        const entry = this.notes.get(path);
        if (!entry) return undefined;
        this.notes.delete(path);
        this.needEmbed.delete(path);
        this.chunkCount -= entry.chunks.length;
        void this.persist([{ type: 'delete', path }]);
        return entry;
    }

    // -----------------------------------------------------------------------
    // Embedding
    // -----------------------------------------------------------------------

    private refreshNeed(entry: NoteEntry): void {
        if (this.embedder && !entry.embedError && entry.chunks.some((chunk) => chunk.vec === null)) this.needEmbed.add(entry.path);
        else this.needEmbed.delete(entry.path);
    }

    private refreshNeedEmbed(): void {
        this.needEmbed.clear();
        for (const entry of this.notes.values()) this.refreshNeed(entry);
    }

    private dropVectors(): void {
        for (const entry of this.notes.values()) {
            delete entry.embedError;
            for (const chunk of entry.chunks) chunk.vec = null;
        }
    }

    /** Up to one request's worth of passages that have no vector, across notes. */
    private nextBatch(): EmbedItem[] {
        const batch: EmbedItem[] = [];
        for (const path of this.needEmbed) {
            const entry = this.notes.get(path);
            const lacking = entry && !entry.embedError ? entry.chunks.filter((chunk) => chunk.vec === null) : [];
            if (!entry || lacking.length === 0) {
                this.needEmbed.delete(path);
                continue;
            }
            for (const chunk of lacking) {
                batch.push({ path, chunk, text: embeddingText(titleOf(path), chunk.heading, chunk.text) });
                if (batch.length >= this.batchSize) return batch;
            }
        }
        return batch;
    }

    /**
     * Embeds the next batch. Returns whether the queue should carry on:
     * false after a failure that pauses embedding, and when work was dropped
     * because the index was stopped or rebuilt.
     */
    private async embedBatch(epoch: number): Promise<boolean> {
        const embedder = this.embedder;
        if (!embedder) return false;
        const batch = this.nextBatch();
        if (batch.length === 0) return true;
        const modelEpoch = this.modelEpoch;
        const controller = new AbortController();
        this.abort = controller;
        try {
            const vectors = await embedder.embedDocuments(batch.map((item) => item.text), controller.signal);
            if (!this.alive(epoch)) return false;
            // The model changed while the request was out: these vectors belong to the old one.
            if (modelEpoch !== this.modelEpoch) return true;
            this.checkVectors(embedder, vectors, batch.length);
            await this.applyVectors(batch, vectors);
            this.embedSucceeded();
            return true;
        } catch (error) {
            if (!this.alive(epoch)) return false;
            if (modelEpoch !== this.modelEpoch) return true;
            if (controller.signal.aborted) return false;
            return this.embedFailed(error, batch, embedder, epoch, modelEpoch);
        } finally {
            if (this.abort === controller) this.abort = null;
        }
    }

    private checkVectors(embedder: NoteEmbedder, vectors: Int8Array[], count: number): void {
        if (vectors.length !== count) {
            throw new EmbeddingSetupError(t('{provider} returned {actual} embeddings for {expected} texts.', { provider: embedder.label, actual: vectors.length, expected: count }));
        }
        const expected = embedder.dimensions ?? this.learnedDimensions;
        for (const vector of vectors) {
            if (expected !== null && expected !== undefined && vector.length !== expected) {
                throw new EmbeddingSetupError(
                    t('{provider} returned vectors of length {actual}, not the {expected} its model id promises. Check the model and dimensions in settings.', {
                        provider: embedder.label,
                        actual: vector.length,
                        expected,
                    }),
                );
            }
        }
    }

    /** Puts vectors on the passages they were made for, if those passages are still in the index. */
    private async applyVectors(items: EmbedItem[], vectors: Int8Array[]): Promise<void> {
        const touched = new Set<NoteEntry>();
        items.forEach((item, i) => {
            const note = this.notes.get(item.path);
            if (!note) return;
            // The note may have been indexed again meanwhile: a passage with the same text still wants this vector.
            const target = note.chunks.includes(item.chunk)
                ? item.chunk
                : note.chunks.find((chunk) => chunk.vec === null && chunk.textHash === item.chunk.textHash);
            if (!target || target.vec) return;
            target.vec = vectors[i];
            touched.add(note);
        });
        const ops: StoreOp[] = [];
        if (this.learnedDimensions === null && vectors.length > 0) {
            this.learnedDimensions = vectors[0].length;
            ops.push({ type: 'meta', meta: this.currentMeta() });
        }
        for (const note of touched) {
            this.refreshNeed(note);
            ops.push(this.putOp(note));
        }
        await this.persist(ops);
    }

    private embedSucceeded(): void {
        this.consecutiveFailures = 0;
        this.refusalsInARow = 0;
        this.lastError = null;
        this.clearPause();
    }

    private async embedFailed(error: unknown, batch: EmbedItem[], embedder: NoteEmbedder, epoch: number, modelEpoch: number): Promise<boolean> {
        const blame = error instanceof EmbeddingSetupError ? 'provider' : embeddingFailureBlame(error);
        if (blame === 'document') return this.isolateRefused(batch, embedder, epoch, modelEpoch);
        this.pauseForFailure(error, embedder);
        return false;
    }

    /** The provider refused a batch for what is in it: send the passages one at a time to find the ones it will not take. */
    private async isolateRefused(batch: EmbedItem[], embedder: NoteEmbedder, epoch: number, modelEpoch: number): Promise<boolean> {
        for (const item of batch) {
            if (!this.alive(epoch)) return false;
            if (modelEpoch !== this.modelEpoch) return true;
            const controller = new AbortController();
            this.abort = controller;
            try {
                const vectors = await embedder.embedDocuments([item.text], controller.signal);
                if (!this.alive(epoch)) return false;
                if (modelEpoch !== this.modelEpoch) return true;
                this.checkVectors(embedder, vectors, 1);
                await this.applyVectors([item], vectors);
                this.refusalsInARow = 0;
            } catch (error) {
                if (!this.alive(epoch)) return false;
                if (modelEpoch !== this.modelEpoch) return true;
                if (controller.signal.aborted) return false;
                const refused = !(error instanceof EmbeddingSetupError) && embeddingFailureBlame(error) === 'document';
                if (!refused) {
                    this.pauseForFailure(error, embedder);
                    return false;
                }
                this.refusalsInARow += 1;
                if (this.refusalsInARow >= MAX_REFUSALS_IN_A_ROW) {
                    // Several different texts refused in a row: it is the setup, not the texts.
                    this.pauseForFailure(error, embedder, true);
                    return false;
                }
                this.flagRefused(item, error);
            } finally {
                if (this.abort === controller) this.abort = null;
            }
        }
        return true;
    }

    /** Marks a note whose passage the model will not take: it is left out of semantic search until it changes. */
    private flagRefused(item: EmbedItem, error: unknown): void {
        const note = this.notes.get(item.path);
        if (!note) return;
        note.embedError = errorText(error);
        this.needEmbed.delete(item.path);
        void this.persist([{ type: 'put', note: this.infoOf(note) }]);
    }

    private pauseForFailure(error: unknown, embedder: NoteEmbedder, hard = false): void {
        this.consecutiveFailures += 1;
        this.lastError = error instanceof EmbeddingSetupError ? error.message : describeEmbeddingFailure(error, embedder.label);
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
    // Storage
    // -----------------------------------------------------------------------

    private infoOf(entry: NoteEntry): NoteInfo {
        return {
            path: entry.path,
            mtime: entry.mtime,
            size: entry.size,
            hash: entry.hash,
            ...(entry.embedError !== undefined ? { embedError: entry.embedError } : {}),
        };
    }

    private storedChunks(entry: NoteEntry): StoredChunk[] {
        const model = this.embedder?.modelId ?? '';
        return entry.chunks.map((chunk) => ({
            path: entry.path,
            index: chunk.index,
            heading: chunk.heading,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            text: chunk.text,
            textHash: chunk.textHash,
            embedding: chunk.vec,
            model: chunk.vec ? model : '',
            dimensions: chunk.vec ? chunk.vec.length : 0,
        }));
    }

    private putOp(entry: NoteEntry): StoreOp {
        return { type: 'put', note: this.infoOf(entry), chunks: this.storedChunks(entry) };
    }

    /** Writes in order, one at a time. Never rejects: a failed write is reported in the status. */
    private persist(ops: StoreOp[]): Promise<void> {
        if (ops.length === 0) return this.writes;
        this.writes = this.writes.then(async () => {
            try {
                await this.store.write(ops);
                if (this.storageError) {
                    this.storageError = null;
                    this.emit(true);
                }
            } catch (error) {
                this.noteStorageFailure(error);
            }
        });
        return this.writes;
    }

    private noteStorageFailure(error: unknown): void {
        this.log('Could not save the note index.', error);
        this.storageError = t('Could not save the note index: {reason}', { reason: errorText(error) });
        this.emit(true);
    }

    private reset(): void {
        this.notes.clear();
        this.eligible.clear();
        this.dirty.clear();
        this.needEmbed.clear();
        this.adoptable.clear();
        this.clearTimers();
        this.clearPause();
        this.chunkCount = 0;
        this.current = null;
        this.learnedDimensions = null;
        this.consecutiveFailures = 0;
        this.refusalsInARow = 0;
        this.lastError = null;
        this.storageError = null;
    }

    // -----------------------------------------------------------------------
    // Search
    // -----------------------------------------------------------------------

    /** The best passages for a query. See {@link searchDetailed} for what else is known about the answer. */
    async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
        return (await this.searchDetailed(query, options)).hits;
    }

    /**
     * Searches by meaning (query embedding against the stored vectors), by
     * keywords (BM25), or both fused by rank. A hybrid search with no
     * embedding model, no vectors yet, or a failing provider is a keyword
     * search, and says so in `warnings`. At most two passages of one note.
     */
    async searchDetailed(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
        if (this.startPromise) await this.startPromise;
        if (!this.running || !this.loaded) throw new SearchUnavailableError(this.fatal ?? 'Note search is off.');
        const mode = options.mode ?? 'hybrid';
        const limit = Math.min(Math.max(Math.floor(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
        const warnings: string[] = [];
        // Quoted phrases must occur exactly in a keyword match; the model reads the query without the quotes.
        const parsed = parseQuery(query);
        const text = [parsed.text, ...parsed.phrases].join(' ').trim();
        if (text === '') return { hits: [], mode, warnings };
        const unread = this.dirty.size + (this.current !== null && !this.dirty.has(this.current) ? 1 : 0);
        if (unread > 0) {
            warnings.push(`${unread} of ${this.eligible.size} notes are not indexed yet, so results may leave them out.`);
        }

        const passages = this.passagesIn(options.folder ?? '');
        const embedder = this.embedder;
        const vectored = embedder ? passages.filter((chunk) => chunk.vec !== null).length : 0;

        let semantic: Array<{ chunk: ChunkEntry; score: number }> | null = null;
        if (mode !== 'keyword') {
            const unavailable = !embedder
                ? 'No embedding model is set up, so notes cannot be searched by meaning.'
                : vectored === 0
                  ? 'No note has been embedded yet, so notes cannot be searched by meaning.'
                  : null;
            if (unavailable) {
                if (mode === 'semantic') throw new SearchUnavailableError(unavailable);
                warnings.push(`${unavailable} Only keywords were matched.`);
            } else if (embedder) {
                try {
                    semantic = await this.rankSemantic(embedder, text, passages, options.signal);
                    if (vectored < passages.length && this.status().pending > 0) {
                        warnings.push(`Search by meaning covers ${vectored} of ${passages.length} passages so far: the index is still being built.`);
                    }
                } catch (error) {
                    const reason = describeEmbeddingFailure(error, embedder.label);
                    if (mode === 'semantic') throw new SearchUnavailableError(reason);
                    warnings.push(`${reason} Only keywords were matched.`);
                }
            }
        }

        let keyword: Array<{ chunk: ChunkEntry; score: number }> | null = null;
        if (mode !== 'semantic') {
            const tests = parsed.phrases.map(phraseTest);
            const candidates = tests.length > 0 ? passages.filter((chunk) => tests.every((test) => test(chunk))) : passages;
            const matches = await bm25Rank(candidates, queryTerms(text), CANDIDATES * 2);
            keyword = capPerNote(
                matches.map(({ doc, score }) => ({ chunk: doc, score })),
                CANDIDATES,
                PER_NOTE_IN_RANKING,
            );
        }

        const effective: SearchResponse['mode'] = semantic && keyword ? 'hybrid' : semantic ? 'semantic' : 'keyword';
        if (semantic && keyword) return { hits: this.fuse(semantic, keyword, limit), mode: effective, warnings };
        const only = (semantic ?? keyword) as Array<{ chunk: ChunkEntry; score: number }>;
        const source = semantic ? 'semantic' : 'keyword';
        const hits = capPerNote(only, limit, PER_NOTE_IN_ANSWER).map(({ chunk, score }) => this.toHit(chunk, score, source));
        return { hits, mode: effective, warnings };
    }

    /** Every passage inside a folder; all of them for ''. */
    private passagesIn(folder: string): ChunkEntry[] {
        const scoped = normalizeFolderPath(folder) !== '';
        const passages: ChunkEntry[] = [];
        for (const entry of this.notes.values()) {
            if (scoped && !isUnderFolder(entry.path, folder)) continue;
            for (const chunk of entry.chunks) passages.push(chunk);
        }
        return passages;
    }

    private async rankSemantic(
        embedder: NoteEmbedder,
        query: string,
        passages: ChunkEntry[],
        signal: AbortSignal | undefined,
    ): Promise<Array<{ chunk: ChunkEntry; score: number }>> {
        const vector = await embedder.embedQuery(query.slice(0, MAX_QUERY_CHARS), signal);
        const scored: Array<{ chunk: ChunkEntry; score: number }> = [];
        for (const chunk of passages) {
            // A vector of another length cannot be from this model.
            if (!chunk.vec || chunk.vec.length !== vector.length) continue;
            const score = int8Cosine(vector, chunk.vec);
            if (score >= MIN_SEMANTIC_SIMILARITY) scored.push({ chunk, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return capPerNote(scored, CANDIDATES, PER_NOTE_IN_RANKING);
    }

    /** Reciprocal-rank fusion of the two rankings. */
    private fuse(
        semantic: Array<{ chunk: ChunkEntry; score: number }>,
        keyword: Array<{ chunk: ChunkEntry; score: number }>,
        limit: number,
    ): SearchHit[] {
        const fused = new Map<ChunkEntry, { score: number; semantic: boolean; keyword: boolean }>();
        const add = (list: Array<{ chunk: ChunkEntry }>, kind: 'semantic' | 'keyword') => {
            list.forEach(({ chunk }, rank) => {
                const entry = fused.get(chunk) ?? { score: 0, semantic: false, keyword: false };
                entry.score += 1 / (RRF_K + rank + 1);
                entry[kind] = true;
                fused.set(chunk, entry);
            });
        };
        add(semantic, 'semantic');
        add(keyword, 'keyword');
        // First in both lists is the best a passage can do: that scales to 1.
        const best = 2 / (RRF_K + 1);
        const ranked = [...fused.entries()]
            .map(([chunk, entry]) => ({ chunk, entry }))
            .sort((a, b) => b.entry.score - a.entry.score);
        return capPerNote(ranked, limit, PER_NOTE_IN_ANSWER).map(({ chunk, entry }) =>
            this.toHit(chunk, entry.score / best, entry.semantic && entry.keyword ? 'both' : entry.semantic ? 'semantic' : 'keyword'),
        );
    }

    private toHit(chunk: ChunkEntry, score: number, source: SearchHit['source']): SearchHit {
        return {
            path: chunk.path,
            title: titleOf(chunk.path),
            heading: chunk.heading.length > 0 ? chunk.heading[chunk.heading.length - 1] : '',
            headingPath: [...chunk.heading],
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            text: trimText(chunk.text, RESULT_TEXT_CHARS),
            score,
            source,
        };
    }
}
