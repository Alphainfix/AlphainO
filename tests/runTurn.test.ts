import { describe, expect, it } from 'vitest';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { ChatProvider, ChatRequest, StreamEvent } from '@beaver/agent-llm/types';
import { answerText, newRun, runTurn, type TurnState } from '../src/agent/runTurn';
import { installRuntime } from '../src/runtime';
import { PrefStore, normalizeSettings } from '../src/settings';

const settings = normalizeSettings({});
installRuntime(new PrefStore(() => settings, () => {}), false);

type Step = (emit: (event: StreamEvent) => void, request: ChatRequest) => void | Promise<void>;

function scripted(steps: Step[], seen: ChatRequest[] = []): ChatProvider {
    let turn = 0;
    return {
        label: 'Fake',
        model: 'fake-1',
        wireFormat: 'openai',
        async stream(request, onEvent) {
            // The loop keeps appending to its messages; keep what was sent at this call.
            seen.push({ ...request, messages: [...request.messages] });
            const step = steps[turn++];
            if (!step) {
                onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
                return;
            }
            await step(onEvent, request);
        },
    };
}

const question = (text: string, threadId = 't1') =>
    newRun({ id: `run-${text}`, threadId, question: text, model: 'fake-1', providerLabel: 'Fake', now: new Date('2026-11-25T23:00:00Z') });

async function turn(provider: ChatProvider, run: AgentRun, priorRuns: AgentRun[] = [], signal = new AbortController().signal) {
    const updates: TurnState[] = [];
    const final = await runTurn({ run, priorRuns, provider, systemPrompt: 'You are a test.', signal, onUpdate: (s) => updates.push(s) });
    return { final, updates };
}

describe('runTurn', () => {
    it('folds the streamed thinking and answer into a completed run', async () => {
        const provider = scripted([
            (emit) => {
                emit({ type: 'reasoning', text: 'They ask about bees.' });
                emit({ type: 'text', text: 'Nectar ' });
                emit({ type: 'text', text: 'and pollen.' });
                emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
            },
        ]);
        const { final, updates } = await turn(provider, question('What do bees eat?'));
        expect(final.run.status).toBe('completed');
        expect(final.run.completed_at).toBeTruthy();
        expect(answerText(final.run)).toBe('Nectar and pollen.');
        const parts = final.run.model_messages.flatMap((m) => m.parts.map((p) => p.part_kind));
        expect(parts).toEqual(['thinking', 'text']);
        // The answer arrived in pieces, not in one block at the end.
        expect(updates.filter((u) => u.run.status === 'in_progress').length).toBeGreaterThan(1);
    });

    it('replays the earlier questions and answers to the model', async () => {
        const seen: ChatRequest[] = [];
        const first = await turn(scripted([(emit) => { emit({ type: 'text', text: 'Nectar.' }); emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] }); }]), question('What do bees eat?'));
        await turn(scripted([(emit) => { emit({ type: 'text', text: 'Yes.' }); emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] }); }], seen), question('All of them?'), [first.final.run]);
        const sent = seen[0].messages.map((m) => [m.role, typeof m.content === 'string' ? m.content : '']);
        expect(sent[0]).toEqual(['system', 'You are a test.']);
        expect(sent.map(([, content]) => content)).toEqual(expect.arrayContaining(['Nectar.']));
        expect(String(sent[sent.length - 1]?.[1])).toContain('All of them?');
    });

    it('ends as stopped when the user stops it mid-answer', async () => {
        const controller = new AbortController();
        const provider = scripted([
            (emit) => {
                emit({ type: 'text', text: 'Bees eat' });
                controller.abort();
                return new Promise<void>(() => {}); // a stream that never finishes on its own
            },
        ]);
        const { final } = await turn(provider, question('What do bees eat?'), [], controller.signal);
        expect(final.run.status).toBe('canceled');
        expect(final.run.error).toMatchObject({ reason_code: 'client_cancel' });
    });

    it('records a failed request as an error with the reason', async () => {
        const provider = scripted([
            (emit) => emit({ type: 'error', error: Object.assign(new Error('Invalid API key'), { status: 401 }) }),
        ]);
        const { final } = await turn(provider, question('Hello'));
        expect(final.run.status).toBe('error');
        expect(final.run.error?.message).toBeTruthy();
    });
    it('sends a question’s pasted image as an image part to a model that can see, and says so to one that cannot', async () => {
        const run = newRun({
            id: 'run-img',
            threadId: 't1',
            question: 'What is this?',
            model: 'fake-1',
            providerLabel: 'Fake',
            now: new Date('2026-11-25T23:00:00Z'),
            context: { images: [{ path: '.alphaino/attachments/a.png', mimeType: 'image/png', name: 'chart.png' }] },
        });
        const seen: ChatRequest[] = [];
        await runTurn({
            run,
            priorRuns: [],
            provider: scripted([], seen),
            systemPrompt: 'You are a test.',
            signal: new AbortController().signal,
            onUpdate: () => {},
            vision: true,
            loadImage: async () => ({ mimeType: 'image/png', base64: 'AAAA' }),
        });
        const last = seen[0].messages[seen[0].messages.length - 1];
        expect(Array.isArray(last.content)).toBe(true);
        expect(last.content).toEqual([
            { type: 'text', text: expect.stringContaining('The user attached an image to this message.') },
            { type: 'image', mimeType: 'image/png', base64: 'AAAA', label: 'chart.png' },
        ]);

        const blind: ChatRequest[] = [];
        await runTurn({ run, priorRuns: [], provider: scripted([], blind), systemPrompt: 'x', signal: new AbortController().signal, onUpdate: () => {}, vision: false });
        const text = blind[0].messages[blind[0].messages.length - 1].content;
        expect(typeof text).toBe('string');
        expect(text).toContain('cannot see images');
    });
});
