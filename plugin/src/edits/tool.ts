/**
 * `edit_note`: the assistant edits a note the way it would in an IDE. The tool
 * takes AlphainZ's `edit_note` arguments (`operation`, `old_string`,
 * `new_string`), puts the change into the note at once (open in a tab if it
 * was not) and marks every changed span for the user to accept or reject
 * (review.ts). `edit_status` tells how the review went, for a client that
 * moved on (Claude through MCP does not wait for the user).
 */
import { MarkdownView, type App, type TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type { ToolDispatcher } from '@beaver/agent-llm/agentLoop';
import type { ToolSchema } from '@beaver/agent-llm/types';
import { linkTarget, wikilink } from '../search/paths';
import { locateNote } from '../tools/vaultTools';
import { diffChunks } from './diff';
import { addReview, type ChunkOutcome, type ReviewChunk } from './review';

export const EDIT_NOTE_SCHEMA: ToolSchema = {
    name: 'edit_note',
    description:
        'Edit a note in the vault. Read the note first with `read_note`: `old_string` has to match the note exactly and uniquely, and '
        + 'you cannot know that without having read it. Prefer the smallest edit that does the job: a targeted replacement is reviewable, '
        + 'a rewrite is not. The change goes into the note at once, marked for the user to accept or reject piece by piece (and one undo '
        + 'takes it all back), so say what you changed and why.',
    parameters: {
        type: 'object',
        properties: {
            note_id: { type: 'string', description: 'The note (its note_id or [[link]]), from `read_note` or a search result.' },
            operation: {
                type: 'string',
                enum: ['str_replace', 'str_replace_all', 'insert_after', 'insert_before', 'append', 'rewrite'],
                description:
                    'What kind of edit. `str_replace` (the default) replaces one unique match; `insert_after`/`insert_before` leave `old_string` '
                    + 'in place and add around it; `append` adds to the end; `rewrite` replaces the whole note and should be a last resort.',
            },
            old_string: {
                type: 'string',
                description: 'The exact text to find, copied from `read_note`. Required for every operation except `append` and `rewrite`. It must appear exactly once unless you use `str_replace_all`.',
            },
            new_string: { type: 'string', description: 'The replacement, insertion, or new text.' },
        },
        required: ['note_id', 'new_string'],
    },
};

export const EDIT_STATUS_SCHEMA: ToolSchema = {
    name: 'edit_status',
    description: 'How the user’s review of an edit made with `edit_note` stands: how many changed pieces they accepted, rejected, or have not decided yet.',
    parameters: { type: 'object', properties: { edit_id: { type: 'string', description: 'The id `edit_note` returned.' } }, required: ['edit_id'] },
};

/** What became of each edit: its pieces and what the user decided about them. */
export class EditRegistry {
    private readonly edits = new Map<string, { path: string; at: string; chunks: Map<string, 'pending' | ChunkOutcome> }>();

    add(editId: string, path: string, chunkIds: string[]): void {
        this.edits.set(editId, { path, at: new Date().toISOString(), chunks: new Map(chunkIds.map((id) => [id, 'pending' as const])) });
    }

    settle(chunk: ReviewChunk, outcome: ChunkOutcome): void {
        const edit = this.edits.get(chunk.editId);
        if (edit?.chunks.has(chunk.id)) edit.chunks.set(chunk.id, outcome);
    }

    status(editId: string): Record<string, unknown> | null {
        const edit = this.edits.get(editId);
        if (!edit) return null;
        const values = [...edit.chunks.values()];
        const count = (value: string) => values.filter((v) => v === value).length;
        return {
            edit_id: editId,
            note_id: linkTarget(edit.path),
            pieces: values.length,
            accepted: count('accepted'),
            rejected: count('rejected'),
            undecided: count('pending'),
        };
    }
}

export interface EditHost {
    app: App;
    registry: EditRegistry;
    newId: () => string;
    /** Folders the user left out of AlphainO: their notes are never edited. */
    getExcludedFolders?: () => readonly string[];
}

/** The editor showing a note: a tab that already has it, else a new tab opened in the background. */
async function editorFor(app: App, file: TFile): Promise<EditorView | null> {
    let view: MarkdownView | null = null;
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
            view = leaf.view;
            break;
        }
    }
    if (!view) {
        const leaf = app.workspace.getLeaf('tab');
        await leaf.openFile(file, { active: false });
        view = leaf.view instanceof MarkdownView ? leaf.view : null;
    }
    return (view?.editor as unknown as { cm?: EditorView } | undefined)?.cm ?? null;
}

function occurrences(text: string, needle: string): number[] {
    const found: number[] = [];
    if (!needle) return found;
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) found.push(at);
    return found;
}

/** The note's text after the operation, or why it cannot be done. */
export function applyOperation(text: string, args: Record<string, unknown>): { text: string } | { error: string } {
    const operation = typeof args.operation === 'string' && args.operation ? args.operation : 'str_replace';
    const oldString = typeof args.old_string === 'string' ? args.old_string : '';
    const newString = typeof args.new_string === 'string' ? args.new_string : '';
    if (operation === 'append') return { text: text === '' || text.endsWith('\n') ? `${text}${newString}` : `${text}\n${newString}` };
    if (operation === 'rewrite') return { text: newString };
    if (!oldString) return { error: `${operation} needs old_string, copied exactly from read_note.` };
    const hits = occurrences(text, oldString);
    if (hits.length === 0) return { error: 'old_string is not in the note word for word (it may have changed since you read it). read_note again and copy it exactly.' };
    if (operation === 'str_replace_all') return { text: text.split(oldString).join(newString) };
    if (hits.length > 1) return { error: `old_string appears ${hits.length} times in the note. Include more of the surrounding text so it is unique, or use str_replace_all.` };
    const at = hits[0];
    const end = at + oldString.length;
    switch (operation) {
        case 'str_replace':
            return { text: text.slice(0, at) + newString + text.slice(end) };
        case 'insert_after':
            return { text: text.slice(0, end) + newString + text.slice(end) };
        case 'insert_before':
            return { text: text.slice(0, at) + newString + text.slice(at) };
        default:
            return { error: `Unknown operation "${operation}".` };
    }
}

export function createEditDispatcher(host: EditHost): ToolDispatcher {
    return async (name, args) => {
        if (name === 'edit_status') {
            const status = host.registry.status(typeof args.edit_id === 'string' ? args.edit_id : '');
            return status ?? { error: 'No edit with that id in this session (edits are reviewed in Obsidian and their record ends when it closes).' };
        }
        if (name !== 'edit_note') return { error: `No tool named ${name}.` };
        const located = locateNote(host.app, typeof args.note_id === 'string' ? args.note_id : '', host.getExcludedFolders?.() ?? []);
        if ('error' in located) return located;
        const view = await editorFor(host.app, located.file);
        if (!view) return { error: 'The note could not be opened in an editor to make the change.' };
        const before = view.state.doc.toString();
        const result = applyOperation(before, args);
        if ('error' in result) return result;
        if (result.text === before) return { error: 'The edit changes nothing.' };
        const pieces = diffChunks(before, result.text);
        const editId = host.newId();
        const chunks: ReviewChunk[] = pieces.map((piece) => ({
            id: host.newId(),
            editId,
            from: piece.fromB,
            to: piece.toB,
            inserted: result.text.slice(piece.fromB, piece.toB),
            deleted: before.slice(piece.fromA, piece.toA),
        }));
        view.dispatch({
            changes: pieces.map((piece) => ({ from: piece.fromA, to: piece.toA, insert: result.text.slice(piece.fromB, piece.toB) })),
            effects: addReview.of(chunks),
            userEvent: 'alphaino.edit',
        });
        host.registry.add(editId, located.file.path, chunks.map((chunk) => chunk.id));
        return {
            ok: true,
            edit_id: editId,
            note_id: linkTarget(located.file.path),
            link: wikilink(located.file.path),
            pieces: chunks.length,
            message: 'The change is in the note, marked for the user to accept or reject piece by piece; one undo takes it all back.',
        };
    };
}
