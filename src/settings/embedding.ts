/**
 * Note search by meaning, as the settings see it: which embedding provider is
 * chosen (`embeddingProvider`, AlphainZ's setting), which key it uses, and
 * whether it can be used on this computer — the same rules AlphainZ applies
 * (`semanticSearchState` in its agentConfig), with keys from Obsidian's
 * secret storage.
 *
 * The note index builds its embedder from the same settings (main.ts).
 */
import { EMBEDDING_PRESETS, type EmbeddingPresetId } from '@beaver/agent-llm/embeddings';
import type { ProviderPresetId } from '@beaver/agent-llm/openAICompatible';
import type { PrefStore } from '../settings';
import { t } from '../i18n';
import { ollamaEmbeddingProblem } from './ollama';
import { ollamaBaseUrl } from './obsidianHost';

export interface EmbeddingKeySource {
    prefs: PrefStore;
    apiKey(providerId: ProviderPresetId): string;
}

export function isEmbeddingPresetId(id: string): id is EmbeddingPresetId {
    return Object.prototype.hasOwnProperty.call(EMBEDDING_PRESETS, id);
}

/**
 * The key an embedding option is used with, or '' when there is none:
 * Google's own embedding key first (`embeddingKeyGoogle`), then the Gemini
 * card's; the OpenAI card's for OpenAI; none for Ollama.
 */
export function embeddingKeyFor(source: EmbeddingKeySource, id: EmbeddingPresetId): string {
    if (id === 'ollama') return '';
    if (id === 'google') return source.prefs.string('embeddingKeyGoogle') || source.apiKey('google');
    return source.apiKey(id);
}

/**
 * `off` is the user's choice; `needs_key` and `unreachable` are faults with a
 * fix: a key this computer lacks (the choice travels with the vault, keys do
 * not), or an Ollama that did not answer, or lacks the model, when last asked.
 */
export type SemanticSearchState =
    | { status: 'ready'; provider: EmbeddingPresetId }
    | { status: 'off' }
    | { status: 'needs_key'; provider: Exclude<EmbeddingPresetId, 'ollama'>; label: string }
    | { status: 'unreachable'; provider: 'ollama'; reason: string };

export function semanticSearchState(source: EmbeddingKeySource): SemanticSearchState {
    const id = source.prefs.string('embeddingProvider');
    if (!id || !isEmbeddingPresetId(id)) return { status: 'off' };
    if (id === 'ollama') {
        const reason = ollamaEmbeddingProblem(ollamaBaseUrl(source.prefs));
        return reason ? { status: 'unreachable', provider: 'ollama', reason } : { status: 'ready', provider: 'ollama' };
    }
    if (embeddingKeyFor(source, id)) return { status: 'ready', provider: id };
    return { status: 'needs_key', provider: id, label: EMBEDDING_PRESETS[id].label };
}

/** What stands in the way of the chosen provider, as AlphainZ says it; null when nothing does. */
export function embeddingProviderProblem(state: SemanticSearchState): string | null {
    switch (state.status) {
        case 'ready':
            return null;
        case 'off':
            return t('No embedding provider is chosen.');
        case 'needs_key':
            return t('Embeddings are set to {provider}, but this computer has no {provider} API key.', { provider: state.label });
        case 'unreachable':
            return t('Embeddings are set to Ollama, but {reason}.', { reason: state.reason });
    }
}

/** The embedding model in use (its health record is kept under it), or null when topic search is off. */
export function currentEmbeddingModelId(source: EmbeddingKeySource): string | null {
    const state = semanticSearchState(source);
    return state.status === 'ready' ? EMBEDDING_PRESETS[state.provider].model : null;
}

/** "14:05", or "Oct 22, 14:05" for an earlier day: when a failure happened (as AlphainZ shows it). */
export function failureTimeText(at: number, now: number = Date.now()): string {
    const when = new Date(at);
    const time = `${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')}`;
    return new Date(now).toDateString() === when.toDateString()
        ? time
        : `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** The folders note search leaves out (`vaultExcludedFolders`, a JSON list of vault paths). */
export function excludedFolders(prefs: PrefStore): string[] {
    const raw = prefs.get('vaultExcludedFolders');
    try {
        const list = typeof raw === 'string' && raw ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
        return Array.isArray(list) ? list.map(String).map((folder) => folder.trim()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

export function setExcludedFolders(prefs: PrefStore, folders: string[]): void {
    prefs.set('vaultExcludedFolders', JSON.stringify([...new Set(folders)].sort((a, b) => a.localeCompare(b))));
}
