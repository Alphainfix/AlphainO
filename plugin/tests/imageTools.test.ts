import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { quantizeToInt8 } from '@beaver/agent-llm/embeddings';
import type { NoteEmbedder } from '../src/search/embedder';
import { ImageIndex } from '../src/search/imageIndex';
import { MemoryImageStore } from '../src/search/imageStore';
import { createImageToolDispatcher, imageToolSchemas } from '../src/tools/imageTools';
import { FakeNoteVault } from './obsidianStub';

function vector(text: string): Int8Array {
    const values = new Array<number>(32).fill(0);
    for (const word of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
        let hash = 7;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        values[hash % 32] += 1;
    }
    return Int8Array.from(quantizeToInt8(values));
}

const embedder: NoteEmbedder = {
    modelId: 'fake-int8-32',
    label: 'Fake',
    embedsImages: true,
    embedDocuments: async (texts) => texts.map(vector),
    embedQuery: async (text) => vector(text),
    embedImages: async (images) => images.map((image) => vector(Buffer.from(image.base64, 'base64').toString('utf8'))),
};

const prepare = async (bytes: ArrayBuffer) => ({
    mimeType: 'image/jpeg',
    base64: Buffer.from(new TextDecoder().decode(bytes)).toString('base64'),
    width: 4,
    height: 3,
});

async function setup() {
    const vault = new FakeNoteVault();
    vault.write('Pictures/cat.png', 'a cat sleeping on a sofa', { silent: true });
    vault.write('Pictures/chart.jpg', 'a bar chart of costs', { silent: true });
    vault.write('Private/passport.png', 'a passport page', { silent: true });
    vault.write('.hidden/secret.png', 'a secret', { silent: true });
    vault.write('Phone/photo.heic', 'a heic photo', { silent: true });
    vault.write('Notes/cat.md', '![[cat.png]]', { silent: true });
    vault.write('Private/diary.md', '![[cat.png]]', { silent: true });
    const metadataCache = {
        resolvedLinks: { 'Notes/cat.md': { 'Pictures/cat.png': 1 }, 'Private/diary.md': { 'Pictures/cat.png': 1 } },
        getFirstLinkpathDest: (name: string) => vault.getFiles().find((file) => file.name === name || file.path === name) ?? null,
    };
    const app = { vault, metadataCache } as unknown as App;
    const excluded = ['Private'];
    const index = new ImageIndex({ app, store: new MemoryImageStore(), embedder, enabled: true, excludedFolders: excluded, prepare, debounceMs: 5, log: () => {} });
    await index.start();
    await index.whenIdle();
    const dispatch = createImageToolDispatcher({ app, getIndex: () => index, getExcludedFolders: () => excluded, prepare });
    const make = (looking: 'tool' | 'file' | 'none') => createImageToolDispatcher({ app, getIndex: () => index, getExcludedFolders: () => excluded, prepare, looking });
    return { index, dispatch, make };
}

describe('the picture tools', () => {
    it('offers the search while the index is on, and the viewer to a model that sees pictures', () => {
        expect(imageToolSchemas({ search: true, view: true }).map((schema) => schema.name)).toEqual(['search_vault_images', 'view_vault_image']);
        expect(imageToolSchemas({ search: false, view: true }).map((schema) => schema.name)).toEqual(['view_vault_image']);
        expect(imageToolSchemas({ search: false, view: false })).toEqual([]);
    });

    it('finds a picture with how to show it and the notes that show it, leaving out excluded notes', async () => {
        const { index, dispatch } = await setup();
        const result = (await dispatch('search_vault_images', { query: 'cat sleeping on a sofa', limit: 2 }, { toolCallId: 't' })) as {
            images: Array<{ path: string; embed: string; shown_in: string[]; similarity: number }>;
        };
        expect(result.images[0]).toMatchObject({ path: 'Pictures/cat.png', embed: '![[Pictures/cat.png]]', shown_in: ['[[Notes/cat]]'] });
        expect(result.images.map((image) => image.path)).not.toContain('Private/passport.png');
        expect(result.images.length).toBeLessThanOrEqual(2);
        await index.stop();
    });

    it('shows a picture to the model, by path or by name, and refuses one in an excluded or hidden folder', async () => {
        const { index, dispatch } = await setup();
        const byName = (await dispatch('view_vault_image', { path: '![[cat.png]]' }, { toolCallId: 't' })) as { kind: string; images: Array<{ label: string; base64: string }>; text: string };
        expect(byName.kind).toBe('tool-images');
        expect(byName.images[0].label).toBe('cat.png');
        expect(Buffer.from(byName.images[0].base64, 'base64').toString('utf8')).toBe('a cat sleeping on a sofa');
        expect(byName.text).toContain('Pictures/cat.png');
        expect(await dispatch('view_vault_image', { path: 'Private/passport.png' }, { toolCallId: 't' })).toMatchObject({ error: expect.stringMatching(/left out of AlphainO/) });
        expect(await dispatch('view_vault_image', { path: '.hidden/secret.png' }, { toolCallId: 't' })).toMatchObject({ error: expect.stringMatching(/left out of AlphainO/) });
        expect(await dispatch('view_vault_image', { path: 'Phone/photo.heic' }, { toolCallId: 't' })).toMatchObject({ error: expect.stringMatching(/HEIC/) });
        expect(await dispatch('view_vault_image', { path: 'Notes/cat.md' }, { toolCallId: 't' })).toMatchObject({ error: expect.stringMatching(/No picture/) });
        await index.stop();
    });

    it('says plainly when the search cannot run', async () => {
        const { index, dispatch } = await setup();
        index.setEnabled(false);
        expect(await dispatch('search_vault_images', { query: 'a cat' }, { toolCallId: 't' })).toMatchObject({ error: expect.stringMatching(/turned off/) });
        expect(await dispatch('search_vault_images', {}, { toolCallId: 't' })).toMatchObject({ error: expect.stringMatching(/requires: query/) });
        await index.stop();
    });

    it('tells the model how it can look at a picture: the viewer, the file, or not at all', async () => {
        const { index, make } = await setup();
        const note = async (looking: 'tool' | 'file' | 'none') => ((await make(looking)('search_vault_images', { query: 'a cat' }, { toolCallId: 't' })) as { note: string }).note;
        expect(await note('tool')).toMatch(/view_vault_image/);
        expect(await note('file')).not.toMatch(/view_vault_image/);
        expect(await note('none')).not.toMatch(/view_vault_image/);
        expect(await note('none')).toMatch(/cannot see pictures/);
        await index.stop();
    });
});
