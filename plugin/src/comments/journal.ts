/**
 * Comments as Orbit keeps them: an append-only journal of small event files,
 * one per change, never rewritten, so two computers writing at once (the
 * vault syncs through iCloud) never conflict.
 *
 * An event is Orbit's journal event, `{schema: 1, id, entity: "comment",
 * entityId, actor, at, parents, patch}`: `patch` holds the fields it sets and
 * `parents` the record's head events it follows. A comment record has Orbit's
 * fields `{taskId, text, deleted}` plus, for a note thread, `documentId`,
 * `anchor` (on the root), `parentId` (on replies) and `resolved` (on the root).
 *
 * Folding: a record's events are applied in causal order (a parent before its
 * children); events that do not follow each other (written on two computers
 * at once) apply in time order, so the later value of a field wins.
 */
import type { CommentAnchor } from './anchor';

export const COMMENT_EVENT_SCHEMA = 1;
/** Orbit's limit on one event file. */
export const MAX_EVENT_BYTES = 64 * 1024;
/** Orbit's limit on a comment's text. */
export const MAX_COMMENT_CHARS = 10_000;

/** Who wrote a comment: the user, AlphainO's assistant, or Claude through the MCP server. */
export type CommentActor = 'user' | 'alphaino' | 'claude';
export const ACTORS: readonly CommentActor[] = ['user', 'alphaino', 'claude'];

export interface CommentEvent {
    schema: 1;
    id: string;
    entity: 'comment';
    entityId: string;
    actor: string;
    at: string;
    parents: string[];
    patch: Partial<CommentFields>;
}

export interface CommentFields {
    taskId: string;
    text: string;
    deleted: boolean;
    documentId: string;
    parentId: string;
    anchor: CommentAnchor | null;
    resolved: boolean;
}

export interface CommentRecord extends CommentFields {
    id: string;
    /** The actor of the record's first event. */
    owner: string;
    createdAt: string;
    updatedAt: string;
    /** The events no other event of this record follows. */
    heads: string[];
    /** Every event, in the order they were applied. */
    history: CommentEvent[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = new Set(['taskId', 'text', 'deleted', 'documentId', 'parentId', 'anchor', 'resolved', 'decisionId']);

/** The event if it is one this journal can apply, else null. */
export function validEvent(value: unknown): CommentEvent | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const event = value as CommentEvent;
    if (event.schema !== COMMENT_EVENT_SCHEMA || event.entity !== 'comment') return null;
    if (typeof event.id !== 'string' || !UUID.test(event.id)) return null;
    if (typeof event.entityId !== 'string' || !UUID.test(event.entityId)) return null;
    if (typeof event.actor !== 'string' || !event.actor) return null;
    if (typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))) return null;
    if (!Array.isArray(event.parents) || !event.parents.every((parent) => typeof parent === 'string')) return null;
    if (!event.patch || typeof event.patch !== 'object' || Array.isArray(event.patch)) return null;
    if (!Object.keys(event.patch).every((key) => FIELDS.has(key))) return null;
    return event;
}

/** The folder, under the comments folder, an event is filed in: the UTC month of its time (`2026-11`). */
export function monthOf(at: string): string {
    return new Date(at).toISOString().slice(0, 7);
}

const DEFAULTS: CommentFields = {
    taskId: '',
    text: '',
    deleted: false,
    documentId: '',
    parentId: '',
    anchor: null,
    resolved: false,
};

/** Events in an order where each comes after the events it follows; unrelated ones by time, then id. */
function causalOrder(events: CommentEvent[]): CommentEvent[] {
    const byId = new Map(events.map((event) => [event.id, event]));
    const done = new Set<string>();
    const order: CommentEvent[] = [];
    const ready = (event: CommentEvent) => event.parents.every((parent) => done.has(parent) || !byId.has(parent));
    const pending = [...events].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    while (pending.length > 0) {
        const index = pending.findIndex(ready);
        // A cycle cannot be ordered causally; time order is the fallback.
        const next = pending.splice(index === -1 ? 0 : index, 1)[0];
        done.add(next.id);
        order.push(next);
    }
    return order;
}

/** Every comment record the events describe. */
export function foldEvents(events: Iterable<CommentEvent>): Map<string, CommentRecord> {
    const byEntity = new Map<string, CommentEvent[]>();
    const seen = new Set<string>();
    for (const event of events) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        const list = byEntity.get(event.entityId) ?? [];
        list.push(event);
        byEntity.set(event.entityId, list);
    }
    const records = new Map<string, CommentRecord>();
    for (const [id, list] of byEntity) {
        const ordered = causalOrder(list);
        const fields: CommentFields = { ...DEFAULTS };
        for (const event of ordered) {
            for (const [key, value] of Object.entries(event.patch)) {
                if (key in fields) (fields as unknown as Record<string, unknown>)[key] = value;
            }
        }
        const followed = new Set(list.flatMap((event) => event.parents));
        records.set(id, {
            ...fields,
            id,
            owner: ordered[0].actor,
            createdAt: ordered[0].at,
            updatedAt: ordered[ordered.length - 1].at,
            heads: list.filter((event) => !followed.has(event.id)).map((event) => event.id).sort(),
            history: ordered,
        });
    }
    return records;
}

/** A thread on a note: its root comment, and the replies under it in time order. */
export interface CommentThread {
    root: CommentRecord;
    replies: CommentRecord[];
}

/** The note threads among the records: roots that carry an anchor, with their replies. */
export function threadsOf(records: Map<string, CommentRecord>): CommentThread[] {
    const threads = new Map<string, CommentThread>();
    for (const record of records.values()) {
        if (record.documentId === record.id && record.anchor && !record.parentId) threads.set(record.id, { root: record, replies: [] });
    }
    for (const record of records.values()) {
        if (record.id === record.documentId) continue;
        const thread = threads.get(record.documentId);
        if (thread && record.parentId && records.get(record.parentId)?.documentId === record.documentId) thread.replies.push(record);
    }
    for (const thread of threads.values()) thread.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return [...threads.values()].sort((a, b) => a.root.createdAt.localeCompare(b.root.createdAt));
}
