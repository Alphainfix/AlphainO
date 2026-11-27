/**
 * The assistant's tools for the vault. Each mirrors a tool AlphainZ gives the
 * assistant for the Zotero library, with the same verb, the same arguments
 * where the idea carries over, and the same shape of result:
 *
 * | vault                   | library                       |
 * | ----------------------- | ----------------------------- |
 * | `search_vault_fulltext` | `search_library_fulltext`     |
 * | `note_search_by_topic`  | `item_search_by_topic`        |
 * | `read_note`             | `read_document`               |
 * | `list_notes`            | `list_items`                  |
 *
 * plus `get_active_note`. A note is named by its `note_id`, its path without
 * `.md`, and every result carries a `link` (`[[Folder/Note#Heading]]`) to cite
 * it by, as AlphainZ's results carry `zotero://` links.
 *
 * Optional arguments arrive from models filled with empty values (`""`, `0`)
 * as often as left out: both mean "not given". No tool throws: a call that
 * cannot be done returns `{ error }` with a sentence the model can correct
 * itself from.
 */
import { MarkdownView, type App, type TFile } from 'obsidian';
import type { ToolDispatcher } from '@beaver/agent-llm/agentLoop';
import type { ToolSchema } from '@beaver/agent-llm/types';
import { noteHeadings, splitLines } from '../search/chunker';
import { headingForLink, isExcludedPath, isIndexablePath, isUnderFolder, linkTarget, normalizeFolderPath, wikilink } from '../search/paths';
import { trimText } from '../search/text';
import type { NoteSearcher, SearchHit } from '../search/types';

export const VAULT_TOOL_NAMES = [
    'search_vault_fulltext',
    'note_search_by_topic',
    'read_note',
    'list_notes',
    'get_active_note',
] as const;
export type VaultToolName = (typeof VAULT_TOOL_NAMES)[number];

/** Most characters of a note `read_note` returns in one call. */
export const MAX_READ_CHARS = 40_000;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 25;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
/** The longest passage a result carries; `read_note` has the rest. */
const PASSAGE_CHARS = 700;
const MAX_SUGGESTIONS = 5;

const INDEX_OFF = 'Searching notes is turned off in AlphainO’s settings. read_note and list_notes still work.';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export interface VaultToolSet {
    /** Offer search_vault_fulltext: the note index exists. Default true. */
    search?: boolean;
    /** Offer note_search_by_topic: the index has an embedding model. Default true. */
    semantic?: boolean;
}

function searchFulltext(semantic: boolean): ToolSchema {
    return {
        name: 'search_vault_fulltext',
        description:
            "Search the text of the user's notes by keywords or an exact phrase, not just their titles. " +
            'This is the tool for "which of my notes mention X" or "where did I write down Y": it returns the note, the heading and lines, and the passage itself. ' +
            'Put a phrase in double quotes to require it exactly (case does not matter). ' +
            `Matching is by words, not by meaning${semantic ? ': for an idea put in other words, use note_search_by_topic' : ''}. ` +
            'Follow up with read_note on a hit to read around it, and cite a note with the `link` of its match.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Words to look for, or a "quoted phrase". Chinese and English both work; short, distinctive words work best.',
                },
                limit: { type: 'integer', description: `Maximum passages to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).` },
                folder: { type: 'string', description: 'Only search notes inside this folder (a path from the vault root).' },
            },
            required: ['query'],
        },
    };
}

const NOTE_SEARCH_BY_TOPIC: ToolSchema = {
    name: 'note_search_by_topic',
    description:
        "Semantic search over the user's notes by topic. Use this when looking for notes about a subject or an idea, however it is worded, in English or Chinese, " +
        'rather than for a known word or phrase (that is search_vault_fulltext). ' +
        'Returns the best-matching notes, each with its best passage, the lines it covers and a `link` to cite it by. Follow up with read_note on a hit to read around it.',
    parameters: {
        type: 'object',
        properties: {
            topic_query: { type: 'string', description: 'A concise topic phrase or question, 2-8 words.' },
            tags_filter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tag names, with or without #; results carry any of them.',
            },
            folder: { type: 'string', description: 'Only search notes inside this folder (a path from the vault root).' },
            limit: { type: 'integer', description: `Maximum notes to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).` },
            offset: { type: 'integer', description: 'Notes to skip, for paging.' },
        },
        required: ['topic_query'],
    },
};

const READ_NOTE: ToolSchema = {
    name: 'read_note',
    description:
        "Read a note in the user's vault. This is how you read what they wrote: prefer it to guessing from the passages a search returns. " +
        'Read the whole note, one section with `heading`, or a line range with `start_line` and `end_line`. ' +
        `A long note comes back truncated, and the result says exactly which lines it contains; ask again with \`start_line\` to read further. The note's properties (frontmatter) come with it. ` +
        'It reads a base (.base) or a canvas (.canvas) too, as text, when you name the file with its extension. ' +
        'Cite the note with the `link` returned.',
    parameters: {
        type: 'object',
        properties: {
            note_id: {
                type: 'string',
                description:
                    'The note exactly as a search, list or active-note result gave it, e.g. "Projects/Plan"; or just its name, or a [[link]]. A link with a heading, [[Plan#Risks]], reads that section.',
            },
            heading: { type: 'string', description: 'Read only the section under this heading, up to the next heading of the same level or above.' },
            start_line: { type: 'integer', description: 'First line to return, counting from 1. Default: the first line.' },
            end_line: { type: 'integer', description: 'Last line to return, inclusive. Default: the last line.' },
        },
        required: ['note_id'],
    },
};

function listNotesSchema(semantic: boolean, search: boolean): ToolSchema {
    const finders = !search ? '' : semantic ? ' For what the notes say, use search_vault_fulltext or note_search_by_topic.' : ' For what the notes say, use search_vault_fulltext.';
    return {
        name: 'list_notes',
        description:
            'List what is actually in a folder or under a tag, most recently modified first. ' +
            'Use it when the user names a folder or tag rather than describing a topic, or to see what they worked on lately. ' +
            `A folder includes everything in its subfolders, so ask for the parent once rather than querying each child. It does not look inside the notes.${finders}`,
        parameters: {
            type: 'object',
            properties: {
                folder: { type: 'string', description: 'A folder, as a path from the vault root.' },
                tag: { type: 'string', description: 'A tag name, with or without #. Notes under its nested tags (#project/alpha for project) count.' },
                limit: { type: 'integer', description: `Maximum notes to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).` },
            },
            required: [],
        },
    };
}

const GET_ACTIVE_NOTE: ToolSchema = {
    name: 'get_active_note',
    description:
        'Get the note the user has open in the editor: its id and link, the line the cursor is on, and the text they have selected, if any. ' +
        'Use it when the user says "this note", "here" or "what I selected"; then read_note to read the note itself.',
    parameters: { type: 'object', properties: {}, required: [] },
};

/** The tools to offer the model now. */
export function vaultToolSchemas(set: VaultToolSet = {}): ToolSchema[] {
    const search = set.search !== false;
    const semantic = search && set.semantic !== false;
    return [
        ...(search ? [searchFulltext(semantic)] : []),
        ...(semantic ? [NOTE_SEARCH_BY_TOPIC] : []),
        READ_NOTE,
        listNotesSchema(semantic, search),
        GET_ACTIVE_NOTE,
    ];
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface VaultToolsOptions {
    app: App;
    /** The note index, or null while note search is turned off. Asked on every call. */
    getIndex: () => NoteSearcher | null;
    /** Folders the user left out: they are not searched and not listed. Asked on every call. */
    getExcludedFolders?: () => readonly string[];
}

export interface VaultTools {
    /** The tools to offer now: the searches only while the note index exists, and the topic search only while it has an embedding model. */
    schemas(): ToolSchema[];
    dispatcher: ToolDispatcher;
    /** Whether `name` is one of these tools. */
    owns(name: string): boolean;
}

export function vaultTools(options: VaultToolsOptions): VaultTools {
    return {
        schemas: () => {
            const index = options.getIndex();
            return vaultToolSchemas({ search: index !== null, semantic: index !== null && index.status().model !== null });
        },
        dispatcher: createVaultToolDispatcher(options),
        owns: isVaultTool,
    };
}

export function isVaultTool(name: string): name is VaultToolName {
    return (VAULT_TOOL_NAMES as readonly string[]).includes(name);
}

export function createVaultToolDispatcher(options: VaultToolsOptions): ToolDispatcher {
    return async (name, args) => {
        try {
            switch (name) {
                case 'search_vault_fulltext':
                    return await searchVaultFulltext(options, args);
                case 'note_search_by_topic':
                    return await noteSearchByTopic(options, args);
                case 'read_note':
                    return await readNote(options, args);
                case 'list_notes':
                    return listNotes(options, args);
                case 'get_active_note':
                    return getActiveNote(options);
                default:
                    return { error: `Unknown tool "${name}". Available tools: ${VAULT_TOOL_NAMES.join(', ')}.` };
            }
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    };
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** A string argument, trimmed; '' when missing or not a string. */
function textArg(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** A whole number of at least `min`, or undefined: models send 0 and "" for what they leave unused. */
function countArg(value: unknown, min = 1): number | undefined {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
    const whole = Math.trunc(number);
    return whole >= min ? whole : undefined;
}

function missing(tool: string, argument: string): { error: string } {
    return { error: `Tool "${tool}" requires: ${argument}.` };
}

/** A list argument as strings; a single string counts as a list of one. */
function listArg(value: unknown): string[] {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    return items.map(textArg).filter((item) => item !== '');
}

function isFile(file: unknown): file is TFile {
    return typeof file === 'object' && file !== null && 'extension' in file;
}

function isMarkdown(file: TFile): boolean {
    return file.extension.toLowerCase() === 'md';
}

/** A folder named in an argument, as the vault spells it; null when there is none such. */
function resolveFolder(app: App, input: string): string | null {
    const wanted = normalizeFolderPath(input);
    if (wanted === '' || app.vault.getFolderByPath(wanted)) return wanted;
    const lower = wanted.toLowerCase();
    const match = app.vault.getAllFolders().find((folder) => folder.path.toLowerCase() === lower);
    return match ? match.path : null;
}

const noFolder = (folder: string) => ({ error: `There is no folder "${folder}" in the vault. list_notes with no folder shows what exists.` });

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

function normalizeTag(tag: string): string {
    return tag.trim().replace(/^#/, '').toLowerCase();
}

/** The tags of a note, in the body and in its frontmatter, lower-case and without the `#`. */
function tagsOf(app: App, file: TFile): string[] {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) return [];
    const tags = new Set<string>();
    for (const entry of cache.tags ?? []) tags.add(normalizeTag(entry.tag));
    const front = cache.frontmatter as Record<string, unknown> | undefined;
    for (const key of ['tags', 'tag']) {
        const value = front?.[key];
        const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : [];
        for (const item of items) if (typeof item === 'string' && item.trim() !== '') tags.add(normalizeTag(item));
    }
    return [...tags];
}

/** Whether a note has the tag, or a tag nested under it (`project/alpha` has `project`). */
function hasTag(tags: string[], wanted: string): boolean {
    return tags.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`));
}

// ---------------------------------------------------------------------------
// search_vault_fulltext and note_search_by_topic
// ---------------------------------------------------------------------------

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** How a passage is named in a result. */
function passageFields(hit: SearchHit) {
    return {
        note_id: linkTarget(hit.path),
        title: hit.title,
        ...(hit.heading ? { heading: hit.heading } : {}),
        start_line: hit.startLine,
        end_line: hit.endLine,
        link: wikilink(hit.path, hit.heading),
    };
}

async function searchVaultFulltext(options: VaultToolsOptions, args: Record<string, unknown>): Promise<unknown> {
    const query = textArg(args.query);
    if (query === '') return missing('search_vault_fulltext', 'query');
    const index = options.getIndex();
    if (!index) return { error: INDEX_OFF };
    const folderArg = textArg(args.folder);
    const folder = resolveFolder(options.app, folderArg);
    if (folder === null) return noFolder(folderArg);
    const limit = Math.min(countArg(args.limit) ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

    let response;
    try {
        response = await index.searchDetailed(query, { mode: 'keyword', limit, ...(folder ? { folder } : {}) });
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
    // Every answer says how much of the vault was searched, so a thin result over a
    // partly built index is not read as "the vault has nothing".
    const coverage = response.warnings.join(' ');
    if (response.hits.length === 0) {
        return { matches: [], note: `No indexed passage matched.${coverage ? ` ${coverage}` : ''}` };
    }
    return {
        ...(coverage ? { coverage } : {}),
        matches: response.hits.map((hit) => ({
            ...passageFields(hit),
            score: round(hit.score, 3),
            passage: trimText(hit.text, PASSAGE_CHARS),
        })),
    };
}

async function noteSearchByTopic(options: VaultToolsOptions, args: Record<string, unknown>): Promise<unknown> {
    const topic = textArg(args.topic_query);
    if (topic === '') return missing('note_search_by_topic', 'topic_query');
    const index = options.getIndex();
    if (!index) return { error: INDEX_OFF };
    const folderArg = textArg(args.folder);
    const folder = resolveFolder(options.app, folderArg);
    if (folder === null) return noFolder(folderArg);
    const limit = Math.min(countArg(args.limit) ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const offset = countArg(args.offset, 0) ?? 0;
    const tags = listArg(args.tags_filter).map(normalizeTag);

    // A note is one result: ask for more passages than notes, and for more still when tags filter some out.
    let response;
    try {
        response = await index.searchDetailed(topic, {
            mode: 'hybrid',
            limit: Math.min((offset + limit) * (tags.length > 0 ? 4 : 2), 50),
            ...(folder ? { folder } : {}),
        });
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
    const seen = new Set<string>();
    const notes: SearchHit[] = [];
    for (const hit of response.hits) {
        if (seen.has(hit.path)) continue;
        seen.add(hit.path);
        if (tags.length > 0) {
            const file = options.app.vault.getAbstractFileByPath(hit.path);
            const have = isFile(file) ? tagsOf(options.app, file) : [];
            if (!tags.some((wanted) => hasTag(have, wanted))) continue;
        }
        notes.push(hit);
    }
    return {
        items: notes.slice(offset, offset + limit).map((hit) => ({
            ...passageFields(hit),
            found_by: hit.source,
            score: round(hit.score, 3),
            passage: trimText(hit.text, PASSAGE_CHARS),
        })),
        ...(response.warnings.length > 0 ? { search_note: response.warnings.join(' ') } : {}),
    };
}

// ---------------------------------------------------------------------------
// read_note
// ---------------------------------------------------------------------------

export type Located = { file: TFile; heading: string } | { error: string; did_you_mean?: string[] };

/**
 * The files besides Markdown notes that `read_note` reads, as text: bases and
 * canvases, whose formats Obsidian's skills describe (src/skills). The other
 * tools work on Markdown notes only.
 */
export const TEXT_FILE_EXTENSIONS: readonly string[] = ['base', 'canvas'];

function isTextFile(file: TFile): boolean {
    return TEXT_FILE_EXTENSIONS.includes(file.extension.toLowerCase());
}

/** What a tool answers for a note in an excluded folder: as if it were not there to read. */
export const EXCLUDED_NOTE_ERROR = 'That note is in a folder left out of AlphainO (Settings → Excluded folders), so it cannot be read or changed.';

/**
 * The note a request names: a note id, a path, a bare name, or a wikilink with an optional heading. A note in
 * one of `excluded` (the folders the user left out) is refused, and never suggested. Files with one of the
 * extensions in `also` (`read_note`'s bases and canvases) are found too, named with their extension.
 */
export function locateNote(app: App, request: string, excluded: readonly string[] = [], also: readonly string[] = []): Located {
    const found = locateAnyNote(app, request, excluded, also);
    if ('file' in found && isExcludedPath(found.file.path, excluded)) return { error: EXCLUDED_NOTE_ERROR };
    return found;
}

function locateAnyNote(app: App, request: string, excluded: readonly string[], also: readonly string[]): Located {
    const wanted = (file: TFile) => isMarkdown(file) || also.includes(file.extension.toLowerCase());
    let link = request.trim().replace(/^[`'"]+|[`'"]+$/g, '');
    const wiki = /^\[\[([\s\S]*)\]\]$/.exec(link);
    if (wiki) link = wiki[1];
    link = link.split('|')[0];
    const hash = link.indexOf('#');
    const heading = hash >= 0 ? link.slice(hash + 1).trim() : '';
    const path = (hash >= 0 ? link.slice(0, hash) : link).trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');

    if (path === '') {
        // "[[#Heading]]" points into the open note.
        const active = app.workspace.getActiveFile();
        if (active && isMarkdown(active)) return { file: active, heading };
        return { error: `"${request}" does not name a note.` };
    }

    for (const candidate of /\.md$/i.test(path) ? [path] : [path, `${path}.md`]) {
        const found = app.vault.getAbstractFileByPath(candidate);
        if (!found) continue;
        if (!isFile(found)) return { error: `"${candidate}" is a folder. list_notes with folder="${candidate}" shows what is in it.` };
        if (!wanted(found)) {
            return {
                error: isTextFile(found)
                    ? `"${candidate}" is not a Markdown note: read_note reads it as text, but this tool works on Markdown notes only.`
                    : `"${candidate}" is not a Markdown note, so read_note cannot read it.`,
            };
        }
        return { file: found, heading };
    }
    const resolved = app.metadataCache.getFirstLinkpathDest(path.replace(/\.md$/i, ''), app.workspace.getActiveFile()?.path ?? '');
    if (resolved && wanted(resolved)) return { file: resolved, heading };

    const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '').toLowerCase();
    const bare = also.reduce((stem, extension) => (stem.endsWith(`.${extension}`) ? stem.slice(0, -extension.length - 1) : stem), name);
    const similar = (also.length > 0 ? app.vault.getFiles().filter(wanted) : app.vault.getMarkdownFiles())
        .filter((file) => bare !== '' && file.basename.toLowerCase().includes(bare) && !isExcludedPath(file.path, excluded))
        .sort((a, b) => a.basename.length - b.basename.length)
        .slice(0, MAX_SUGGESTIONS)
        .map((file) => linkTarget(file.path));
    return {
        error: `No note found for "${request}". Use search_vault_fulltext or list_notes to find the right note_id.`,
        ...(similar.length > 0 ? { did_you_mean: similar } : {}),
    };
}

/**
 * The lines of a heading's section: from the heading to the line before the
 * next heading at its level or above. Headings are read from the text, which
 * is what the line numbers refer to, rather than from Obsidian's cache, which
 * may not have caught up with a note that was just edited.
 */
function sectionLines(lines: string[], heading: string): { start: number; end: number } | null {
    const headings = noteHeadings(lines);
    const wanted = headingForLink(heading).toLowerCase();
    const at = headings.findIndex((entry) => headingForLink(entry.heading).toLowerCase() === wanted);
    if (at < 0) return null;
    let end = lines.length;
    for (let i = at + 1; i < headings.length; i += 1) {
        if (headings[i].level <= headings[at].level) {
            end = headings[i].line;
            break;
        }
    }
    return { start: headings[at].line + 1, end };
}

function frontmatterOf(app: App, file: TFile): Record<string, unknown> | null {
    const raw = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!raw) return null;
    // Older versions put the frontmatter's own position among its properties.
    const { position: _position, ...properties } = raw as Record<string, unknown>;
    return Object.keys(properties).length > 0 ? properties : null;
}

async function readNote(options: VaultToolsOptions, args: Record<string, unknown>): Promise<unknown> {
    const { app } = options;
    // `path` is accepted for `note_id`.
    const request = textArg(args.note_id) || textArg(args.path);
    if (request === '') return missing('read_note', 'note_id');
    const located = locateNote(app, request, options.getExcludedFolders?.() ?? [], TEXT_FILE_EXTENSIONS);
    if ('error' in located) return located;
    const { file } = located;
    const heading = textArg(args.heading) || located.heading;

    const lines = splitLines(await app.vault.cachedRead(file));
    // A final line break ends the last line; it does not start another.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;

    let start = countArg(args.start_line);
    let end = countArg(args.end_line);
    let note: string | undefined;
    if (start === undefined && end === undefined && heading) {
        const section = sectionLines(lines, heading);
        if (section) ({ start, end } = section);
        else note = `The note has no heading "${heading}"; this is the note from its first line.`;
    }
    start = start ?? 1;
    end = Math.min(end ?? total, total);
    if (start > total) return { error: `start_line ${start} is past the end of the note, which has ${total} lines.` };
    if (end < start) return { error: `end_line ${end} is before start_line ${start}.` };

    const wanted = lines.slice(start - 1, end);
    let text = wanted.join('\n');
    let last = end;
    let cutMidLine = false;
    if (text.length > MAX_READ_CHARS) {
        let used = 0;
        let count = 0;
        for (const line of wanted) {
            if (count > 0 && used + line.length + 1 > MAX_READ_CHARS) break;
            used += line.length + 1;
            count += 1;
        }
        cutMidLine = count === 1 && wanted[0].length > MAX_READ_CHARS;
        text = cutMidLine ? wanted[0].slice(0, MAX_READ_CHARS) : wanted.slice(0, count).join('\n');
        last = start + count - 1;
    }
    const truncated = last < end || cutMidLine;
    const limit = MAX_READ_CHARS.toLocaleString('en-US');

    return {
        note_id: linkTarget(file.path),
        title: file.basename,
        total_lines: total,
        lines_returned: start === last ? `${start}` : `${start}-${last}`,
        link: wikilink(file.path, heading && !note ? heading : ''),
        frontmatter: frontmatterOf(app, file),
        // A base or a canvas: its text is YAML or JSON (src/skills has their formats).
        ...(isMarkdown(file) ? {} : { file_type: file.extension.toLowerCase() }),
        ...(truncated
            ? {
                  truncated: true,
                  ...(cutMidLine ? {} : { next_start_line: last + 1 }),
                  note: cutMidLine
                      ? `Line ${start} is longer than ${limit} characters: only its start is included.`
                      : `Lines ${last + 1}-${end} were not included (the limit is about ${limit} characters). Call read_note again with start_line: ${last + 1} to read further.`,
              }
            : note
              ? { note }
              : {}),
        text,
    };
}

// ---------------------------------------------------------------------------
// list_notes
// ---------------------------------------------------------------------------

function listNotes(options: VaultToolsOptions, args: Record<string, unknown>): unknown {
    const { app } = options;
    const folderArg = textArg(args.folder);
    const folder = resolveFolder(app, folderArg);
    if (folder === null) return noFolder(folderArg);
    const tag = normalizeTag(textArg(args.tag));
    const limit = Math.min(countArg(args.limit) ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const excluded = options.getExcludedFolders?.() ?? [];
    const files = app.vault
        .getMarkdownFiles()
        .filter((file) => isUnderFolder(file.path, folder) && isIndexablePath(file.path, excluded))
        .filter((file) => tag === '' || hasTag(tagsOf(app, file), tag))
        .sort((a, b) => b.stat.mtime - a.stat.mtime);
    return {
        ...(folder ? { folder } : {}),
        ...(tag ? { tag } : {}),
        total_count: files.length,
        items: files.slice(0, limit).map((file) => ({
            note_id: linkTarget(file.path),
            title: file.basename,
            link: wikilink(file.path),
            date_added: new Date(file.stat.ctime).toISOString(),
            date_modified: new Date(file.stat.mtime).toISOString(),
        })),
    };
}

// ---------------------------------------------------------------------------
// get_active_note
// ---------------------------------------------------------------------------

/** The note view the user is working in. With the chat focused, that is the last one used in the main area. */
function activeMarkdownView(app: App): MarkdownView | null {
    const { workspace } = app;
    const active = workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;
    const leaf = workspace.getMostRecentLeaf(workspace.rootSplit);
    return leaf && leaf.view instanceof MarkdownView ? leaf.view : null;
}

function selectionOf(view: MarkdownView): { text: string; start_line: number; end_line: number; truncated?: true } | null {
    const editor = view.editor;
    if (!editor || view.getMode?.() === 'preview') return null;
    const selected = editor.getSelection();
    if (!selected) return null;
    let first = Infinity;
    let last = 0;
    for (const range of editor.listSelections()) {
        const forward =
            range.anchor.line < range.head.line || (range.anchor.line === range.head.line && range.anchor.ch <= range.head.ch);
        const from = forward ? range.anchor : range.head;
        const to = forward ? range.head : range.anchor;
        if (from.line === to.line && from.ch === to.ch) continue;
        // A selection that ends at the start of a line does not include that line.
        const endLine = to.ch === 0 && to.line > from.line ? to.line : to.line + 1;
        first = Math.min(first, from.line + 1);
        last = Math.max(last, endLine);
    }
    if (!Number.isFinite(first)) return null;
    const cut = selected.length > MAX_READ_CHARS;
    return {
        text: cut ? selected.slice(0, MAX_READ_CHARS) : selected,
        start_line: first,
        end_line: last,
        ...(cut ? { truncated: true as const } : {}),
    };
}

/** The line the cursor is on, counting from 1; undefined when there is no editor to ask. */
function cursorLineOf(view: MarkdownView): number | undefined {
    try {
        return view.editor.getCursor('head').line + 1;
    } catch {
        return undefined;
    }
}

function getActiveNote(options: VaultToolsOptions): unknown {
    const view = activeMarkdownView(options.app);
    const file = view?.file;
    if (!view || !file) return { active: false, message: 'No note is open in the editor.' };
    if (isExcludedPath(file.path, options.getExcludedFolders?.() ?? [])) return { active: false, message: EXCLUDED_NOTE_ERROR };
    const cursor = view.getMode?.() === 'preview' ? undefined : cursorLineOf(view);
    return {
        active: true,
        note_id: linkTarget(file.path),
        title: file.basename,
        link: wikilink(file.path),
        ...(cursor !== undefined ? { cursor_line: cursor } : {}),
        selection: selectionOf(view),
    };
}
