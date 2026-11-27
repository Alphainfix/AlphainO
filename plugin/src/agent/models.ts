/**
 * Which models the composer offers and which one answers, decided by the
 * shared model choices (@beaver/agent-llm/modelChoices) exactly as AlphainZ
 * decides them: every model a key on this computer reaches, the same names,
 * the same grouping, the same thinking tiers. Only where the keys live is
 * AlphainO's own (Obsidian's secret storage).
 */
import type { ModelConfig } from '@beaver/agent-core/types/models';
import {
    currentModelChoice,
    dedupeByEndpoint,
    localModelChoices,
    saveModelChoice,
    type ModelChoiceSources,
} from '@beaver/agent-llm/modelChoices';
import { modelThinkingTiers } from '@beaver/agent-llm/modelTuning';
import { isThinkingTier, nearestTier, type ThinkingTier } from '@beaver/agent-llm/thinkingTiers';
import type { ProviderPresetId } from '@beaver/agent-llm/openAICompatible';
import type { PrefStore } from '../settings';
import { KEYLESS_PROVIDERS } from './provider';

export interface ModelHost {
    prefs: PrefStore;
    apiKey(providerId: ProviderPresetId): string;
}

/** The Ollama chat models recorded in the settings (by Detect models, or typed). */
export function ollamaModels(prefs: PrefStore): string[] {
    const raw = prefs.get('ollamaModels');
    try {
        const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
        return Array.isArray(parsed) ? parsed.map(String).map((name) => name.trim()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

export function modelSources(host: ModelHost): ModelChoiceSources {
    return {
        hasKey: (id) => KEYLESS_PROVIDERS.has(id) || host.apiKey(id) !== '',
        ollamaModels: () => ollamaModels(host.prefs),
    };
}

/** Every model the keys on this computer reach, each endpoint and model once. */
export function availableModels(host: ModelHost): ModelConfig[] {
    return dedupeByEndpoint(localModelChoices(modelSources(host)));
}

/**
 * The model the next question goes to: what the settings name, as the list's
 * own entry when it is listed. Only when nothing is chosen yet — a fresh setup
 * whose first key was just added — is a default picked and saved, the first
 * model on offer; a choice whose key is missing here stays chosen, and the
 * send reports what is missing (as in AlphainZ).
 */
export function selectedModel(host: ModelHost): ModelConfig | null {
    const models = availableModels(host);
    const chosen = currentModelChoice();
    if (chosen) return models.find((model) => model.id === chosen.id) ?? chosen;
    const first = models.find((model) => model.is_default) ?? models[0];
    if (!first) return null;
    saveModelChoice(first);
    return first;
}

export function chooseModel(model: ModelConfig): void {
    saveModelChoice(model);
}

/** The thinking tiers a model takes, in order; empty for one that takes none. */
export function thinkingTiersFor(model: ModelConfig | null): ThinkingTier[] {
    return model ? modelThinkingTiers(String(model.provider), model.snapshot ?? '') : [];
}

/** The thinking setting (one for every model), as stored. */
export function storedEffort(prefs: PrefStore): ThinkingTier {
    const raw = prefs.string('reasoningEffort');
    return isThinkingTier(raw) ? raw : 'low';
}

/** The setting as the tier this model actually gets. */
export function shownEffort(prefs: PrefStore, model: ModelConfig | null): ThinkingTier | null {
    const tiers = thinkingTiersFor(model);
    if (tiers.length === 0) return null;
    return nearestTier(storedEffort(prefs), tiers) ?? null;
}
