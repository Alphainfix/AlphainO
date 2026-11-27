/**
 * The comments as tools of the chat's agent loop, the counterpart of
 * AlphainZ's annotation tools: `get_comments` (every thread on one note, like
 * `get_annotations`), `find_comments` (across the vault, like
 * `find_annotations`), and the writes `add_comment`, `reply_to_comment` and
 * `resolve_comment`, so the assistant can work through the user's comments
 * one by one. Every thread comes with the passage it is on, read from the
 * note as it is now.
 */
import type { App, TFile } from 'obsidian';
import type { ToolDispatcher } from '@beaver/agent-llm/agentLoop';
import type { ToolSchema } from '@beaver/agent-llm/types';
import { linkTarget, wikilink } from '../search/paths';
import { EXCLUDED_NOTE_ERROR, locateNote } from '../tools/vaultTools';
import { isExcludedPath } from '../search/paths';
import { captureAnchor, normalized, resolveAnchor, type AnchorResolution } from './anchor';
import type { CommentActor, CommentRecord, CommentThread } from './journal';
import { CommentError, type CommentStore } from './store';

export const COMMENT_TOOL_NAMES = ['get_comments', 'find_comments', 'add_comment', 'reply_to_comment', 'resolve_comment'] as const;
/** The tools that change something: their cards are their own output (see the loop's `writeTools`). */
export const COMMENT_WRITE_TOOLS = ['add_comment', 'reply_to_comment', 'resolve_comment'] as const;

const DEFAULT_FIND_LIMIT = 20;
const MAX_FIND_LIMIT = 50;
const QUOTE_CHARS = 600;

export function commentToolSchemas(): ToolSchema[] {
    return [
        {
            name: 'get_comments',
            description:
                "Every comment thread on one note, in reading order, each with the passage it is on (as the note reads now) and its replies. Use when discussing a note the user has commented on, or to work through the user's comments one by one.",
            parameters: {
                type: 'object',
                properties: {
                    note_id: { type: 'string', description: 'The note (its note_id or [[link]]). Default: the note open in the editor.' },
                    include_resolved: { type: 'boolean', description: 'Also list resolved threads. Default false.' },
                },
                required: [],
            },
        },
        {
            name: 'find_comments',
            description:
                "Search comment threads across the whole vault: by words in the comments or in the commented passage, by who wrote them, and by whether they are resolved. This is how you find what the user has flagged in their notes.",
            parameters: {
                type: 'object',
                properties: {
                    text_contains: { type: 'string', description: 'Words in a comment or in the commented passage.' },
                    author: { type: 'string', enum: ['user', 'alphaino', 'claude'], description: 'Who wrote the first comment of the thread.' },
                    include_resolved: { type: 'boolean', description: 'Also list resolved threads. Default false.' },
                    limit: { type: 'integer', description: `How many threads to return (default ${DEFAULT_FIND_LIMIT}, at most ${MAX_FIND_LIMIT}).` },
                },
                required: [],
            },
        },
        {
            name: 'add_comment',
            description:
                'Comment on a passage of a note, or on the whole note, the way a reviewer leaves a margin note. The comment is shown beside the passage and kept with the note even as it is edited. Quote the passage exactly as it appears in the note (read it first); leave `quote` out to comment on the whole note. Use it when the user asks you to review, check or annotate a note.',
            parameters: {
                type: 'object',
                properties: {
                    note_id: { type: 'string', description: 'The note (its note_id or [[link]]). Default: the note open in the editor.' },
                    text: { type: 'string', description: 'The comment, in Markdown, in the user’s language.' },
                    quote: {
                        type: 'string',
                        description: 'The passage the comment is on, copied exactly from the note (a sentence or a few words; at most 4000 characters). Leave out for the whole note.',
                    },
                    occurrence: { type: 'integer', description: 'Which occurrence of `quote` to use when it appears more than once (1 = first). Prefer a longer quote instead.' },
                },
                required: ['text'],
            },
        },
        {
            name: 'reply_to_comment',
            description: 'Answer in a comment thread: a reply under its comments, as the user would see it beside the passage.',
            parameters: {
                type: 'object',
                properties: {
                    thread_id: { type: 'string', description: 'The thread, from get_comments or find_comments.' },
                    text: { type: 'string', description: 'The reply, in Markdown, in the user’s language.' },
                },
                required: ['thread_id', 'text'],
            },
        },
        {
            name: 'resolve_comment',
            description:
                'Mark a comment thread resolved once what it asks for is done (or reopen it). Say in a reply what you did before resolving a thread the user opened.',
            parameters: {
                type: 'object',
                properties: {
                    thread_id: { type: 'string', description: 'The thread, from get_comments or find_comments.' },
                    resolved: { type: 'boolean', description: 'false reopens it. Default true.' },
                },
                required: ['thread_id'],
            },
        },
    ];
}

export interface CommentToolsOptions {
    app: App;
    store: CommentStore;
    /** Who the tools write as. */
    actor: CommentActor;
    /** Folders the user left out of AlphainO: comments on their notes are neither read nor written. */
    getExcludedFolders?: () => readonly string[];
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function clip(value: string, max = QUOTE_CHARS): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** The note a request names, or the note open in the editor; never one in an excluded folder. */
function noteFor(app: App, request: string, excluded: readonly string[]): { file: TFile } | { error: string; did_you_mean?: string[] } {
    if (!request) {
        const file = app.workspace.getActiveFile();
        if (file && file.extension === 'md') return isExcludedPath(file.path, excluded) ? { error: EXCLUDED_NOTE_ERROR } : { file };
        return { error: 'No note is open in the editor; give note_id.' };
    }
    const found = locateNote(app, request, excluded);
    return 'file' in found ? { file: found.file } : found;
}

function where(place: AnchorResolution, kind: string): Record<string, unknown> {
    if (kind === 'document') return { status: 'whole_note' };
    if (place.status !== 'attached') return { status: place.status === 'ambiguous' ? 'ambiguous' : 'passage_not_found' };
    if (place.deleted) return { status: 'passage_deleted', line: place.line + 1 };
    return { status: place.exact ? 'attached' : 'moved', line: place.line + 1 };
}

function commentRow(record: CommentRecord) {
    return {
        comment_id: record.id,
        author: record.owner,
        text: record.deleted ? '(deleted)' : record.text,
        at: record.createdAt,
        ...(record.updatedAt !== record.createdAt ? { edited_at: record.updatedAt } : {}),
    };
}

async function describeThread(app: App, thread: CommentThread, noteText: string | null): Promise<Record<string, unknown>> {
    const anchor = thread.root.anchor;
    if (!anchor) return {};
    const place = noteText !== null ? resolveAnchor(anchor, noteText) : ({ status: 'detached' } as AnchorResolution);
    const current = place.status === 'attached' && !place.deleted ? place.quote : '';
    return {
        thread_id: thread.root.id,
        note_id: linkTarget(anchor.path),
        link: wikilink(anchor.path),
        resolved: thread.root.resolved,
        ...where(place, anchor.kind),
        ...(anchor.kind === 'range' ? { quote: clip(current || anchor.quote) } : {}),
        ...(anchor.kind === 'range' && current && current !== anchor.quote ? { quote_when_commented: clip(anchor.quote) } : {}),
        comments: [thread.root, ...thread.replies].filter((record) => !record.deleted || record === thread.root).map(commentRow),
    };
}

async function readNote(app: App, path: string): Promise<string | null> {
    const file = app.vault.getAbstractFileByPath(path) as TFile | null;
    if (!file || !('extension' in file)) return null;
    try {
        return await app.vault.cachedRead(file);
    } catch {
        return null;
    }
}

export function createCommentToolDispatcher(options: CommentToolsOptions): ToolDispatcher {
    const { app, store, actor } = options;
    const excluded = () => options.getExcludedFolders?.() ?? [];
    /** A thread on a note in an excluded folder, which the tools leave alone. */
    const offLimits = (threadId: string) => {
        const path = store.thread(threadId)?.root.anchor?.path;
        return Boolean(path && isExcludedPath(path, excluded()));
    };
    return async (name, args) => {
        try {
            await store.load();
            switch (name) {
                case 'get_comments': {
                    const note = noteFor(app, text(args.note_id), excluded());
                    if ('error' in note) return note;
                    const noteText = await app.vault.cachedRead(note.file);
                    const threads = store
                        .threadsOn(note.file.path)
                        .filter((thread) => args.include_resolved === true || !thread.root.resolved)
                        .filter((thread) => !thread.root.deleted || thread.replies.some((reply) => !reply.deleted));
                    const described = await Promise.all(threads.map((thread) => describeThread(app, thread, noteText)));
                    described.sort((a, b) => Number(a.line ?? 0) - Number(b.line ?? 0));
                    return { note_id: linkTarget(note.file.path), link: wikilink(note.file.path), total: described.length, threads: described };
                }
                case 'find_comments': {
                    const needle = text(args.text_contains).toLowerCase();
                    const author = text(args.author);
                    const limit = Math.min(MAX_FIND_LIMIT, Math.max(1, Number.isInteger(args.limit) && (args.limit as number) > 0 ? (args.limit as number) : DEFAULT_FIND_LIMIT));
                    const matches = store.threads().filter((thread) => {
                        if (!thread.root.anchor) return false;
                        if (isExcludedPath(thread.root.anchor.path, excluded())) return false;
                        if (args.include_resolved !== true && thread.root.resolved) return false;
                        if (author && thread.root.owner !== author) return false;
                        if (!needle) return true;
                        const haystack = [thread.root.anchor.quote, thread.root.text, ...thread.replies.map((reply) => reply.text)].join('\n').toLowerCase();
                        return haystack.includes(needle);
                    });
                    const newest = matches.sort((a, b) => b.root.updatedAt.localeCompare(a.root.updatedAt)).slice(0, limit);
                    const described = [];
                    for (const thread of newest) described.push(await describeThread(app, thread, await readNote(app, thread.root.anchor?.path ?? '')));
                    return { total_count: matches.length, threads: described };
                }
                case 'add_comment': {
                    const note = noteFor(app, text(args.note_id), excluded());
                    if ('error' in note) return note;
                    const comment = text(args.text);
                    if (!comment) return { error: 'add_comment needs `text`.' };
                    const raw = await app.vault.read(note.file);
                    const body = normalized(raw);
                    const quote = typeof args.quote === 'string' ? args.quote : '';
                    let from = 0;
                    let to = 0;
                    if (quote.trim()) {
                        const hits: number[] = [];
                        for (let at = body.indexOf(quote); at !== -1; at = body.indexOf(quote, at + 1)) hits.push(at);
                        if (hits.length === 0) {
                            return { error: 'That passage is not in the note word for word. read_note and copy the passage exactly (or a shorter part of it).' };
                        }
                        const occurrence = Number.isInteger(args.occurrence) ? (args.occurrence as number) : 0;
                        if (hits.length > 1 && !(occurrence >= 1 && occurrence <= hits.length)) {
                            return { error: `That passage appears ${hits.length} times in the note. Quote more of it so it is unique, or give occurrence (1–${hits.length}).` };
                        }
                        from = hits[hits.length > 1 ? occurrence - 1 : 0];
                        to = from + quote.length;
                    }
                    const anchor = captureAnchor(note.file.path, raw, { from, to });
                    const thread = await store.addThread({ actor, anchor, text: comment });
                    return { ok: true, thread_id: thread.root.id, link: wikilink(note.file.path), line: anchor.kind === 'range' ? body.slice(0, from).split('\n').length : null };
                }
                case 'reply_to_comment': {
                    if (offLimits(text(args.thread_id))) return { error: EXCLUDED_NOTE_ERROR };
                    const reply = await store.reply({ actor, threadId: text(args.thread_id), text: text(args.text) });
                    return { ok: true, thread_id: reply.documentId, comment_id: reply.id };
                }
                case 'resolve_comment': {
                    if (offLimits(text(args.thread_id))) return { error: EXCLUDED_NOTE_ERROR };
                    const thread = await store.setResolved({ actor, threadId: text(args.thread_id), resolved: args.resolved !== false });
                    return { ok: true, thread_id: thread.root.id, resolved: thread.root.resolved };
                }
                default:
                    return { error: `No tool named ${name}.` };
            }
        } catch (error) {
            if (error instanceof CommentError || error instanceof Error) return { error: error.message };
            return { error: String(error) };
        }
    };
}
