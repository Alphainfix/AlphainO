import { describe, expect, it } from 'vitest';
import { anchorHash, captureAnchor, digest, normalized, resolveAnchor, validateAnchor } from '../src/comments/anchor';
import { foldEvents, threadsOf, validEvent, type CommentEvent } from '../src/comments/journal';
import { CommentStore } from '../src/comments/store';
import type { FileAdapter } from '../src/store/conversations';

/** A vault folder tree in memory, behaving like Obsidian's adapter (full paths in listings). */
function memoryAdapter(files = new Map<string, string>(), folders = new Set<string>()): FileAdapter & { files: Map<string, string> } {
    return {
        files,
        exists: async (path) => files.has(path) || folders.has(path),
        mkdir: async (path) => void folders.add(path),
        read: async (path) => {
            const text = files.get(path);
            if (text === undefined) throw new Error(`no file ${path}`);
            return text;
        },
        write: async (path, data) => void files.set(path, data),
        remove: async (path) => void files.delete(path),
        list: async (path) => ({
            files: [...files.keys()].filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/')),
            folders: [...folders].filter((folder) => folder.startsWith(`${path}/`) && !folder.slice(path.length + 1).includes('/')),
        }),
    };
}

const NOTE = [
    '# Bees',
    '',
    'Honey bees communicate through a waggle dance that tells other workers where flowers are.',
    'The angle of the dance shows the direction relative to the sun.',
    '',
    '## Food',
    '',
    'Bees eat nectar and pollen, and they store honey for the winter.',
].join('\n');

function rangeOf(text: string, passage: string): { from: number; to: number } {
    const from = text.indexOf(passage);
    if (from === -1) throw new Error('passage not in text');
    return { from, to: from + passage.length };
}

describe('comment anchors (Orbit format)', () => {
    const passage = 'waggle dance that tells other workers where flowers are';

    it('keeps exactly what Orbit keeps: the passage, 64 characters around it, offsets and two hashes', () => {
        const anchor = captureAnchor('Biology/Bees.md', NOTE, rangeOf(NOTE, passage));
        expect(Object.keys(anchor).sort()).toEqual(['documentHash', 'documentKey', 'from', 'kind', 'path', 'prefix', 'quote', 'suffix', 'textHash', 'to']);
        expect(anchor.kind).toBe('range');
        expect(anchor.quote).toBe(passage);
        expect(anchor.prefix.length).toBeLessThanOrEqual(64);
        expect(NOTE.slice(anchor.from - anchor.prefix.length, anchor.from)).toBe(anchor.prefix);
        expect(anchor.textHash).toBe(digest(NOTE));
        expect(anchor.documentKey).toBe('');
    });

    it('a collapsed selection anchors the whole note', () => {
        const anchor = captureAnchor('Biology/Bees.md', NOTE, { from: 5, to: 5 });
        expect(anchor).toMatchObject({ kind: 'document', from: 0, to: 0, quote: '', prefix: '', suffix: '' });
        expect(resolveAnchor(anchor, 'anything at all')).toMatchObject({ status: 'attached', exact: true });
    });

    it('finds the passage at its recorded place while the note is unchanged', () => {
        const anchor = captureAnchor('Biology/Bees.md', NOTE, rangeOf(NOTE, passage));
        const place = resolveAnchor(anchor, NOTE);
        expect(place).toMatchObject({ status: 'attached', exact: true, quote: passage, line: 2 });
    });

    it('follows the passage when text is added above it', () => {
        const anchor = captureAnchor('Biology/Bees.md', NOTE, rangeOf(NOTE, passage));
        const edited = `A new opening paragraph, written later.\n\n${NOTE}`;
        const place = resolveAnchor(anchor, edited);
        expect(place.status).toBe('attached');
        if (place.status !== 'attached') return;
        expect(place.exact).toBe(false);
        expect(edited.slice(place.from, place.to)).toBe(passage);
        expect(place.line).toBe(4);
    });

    it('keeps the passage through an edit inside it, and leaves text typed at its edges out', () => {
        const anchor = captureAnchor('Biology/Bees.md', NOTE, rangeOf(NOTE, passage));
        const edited = NOTE.replace('tells other workers', 'tells the other worker bees').replace(passage.replace('tells other workers', 'tells the other worker bees'), (s) => s);
        const place = resolveAnchor(anchor, edited);
        expect(place.status).toBe('attached');
        if (place.status !== 'attached') return;
        expect(edited.slice(place.from, place.to)).toBe('waggle dance that tells the other worker bees where flowers are');
    });

    it('finds a Chinese passage after the note around it changed', () => {
        const text = '# 蜜蜂\n\n蜜蜂通过摇摆舞告诉同伴花在哪里，舞蹈的角度表示相对太阳的方向。\n\n它们吃花蜜和花粉。';
        const quote = '摇摆舞告诉同伴花在哪里';
        const anchor = captureAnchor('生物/蜜蜂.md', text, rangeOf(text, quote));
        const edited = text.replace('# 蜜蜂\n\n', '# 蜜蜂\n\n这是后来加的一段介绍。\n\n');
        const place = resolveAnchor(anchor, edited);
        expect(place.status).toBe('attached');
        if (place.status === 'attached') expect(edited.slice(place.from, place.to)).toBe(quote);
    });

    it('reports a passage whose text is gone as deleted or detached, never placed on other text', () => {
        const anchor = captureAnchor('Biology/Bees.md', NOTE, rangeOf(NOTE, passage));
        const edited = NOTE.replace(passage, '');
        const place = resolveAnchor(anchor, edited);
        if (place.status === 'attached') {
            expect(place.deleted).toBe(true);
            expect(place.to).toBe(place.from);
        } else {
            expect(['detached', 'ambiguous']).toContain(place.status);
        }
        expect(resolveAnchor(anchor, 'Nothing of the old note is left.').status).not.toBe('attached');
    });

    it('calls a passage that now appears twice, with nothing to tell the two apart, ambiguous', () => {
        const quote = 'the dance shows the direction';
        const text = `Intro.\n${quote}\nEnd.`;
        const anchor = captureAnchor('A.md', text, rangeOf(text, quote));
        const twice = `A.\n${quote}\nB.\n\nC.\n${quote}\nD.`;
        expect(resolveAnchor(anchor, twice).status).toBe('ambiguous');
    });

    it('never places a short passage whose context is gone', () => {
        const text = 'x\nalpha beta\ny\n';
        const anchor = captureAnchor('A.md', text, rangeOf(text, 'alpha beta'));
        expect(resolveAnchor(anchor, 'q\nalpha beta\nr\n\nq\nalpha beta\nr\n').status).toBe('detached');
    });

    it('counts offsets in the text with LF line endings and no BOM', () => {
        const raw = `﻿${NOTE.replace(/\n/g, '\r\n')}`;
        const anchor = captureAnchor('Biology/Bees.md', raw, rangeOf(normalized(raw), passage));
        expect(anchor.quote).toBe(passage);
        expect(anchor.textHash).toBe(digest(NOTE));
        expect(anchor.documentHash).toBe(digest(raw));
        expect(resolveAnchor(anchor, raw)).toMatchObject({ status: 'attached', exact: true });
    });

    it('refuses malformed anchors as Orbit does', () => {
        const good = captureAnchor('Biology/Bees.md', NOTE, rangeOf(NOTE, passage));
        expect(() => validateAnchor({ ...good, extra: 1 })).toThrow();
        expect(() => validateAnchor({ ...good, path: '.hidden/Bees.md' })).toThrow();
        expect(() => validateAnchor({ ...good, quote: 'x'.repeat(4001), to: good.from + 4001 })).toThrow();
        expect(() => validateAnchor({ ...good, to: good.to + 1 })).toThrow();
        expect(() => captureAnchor('Biology/Bees.md', NOTE, { from: 0, to: NOTE.length + 1 })).toThrow();
        expect(anchorHash(good)).toMatch(/^[0-9a-f]{64}$/);
    });
});

function event(partial: Partial<CommentEvent> & Pick<CommentEvent, 'id' | 'entityId' | 'at' | 'patch'>): CommentEvent {
    return { schema: 1, entity: 'comment', actor: 'user', parents: [], ...partial };
}

const ids = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('the comment journal', () => {
    const anchor = captureAnchor('Biology/Bees.md', NOTE, rangeOf(NOTE, 'waggle dance'));

    it('folds a thread from its events: root, reply, resolve', () => {
        const root = ids(1);
        const events = [
            event({ id: ids(10), entityId: root, at: '2026-11-26T01:00:00.000Z', patch: { taskId: '', text: 'Source?', deleted: false, documentId: root, anchor } }),
            event({ id: ids(11), entityId: ids(2), actor: 'alphaino', at: '2026-11-26T01:01:00.000Z', patch: { taskId: '', text: 'Von Frisch, 1967.', deleted: false, documentId: root, parentId: root } }),
            event({ id: ids(12), entityId: root, at: '2026-11-26T01:02:00.000Z', parents: [ids(10)], patch: { resolved: true } }),
        ];
        const records = foldEvents(events);
        expect(records.get(root)).toMatchObject({ text: 'Source?', resolved: true, owner: 'user', heads: [ids(12)] });
        const [thread] = threadsOf(records);
        expect(thread.root.id).toBe(root);
        expect(thread.replies.map((reply) => [reply.owner, reply.text])).toEqual([['alphaino', 'Von Frisch, 1967.']]);
    });

    it('lets the later of two edits written at once win, and keeps both as heads', () => {
        const root = ids(1);
        const events = [
            event({ id: ids(10), entityId: root, at: '2026-11-26T01:00:00.000Z', patch: { taskId: '', text: 'first', deleted: false, documentId: root, anchor } }),
            event({ id: ids(21), entityId: root, at: '2026-11-26T01:05:00.000Z', parents: [ids(10)], patch: { text: 'from the Mac' } }),
            event({ id: ids(20), entityId: root, at: '2026-11-26T01:03:00.000Z', parents: [ids(10)], patch: { text: 'from Windows' } }),
        ];
        const record = foldEvents(events).get(root);
        expect(record?.text).toBe('from the Mac');
        expect(record?.heads).toEqual([ids(20), ids(21)]);
    });

    it('takes only well-formed events', () => {
        const good = event({ id: ids(10), entityId: ids(1), at: '2026-11-26T01:00:00.000Z', patch: { text: 'x' } });
        expect(validEvent(good)).toBe(good);
        expect(validEvent({ ...good, schema: 2 })).toBeNull();
        expect(validEvent({ ...good, entity: 'task' })).toBeNull();
        expect(validEvent({ ...good, patch: { owner: 'someone' } })).toBeNull();
        expect(validEvent({ ...good, at: 'yesterday' })).toBeNull();
    });
});

describe('the comment store', () => {
    let counter = 100;
    const newId = () => ids(counter++);
    const now = () => new Date('2026-11-26T05:00:00.000Z');
    const anchor = captureAnchor('Biology/Bees.md', NOTE, rangeOf(NOTE, 'waggle dance'));

    it('writes one Orbit event file per change under comments/<month>/, and another store reads them back', async () => {
        const adapter = memoryAdapter();
        const store = new CommentStore(adapter, () => 'Agent/.alphaino', newId, now);
        const thread = await store.addThread({ actor: 'user', anchor, text: 'Is this right?' });
        await store.reply({ actor: 'alphaino', threadId: thread.root.id, text: 'Yes: von Frisch showed it.' });
        await store.setResolved({ actor: 'alphaino', threadId: thread.root.id, resolved: true });

        const paths = [...adapter.files.keys()];
        expect(paths).toHaveLength(3);
        expect(paths.every((path) => /^Agent\/\.alphaino\/comments\/2026-11\/[0-9a-f-]{36}\.json$/.test(path))).toBe(true);
        const first = JSON.parse(adapter.files.get(paths[0]) as string);
        expect(Object.keys(first).sort()).toEqual(['actor', 'at', 'entity', 'entityId', 'id', 'parents', 'patch', 'schema']);
        expect(first.patch).toMatchObject({ taskId: '', text: 'Is this right?', deleted: false, documentId: thread.root.id });

        const again = new CommentStore(adapter, () => 'Agent/.alphaino', newId, now);
        await again.load();
        const [read] = again.threadsOn('Biology/Bees.md');
        expect(read.root.resolved).toBe(true);
        expect(read.replies.map((reply) => reply.text)).toEqual(['Yes: von Frisch showed it.']);
    });

    it('refuses a reply to a resolved thread, and an edit by someone else', async () => {
        const store = new CommentStore(memoryAdapter(), () => '.alphaino', newId, now);
        const thread = await store.addThread({ actor: 'user', anchor, text: 'Check this' });
        await expect(store.edit({ actor: 'alphaino', id: thread.root.id, text: 'changed' })).rejects.toThrow(/author/);
        await store.setResolved({ actor: 'user', threadId: thread.root.id, resolved: true });
        await expect(store.reply({ actor: 'alphaino', threadId: thread.root.id, text: 'late' })).rejects.toThrow(/resolved/);
        await expect(store.addThread({ actor: 'user', anchor, text: '   ' })).rejects.toThrow(/text/);
    });

    it('moves a note’s threads with it', async () => {
        const store = new CommentStore(memoryAdapter(), () => '.alphaino', newId, now);
        await store.addThread({ actor: 'user', anchor, text: 'Note' });
        await store.noteMoved('user', 'Biology/Bees.md', 'Insects/Bees.md');
        expect(store.threadsOn('Biology/Bees.md')).toHaveLength(0);
        expect(store.threadsOn('Insects/Bees.md')[0].root.anchor?.path).toBe('Insects/Bees.md');
    });

    it('skips a half-written file and picks it up once it is complete', async () => {
        const adapter = memoryAdapter(new Map(), new Set(['x', 'x/comments', 'x/comments/2026-11']));
        const store = new CommentStore(adapter, () => 'x', newId, now);
        const path = `x/comments/2026-11/${ids(900)}.json`;
        adapter.files.set(path, '{"schema":1,"id":');
        await store.load();
        expect(store.threads()).toHaveLength(0);
        adapter.files.set(path, JSON.stringify(event({ id: ids(900), entityId: ids(901), at: '2026-11-26T01:00:00.000Z', patch: { taskId: '', text: 'hi', deleted: false, documentId: ids(901), anchor } })));
        await store.load();
        expect(store.threads()).toHaveLength(1);
    });
});
