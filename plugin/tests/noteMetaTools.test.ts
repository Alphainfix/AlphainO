import { describe, expect, it, vi } from 'vitest';

// The obsidian stand-in has no file classes or tag helper; the tools only ask `instanceof` and read tags.
vi.mock('obsidian', async (importOriginal) => {
    class TAbstractFile {
        path = '';
        name = '';
        parent: any = null;
    }
    class TFile extends TAbstractFile {
        basename = '';
        extension = '';
        stat = { ctime: 0, mtime: 0, size: 0 };
    }
    class TFolder extends TAbstractFile {
        children: TAbstractFile[] = [];
    }
    return {
        ...(await importOriginal<Record<string, unknown>>()),
        TAbstractFile,
        TFile,
        TFolder,
        MarkdownView: class MarkdownView {},
        getAllTags: (cache: any) => [
            ...((cache?.tags ?? []).map((tag: any) => tag.tag) as string[]),
            ...((cache?.frontmatter?.tags ?? []) as string[]).map((tag) => `#${tag}`),
        ],
    };
});

import { TFile, TFolder } from 'obsidian';
import { createNoteMetaToolDispatcher, noteMetaToolSchemas, NOTE_META_TOOL_NAMES } from '../src/tools/noteMetaTools';

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-11-01T12:00:00');

interface NoteSpec {
    path: string;
    text: string;
    cache?: Record<string, unknown>;
    ctime?: number;
    mtime?: number;
}

function vault(notes: NoteSpec[], links: Record<string, Record<string, number>> = {}, missing: Record<string, Record<string, number>> = {}) {
    const folders = new Map<string, any>();
    const root: any = Object.assign(new (TFolder as any)(), { path: '/', name: '', children: [] });
    const folderOf = (path: string): any => {
        if (!path) return root;
        let folder = folders.get(path);
        if (!folder) {
            const parent = folderOf(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
            folder = Object.assign(new (TFolder as any)(), { path, name: path.slice(path.lastIndexOf('/') + 1), parent, children: [] });
            parent.children.push(folder);
            folders.set(path, folder);
        }
        return folder;
    };
    const files = new Map<string, { file: any; spec: NoteSpec }>();
    for (const spec of notes) {
        const name = spec.path.slice(spec.path.lastIndexOf('/') + 1);
        const parent = folderOf(spec.path.includes('/') ? spec.path.slice(0, spec.path.lastIndexOf('/')) : '');
        const file = Object.assign(new (TFile as any)(), {
            path: spec.path,
            name,
            basename: name.replace(/\.md$/, ''),
            extension: 'md',
            parent,
            stat: { ctime: spec.ctime ?? T0, mtime: spec.mtime ?? T0, size: spec.text.length },
        });
        parent.children.push(file);
        files.set(spec.path, { file, spec });
    }
    const app: any = {
        vault: {
            getMarkdownFiles: () => [...files.values()].map((entry) => entry.file),
            getAllLoadedFiles: () => [root, ...folders.values(), ...[...files.values()].map((entry) => entry.file)],
            getAbstractFileByPath: (path: string) => files.get(path)?.file ?? folders.get(path) ?? null,
            cachedRead: async (file: any) => files.get(file.path)?.spec.text ?? '',
            read: async (file: any) => files.get(file.path)?.spec.text ?? '',
        },
        metadataCache: {
            getFileCache: (file: any) => files.get(file.path)?.spec.cache ?? null,
            getFirstLinkpathDest: (link: string) => [...files.values()].find((entry) => entry.file.basename === link || entry.file.path === `${link}.md`)?.file ?? null,
            resolvedLinks: links,
            unresolvedLinks: missing,
        },
        workspace: { getActiveFile: () => files.get('Projects/Plan.md')?.file ?? null },
    };
    return app;
}

const PLAN_TEXT = ['---', 'status: draft', '---', '# Plan', '', 'The bees dance at noon.', '', '## Risks', '', 'Bees may swarm. Bees!'].join('\n');

function sample() {
    return vault(
        [
            { path: 'Projects/Plan.md', text: PLAN_TEXT, cache: { frontmatter: { status: 'draft', tags: ['project/alpha'] }, tags: [{ tag: '#bees' }] }, ctime: T0 - 10 * DAY, mtime: T0 },
            { path: 'Projects/Old/Archive note.md', text: '# Old\nNothing here.', cache: { frontmatter: { status: 'done' } }, ctime: T0 - 60 * DAY, mtime: T0 - 50 * DAY },
            { path: 'Journal/2026-11-01.md', text: 'Saw [[Plan]] today. #bees', cache: { tags: [{ tag: '#bees' }, { tag: '#daily' }] }, ctime: T0, mtime: T0 + DAY },
            { path: 'Private/Secret.md', text: 'secret #bees', cache: { tags: [{ tag: '#bees' }] } },
        ],
        {
            'Journal/2026-11-01.md': { 'Projects/Plan.md': 2 },
            'Projects/Plan.md': { 'Journal/2026-11-01.md': 1 },
        },
        { 'Projects/Plan.md': { 'Not yet written': 1 } },
    );
}

const run = (app: any, name: string, args: Record<string, unknown> = {}) =>
    createNoteMetaToolDispatcher({ app, getExcludedFolders: () => ['Private'] })(name, args, { toolCallId: 'c' }) as Promise<any>;

describe('the second batch of vault tools (AlphainZ counterparts)', () => {
    it('offers six tools whose names mirror AlphainZ’s', () => {
        expect(noteMetaToolSchemas().map((schema) => schema.name)).toEqual([...NOTE_META_TOOL_NAMES]);
    });

    it('note_search_by_metadata: by tag (nested), property and value, folder and dates, newest first, never in excluded folders', async () => {
        const app = sample();
        const byTag = await run(app, 'note_search_by_metadata', { tag: '#bees' });
        expect(byTag.items.map((item: any) => item.note_id)).toEqual(['Journal/2026-11-01', 'Projects/Plan']);
        expect((await run(app, 'note_search_by_metadata', { tag: 'project' })).items.map((item: any) => item.title)).toEqual(['Plan']);
        const byProperty = await run(app, 'note_search_by_metadata', { property: 'status', property_value: 'done' });
        expect(byProperty.items).toMatchObject([{ note_id: 'Projects/Old/Archive note', link: '[[Projects/Old/Archive note]]', status: 'done' }]);
        expect((await run(app, 'note_search_by_metadata', { folder: 'Projects' })).total_count).toBe(2);
        expect((await run(app, 'note_search_by_metadata', { modified_after: '2026-10-20' })).total_count).toBe(2);
        expect((await run(app, 'note_search_by_metadata', { created_after: '2026-11-01' })).items.map((item: any) => item.title)).toEqual(['2026-11-01']);
        expect((await run(app, 'note_search_by_metadata', {})).error).toMatch(/criterion/);
        expect((await run(app, 'note_search_by_metadata', { folder: 'Nope' })).error).toMatch(/no folder/);
    });

    it('search_in_note: literal, case-insensitive, with lines and the heading each match is under', async () => {
        const result = await run(sample(), 'search_in_note', { note_id: '[[Plan]]', query: 'bees' });
        expect(result.total_matches).toBe(3);
        expect(result.matches.map((match: any) => [match.line, match.heading])).toEqual([
            [6, 'Plan'],
            [10, 'Risks'],
            [10, 'Risks'],
        ]);
        expect((await run(sample(), 'search_in_note', { note_id: 'Plan', query: 'wasps' })).note).toMatch(/No literal match/);
    });

    it('get_note_metadata: properties, tags, outline with lines, links in and out, dates', async () => {
        const result = await run(sample(), 'get_note_metadata', { note_ids: ['Projects/Plan', 'Nope'] });
        expect(result.items[0]).toMatchObject({
            note_id: 'Projects/Plan',
            folder: 'Projects',
            properties: { status: 'draft' },
            outline: [
                { level: 1, heading: 'Plan', line: 4 },
                { level: 2, heading: 'Risks', line: 8 },
            ],
            total_lines: 10,
            links_out: 1,
            links_in: 2,
        });
        expect(result.items[0].tags.sort()).toEqual(['bees', 'project/alpha']);
        expect(result.items[1].error).toMatch(/No note found/);
    });

    it('list_folders: flattened with parent and counts, inside a folder on request, without excluded ones', async () => {
        const result = await run(sample(), 'list_folders');
        expect(result.folders).toEqual([
            { folder: 'Journal', parent: '', note_count: 1, total_notes: 1 },
            { folder: 'Projects', parent: '', note_count: 1, total_notes: 2 },
            { folder: 'Projects/Old', parent: 'Projects', note_count: 1, total_notes: 1 },
        ]);
        expect((await run(sample(), 'list_folders', { parent_folder: 'Projects' })).folders.map((row: any) => row.folder)).toEqual(['Projects/Old']);
    });

    it('list_tags: most frequent first, counting each note once, excluded folders left out', async () => {
        const result = await run(sample(), 'list_tags');
        expect(result.tags[0]).toEqual({ tag: '#bees', note_count: 2 });
        expect(result.tags.map((row: any) => row.tag).sort()).toEqual(['#bees', '#daily', '#project/alpha']);
        expect((await run(sample(), 'list_tags', { name_query: 'proj' })).tags).toEqual([{ tag: '#project/alpha', note_count: 1 }]);
    });

    it('get_note_links: links out, links to missing notes and backlinks, the open note by default', async () => {
        const result = await run(sample(), 'get_note_links');
        expect(result.note_id).toBe('Projects/Plan');
        expect(result.links_out).toEqual([{ note_id: 'Journal/2026-11-01', link: '[[Journal/2026-11-01]]', count: 1 }]);
        expect(result.links_to_missing_notes).toEqual([{ target: 'Not yet written', count: 1 }]);
        expect(result.backlinks).toEqual([{ note_id: 'Journal/2026-11-01', link: '[[Journal/2026-11-01]]', count: 2 }]);
    });
});
