/**
 * The Obsidian side of AlphainZ's model settings: removing a provider moves
 * the model in use the way AlphainZ moves it, the Ollama card lists only chat
 * models, note search reads its provider and key as main.ts does, and the
 * shared components read in AlphainZ's Chinese.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    // The settings' dialogs; these tests never open them.
    Modal: class {},
    FuzzySuggestModal: class {},
}));

import type { ProviderPresetId } from '@beaver/agent-llm/openAICompatible';
import { t as sharedT } from '@beaver/agent-ui/i18n';
import { ZH_CN } from '@alphainz/i18n/zh-CN';
import { installRuntime } from '../src/runtime';
import { PrefStore, normalizeSettings, type AlphainOSettings, type SecretStore } from '../src/settings';
import { obsidianSettingsHost, type SettingsPlugin } from '../src/settings/obsidianHost';
import {
    embeddingKeyFor,
    embeddingProviderProblem,
    excludedFolders,
    semanticSearchState,
    setExcludedFolders,
} from '../src/settings/embedding';
import { recordOllamaStatus } from '../src/settings/ollama';
import { t } from '../src/i18n';
import { setLanguageForTests } from './obsidianStub';

let settings: AlphainOSettings;
let prefs: PrefStore;
let secrets: Map<string, string>;
let plugin: SettingsPlugin;
let saves: number;

beforeEach(() => {
    settings = normalizeSettings({});
    secrets = new Map();
    const store: SecretStore = {
        getSecret: (id) => secrets.get(id) ?? null,
        setSecret: (id, value) => { secrets.set(id, value); },
    };
    saves = 0;
    prefs = new PrefStore(() => settings, () => { saves += 1; }, store);
    installRuntime(prefs, false);
    setLanguageForTests('en');
    plugin = {
        app: {} as SettingsPlugin['app'],
        prefs,
        apiKey: (id: ProviderPresetId) => {
            const name = settings.keySecrets[id];
            return name ? (secrets.get(name) ?? '').trim() : '';
        },
        requestSave: () => { saves += 1; },
        onSettingsChange: () => () => {},
    };
});

describe('removing the provider in use', () => {
    it('names the model that takes over, and moves the choice there', () => {
        prefs.set('llmKeyOpenrouter', 'k-or');
        prefs.set('llmKeyDeepseek', 'k-d');
        prefs.set('llmProvider', 'openrouter');
        prefs.set('llmModel', 'z-ai/glm-5.3-flash');
        const host = obsidianSettingsHost(plugin);
        expect(host.models.afterRemoving(['openrouter'])?.name).toBe('DeepSeek · deepseek-flash');
        prefs.set('llmKeyOpenrouter', '');
        host.models.releaseRemoved(['openrouter']);
        expect(settings.prefs).toMatchObject({ llmProvider: 'deepseek', llmModel: 'deepseek-flash' });
    });

    it('leaves a choice elsewhere alone, and says nothing takes over when nothing is left', () => {
        prefs.set('llmKeyDeepseek', 'k-d');
        prefs.set('llmProvider', 'deepseek');
        prefs.set('llmModel', 'deepseek-flash');
        const host = obsidianSettingsHost(plugin);
        host.models.releaseRemoved(['openrouter']);
        expect(settings.prefs).toMatchObject({ llmProvider: 'deepseek', llmModel: 'deepseek-flash' });
        expect(host.models.afterRemoving(['deepseek'])).toBeNull();
    });

    it('gives the first key\'s first model to a fresh setup, as AlphainZ does', () => {
        prefs.set('llmKeyZhipu', 'zk');
        obsidianSettingsHost(plugin).models.refresh();
        expect(settings.prefs.llmProvider).toBe('zhipu');
    });
});

describe('the Ollama card', () => {
    it('lists the chat models only, never one that only embeds', () => {
        prefs.set('ollamaModels', JSON.stringify(['qwen2.5:7b', 'embeddinggemma-2:440m-q8_0-text-vision', 'bge-m3:latest']));
        expect(obsidianSettingsHost(plugin).models.ollamaModels()).toEqual(['qwen2.5:7b']);
    });

    it('records what a reading found: chat models for the menu, and whether note search can embed', () => {
        prefs.set('embeddingProvider', 'ollama');
        recordOllamaStatus(prefs, 'http://127.0.0.1:11434', { running: true, version: '0.40.1', models: ['qwen2.5:7b'] });
        expect(settings.prefs.ollamaModels).toBe(JSON.stringify(['qwen2.5:7b']));
        expect(semanticSearchState(plugin)).toMatchObject({ status: 'unreachable', reason: expect.stringContaining('not installed') });
        recordOllamaStatus(prefs, 'http://127.0.0.1:11434/', {
            running: true,
            version: '0.40.1',
            models: ['qwen2.5:7b', 'embeddinggemma-2:440m-q8_0-text-vision'],
        });
        expect(semanticSearchState(plugin)).toEqual({ status: 'ready', provider: 'ollama' });
        recordOllamaStatus(prefs, 'http://127.0.0.1:11434', { running: false, version: null, models: [] });
        expect(embeddingProviderProblem(semanticSearchState(plugin))).toBe('Embeddings are set to Ollama, but Ollama is not running on this computer.');
    });
});

describe('note search\'s provider and key', () => {
    it('is off until chosen', () => {
        expect(semanticSearchState(plugin)).toEqual({ status: 'off' });
    });

    it('needs the vendor\'s key on this computer, and says so', () => {
        prefs.set('embeddingProvider', 'openai');
        expect(semanticSearchState(plugin)).toEqual({ status: 'needs_key', provider: 'openai', label: 'OpenAI' });
        prefs.set('llmKeyOpenai', 'sk-o');
        expect(semanticSearchState(plugin)).toEqual({ status: 'ready', provider: 'openai' });
        expect(embeddingKeyFor(plugin, 'openai')).toBe('sk-o');
    });

    it('takes Google\'s own embedding key before the Gemini card\'s', () => {
        prefs.set('embeddingProvider', 'google');
        prefs.set('llmKeyGoogle', 'g-chat');
        expect(embeddingKeyFor(plugin, 'google')).toBe('g-chat');
        prefs.set('embeddingKeyGoogle', 'g-embed');
        expect(embeddingKeyFor(plugin, 'google')).toBe('g-embed');
        // The secret main.ts reads: keySecrets.embeddingKeyGoogle.
        expect(secrets.get(settings.keySecrets.embeddingKeyGoogle!)).toBe('g-embed');
    });
});

describe('excluded folders', () => {
    it('are kept as AlphainO\'s note search reads them: a sorted JSON list, each once', () => {
        setExcludedFolders(prefs, ['Templates', 'Journal', 'Templates']);
        expect(settings.prefs.vaultExcludedFolders).toBe(JSON.stringify(['Journal', 'Templates']));
        expect(excludedFolders(prefs)).toEqual(['Journal', 'Templates']);
        settings.prefs.vaultExcludedFolders = 'not json';
        expect(excludedFolders(prefs)).toEqual([]);
    });
});

describe('the shared components in Chinese', () => {
    it('read as they do in AlphainZ, with AlphainO\'s table only where AlphainZ\'s has nothing', () => {
        setLanguageForTests('zh-CN');
        expect(sharedT('API key')).toBe(ZH_CN['API key']);
        expect(sharedT('Thinking')).toBe(ZH_CN['Thinking']);
        expect(sharedT('{label} API key', { label: 'DeepSeek' })).toBe(ZH_CN['{label} API key'].replace('{label}', 'DeepSeek'));
        // The chat says Thinking / Thoughts as AlphainZ does (思考 / 思考过程), with no wording of its own.
        expect(t('Thinking')).toBe(ZH_CN['Thinking']);
        expect(t('Thoughts')).toBe(ZH_CN['Thoughts']);
        // AlphainO's table answers for what AlphainZ's lacks.
        expect(sharedT('Note search')).toBe('笔记搜索');
    });
});
