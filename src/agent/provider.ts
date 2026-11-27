/**
 * The chat model the next question will use, assembled from AlphainO's
 * settings the way AlphainZ assembles it from Zotero's (`buildAgentFromPrefs`):
 * the same provider presets, retired-model successors, address overrides,
 * output budget and thinking tiers, all from @beaver/agent-llm.
 */
import {
    PROVIDER_PRESETS,
    presetCapabilities,
    presetSupportsVision,
    providerFromPreset,
    retireChoice,
    type ProviderPresetId,
} from '@beaver/agent-llm/openAICompatible';
import {
    DEFAULT_CUSTOM_MAX_TOKENS,
    customModelCapabilities,
    customProviderFromEndpoint,
    findCustomEndpoint,
    findCustomModel,
    isCustomProviderId,
} from '@beaver/agent-llm/customEndpoints';
import { baseUrlOverrideFor, hydrateProviderOverrides, readProviderOverrides } from '@beaver/agent-llm/providerOverrides';
import { modelThinkingTiers, presetModelOutputTokens } from '@beaver/agent-llm/modelTuning';
import { readRunLimits, resolveOutputTokens } from '@beaver/agent-llm/runLimits';
import { isThinkingTier, nearestTier } from '@beaver/agent-llm/thinkingTiers';
import type { ChatProvider } from '@beaver/agent-llm/types';
import type { PrefStore } from '../settings';
import { t } from '../i18n';

export type BuiltProvider =
    | {
          ok: true;
          provider: ChatProvider;
          /** A preset id, or `custom:<id>` for an endpoint added by hand. */
          providerId: string;
          providerLabel: string;
          model: string;
          /** The output cap each request carries. */
          outputTokenLimit: number;
          /** Whether the model reads images (AlphainZ's `modelReadsImages`). */
          supportsVision: boolean;
      }
    | { ok: false; message: string; needsKey: boolean };

/** Providers that run on this computer and take no key. */
export const KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(['ollama']);

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/** The OpenAI-compatible root Ollama serves under its base address. */
export function ollamaApiBaseUrl(prefs: PrefStore): string {
    const base = (prefs.string('ollamaBaseUrl') || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
    return base.endsWith('/v1') ? base : `${base}/v1`;
}

export function buildChatProvider(
    prefs: PrefStore,
    keyFor: (providerId: ProviderPresetId) => string,
    fetchImpl: typeof fetch,
): BuiltProvider {
    // A stored pair may name a retired provider or model; it runs as its successor.
    const stored = retireChoice(prefs.string('llmProvider'), prefs.string('llmModel'));
    const providerId = stored.provider;
    if (!providerId) {
        return { ok: false, needsKey: true, message: t('No model is set up yet. Choose a provider and its API key in AlphainO’s settings.') };
    }
    if (isCustomProviderId(providerId)) return buildCustomProvider(prefs, providerId, stored.model, fetchImpl);
    if (!(providerId in PROVIDER_PRESETS)) {
        return {
            ok: false,
            needsKey: false,
            message: t('The chosen provider "{provider}" is not one this version knows. Choose another in AlphainO’s settings.', { provider: providerId }),
        };
    }
    const id = providerId as ProviderPresetId;
    const preset = PROVIDER_PRESETS[id];
    const apiKey = KEYLESS_PROVIDERS.has(id) ? '' : keyFor(id);
    if (!KEYLESS_PROVIDERS.has(id) && !apiKey) {
        return {
            ok: false,
            needsKey: true,
            message: t('{provider} needs an API key on this computer. Choose or create one in AlphainO’s settings.', { provider: preset.label }),
        };
    }

    const model = stored.model || preset.defaultModel;
    const overrides = readProviderOverrides();
    hydrateProviderOverrides(overrides);
    const baseUrl = baseUrlOverrideFor(id, overrides) || (id === 'ollama' ? ollamaApiBaseUrl(prefs) : '');

    // What one reply may spend: the setting, or the provider's default, held
    // under what the provider accepts (see AlphainZ's buildAgentFromPrefs).
    const caps = presetCapabilities(id, model || undefined);
    const ownBudget = presetModelOutputTokens(id, model, overrides);
    const outputTokens = resolveOutputTokens(
        readRunLimits().outputTokens,
        ownBudget ?? caps.defaultMaxTokens ?? 4000,
        ownBudget !== undefined && caps.maxOutputTokens !== undefined
            ? Math.min(ownBudget, caps.maxOutputTokens)
            : ownBudget ?? caps.maxOutputTokens,
    );
    const tiers = modelThinkingTiers(id, model, overrides);
    const wanted = prefs.string('reasoningEffort');
    const effort = nearestTier(isThinkingTier(wanted) ? wanted : 'low', tiers);

    const provider = providerFromPreset(id, apiKey, fetchImpl as any, {
        ...(model ? { model } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(effort ? { extraBody: { reasoning_effort: effort } } : {}),
        supportsReasoningEffort: tiers.length > 0,
        ...(tiers.length > 0 ? { leastReasoningEffort: tiers[0] } : {}),
        maxTokens: outputTokens,
    });
    return {
        ok: true,
        provider,
        providerId: id,
        providerLabel: preset.label,
        model,
        outputTokenLimit: outputTokens,
        supportsVision: presetSupportsVision(id, model || undefined) === true,
    };
}

/** The thinking setting as the tier this model takes, sent only when it takes one (AlphainZ's `reasoningEffortBody`). */
function reasoningEffortBody(prefs: PrefStore, providerId: string, model: string): { extraBody: Record<string, unknown> } | Record<string, never> {
    const tiers = modelThinkingTiers(providerId, model);
    const wanted = prefs.string('reasoningEffort');
    const effort = nearestTier(isThinkingTier(wanted) ? wanted : 'low', tiers);
    return effort ? { extraBody: { reasoning_effort: effort } } : {};
}

/**
 * A model of an endpoint added by hand (Settings → Add custom provider), built
 * as AlphainZ's `buildAgentFromPrefs` builds it: the wire, key style and model
 * list the user gave, the model's own output cap as both default and ceiling.
 */
function buildCustomProvider(prefs: PrefStore, providerId: string, modelId: string, fetchImpl: typeof fetch): BuiltProvider {
    const endpoint = findCustomEndpoint(providerId);
    if (!endpoint) {
        return {
            ok: false,
            needsKey: true,
            // Endpoints carry keys, so they stay on the computer they were added on while the model choice syncs.
            message: t('The chosen model belongs to a custom provider that is not set up on this computer. Add it in AlphainO’s settings (Add custom provider), or pick another model.'),
        };
    }
    if (!modelId || !findCustomModel(endpoint, modelId)) {
        return {
            ok: false,
            needsKey: false,
            message: t('"{model}" is not one of the models of {provider}. Add it to that provider’s card in AlphainO’s settings, or pick another model.', {
                model: modelId || t('(none)'),
                provider: endpoint.name || endpoint.baseUrl,
            }),
        };
    }
    // A model's own declared cap is both its default and its ceiling: it is usually there because the endpoint refuses more.
    const declared = findCustomModel(endpoint, modelId)?.maxTokens;
    const outputTokens = resolveOutputTokens(readRunLimits().outputTokens, declared ?? DEFAULT_CUSTOM_MAX_TOKENS, declared);
    const provider = customProviderFromEndpoint(endpoint, modelId, fetchImpl as any, {
        ...reasoningEffortBody(prefs, providerId, modelId),
        maxTokens: outputTokens,
    });
    return {
        ok: true,
        provider,
        providerId,
        providerLabel: endpoint.name || endpoint.baseUrl || t('Custom endpoint'),
        model: modelId,
        outputTokenLimit: outputTokens,
        supportsVision: customModelCapabilities(providerId, modelId)?.supportsVision === true,
    };
}
