/**
 * An index store that keeps everything in memory: for tests, and the shape
 * the IndexedDB store follows.
 *
 * Records are copied on the way in and out, as a database would, so code that
 * changes a record after writing it cannot change what is stored.
 */
import type { IndexMeta, IndexStore, NoteInfo, StoredChunk, StoredIndex, StoreOp } from './types';

export class MemoryIndexStore implements IndexStore {
    private meta: IndexMeta | null = null;
    private readonly notes = new Map<string, NoteInfo>();
    private readonly chunks = new Map<string, StoredChunk[]>();
    private opened = false;

    /** Makes the next write fail with this error (tests). */
    failWith: Error | null = null;

    async open(): Promise<void> {
        this.opened = true;
    }

    async load(): Promise<StoredIndex> {
        this.requireOpen();
        return structuredClone({
            meta: this.meta,
            notes: [...this.notes.values()].map((note) => ({ ...note, chunks: this.chunks.get(note.path) ?? [] })),
        });
    }

    async write(ops: StoreOp[]): Promise<void> {
        this.requireOpen();
        if (this.failWith) throw this.failWith;
        for (const op of structuredClone(ops)) {
            if (op.type === 'put') {
                this.notes.set(op.note.path, op.note);
                if (op.chunks) this.chunks.set(op.note.path, op.chunks);
            } else if (op.type === 'delete') {
                this.notes.delete(op.path);
                this.chunks.delete(op.path);
            } else {
                this.meta = op.meta;
            }
        }
    }

    async clear(): Promise<void> {
        this.requireOpen();
        this.meta = null;
        this.notes.clear();
        this.chunks.clear();
    }

    close(): void {
        this.opened = false;
    }

    private requireOpen(): void {
        if (!this.opened) throw new Error('The index store is not open.');
    }
}
