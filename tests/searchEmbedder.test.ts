import { beforeEach, describe, expect, it } from 'vitest';
import { readEmbeddingHealth } from '@beaver/agent-llm/embeddingHealth';
import { isModelRequestError } from '@beaver/agent-llm/sse';
import { buildNoteEmbedder, embedderFromProvider, isEmbeddingPreset } from '../src/search/embedder';
import { installRuntime } from '../src/runtime';
import { PrefStore, normalizeSettings, type AlphainOSettings } from '../src/settings';

interface Sent {
    url: string;
    headers: Record<string, string>;
    body: any;
}

/** A fetch that answers every request with `answer` and remembers what was sent. */
function fakeFetch(answer: (sent: Sent) => { status: number; body: unknown }) {
    const sent: Sent[] = [];
    const fetchImpl = (async (url: string, init: Record<string, any>) => {
        const request: Sent = { url, headers: init.headers, body: JSON.parse(init.body) };
        sent.push(request);
        const { status, body } = answer(request);
        return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch;
    return { fetchImpl, sent };
}

/** One float vector of `dims` numbers per input, in the shape of each wire. */
function vectors(count: number, dims: number, wire: 'openai' | 'gemini') {
    const rows = Array.from({ length: count }, (_, i) => Array.from({ length: dims }, (_, d) => Math.sin(i + d) * 0.37));
    return wire === 'gemini'
        ? { embeddings: rows.map((values) => ({ values })) }
        : { data: rows.map((embedding, index) => ({ index, embedding })) };
}

let settings: AlphainOSettings;
beforeEach(() => {
    settings = normalizeSettings({});
    installRuntime(new PrefStore(() => settings, () => {}), false);
});

describe('buildNoteEmbedder', () => {
    it('embeds documents and queries with the Gemini prompts, as int8 vectors of the preset’s length', async () => {
        const { fetchImpl, sent } = fakeFetch((request) => ({
            status: 200,
            body: vectors(request.body.requests.length, 512, 'gemini'),
        }));
        const built = buildNoteEmbedder({ preset: 'google', apiKey: 'key-1' }, fetchImpl);
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        const { embedder } = built;
        expect(embedder.modelId).toBe('gemini-embedding-2-int8-512');
        expect(embedder.dimensions).toBe(512);
        expect(embedder.label).toBe('Google Gemini');

        const docs = await embedder.embedDocuments(['first', 'second']);
        expect(docs).toHaveLength(2);
        expect(docs[0]).toBeInstanceOf(Int8Array);
        expect(docs[0]).toHaveLength(512);
        expect(Math.max(...docs[0].map(Math.abs))).toBe(127);
        expect(sent[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents');
        expect(sent[0].headers['x-goog-api-key']).toBe('key-1');
        expect(sent[0].body.requests.map((r: any) => r.content.parts[0].text)).toEqual(['title: none | text: first', 'title: none | text: second']);

        const query = await embedder.embedQuery('what bees eat');
        expect(query).toHaveLength(512);
        expect(sent[1].body.requests[0].content.parts[0].text).toBe('task: search result | query: what bees eat');
    });

    it('uses OpenAI’s embeddings endpoint with the preset’s model and length, and no prompts', async () => {
        const { fetchImpl, sent } = fakeFetch((request) => ({ status: 200, body: vectors(request.body.input.length, 512, 'openai') }));
        const built = buildNoteEmbedder({ preset: 'openai', apiKey: 'sk-1' }, fetchImpl);
        if (!built.ok) throw new Error(built.message);
        await built.embedder.embedDocuments(['a', 'b', 'c']);
        expect(sent[0].url).toBe('https://api.openai.com/v1/embeddings');
        expect(sent[0].headers.Authorization).toBe('Bearer sk-1');
        expect(sent[0].body).toEqual({ model: 'text-embedding-3-large', input: ['a', 'b', 'c'], dimensions: 512 });
        expect(built.embedder.modelId).toBe('text-embedding-3-large-int8-512');
    });

    it('needs no key for Ollama and reaches it at the address given', async () => {
        const { fetchImpl, sent } = fakeFetch((request) => ({ status: 200, body: vectors(request.body.input.length, 768, 'openai') }));
        const built = buildNoteEmbedder({ preset: 'ollama', apiKey: '', baseUrl: 'http://localhost:11500' }, fetchImpl);
        if (!built.ok) throw new Error(built.message);
        await built.embedder.embedQuery('q');
        expect(sent[0].url).toBe('http://localhost:11500/v1/embeddings');
        expect(built.embedder.dimensions).toBe(768);
        expect(sent[0].body.input[0]).toBe('task: search result | query: q');
    });

    it('asks for a key when the provider needs one and none is set', () => {
        const { fetchImpl } = fakeFetch(() => ({ status: 200, body: {} }));
        expect(buildNoteEmbedder({ preset: 'openai', apiKey: '  ' }, fetchImpl)).toMatchObject({
            ok: false,
            needsKey: true,
            message: expect.stringContaining('OpenAI needs an API key'),
        });
    });

    it('names a provider it does not know', () => {
        const { fetchImpl } = fakeFetch(() => ({ status: 200, body: {} }));
        expect(buildNoteEmbedder({ preset: 'nope', apiKey: 'k' }, fetchImpl)).toMatchObject({ ok: false, needsKey: false });
        expect(isEmbeddingPreset('google')).toBe(true);
        expect(isEmbeddingPreset('nope')).toBe(false);
        expect(isEmbeddingPreset('toString')).toBe(false);
    });

    it('lets the model and the vector length be changed, and drops the preset’s prompts for another model', async () => {
        const { fetchImpl, sent } = fakeFetch((request) => ({ status: 200, body: vectors(request.body.requests.length, 256, 'gemini') }));
        const built = buildNoteEmbedder({ preset: 'google', apiKey: 'k', model: 'other-embed', dimensions: 256 }, fetchImpl);
        if (!built.ok) throw new Error(built.message);
        expect(built.embedder.modelId).toBe('other-embed-int8-256');
        await built.embedder.embedDocuments(['plain']);
        expect(sent[0].body.requests[0].content.parts[0].text).toBe('plain');
        expect(sent[0].body.requests[0].outputDimensionality).toBe(256);
    });

    it('fails with the provider’s status, and records that it did', async () => {
        const { fetchImpl } = fakeFetch(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
        const built = buildNoteEmbedder({ preset: 'openai', apiKey: 'sk-bad' }, fetchImpl);
        if (!built.ok) throw new Error(built.message);
        const failure = await built.embedder.embedDocuments(['a']).catch((error) => error);
        expect(isModelRequestError(failure)).toBe(true);
        expect(failure.status).toBe(401);
        expect(readEmbeddingHealth('text-embedding-3-large')?.reason).toContain('rejected the API key');
    });

    it('reports a reply with too few vectors as an error', async () => {
        const { fetchImpl } = fakeFetch(() => ({ status: 200, body: vectors(1, 512, 'openai') }));
        const built = buildNoteEmbedder({ preset: 'openai', apiKey: 'sk' }, fetchImpl);
        if (!built.ok) throw new Error(built.message);
        await expect(built.embedder.embedDocuments(['a', 'b'])).rejects.toThrow();
    });
});

describe('embedderFromProvider', () => {
    it('quantises whatever the provider returns to int8', async () => {
        const provider = {
            modelId: 'custom-model',
            generateEmbeddings: async (items: Array<{ item_id: number }>) => ({
                embeddings: items.map((item) => ({ item_id: item.item_id, embedding: [0.5, -0.25, 0.1], dimensions: 3 })),
                model_id: 'custom-model',
            }),
            generateQueryEmbedding: async () => ({ embedding: [1, -1, 0.5], dimensions: 3 }),
        };
        const embedder = embedderFromProvider(provider as never, 'Custom');
        expect(embedder.dimensions).toBeUndefined();
        expect(Array.from((await embedder.embedDocuments(['x']))[0])).toEqual([127, -63, 25]);
        expect(Array.from(await embedder.embedQuery('q'))).toEqual([127, -127, 64]);
    });
});
