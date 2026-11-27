/**
 * `create_note`: a new note in the vault, the counterpart of AlphainZ's
 * `create_note` (which adds a note to a Zotero item). It never touches an
 * existing note: a title already taken gets a number. Notes go into the folder
 * AlphainO writes into (`Agent` when the vault has one) unless another
 * existing folder is named.
 */
import { TFile, TFolder, normalizePath, type App } from 'obsidian';
import type { ToolDispatcher } from '@beaver/agent-llm/agentLoop';
import type { ToolSchema } from '@beaver/agent-llm/types';
import { linkTarget, wikilink } from '../search/paths';

export const CREATE_NOTE_SCHEMA: ToolSchema = {
    name: 'create_note',
    description:
        'Create a new note in the vault with Markdown content: a summary, a write-up, a list the user asked to keep. It never changes an existing note; a title already in use gets a number. By default it goes into the folder AlphainO writes into ("Agent" when there is one).',
    parameters: {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'The note’s title (its file name, without .md).' },
            content: { type: 'string', description: 'The note’s Markdown. Link other notes with [[wikilinks]].' },
            folder: { type: 'string', description: 'An existing folder to put it in. Default: the agent folder.' },
        },
        required: ['title', 'content'],
    },
};

/** A title as a file name Obsidian accepts and links can name. */
export function safeTitle(title: string): string {
    return title
        .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '')
        .slice(0, 120)
        .trim();
}

export function createNoteDispatcher(app: App): ToolDispatcher {
    return async (_name, args) => {
        const title = safeTitle(typeof args.title === 'string' ? args.title : '');
        if (!title) return { error: 'create_note needs a `title`.' };
        const content = typeof args.content === 'string' ? args.content : '';
        let folder = typeof args.folder === 'string' ? normalizePath(args.folder.trim()) : '';
        if (folder && !(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
            return { error: `There is no folder "${folder}" in the vault. Leave folder out to use the agent folder.` };
        }
        if (!folder) folder = app.vault.getAbstractFileByPath('Agent') instanceof TFolder ? 'Agent' : '';
        const base = folder ? `${folder}/${title}` : title;
        let path = `${base}.md`;
        for (let n = 2; app.vault.getAbstractFileByPath(path); n += 1) path = `${base} ${n}.md`;
        const file = await app.vault.create(path, content);
        if (!(file instanceof TFile)) return { error: 'The note could not be created.' };
        return { ok: true, note_id: linkTarget(file.path), link: wikilink(file.path) };
    };
}
