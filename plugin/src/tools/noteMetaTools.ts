/**
 * The rest of the vault tools, each the counterpart of one of AlphainZ's
 * library tools, with the same kind of arguments and results:
 *
 * | AlphainZ (Zotero)          | AlphainO (Obsidian)        |
 * |----------------------------|----------------------------|
 * | `item_search_by_metadata`  | `note_search_by_metadata`  |
 * | `search_in_document`       | `search_in_note`           |
 * | `get_metadata`             | `get_note_metadata`        |
 * | `list_collections`         | `list_folders`             |
 * | `list_tags`                | `list_tags`                |
 * | (none)                     | `get_note_links`           |
 *
 * Notes are named by `note_id` (the path without `.md`) and every row carries
 * `link`, the `[[wikilink]]` to cite. Line numbers count from 1 in the note's
 * text, as `read_note` counts them.
 */
import { getAllTags, TFile, TFolder, type App, type CachedMetadata } from 'obsidian';
import type { ToolDispatcher } from '@beaver/agent-llm/agentLoop';
import type { ToolSchema } from '@beaver/agent-llm/types';
import { noteHeadings, splitLines } from '../search/chunker';
import { hasHiddenSegment, isUnderFolder, linkTarget, normalizeFolderPath, wikilink } from '../search/paths';
import { EXCLUDED_NOTE_ERROR, locateNote } from './vaultTools';
import { isExcludedPath } from '../search/paths';

export const NOTE_META_TOOL_NAMES = ['note_search_by_metadata', 'search_in_note', 'get_note_metadata', 'list_folders', 'list_tags', 'get_note_links'] as const;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_HITS = 30;
const CONTEXT_CHARS = 160;

const paging = {
    limit: { type: 'integer', description: `How many rows to return (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).` },
    offset: { type: 'integer', description: 'How many rows to skip, for the next page.' },
};

export function noteMetaToolSchemas(): ToolSchema[] {
    return [
        {
            name: 'note_search_by_metadata',
            description:
                "Find notes by what they are rather than what they say: title, tag, a property (frontmatter field) and its value, folder, and when they were created or changed. Use it when the user names a note, a tag or a property, or asks for notes from a period. Several criteria narrow the result (AND).",
            parameters: {
                type: 'object',
                properties: {
                    title_query: { type: 'string', description: 'Words in the note’s title (file name), case-insensitive.' },
                    tag: { type: 'string', description: 'A tag, with or without "#"; nested tags count (#project finds #project/alpha).' },
                    property: { type: 'string', description: 'A property (frontmatter field) the note must have, e.g. "status".' },
                    property_value: { type: 'string', description: 'With `property`: words its value must contain.' },
                    folder: { type: 'string', description: 'Only notes in this folder (and its subfolders).' },
                    modified_after: { type: 'string', description: 'Changed on or after this date (YYYY-MM-DD).' },
                    modified_before: { type: 'string', description: 'Changed before this date (YYYY-MM-DD).' },
                    created_after: { type: 'string', description: 'Created on or after this date (YYYY-MM-DD).' },
                    ...paging,
                },
                required: [],
            },
        },
        {
            name: 'search_in_note',
            description:
                'Find where a word or phrase appears inside one note, with the line numbers and a little context around each match. Matching is literal and case-insensitive, not semantic: search for a term the note would actually use. Use it to locate a topic in a long note, then read_note those lines.',
            parameters: {
                type: 'object',
                properties: {
                    note_id: { type: 'string', description: 'The note (its note_id or [[link]]).' },
                    query: { type: 'string', description: 'The word or phrase to find. Short and distinctive works best.' },
                },
                required: ['note_id', 'query'],
            },
        },
        {
            name: 'get_note_metadata',
            description:
                'What notes are, without their text: properties (frontmatter), tags, the outline of headings with their lines, how many lines, links out and links in, and when each was created and changed. Use it after a search to inspect candidates, or to see a long note’s outline before reading part of it.',
            parameters: {
                type: 'object',
                properties: {
                    note_ids: { type: 'array', items: { type: 'string' }, description: 'Notes from a previous result (note_id or [[link]]).' },
                },
                required: ['note_ids'],
            },
        },
        {
            name: 'list_folders',
            description:
                "List the vault's folders, flattened: every row carries `parent` so you can rebuild the tree, and `note_count` (notes directly in it) and `total_notes` (with its subfolders). Use it to understand how the user organizes their notes before searching.",
            parameters: {
                type: 'object',
                properties: {
                    parent_folder: { type: 'string', description: 'List only inside this folder.' },
                    ...paging,
                },
                required: [],
            },
        },
        {
            name: 'list_tags',
            description: 'List the tags in use, most frequent first, with how many notes carry each. Useful for learning the vocabulary the user organizes their notes with.',
            parameters: {
                type: 'object',
                properties: {
                    name_query: { type: 'string', description: 'Keep only tags whose name contains this.' },
                    ...paging,
                },
                required: [],
            },
        },
        {
            name: 'get_note_links',
            description:
                'The links of one note: the notes it links to (and links that point to no note yet), and the notes that link to it (backlinks), with how many times. Use it to follow how the user’s notes connect.',
            parameters: {
                type: 'object',
                properties: {
                    note_id: { type: 'string', description: 'The note (its note_id or [[link]]). Default: the note open in the editor.' },
                },
                required: [],
            },
        },
    ];
}

export interface NoteMetaToolsOptions {
    app: App;
    getExcludedFolders?: () => readonly string[];
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function count(value: unknown, fallback: number, max: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function offsetOf(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

function dayStart(value: string): number | null {
    if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
    const time = Date.parse(`${value.slice(0, 10)}T00:00:00`);
    return Number.isNaN(time) ? null : time;
}

function isoDay(time: number): string {
    const date = new Date(time);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalTag(tag: string): string {
    return tag.trim().replace(/^#/, '').toLowerCase();
}

function tagsOf(cache: CachedMetadata | null): string[] {
    if (!cache) return [];
    return [...new Set((getAllTags(cache) ?? []).map((tag) => tag.replace(/^#/, '')))];
}

function hasTag(tags: string[], wanted: string): boolean {
    const want = normalTag(wanted);
    return tags.some((tag) => {
        const have = tag.toLowerCase();
        return have === want || have.startsWith(`${want}/`);
    });
}

function propertyText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(propertyText).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

export function createNoteMetaToolDispatcher(options: NoteMetaToolsOptions): ToolDispatcher {
    const { app } = options;
    const excluded = () => options.getExcludedFolders?.() ?? [];
    const visible = (file: TFile) =>
        !hasHiddenSegment(file.path) && !excluded().some((folder) => normalizeFolderPath(folder) !== '' && isUnderFolder(file.path, folder));
    const notes = () => app.vault.getMarkdownFiles().filter(visible);
    const cacheOf = (file: TFile) => app.metadataCache.getFileCache(file);

    const backlinksOf = (path: string) => {
        const resolved = app.metadataCache.resolvedLinks ?? {};
        const rows: Array<{ note_id: string; link: string; count: number }> = [];
        for (const [source, targets] of Object.entries(resolved)) {
            const n = targets?.[path];
            // A note in an excluded folder is not named, even as a backlink.
            if (n && source !== path && /\.md$/i.test(source) && !isExcludedPath(source, excluded())) rows.push({ note_id: linkTarget(source), link: wikilink(source), count: n });
        }
        return rows.sort((a, b) => b.count - a.count || a.note_id.localeCompare(b.note_id));
    };

    return async (name, args) => {
        switch (name) {
            case 'note_search_by_metadata': {
                const title = text(args.title_query).toLowerCase();
                const tag = text(args.tag);
                const property = text(args.property);
                const value = text(args.property_value).toLowerCase();
                const folder = text(args.folder);
                const after = dayStart(text(args.modified_after));
                const before = dayStart(text(args.modified_before));
                const created = dayStart(text(args.created_after));
                if (!title && !tag && !property && !folder && after === null && before === null && created === null) {
                    return { error: 'Give at least one criterion (title_query, tag, property, folder or a date).' };
                }
                if (folder && !(app.vault.getAbstractFileByPath(normalizeFolderPath(folder)) instanceof TFolder)) {
                    return { error: `There is no folder "${folder}" in the vault. list_folders shows what exists.` };
                }
                const matches = notes()
                    .filter((file) => {
                        if (title && !file.basename.toLowerCase().includes(title)) return false;
                        if (folder && !isUnderFolder(file.path, folder)) return false;
                        if (after !== null && file.stat.mtime < after) return false;
                        if (before !== null && file.stat.mtime >= before) return false;
                        if (created !== null && file.stat.ctime < created) return false;
                        const cache = cacheOf(file);
                        if (tag && !hasTag(tagsOf(cache), tag)) return false;
                        if (property) {
                            const frontmatter = cache?.frontmatter ?? {};
                            const key = Object.keys(frontmatter).find((k) => k.toLowerCase() === property.toLowerCase());
                            if (!key) return false;
                            if (value && !propertyText(frontmatter[key]).toLowerCase().includes(value)) return false;
                        }
                        return true;
                    })
                    .sort((a, b) => b.stat.mtime - a.stat.mtime);
                const offset = offsetOf(args.offset);
                const limit = count(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
                return {
                    total_count: matches.length,
                    items: matches.slice(offset, offset + limit).map((file) => {
                        const cache = cacheOf(file);
                        const tags = tagsOf(cache);
                        return {
                            note_id: linkTarget(file.path),
                            title: file.basename,
                            link: wikilink(file.path),
                            ...(tags.length > 0 ? { tags } : {}),
                            ...(property && cache?.frontmatter ? { [property]: propertyText(cache.frontmatter[property]) } : {}),
                            date_added: isoDay(file.stat.ctime),
                            date_modified: isoDay(file.stat.mtime),
                        };
                    }),
                    ...(offset + limit < matches.length ? { next_offset: offset + limit } : {}),
                };
            }
            case 'search_in_note': {
                const located = locateNote(app, text(args.note_id), excluded());
                if ('error' in located) return located;
                const query = text(args.query);
                if (!query) return { error: 'search_in_note needs `query`.' };
                const lines = splitLines(await app.vault.cachedRead(located.file));
                const needle = query.toLowerCase();
                const headings = noteHeadings(lines);
                const hits: Array<Record<string, unknown>> = [];
                let total = 0;
                lines.forEach((line, index) => {
                    let at = line.toLowerCase().indexOf(needle);
                    while (at !== -1) {
                        total += 1;
                        if (hits.length < MAX_HITS) {
                            const start = Math.max(0, at - CONTEXT_CHARS / 2);
                            // noteHeadings counts lines from 0, as `lines` does.
                            const section = [...headings].reverse().find((heading) => heading.line <= index);
                            hits.push({
                                line: index + 1,
                                ...(section ? { heading: section.heading } : {}),
                                context: `${start > 0 ? '…' : ''}${line.slice(start, at + needle.length + CONTEXT_CHARS / 2)}${at + needle.length + CONTEXT_CHARS / 2 < line.length ? '…' : ''}`,
                            });
                        }
                        at = line.toLowerCase().indexOf(needle, at + needle.length);
                    }
                });
                return {
                    note_id: linkTarget(located.file.path),
                    link: wikilink(located.file.path),
                    total_lines: lines.length,
                    total_matches: total,
                    matches: hits,
                    ...(total === 0 ? { note: 'No literal match. Try a shorter or different word, or note_search_by_topic for meaning.' } : {}),
                    ...(total > hits.length ? { truncated: true } : {}),
                };
            }
            case 'get_note_metadata': {
                const requested = Array.isArray(args.note_ids) ? args.note_ids.map((id) => text(id)).filter(Boolean) : [];
                if (requested.length === 0) return { error: 'get_note_metadata needs `note_ids`.' };
                const items = [];
                for (const request of requested.slice(0, 20)) {
                    const located = locateNote(app, request, excluded());
                    if ('error' in located) {
                        items.push({ note_id: request, ...located });
                        continue;
                    }
                    const file = located.file;
                    const cache = cacheOf(file);
                    const lines = splitLines(await app.vault.cachedRead(file));
                    const outgoing = Object.values(app.metadataCache.resolvedLinks?.[file.path] ?? {}).reduce((sum, n) => sum + n, 0);
                    items.push({
                        note_id: linkTarget(file.path),
                        title: file.basename,
                        link: wikilink(file.path),
                        folder: file.parent && file.parent.path !== '/' ? file.parent.path : '',
                        properties: cache?.frontmatter ? Object.fromEntries(Object.entries(cache.frontmatter).filter(([key]) => key !== 'position')) : {},
                        tags: tagsOf(cache),
                        // Lines count from 1 here, as read_note counts them.
                        outline: noteHeadings(lines).map((heading) => ({ level: heading.level, heading: heading.heading, line: heading.line + 1 })),
                        total_lines: lines.length,
                        links_out: outgoing,
                        links_in: backlinksOf(file.path).reduce((sum, row) => sum + row.count, 0),
                        date_added: isoDay(file.stat.ctime),
                        date_modified: isoDay(file.stat.mtime),
                        size_bytes: file.stat.size,
                    });
                }
                return { items };
            }
            case 'list_folders': {
                const parent = normalizeFolderPath(text(args.parent_folder));
                if (parent && !(app.vault.getAbstractFileByPath(parent) instanceof TFolder)) {
                    return { error: `There is no folder "${parent}" in the vault.` };
                }
                const visibleNotes = notes();
                const folders = app.vault
                    .getAllLoadedFiles()
                    .filter((file): file is TFolder => file instanceof TFolder && file.path !== '/' && !hasHiddenSegment(file.path))
                    .filter((folder) => !excluded().some((ex) => normalizeFolderPath(ex) !== '' && isUnderFolder(folder.path, ex)))
                    .filter((folder) => !parent || (folder.path !== parent && isUnderFolder(folder.path, parent)))
                    .sort((a, b) => a.path.localeCompare(b.path));
                const offset = offsetOf(args.offset);
                const limit = count(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
                return {
                    total_count: folders.length,
                    folders: folders.slice(offset, offset + limit).map((folder) => ({
                        folder: folder.path,
                        parent: folder.parent && folder.parent.path !== '/' ? folder.parent.path : '',
                        note_count: visibleNotes.filter((file) => file.parent?.path === folder.path).length,
                        total_notes: visibleNotes.filter((file) => isUnderFolder(file.path, folder.path)).length,
                    })),
                    ...(offset + limit < folders.length ? { next_offset: offset + limit } : {}),
                };
            }
            case 'list_tags': {
                const query = normalTag(text(args.name_query));
                const counts = new Map<string, number>();
                for (const file of notes()) {
                    for (const tag of tagsOf(cacheOf(file))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
                }
                const rows = [...counts.entries()]
                    .filter(([tag]) => !query || tag.toLowerCase().includes(query))
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
                const offset = offsetOf(args.offset);
                const limit = count(args.limit, DEFAULT_LIMIT * 2, MAX_LIMIT * 2);
                return {
                    total_count: rows.length,
                    tags: rows.slice(offset, offset + limit).map(([tag, notesWithIt]) => ({ tag: `#${tag}`, note_count: notesWithIt })),
                    ...(offset + limit < rows.length ? { next_offset: offset + limit } : {}),
                };
            }
            case 'get_note_links': {
                let file: TFile | null = null;
                const request = text(args.note_id);
                if (request) {
                    const located = locateNote(app, request, excluded());
                    if ('error' in located) return located;
                    file = located.file;
                } else {
                    const active = app.workspace.getActiveFile();
                    if (active && active.extension === 'md') file = active;
                    if (file && isExcludedPath(file.path, excluded())) return { error: EXCLUDED_NOTE_ERROR };
                }
                if (!file) return { error: 'No note is open in the editor; give note_id.' };
                const out = Object.entries(app.metadataCache.resolvedLinks?.[file.path] ?? {})
                    .filter(([target]) => target !== file?.path && !isExcludedPath(target, excluded()))
                    .map(([target, n]) => ({ note_id: linkTarget(target), link: /\.md$/i.test(target) ? wikilink(target) : `[[${target}]]`, count: n }))
                    .sort((a, b) => b.count - a.count || a.note_id.localeCompare(b.note_id));
                const unresolved = Object.entries(app.metadataCache.unresolvedLinks?.[file.path] ?? {}).map(([target, n]) => ({ target, count: n }));
                return {
                    note_id: linkTarget(file.path),
                    link: wikilink(file.path),
                    links_out: out,
                    ...(unresolved.length > 0 ? { links_to_missing_notes: unresolved } : {}),
                    backlinks: backlinksOf(file.path),
                };
            }
            default:
                return { error: `No tool named ${name}.` };
        }
    };
}
