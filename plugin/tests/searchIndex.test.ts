import { IDBFactory } from 'fake-indexeddb';
import type { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { quantizeToInt8 } from '@beaver/agent-llm/embeddings';
import { ModelRequestError } from '@beaver/agent-llm/sse';
import type { NoteEmbedder } from '../src/search/embedder';
import { IdbIndexStore } from '../src/search/idbStore';
import { NoteIndex, SearchUnavailableError, type NoteIndexOptions } from '../src/search/noteIndex';
import { MemoryIndexStore } from '../src/search/store';
import type { IndexStatus } from '../src/search/types';
import { FakeNoteVault } from './obsidianStub';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Words that mean the same to the fake model: a search for one finds the other without sharing a word. */
const SYNONYMS: Record<string, string> = { automobile: 'car', vehicle: 'car' };

function wordsOf(text: string): string[] {
    const tokens: string[] = [];
    for (const part of text.toLowerCase().split(/[^a-z0-9一-鿿]+/)) {
        if (part === '') continue;
        if (/[一-鿿]/.test(part)) tokens.push(...Array.from(part));
        else tokens.push(SYNONYMS[part] ?? part);
    }
    return tokens;
}

function bucket(token: string, dimensions: number): number {
    let hash = 7;
    for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash % dimensions;
}

/** A model that embeds a text as the counts of its words: texts that share words are close. It records every call. */
class FakeEmbedder implements NoteEmbedder {
    readonly label = 'Fake';
    calls: string[][] = [];
    queries: string[] = [];
    /** Errors for the next calls to embedDocuments, one each. */
    failures: unknown[] = [];
    /** An error for the next query. */
    queryFailure: unknown = null;
    /** Holds calls to embedDocuments until it resolves. */
    gate: Promise<void> | null = null;
    /** Refuses (400) any request with a text this accepts. */
    refuseIf: ((texts: string[]) => boolean) | null = null;

    constructor(
        readonly modelId = 'fake-int8-256',
        readonly dimensions = 256,
    ) {}

    get texts(): string[] {
        return this.calls.flat();
    }

    vector(text: string): Int8Array {
        const values = new Array<number>(this.dimensions).fill(0);
        for (const token of wordsOf(text)) values[bucket(token, this.dimensions)] += 1;
        return Int8Array.from(quantizeToInt8(values));
    }

    async embedDocuments(texts: string[], signal?: AbortSignal): Promise<Int8Array[]> {
        this.calls.push([...texts]);
        await this.hold(signal);
        const failure = this.failures.shift();
        if (failure) throw failure;
        if (this.refuseIf?.(texts)) throw new ModelRequestError('Fake embeddings failed: 400', { kind: 'http', status: 400, label: 'Fake' });
        return texts.map((text) => this.vector(text));
    }

    async embedQuery(text: string): Promise<Int8Array> {
        this.queries.push(text);
        if (this.queryFailure) throw this.queryFailure;
        return this.vector(text);
    }

    private async hold(signal?: AbortSignal): Promise<void> {
        const gate = this.gate;
        if (!gate) return;
        const cancelled = () => new ModelRequestError('Fake embeddings request cancelled', { kind: 'cancelled' });
        if (signal?.aborted) throw cancelled();
        await new Promise<void>((resolve, reject) => {
            void gate.then(resolve);
            signal?.addEventListener('abort', () => reject(cancelled()), { once: true });
        });
    }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const httpError = (status: number, extra: Partial<ConstructorParameters<typeof ModelRequestError>[1]> = {}) =>
    new ModelRequestError(`Fake embeddings failed: ${status}`, { kind: 'http', status, label: 'Fake', ...extra });

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

const BEES = [
    '# Bees',
    '',
    'Honey bees collect nectar and pollen from flowers.',
    '',
    '## Winter',
    '',
    'In winter the colony clusters around the queen to stay warm.',
    '',
    '## Diseases',
    '',
    'Varroa mites weaken the colony and spread viruses.',
].join('\n');
const CATS = '# Cats\n\nCats sleep most of the day and hunt at dusk.\n';
const ML = '# 机器学习\n\n机器学习是人工智能的一个分支。\n\n## 神经网络\n\n神经网络由许多层组成。\n';

interface Setup {
    vault: FakeNoteVault;
    store: MemoryIndexStore;
    embedder: FakeEmbedder | null;
    index: NoteIndex;
    app: App;
}

const running: NoteIndex[] = [];

type SetupOptions = Omit<Partial<NoteIndexOptions>, 'app' | 'embedder' | 'store'> & {
    embedder?: FakeEmbedder | null;
    store?: MemoryIndexStore;
    vault?: FakeNoteVault;
};

function setup(notes: Record<string, string> = {}, options: SetupOptions = {}): Setup {
    const vault = options.vault ?? new FakeNoteVault();
    for (const [path, content] of Object.entries(notes)) vault.write(path, content, { silent: true });
    const store = options.store ?? new MemoryIndexStore();
    const embedder = options.embedder === undefined ? new FakeEmbedder() : options.embedder;
    const app = { vault, appId: 'test-app' } as unknown as App;
    const { embedder: _e, store: _s, vault: _v, ...rest } = options;
    const index = new NoteIndex({ app, store, embedder, debounceMs: 5, log: () => {}, ...rest });
    running.push(index);
    return { vault, store, embedder, index, app };
}

async function started(notes: Record<string, string> = {}, options: SetupOptions = {}): Promise<Setup> {
    const made = setup(notes, options);
    await made.index.start();
    await made.index.whenIdle();
    return made;
}

afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const index of running.splice(0)) await index.stop();
});

// ---------------------------------------------------------------------------
// Building and following the vault
// ---------------------------------------------------------------------------

describe('the first build', () => {
    it('indexes every note and embeds every passage, with the note title and headings in front', async () => {
        const { index, embedder, store } = await started({ 'Bees.md': BEES, 'Notes/Cats.md': CATS, '机器学习.md': ML });
        expect(index.status()).toEqual({
            state: 'idle',
            model: 'fake-int8-256',
            notesIndexed: 3,
            notesTotal: 3,
            chunks: 6,
            pending: 0,
            lastError: null,
            retryAt: null,
        });
        expect(embedder?.calls).toHaveLength(1);
        expect(embedder?.texts).toHaveLength(6);
        expect(embedder?.texts).toContain('Bees › Winter\n\nIn winter the colony clusters around the queen to stay warm.');
        expect(embedder?.texts).toContain('Cats\n\nCats sleep most of the day and hunt at dusk.');
        expect(embedder?.texts).toContain('机器学习 › 神经网络\n\n神经网络由许多层组成。');

        const stored = await store.load();
        expect(stored.meta).toEqual({ key: 'index', schema: 1, chunker: 1, model: 'fake-int8-256', dimensions: 256 });
        expect(stored.notes.map((note) => note.path).sort()).toEqual(['Bees.md', 'Notes/Cats.md', '机器学习.md']);
    });

    it('stores each note’s path, modified time, size and hash, and each passage’s place, text, hash and vector', async () => {
        const { vault, store } = await started({ 'Bees.md': BEES });
        const file = vault.files.get('Bees.md')?.file;
        const note = (await store.load()).notes[0];
        expect(note).toMatchObject({ path: 'Bees.md', mtime: file?.stat.mtime, size: file?.stat.size });
        expect(typeof note.hash).toBe('string');
        expect(note.chunks).toHaveLength(3);
        expect(note.chunks[1]).toMatchObject({
            path: 'Bees.md',
            index: 1,
            heading: ['Bees', 'Winter'],
            startLine: 7,
            endLine: 7,
            text: 'In winter the colony clusters around the queen to stay warm.',
            model: 'fake-int8-256',
            dimensions: 256,
        });
        expect(typeof note.chunks[1].textHash).toBe('string');
        expect(note.chunks[1].embedding).toBeInstanceOf(Int8Array);
        expect(note.chunks[1].embedding).toHaveLength(256);
    });

    it('with no model indexes the notes for keywords only', async () => {
        const { index, vault } = await started({ 'Bees.md': BEES }, { embedder: null });
        expect(index.status()).toMatchObject({ state: 'idle', model: null, chunks: 3, pending: 0, notesIndexed: 1 });
        expect(vault.reads).toBe(1);
    });

    it('is working until the notes are indexed, and says how far it is', async () => {
        const made = setup({ 'a.md': BEES, 'b.md': CATS });
        const gate = deferred();
        made.embedder!.gate = gate.promise;
        await made.index.start();
        await vi.waitFor(() => expect(made.embedder?.calls).toHaveLength(1));
        expect(made.index.status()).toMatchObject({ state: 'indexing', notesTotal: 2, notesIndexed: 0, pending: 2, chunks: 4 });
        gate.resolve();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', notesIndexed: 2, pending: 0 });
    });

    it('handles a few hundred notes in batches', async () => {
        const notes: Record<string, string> = {};
        for (let i = 0; i < 200; i += 1) notes[`n/${i}.md`] = `# Note ${i}\n\nSome words about subject ${i} and more.`;
        const { index, embedder } = await started(notes);
        expect(index.status()).toMatchObject({ state: 'idle', notesTotal: 200, chunks: 200, pending: 0 });
        expect(embedder?.calls.map((call) => call.length)).toEqual([32, 32, 32, 32, 32, 32, 8]);
    });
});

describe('a changed note', () => {
    it('embeds only the passages whose text changed', async () => {
        const { index, embedder, vault } = await started({ 'Bees.md': BEES });
        vault.write('Bees.md', BEES.replace('Varroa mites weaken the colony and spread viruses.', 'Varroa mites are a parasite of honey bees.'));
        await index.whenIdle();
        expect(embedder?.calls).toHaveLength(2);
        expect(embedder?.calls[1]).toEqual(['Bees › Diseases\n\nVarroa mites are a parasite of honey bees.']);
        expect(index.status()).toMatchObject({ chunks: 3, pending: 0 });
        expect((await index.search('parasite', { mode: 'keyword' }))[0].path).toBe('Bees.md');
        expect(await index.search('viruses', { mode: 'keyword' })).toEqual([]);
    });

    it('keeps the vectors of passages that only moved, and updates their lines', async () => {
        const { index, embedder, vault } = await started({ 'Bees.md': BEES });
        vault.write('Bees.md', `A new first line.\n\n${BEES}`);
        await index.whenIdle();
        expect(embedder?.calls[1]).toEqual(['Bees\n\nA new first line.']);
        const [hit] = await index.search('queen', { mode: 'keyword' });
        expect(hit).toMatchObject({ startLine: 9, endLine: 9, heading: 'Winter' });
    });

    it('embeds again a passage whose heading changed, since the heading is part of what is embedded', async () => {
        const { index, embedder, vault } = await started({ 'Bees.md': BEES });
        vault.write('Bees.md', BEES.replace('## Winter', '## Cold season'));
        await index.whenIdle();
        expect(embedder?.calls[1]).toEqual(['Bees › Cold season\n\nIn winter the colony clusters around the queen to stay warm.']);
    });

    it('is read again even when its modified time and size look the same', async () => {
        const { index, embedder, vault } = await started({ 'a.md': 'The cat sat on the mat today.' });
        const file = vault.files.get('a.md')!.file;
        const stat = { ...file.stat };
        vault.write('a.md', 'The dog sat on the mat today.', { silent: true });
        Object.assign(file.stat, stat);
        (vault as unknown as { emit(name: string, ...args: unknown[]): void }).emit('modify', file);
        await index.whenIdle();
        expect(embedder?.texts[embedder.texts.length - 1]).toContain('dog');
    });

    it('only has its modified time updated when the text is the same', async () => {
        const { index, embedder, vault, store } = await started({ 'a.md': BEES });
        const reads = vault.reads;
        vault.touch('a.md');
        (vault as unknown as { emit(name: string, ...args: unknown[]): void }).emit('modify', vault.files.get('a.md')!.file);
        await index.whenIdle();
        expect(vault.reads).toBe(reads + 1);
        expect(embedder?.calls).toHaveLength(1);
        expect((await store.load()).notes[0].mtime).toBe(vault.files.get('a.md')!.file.stat.mtime);
    });

    it('is not read again for a create announcement of a note already in the index', async () => {
        const { index, vault } = await started({ 'a.md': BEES, 'b.md': CATS });
        const reads = vault.reads;
        for (const { file } of vault.files.values()) (vault as unknown as { emit(name: string, ...args: unknown[]): void }).emit('create', file);
        await index.whenIdle();
        expect(vault.reads).toBe(reads);
    });

    it('is picked up as a new note when created', async () => {
        const { index, embedder, vault } = await started({ 'a.md': BEES });
        vault.write('b.md', CATS);
        await index.whenIdle();
        expect(index.status()).toMatchObject({ notesTotal: 2, notesIndexed: 2, chunks: 4 });
        expect(embedder?.calls[1]).toEqual(['b › Cats\n\nCats sleep most of the day and hunt at dusk.']);
        expect((await index.search('dusk'))[0].path).toBe('b.md');
    });
});

describe('a renamed note', () => {
    it('keeps its vectors: nothing is read or embedded again', async () => {
        const { index, embedder, vault, store } = await started({ 'Bees.md': BEES, 'Notes/Cats.md': CATS });
        const reads = vault.reads;
        vault.rename('Notes/Cats.md', 'Notes/Felines.md');
        await index.whenIdle();
        expect(embedder?.calls).toHaveLength(1);
        expect(vault.reads).toBe(reads);
        const hits = await index.search('cats sleep');
        expect(hits[0]).toMatchObject({ path: 'Notes/Felines.md', title: 'Felines' });
        expect(hits.some((hit) => hit.path === 'Notes/Cats.md')).toBe(false);
        expect((await store.load()).notes.map((note) => note.path).sort()).toEqual(['Bees.md', 'Notes/Felines.md']);
        expect(index.status()).toMatchObject({ notesTotal: 2, chunks: 4, pending: 0 });
    });

    it('is found under its new title', async () => {
        const { index, vault } = await started({ 'Notes/Cats.md': CATS });
        vault.rename('Notes/Cats.md', 'Notes/Felines.md');
        await index.whenIdle();
        expect((await index.search('felines', { mode: 'keyword' }))[0].path).toBe('Notes/Felines.md');
        expect(await index.search('cats', { mode: 'keyword' })).toHaveLength(1);
    });

    it('moves with its folder', async () => {
        const { index, embedder, vault } = await started({ 'Proj/a.md': BEES, 'Proj/b.md': CATS, 'Other/c.md': ML });
        const reads = vault.reads;
        vault.renameFolder('Proj', 'Work/Proj');
        await index.whenIdle();
        expect(vault.reads).toBe(reads);
        expect(embedder?.calls).toHaveLength(1);
        const paths = (await index.search('honey bees cats', { mode: 'keyword', limit: 10 })).map((hit) => hit.path);
        expect([...new Set(paths)].sort()).toEqual(['Work/Proj/a.md', 'Work/Proj/b.md']);
        expect(index.status()).toMatchObject({ notesTotal: 3, chunks: 6 });
    });

    it('leaves the index when it is moved somewhere that is not searched, and comes back when moved out', async () => {
        const { index, vault } = await started({ 'a.md': BEES }, { excludedFolders: ['Private'] });
        vault.rename('a.md', 'Private/a.md');
        await index.whenIdle();
        expect(index.status()).toMatchObject({ notesTotal: 0, chunks: 0 });
        expect(await index.search('honey', { mode: 'keyword' })).toEqual([]);
        vault.rename('Private/a.md', 'Public/a.md');
        await index.whenIdle();
        expect(index.status()).toMatchObject({ notesTotal: 1, chunks: 3, pending: 0 });
        expect((await index.search('honey', { mode: 'keyword' }))[0].path).toBe('Public/a.md');
    });

    it('is read at its new path when an edit was waiting', async () => {
        vi.useFakeTimers();
        const { index, embedder, vault } = await started({ 'a.md': BEES }, { debounceMs: 1000 });
        vault.write('a.md', `${BEES}\n\nA late addition about drones.`);
        vault.rename('a.md', 'b.md');
        await vi.advanceTimersByTimeAsync(1100);
        await index.whenIdle();
        expect(embedder?.texts[embedder.texts.length - 1]).toContain('drones');
        expect((await index.search('drones', { mode: 'keyword' }))[0].path).toBe('b.md');
    });
});

describe('a deleted note', () => {
    it('leaves the index, the search and the store', async () => {
        const { index, vault, store } = await started({ 'Bees.md': BEES, 'Cats.md': CATS });
        vault.remove('Cats.md');
        await index.whenIdle();
        expect(index.status()).toMatchObject({ notesTotal: 1, notesIndexed: 1, chunks: 3 });
        expect(await index.search('cats sleep')).toEqual([]);
        expect((await store.load()).notes.map((note) => note.path)).toEqual(['Bees.md']);
    });

    it('takes a deleted folder’s notes with it', async () => {
        const { index, vault, store } = await started({ 'Proj/a.md': BEES, 'Proj/b.md': CATS, 'c.md': ML });
        vault.removeFolder('Proj');
        await index.whenIdle();
        expect(index.status()).toMatchObject({ notesTotal: 1, chunks: 2 });
        expect((await store.load()).notes.map((note) => note.path)).toEqual(['c.md']);
    });

    it('is forgotten even if it was waiting to be indexed again', async () => {
        vi.useFakeTimers();
        const { index, vault } = await started({ 'a.md': BEES }, { debounceMs: 1000 });
        const reads = vault.reads;
        vault.write('a.md', `${BEES}\n\nmore`);
        vault.remove('a.md');
        await vi.advanceTimersByTimeAsync(2000);
        await index.whenIdle();
        expect(vault.reads).toBe(reads);
        expect(index.status().notesTotal).toBe(0);
    });
});

describe('a change of embedding model', () => {
    it('drops the old vectors and embeds every passage with the new model', async () => {
        const { index, embedder, store, vault } = await started({ 'Bees.md': BEES, 'Cats.md': CATS });
        const reads = vault.reads;
        const next = new FakeEmbedder('fake-int8-128', 128);
        index.setEmbedder(next);
        await index.whenIdle();
        expect(next.texts).toHaveLength(4);
        expect(embedder?.calls).toHaveLength(1);
        expect(index.status()).toMatchObject({ state: 'idle', model: 'fake-int8-128', pending: 0, chunks: 4 });
        const stored = await store.load();
        expect(stored.meta).toMatchObject({ model: 'fake-int8-128', dimensions: 128 });
        for (const note of stored.notes) {
            for (const chunk of note.chunks) {
                expect(chunk.model).toBe('fake-int8-128');
                expect(chunk.embedding).toHaveLength(128);
            }
        }
        expect(vault.reads).toBe(reads);
        expect((await index.search('winter colony queen', { mode: 'semantic' }))[0].path).toBe('Bees.md');
    });

    it('is not a rebuild when the model is the same', async () => {
        const { index } = await started({ 'Bees.md': BEES });
        const same = new FakeEmbedder('fake-int8-256');
        index.setEmbedder(same);
        await index.whenIdle();
        expect(same.calls).toEqual([]);
    });

    it('drops the vectors for good when the model is turned off, and embeds everything when it is turned on again', async () => {
        const { index, store, embedder } = await started({ 'Bees.md': BEES });
        index.setEmbedder(null);
        await index.whenIdle();
        expect(index.status()).toMatchObject({ model: null, state: 'idle', pending: 0 });
        expect((await store.load()).notes[0].chunks.every((chunk) => chunk.embedding === null)).toBe(true);
        await expect(index.search('winter colony queen', { mode: 'semantic' })).rejects.toBeInstanceOf(SearchUnavailableError);
        const again = new FakeEmbedder();
        index.setEmbedder(again);
        await index.whenIdle();
        expect(again.texts).toHaveLength(3);
        expect(embedder?.calls).toHaveLength(1);
    });

    it('adds vectors to an index of keywords without reading the notes again', async () => {
        const { index, vault } = await started({ 'Bees.md': BEES, 'Cats.md': CATS }, { embedder: null });
        const reads = vault.reads;
        const model = new FakeEmbedder();
        index.setEmbedder(model);
        await index.whenIdle();
        expect(model.texts).toHaveLength(4);
        expect(vault.reads).toBe(reads);
        expect(index.status()).toMatchObject({ model: 'fake-int8-256', pending: 0 });
    });

    it('drops an embedding request that was in flight for the old model', async () => {
        const made = setup({ 'Bees.md': BEES });
        const gate = deferred();
        made.embedder!.gate = gate.promise;
        await made.index.start();
        await vi.waitFor(() => expect(made.embedder?.calls).toHaveLength(1));
        const next = new FakeEmbedder('fake-int8-128', 128);
        made.index.setEmbedder(next);
        gate.resolve();
        await made.index.whenIdle();
        expect(next.texts).toHaveLength(3);
        const stored = await made.store.load();
        expect(stored.notes[0].chunks.every((chunk) => chunk.model === 'fake-int8-128')).toBe(true);
    });
});

describe('reconciling on start', () => {
    it('catches what changed while Obsidian was closed, and embeds only what is new', async () => {
        const a = '# A\n\nFirst section of a is stable.\n\n## Edited\n\nThis part of a will change.\n';
        const first = await started({ 'a.md': a, 'b.md': BEES, 'c.md': CATS, 'd.md': ML, 'e.md': '# E\n\nThe e note will be renamed while closed.\n' });
        const { vault, store } = first;
        await first.index.stop();

        vault.write('a.md', a.replace('This part of a will change.', 'This part of a has changed.'), { silent: true });
        vault.write('new.md', '# New\n\nA note that came from another computer.\n', { silent: true });
        vault.remove('c.md', { silent: true });
        vault.touch('d.md');
        vault.rename('e.md', 'moved/e2.md', { silent: true });

        const embedder = new FakeEmbedder();
        const second = setup({}, { vault, store, embedder });
        const reads = vault.reads;
        await second.index.start();
        await second.index.whenIdle();

        expect(embedder.texts).toEqual(['a › Edited\n\nThis part of a has changed.', 'new\n\nA note that came from another computer.']);
        // a (changed), new, d (touched), and the renamed note (read to see it is the same text)
        expect(vault.reads - reads).toBe(4);
        expect(second.index.status()).toMatchObject({ state: 'idle', notesTotal: 5, notesIndexed: 5, pending: 0 });
        expect((await second.index.search('another computer'))[0].path).toBe('new.md');
        expect((await second.index.search('changed', { mode: 'keyword' }))[0].path).toBe('a.md');
        expect(await second.index.search('cats sleep')).toEqual([]);
        expect((await second.index.search('renamed while closed', { mode: 'keyword' }))[0].path).toBe('moved/e2.md');
        const stored = await store.load();
        expect(stored.notes.map((note) => note.path).sort()).toEqual(['a.md', 'b.md', 'd.md', 'moved/e2.md', 'new.md']);
    });

    it('does nothing for notes that did not change', async () => {
        const first = await started({ 'a.md': BEES, 'b.md': CATS });
        await first.index.stop();
        const embedder = new FakeEmbedder();
        const second = setup({}, { vault: first.vault, store: first.store, embedder });
        const reads = first.vault.reads;
        await second.index.start();
        await second.index.whenIdle();
        expect(first.vault.reads).toBe(reads);
        expect(embedder.calls).toEqual([]);
        expect(second.index.status()).toMatchObject({ state: 'idle', chunks: 4, pending: 0 });
        expect((await second.index.search('winter colony queen', { mode: 'semantic' }))[0].path).toBe('a.md');
    });

    it('embeds again at once the passages that never got a vector', async () => {
        const first = setup({ 'a.md': BEES });
        first.embedder!.failures.push(httpError(503));
        await first.index.start();
        await first.index.whenIdle();
        expect(first.index.status().state).toBe('paused');
        await first.index.stop();
        const embedder = new FakeEmbedder();
        const second = setup({}, { vault: first.vault, store: first.store, embedder });
        await second.index.start();
        await second.index.whenIdle();
        expect(embedder.texts).toHaveLength(3);
        expect(second.index.status()).toMatchObject({ state: 'idle', pending: 0 });
    });

    it('rebuilds from the text, without the vectors, when the stored vectors are from another model', async () => {
        const first = await started({ 'a.md': BEES });
        await first.index.stop();
        const embedder = new FakeEmbedder('fake-int8-64', 64);
        const second = setup({}, { vault: first.vault, store: first.store, embedder });
        const reads = first.vault.reads;
        await second.index.start();
        await second.index.whenIdle();
        expect(embedder.texts).toHaveLength(3);
        expect(first.vault.reads).toBe(reads);
        const stored = await first.store.load();
        expect(stored.meta?.model).toBe('fake-int8-64');
        expect(stored.notes[0].chunks.every((chunk) => chunk.model === 'fake-int8-64')).toBe(true);
    });

    it('starts over when the stored index was made by a different chunker', async () => {
        const first = await started({ 'a.md': BEES });
        await first.index.stop();
        await first.store.open();
        await first.store.write([{ type: 'meta', meta: { key: 'index', schema: 1, chunker: 0, model: 'fake-int8-256', dimensions: 256 } }]);
        const embedder = new FakeEmbedder();
        const second = setup({}, { vault: first.vault, store: first.store, embedder });
        await second.index.start();
        await second.index.whenIdle();
        expect(embedder.texts).toHaveLength(3);
        expect((await first.store.load()).meta?.chunker).toBe(1);
    });

    it('survives a stored record that is not usable', async () => {
        const first = await started({ 'a.md': BEES, 'b.md': CATS });
        await first.index.stop();
        await first.store.open();
        await first.store.write([{ type: 'put', note: { path: 'broken.md' } as never, chunks: 'garbage' as never }]);
        const second = setup({}, { vault: first.vault, store: first.store });
        await second.index.start();
        await second.index.whenIdle();
        expect(second.index.status()).toMatchObject({ state: 'idle', notesTotal: 2, chunks: 4 });
    });
});

describe('with IndexedDB', () => {
    it('keeps the index across a restart, vectors included', async () => {
        const factory = new IDBFactory() as unknown as IDBFactory;
        const vault = new FakeNoteVault();
        vault.write('a.md', BEES, { silent: true });
        vault.write('b.md', CATS, { silent: true });
        const app = { vault, appId: 'v' } as unknown as App;

        const embedder = new FakeEmbedder();
        const first = new NoteIndex({ app, store: new IdbIndexStore('alphaino-index:v', factory), embedder, debounceMs: 5, log: () => {} });
        running.push(first);
        await first.start();
        await first.whenIdle();
        expect(embedder.texts).toHaveLength(4);
        await first.stop();

        const embedder2 = new FakeEmbedder();
        const second = new NoteIndex({ app, store: new IdbIndexStore('alphaino-index:v', factory), embedder: embedder2, debounceMs: 5, log: () => {} });
        running.push(second);
        const reads = vault.reads;
        await second.start();
        await second.whenIdle();
        expect(embedder2.calls).toEqual([]);
        expect(vault.reads).toBe(reads);
        expect(second.status()).toMatchObject({ state: 'idle', chunks: 4, notesTotal: 2 });
        expect((await second.search('winter colony queen', { mode: 'semantic' }))[0]).toMatchObject({ path: 'a.md', source: 'semantic' });
    });

    it('names the database for the app id, or the vault name when there is none', async () => {
        const factory = new IDBFactory() as unknown as IDBFactory;
        vi.stubGlobal('indexedDB', factory);
        const withId = new NoteIndex({ app: { vault: new FakeNoteVault('Named'), appId: 'abc123' } as unknown as App, log: () => {} });
        running.push(withId);
        await withId.start();
        const withoutId = new NoteIndex({ app: { vault: new FakeNoteVault('Named') } as unknown as App, log: () => {} });
        running.push(withoutId);
        await withoutId.start();
        expect((await factory.databases()).map((db) => db.name).sort()).toEqual(['alphaino-index:Named', 'alphaino-index:abc123']);
    });

    it('is in error, not silent, when there is no IndexedDB', async () => {
        const index = new NoteIndex({ app: { vault: new FakeNoteVault(), appId: 'x' } as unknown as App, log: () => {} });
        running.push(index);
        await index.start();
        expect(index.status()).toMatchObject({ state: 'error', lastError: expect.stringContaining('IndexedDB is not available') });
        await expect(index.search('anything')).rejects.toBeInstanceOf(SearchUnavailableError);
    });
});

describe('waiting before indexing a changed note', () => {
    it('reads a note once, three seconds after its last change, however often it changed', async () => {
        vi.useFakeTimers();
        const { index, embedder, vault } = await started({ 'a.md': BEES }, { debounceMs: 3000 });
        const reads = vault.reads;
        for (let i = 1; i <= 5; i += 1) {
            vault.write('a.md', `${BEES}\n\nEdit number ${i} of this note is here.`);
            await vi.advanceTimersByTimeAsync(500);
        }
        // 500 ms after the last change.
        await vi.advanceTimersByTimeAsync(2400);
        expect(vault.reads).toBe(reads);
        expect(index.status().state).toBe('idle');
        await vi.advanceTimersByTimeAsync(200);
        await index.whenIdle();
        expect(vault.reads).toBe(reads + 1);
        expect(embedder?.calls).toHaveLength(2);
        expect(embedder?.calls[1]).toHaveLength(1);
        expect(embedder?.calls[1][0]).toContain('Edit number 5 of this note is here.');
        expect(embedder?.calls[1][0]).not.toContain('Edit number 4');
    });

    it('waits for each note separately', async () => {
        vi.useFakeTimers();
        const { index, vault } = await started({ 'a.md': BEES, 'b.md': CATS }, { debounceMs: 3000 });
        const reads = vault.reads;
        vault.write('a.md', `${BEES}\n\nAn edit to a.`);
        await vi.advanceTimersByTimeAsync(2000);
        vault.write('b.md', `${CATS}\nAn edit to b.`);
        await vi.advanceTimersByTimeAsync(1100);
        // a's quiet time is over, b's is not.
        expect(vault.reads).toBe(reads + 1);
        await vi.advanceTimersByTimeAsync(2000);
        await index.whenIdle();
        expect(vault.reads).toBe(reads + 2);
    });
});

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

describe('keyword search', () => {
    const notes = {
        'Bees.md': BEES,
        'Cats.md': CATS,
        'ML.md': ML,
        'Zoo.md': '# Zoo\n\nThe zoo has a category of animals called felines.',
        'Wide.md': '# Wide\n\nＧＰＴ模型 and the 猫 sat down.',
    };

    it('finds Chinese text by characters and pairs, and ranks the best note first', async () => {
        const { index } = await started(notes, { embedder: null });
        const hits = await index.search('机器学习', { mode: 'keyword' });
        expect(hits[0]).toMatchObject({ path: 'ML.md', source: 'keyword', heading: '机器学习', title: 'ML' });
        const network = await index.search('神经网络', { mode: 'keyword' });
        expect(network[0]).toMatchObject({ path: 'ML.md', heading: '神经网络' });
        expect((await index.search('神经', { mode: 'keyword' }))[0].path).toBe('ML.md');
        expect((await index.search('猫', { mode: 'keyword' }))[0].path).toBe('Wide.md');
    });

    it('ranks the note that has a CJK pair above one that only has its characters', async () => {
        const { index } = await started({ 'pair.md': '机器学习很有用。', 'chars.md': '机器人学校很有用。' }, { embedder: null });
        const hits = await index.search('器学', { mode: 'keyword' });
        expect(hits.map((hit) => hit.path)).toEqual(['pair.md', 'chars.md']);
        expect(hits[0].score).toBeGreaterThan(hits[1].score);
        // A pair that occurs nowhere, and no character of it either, finds nothing.
        expect(await index.search('猫狗', { mode: 'keyword' })).toEqual([]);
    });

    it('finds English words whatever their case, and only as whole words', async () => {
        const { index } = await started(notes, { embedder: null });
        expect((await index.search('HONEY', { mode: 'keyword' }))[0].path).toBe('Bees.md');
        expect((await index.search('Honey Bees', { mode: 'keyword' }))[0]).toMatchObject({ path: 'Bees.md', heading: 'Bees' });
        const cat = await index.search('cat', { mode: 'keyword' });
        expect(cat.map((hit) => hit.path)).toEqual([]);
        const cats = await index.search('cats', { mode: 'keyword' });
        expect(cats[0].path).toBe('Cats.md');
        expect((await index.search('category', { mode: 'keyword' }))[0].path).toBe('Zoo.md');
    });

    it('treats full-width text as ordinary text', async () => {
        const { index } = await started(notes, { embedder: null });
        expect((await index.search('gpt', { mode: 'keyword' }))[0].path).toBe('Wide.md');
        expect((await index.search('ＧＰＴ', { mode: 'keyword' }))[0].path).toBe('Wide.md');
    });

    it('finds a note by its title and its headings', async () => {
        const { index } = await started({ 'Garden planning.md': '# Overview\n\nSome words.\n\n## Calibration\n\nOther words.' }, { embedder: null });
        expect((await index.search('garden', { mode: 'keyword' }))[0].path).toBe('Garden planning.md');
        expect((await index.search('calibration', { mode: 'keyword' }))[0]).toMatchObject({ heading: 'Calibration' });
    });

    it('returns nothing for a query with no matches or no text', async () => {
        const { index } = await started(notes, { embedder: null });
        expect(await index.search('xylophone', { mode: 'keyword' })).toEqual([]);
        expect(await index.search('   ', { mode: 'keyword' })).toEqual([]);
        expect(await index.search('!!! ??? ...', { mode: 'keyword' })).toEqual([]);
    });

    it('reports where a passage is: heading, path of headings, lines, and its text', async () => {
        const { index } = await started({ 'Bees.md': BEES }, { embedder: null });
        const [hit] = await index.search('queen', { mode: 'keyword' });
        expect(hit).toEqual({
            path: 'Bees.md',
            title: 'Bees',
            heading: 'Winter',
            headingPath: ['Bees', 'Winter'],
            startLine: 7,
            endLine: 7,
            text: 'In winter the colony clusters around the queen to stay warm.',
            score: expect.any(Number),
            source: 'keyword',
        });
        expect(hit.score).toBeGreaterThan(0);
    });

    it('cuts a long passage to about 1200 characters', async () => {
        const long = `# T\n\n${'Sentence about zebras goes here. '.repeat(100)}`;
        const { index } = await started({ 'a.md': long }, { embedder: null, chunkUnits: 5000 });
        const [hit] = await index.search('zebras', { mode: 'keyword' });
        expect(hit.text.length).toBeLessThanOrEqual(1202);
        expect(hit.text.endsWith(' …')).toBe(true);
    });
});

describe('quoted phrases', () => {
    const notes = {
        'a.md': 'The winter cluster keeps the queen warm.\n\nCold days.',
        'b.md': 'A cluster in winter, and a winter far away.',
        'c.md': 'A wrapped line says winter\ncluster here.',
        'Winter cluster.md': 'Nothing else to say.',
    };

    it('must occur exactly, whatever the case and the line breaks, and the title counts', async () => {
        const { index } = await started(notes, { embedder: null });
        const paths = async (query: string) => [...new Set((await index.search(query, { mode: 'keyword', limit: 10 })).map((hit) => hit.path))].sort();
        expect(await paths('"Winter Cluster"')).toEqual(['Winter cluster.md', 'a.md', 'c.md']);
        expect(await paths('winter cluster')).toEqual(['Winter cluster.md', 'a.md', 'b.md', 'c.md']);
        expect(await paths('"cluster winter"')).toEqual([]);
        expect(await paths('“winter cluster”')).toEqual(['Winter cluster.md', 'a.md', 'c.md']);
    });

    it('narrow a keyword query, and the other words still rank what is left', async () => {
        const { index } = await started(notes, { embedder: null });
        const hits = await index.search('queen "winter cluster"', { mode: 'keyword', limit: 10 });
        expect(hits[0].path).toBe('a.md');
        expect(hits.map((hit) => hit.path)).not.toContain('b.md');
    });

    it('may all be required together', async () => {
        const { index } = await started(notes, { embedder: null });
        expect((await index.search('"winter cluster" "queen warm"', { mode: 'keyword' })).map((hit) => hit.path)).toEqual(['a.md']);
        expect(await index.search('"winter cluster" "no such words"', { mode: 'keyword' })).toEqual([]);
    });

    it('are sent to the model without their quotes', async () => {
        const { index, embedder } = await started(notes);
        await index.search('queen "winter cluster"');
        expect(embedder?.queries).toEqual(['queen winter cluster']);
    });
});

describe('how much of the vault is searched', () => {
    function slowReads(vault: FakeNoteVault) {
        const gate = deferred();
        const read = vault.read.bind(vault);
        vault.read = async (file) => {
            await gate.promise;
            return read(file);
        };
        return gate;
    }

    it('counts the note being read as not indexed yet, in the status and in a search', async () => {
        const vault = new FakeNoteVault();
        vault.write('a.md', 'Otters like rivers.', { silent: true });
        vault.write('b.md', 'Otters like the sea.', { silent: true });
        const gate = slowReads(vault);
        const made = setup({}, { vault, embedder: null });
        await made.index.start();
        expect(made.index.status()).toMatchObject({ state: 'indexing', notesTotal: 2, notesIndexed: 0, pending: 2 });
        const early = await made.index.searchDetailed('otters', { mode: 'keyword' });
        expect(early.hits).toEqual([]);
        expect(early.warnings).toEqual(['2 of 2 notes are not indexed yet, so results may leave them out.']);
        gate.resolve();
        await made.index.whenIdle();
        const later = await made.index.searchDetailed('otters', { mode: 'keyword' });
        expect(later.warnings).toEqual([]);
        expect(later.hits).toHaveLength(2);
        expect(made.index.status()).toMatchObject({ state: 'idle', notesIndexed: 2, pending: 0 });
    });
});

describe('search by meaning and hybrid search', () => {
    const notes = {
        'Cars.md': 'The red car drove past the house.',
        'Garage.md': 'An automobile rests in the garage.',
        'Noise.md':
            '# Noise\n\nalpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau car upsilon phi chi psi omega.',
        'Cats.md': CATS,
    };

    it('finds a note that shares no word with the query', async () => {
        const { index } = await started(notes);
        const hits = await index.search('vehicle', { mode: 'semantic' });
        expect(hits.map((hit) => hit.path)).toEqual(expect.arrayContaining(['Cars.md', 'Garage.md']));
        expect(hits.every((hit) => hit.source === 'semantic')).toBe(true);
        expect(hits[0].score).toBeGreaterThan(0.25);
        expect(hits[0].score).toBeLessThanOrEqual(1);
        expect(await index.search('vehicle', { mode: 'keyword' })).toEqual([]);
    });

    it('puts what both rankings find first, and says which ranking found each hit', async () => {
        const { index } = await started(notes);
        const response = await index.searchDetailed('car');
        expect(response.mode).toBe('hybrid');
        expect(response.warnings).toEqual([]);
        const sources = new Map(response.hits.map((hit) => [hit.path, hit.source]));
        expect(sources.get('Cars.md')).toBe('both');
        expect(sources.get('Garage.md')).toBe('semantic');
        expect(sources.get('Noise.md')).toBe('keyword');
        expect(sources.has('Cats.md')).toBe(false);
        expect(response.hits[0].path).toBe('Cars.md');
        expect(response.hits[0].score).toBeGreaterThan(0.9);
        expect(response.hits[0].score).toBeLessThanOrEqual(1);
        for (let i = 1; i < response.hits.length; i += 1) expect(response.hits[i].score).toBeLessThanOrEqual(response.hits[i - 1].score);
    });

    it('embeds the query once per search', async () => {
        const { index, embedder } = await started(notes);
        await index.search('car');
        await index.search('car', { mode: 'keyword' });
        expect(embedder?.queries).toEqual(['car']);
    });

    it('falls back to keywords when there is no model, and says so', async () => {
        const { index } = await started(notes, { embedder: null });
        const response = await index.searchDetailed('car');
        expect(response.mode).toBe('keyword');
        expect(response.warnings[0]).toContain('No embedding model is set up');
        expect(response.hits.map((hit) => hit.path)).toEqual(expect.arrayContaining(['Cars.md', 'Noise.md']));
        await expect(index.search('car', { mode: 'semantic' })).rejects.toThrow(/No embedding model is set up/);
    });

    it('falls back to keywords while nothing is embedded yet', async () => {
        const made = setup(notes);
        made.embedder!.failures.push(httpError(503));
        await made.index.start();
        await made.index.whenIdle();
        const response = await made.index.searchDetailed('car');
        expect(response.mode).toBe('keyword');
        expect(response.warnings[0]).toContain('No note has been embedded yet');
        await expect(made.index.search('car', { mode: 'semantic' })).rejects.toBeInstanceOf(SearchUnavailableError);
    });

    it('falls back to keywords when the query cannot be embedded, naming the reason', async () => {
        const { index, embedder } = await started(notes);
        embedder!.queryFailure = httpError(429);
        const response = await index.searchDetailed('car');
        expect(response.mode).toBe('keyword');
        expect(response.warnings[0]).toContain('limiting requests');
        expect(response.hits.length).toBeGreaterThan(0);
        await expect(index.search('car', { mode: 'semantic' })).rejects.toThrow(/limiting requests/);
    });

    it('warns that search by meaning is partial while the index is still being built', async () => {
        const made = setup(notes);
        await made.index.start();
        await made.index.whenIdle();
        made.vault.write('Late.md', 'The late car arrived at the station.');
        // Indexed for keywords, not yet embedded:
        made.embedder!.gate = new Promise(() => {});
        await vi.waitFor(() => expect(made.index.status().pending).toBeGreaterThan(0));
        await vi.waitFor(() => expect(made.index.status().chunks).toBe(5));
        const response = await made.index.searchDetailed('car');
        expect(response.warnings.join(' ')).toContain('covers 4 of 5 passages');
    });
});

describe('what a search returns', () => {
    it('is at most two passages of a note, whatever its length', async () => {
        const sections = Array.from({ length: 6 }, (_, i) => `## Part ${i}\n\nBananas are discussed here in part ${i}.`).join('\n\n');
        const { index } = await started({ 'Long.md': `# Long\n\n${sections}`, 'Short.md': 'One note that mentions bananas once.' }, { embedder: null });
        const hits = await index.search('bananas', { mode: 'keyword', limit: 10 });
        expect(hits.filter((hit) => hit.path === 'Long.md')).toHaveLength(2);
        expect(hits.filter((hit) => hit.path === 'Short.md')).toHaveLength(1);
    });

    it('is limited to what was asked for, 8 by default', async () => {
        const notes: Record<string, string> = {};
        for (let i = 0; i < 20; i += 1) notes[`n${i}.md`] = `Mentions the pear here ${i}.`;
        const { index } = await started(notes, { embedder: null });
        expect(await index.search('pear', { mode: 'keyword' })).toHaveLength(8);
        expect(await index.search('pear', { mode: 'keyword', limit: 3 })).toHaveLength(3);
        expect(await index.search('pear', { mode: 'keyword', limit: 500 })).toHaveLength(20);
    });

    it('can be limited to a folder, ignoring case', async () => {
        const { index } = await started(
            { 'Alpha/a.md': 'A note about lemons.', 'Alpha/Sub/b.md': 'Another note about lemons.', 'Beta/c.md': 'A third note about lemons.', 'Alphabet/d.md': 'Lemons too.' },
            { embedder: null },
        );
        const hits = await index.search('lemons', { mode: 'keyword', folder: 'alpha' });
        expect(hits.map((hit) => hit.path).sort()).toEqual(['Alpha/Sub/b.md', 'Alpha/a.md']);
        expect(await index.search('lemons', { mode: 'keyword', folder: '/Beta/' })).toHaveLength(1);
        expect(await index.search('lemons', { mode: 'keyword', folder: 'Nowhere' })).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// What is and is not searched
// ---------------------------------------------------------------------------

describe('which notes are searched', () => {
    const notes = {
        'Notes/n.md': 'A visible note about walnuts.',
        '.hidden/x.md': 'A hidden note about walnuts.',
        'Agent/.alphaino/conv.md': 'AlphainO’s own file about walnuts.',
        'Templates/t.md': 'A template about walnuts.',
        'Archive/Old/o.md': 'An old note about walnuts.',
        'Notes/.draft.md': 'A dot file about walnuts.',
        'Notes/big.md': `A big note about walnuts. ${'x'.repeat(2000)}`,
        'Notes/image.png': 'not a note',
    };

    it('skips dot-folders, excluded folders, big notes and other files', async () => {
        const { index } = await started(notes, { excludedFolders: ['Templates', '/archive/old/'], maxNoteBytes: 1000 });
        expect(index.status()).toMatchObject({ notesTotal: 1, notesIndexed: 1, chunks: 1 });
        expect((await index.search('walnuts', { mode: 'keyword', limit: 20 })).map((hit) => hit.path)).toEqual(['Notes/n.md']);
    });

    it('ignores changes to notes that are not searched', async () => {
        const { index, vault } = await started(notes, { excludedFolders: ['Templates', 'Archive/Old'], maxNoteBytes: 1000 });
        const reads = vault.reads;
        vault.write('Templates/new.md', 'A new template about walnuts.');
        vault.write('.hidden/y.md', 'Another hidden note about walnuts.');
        vault.write('Agent/.alphaino/other.md', 'More of its own about walnuts.');
        await index.whenIdle();
        expect(vault.reads).toBe(reads);
        expect(index.status().notesTotal).toBe(1);
    });

    it('drops a note that grows past the size limit', async () => {
        const { index, vault } = await started({ 'a.md': 'A small note about walnuts.' }, { maxNoteBytes: 1000 });
        vault.write('a.md', `A grown note about walnuts. ${'y'.repeat(2000)}`);
        await index.whenIdle();
        expect(index.status()).toMatchObject({ notesTotal: 0, chunks: 0 });
        expect(await index.search('walnuts', { mode: 'keyword' })).toEqual([]);
    });

    it('follows a change of the excluded folders', async () => {
        const { index } = await started(notes, { excludedFolders: ['Templates', 'Archive/Old'], maxNoteBytes: 1000 });
        index.setExcludedFolders([]);
        await index.whenIdle();
        expect(index.status().notesTotal).toBe(3);
        index.setExcludedFolders(['archive']);
        await index.whenIdle();
        expect((await index.search('walnuts', { mode: 'keyword', limit: 20 })).map((hit) => hit.path).sort()).toEqual(['Notes/n.md', 'Templates/t.md']);
        index.setExcludedFolders(['archive', '', '/Templates/']);
        await index.whenIdle();
        expect(index.status().notesTotal).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Status, failures and cleaning up
// ---------------------------------------------------------------------------

describe('status', () => {
    it('is off until started and after stopping, and tells listeners as it changes', async () => {
        const made = setup({ 'a.md': BEES });
        const seen: IndexStatus[] = [];
        const stopListening = made.index.onStatusChange((status) => seen.push(status));
        expect(made.index.status()).toMatchObject({ state: 'off', notesTotal: 0, chunks: 0, model: 'fake-int8-256' });
        await made.index.start();
        await made.index.whenIdle();
        const states = seen.map((status) => status.state);
        expect(states[0]).toBe('indexing');
        expect(states[states.length - 1]).toBe('idle');
        expect(seen[seen.length - 1]).toMatchObject({ notesTotal: 1, chunks: 3, pending: 0 });
        await made.index.stop();
        expect(made.index.status().state).toBe('off');
        expect(seen[seen.length - 1].state).toBe('off');
        stopListening();
        const count = seen.length;
        await made.index.start();
        await made.index.whenIdle();
        expect(seen).toHaveLength(count);
    });

    it('survives a listener that throws', async () => {
        const made = setup({ 'a.md': BEES });
        made.index.onStatusChange(() => {
            throw new Error('listener bug');
        });
        const seen: string[] = [];
        made.index.onStatusChange((status) => seen.push(status.state));
        await made.index.start();
        await made.index.whenIdle();
        expect(seen[seen.length - 1]).toBe('idle');
    });
});

describe('when the embedding provider fails', () => {
    it('pauses, keeps keyword search current, and carries on when told to retry', async () => {
        const made = setup({ 'a.md': BEES, 'b.md': CATS });
        made.embedder!.failures.push(httpError(503));
        const before = Date.now();
        await made.index.start();
        await made.index.whenIdle();
        const paused = made.index.status();
        expect(paused).toMatchObject({ state: 'paused', pending: 2, chunks: 4, lastError: expect.stringContaining('server problem (503)') });
        expect(paused.retryAt).toBeGreaterThan(before);

        // Notes keep being indexed for keywords, and no further request is made.
        made.vault.write('c.md', 'A late note about zebras.');
        await made.index.whenIdle();
        expect(made.embedder?.calls).toHaveLength(1);
        expect((await made.index.search('zebras', { mode: 'keyword' }))[0].path).toBe('c.md');
        expect(made.index.status()).toMatchObject({ state: 'paused', chunks: 5, pending: 3 });

        made.index.retry();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', pending: 0, lastError: null, retryAt: null });
        expect(made.embedder?.texts).toHaveLength(4 + 5);
    });

    it('tries again by itself, later each time it fails', async () => {
        vi.useFakeTimers();
        const made = setup({ 'a.md': BEES });
        made.embedder!.failures.push(httpError(503), httpError(503));
        await made.index.start();
        await made.index.whenIdle();
        const first = made.index.status();
        expect(first.state).toBe('paused');
        const firstWait = (first.retryAt ?? 0) - Date.now();
        expect(firstWait).toBeGreaterThanOrEqual(4000);
        expect(firstWait).toBeLessThanOrEqual(6000);

        await vi.advanceTimersByTimeAsync(firstWait + 10);
        await made.index.whenIdle();
        const second = made.index.status();
        expect(second.state).toBe('paused');
        const secondWait = (second.retryAt ?? 0) - Date.now();
        expect(secondWait).toBeGreaterThan(firstWait * 1.5);

        await vi.advanceTimersByTimeAsync(secondWait + 10);
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', pending: 0, lastError: null });
        expect(made.embedder?.calls).toHaveLength(3);
    });

    it('waits as long as the provider asks', async () => {
        const made = setup({ 'a.md': BEES });
        made.embedder!.failures.push(httpError(429, { retryAfterMs: 90_000 }));
        await made.index.start();
        await made.index.whenIdle();
        const wait = (made.index.status().retryAt ?? 0) - Date.now();
        expect(wait).toBeGreaterThan(85_000);
        expect(wait).toBeLessThanOrEqual(90_000);
    });

    it('waits for the day to turn over when the day’s allowance is spent', async () => {
        const made = setup({ 'a.md': BEES });
        made.embedder!.failures.push(httpError(429, { code: 'daily_quota', retryAfterMs: 3_600_000, quotaTier: 'free' }));
        await made.index.start();
        await made.index.whenIdle();
        const status = made.index.status();
        expect(status.state).toBe('paused');
        expect(status.lastError).toContain('used up today');
        const wait = (status.retryAt ?? 0) - Date.now();
        expect(wait).toBeGreaterThan(3_500_000);
        expect(wait).toBeLessThanOrEqual(3_600_000);
    });

    it('waits for the user when the key is refused, and carries on with a new provider', async () => {
        const made = setup({ 'a.md': BEES });
        made.embedder!.failures.push(httpError(401));
        await made.index.start();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'paused', retryAt: null, lastError: expect.stringContaining('rejected the API key') });
        const fixed = new FakeEmbedder();
        made.index.setEmbedder(fixed);
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', lastError: null, pending: 0 });
        expect(fixed.texts).toHaveLength(3);
    });

    it('waits for the user when the vectors have the wrong length', async () => {
        const made = setup({ 'a.md': BEES });
        made.embedder!.vector = () => new Int8Array(8);
        await made.index.start();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'paused', retryAt: null, lastError: expect.stringContaining('length 8') });
        expect((await made.store.load()).notes[0].chunks.every((chunk) => chunk.embedding === null)).toBe(true);
    });

    it('leaves out of semantic search a passage the model refuses, and carries on with the rest', async () => {
        const made = setup({ 'good.md': BEES, 'bad.md': 'This note has a POISON passage.', 'fine.md': CATS });
        made.embedder!.refuseIf = (texts) => texts.some((text) => text.includes('POISON'));
        await made.index.start();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', pending: 0, lastError: null });
        const stored = (await made.store.load()).notes;
        expect(stored.find((note) => note.path === 'bad.md')).toMatchObject({ embedError: expect.stringContaining('400') });
        expect(stored.find((note) => note.path === 'good.md')?.chunks.every((chunk) => chunk.embedding !== null)).toBe(true);
        expect(stored.find((note) => note.path === 'fine.md')?.chunks.every((chunk) => chunk.embedding !== null)).toBe(true);
        // Still found by keywords, and not asked for again.
        expect((await made.index.search('poison', { mode: 'keyword' }))[0].path).toBe('bad.md');
        const calls = made.embedder!.calls.length;
        await made.index.stop();
        const second = setup({}, { vault: made.vault, store: made.store, embedder: made.embedder });
        await second.index.start();
        await second.index.whenIdle();
        expect(made.embedder!.calls).toHaveLength(calls);

        // Edited so the model takes it, it is embedded.
        made.vault.write('bad.md', 'This note is fine now.');
        await second.index.whenIdle();
        const after = (await made.store.load()).notes.find((note) => note.path === 'bad.md');
        expect(after?.embedError).toBeUndefined();
        expect(after?.chunks[0].embedding).not.toBeNull();
    });

    it('blames the provider, not the texts, when several are refused in a row', async () => {
        const notes: Record<string, string> = {};
        for (let i = 0; i < 6; i += 1) notes[`p${i}.md`] = `POISON number ${i}.`;
        const made = setup(notes);
        made.embedder!.refuseIf = () => true;
        await made.index.start();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'paused', retryAt: null, lastError: expect.stringContaining('failed') });
        // 1 request for the batch, then one per text until the third refusal.
        expect(made.embedder?.calls).toHaveLength(4);
    });

    it('does not mark a note as failed because the network was down', async () => {
        const made = setup({ 'a.md': BEES });
        made.embedder!.failures.push(new ModelRequestError('Fake embeddings could not be reached', { kind: 'network', label: 'Fake' }));
        await made.index.start();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'paused', lastError: expect.stringContaining('could not be reached') });
        expect((await made.store.load()).notes[0].embedError).toBeUndefined();
        made.index.retry();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', pending: 0 });
    });
});

describe('edits while embedding', () => {
    it('embeds a note that was edited while its first embedding was on the way', async () => {
        const made = setup({ 'a.md': BEES });
        const gate = deferred();
        made.embedder!.gate = gate.promise;
        await made.index.start();
        await vi.waitFor(() => expect(made.embedder?.calls).toHaveLength(1));
        made.vault.write('a.md', BEES.replace('Honey bees collect nectar and pollen from flowers.', 'Bumblebees collect nectar too.'));
        await new Promise((resolve) => setTimeout(resolve, 30));
        gate.resolve();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', pending: 0, chunks: 3 });
        expect(made.embedder?.calls).toHaveLength(2);
        expect(made.embedder?.calls[1]).toEqual(['a › Bees\n\nBumblebees collect nectar too.']);
        expect((await made.index.search('bumblebees', { mode: 'semantic' }))[0].path).toBe('a.md');
    });

    it('embeds a note again at its new path when it was renamed while its embedding was on the way', async () => {
        const made = setup({ 'a.md': BEES });
        const gate = deferred();
        made.embedder!.gate = gate.promise;
        await made.index.start();
        await vi.waitFor(() => expect(made.embedder?.calls).toHaveLength(1));
        made.vault.rename('a.md', 'b.md');
        gate.resolve();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', pending: 0 });
        const stored = (await made.store.load()).notes;
        expect(stored.map((note) => note.path)).toEqual(['b.md']);
        expect(stored[0].chunks.every((chunk) => chunk.embedding !== null)).toBe(true);
    });

    it('drops the embedding of a note deleted while it was on the way', async () => {
        const made = setup({ 'a.md': BEES, 'b.md': CATS });
        const gate = deferred();
        made.embedder!.gate = gate.promise;
        await made.index.start();
        await vi.waitFor(() => expect(made.embedder?.calls).toHaveLength(1));
        made.vault.remove('a.md');
        gate.resolve();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', pending: 0, notesTotal: 1, chunks: 1 });
        expect((await made.store.load()).notes.map((note) => note.path)).toEqual(['b.md']);
    });
});

describe('when the index cannot be saved', () => {
    it('is in error, keeps working from memory, and recovers when saving works again', async () => {
        const store = new MemoryIndexStore();
        const made = setup({ 'a.md': BEES }, { store });
        store.failWith = new Error('disk full');
        await made.index.start();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'error', lastError: expect.stringContaining('disk full') });
        expect((await made.index.search('queen'))[0].path).toBe('a.md');
        store.failWith = null;
        made.vault.write('b.md', CATS);
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', lastError: null });
    });
});

describe('unreadable notes', () => {
    it('are reported and skipped, and the rest are indexed', async () => {
        const vault = new FakeNoteVault();
        vault.write('good.md', BEES, { silent: true });
        vault.write('bad.md', CATS, { silent: true });
        const read = vault.read.bind(vault);
        vault.read = async (file) => {
            if (file.path === 'bad.md') throw new Error('EACCES');
            return read(file);
        };
        const log = vi.fn();
        const made = setup({}, { vault, log });
        await made.index.start();
        await made.index.whenIdle();
        expect(log).toHaveBeenCalledWith(expect.stringContaining('bad.md'), expect.any(Error));
        expect(made.index.status()).toMatchObject({ state: 'idle', chunks: 3, notesTotal: 2 });
    });
});

describe('when something goes wrong while indexing', () => {
    it('skips a note it cannot index and indexes the rest', async () => {
        const vault = new FakeNoteVault();
        vault.write('a.md', BEES, { silent: true });
        vault.write('bad.md', CATS, { silent: true });
        vault.write('c.md', ML, { silent: true });
        const read = vault.read.bind(vault);
        vault.read = async (file) => (file.path === 'bad.md' ? (undefined as unknown as string) : read(file));
        const log = vi.fn();
        const made = setup({}, { vault, log });
        await made.index.start();
        await made.index.whenIdle();
        expect(log).toHaveBeenCalledWith('Could not index bad.md.', expect.any(Error));
        expect(made.index.status()).toMatchObject({ state: 'idle', chunks: 5, pending: 0 });
        expect((await made.index.search('queen', { mode: 'keyword' }))[0].path).toBe('a.md');
        expect((await made.index.search('人工智能', { mode: 'keyword' }))[0].path).toBe('c.md');
    });

    it('starts again from a failed load when started again', async () => {
        const vault = new FakeNoteVault();
        vault.write('a.md', BEES, { silent: true });
        const store = new MemoryIndexStore();
        const open = store.open.bind(store);
        let failing = true;
        store.open = async () => {
            if (failing) throw new Error('database locked');
            return open();
        };
        const made = setup({}, { vault, store, embedder: null });
        await made.index.start();
        expect(made.index.status()).toMatchObject({ state: 'error', lastError: expect.stringContaining('database locked') });
        failing = false;
        await made.index.start();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', lastError: null, chunks: 3, notesTotal: 1 });
        expect((await made.index.search('queen', { mode: 'keyword' }))[0].path).toBe('a.md');
    });
});

describe('rebuilding', () => {
    it('starts over from the notes', async () => {
        const made = await started({ 'a.md': BEES, 'b.md': CATS });
        made.vault.remove('b.md', { silent: true });
        made.vault.write('c.md', ML, { silent: true });
        const before = made.embedder!.texts.length;
        await made.index.rebuild();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', notesTotal: 2, chunks: 5, pending: 0 });
        expect(made.embedder!.texts.length - before).toBe(5);
        expect((await made.store.load()).notes.map((note) => note.path).sort()).toEqual(['a.md', 'c.md']);
    });

    it('also clears a pause', async () => {
        const made = setup({ 'a.md': BEES });
        made.embedder!.failures.push(httpError(401));
        await made.index.start();
        await made.index.whenIdle();
        expect(made.index.status().state).toBe('paused');
        await made.index.rebuild();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', lastError: null, pending: 0 });
    });

    it('does nothing when the index is off', async () => {
        const made = setup({ 'a.md': BEES });
        await made.index.rebuild();
        expect(made.index.status().state).toBe('off');
    });
});

describe('stopping', () => {
    it('removes the vault listeners it added, and hands each to the caller to register', async () => {
        const made = setup({ 'a.md': BEES });
        const refs: unknown[] = [];
        await made.index.start((ref) => refs.push(ref));
        expect(refs).toHaveLength(4);
        expect(made.vault.listenerCount()).toBe(4);
        await made.index.stop();
        expect(made.vault.listenerCount()).toBe(0);
    });

    it('leaves no timer running and ignores later changes', async () => {
        vi.useFakeTimers();
        const made = await started({ 'a.md': BEES }, { debounceMs: 3000 });
        made.vault.write('a.md', `${BEES}\n\nOne more line.`);
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        const reads = made.vault.reads;
        await made.index.stop();
        expect(vi.getTimerCount()).toBe(0);
        made.vault.write('a.md', `${BEES}\n\nAnd another line.`);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(made.vault.reads).toBe(reads);
        expect(made.index.status().state).toBe('off');
        await expect(made.index.search('bees')).rejects.toBeInstanceOf(SearchUnavailableError);
    });

    it('cancels a pause timer', async () => {
        vi.useFakeTimers();
        const made = setup({ 'a.md': BEES });
        made.embedder!.failures.push(httpError(503));
        await made.index.start();
        await made.index.whenIdle();
        expect(made.index.status().state).toBe('paused');
        await made.index.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ends an embedding request that is in flight, and saves what was indexed', async () => {
        const made = setup({ 'a.md': BEES });
        made.embedder!.gate = new Promise(() => {});
        await made.index.start();
        await vi.waitFor(() => expect(made.embedder?.calls).toHaveLength(1));
        await made.index.stop();
        expect(made.index.status().state).toBe('off');
        const stored = await made.store.load().catch(() => null);
        // The store was closed by stop; reopen it as the next run would.
        await made.store.open();
        const reopened = stored ?? (await made.store.load());
        expect(reopened.notes.map((note) => note.path)).toEqual(['a.md']);
        expect(reopened.notes[0].chunks).toHaveLength(3);
    });

    it('can be started again', async () => {
        const made = await started({ 'a.md': BEES });
        await made.index.stop();
        const reads = made.vault.reads;
        await made.index.start();
        await made.index.whenIdle();
        expect(made.index.status()).toMatchObject({ state: 'idle', chunks: 3, notesTotal: 1 });
        expect(made.vault.reads).toBe(reads);
        expect((await made.index.search('queen'))[0].path).toBe('a.md');
    });

    it('can be called when it was never started, and twice', async () => {
        const made = setup({ 'a.md': BEES });
        await made.index.stop();
        await made.index.start();
        await made.index.stop();
        await made.index.stop();
        expect(made.index.status().state).toBe('off');
    });
});
