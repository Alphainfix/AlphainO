import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({ Notice: class {}, getLanguage: () => 'en', setIcon: () => {}, MarkdownRenderer: { render: async () => {} }, Component: class {} }));

const { answerWithSteps, chatMarkdown } = await import('../src/view/chatContent');

const run = (id: string, question: string, parts: unknown[]) =>
    ({ id, thread_id: 't1', user_prompt: { content: question }, model_messages: [{ kind: 'response', parts }], status: 'completed' }) as never;

describe('a chat as Markdown, as AlphainZ copies it', () => {
    const chat = {
        name: 'Bees',
        runs: [
            run('r1', 'What do bees eat?', [
                { part_kind: 'tool-call', tool_name: 'read_note', args: { note_id: 'Biology/Bees.md' }, tool_call_id: 'c1' },
                { part_kind: 'text', content: 'Nectar and pollen.' },
                { part_kind: 'tool-call', tool_name: 'return_suggestions', args: {}, tool_call_id: 'c2' },
            ]),
            run('r2', 'And\nwasps?', [{ part_kind: 'text', content: 'Other insects.' }]),
        ],
    };

    it('writes the title, each question under User and each answer under AlphainO, with rules between', () => {
        const text = chatMarkdown(chat);
        expect(text.startsWith('# Bees\n\n---\n\n## User\n\nWhat do bees eat?\n\n---\n\n## AlphainO\n\n')).toBe(true);
        expect(text).toContain('Nectar and pollen.');
        expect(text.endsWith('## User\n\nAnd\nwasps?\n\n---\n\n## AlphainO\n\nOther insects.')).toBe(true);
    });

    it('keeps a line for each step the answer took, but not the follow-up suggestions', () => {
        const text = answerWithSteps(chat.runs[0]);
        expect(text).toContain('Nectar and pollen.');
        expect(text).toMatch(/\*[^*]*Bees[^*]*\*/);
        expect(text).not.toContain('return_suggestions');
    });

    it('in a note: questions quoted, each linking back to its place in the chat', () => {
        const text = chatMarkdown(chat, { link: (id) => `obsidian://alphaino?thread=t1&run=${id}`, quoteQuestions: true });
        expect(text).toContain('## [User ↗](obsidian://alphaino?thread=t1&run=r1)\n\n> What do bees eat?');
        expect(text).toContain('> And\n> wasps?');
    });
});
