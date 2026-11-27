import { beforeEach, describe, expect, it } from 'vitest';
import { buildChatProvider } from '../src/agent/provider';
import { installRuntime } from '../src/runtime';
import { PrefStore, normalizeSettings, type AlphainOSettings } from '../src/settings';
import { setLanguageForTests } from './obsidianStub';

let settings: AlphainOSettings;
let prefs: PrefStore;
const keys: Record<string, string> = {};
const noNetwork = (() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch;
const build = () => buildChatProvider(prefs, (id) => keys[id] ?? '', noNetwork);

beforeEach(() => {
    settings = normalizeSettings({});
    prefs = new PrefStore(() => settings, () => {});
    installRuntime(prefs, false);
    for (const id of Object.keys(keys)) delete keys[id];
    setLanguageForTests('en');
});

describe('buildChatProvider', () => {
    it('asks for a provider when none is chosen', () => {
        expect(build()).toMatchObject({ ok: false, needsKey: true, message: expect.stringContaining('No model is set up yet') });
    });

    it('asks for a key on this computer when the provider has none', () => {
        prefs.set('llmProvider', 'deepseek');
        expect(build()).toMatchObject({ ok: false, needsKey: true, message: expect.stringContaining('DeepSeek needs an API key') });
    });

    it('builds the preset provider with its default model and output budget once there is a key', () => {
        prefs.set('llmProvider', 'deepseek');
        keys.deepseek = 'sk-test';
        const built = build();
        expect(built).toMatchObject({ ok: true, providerId: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-flash', outputTokenLimit: 32_000 });
        if (built.ok) expect(built.provider.model).toBe('deepseek-flash');
    });

    it('runs a retired model as its successor, as AlphainZ does', () => {
        prefs.set('llmProvider', 'deepseek');
        prefs.set('llmModel', 'deepseek-v4-pro');
        keys.deepseek = 'sk-test';
        expect(build()).toMatchObject({ ok: true, model: 'deepseek-flash' });
    });

    it('honours the output-token setting, read through the runtime adapter', () => {
        prefs.set('llmProvider', 'deepseek');
        prefs.set('maxOutputTokens', 5000);
        keys.deepseek = 'sk-test';
        expect(build()).toMatchObject({ ok: true, outputTokenLimit: 5000 });
    });

    it('needs no key for Ollama', () => {
        prefs.set('llmProvider', 'ollama');
        prefs.set('llmModel', 'qwen3:8b');
        expect(build()).toMatchObject({ ok: true, providerId: 'ollama', model: 'qwen3:8b' });
    });

    it('names a provider this version does not know', () => {
        prefs.set('llmProvider', 'someone-else');
        expect(build()).toMatchObject({ ok: false, needsKey: false, message: expect.stringContaining('"someone-else"') });
    });

    it('speaks Chinese when Obsidian does', () => {
        setLanguageForTests('zh');
        prefs.set('llmProvider', 'deepseek');
        expect(build()).toMatchObject({ ok: false, message: 'DeepSeek 在这台电脑上还没有 API 密钥。请在 AlphainO 的设置里选一个或新建一个。' });
    });
});

describe('the model layer reads AlphainO settings', () => {
    it('falls back to AlphainZ defaults for keys never set', () => {
        expect(prefs.get('maxModelRequests')).toBe(24);
        expect(prefs.get('providerOverrides')).toBe('{}');
        expect(prefs.get('reasoningEffort')).toBe('low');
    });

    it('remembers that the chat was placed in the sidebar, and nothing else counts as placed', () => {
        expect(normalizeSettings({}).chatPlaced).toBe(false);
        expect(normalizeSettings({ chatPlaced: true }).chatPlaced).toBe(true);
        expect(normalizeSettings({ chatPlaced: 'yes' }).chatPlaced).toBe(false);
    });

    it('offers OpenCode Go, whose models need a key and think at Low at the least', () => {
        prefs.set('llmProvider', 'opencode-go');
        expect(build()).toMatchObject({ ok: false, needsKey: true, message: expect.stringContaining('OpenCode Go needs an API key') });
        keys['opencode-go'] = 'sk-test';
        expect(build()).toMatchObject({ ok: true, providerLabel: 'OpenCode Go', model: 'deepseek-v4.1-flash' });
    });

    it('stores only the secret names, never a key', () => {
        const restored = normalizeSettings({ keySecrets: { deepseek: 'my-deepseek', openai: '' }, prefs: { llmProvider: 'deepseek' } });
        expect(restored.keySecrets).toEqual({ deepseek: 'my-deepseek' });
    });
});
