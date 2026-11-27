/**
 * Conversations as files in the vault: one JSON file per conversation in
 * `<data folder>/conversations/<id>.json`.
 *
 * The file is AlphainZ's conversation format (`alphainz.conversation`,
 * version 1): the thread, the runs as stored, and a readable transcript. The
 * folder is AlphainO's own, so the two plugins' conversations do not mix, but
 * either can read the other's files. The vault syncs the folder; a file a sync
 * client duplicated on a conflict ("<id> 2.json") is ignored.
 */
import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { ThreadCompaction } from '@beaver/agent-llm/threadCompaction';
import { answerText } from '../agent/runTurn';
import { attachedNotesOf, openNoteOf, quoteOf } from '../agent/quote';

export const CONVERSATION_FORMAT = 'alphainz.conversation';
export const CONVERSATION_VERSION = 1;

export interface ConversationFile {
    format: typeof CONVERSATION_FORMAT;
    version: number;
    generator: { name: string; version: string };
    thread: {
        id: string;
        name: string;
        createdAt: string;
        updatedAt: string;
        archivedAt: string | null;
        compaction: ThreadCompaction | null;
    };
    /** The transcript in chat-completions form: the readable half. */
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    /** The runs as stored, lossless. */
    runs: AgentRun[];
    exportedBy: string;
    exportedAt: string;
}

export interface Conversation {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    /** When it was moved to the archive (deleted, restorable), or null. */
    archivedAt?: string | null;
    runs: AgentRun[];
}

export interface ConversationSummary {
    id: string;
    name: string;
    updatedAt: string;
    archivedAt: string | null;
    /** The questions and answers, lowercased and capped, for the history's search. */
    searchText: string;
    /**
     * The notes (and PDFs) its questions were about: open in the editor when
     * asked, attached, or holding the selected passage. AlphainZ's "chats about
     * this paper" counts the same things (`itemLinksForRun`).
     */
    notes: string[];
}

/** Every note a conversation's questions carried, each once. */
export function notesOf(conversation: Pick<Conversation, 'runs'>): string[] {
    const notes = new Set<string>();
    for (const run of conversation.runs) {
        const open = openNoteOf(run.user_prompt);
        if (open) notes.add(open);
        for (const path of attachedNotesOf(run.user_prompt)) notes.add(path);
        const quote = quoteOf(run.user_prompt);
        if (quote?.path) notes.add(quote.path);
    }
    return [...notes];
}

/** How much of a conversation's text the history search reads. */
const SEARCH_TEXT_CHARS = 60_000;

function searchTextOf(conversation: Conversation): string {
    return transcript(conversation.runs)
        .map((message) => message.content)
        .join('\n')
        .slice(0, SEARCH_TEXT_CHARS)
        .toLowerCase();
}

/** The slice of Obsidian's DataAdapter the store uses. */
export interface FileAdapter {
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    remove(path: string): Promise<void>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    /** When the file last changed, to reuse what was read from it. */
    stat?(path: string): Promise<{ mtime: number; size: number } | null>;
}

/** A conversation file's name: the conversation id, a UUID. */
const FILE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;

export function transcript(runs: AgentRun[]): ConversationFile['messages'] {
    const out: ConversationFile['messages'] = [];
    for (const run of runs) {
        out.push({ role: 'user', content: run.user_prompt?.content ?? '' });
        const answer = answerText(run);
        if (answer) out.push({ role: 'assistant', content: answer });
    }
    return out;
}

export function toFile(conversation: Conversation, generatorVersion: string, deviceId: string, now: Date): ConversationFile {
    return {
        format: CONVERSATION_FORMAT,
        version: CONVERSATION_VERSION,
        generator: { name: 'AlphainO', version: generatorVersion },
        thread: {
            id: conversation.id,
            name: conversation.name,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            archivedAt: conversation.archivedAt ?? null,
            compaction: null,
        },
        messages: transcript(conversation.runs),
        runs: conversation.runs,
        exportedBy: deviceId,
        exportedAt: now.toISOString(),
    };
}

/** A conversation read back from a file, or null when the file is not one this version can read. */
export function fromFile(text: string): Conversation | null {
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (parsed?.format !== CONVERSATION_FORMAT) return null;
    if (typeof parsed.version !== 'number' || parsed.version > CONVERSATION_VERSION) return null;
    const thread = parsed.thread;
    if (!thread || typeof thread.id !== 'string' || !Array.isArray(parsed.runs)) return null;
    return {
        id: thread.id,
        name: typeof thread.name === 'string' ? thread.name : '',
        createdAt: String(thread.createdAt ?? ''),
        updatedAt: String(thread.updatedAt ?? thread.createdAt ?? ''),
        archivedAt: typeof thread.archivedAt === 'string' && thread.archivedAt ? thread.archivedAt : null,
        runs: parsed.runs as AgentRun[],
    };
}

export class ConversationStore {
    constructor(
        private readonly adapter: FileAdapter,
        private readonly dataFolder: () => string,
        private readonly generatorVersion: string,
        private readonly deviceId: string,
    ) {}

    folder(): string {
        return `${this.dataFolder()}/conversations`;
    }

    private path(id: string): string {
        return `${this.folder()}/${id}.json`;
    }

    private async ensureFolder(): Promise<void> {
        const parts = this.folder().split('/');
        for (let i = 1; i <= parts.length; i += 1) {
            const path = parts.slice(0, i).join('/');
            if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
        }
    }

    /** Every readable conversation, most recently updated first. */
    /** What was read from each file, while it has not changed since. */
    private readonly summaries = new Map<string, { mtime: number; size: number; summary: ConversationSummary }>();

    /** Every readable conversation (archived ones too, marked), most recently updated first. */
    async list(): Promise<ConversationSummary[]> {
        if (!(await this.adapter.exists(this.folder()))) return [];
        const { files } = await this.adapter.list(this.folder());
        const out: ConversationSummary[] = [];
        for (const file of files) {
            const name = file.split('/').pop() ?? '';
            if (!FILE_NAME.test(name)) continue;
            try {
                const stat = (await this.adapter.stat?.(file)) ?? null;
                const cached = this.summaries.get(file);
                if (stat && cached && cached.mtime === stat.mtime && cached.size === stat.size) {
                    out.push(cached.summary);
                    continue;
                }
                const conversation = fromFile(await this.adapter.read(file));
                if (!conversation) continue;
                const summary = {
                    id: conversation.id,
                    name: conversation.name,
                    updatedAt: conversation.updatedAt,
                    archivedAt: conversation.archivedAt ?? null,
                    searchText: searchTextOf(conversation),
                    notes: notesOf(conversation),
                };
                if (stat) this.summaries.set(file, { mtime: stat.mtime, size: stat.size, summary });
                out.push(summary);
            } catch {
                // Unreadable for now (a sync client still downloading it): skip.
            }
        }
        return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    /** Move a conversation to the archive (AlphainZ's delete): it stays restorable. */
    async archive(id: string, now = new Date()): Promise<void> {
        const conversation = await this.load(id);
        if (conversation) await this.save({ ...conversation, archivedAt: now.toISOString() }, now);
    }

    /** Bring a conversation back from the archive. */
    async restore(id: string, now = new Date()): Promise<void> {
        const conversation = await this.load(id);
        if (conversation) await this.save({ ...conversation, archivedAt: null }, now);
    }

    async rename(id: string, name: string, now = new Date()): Promise<void> {
        const conversation = await this.load(id);
        if (conversation) await this.save({ ...conversation, name: name.trim() }, now);
    }

    async load(id: string): Promise<Conversation | null> {
        const path = this.path(id);
        if (!(await this.adapter.exists(path))) return null;
        return fromFile(await this.adapter.read(path));
    }

    async save(conversation: Conversation, now = new Date()): Promise<void> {
        await this.ensureFolder();
        const file = toFile(conversation, this.generatorVersion, this.deviceId, now);
        await this.adapter.write(this.path(conversation.id), `${JSON.stringify(file, null, 2)}\n`);
    }

    /** Delete a conversation for good (its file, which the vault's sync then removes everywhere). */
    async remove(id: string): Promise<void> {
        const path = this.path(id);
        this.summaries.delete(path);
        if (await this.adapter.exists(path)) await this.adapter.remove(path);
    }
}
