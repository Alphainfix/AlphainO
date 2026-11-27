import type { App, CachedMetadata, MarkdownView as MarkdownViewType } from 'obsidian';
import { MarkdownView } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { quantizeToInt8 } from '@beaver/agent-llm/embeddings';
import type { NoteEmbedder } from '../src/search/embedder';
import { NoteIndex, SearchUnavailableError } from '../src/search/noteIndex';
import { MemoryIndexStore } from '../src/search/store';
import type { IndexStatus, NoteSearcher, SearchHit, SearchOptions, SearchResponse } from '../src/search/types';
import {
    MAX_READ_CHARS,
    VAULT_TOOL_NAMES,
    createVaultToolDispatcher,
    isVaultTool,
    locateNote,
    vaultToolSchemas,
    vaultTools,
    type VaultToolsOptions,
} from '../src/tools/vaultTools';
import { FakeNoteVault } from './obsidianStub';

// The test stub of `obsidian` has no MarkdownView: the tools only ask `instanceof`.
vi.mock('obsidian', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    MarkdownView: class MarkdownView {},
}));

// ---------------------------------------------------------------------------
// A vault, its metadata, and the editor
// ---------------------------------------------------------------------------

const PLAN = [
    '---',
    'status: draft',
    'tags: [work, project/alpha]',
    '---',
    '# Plan',
    '',
    'Intro paragraph about the plan.',
    '',
    '## Risks',
    '',
    'The main risk is time.',
    '',
    '## Budget',
    '',
    'Costs are low.',
].join('\n');

const at = (line: number) => ({ start: { line, col: 0, offset: 0 }, end: { line, col: 0, offset: 0 } });

const PLAN_CACHE: CachedMetadata = {
    frontmatter: { status: 'draft', tags: ['work', 'project/alpha'], position: at(0) } as never,
    headings: [
        { heading: 'Plan', level: 1, position: at(4) },
        { heading: 'Risks', level: 2, position: at(8) },
        { heading: 'Budget', level: 2, position: at(12) },
    ],
    tags: [{ tag: '#inline', position: at(6) }],
};

class FakeEditor {
    selection = '';
    selections: Array<{ anchor: { line: number; ch: number }; head: { line: number; ch: number } }> = [];
    cursor = { line: 0, ch: 0 };
    getSelection() {
        return this.selection;
    }
    listSelections() {
        return this.selections;
    }
    getCursor() {
        return this.cursor;
    }
}

function viewOf(file: { path: string; basename: string } | null, editor = new FakeEditor(), mode: 'source' | 'preview' = 'source'): MarkdownViewType {
    const view = new (MarkdownView as unknown as new () => object)();
    return Object.assign(view, { file, editor, getMode: () => mode }) as unknown as MarkdownViewType;
}

interface Env {
    vault: FakeNoteVault;
    app: App;
    cache: Record<string, CachedMetadata>;
    state: { active: MarkdownViewType | null; recent: MarkdownViewType | null; activeFile: string | null };
}

function environment(notes: Record<string, string> = {}): Env {
    const vault = new FakeNoteVault();
    for (const [path, content] of Object.entries(notes)) vault.write(path, content, { silent: true });
    const cache: Record<string, CachedMetadata> = {};
    const state: Env['state'] = { active: null, recent: null, activeFile: null };
    const metadataCache = {
        getFileCache: (file: { path: string }) => cache[file.path] ?? null,
        getFirstLinkpathDest: (link: string) => {
            const wanted = link.toLowerCase();
            const found = vault
                .getMarkdownFiles()
                .filter((file) => file.basename.toLowerCase() === wanted || file.path.toLowerCase() === `${wanted}.md`)
                .sort((a, b) => a.path.length - b.path.length);
            return found[0] ?? null;
        },
    };
    const workspace = {
        rootSplit: {},
        getActiveViewOfType: () => state.active,
        getMostRecentLeaf: () => (state.recent ? { view: state.recent } : null),
        getActiveFile: () => (state.activeFile ? vault.getAbstractFileByPath(state.activeFile) : null),
    };
    return { vault, cache, state, app: { vault, metadataCache, workspace } as unknown as App };
}

let env: Env;
let excluded: string[];
let index: NoteSearcher | null;

function tools(extra: Partial<VaultToolsOptions> = {}) {
    return createVaultToolDispatcher({ app: env.app, getIndex: () => index, getExcludedFolders: () => excluded, ...extra });
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return tools()(name, args, { toolCallId: 'call-1' });
}

beforeEach(() => {
    env = environment({
        'Projects/Plan.md': PLAN,
        'Projects/Alpha/Notes.md': '# Notes\n\nAlpha notes.',
        'Inbox/Idea.md': 'A quick idea.\n',
        'Private/Diary.md': 'Dear diary.',
        'image.png': 'binary',
    });
    env.cache['Projects/Plan.md'] = PLAN_CACHE;
    excluded = [];
    index = null;
});

// ---------------------------------------------------------------------------
// A searcher that records what it was asked
// ---------------------------------------------------------------------------

function hit(path: string, extra: Partial<SearchHit> = {}): SearchHit {
    return {
        path,
        title: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
        heading: '',
        headingPath: [],
        startLine: 1,
        endLine: 2,
        text: `Passage of ${path}.`,
        score: 0.5,
        source: 'keyword',
        ...extra,
    };
}

function stubSearcher(response: Partial<SearchResponse> = {}, status: Partial<IndexStatus> = {}) {
    const asked: Array<{ query: string; options: SearchOptions | undefined }> = [];
    const searcher: NoteSearcher & { response: SearchResponse; failure: Error | null } = {
        response: { hits: [], mode: 'keyword', warnings: [], ...response },
        failure: null,
        async searchDetailed(query, options) {
            asked.push({ query, options });
            if (this.failure) throw this.failure;
            return this.response;
        },
        status: () => ({
            state: 'idle',
            model: null,
            notesIndexed: 1,
            notesTotal: 1,
            chunks: 1,
            pending: 0,
            lastError: null,
            retryAt: null,
            ...status,
        }),
    };
    return { searcher, asked };
}

// ---------------------------------------------------------------------------
// Schemas and wiring
// ---------------------------------------------------------------------------

describe('the tool set', () => {
    it('is five tools, named as AlphainZ’s are, each with a description and a JSON schema', () => {
        const schemas = vaultToolSchemas();
        expect(schemas.map((tool) => tool.name)).toEqual([
            'search_vault_fulltext',
            'note_search_by_topic',
            'read_note',
            'list_notes',
            'get_active_note',
        ]);
        expect(schemas.map((tool) => tool.name)).toEqual([...VAULT_TOOL_NAMES]);
        for (const tool of schemas) {
            expect(tool.description.length).toBeGreaterThan(40);
            expect(tool.parameters.type).toBe('object');
            expect(/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)).toBe(true);
        }
        const required = Object.fromEntries(schemas.map((tool) => [tool.name, tool.parameters.required]));
        expect(required).toEqual({
            search_vault_fulltext: ['query'],
            note_search_by_topic: ['topic_query'],
            read_note: ['note_id'],
            list_notes: [],
            get_active_note: [],
        });
        expect(Object.keys(schemas[0].parameters.properties)).toEqual(['query', 'limit', 'folder']);
        expect(Object.keys(schemas[1].parameters.properties)).toEqual(['topic_query', 'tags_filter', 'folder', 'limit', 'offset']);
        expect(Object.keys(schemas[2].parameters.properties)).toEqual(['note_id', 'heading', 'start_line', 'end_line']);
        expect(Object.keys(schemas[3].parameters.properties)).toEqual(['folder', 'tag', 'limit']);
    });

    it('tells the model to cite notes with the link a result carries', () => {
        for (const tool of vaultToolSchemas()) {
            if (tool.name === 'list_notes') continue;
            expect(tool.description).toContain('link');
        }
    });

    it('leaves out the searches that cannot run', () => {
        expect(vaultToolSchemas({ search: false }).map((tool) => tool.name)).toEqual(['read_note', 'list_notes', 'get_active_note']);
        const noModel = vaultToolSchemas({ semantic: false });
        expect(noModel.map((tool) => tool.name)).toEqual(['search_vault_fulltext', 'read_note', 'list_notes', 'get_active_note']);
        for (const tool of noModel) expect(tool.description).not.toContain('note_search_by_topic');
        expect(vaultToolSchemas()[0].description).toContain('note_search_by_topic');
        expect(vaultToolSchemas({ search: false })[1].description).not.toContain('search_vault_fulltext');
    });

    it('offers what the note index can do right now', () => {
        const wired = vaultTools({ app: env.app, getIndex: () => index });
        expect(wired.schemas().map((tool) => tool.name)).toEqual(['read_note', 'list_notes', 'get_active_note']);
        index = stubSearcher({}, { model: null }).searcher;
        expect(wired.schemas().map((tool) => tool.name)).toEqual(['search_vault_fulltext', 'read_note', 'list_notes', 'get_active_note']);
        index = stubSearcher({}, { model: 'm-int8-512' }).searcher;
        expect(wired.schemas().map((tool) => tool.name)).toEqual([...VAULT_TOOL_NAMES]);
    });

    it('knows its own tools', () => {
        const wired = vaultTools({ app: env.app, getIndex: () => null });
        expect(wired.owns('read_note')).toBe(true);
        expect(wired.owns('zotero_read_note')).toBe(false);
        expect(isVaultTool('note_search_by_topic')).toBe(true);
        expect(isVaultTool('search_notes')).toBe(false);
    });

    it('returns an error, not an exception, for an unknown tool or a failure inside one', async () => {
        expect(await call('nope')).toEqual({ error: expect.stringContaining('Unknown tool "nope"') });
        env.vault.cachedRead = async () => {
            throw new Error('disk gone');
        };
        expect(await call('read_note', { note_id: 'Projects/Plan' })).toEqual({ error: 'disk gone' });
    });
});

// ---------------------------------------------------------------------------
// read_note
// ---------------------------------------------------------------------------

describe('read_note', () => {
    it('reads a whole note, with its properties, and a link to cite it by', async () => {
        const result = await call('read_note', { note_id: 'Projects/Plan' });
        expect(result).toEqual({
            note_id: 'Projects/Plan',
            title: 'Plan',
            total_lines: 15,
            lines_returned: '1-15',
            link: '[[Projects/Plan]]',
            frontmatter: { status: 'draft', tags: ['work', 'project/alpha'] },
            text: PLAN,
        });
    });

    it('takes the note by id, path, bare name or link, and the old `path` argument', async () => {
        for (const note_id of ['Projects/Plan', 'Projects/Plan.md', 'Plan', 'plan', '[[Projects/Plan]]', '[[Plan|the plan]]', ' "Plan" ']) {
            const result = await call('read_note', { note_id });
            expect(result.note_id, note_id).toBe('Projects/Plan');
        }
        expect((await call('read_note', { path: 'Projects/Plan.md' })).note_id).toBe('Projects/Plan');
    });

    it('reads a range of lines, counted from 1', async () => {
        const result = await call('read_note', { note_id: 'Plan', start_line: 9, end_line: 11 });
        expect(result.text).toBe('## Risks\n\nThe main risk is time.');
        expect(result.lines_returned).toBe('9-11');
        expect(result.total_lines).toBe(15);
        expect((await call('read_note', { note_id: 'Plan', start_line: 13 })).text).toBe('## Budget\n\nCosts are low.');
        expect((await call('read_note', { note_id: 'Plan', end_line: 2 })).text).toBe('---\nstatus: draft');
        expect((await call('read_note', { note_id: 'Plan', start_line: 15, end_line: 99 })).lines_returned).toBe('15');
    });

    it('reads one section, by the heading argument or by a link with a heading', async () => {
        const risks = await call('read_note', { note_id: 'Projects/Plan', heading: 'Risks' });
        expect(risks.text).toBe('## Risks\n\nThe main risk is time.\n');
        expect(risks.lines_returned).toBe('9-12');
        expect(risks.link).toBe('[[Projects/Plan#Risks]]');
        expect((await call('read_note', { note_id: '[[Plan#Budget]]' })).text).toBe('## Budget\n\nCosts are low.');
        expect((await call('read_note', { note_id: 'Plan', heading: 'plan' })).lines_returned).toBe('5-15');
        // Lines asked for win over a heading.
        expect((await call('read_note', { note_id: 'Plan', heading: 'Risks', start_line: 15 })).text).toBe('Costs are low.');
    });

    it('says when the heading is not there, and returns the note', async () => {
        const result = await call('read_note', { note_id: 'Plan', heading: 'Nowhere' });
        expect(result.note).toContain('no heading "Nowhere"');
        expect(result.lines_returned).toBe('1-15');
        expect(result.link).toBe('[[Projects/Plan]]');
    });

    it('treats empty values as not given', async () => {
        const result = await call('read_note', { note_id: 'Plan', heading: '', start_line: 0, end_line: '' });
        expect(result.lines_returned).toBe('1-15');
        expect((await call('read_note', { note_id: 'Plan', start_line: '9', end_line: '10' })).lines_returned).toBe('9-10');
    });

    it('does not count the final line break as a line', async () => {
        const result = await call('read_note', { note_id: 'Inbox/Idea' });
        expect(result).toMatchObject({ total_lines: 1, lines_returned: '1', text: 'A quick idea.' });
    });

    it('reads a link to a heading in the open note', async () => {
        env.state.activeFile = 'Projects/Plan.md';
        expect((await call('read_note', { note_id: '[[#Risks]]' })).lines_returned).toBe('9-12');
        env.state.activeFile = null;
        expect(await call('read_note', { note_id: '[[#Risks]]' })).toEqual({ error: expect.stringContaining('does not name a note') });
    });

    it('is a note with no properties when it has none', async () => {
        expect((await call('read_note', { note_id: 'Inbox/Idea' })).frontmatter).toBeNull();
    });

    it('says what is wrong with a request, and what may have been meant', async () => {
        expect(await call('read_note', {})).toEqual({ error: 'Tool "read_note" requires: note_id.' });
        expect(await call('read_note', { note_id: '   ' })).toEqual({ error: 'Tool "read_note" requires: note_id.' });
        expect(await call('read_note', { note_id: 'Projects/Pla' })).toEqual({
            error: expect.stringContaining('No note found for "Projects/Pla"'),
            did_you_mean: ['Projects/Plan'],
        });
        expect(await call('read_note', { note_id: 'Nothing like it' })).toEqual({ error: expect.stringContaining('No note found') });
        expect(await call('read_note', { note_id: 'Projects' })).toEqual({ error: expect.stringContaining('is a folder') });
        expect(await call('read_note', { note_id: 'image.png' })).toEqual({ error: expect.stringContaining('not a Markdown note') });
        expect(await call('read_note', { note_id: 'Plan', start_line: 16 })).toEqual({ error: expect.stringContaining('past the end of the note, which has 15 lines') });
        expect(await call('read_note', { note_id: 'Plan', start_line: 9, end_line: 5 })).toEqual({ error: expect.stringContaining('before start_line 9') });
    });

    it('cuts a long note at a line, says where, and carries on from there', async () => {
        const lines = Array.from({ length: 3000 }, (_, i) => `Line ${i + 1} of a very long note, with some words in it.`);
        env.vault.write('Long.md', lines.join('\n'), { silent: true });
        const first = await call('read_note', { note_id: 'Long' });
        expect(first.truncated).toBe(true);
        expect(first.text.length).toBeLessThanOrEqual(MAX_READ_CHARS);
        expect(first.total_lines).toBe(3000);
        const shown = Number(first.lines_returned.split('-')[1]);
        expect(first.next_start_line).toBe(shown + 1);
        expect(first.text.split('\n')).toHaveLength(shown);
        expect(first.note).toContain(`Call read_note again with start_line: ${shown + 1}`);

        let text = first.text as string;
        let next = first.next_start_line as number | undefined;
        while (next) {
            const more = await call('read_note', { note_id: 'Long', start_line: next });
            text += `\n${more.text}`;
            next = more.next_start_line;
        }
        expect(text).toBe(lines.join('\n'));
    });

    it('cuts a single line that is longer than the limit, and says so', async () => {
        env.vault.write('Wide.md', `${'x'.repeat(MAX_READ_CHARS + 500)}\nnext line`, { silent: true });
        const result = await call('read_note', { note_id: 'Wide' });
        expect(result.text).toHaveLength(MAX_READ_CHARS);
        expect(result.truncated).toBe(true);
        expect(result.next_start_line).toBeUndefined();
        expect(result.note).toContain('only its start is included');
    });
});

describe('locateNote', () => {
    it('resolves a note id, path, name or link the way read_note does, with the heading a link names', () => {
        const plan = env.vault.files.get('Projects/Plan.md')!.file;
        for (const request of ['Projects/Plan', 'Projects/Plan.md', 'Plan', '[[Projects/Plan|the plan]]']) {
            expect(locateNote(env.app, request), request).toEqual({ file: plan, heading: '' });
        }
        expect(locateNote(env.app, '[[Plan#Risks]]')).toEqual({ file: plan, heading: 'Risks' });
    });

    it('says what is wrong with a request that names no note', () => {
        expect(locateNote(env.app, 'Projects/Pla')).toEqual({
            error: expect.stringContaining('No note found'),
            did_you_mean: ['Projects/Plan'],
        });
        expect(locateNote(env.app, 'Projects')).toEqual({ error: expect.stringContaining('is a folder') });
        expect(locateNote(env.app, 'image.png')).toEqual({ error: expect.stringContaining('not a Markdown note') });
    });
});

// ---------------------------------------------------------------------------
// list_notes
// ---------------------------------------------------------------------------

describe('list_notes', () => {
    it('lists the most recently modified notes first, with a link and dates', async () => {
        env.vault.touch('Projects/Plan.md');
        const result = await call('list_notes');
        expect(result.total_count).toBe(4);
        expect(result.items.map((item: any) => item.note_id)).toEqual(['Projects/Plan', 'Private/Diary', 'Inbox/Idea', 'Projects/Alpha/Notes']);
        const file = env.vault.files.get('Projects/Plan.md')!.file;
        expect(result.items[0]).toEqual({
            note_id: 'Projects/Plan',
            title: 'Plan',
            link: '[[Projects/Plan]]',
            date_added: new Date(file.stat.ctime).toISOString(),
            date_modified: new Date(file.stat.mtime).toISOString(),
        });
        expect(result.folder).toBeUndefined();
        expect(result.tag).toBeUndefined();
    });

    it('lists a folder with its subfolders, whatever the case of its name', async () => {
        const result = await call('list_notes', { folder: 'projects' });
        expect(result).toMatchObject({ folder: 'Projects', total_count: 2 });
        expect(result.items.map((item: any) => item.note_id).sort()).toEqual(['Projects/Alpha/Notes', 'Projects/Plan']);
        expect((await call('list_notes', { folder: '/Projects/Alpha/' })).total_count).toBe(1);
    });

    it('lists the notes under a tag, in their text or their properties, nested tags included', async () => {
        env.cache['Inbox/Idea.md'] = { tags: [{ tag: '#Project/Beta', position: at(0) }] };
        env.cache['Private/Diary.md'] = { frontmatter: { tag: 'personal, private' } as never };
        const ids = async (tag: string) => (await call('list_notes', { tag })).items.map((item: any) => item.note_id).sort();
        expect(await ids('work')).toEqual(['Projects/Plan']);
        expect(await ids('#inline')).toEqual(['Projects/Plan']);
        expect(await ids('project')).toEqual(['Inbox/Idea', 'Projects/Plan']);
        expect(await ids('#Project/Alpha')).toEqual(['Projects/Plan']);
        expect(await ids('private')).toEqual(['Private/Diary']);
        expect(await ids('nothing')).toEqual([]);
        expect(await call('list_notes', { tag: '#Work' })).toMatchObject({ tag: 'work', total_count: 1 });
    });

    it('combines a folder and a tag', async () => {
        env.cache['Projects/Alpha/Notes.md'] = { tags: [{ tag: '#work', position: at(0) }] };
        const result = await call('list_notes', { folder: 'Projects/Alpha', tag: 'work' });
        expect(result.items.map((item: any) => item.note_id)).toEqual(['Projects/Alpha/Notes']);
    });

    it('is limited to what was asked, 25 by default and 100 at most', async () => {
        for (let i = 0; i < 130; i += 1) env.vault.write(`Many/n${i}.md`, `Note ${i}`, { silent: true });
        expect((await call('list_notes', { folder: 'Many' })).items).toHaveLength(25);
        expect((await call('list_notes', { folder: 'Many', limit: 3 })).items).toHaveLength(3);
        expect((await call('list_notes', { folder: 'Many', limit: 1000 })).items).toHaveLength(100);
        expect((await call('list_notes', { folder: 'Many', limit: 0 })).items).toHaveLength(25);
        expect(await call('list_notes', { folder: 'Many', limit: 5 })).toMatchObject({ total_count: 130 });
    });

    it('leaves out the folders the user excluded, and treats empty values as not given', async () => {
        excluded = ['Private'];
        const result = await call('list_notes', { folder: '', tag: '', limit: 0 });
        expect(result.items.map((item: any) => item.note_id)).not.toContain('Private/Diary');
        expect(result.total_count).toBe(3);
    });

    it('says when a folder does not exist', async () => {
        expect(await call('list_notes', { folder: 'Nowhere' })).toEqual({ error: expect.stringContaining('no folder "Nowhere"') });
    });
});

// ---------------------------------------------------------------------------
// get_active_note
// ---------------------------------------------------------------------------

describe('get_active_note', () => {
    const plan = () => env.vault.files.get('Projects/Plan.md')!.file;

    it('says when no note is open', async () => {
        expect(await call('get_active_note')).toEqual({ active: false, message: 'No note is open in the editor.' });
    });

    it('gives the note, the line of the cursor, and what is selected, with its lines', async () => {
        const editor = new FakeEditor();
        editor.selection = 'The main risk is time.';
        editor.selections = [{ anchor: { line: 10, ch: 0 }, head: { line: 10, ch: 22 } }];
        editor.cursor = { line: 10, ch: 22 };
        env.state.active = viewOf(plan(), editor);
        expect(await call('get_active_note')).toEqual({
            active: true,
            note_id: 'Projects/Plan',
            title: 'Plan',
            link: '[[Projects/Plan]]',
            cursor_line: 11,
            selection: { text: 'The main risk is time.', start_line: 11, end_line: 11 },
        });
    });

    it('has no selection when nothing is selected', async () => {
        const editor = new FakeEditor();
        editor.cursor = { line: 4, ch: 2 };
        env.state.active = viewOf(plan(), editor);
        const result = await call('get_active_note');
        expect(result.selection).toBeNull();
        expect(result.cursor_line).toBe(5);
    });

    it('counts a selection made backwards, and one that ends at the start of a line', async () => {
        const editor = new FakeEditor();
        editor.selection = 'a\nb';
        editor.selections = [{ anchor: { line: 8, ch: 0 }, head: { line: 6, ch: 3 } }];
        env.state.active = viewOf(plan(), editor);
        expect((await call('get_active_note')).selection).toMatchObject({ start_line: 7, end_line: 8 });
        editor.selections = [{ anchor: { line: 6, ch: 0 }, head: { line: 8, ch: 0 } }];
        expect((await call('get_active_note')).selection).toMatchObject({ start_line: 7, end_line: 8 });
    });

    it('spans several selections', async () => {
        const editor = new FakeEditor();
        editor.selection = 'x\ny';
        editor.selections = [
            { anchor: { line: 2, ch: 0 }, head: { line: 2, ch: 4 } },
            { anchor: { line: 9, ch: 1 }, head: { line: 9, ch: 5 } },
            { anchor: { line: 5, ch: 3 }, head: { line: 5, ch: 3 } },
        ];
        env.state.active = viewOf(plan(), editor);
        expect((await call('get_active_note')).selection).toMatchObject({ start_line: 3, end_line: 10 });
    });

    it('finds the note being read when the chat has the focus', async () => {
        const editor = new FakeEditor();
        editor.selection = 'Costs are low.';
        editor.selections = [{ anchor: { line: 14, ch: 0 }, head: { line: 14, ch: 14 } }];
        env.state.active = null;
        env.state.recent = viewOf(plan(), editor);
        expect(await call('get_active_note')).toMatchObject({ active: true, note_id: 'Projects/Plan', selection: { start_line: 15, end_line: 15 } });
    });

    it('is no note when the last view used is not a note', async () => {
        env.state.recent = { file: plan() } as unknown as MarkdownViewType;
        expect(await call('get_active_note')).toMatchObject({ active: false });
        env.state.recent = viewOf(null);
        expect(await call('get_active_note')).toMatchObject({ active: false });
    });

    it('has no cursor or selection in reading view', async () => {
        const editor = new FakeEditor();
        editor.selection = 'stale';
        editor.selections = [{ anchor: { line: 1, ch: 0 }, head: { line: 1, ch: 5 } }];
        env.state.active = viewOf(plan(), editor, 'preview');
        const result = await call('get_active_note');
        expect(result).toMatchObject({ active: true, note_id: 'Projects/Plan', selection: null });
        expect(result.cursor_line).toBeUndefined();
    });

    it('cuts a selection that is longer than a note may be read', async () => {
        const editor = new FakeEditor();
        editor.selection = 'y'.repeat(MAX_READ_CHARS + 10);
        editor.selections = [{ anchor: { line: 0, ch: 0 }, head: { line: 3000, ch: 0 } }];
        env.state.active = viewOf(plan(), editor);
        const { selection } = await call('get_active_note');
        expect(selection.text).toHaveLength(MAX_READ_CHARS);
        expect(selection.truncated).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// search_vault_fulltext
// ---------------------------------------------------------------------------

describe('search_vault_fulltext', () => {
    it('searches by keyword, 8 passages by default, and asks nothing of a folder it is not given', async () => {
        const { searcher, asked } = stubSearcher();
        index = searcher;
        await call('search_vault_fulltext', { query: 'bees' });
        expect(asked).toEqual([{ query: 'bees', options: { mode: 'keyword', limit: 8 } }]);
    });

    it('limits the number of passages and keeps to a folder, in the vault’s spelling', async () => {
        const { searcher, asked } = stubSearcher();
        index = searcher;
        await call('search_vault_fulltext', { query: 'q', limit: 3, folder: 'projects/alpha' });
        await call('search_vault_fulltext', { query: 'q', limit: 500 });
        await call('search_vault_fulltext', { query: 'q', limit: 0, folder: '' });
        expect(asked.map((entry) => entry.options)).toEqual([
            { mode: 'keyword', limit: 3, folder: 'Projects/Alpha' },
            { mode: 'keyword', limit: 25 },
            { mode: 'keyword', limit: 8 },
        ]);
    });

    it('returns matches that name the note, the heading and lines, a link to cite, and the passage', async () => {
        const long = 'word '.repeat(300);
        const { searcher } = stubSearcher({
            hits: [
                hit('Projects/Plan.md', { heading: 'Risks', headingPath: ['Plan', 'Risks'], startLine: 11, endLine: 11, score: 3.14159, text: 'The main risk is time.' }),
                hit('Inbox/Idea.md', { text: long }),
                hit('Projects/Alpha/Notes.md', { heading: 'Pros: cons | more' }),
            ],
        });
        index = searcher;
        const result = await call('search_vault_fulltext', { query: 'risk' });
        expect(result.coverage).toBeUndefined();
        expect(result.matches).toHaveLength(3);
        expect(result.matches[0]).toEqual({
            note_id: 'Projects/Plan',
            title: 'Plan',
            heading: 'Risks',
            start_line: 11,
            end_line: 11,
            link: '[[Projects/Plan#Risks]]',
            score: 3.142,
            passage: 'The main risk is time.',
        });
        expect(result.matches[1]).not.toHaveProperty('heading');
        expect(result.matches[1].link).toBe('[[Inbox/Idea]]');
        expect(result.matches[1].passage.length).toBeLessThanOrEqual(702);
        expect(result.matches[1].passage.endsWith(' …')).toBe(true);
        expect(result.matches[2].link).toBe('[[Projects/Alpha/Notes#Pros cons more]]');
    });

    it('says nothing matched, and how much of the vault was searched', async () => {
        const { searcher } = stubSearcher();
        index = searcher;
        expect(await call('search_vault_fulltext', { query: 'zzz' })).toEqual({ matches: [], note: 'No indexed passage matched.' });
        searcher.response = { hits: [], mode: 'keyword', warnings: ['3 of 10 notes are not indexed yet, so results may leave them out.'] };
        expect(await call('search_vault_fulltext', { query: 'zzz' })).toEqual({
            matches: [],
            note: 'No indexed passage matched. 3 of 10 notes are not indexed yet, so results may leave them out.',
        });
        searcher.response = { hits: [hit('Inbox/Idea.md')], mode: 'keyword', warnings: ['3 of 10 notes are not indexed yet, so results may leave them out.'] };
        expect(await call('search_vault_fulltext', { query: 'idea' })).toMatchObject({
            coverage: '3 of 10 notes are not indexed yet, so results may leave them out.',
            matches: [expect.objectContaining({ note_id: 'Inbox/Idea' })],
        });
    });

    it('returns an error for a missing query, an index that is off, a folder that is not there, and a search that fails', async () => {
        const { searcher } = stubSearcher();
        index = searcher;
        expect(await call('search_vault_fulltext', {})).toEqual({ error: 'Tool "search_vault_fulltext" requires: query.' });
        expect(await call('search_vault_fulltext', { query: '  ' })).toEqual({ error: 'Tool "search_vault_fulltext" requires: query.' });
        expect(await call('search_vault_fulltext', { query: 'x', folder: 'Nowhere' })).toEqual({ error: expect.stringContaining('no folder "Nowhere"') });
        searcher.failure = new SearchUnavailableError('Note search is off.');
        expect(await call('search_vault_fulltext', { query: 'x' })).toEqual({ error: 'Note search is off.' });
        index = null;
        expect(await call('search_vault_fulltext', { query: 'x' })).toEqual({ error: expect.stringContaining('turned off') });
    });
});

// ---------------------------------------------------------------------------
// note_search_by_topic
// ---------------------------------------------------------------------------

describe('note_search_by_topic', () => {
    it('searches by meaning and keywords together, and asks for more passages than notes', async () => {
        const { searcher, asked } = stubSearcher({}, { model: 'm-int8-512' });
        index = searcher;
        await call('note_search_by_topic', { topic_query: 'risk of delay' });
        await call('note_search_by_topic', { topic_query: 'risk', limit: 5, offset: 10, folder: 'inbox' });
        await call('note_search_by_topic', { topic_query: 'risk', limit: 25, offset: 25 });
        expect(asked.map((entry) => [entry.query, entry.options])).toEqual([
            ['risk of delay', { mode: 'hybrid', limit: 16 }],
            ['risk', { mode: 'hybrid', limit: 30, folder: 'Inbox' }],
            ['risk', { mode: 'hybrid', limit: 50 }],
        ]);
    });

    it('returns each note once, with its best passage, a link, and how it was found', async () => {
        const { searcher } = stubSearcher({
            hits: [
                hit('Projects/Plan.md', { heading: 'Risks', startLine: 11, endLine: 11, source: 'both', score: 0.98765, text: 'The main risk is time.' }),
                hit('Projects/Plan.md', { heading: 'Budget', source: 'semantic', score: 0.7 }),
                hit('Inbox/Idea.md', { source: 'keyword', score: 0.4 }),
            ],
            mode: 'hybrid',
        }, { model: 'm' });
        index = searcher;
        const result = await call('note_search_by_topic', { topic_query: 'risk' });
        expect(result.search_note).toBeUndefined();
        expect(result.items).toEqual([
            {
                note_id: 'Projects/Plan',
                title: 'Plan',
                heading: 'Risks',
                start_line: 11,
                end_line: 11,
                link: '[[Projects/Plan#Risks]]',
                found_by: 'both',
                score: 0.988,
                passage: 'The main risk is time.',
            },
            expect.objectContaining({ note_id: 'Inbox/Idea', found_by: 'keyword', link: '[[Inbox/Idea]]' }),
        ]);
    });

    it('pages through the notes', async () => {
        const hits = Array.from({ length: 6 }, (_, i) => hit(`Many/n${i}.md`));
        const { searcher } = stubSearcher({ hits, mode: 'hybrid' }, { model: 'm' });
        index = searcher;
        const ids = async (args: Record<string, unknown>) => (await call('note_search_by_topic', { topic_query: 'x', ...args })).items.map((item: any) => item.note_id);
        expect(await ids({ limit: 2 })).toEqual(['Many/n0', 'Many/n1']);
        expect(await ids({ limit: 2, offset: 2 })).toEqual(['Many/n2', 'Many/n3']);
        expect(await ids({ limit: 5, offset: 4 })).toEqual(['Many/n4', 'Many/n5']);
        expect(await ids({ limit: 0, offset: 0 })).toHaveLength(6);
    });

    it('keeps the notes that have any of the tags', async () => {
        env.cache['Inbox/Idea.md'] = { tags: [{ tag: '#Project/Beta', position: at(0) }] };
        const { searcher, asked } = stubSearcher({
            hits: [hit('Projects/Plan.md'), hit('Inbox/Idea.md'), hit('Private/Diary.md')],
            mode: 'hybrid',
        }, { model: 'm' });
        index = searcher;
        const ids = async (tags: unknown) => (await call('note_search_by_topic', { topic_query: 'x', tags_filter: tags })).items.map((item: any) => item.note_id);
        expect(await ids(['work'])).toEqual(['Projects/Plan']);
        expect(await ids(['#project'])).toEqual(['Projects/Plan', 'Inbox/Idea']);
        expect(await ids('PROJECT/beta')).toEqual(['Inbox/Idea']);
        expect(await ids(['nothing', 'inline'])).toEqual(['Projects/Plan']);
        expect(await ids([])).toHaveLength(3);
        // More is asked for when tags will take some away.
        expect(asked[0].options?.limit).toBe(32);
        expect(asked[asked.length - 1].options?.limit).toBe(16);
    });

    it('says how the results were found when that is not by meaning', async () => {
        const { searcher } = stubSearcher({
            hits: [hit('Inbox/Idea.md')],
            mode: 'keyword',
            warnings: ['No embedding model is set up, so notes cannot be searched by meaning. Only keywords were matched.'],
        }, { model: null });
        index = searcher;
        const result = await call('note_search_by_topic', { topic_query: 'idea' });
        expect(result.search_note).toContain('Only keywords were matched');
        expect(result.items).toHaveLength(1);
    });

    it('returns an error for a missing topic, an index that is off, a missing folder, and a search that fails', async () => {
        const { searcher } = stubSearcher({}, { model: 'm' });
        index = searcher;
        expect(await call('note_search_by_topic', {})).toEqual({ error: 'Tool "note_search_by_topic" requires: topic_query.' });
        expect(await call('note_search_by_topic', { topic_query: 'x', folder: 'Nowhere' })).toEqual({ error: expect.stringContaining('no folder') });
        searcher.failure = new Error('boom');
        expect(await call('note_search_by_topic', { topic_query: 'x' })).toEqual({ error: 'boom' });
        index = null;
        expect(await call('note_search_by_topic', { topic_query: 'x' })).toEqual({ error: expect.stringContaining('turned off') });
    });
});

// ---------------------------------------------------------------------------
// With the real note index
// ---------------------------------------------------------------------------

/** A model that embeds a text as the counts of its words. */
const smallModel: NoteEmbedder = {
    modelId: 'tiny-int8-128',
    label: 'Tiny',
    dimensions: 128,
    async embedDocuments(texts) {
        return texts.map((text) => smallVector(text));
    },
    async embedQuery(text) {
        return smallVector(text);
    },
};

function smallVector(text: string): Int8Array {
    const values = new Array<number>(128).fill(0);
    for (const word of text.toLowerCase().split(/[^a-z0-9一-鿿]+/)) {
        if (word === '') continue;
        let hash = 7;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        values[hash % 128] += 1;
    }
    return Int8Array.from(quantizeToInt8(values));
}

describe('with the real note index', () => {
    async function realIndex(embedder: NoteEmbedder | null) {
        const made = environment({
            'Bees.md': '# Bees\n\nHoney bees collect nectar.\n\n## Winter\n\nIn winter the colony will cluster around the queen.\n',
            'Cats.md': '# Cats\n\nCats sleep most of the day. The winter is cold for cats.\n',
            '机器学习.md': '# 机器学习\n\n机器学习是人工智能的一个分支。\n',
        });
        const noteIndex = new NoteIndex({
            app: made.app,
            store: new MemoryIndexStore(),
            embedder,
            debounceMs: 5,
            log: () => {},
        });
        await noteIndex.start();
        await noteIndex.whenIdle();
        env = made;
        index = noteIndex;
        return noteIndex;
    }

    it('finds a passage by keyword and reads it back by the note_id and lines it gave', async () => {
        const noteIndex = await realIndex(null);
        const found = await call('search_vault_fulltext', { query: 'queen' });
        expect(found.matches).toHaveLength(1);
        const [match] = found.matches;
        expect(match).toMatchObject({ note_id: 'Bees', title: 'Bees', heading: 'Winter', link: '[[Bees#Winter]]', start_line: 7, end_line: 7 });
        expect(match.passage).toContain('cluster around the queen');
        const read = await call('read_note', { note_id: match.note_id, start_line: match.start_line, end_line: match.end_line });
        expect(read.text).toBe('In winter the colony will cluster around the queen.');
        expect((await call('read_note', { note_id: match.link })).lines_returned).toBe('5-7');
        await noteIndex.stop();
    });

    it('finds an exact phrase, and not the same words apart', async () => {
        const noteIndex = await realIndex(null);
        const apartPhrase = await call('search_vault_fulltext', { query: '"the colony winter"' });
        expect(apartPhrase.matches).toEqual([]);
        const exact = await call('search_vault_fulltext', { query: '"In Winter the colony"' });
        expect(exact.matches.map((m: any) => m.note_id)).toEqual(['Bees']);
        const apart = await call('search_vault_fulltext', { query: 'winter cats' });
        expect(apart.matches.map((m: any) => m.note_id)).toContain('Cats');
        const both = await call('search_vault_fulltext', { query: 'cold "winter is"' });
        expect(both.matches.map((m: any) => m.note_id)).toEqual(['Cats']);
        await noteIndex.stop();
    });

    it('finds Chinese text', async () => {
        const noteIndex = await realIndex(null);
        const found = await call('search_vault_fulltext', { query: '人工智能' });
        expect(found.matches[0]).toMatchObject({ note_id: '机器学习', link: '[[机器学习#机器学习]]' });
        await noteIndex.stop();
    });

    it('searches by topic with a model, each note once', async () => {
        const noteIndex = await realIndex(smallModel);
        const wired = vaultTools({ app: env.app, getIndex: () => index });
        expect(wired.schemas().map((tool) => tool.name)).toContain('note_search_by_topic');
        const found = await call('note_search_by_topic', { topic_query: 'cold winter for cats' });
        const ids = found.items.map((item: any) => item.note_id);
        expect(ids[0]).toBe('Cats');
        expect(new Set(ids).size).toBe(ids.length);
        expect(found.items[0]).toMatchObject({ link: '[[Cats#Cats]]', found_by: expect.stringMatching(/semantic|both/) });
        await noteIndex.stop();
    });

    it('with no model offers no topic search, and falls back to keywords if asked', async () => {
        const noteIndex = await realIndex(null);
        const wired = vaultTools({ app: env.app, getIndex: () => index });
        expect(wired.schemas().map((tool) => tool.name)).not.toContain('note_search_by_topic');
        const found = await call('note_search_by_topic', { topic_query: 'queen' });
        expect(found.items[0]).toMatchObject({ note_id: 'Bees', found_by: 'keyword' });
        expect(found.search_note).toContain('No embedding model is set up');
        await noteIndex.stop();
    });

    it('says how much of the vault is searched while it is still being indexed', async () => {
        const made = environment({ 'a.md': 'The first note mentions otters.', 'b.md': 'The second note mentions otters too.' });
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const read = made.vault.read.bind(made.vault);
        made.vault.read = async (file) => {
            await gate;
            return read(file);
        };
        const noteIndex = new NoteIndex({ app: made.app, store: new MemoryIndexStore(), embedder: null, debounceMs: 5, log: () => {} });
        env = made;
        index = noteIndex;
        await noteIndex.start();
        const early = await call('search_vault_fulltext', { query: 'otters' });
        expect(early).toEqual({ matches: [], note: 'No indexed passage matched. 2 of 2 notes are not indexed yet, so results may leave them out.' });
        release();
        await noteIndex.whenIdle();
        const later = await call('search_vault_fulltext', { query: 'otters' });
        expect(later.coverage).toBeUndefined();
        expect(later.matches).toHaveLength(2);
        await noteIndex.stop();
    });
});
