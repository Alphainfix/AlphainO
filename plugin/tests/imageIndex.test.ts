import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { quantizeToInt8 } from '@beaver/agent-llm/embeddings';
import { ModelRequestError } from '@beaver/agent-llm/sse';
import { summarizeToolResult } from '@beaver/agent-llm/agentLoop';
import { buildNoteEmbedder, type NoteEmbedder } from '../src/search/embedder';
import { ImageIndex, type ImageIndexOptions } from '../src/search/imageIndex';
import { UnreadableImageError, type PreparedImage } from '../src/search/imagePrep';
import { MemoryImageStore } from '../src/search/imageStore';
import { NoteIndex, SearchUnavailableError } from '../src/search/noteIndex';
import { MemoryIndexStore } from '../src/search/store';
import { FakeNoteVault } from './obsidianStub';

// ---------------------------------------------------------------------------
// Test doubles: a "picture" is a file whose text describes what it shows, and
// the fake model embeds a picture and a query by their words, so a query finds
// the picture that shares its words.
// ---------------------------------------------------------------------------

function bucket(token: string, dimensions: number): number {
    let hash = 7;
    for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash % dimensions;
}

function wordVector(text: string, dimensions: number): Int8Array {
    const values = new Array<number>(dimensions).fill(0);
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) values[bucket(word, dimensions)] += 1;
    return Int8Array.from(quantizeToInt8(values));
}

class FakePictureEmbedder implements NoteEmbedder {
    readonly label = 'Fake';
    readonly embedsImages: boolean;
    /** What each picture request carried, as the pictures' descriptions. */
    imageCalls: string[][] = [];
    queries: string[] = [];
    /** Errors for the next picture requests, one each. */
    failures: unknown[] = [];
    /** Refuses (400) any request with a picture this accepts. */
    refuse: ((description: string) => boolean) | null = null;
    /** Holds picture requests until it resolves. */
    gate: Promise<void> | null = null;

    constructor(
        readonly modelId = 'fake-pictures-int8-64',
        readonly dimensions = 64,
        embedsImages = true,
    ) {
        this.embedsImages = embedsImages;
    }

    get described(): string[] {
        return this.imageCalls.flat();
    }

    async embedDocuments(texts: string[]): Promise<Int8Array[]> {
        return texts.map((text) => wordVector(text, this.dimensions));
    }

    async embedQuery(text: string): Promise<Int8Array> {
        this.queries.push(text);
        return wordVector(text, this.dimensions);
    }

    async embedImages(images: Array<{ mimeType: string; base64: string }>): Promise<Int8Array[]> {
        const descriptions = images.map((image) => Buffer.from(image.base64, 'base64').toString('utf8'));
        this.imageCalls.push(descriptions);
        if (this.gate) await this.gate;
        const failure = this.failures.shift();
        if (failure) throw failure;
        if (this.refuse && descriptions.some(this.refuse)) throw new ModelRequestError('Fake embeddings failed: 400', { kind: 'http', status: 400, label: 'Fake' });
        return descriptions.map((description) => wordVector(description, this.dimensions));
    }
}

/** Reads a picture as its description; one starting with "broken" cannot be decoded. */
function makePrepare(): { prepare: (bytes: ArrayBuffer, extension: string) => Promise<PreparedImage>; reads: string[] } {
    const reads: string[] = [];
    return {
        reads,
        prepare: async (bytes) => {
            const text = new TextDecoder().decode(bytes);
            reads.push(text);
            if (text.startsWith('broken')) throw new UnreadableImageError('The picture could not be read.');
            return { mimeType: 'image/jpeg', base64: Buffer.from(text).toString('base64'), width: 8, height: 8 };
        },
    };
}

const FILES: Record<string, string> = {
    'Pictures/cat.png': 'a cat sleeping on a sofa',
    'Pictures/chart.jpg': 'a bar chart of monthly costs',
    'Trips/beach.jpeg': 'a photo of the beach at sunset',
    'Notes/cat.md': 'My cat ![[cat.png]]',
    '.hidden/secret.png': 'a secret diagram',
    'Private/passport.png': 'a passport photo page',
    'Phone/IMG_1.heic': 'a heic photo from a phone',
};

function setup(options: Partial<ImageIndexOptions> & { files?: Record<string, string>; picture?: FakePictureEmbedder | null } = {}) {
    const vault = new FakeNoteVault();
    for (const [path, content] of Object.entries(options.files ?? FILES)) vault.write(path, content, { silent: true });
    const app = { vault } as unknown as App;
    const store = (options.store as MemoryImageStore | undefined) ?? new MemoryImageStore();
    const embedder = options.picture === undefined ? new FakePictureEmbedder() : options.picture;
    const reading = makePrepare();
    const { files: _files, picture: _picture, ...rest } = options;
    const index = new ImageIndex({
        app,
        store,
        embedder,
        enabled: true,
        excludedFolders: ['Private'],
        prepare: reading.prepare,
        debounceMs: 5,
        log: () => {},
        ...rest,
    });
    return { vault, app, store, embedder, index, reads: reading.reads };
}

async function settle(index: ImageIndex, ms = 30): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await index.whenIdle();
}

describe('the picture index', () => {
    it('indexes the pictures outside hidden and excluded folders, and counts the ones it cannot read', async () => {
        const { index, embedder } = setup();
        await index.start();
        await settle(index);
        expect(embedder?.described.sort()).toEqual(['a bar chart of monthly costs', 'a cat sleeping on a sofa', 'a photo of the beach at sunset']);
        const status = index.status();
        expect(status).toMatchObject({ state: 'idle', imagesIndexed: 3, imagesTotal: 4, skipped: 1, pending: 0, offReason: null });
        await index.stop();
    });

    it('finds a picture by what it shows, within a folder when asked', async () => {
        const { index } = setup();
        await index.start();
        await settle(index);
        const found = await index.search('cat sleeping on the sofa');
        expect(found.hits[0]).toMatchObject({ path: 'Pictures/cat.png', name: 'cat.png' });
        // Indexing is done; the HEIC picture is named as one that can never be found.
        expect(found.warnings.join(' ')).not.toMatch(/still being indexed/);
        expect(found.warnings.join(' ')).toMatch(/never found/);
        const inTrips = await index.search('a cat', { folder: 'Trips' });
        expect(inTrips.hits.map((hit) => hit.path)).toEqual(['Trips/beach.jpeg']);
        await index.stop();
    });

    it('stays off while its setting is off or the model reads text only, and says why', async () => {
        const off = setup({ enabled: false });
        await off.index.start();
        await settle(off.index);
        expect(off.embedder?.imageCalls).toEqual([]);
        expect(off.index.status()).toMatchObject({ state: 'off', offReason: 'disabled' });
        await expect(off.index.search('a cat')).rejects.toBeInstanceOf(SearchUnavailableError);
        off.index.setEnabled(true);
        await settle(off.index);
        expect(off.index.status().imagesIndexed).toBe(3);
        await off.index.stop();

        const textOnly = setup({ picture: new FakePictureEmbedder('text-int8-64', 64, false) });
        await textOnly.index.start();
        await settle(textOnly.index);
        expect(textOnly.index.status()).toMatchObject({ state: 'off', offReason: 'text-only' });
        await expect(textOnly.index.search('a cat')).rejects.toThrow(/reads text only/);
        await textOnly.index.stop();

        const none = setup({ picture: null });
        await none.index.start();
        expect(none.index.status().offReason).toBe('no-model');
        await none.index.stop();
    });

    it('waits for its turn (the notes) before sending anything', async () => {
        let release: () => void = () => {};
        const turn = new Promise<void>((resolve) => (release = resolve));
        const { index, embedder } = setup({ waitForTurn: () => turn });
        await index.start();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(embedder?.imageCalls).toEqual([]);
        expect(index.status().pending).toBe(3);
        release();
        await settle(index);
        expect(index.status().imagesIndexed).toBe(3);
        await index.stop();
    });

    it('stops while waiting for its turn', async () => {
        const { index, embedder } = setup({ waitForTurn: () => new Promise<void>(() => {}) });
        await index.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await index.stop();
        expect(embedder?.imageCalls).toEqual([]);
    });

    it('follows the vault: a changed picture again, a removed one gone, a renamed one keeps its vector', async () => {
        const { index, embedder, vault } = setup();
        await index.start();
        await settle(index);
        const before = embedder!.imageCalls.length;

        vault.write('Pictures/chart.jpg', 'a line chart of yearly rainfall');
        await settle(index);
        expect(embedder!.imageCalls.slice(before).flat()).toEqual(['a line chart of yearly rainfall']);
        expect((await index.search('yearly rainfall line chart')).hits[0].path).toBe('Pictures/chart.jpg');

        vault.remove('Trips/beach.jpeg');
        await settle(index);
        expect((await index.search('beach at sunset')).hits.map((hit) => hit.path)).not.toContain('Trips/beach.jpeg');

        const calls = embedder!.imageCalls.length;
        vault.rename('Pictures/cat.png', 'Pictures/kitty.png');
        await settle(index);
        vault.renameFolder('Pictures', 'Images');
        await settle(index);
        expect(embedder!.imageCalls.length).toBe(calls);
        expect((await index.search('cat sleeping on a sofa')).hits[0].path).toBe('Images/kitty.png');
        await index.stop();
    });

    it('leaves out a folder excluded later, and takes it back when it is let in again', async () => {
        const { index } = setup();
        await index.start();
        await settle(index);
        index.setExcludedFolders(['Private', 'Pictures']);
        await settle(index);
        expect((await index.search('a cat sleeping on a sofa')).hits.map((hit) => hit.path)).not.toContain('Pictures/cat.png');
        expect(index.status().imagesTotal).toBe(2);
        index.setExcludedFolders(['Private']);
        await settle(index);
        expect((await index.search('a cat sleeping on a sofa')).hits[0].path).toBe('Pictures/cat.png');
        await index.stop();
    });

    it('keeps its vectors across restarts, and embeds again for a new model', async () => {
        const store = new MemoryImageStore();
        const first = setup({ store });
        await first.index.start();
        await settle(first.index);
        await first.index.stop();

        const second = setup({ store });
        await second.index.start();
        await settle(second.index);
        expect(second.embedder?.imageCalls).toEqual([]);
        expect(second.index.status().imagesIndexed).toBe(3);

        const other = new FakePictureEmbedder('other-pictures-int8-64');
        second.index.setEmbedder(other);
        await settle(second.index);
        expect(other.described.length).toBe(3);
        expect((await second.index.search('a bar chart of costs')).hits[0].path).toBe('Pictures/chart.jpg');
        await second.index.stop();
    });

    it('marks a picture it cannot read, and does not read it again until it changes', async () => {
        const store = new MemoryImageStore();
        const first = setup({ store, files: { ...FILES, 'Pictures/bad.png': 'broken bytes' } });
        await first.index.start();
        await settle(first.index);
        expect(first.index.status()).toMatchObject({ imagesIndexed: 3, skipped: 2 });
        await first.index.stop();

        const second = setup({ store, files: { ...FILES, 'Pictures/bad.png': 'broken bytes' } });
        await second.index.start();
        await settle(second.index);
        expect(second.reads).toEqual([]);
        await second.index.stop();
    });

    it('finds the one picture the model refuses, and indexes the rest', async () => {
        const picture = new FakePictureEmbedder();
        picture.refuse = (description) => description.includes('forbidden');
        const { index } = setup({ picture, files: { ...FILES, 'Pictures/odd.png': 'a forbidden thing' } });
        await index.start();
        await settle(index);
        expect(index.status()).toMatchObject({ state: 'idle', imagesIndexed: 3, skipped: 2, lastError: null });
        await index.stop();
    });

    it('pauses on a rate limit and goes on when told to retry', async () => {
        const picture = new FakePictureEmbedder();
        picture.failures.push(new ModelRequestError('Fake embeddings failed: 429', { kind: 'http', status: 429, label: 'Fake', retryAfterMs: 60_000 }));
        const { index } = setup({ picture });
        await index.start();
        await settle(index);
        const paused = index.status();
        expect(paused.state).toBe('paused');
        expect(paused.retryAt).toBeGreaterThan(Date.now());
        expect(paused.lastError).toBeTruthy();
        index.retry();
        await settle(index);
        expect(index.status()).toMatchObject({ state: 'idle', imagesIndexed: 3 });
        await index.stop();
    });

    it('says when pictures are still being indexed', async () => {
        const picture = new FakePictureEmbedder();
        let open: () => void = () => {};
        picture.gate = new Promise<void>((resolve) => (open = resolve));
        const { index } = setup({ picture, batchSize: 1 });
        await index.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const response = await index.search('a cat');
        expect(response.warnings.join(' ')).toMatch(/still being indexed/);
        open();
        await settle(index);
        await index.stop();
    });
});

describe('the embedding model and pictures', () => {
    it('sends pictures only to a preset model that takes them', () => {
        const fetchImpl = (async () => new Response('{}')) as unknown as typeof fetch;
        const google = buildNoteEmbedder({ preset: 'google', apiKey: 'test-key' }, fetchImpl);
        const own = buildNoteEmbedder({ preset: 'google', apiKey: 'test-key', model: 'text-embedding-004' }, fetchImpl);
        const openai = buildNoteEmbedder({ preset: 'openai', apiKey: 'test-key' }, fetchImpl);
        expect(google.ok && google.embedder.embedsImages).toBe(true);
        expect(own.ok && own.embedder.embedsImages).toBe(false);
        expect(openai.ok && openai.embedder.embedsImages).toBe(false);
    });

    it('sums up a picture search by the pictures’ paths, which a later turn can still use', () => {
        expect(summarizeToolResult('search_vault_images', { images: [{ path: 'A/fig1.png', name: 'fig1.png' }, { path: 'B/fig1.png', name: 'fig1.png' }] })).toBe('2 picture(s): A/fig1.png; B/fig1.png');
        expect(summarizeToolResult('search_vault_images', { images: [{ name: 'cat.png' }] })).toBe('1 picture(s): cat.png');
        expect(summarizeToolResult('search_vault_images', { images: [] })).toBe('0 picture(s)');
    });
});

describe('the picture index, after review', () => {
    it('does not send a picture of a folder excluded while its batch is being read', async () => {
        const reading = makePrepare();
        let hold: () => void = () => {};
        const held = new Promise<void>((resolve) => (hold = resolve));
        let first = true;
        const prepare = async (bytes: ArrayBuffer, extension: string) => {
            if (first) {
                first = false;
                await held;
            }
            return reading.prepare(bytes, extension);
        };
        const files = { 'Scans/passport.png': 'passport page', 'Scans/visa.png': 'visa page', 'Pictures/cat.png': 'a cat' };
        const { index, embedder } = setup({ files, prepare, excludedFolders: [] });
        await index.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        index.setExcludedFolders(['Scans']);
        hold();
        await settle(index);
        expect(embedder!.described).not.toContain('passport page');
        expect(embedder!.described).not.toContain('visa page');
        expect(embedder!.described).toContain('a cat');
        await index.stop();
    });

    it('lets the note index say it is idle when a note waiting to be read is deleted or moved away', async () => {
        const vault = new FakeNoteVault();
        vault.write('Notes/a.md', 'alpha', { silent: true });
        const notes = new NoteIndex({ app: { vault } as unknown as App, store: new MemoryIndexStore(), embedder: null, debounceMs: 50, log: () => {} });
        await notes.start();
        await notes.whenIdle();
        const idleSoon = async () => Promise.race([notes.whenIdle().then(() => 'idle'), new Promise((resolve) => setTimeout(() => resolve('stuck'), 400))]);
        // Someone (the picture index) is already waiting when the note goes away before it is read.
        vault.write('Notes/b.md', 'beta');
        const afterDelete = idleSoon();
        vault.remove('Notes/b.md');
        expect(await afterDelete).toBe('idle');
        vault.write('Notes/c.md', 'gamma');
        const afterMove = idleSoon();
        vault.rename('Notes/c.md', '.trash/c.md');
        expect(await afterMove).toBe('idle');
        await notes.stop();
    });

    it('sends its last status after a burst, so the header does not keep turning', async () => {
        const { index, vault } = setup();
        await index.start();
        await settle(index);
        const seen: string[] = [];
        index.onStatusChange((status) => seen.push(`${status.state}:${status.pending}`));
        for (let i = 0; i < 8; i += 1) vault.write(`Phone/IMG_${i + 10}.heic`, 'a phone photo');
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(seen[seen.length - 1]).toBe('idle:0');
        expect(index.status()).toMatchObject({ state: 'idle', skipped: 9 });
        await index.stop();
    });

    it('reads again later a file that could not be read for the moment, instead of leaving it out', async () => {
        const { index, vault, embedder } = setup({ readRetryMs: 20 });
        const readBinary = vault.readBinary.bind(vault);
        let failures = 1;
        (vault as unknown as { readBinary: typeof readBinary }).readBinary = async (file) => {
            if (file.path === 'Pictures/cat.png' && failures > 0) {
                failures -= 1;
                throw Object.assign(new Error('EDEADLK: resource deadlock would occur'), { code: 'EDEADLK' });
            }
            return readBinary(file);
        };
        await index.start();
        await settle(index);
        await new Promise((resolve) => setTimeout(resolve, 80));
        await index.whenIdle();
        expect(index.status()).toMatchObject({ imagesIndexed: 3, skipped: 1, retrying: 0 });
        expect(embedder!.described).toContain('a cat sleeping on a sofa');
        await index.stop();
    });

    it('tells a search that indexing stopped, and that some pictures can never be found', async () => {
        const picture = new FakePictureEmbedder();
        const { index } = setup({ picture, batchSize: 1 });
        picture.failures.push(undefined, new ModelRequestError('Fake embeddings failed: 401', { kind: 'http', status: 401, label: 'Fake' }));
        await index.start();
        await settle(index);
        expect(index.status().state).toBe('paused');
        const response = await index.search('a cat');
        expect(response.warnings.join(' ')).toMatch(/has stopped/);
        expect(response.warnings.join(' ')).toMatch(/never found/);
        await index.stop();
    });

    it('loads again on retry after the stored index could not be read', async () => {
        const store = new MemoryImageStore();
        let fail = true;
        const open = store.open.bind(store);
        store.open = async () => {
            if (fail) {
                fail = false;
                throw new Error('disk trouble');
            }
            return open();
        };
        const { index } = setup({ store });
        await index.start();
        expect(index.status()).toMatchObject({ state: 'error' });
        index.retry();
        await settle(index);
        expect(index.status()).toMatchObject({ state: 'idle', imagesIndexed: 3 });
        await index.stop();
    });
});
