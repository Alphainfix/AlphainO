/**
 * The Obsidian side of the shared model settings (@beaver/agent-ui/settings):
 * where they read and write (the plugin's settings, keys in Obsidian's secret
 * storage — see `PrefStore`), how their requests reach the network (Node, so
 * no CORS is in the way), Obsidian's dialogs, and the model menu beside the
 * message box, which follows every settings change on its own.
 */
import type { App } from 'obsidian';
import { retireChoice, type ProviderPresetId } from '@beaver/agent-llm/openAICompatible';
import type { OllamaService, SettingsFetch, SettingsHost } from '@beaver/agent-ui/settings/host';
import { availableModels, ollamaModels, selectedModel } from '../agent/models';
import { nodeFetch } from '../agent/nodeFetch';
import { DEFAULT_OLLAMA_BASE_URL } from '../agent/provider';
import type { PrefStore } from '../settings';
import { t } from '../i18n';
import { confirmInModal } from './confirm';
import {
    OLLAMA_MODELS,
    cancelOllamaPull,
    isModelInstalled,
    isOllamaEmbeddingModel,
    normalizeOllamaBase,
    ollamaChatModels,
    ollamaPullState,
    ollamaPullsVersion,
    ollamaVersionAtLeast,
    onOllamaStatus,
    pullCommand,
    refreshOllamaStatus,
    startOllamaPull,
    subscribeOllamaPulls,
} from './ollama';

/** What the settings need from the plugin. */
export interface SettingsPlugin {
    app: App;
    prefs: PrefStore;
    apiKey(providerId: ProviderPresetId): string;
    requestSave(): void;
    onSettingsChange(listener: () => void): () => void;
}

export const settingsFetch = nodeFetch as unknown as SettingsFetch;

/** Ollama's address as set on its card, without a trailing slash; the local default when none is. */
export function ollamaBaseUrl(prefs: PrefStore): string {
    return (prefs.string('ollamaBaseUrl') || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
}

export function obsidianOllama(prefs: PrefStore): OllamaService {
    return {
        models: OLLAMA_MODELS,
        normalizeBase: normalizeOllamaBase,
        isEmbeddingModel: isOllamaEmbeddingModel,
        isModelInstalled,
        versionAtLeast: ollamaVersionAtLeast,
        pullCommand,
        refreshStatus: (base, fetchImpl) => refreshOllamaStatus(prefs, base, fetchImpl ?? settingsFetch),
        onStatus: onOllamaStatus,
        startPull: startOllamaPull,
        cancelPull: cancelOllamaPull,
        pullState: ollamaPullState,
        subscribePulls: subscribeOllamaPulls,
        pullsVersion: ollamaPullsVersion,
    };
}

/** The settings host for AlphainO. Made once per settings page; its functions keep their identity. */
export function obsidianSettingsHost(plugin: SettingsPlugin): SettingsHost {
    const { prefs } = plugin;
    // The model menu re-reads the settings on every change; what is left is
    // AlphainZ's first-key rule: with nothing chosen yet, the first model on
    // offer is chosen and saved.
    const refresh = () => {
        selectedModel(plugin);
        plugin.requestSave();
    };
    return {
        getPref: (key) => prefs.get(key),
        setPref: (key, value) => prefs.set(key, value),
        fetch: settingsFetch,
        confirm: (title, text, confirmLabel) => confirmInModal(plugin.app, title, text, confirmLabel),
        openUrl: (url) => {
            window.open(url);
        },
        copyText: async (text) => {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                return false;
            }
        },
        models: {
            refresh,
            releaseRemoved: (providerIds) => {
                // A choice that used a removed provider moves to the first model still on offer.
                const inUse = retireChoice(prefs.string('llmProvider'), prefs.string('llmModel')).provider;
                if (inUse && providerIds.includes(inUse)) {
                    prefs.set('llmProvider', '');
                    prefs.set('llmModel', '');
                }
                refresh();
            },
            afterRemoving: (providerIds) => {
                const remaining = availableModels(plugin).filter((model) => !providerIds.includes(String(model.provider)));
                return remaining.find((model) => model.is_default) ?? remaining[0] ?? null;
            },
            ollamaModels: () => ollamaChatModels(ollamaModels(prefs)),
        },
        ollama: obsidianOllama(prefs),
        ollamaBaseUrl: () => ollamaBaseUrl(prefs),
        choiceTravelsNote: () =>
            t('If this vault syncs to other computers, they switch to it too, so it has to be set up on each of them.'),
        keysNote: t(
            'Keys stay on this computer, in Obsidian’s secret storage; the vault records only their names, so each computer it syncs to needs its own keys. Addresses, catalogues and the choice of model are kept in the plugin’s settings and travel with the vault.',
        ),
    };
}
