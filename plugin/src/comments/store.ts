/**
 * The comments of the vault, kept as Orbit keeps them (see journal.ts): one
 * event file per change, `<data folder>/comments/<YYYY-MM>/<event id>.json`,
 * never rewritten. The store reads every event once, folds them into
 * records, and appends a new event for each change.
 *
 * Files that arrive from another computer (the vault syncs) are picked up by
 * `load()`, which reads only the event files it has not seen yet; the plugin
 * calls it when the folder changes on disk.
 */
import type { FileAdapter } from '../store/conversations';
import { anchorPath, validateAnchor, type CommentAnchor } from './anchor';
import {
    COMMENT_EVENT_SCHEMA,
    MAX_COMMENT_CHARS,
    MAX_EVENT_BYTES,
    foldEvents,
    monthOf,
    threadsOf,
    validEvent,
    type CommentActor,
    type CommentEvent,
    type CommentFields,
    type CommentRecord,
    type CommentThread,
} from './journal';

const EVENT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const MONTH_FOLDER = /^\d{4}-\d{2}$/;

export class CommentError extends Error {}

export class CommentStore {
    private readonly events = new Map<string, CommentEvent>();
    private readonly seenFiles = new Set<string>();
    private records = new Map<string, CommentRecord>();
    private threadList: CommentThread[] = [];
    private readonly listeners = new Set<() => void>();
    private loading: Promise<void> | null = null;
    private writes: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly adapter: FileAdapter,
        private readonly dataFolder: () => string,
        private readonly newId: () => string = () => crypto.randomUUID(),
        private readonly now: () => Date = () => new Date(),
    ) {}

    folder(): string {
        return `${this.dataFolder()}/comments`;
    }

    /** Be told when the comments change; returns the unsubscribe. */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Read the event files not read yet. Safe to call often: only new files are opened. */
    load(): Promise<void> {
        if (!this.loading) {
            this.loading = this.readNewFiles().finally(() => {
                this.loading = null;
            });
        }
        return this.loading;
    }

    /** Forget everything read, e.g. after the data folder moved. */
    reset(): void {
        this.events.clear();
        this.seenFiles.clear();
        this.refold();
    }

    threads(): CommentThread[] {
        return this.threadList;
    }

    /** The threads on a note: anchored to its path, leaving out threads whose every comment was deleted. */
    threadsOn(path: string): CommentThread[] {
        return this.threadList.filter((thread) => thread.root.anchor?.path === path && isLive(thread));
    }

    thread(id: string): CommentThread | null {
        const record = this.records.get(id);
        if (!record) return null;
        return this.threadList.find((thread) => thread.root.id === (record.documentId || record.id)) ?? null;
    }

    record(id: string): CommentRecord | null {
        return this.records.get(id) ?? null;
    }

    /** Start a thread: a comment on a passage of a note, or on the whole note. */
    async addThread(options: { actor: CommentActor; anchor: CommentAnchor; text: string }): Promise<CommentThread> {
        validateAnchor(options.anchor);
        const text = checkedText(options.text);
        const id = this.newId();
        await this.append(id, options.actor, [], { taskId: '', text, deleted: false, documentId: id, anchor: options.anchor });
        const thread = this.thread(id);
        if (!thread) throw new CommentError('The comment was written but could not be read back.');
        return thread;
    }

    /** Answer in a thread. Replies go under the root unless another comment of the thread is named. */
    async reply(options: { actor: CommentActor; threadId: string; text: string; parentId?: string }): Promise<CommentRecord> {
        const thread = this.thread(options.threadId);
        if (!thread) throw new CommentError('There is no such comment thread.');
        if (thread.root.resolved) throw new CommentError('This thread is resolved. Reopen it before replying.');
        const parentId = options.parentId && this.records.get(options.parentId)?.documentId === thread.root.id ? options.parentId : thread.root.id;
        const text = checkedText(options.text);
        const id = this.newId();
        await this.append(id, options.actor, [], { taskId: '', text, deleted: false, documentId: thread.root.id, parentId });
        return this.records.get(id) as CommentRecord;
    }

    /** Change a comment's text. Only its author may. */
    async edit(options: { actor: CommentActor; id: string; text: string }): Promise<CommentRecord> {
        const record = this.records.get(options.id);
        if (!record) throw new CommentError('There is no such comment.');
        if (record.owner !== options.actor) throw new CommentError('Only the author of a comment can change its text.');
        await this.append(record.id, options.actor, record.heads, { text: checkedText(options.text) });
        return this.records.get(record.id) as CommentRecord;
    }

    /** Mark a thread resolved, or open it again. */
    async setResolved(options: { actor: CommentActor; threadId: string; resolved: boolean }): Promise<CommentThread> {
        const thread = this.thread(options.threadId);
        if (!thread) throw new CommentError('There is no such comment thread.');
        if (thread.root.resolved !== options.resolved) {
            await this.append(thread.root.id, options.actor, thread.root.heads, { resolved: options.resolved });
        }
        return this.thread(thread.root.id) as CommentThread;
    }

    /** Delete a comment (it stays in the journal and can be restored). Only its author may. */
    async setDeleted(options: { actor: CommentActor; id: string; deleted: boolean }): Promise<CommentRecord> {
        const record = this.records.get(options.id);
        if (!record) throw new CommentError('There is no such comment.');
        if (record.owner !== options.actor && options.actor !== 'user') throw new CommentError('Only the author of a comment can delete it.');
        if (record.deleted !== options.deleted) await this.append(record.id, options.actor, record.heads, { deleted: options.deleted });
        return this.records.get(record.id) as CommentRecord;
    }

    /** Point a thread at another place: a new passage, or the same passage after its note moved. */
    async reanchor(options: { actor: CommentActor; threadId: string; anchor: CommentAnchor }): Promise<CommentThread> {
        validateAnchor(options.anchor);
        const thread = this.thread(options.threadId);
        if (!thread) throw new CommentError('There is no such comment thread.');
        await this.append(thread.root.id, options.actor, thread.root.heads, { anchor: options.anchor });
        return this.thread(thread.root.id) as CommentThread;
    }

    /** A note was renamed or moved: its threads follow it. */
    async noteMoved(actor: CommentActor, oldPath: string, newPath: string): Promise<void> {
        if (!anchorPath(newPath)) return;
        for (const thread of this.threadsOn(oldPath)) {
            const anchor = thread.root.anchor as CommentAnchor;
            await this.append(thread.root.id, actor, thread.root.heads, { anchor: { ...anchor, path: newPath } });
        }
    }

    private async readNewFiles(): Promise<void> {
        const folder = this.folder();
        if (!(await this.adapter.exists(folder))) return;
        const months = (await this.adapter.list(folder)).folders.filter((path) => MONTH_FOLDER.test(path.slice(path.lastIndexOf('/') + 1)));
        let added = 0;
        for (const month of months) {
            const { files } = await this.adapter.list(month);
            for (const file of files) {
                if (this.seenFiles.has(file) || !EVENT_FILE.test(file.slice(file.lastIndexOf('/') + 1))) continue;
                try {
                    const event = validEvent(JSON.parse(await this.adapter.read(file)));
                    // A file still being written (or half-synced) is read again next time.
                    if (!event) continue;
                    this.seenFiles.add(file);
                    if (!this.events.has(event.id)) {
                        this.events.set(event.id, event);
                        added += 1;
                    }
                } catch {
                    // Unreadable for now; tried again on the next load.
                }
            }
        }
        if (added > 0) this.refold();
    }

    private refold(): void {
        this.records = foldEvents(this.events.values());
        this.threadList = threadsOf(this.records);
        for (const listener of this.listeners) listener();
    }

    /** Write one event and take it in. Writes go one at a time, in order. */
    private append(entityId: string, actor: CommentActor, parents: string[], patch: Partial<CommentFields>): Promise<void> {
        const write = this.writes.then(async () => {
            const at = this.now().toISOString();
            const event: CommentEvent = { schema: COMMENT_EVENT_SCHEMA, id: this.newId(), entity: 'comment', entityId, actor, at, parents: [...parents], patch };
            const json = `${JSON.stringify(event)}\n`;
            if (new TextEncoder().encode(json).length > MAX_EVENT_BYTES) throw new CommentError('This comment is too long to keep.');
            const month = `${this.folder()}/${monthOf(at)}`;
            await this.ensureFolder(month);
            const path = `${month}/${event.id}.json`;
            await this.adapter.write(path, json);
            this.seenFiles.add(path);
            this.events.set(event.id, event);
            this.refold();
        });
        this.writes = write.catch(() => {});
        return write;
    }

    private async ensureFolder(folder: string): Promise<void> {
        const parts = folder.split('/');
        for (let i = 1; i <= parts.length; i += 1) {
            const path = parts.slice(0, i).join('/');
            if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
        }
    }
}

/** A thread with at least one comment not deleted. */
export function isLive(thread: CommentThread): boolean {
    return !thread.root.deleted || thread.replies.some((reply) => !reply.deleted);
}

function checkedText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) throw new CommentError('A comment needs some text.');
    if (trimmed.length > MAX_COMMENT_CHARS) throw new CommentError(`A comment can be at most ${MAX_COMMENT_CHARS} characters long.`);
    return trimmed;
}
