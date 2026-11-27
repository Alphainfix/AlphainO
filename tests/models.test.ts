import { beforeEach, describe, expect, it } from 'vitest';
import { groupByVendor, rowLabel } from '@beaver/agent-llm/modelChoices';
import { availableModels, selectedModel, shownEffort, thinkingTiersFor, type ModelHost } from '../src/agent/models';
import { installRuntime } from '../src/runtime';
import { PrefStore, normalizeSettings, type AlphainOSettings } from '../src/settings';
import { setLanguageForTests } from './obsidianStub';

let settings: AlphainOSettings;
let prefs: PrefStore;
const keys: Record<string, string> = {};
const host: ModelHost = { get prefs() { return prefs; }, apiKey: (id) => keys[id] ?? '' };

beforeEach(() => {
    settings = normalizeSettings({});
    prefs = new PrefStore(() => settings, () => {});
    installRuntime(prefs, false);
    for (const id of Object.keys(keys)) delete keys[id];
    setLanguageForTests('en');
});

describe('the composer’s models', () => {
    it('offers nothing before any key is set', () => {
        expect(availableModels(host)).toEqual([]);
        expect(selectedModel(host)).toBeNull();
    });

    it('lists the models of every provider with a key, under its vendor heading', () => {
        keys['opencode-go'] = 'k1';
        keys.zhipu = 'k2';
        const groups = groupByVendor(availableModels(host));
        expect(groups.map((g) => g.vendor)).toEqual(['OpenCode Go', 'Zhipu (BigModel)']);
        expect(groups[0].models.map((m) => m.snapshot)).toEqual([
            'deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k3.1-pro', 'minimax-m3.1-flash', 'deepseek-v4-pro', 'glm-5.3',
        ]);
        // Per model: OpenCode Go hosts text-only models beside ones that read figures.
        expect(rowLabel(groups[0].models[0])).toBe('deepseek-v4.1-flash · reads figures');
        expect(rowLabel(groups[0].models[4])).toBe('deepseek-v4-pro');
    });

    it('lists the Ollama models recorded on this computer, which need no key', () => {
        prefs.set('ollamaModels', JSON.stringify(['qwen3:8b']));
        expect(availableModels(host).map((m) => m.id)).toEqual(['local-ollama::qwen3:8b']);
    });

    it('chooses the first model on offer when nothing is chosen, and saves it for the runner', () => {
        keys['opencode-go'] = 'k1';
        expect(selectedModel(host)?.snapshot).toBe('deepseek-v4.1-flash');
        expect(prefs.get('llmProvider')).toBe('opencode-go');
        expect(prefs.get('llmModel')).toBe('deepseek-v4.1-flash');
    });

    it('keeps a choice whose key is missing here rather than switching silently', () => {
        keys.zhipu = 'k2';
        prefs.set('llmProvider', 'opencode-go');
        prefs.set('llmModel', 'glm-5.3-flash');
        expect(selectedModel(host)?.id).toBe('local-opencode-go::glm-5.3-flash');
        expect(prefs.get('llmProvider')).toBe('opencode-go');
    });

    it('offers OpenCode Go’s DeepSeek the tiers it takes, and shows the setting as one of them', () => {
        keys['opencode-go'] = 'k1';
        const model = selectedModel(host);
        expect(thinkingTiersFor(model)).toEqual(['low', 'high', 'max']);
        prefs.set('reasoningEffort', 'none');
        expect(shownEffort(prefs, model)).toBe('low');
        prefs.set('reasoningEffort', 'max');
        expect(shownEffort(prefs, model)).toBe('max');
    });
});
