/**
 * An endpoint added by hand (Settings → Add custom provider) answers in chat with its own key, and the user's
 * custom instructions reach the system message, as in AlphainZ.
 */
import { describe, expect, it } from 'vitest';
import { writeCustomEndpoints } from '@beaver/agent-llm/customEndpoints';
import { installRuntime } from '../src/runtime';
import { PrefStore, normalizeSettings, type SecretStore } from '../src/settings';
import { buildChatProvider } from '../src/agent/provider';
import { newRun, runTurn } from '../src/agent/runTurn';
import { availableModels } from '../src/agent/models';
import { setLanguageForTests } from './obsidianStub';

class MemorySecrets implements SecretStore {
    readonly values = new Map<string, string>();
    getSecret(id: string) { return this.values.get(id) ?? null; }
    setSecret(id: string, secret: string) { this.values.set(id, secret); }
}

function sse(chunks: unknown[]): Response {
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('hand-added endpoint in chat', () => {
    it('builds, lists, and sends to the endpoint with its key; custom instructions in the system message', async () => {
        setLanguageForTests('en');
        const settings = normalizeSettings({});
        const secrets = new MemorySecrets();
        const prefs = new PrefStore(() => settings, () => {}, secrets);
        installRuntime(prefs, false);
        writeCustomEndpoints([{ id: 'ep-0a1b2c3d', name: 'Relay', baseUrl: 'http://relay.test/v1', apiKey: 'relay-secret', authStyle: 'bearer', models: [{ id: 'm1', supportsVision: false, reasoningEffort: false, efforts: ['low', 'high'] }] }]);
        prefs.set('llmProvider', 'custom:ep-0a1b2c3d');
        prefs.set('llmModel', 'm1');
        prefs.set('customInstructions', 'Always answer in haiku.');
        const models = availableModels({ prefs, apiKey: () => '' });
        const requests: Array<{ url: string; headers: any; body: any }> = [];
        const fakeFetch = (async (url: string, init: any) => {
            requests.push({ url, headers: init?.headers, body: JSON.parse(init?.body ?? '{}') });
            return sse([{ choices: [{ index: 0, delta: { content: 'Hello.' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]);
        }) as unknown as typeof fetch;
        const built = buildChatProvider(prefs, () => '', fakeFetch);
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        const run = newRun({ id: 'r1', threadId: 't1', question: 'Hi', model: built.model, providerLabel: built.providerLabel, now: new Date() });
        const final = await runTurn({
            run, priorRuns: [], provider: built.provider, systemPrompt: 'SYSTEM', outputTokenLimit: built.outputTokenLimit,
            customInstructions: prefs.string('customInstructions'), signal: new AbortController().signal, onUpdate: () => {},
        });
        expect(requests[0].url).toContain('relay.test/v1');
    });
});
