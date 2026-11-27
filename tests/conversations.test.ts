import { describe, expect, it } from 'vitest';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import {
    CONVERSATION_FORMAT,
    ConversationStore,
    fromFile,
    toFile,
    transcript,
    type Conversation,
    type FileAdapter,
} from '../src/store/conversations';

function memoryAdapter(): FileAdapter & { files: Map<string, string>; folders: Set<string> } {
    const files = new Map<string, string>();
    const folders = new Set<string>();
    return {
        files,
        folders,
        async exists(path) {
            return files.has(path) || folders.has(path);
        },
        async mkdir(path) {
            folders.add(path);
        },
        async read(path) {
            const text = files.get(path);
            if (text === undefined) throw new Error(`missing ${path}`);
            return text;
        },
        async write(path, data) {
            files.set(path, data);
        },
        async remove(path) {
            files.delete(path);
        },
        async list(path) {
            return { files: [...files.keys()].filter((f) => f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes('/')), folders: [] };
        },
    };
}

const ID = '0b9d6b3e-4c1a-4f37-9d2e-6f0f6a1b2c3d';

function run(question: string, answer: string): AgentRun {
    return {
        id: `run-${question}`,
        user_id: 'local',
        thread_id: ID,
        agent_name: 'alphaino',
        user_prompt: { content: question },
        status: 'completed',
        model_messages: [
            { kind: 'response', run_id: `run-${question}`, parts: [{ part_kind: 'thinking', content: 'hmm' }, { part_kind: 'text', content: answer }] },
        ],
        model_name: 'deepseek-flash',
        provider_name: 'DeepSeek',
        created_at: '2026-11-25T23:00:00.000Z',
        consent_to_share: false,
    };
}

const conversation: Conversation = {
    id: ID,
    name: 'Bees',
    createdAt: '2026-11-25T23:00:00.000Z',
    updatedAt: '2026-11-25T23:01:00.000Z',
    runs: [run('What do bees eat?', 'Nectar and pollen.')],
};

describe('conversation files', () => {
    it('are AlphainZ conversation files that read back to the same conversation', () => {
        const file = toFile(conversation, '0.0.1', 'device-1', new Date('2026-11-25T23:02:00.000Z'));
        expect(file.format).toBe(CONVERSATION_FORMAT);
        expect(file.version).toBe(1);
        expect(file.generator).toEqual({ name: 'AlphainO', version: '0.0.1' });
        expect(file.thread).toMatchObject({ id: ID, name: 'Bees', archivedAt: null, compaction: null });
        expect(file.exportedBy).toBe('device-1');
        expect(fromFile(JSON.stringify(file))).toEqual({ ...conversation, archivedAt: null });
    });

    it('carry a readable transcript of the questions and answers, thinking left out', () => {
        expect(transcript(conversation.runs)).toEqual([
            { role: 'user', content: 'What do bees eat?' },
            { role: 'assistant', content: 'Nectar and pollen.' },
        ]);
    });

    it('refuse other JSON and files from a newer format version', () => {
        expect(fromFile('{"format":"something.else","version":1,"thread":{"id":"x"},"runs":[]}')).toBeNull();
        const newer = { ...toFile(conversation, '0.0.1', 'd', new Date()), version: 2 };
        expect(fromFile(JSON.stringify(newer))).toBeNull();
        expect(fromFile('not json')).toBeNull();
    });
});

describe('ConversationStore', () => {
    it('saves into <data folder>/conversations, creating the folders, and lists, loads and removes', async () => {
        const adapter = memoryAdapter();
        const store = new ConversationStore(adapter, () => 'Agent/.alphaino', '0.0.1', 'device-1');
        await store.save(conversation, new Date('2026-11-25T23:02:00.000Z'));

        expect(adapter.folders).toEqual(new Set(['Agent', 'Agent/.alphaino', 'Agent/.alphaino/conversations']));
        expect([...adapter.files.keys()]).toEqual([`Agent/.alphaino/conversations/${ID}.json`]);
        expect(await store.list()).toEqual([{ id: ID, name: 'Bees', updatedAt: conversation.updatedAt, archivedAt: null, searchText: expect.any(String), notes: [] }]);
        expect(await store.load(ID)).toEqual({ ...conversation, archivedAt: null });

        await store.remove(ID);
        expect(await store.list()).toEqual([]);
        expect(await store.load(ID)).toBeNull();
    });

    it('ignores a copy a sync client made on a conflict, and other files', async () => {
        const adapter = memoryAdapter();
        const store = new ConversationStore(adapter, () => '.alphaino', '0.0.1', 'device-1');
        await store.save(conversation);
        const text = adapter.files.get(`.alphaino/conversations/${ID}.json`)!;
        adapter.files.set(`.alphaino/conversations/${ID} 2.json`, text);
        adapter.files.set('.alphaino/conversations/notes.md', '# not a conversation');
        expect((await store.list()).map((item) => item.id)).toEqual([ID]);
    });

    it('lists the most recently updated first', async () => {
        const adapter = memoryAdapter();
        const store = new ConversationStore(adapter, () => '.alphaino', '0.0.1', 'device-1');
        const older = { ...conversation, id: '11111111-1111-4111-8111-111111111111', name: 'Older', updatedAt: '2026-11-01T00:00:00.000Z' };
        await store.save(older);
        await store.save(conversation);
        expect((await store.list()).map((item) => item.name)).toEqual(['Bees', 'Older']);
    });

    it('lists nothing before the folder exists', async () => {
        const store = new ConversationStore(memoryAdapter(), () => '.alphaino', '0.0.1', 'device-1');
        expect(await store.list()).toEqual([]);
    });
    it('archives, restores and renames a chat, as AlphainZ’s history does', async () => {
        const adapter = memoryAdapter();
        const store = new ConversationStore(adapter, () => 'Agent/.alphaino', '0.0.1', 'device');
        await store.save(conversation);
        await store.archive(ID, new Date('2026-11-26T01:00:00.000Z'));
        expect((await store.list())[0]).toMatchObject({ id: ID, archivedAt: '2026-11-26T01:00:00.000Z', updatedAt: conversation.updatedAt });
        await store.restore(ID);
        expect((await store.list())[0].archivedAt).toBeNull();
        await store.rename(ID, '  Honey  ');
        expect((await store.list())[0].name).toBe('Honey');
        expect((await store.load(ID))?.runs).toEqual(conversation.runs);
    });
});
