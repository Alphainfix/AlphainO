import { describe, expect, it } from 'vitest';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { newRun } from '../src/agent/runTurn';
import {
    attachedNotesOf,
    describeContext,
    openNoteOf,
    promptForModel,
    questionForModel,
    quoteOf,
    runsForModel,
    type Quote,
} from '../src/agent/quote';

const quote: Quote = { text: 'Bees dance to say\nwhere the flowers are.', path: 'Biology/Bees.md', from: 12, to: 13 };

function ask(question: string, context: Parameters<typeof newRun>[0]['context'] = {}) {
    return newRun({ id: 'r1', threadId: 't', question, model: 'm', providerLabel: 'P', now: new Date(), context });
}

describe('what a question carries', () => {
    it('stores the open note, attached notes and the passage with the question', () => {
        const run = ask('Why do they dance?', { note: 'Biology/Bees.md', notes: ['Biology/Flowers.md'], quote });
        expect(run.user_prompt.content).toBe('Why do they dance?');
        expect(openNoteOf(run.user_prompt)).toBe('Biology/Bees.md');
        expect(attachedNotesOf(run.user_prompt)).toEqual(['Biology/Flowers.md']);
        expect(quoteOf(run.user_prompt)).toEqual(quote);
    });

    it('reads to the model as AlphainZ words it: what is open, what is attached, the passage quoted, then the question', () => {
        const run = ask('Why do they dance?', { note: 'Biology/Bees.md', notes: ['Biology/Flowers.md'], quote });
        expect(questionForModel(run.user_prompt)).toBe([
            'Currently open in the editor: [[Biology/Bees]].',
            'Notes attached to this message:',
            '- [[Biology/Flowers]]',
            'The user has selected this passage in [[Biology/Bees]] (lines 12–13), which is what "this" refers to:',
            '"""',
            'Bees dance to say',
            'where the flowers are.',
            '"""',
            '',
            'Why do they dance?',
        ].join('\n'));
    });

    it('does not list the open note again among the attached ones', () => {
        const run = ask('Compare', { note: 'A.md', notes: ['A.md', 'B.md'] });
        expect(describeContext(run.user_prompt)).toBe(['Currently open in the editor: [[A]].', 'Notes attached to this message:', '- [[B]]'].join('\n'));
    });

    it('asks what the passage means when nothing else is asked', () => {
        const prompt = { content: '', alphaino_quote: { ...quote, from: 5, to: 5 } } as AgentRun['user_prompt'];
        const text = questionForModel(prompt);
        expect(text).toContain('(line 5)');
        expect(text.endsWith('Explain this passage.')).toBe(true);
    });

    it('leaves a plain question as it is', () => {
        expect(promptForModel({ content: 'hi' })).toEqual({ content: 'hi' });
        expect(ask('hi').user_prompt).toEqual({ content: 'hi' });
    });

    it('replays earlier questions with what they carried, byte for byte', () => {
        const asked = ask('Why?', { quote });
        const plain = newRun({ id: 'r2', threadId: 't', question: 'And then?', model: 'm', providerLabel: 'P', now: new Date() });
        const replayed = runsForModel([asked, plain]);
        expect(replayed[0].user_prompt.content).toBe(questionForModel(asked.user_prompt));
        expect(replayed[0].user_prompt.content).toContain('Bees dance to say');
        expect(replayed[1]).toBe(plain);
        // The stored run is untouched.
        expect(asked.user_prompt.content).toBe('Why?');
    });

    it('still reads a question stored by the first build, which carried only a passage', () => {
        const old = { content: 'What?', alphaino_quote: quote } as AgentRun['user_prompt'];
        expect(quoteOf(old)).toEqual(quote);
        expect(openNoteOf(old)).toBeNull();
        expect(questionForModel(old)).toContain('[[Biology/Bees]] (lines 12–13)');
    });

    it('says which page of a PDF a passage was selected on', () => {
        const run = ask('What does it mean?', { quote: { text: 'The waggle dance', path: 'Papers/Frisch 1967.pdf', from: 0, to: 0, page: 3 } });
        expect(describeContext(run.user_prompt)).toContain('in [[Papers/Frisch 1967.pdf]] (page 3), which is what "this" refers to:');
    });
});
