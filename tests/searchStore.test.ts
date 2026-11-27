import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IdbIndexStore, indexDatabaseName } from '../src/search/idbStore';
import { MemoryIndexStore } from '../src/search/store';
import type { IndexMeta, IndexStore, NoteInfo, StoredChunk } from '../src/search/types';

const META: IndexMeta = { key: 'index', schema: 1, chunker: 1, model: 'm-int8-4', dimensions: 4 };

function info(path: string, hash = 'h1'): NoteInfo {
    return { path, mtime: 1000, size: 10, hash };
}

function chunk(path: string, index: number, embedding: Int8Array | null): StoredChunk {
    return {
        path,
        index,
        heading: ['A', 'B'],
        startLine: 3 + index,
        endLine: 4 + index,
        text: `text ${index} of ${path}`,
        textHash: `t${index}`,
        embedding,
        model: embedding ? 'm-int8-4' : '',
        dimensions: embedding ? embedding.length : 0,
    };
}

interface Kit {
    store: IndexStore;
    /** A store on the same data, as after a restart. */
    reopen: () => IndexStore;
}

function memoryKit(): Kit {
    const store = new MemoryIndexStore();
    return { store, reopen: () => store };
}

function indexedDbKit(): Kit {
    const factory = new IDBFactory() as unknown as IDBFactory;
    const name = indexDatabaseName('test-vault');
    return { store: new IdbIndexStore(name, factory), reopen: () => new IdbIndexStore(name, factory) };
}

describe.each([
    ['memory store', memoryKit],
    ['IndexedDB store', indexedDbKit],
])('%s', (_name, makeKit) => {
    it('starts empty', async () => {
        const { store } = makeKit();
        await store.open();
        expect(await store.load()).toEqual({ meta: null, notes: [] });
    });

    it('returns what was written: notes, passages, int8 vectors and the missing ones', async () => {
        const { store } = makeKit();
        await store.open();
        const vector = Int8Array.from([1, -2, 127, -127]);
        await store.write([
            { type: 'meta', meta: META },
            { type: 'put', note: info('a.md'), chunks: [chunk('a.md', 0, vector), chunk('a.md', 1, null)] },
            { type: 'put', note: { ...info('b/c.md'), embedError: 'refused' }, chunks: [] },
        ]);
        const loaded = await store.load();
        expect(loaded.meta).toEqual(META);
        const a = loaded.notes.find((note) => note.path === 'a.md');
        expect(a).toMatchObject({ path: 'a.md', mtime: 1000, size: 10, hash: 'h1' });
        expect(a?.chunks).toHaveLength(2);
        expect(a?.chunks[0].embedding).toBeInstanceOf(Int8Array);
        expect(Array.from(a?.chunks[0].embedding ?? [])).toEqual([1, -2, 127, -127]);
        expect(a?.chunks[0]).toMatchObject({ heading: ['A', 'B'], startLine: 3, endLine: 4, textHash: 't0', model: 'm-int8-4', dimensions: 4 });
        expect(a?.chunks[1].embedding).toBeNull();
        expect(loaded.notes.find((note) => note.path === 'b/c.md')).toMatchObject({ embedError: 'refused', chunks: [] });
    });

    it('does not change what is stored when the caller changes a record afterwards', async () => {
        const { store } = makeKit();
        await store.open();
        const vector = Int8Array.from([1, 2, 3, 4]);
        const note = info('a.md');
        await store.write([{ type: 'put', note, chunks: [chunk('a.md', 0, vector)] }]);
        vector[0] = 99;
        note.hash = 'changed';
        const loaded = await store.load();
        expect(loaded.notes[0].hash).toBe('h1');
        expect(loaded.notes[0].chunks[0].embedding?.[0]).toBe(1);
    });

    it('keeps a note’s passages when only its row is written, and replaces them when new ones are given', async () => {
        const { store } = makeKit();
        await store.open();
        await store.write([{ type: 'put', note: info('a.md'), chunks: [chunk('a.md', 0, null), chunk('a.md', 1, null)] }]);
        await store.write([{ type: 'put', note: info('a.md', 'h2') }]);
        let loaded = await store.load();
        expect(loaded.notes[0]).toMatchObject({ hash: 'h2' });
        expect(loaded.notes[0].chunks).toHaveLength(2);
        await store.write([{ type: 'put', note: info('a.md', 'h3'), chunks: [chunk('a.md', 0, null)] }]);
        loaded = await store.load();
        expect(loaded.notes[0].chunks).toHaveLength(1);
    });

    it('deletes a note with its passages', async () => {
        const { store } = makeKit();
        await store.open();
        await store.write([
            { type: 'put', note: info('a.md'), chunks: [chunk('a.md', 0, null)] },
            { type: 'put', note: info('b.md'), chunks: [chunk('b.md', 0, null)] },
        ]);
        await store.write([{ type: 'delete', path: 'a.md' }]);
        const loaded = await store.load();
        expect(loaded.notes.map((note) => note.path)).toEqual(['b.md']);
    });

    it('keeps its contents across a restart', async () => {
        const { store, reopen } = makeKit();
        await store.open();
        await store.write([
            { type: 'meta', meta: META },
            { type: 'put', note: info('a.md'), chunks: [chunk('a.md', 0, Int8Array.from([5, 6, 7, 8]))] },
        ]);
        store.close();
        const again = reopen();
        await again.open();
        const loaded = await again.load();
        expect(loaded.meta).toEqual(META);
        expect(Array.from(loaded.notes[0].chunks[0].embedding ?? [])).toEqual([5, 6, 7, 8]);
    });

    it('clears everything', async () => {
        const { store } = makeKit();
        await store.open();
        await store.write([
            { type: 'meta', meta: META },
            { type: 'put', note: info('a.md'), chunks: [chunk('a.md', 0, null)] },
        ]);
        await store.clear();
        expect(await store.load()).toEqual({ meta: null, notes: [] });
    });

    it('applies a write completely or not at all', async () => {
        const { store } = makeKit();
        await store.open();
        const unstorable = { ...info('bad.md'), hash: (() => 1) as unknown as string };
        await expect(
            store.write([
                { type: 'put', note: info('good.md'), chunks: [chunk('good.md', 0, null)] },
                { type: 'put', note: unstorable, chunks: [] },
            ]),
        ).rejects.toThrow();
        expect((await store.load()).notes).toEqual([]);
    });

    it('does nothing for an empty write', async () => {
        const { store } = makeKit();
        await store.open();
        await store.write([]);
        expect(await store.load()).toEqual({ meta: null, notes: [] });
    });
});

describe('IndexedDB store', () => {
    it('names the database for the vault', () => {
        expect(indexDatabaseName('abc123')).toBe('alphaino-index:abc123');
    });

    it('creates the database under that name', async () => {
        const factory = new IDBFactory() as unknown as IDBFactory;
        const store = new IdbIndexStore(indexDatabaseName('vault-1'), factory);
        await store.open();
        await store.open();
        expect((await factory.databases()).map((db) => db.name)).toEqual(['alphaino-index:vault-1']);
        store.close();
    });

    it('starts over when the database is from a newer version', async () => {
        const factory = new IDBFactory() as unknown as IDBFactory;
        const name = indexDatabaseName('vault-2');
        await new Promise<void>((resolve, reject) => {
            const request = factory.open(name, 9);
            request.onupgradeneeded = () => request.result.createObjectStore('something-new', { keyPath: 'id' });
            request.onsuccess = () => {
                request.result.close();
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
        const store = new IdbIndexStore(name, factory);
        await store.open();
        await store.write([{ type: 'put', note: info('a.md'), chunks: [] }]);
        expect((await store.load()).notes).toHaveLength(1);
        store.close();
    });

    it('says so when there is no IndexedDB', async () => {
        const store = new IdbIndexStore('x', undefined as unknown as IDBFactory);
        // `undefined` selects the default, which node does not have either.
        await expect(store.open()).rejects.toThrow(/IndexedDB is not available/);
    });

    it('refuses to be used before it is opened', async () => {
        const store = new IdbIndexStore('x', new IDBFactory() as unknown as IDBFactory);
        await expect(store.load()).rejects.toThrow(/not open/);
    });
});

describe('memory store', () => {
    it('can be told to fail its next writes', async () => {
        const store = new MemoryIndexStore();
        await store.open();
        store.failWith = new Error('disk full');
        await expect(store.write([{ type: 'delete', path: 'a.md' }])).rejects.toThrow('disk full');
    });
});
