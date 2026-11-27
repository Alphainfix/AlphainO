/**
 * The search benchmark behind the README's accuracy table (docs/benchmark).
 *
 * The demo vault's notes and pictures are indexed by AlphainO's own NoteIndex and ImageIndex with a real
 * embedding model, and the 36 questions in docs/benchmark/queries.json are run against them. No language
 * model is involved. Obsidian's built-in search is played by its rule: every word of the query must occur in
 * the note (its text or its path), case aside.
 *
 *   npm run benchmark                          EmbeddingGemma 2 in Ollama at 127.0.0.1:11434
 *   GEMINI_API_KEY=... npm run benchmark       Gemini Embedding 2 as well
 *   BENCH_MODELS=gemini npm run benchmark      only one of them (ollama | gemini)
 *
 * Writes docs/benchmark/results/<model>.json. Pictures are sent as stored (PNG); in Obsidian the plugin
 * first re-encodes them to JPEG of at most 1024 pixels, which these already fit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { buildNoteEmbedder, type NoteEmbedderSettings } from '../../src/search/embedder';
import { ImageIndex } from '../../src/search/imageIndex';
import { MemoryImageStore } from '../../src/search/imageStore';
import { NoteIndex } from '../../src/search/noteIndex';
import { MemoryIndexStore } from '../../src/search/store';
import type { SearchMode } from '../../src/search/types';
import { FakeNoteVault } from '../obsidianStub';

const here = path.dirname(fileURLToPath(import.meta.url));
// docs/ sits next to the plugin in this repository, and one level up in the public one (plugin/).
const BENCH = [path.resolve(here, '../../docs/benchmark'), path.resolve(here, '../../../docs/benchmark')].find((dir) =>
    fs.existsSync(path.join(dir, 'queries.json')),
)!;
const VAULT = path.join(BENCH, 'vault');

interface Query {
    id: string;
    kind: 'text' | 'keyword' | 'picture';
    lang: 'en' | 'zh';
    query: string;
    target: string;
}

interface Row extends Query {
    /** Rank of the target by meaning alone (a note among notes, a picture among pictures); null when missing. */
    rank: number | null;
    /** The first three notes or pictures found by meaning. */
    top: string[];
    /** Text questions: the rank in each search mode. */
    ranks?: Partial<Record<SearchMode, number | null>>;
    /** Text questions: whether Obsidian's search lists the target note. */
    obsidian: boolean | null;
}

/** The demo vault on disk, read into the stand-in vault; pictures keep their real bytes. */
class DiskVault extends FakeNoteVault {
    private readonly bytes = new Map<string, Uint8Array>();
    readonly notes: Array<{ path: string; text: string }> = [];

    load(root: string): this {
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                const rel = path.relative(root, full).split(path.sep).join('/');
                if (entry.isDirectory()) walk(full);
                else if (rel.endsWith('.md')) {
                    const text = fs.readFileSync(full, 'utf8');
                    this.write(rel, text, { silent: true });
                    this.notes.push({ path: rel, text });
                } else {
                    const data = new Uint8Array(fs.readFileSync(full));
                    const file = this.write(rel, '', { silent: true });
                    file.stat.size = data.byteLength;
                    this.bytes.set(rel, data);
                }
            }
        };
        walk(root);
        return this;
    }

    override async readBinary(file: { path: string }): Promise<ArrayBuffer> {
        const data = this.bytes.get(file.path);
        if (!data) return super.readBinary(file);
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    }
}

/** Obsidian's search: every word of the query occurs in the note's path or text, ignoring case. */
function obsidianFinds(vault: DiskVault, query: string, target: string): boolean {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return vault.notes.some((note) => note.path === target && terms.every((term) => `${note.path}\n${note.text}`.toLowerCase().includes(term)));
}

function rankOf(paths: string[], target: string): number | null {
    const unique = [...new Set(paths)];
    const at = unique.indexOf(target);
    return at < 0 ? null : at + 1;
}

const MODELS: Array<{ name: string; key: string; settings: () => NoteEmbedderSettings | null }> = [
    { name: 'embeddinggemma-2', key: 'ollama', settings: () => ({ preset: 'ollama', apiKey: '' }) },
    {
        name: 'gemini-embedding-2',
        key: 'gemini',
        settings: () => (process.env.GEMINI_API_KEY ? { preset: 'google', apiKey: process.env.GEMINI_API_KEY } : null),
    },
];
const wanted = (process.env.BENCH_MODELS ?? 'ollama,gemini').split(',').map((s) => s.trim());

describe('search benchmark', () => {
    const queries: Query[] = JSON.parse(fs.readFileSync(path.join(BENCH, 'queries.json'), 'utf8')).queries;

    for (const model of MODELS) {
        const settings = wanted.includes(model.key) ? model.settings() : null;
        it.skipIf(!settings)(model.name, async () => {
            const built = buildNoteEmbedder(settings!, fetch);
            if (!built.ok) throw new Error(built.message);
            const vault = new DiskVault().load(VAULT);
            const app = { vault, metadataCache: { resolvedLinks: {}, getFirstLinkpathDest: () => null } } as unknown as App;
            const log = (...args: unknown[]) => console.log('[bench]', ...args);
            const notes = new NoteIndex({ app, store: new MemoryIndexStore(), embedder: built.embedder, debounceMs: 5, log });
            const pictures = new ImageIndex({
                app,
                store: new MemoryImageStore(),
                embedder: built.embedder,
                enabled: true,
                debounceMs: 5,
                waitForTurn: () => notes.whenIdle(),
                prepare: async (bytes, extension) => ({
                    mimeType: extension === 'png' ? 'image/png' : 'image/jpeg',
                    base64: Buffer.from(bytes).toString('base64'),
                    width: 0,
                    height: 0,
                }),
                log,
            });
            await notes.start();
            await notes.whenIdle();
            await pictures.start();
            await pictures.whenIdle();
            const status = pictures.status();
            expect(status.lastError ?? null).toBeNull();

            const rows: Row[] = [];
            for (const q of queries) {
                if (q.kind === 'picture') {
                    const found = await pictures.search(q.query, { limit: 20 });
                    const paths = found.hits.map((hit) => hit.path);
                    rows.push({ ...q, rank: rankOf(paths, q.target), top: [...new Set(paths)].slice(0, 3), obsidian: null });
                    continue;
                }
                const ranks: Partial<Record<SearchMode, number | null>> = {};
                let top: string[] = [];
                for (const mode of ['semantic', 'keyword', 'hybrid'] as SearchMode[]) {
                    const found = await notes.searchDetailed(q.query, { mode, limit: 50 });
                    const paths = found.hits.map((hit) => hit.path);
                    ranks[mode] = rankOf(paths, q.target);
                    if (mode === 'semantic') top = [...new Set(paths)].slice(0, 3);
                }
                rows.push({ ...q, rank: ranks.semantic ?? null, top, ranks, obsidian: obsidianFinds(vault, q.query, q.target) });
            }
            await pictures.stop();
            await notes.stop();

            const pick = (kind: string, lang?: string) => rows.filter((row) => row.kind === kind && (!lang || row.lang === lang));
            const best = (list: typeof rows) => list.filter((row) => row.rank === 1).length;
            const top3 = (list: typeof rows) => list.filter((row) => row.rank !== null && row.rank <= 3).length;
            const mrr = (list: typeof rows) => Number((list.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / list.length).toFixed(3));
            const summary = {
                'text-en': { of: pick('text', 'en').length, best: best(pick('text', 'en')), top3: top3(pick('text', 'en')), mrr: mrr(pick('text', 'en')), obsidian: pick('text', 'en').filter((r) => r.obsidian).length },
                'text-zh': { of: pick('text', 'zh').length, best: best(pick('text', 'zh')), top3: top3(pick('text', 'zh')), mrr: mrr(pick('text', 'zh')), obsidian: pick('text', 'zh').filter((r) => r.obsidian).length },
                picture: { of: pick('picture').length, best: best(pick('picture')), top3: top3(pick('picture')), mrr: mrr(pick('picture')) },
                keyword: {
                    of: pick('keyword').length,
                    best: best(pick('keyword')),
                    bestHybrid: pick('keyword').filter((row) => row.ranks?.hybrid === 1).length,
                    obsidian: pick('keyword').filter((r) => r.obsidian).length,
                },
            };
            const out = {
                model: built.embedder.modelId,
                vault: { notes: vault.notes.length, pictures: vault.getFiles().length - vault.notes.length },
                summary,
                results: rows,
            };
            fs.mkdirSync(path.join(BENCH, 'results'), { recursive: true });
            fs.writeFileSync(path.join(BENCH, 'results', `${model.name}.json`), `${JSON.stringify(out, null, 1)}\n`);
            console.log(model.name, JSON.stringify(summary));
        }, 900_000);
    }
});
