/**
 * Where the picture index is kept between runs.
 *
 * IndexedDB on this computer (`alphaino-images:<app id>`), apart from the note
 * index so that neither one's layout changes the other's; like the note index
 * it is only a cache, never synced, and rebuilt when it cannot be used. Two
 * object stores: `images`, a row per picture keyed by its path, and `meta`,
 * the model its vectors belong to. A memory store with the same shape serves
 * the tests.
 */

/** One picture as stored. */
export interface StoredImage {
    path: string;
    /** Modification time and size when the picture was read. */
    mtime: number;
    size: number;
    /** int8 vector; null when there is none (see `error`). */
    embedding: Int8Array | null;
    /** The model that made the vector, or that the error belongs to; '' for neither. */
    model: string;
    /**
     * Why the picture has no vector: it could not be read here (a format the
     * app cannot open, a broken file) or the model would not take it. It is
     * not tried again until the file changes (or the model does).
     */
    error?: string;
}

/** What the picture index records about itself. */
export interface ImageIndexMeta {
    key: 'images';
    /** The layout of the stored records. */
    schema: number;
    /** The embedding model of the stored vectors; null for none. */
    model: string | null;
}

export interface StoredImages {
    meta: ImageIndexMeta | null;
    images: StoredImage[];
}

export type ImageStoreOp = { type: 'put'; image: StoredImage } | { type: 'delete'; path: string } | { type: 'meta'; meta: ImageIndexMeta };

export interface ImageStore {
    open(): Promise<void>;
    load(): Promise<StoredImages>;
    /** Applies the changes together: all of them or none. */
    write(ops: ImageStoreOp[]): Promise<void>;
    /** Removes everything. */
    clear(): Promise<void>;
    close(): void;
}

export function imageDatabaseName(appId: string): string {
    return `alphaino-images:${appId}`;
}

/** Records are copied on the way in and out, as a database would. */
export class MemoryImageStore implements ImageStore {
    private meta: ImageIndexMeta | null = null;
    private readonly images = new Map<string, StoredImage>();
    private opened = false;
    /** Makes the next write fail with this error (tests). */
    failWith: Error | null = null;
    writes = 0;

    async open(): Promise<void> {
        this.opened = true;
    }

    async load(): Promise<StoredImages> {
        this.requireOpen();
        return structuredClone({ meta: this.meta, images: [...this.images.values()] });
    }

    async write(ops: ImageStoreOp[]): Promise<void> {
        this.requireOpen();
        if (this.failWith) {
            const error = this.failWith;
            this.failWith = null;
            throw error;
        }
        this.writes += 1;
        for (const op of structuredClone(ops)) {
            if (op.type === 'put') this.images.set(op.image.path, op.image);
            else if (op.type === 'delete') this.images.delete(op.path);
            else this.meta = op.meta;
        }
    }

    async clear(): Promise<void> {
        this.requireOpen();
        this.meta = null;
        this.images.clear();
    }

    close(): void {
        this.opened = false;
    }

    /** What is stored (tests). */
    snapshot(): StoredImages {
        return structuredClone({ meta: this.meta, images: [...this.images.values()] });
    }

    private requireOpen(): void {
        if (!this.opened) throw new Error('The picture index store is not open.');
    }
}

const DB_VERSION = 1;
const META = 'meta';
const IMAGES = 'images';

function failure(request: { error: DOMException | null }, fallback: string): Error {
    return request.error ?? new Error(fallback);
}

export class IdbImageStore implements ImageStore {
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
                if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES, { keyPath: 'path' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(failure(request, 'Could not open the picture index database.'));
        });
    }

    private drop(): Promise<void> {
        const factory = this.factory as IDBFactory;
        return new Promise((resolve, reject) => {
            const request = factory.deleteDatabase(this.name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(failure(request, 'Could not delete the picture index database.'));
        });
    }

    private requireDb(): IDBDatabase {
        if (!this.db) throw new Error('The picture index database is not open.');
        return this.db;
    }

    async load(): Promise<StoredImages> {
        const db = this.requireDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([META, IMAGES], 'readonly');
            const meta = tx.objectStore(META).get('images');
            const images: StoredImage[] = [];
            const request = tx.objectStore(IMAGES).openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                images.push(cursor.value as StoredImage);
                cursor.continue();
            };
            tx.oncomplete = () => resolve({ meta: (meta.result as ImageIndexMeta | undefined) ?? null, images });
            tx.onerror = () => reject(failure(tx, 'Could not read the picture index.'));
            tx.onabort = () => reject(failure(tx, 'Reading the picture index was aborted.'));
        });
    }

    async write(ops: ImageStoreOp[]): Promise<void> {
        if (ops.length === 0) return;
        const db = this.requireDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([META, IMAGES], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(failure(tx, 'Could not write the picture index.'));
            tx.onabort = () => reject(failure(tx, 'Writing the picture index was aborted.'));
            try {
                const meta = tx.objectStore(META);
                const images = tx.objectStore(IMAGES);
                for (const op of ops) {
                    if (op.type === 'put') images.put(op.image);
                    else if (op.type === 'delete') images.delete(op.path);
                    else meta.put(op.meta);
                }
            } catch (error) {
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
            const tx = db.transaction([META, IMAGES], 'readwrite');
            tx.objectStore(META).clear();
            tx.objectStore(IMAGES).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(failure(tx, 'Could not clear the picture index.'));
            tx.onabort = () => reject(failure(tx, 'Clearing the picture index was aborted.'));
        });
    }

    close(): void {
        this.db?.close();
        this.db = null;
    }
}
