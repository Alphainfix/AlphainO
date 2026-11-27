/**
 * The embedding model the index and its queries use.
 *
 * `NoteEmbedder` is the small surface the index needs; `buildNoteEmbedder`
 * makes one from AlphainZ's embedding presets (OpenAI, Google Gemini,
 * Ollama), with the same pacing for a free Google key and the same record of
 * how requests ended that AlphainZ keeps.
 */
import {
    EMBEDDING_PRESETS,
    embeddingProviderFromPreset,
    quantizeToInt8,
    type EmbeddingPresetId,
    type EmbeddingProvider,
    type EmbeddingProviderConfig,
    type EmbeddingRequestOutcome,
    type FetchLike,
} from '@beaver/agent-llm/embeddings';
import { noteEmbeddingOutcome } from '@beaver/agent-llm/embeddingHealth';
import { geminiIndexPacing } from '@beaver/agent-llm/embeddingQuota';
import { t } from '../i18n';

export interface NoteEmbedder {
    /**
     * Names the model and its vector length (`gemini-embedding-2-int8-512`).
     * Vectors with different ids are never compared: a new id means every
     * passage is embedded again.
     */
    readonly modelId: string;
    /** The provider's name, for messages. */
    readonly label: string;
    /** Length of every vector, when the id says. */
    readonly dimensions?: number;
    /** int8 vectors for passages, in order. The model's document prompt is applied. */
    embedDocuments(texts: string[], signal?: AbortSignal): Promise<Int8Array[]>;
    /** The int8 vector for a search query. The model's query prompt is applied. */
    embedQuery(text: string, signal?: AbortSignal): Promise<Int8Array>;
    /** Whether the model embeds pictures, in the same space as its texts (Gemini Embedding 2, EmbeddingGemma 2). */
    readonly embedsImages?: boolean;
    /** int8 vectors for pictures, in order, compared with `embedQuery`'s. Only when `embedsImages`. */
    embedImages?(images: Array<{ mimeType: string; base64: string }>, signal?: AbortSignal): Promise<Int8Array[]>;
}

/** Wraps an AlphainZ embedding provider. */
export function embedderFromProvider(provider: EmbeddingProvider, label: string): NoteEmbedder {
    const sized = /-int8-(\d+)$/.exec(provider.modelId);
    return {
        modelId: provider.modelId,
        label,
        ...(sized ? { dimensions: Number(sized[1]) } : {}),
        async embedDocuments(texts, signal) {
            const response = await provider.generateEmbeddings(
                texts.map((text, index) => ({ item_id: index, text })),
                signal,
            );
            const byIndex = new Map<number, Int8Array>();
            for (const result of response.embeddings) byIndex.set(result.item_id, Int8Array.from(quantizeToInt8(result.embedding)));
            const vectors: Int8Array[] = [];
            for (let i = 0; i < texts.length; i += 1) {
                const vector = byIndex.get(i);
                if (!vector) throw new Error(`${label} returned ${response.embeddings.length} embeddings for ${texts.length} texts.`);
                vectors.push(vector);
            }
            return vectors;
        },
        async embedQuery(text, signal) {
            const result = await provider.generateQueryEmbedding(text, signal);
            return Int8Array.from(quantizeToInt8(result.embedding));
        },
        embedsImages: provider.embedsImages,
        async embedImages(images, signal) {
            const response = await provider.generateImageEmbeddings(
                images.map((image, index) => ({ item_id: index, mimeType: image.mimeType, base64: image.base64 })),
                signal,
            );
            const byIndex = new Map<number, Int8Array>();
            for (const result of response.embeddings) byIndex.set(result.item_id, Int8Array.from(quantizeToInt8(result.embedding)));
            const vectors: Int8Array[] = [];
            for (let i = 0; i < images.length; i += 1) {
                const vector = byIndex.get(i);
                if (!vector) throw new Error(`${label} returned ${response.embeddings.length} embeddings for ${images.length} pictures.`);
                vectors.push(vector);
            }
            return vectors;
        },
    };
}

export interface NoteEmbedderSettings {
    /** An id from `EMBEDDING_PRESETS` ('openai', 'google', 'ollama'). */
    preset: string;
    /** The provider's API key; Ollama takes none. */
    apiKey: string;
    /** Another model of the same provider than the preset's. Its prompts are left off: the preset's belong to the preset's model. */
    model?: string;
    /** Another vector length than the preset's. */
    dimensions?: number;
    /** Another address: the Ollama server, or any OpenAI-compatible endpoint. */
    baseUrl?: string;
}

export type BuiltEmbedder =
    | { ok: true; embedder: NoteEmbedder }
    | { ok: false; message: string; needsKey: boolean };

export function isEmbeddingPreset(id: string): id is EmbeddingPresetId {
    return Object.prototype.hasOwnProperty.call(EMBEDDING_PRESETS, id);
}

export function buildNoteEmbedder(settings: NoteEmbedderSettings, fetchImpl: typeof fetch): BuiltEmbedder {
    const id = settings.preset;
    if (!isEmbeddingPreset(id)) {
        return {
            ok: false,
            needsKey: false,
            message: t('The chosen provider "{provider}" is not one this version knows. Choose another in AlphainO’s settings.', { provider: id }),
        };
    }
    const preset = EMBEDDING_PRESETS[id];
    const apiKey = settings.apiKey.trim();
    if (id !== 'ollama' && !apiKey) {
        return {
            ok: false,
            needsKey: true,
            message: t('{provider} needs an API key on this computer. Choose or create one in AlphainO’s settings.', { provider: preset.label }),
        };
    }

    const model = settings.model?.trim() ?? '';
    const ownModel = model !== '' && model !== preset.model;
    const pacing = id === 'google' ? geminiIndexPacing(apiKey, preset.label) : null;
    const onRequest = (outcome: EmbeddingRequestOutcome) => {
        // Keeping the books must never fail a request.
        try {
            noteEmbeddingOutcome(ownModel ? model : preset.model, preset.label, outcome);
            pacing?.onRequest(outcome);
        } catch {
            // no settings to write to
        }
    };
    const overrides: Partial<EmbeddingProviderConfig> = {
        onRequest,
        ...(pacing ? { beforeIndexBatch: pacing.beforeIndexBatch } : {}),
        // A model of the user's own choosing is not sent pictures: only the presets' models are known to take them.
        ...(ownModel ? { model, queryPrefix: '', documentPrefix: '', imageWire: undefined } : {}),
        ...(settings.dimensions && settings.dimensions > 0 ? { dimensions: settings.dimensions } : {}),
        ...(settings.baseUrl?.trim() ? { baseUrl: settings.baseUrl.trim() } : {}),
    };
    const provider = embeddingProviderFromPreset(id, apiKey, fetchImpl as unknown as FetchLike, overrides);
    return { ok: true, embedder: embedderFromProvider(provider, preset.label) };
}
