/**
 * Folders the user left out of AlphainO (Settings → Excluded folders) are a boundary, as AlphainZ's excluded
 * libraries are: no tool reads, lists, suggests, links to or comments on their notes.
 */
import { describe, expect, it, vi } from 'vitest';

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
        getAllTags: (cache: any) => ((cache?.tags ?? []) as any[]).map((tag) => tag.tag),
    };
});

import { TFile, TFolder } from 'obsidian';
import { createVaultToolDispatcher } from '../src/tools/vaultTools';
import { createNoteMetaToolDispatcher } from '../src/tools/noteMetaTools';
import { createCommentToolDispatcher } from '../src/comments/tools';
import { CommentStore } from '../src/comments/store';
import { captureAnchor } from '../src/comments/anchor';
import type { FileAdapter } from '../src/store/conversations';

function memoryAdapter(): FileAdapter {
    const files = new Map<string, string>();
    const folders = new Set<string>();
    return {
        exists: async (path) => files.has(path) || folders.has(path),
        mkdir: async (path) => void folders.add(path),
        read: async (path) => files.get(path) as string,
        write: async (path, data) => void files.set(path, data),
        remove: async (path) => void files.delete(path),
        list: async (path) => ({
            files: [...files.keys()].filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/')),
            folders: [...folders].filter((folder) => folder.startsWith(`${path}/`) && !folder.slice(path.length + 1).includes('/')),
        }),
    };
}

const DIARY = ['---', 'mood: low', '---', '# Therapy notes', '', 'I told Dr. K about the panic attacks.', '', '## Medication', '', 'Started sertraline 50mg.'].join('\n');

function app() {
    const notes: Record<string, string> = {
        'Projects/Plan.md': '# Plan\n\nSee the plan.',
        'Private/Diary.md': DIARY,
    };
    const folders = new Map<string, any>();
    const root: any = Object.assign(new (TFolder as any)(), { path: '/', name: '', children: [] });
    const files = new Map<string, any>();
    for (const [path, text] of Object.entries(notes)) {
        const folderPath = path.slice(0, path.lastIndexOf('/'));
        let folder = folders.get(folderPath);
        if (!folder) {
            folder = Object.assign(new (TFolder as any)(), { path: folderPath, name: folderPath, parent: root, children: [] });
            folders.set(folderPath, folder);
        }
        const name = path.slice(path.lastIndexOf('/') + 1);
        files.set(path, Object.assign(new (TFile as any)(), { path, name, basename: name.replace(/\.md$/, ''), extension: 'md', parent: folder, stat: { ctime: 1, mtime: 2, size: text.length }, text }));
    }
    return {
        vault: {
            getMarkdownFiles: () => [...files.values()],
            getAllLoadedFiles: () => [root, ...folders.values(), ...files.values()],
            getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path) ?? null,
            getFolderByPath: (path: string) => folders.get(path) ?? null,
            getAllFolders: () => [...folders.values()],
            cachedRead: async (file: any) => files.get(file.path).text,
            read: async (file: any) => files.get(file.path).text,
        },
        metadataCache: {
            getFileCache: (file: any) => (file.path === 'Private/Diary.md' ? { frontmatter: { mood: 'low' } } : null),
            getFirstLinkpathDest: (link: string) => [...files.values()].find((file) => file.basename === link) ?? null,
            // The diary links to the plan: the plan's backlinks name the diary.
            resolvedLinks: { 'Private/Diary.md': { 'Projects/Plan.md': 1 } },
            unresolvedLinks: {},
        },
        workspace: { getActiveFile: () => null, getActiveViewOfType: () => null, getMostRecentLeaf: () => null, rootSplit: {} },
    } as any;
}

const EXCLUDED = () => ['Private'];

describe('notes in excluded folders, as the chat and Claude see them', () => {
    it('are not listed or found by metadata', async () => {
        const a = app();
        const vault = createVaultToolDispatcher({ app: a, getIndex: () => null, getExcludedFolders: EXCLUDED });
        const listed: any = await vault('list_notes', {}, { toolCallId: 'x' });
        expect(listed.items.map((i: any) => i.note_id)).toEqual(['Projects/Plan']);
        const meta = createNoteMetaToolDispatcher({ app: a, getExcludedFolders: EXCLUDED });
        const found: any = await meta('note_search_by_metadata', { title_query: 'diary' }, { toolCallId: 'x' });
        expect(found.total_count).toBe(0);
    });

    it('cannot be read, and are never suggested for a near miss', async () => {
        const vault = createVaultToolDispatcher({ app: app(), getIndex: () => null, getExcludedFolders: EXCLUDED });
        const read: any = await vault('read_note', { note_id: 'Diary' }, { toolCallId: 'x' });
        expect(read.text).toBeUndefined();
        expect(read.error).toContain('left out of AlphainO');
        const byPath: any = await vault('read_note', { note_id: 'Private/Diary.md' }, { toolCallId: 'x' });
        expect(byPath.error).toContain('left out of AlphainO');
        const miss: any = await vault('read_note', { note_id: 'Dia' }, { toolCallId: 'x' });
        expect(miss.did_you_mean ?? []).not.toContain('Private/Diary');
    });

    it('are not searched within, described, or named as a backlink', async () => {
        const meta = createNoteMetaToolDispatcher({ app: app(), getExcludedFolders: EXCLUDED });
        const hits: any = await meta('search_in_note', { note_id: 'Private/Diary', query: 'panic' }, { toolCallId: 'x' });
        expect(hits.matches).toBeUndefined();
        expect(hits.error).toContain('left out of AlphainO');
        const metadata: any = await meta('get_note_metadata', { note_ids: ['Private/Diary'] }, { toolCallId: 'x' });
        expect(metadata.items[0].outline).toBeUndefined();
        expect(metadata.items[0].error).toContain('left out of AlphainO');
        const links: any = await meta('get_note_links', { note_id: 'Projects/Plan' }, { toolCallId: 'x' });
        expect(links.backlinks.map((b: any) => b.note_id)).not.toContain('Private/Diary');
    });

    it('keep their comments to themselves: not found, not answered, not resolved', async () => {
        const a = app();
        const store = new CommentStore(memoryAdapter(), () => 'Agent/.alphaino');
        const passage = 'I told Dr. K about the panic attacks.';
        const from = DIARY.indexOf(passage);
        const thread = await store.addThread({ actor: 'user', anchor: captureAnchor('Private/Diary.md', DIARY, { from, to: from + passage.length }), text: 'follow up' });
        const comments = createCommentToolDispatcher({ app: a, store, actor: 'claude', getExcludedFolders: EXCLUDED });
        const found: any = await comments('find_comments', {}, { toolCallId: 'x' });
        expect(found.threads).toEqual([]);
        const reply: any = await comments('reply_to_comment', { thread_id: thread.root.id, text: 'noted' }, { toolCallId: 'x' });
        expect(reply.error).toContain('left out of AlphainO');
        const resolve: any = await comments('resolve_comment', { thread_id: thread.root.id }, { toolCallId: 'x' });
        expect(resolve.error).toContain('left out of AlphainO');
        // Without excluded folders the same thread is found.
        const open = createCommentToolDispatcher({ app: a, store, actor: 'claude' });
        expect(((await open('find_comments', {}, { toolCallId: 'x' })) as any).threads).toHaveLength(1);
    });
});
