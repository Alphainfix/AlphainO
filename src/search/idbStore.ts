/**
 * The note index in IndexedDB, on this computer only.
 *
 * The database is named for the vault (`alphaino-index:<app id>`) and lives
 * in the app's own storage, not in the vault, so it does not sync: it is big,
 * two computers would write it at once, and each rebuilds its own.
 *
 * Three object stores, all keyed by note path except `meta`:
 * - `meta`: one record about the index as a whole,
 * - `notes`: a row per note (modified time, size, content hash),
 * - `chunks`: a note's passages together, as `{ path, chunks }`, so replacing
 *   a note's passages is one write and a note can never have some of the old
 *   passages and some of the new.
 *
 * It is only a cache: when the stored data cannot be used (a newer database
 * version, say) it is deleted and rebuilt.
 */
import type { IndexStore, NoteInfo, StoredChunk, StoredIndex, StoredNote, StoreOp } from './types';

const DB_VERSION = 1;
const META = 'meta';
const NOTES = 'notes';
const CHUNKS = 'chunks';

export function indexDatabaseName(appId: string): string {
    return `alphaino-index:${appId}`;
}

function failure(request: { error: DOMException | null }, fallback: string): Error {
    return request.error ?? new Error(fallback);
}

export class IdbIndexStore implements IndexStore {
    private db: IDBDatabase | null = null;

    /** `factory` is the IndexedDB to use; the app's own by default. */
    constructor(
        private readonly name: string,
        private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
    ) {}

    async open(): Promise<void> {
        if (this.db) return;
        if (!this.factory) throw new Error('IndexedDB is not available here.');
        try {
            this.db = await this.connect();
        } catch (error) {
            // A database from a newer version of the plugin: it is only a cache, start over.
            if ((error as { name?: string } | null)?.name !== 'VersionError') throw error;
            await this.drop();
            this.db = await this.connect();
        }
        const db = this.db;
        // Another tab or window wants to upgrade or delete the database: let go of it.
        db.onversionchange = () => {
            db.close();
            if (this.db === db) this.db = null;
        };
    }

    private connect(): Promise<IDBDatabase> {
        const factory = this.factory as IDBFactory;
        return new Promise((resolve, reject) => {
            const request = factory.open(this.name, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
                if (!db.objectStoreNames.contains(NOTES)) db.createObjectStore(NOTES, { keyPath: 'path' });
                if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: 'path' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(failure(request, 'Could not open the note index database.'));
        });
    }

    private drop(): Promise<void> {
        const factory = this.factory as IDBFactory;
        return new Promise((resolve, reject) => {
            const request = factory.deleteDatabase(this.name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(failure(request, 'Could not delete the note index database.'));
        });
    }

    private requireDb(): IDBDatabase {
        if (!this.db) throw new Error('The note index database is not open.');
        return this.db;
    }

    async load(): Promise<StoredIndex> {
        const db = this.requireDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([META, NOTES, CHUNKS], 'readonly');
            const meta = tx.objectStore(META).get('index');
            const rows: NoteInfo[] = [];
            const groups = new Map<string, StoredChunk[]>();
            // Cursors, not one big read: the records arrive a few at a time and the interface keeps running.
            const walk = (store: string, each: (value: any) => void) => {
                const request = tx.objectStore(store).openCursor();
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return;
                    each(cursor.value);
                    cursor.continue();
                };
            };
            walk(NOTES, (row: NoteInfo) => rows.push(row));
            walk(CHUNKS, (group: { path: string; chunks: StoredChunk[] }) => groups.set(group.path, group.chunks));
            tx.oncomplete = () => {
                const notes: StoredNote[] = rows.map((row) => ({ ...row, chunks: groups.get(row.path) ?? [] }));
                resolve({ meta: meta.result ?? null, notes });
            };
            tx.onerror = () => reject(failure(tx, 'Could not read the note index.'));
            tx.onabort = () => reject(failure(tx, 'Reading the note index was aborted.'));
        });
    }

    async write(ops: StoreOp[]): Promise<void> {
        if (ops.length === 0) return;
        const db = this.requireDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([META, NOTES, CHUNKS], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(failure(tx, 'Could not write the note index.'));
            tx.onabort = () => reject(failure(tx, 'Writing the note index was aborted.'));
            try {
                const meta = tx.objectStore(META);
                const notes = tx.objectStore(NOTES);
                const chunks = tx.objectStore(CHUNKS);
                for (const op of ops) {
                    if (op.type === 'put') {
                        notes.put(op.note);
                        if (op.chunks) chunks.put({ path: op.note.path, chunks: op.chunks });
                    } else if (op.type === 'delete') {
                        notes.delete(op.path);
                        chunks.delete(op.path);
                    } else {
                        meta.put(op.meta);
                    }
                }
            } catch (error) {
                // A record that cannot be stored must not leave the others half written.
                try {
                    tx.abort();
                } catch {
                    // already finished
                }
                reject(error);
            }
        });
    }

    async clear(): Promise<void> {
        const db = this.requireDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([META, NOTES, CHUNKS], 'readwrite');
            tx.objectStore(META).clear();
            tx.objectStore(NOTES).clear();
            tx.objectStore(CHUNKS).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(failure(tx, 'Could not clear the note index.'));
            tx.onabort = () => reject(failure(tx, 'Clearing the note index was aborted.'));
        });
    }

    close(): void {
        this.db?.close();
        this.db = null;
    }
}
