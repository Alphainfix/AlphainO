/**
 * Keyword ranking: BM25 over passages.
 *
 * There is no inverted index. For a CJK-heavy vault one would take
 * gigabytes (every character pair is a term), and building it would hold up
 * start-up. Instead a query scans the normalised passage texts and counts its
 * few terms with `indexOf`: about 100 ms for 15,000 passages, no memory beyond
 * the texts, and nothing to keep in step as notes change. The counts equal
 * what counting `tokenize` tokens would give: a CJK term is counted wherever
 * it occurs, a Latin word only as a whole word.
 */
import { isWordCode, normalizeText, yieldToEventLoop, type QueryTerm } from './text';

const K1 = 1.2;
const B = 0.75;
/** A term in the title or heading counts this many times over a term in the body. */
const HEAD_WEIGHT = 2;
/** Longest the scan runs before it lets the interface breathe, in ms. */
const SLICE_MS = 20;

/** What the ranking reads of a passage. */
export interface KeywordDoc {
    /** The passage text in search form (see `normalizeText`). */
    norm: string;
    /** The note's title and the passage's headings, in search form. */
    head: string;
    /** Length in characters of `norm` and `head` together, for BM25's length normalisation. */
    len: number;
}

function wordBefore(text: string, index: number): boolean {
    if (index <= 0) return false;
    const low = text.charCodeAt(index - 1);
    if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
        const high = text.charCodeAt(index - 2);
        if (high >= 0xd800 && high <= 0xdbff) return isWordCode(((high - 0xd800) << 10) + (low - 0xdc00) + 0x10000);
    }
    return isWordCode(low);
}

function wordAt(text: string, index: number): boolean {
    return index < text.length && isWordCode(text.codePointAt(index) as number);
}

/** How often a term occurs in a text. */
export function countTerm(text: string, term: QueryTerm): number {
    let at = text.indexOf(term.term);
    if (at < 0) return 0;
    let count = 0;
    if (term.kind === 'cjk') {
        // Overlapping occurrences count: "哈哈" is in "哈哈哈" twice.
        while (at >= 0) {
            count += 1;
            at = text.indexOf(term.term, at + 1);
        }
        return count;
    }
    const width = term.term.length;
    while (at >= 0) {
        if (!wordBefore(text, at) && !wordAt(text, at + width)) count += 1;
        at = text.indexOf(term.term, at + width);
    }
    return count;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A test for a literal phrase, in search form: whitespace in the phrase
 * matches any whitespace (a line break included) in the passage, and the
 * title and headings count as part of the passage.
 */
export function phraseTest(phrase: string): (doc: KeywordDoc) => boolean {
    const words = normalizeText(phrase).split(/\s+/).filter((word) => word !== '');
    if (words.length === 0) return () => true;
    if (words.length === 1) return (doc) => doc.norm.includes(words[0]) || doc.head.includes(words[0]);
    const pattern = new RegExp(words.map(escapeRegExp).join('\\s+'));
    return (doc) => pattern.test(doc.norm) || pattern.test(doc.head);
}

export interface KeywordMatch<T> {
    doc: T;
    score: number;
}

/**
 * The passages that contain any of `terms`, best first, at most `limit`.
 *
 * IDF is taken over the passages passed in, so a search inside one folder
 * ranks by what is rare in that folder.
 */
export async function bm25Rank<T extends KeywordDoc>(
    docs: readonly T[],
    terms: readonly QueryTerm[],
    limit: number,
): Promise<Array<KeywordMatch<T>>> {
    const n = docs.length;
    const q = terms.length;
    if (n === 0 || q === 0) return [];

    const counts = new Float32Array(n * q);
    const df = new Uint32Array(q);
    let totalLength = 0;
    let sliceStart = Date.now();
    for (let d = 0; d < n; d += 1) {
        const doc = docs[d];
        totalLength += doc.len;
        for (let t = 0; t < q; t += 1) {
            const count = countTerm(doc.norm, terms[t]) + HEAD_WEIGHT * countTerm(doc.head, terms[t]);
            if (count > 0) {
                counts[d * q + t] = count;
                df[t] += 1;
            }
        }
        if ((d & 255) === 255 && Date.now() - sliceStart > SLICE_MS) {
            await yieldToEventLoop();
            sliceStart = Date.now();
        }
    }

    const averageLength = totalLength / n || 1;
    const idf = Array.from(df, (found) => Math.log(1 + (n - found + 0.5) / (found + 0.5)));
    const matches: Array<KeywordMatch<T>> = [];
    for (let d = 0; d < n; d += 1) {
        let score = 0;
        const norm = K1 * (1 - B + (B * docs[d].len) / averageLength);
        for (let t = 0; t < q; t += 1) {
            const count = counts[d * q + t];
            if (count > 0) score += (idf[t] * (count * (K1 + 1))) / (count + norm);
        }
        if (score > 0) matches.push({ doc: docs[d], score });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, limit);
}
