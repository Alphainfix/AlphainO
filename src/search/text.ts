/**
 * Text utilities for note search: normalisation, the tokenizer that defines
 * what a keyword is, and a small content hash.
 *
 * Keywords are Latin words (case-folded) and CJK characters: each character
 * on its own, and every pair of neighbouring characters. Chinese and Japanese
 * have no spaces, so pairs are what let "机器学习" match "机器学习" but not
 * "机器人学习", while the single characters still find one-character words.
 */

/** Whether a code point is Han, kana or Hangul: scripts written without spaces between words. */
export function isCjkCode(cp: number): boolean {
    return (
        (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
        (cp >= 0x3400 && cp <= 0x4dbf) || // extension A
        (cp >= 0x20000 && cp <= 0x323af) || // extensions B and later
        (cp >= 0xf900 && cp <= 0xfaff) || // compatibility ideographs
        (cp >= 0x3040 && cp <= 0x30ff && cp !== 0x30fb) || // hiragana, katakana (not the middle dot)
        (cp >= 0x31f0 && cp <= 0x31ff) || // katakana extensions
        (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
        (cp >= 0x1100 && cp <= 0x11ff) || // Hangul jamo
        (cp >= 0x3130 && cp <= 0x318f) // Hangul compatibility jamo
    );
}

const WORD_CHARACTER = /^[\p{L}\p{M}\p{N}]$/u;

/** Whether a code point belongs to a Latin-style word: a letter, mark or digit that is not CJK. */
export function isWordCode(cp: number): boolean {
    if (cp < 128) return (cp >= 97 && cp <= 122) || (cp >= 65 && cp <= 90) || (cp >= 48 && cp <= 57);
    if (isCjkCode(cp)) return false;
    return WORD_CHARACTER.test(String.fromCodePoint(cp));
}

/**
 * The form text is searched in: compatibility characters folded (full-width
 * letters and digits become ordinary ones) and case removed.
 */
export function normalizeText(text: string): string {
    return text.normalize('NFKC').toLowerCase();
}

export interface TextRun {
    kind: 'word' | 'cjk';
    text: string;
}

/** Splits already-normalised text into Latin words and CJK runs, dropping everything else. */
export function splitRuns(text: string): TextRun[] {
    const runs: TextRun[] = [];
    let i = 0;
    while (i < text.length) {
        const cp = text.codePointAt(i) as number;
        const width = cp > 0xffff ? 2 : 1;
        const cjk = isCjkCode(cp);
        if (!cjk && !isWordCode(cp)) {
            i += width;
            continue;
        }
        let j = i + width;
        while (j < text.length) {
            const next = text.codePointAt(j) as number;
            if (cjk ? !isCjkCode(next) : !isWordCode(next)) break;
            j += next > 0xffff ? 2 : 1;
        }
        runs.push({ kind: cjk ? 'cjk' : 'word', text: text.slice(i, j) });
        i = j;
    }
    return runs;
}

/** The characters of a string, whole code points. */
function characters(text: string): string[] {
    return Array.from(text);
}

/** The keywords of a text, in order: words, and for CJK runs each character followed by its pair with the next. */
export function tokenize(text: string): string[] {
    const tokens: string[] = [];
    for (const run of splitRuns(normalizeText(text))) {
        if (run.kind === 'word') {
            tokens.push(run.text);
            continue;
        }
        const chars = characters(run.text);
        for (let i = 0; i < chars.length; i += 1) {
            tokens.push(chars[i]);
            if (i + 1 < chars.length) tokens.push(chars[i] + chars[i + 1]);
        }
    }
    return tokens;
}

/**
 * A query split into its words and its quoted phrases: `bees "winter cluster"`
 * is the word `bees` and the phrase `winter cluster`. Straight and curly
 * double quotes both quote; a quote that is never closed is just text.
 */
export function parseQuery(query: string): { text: string; phrases: string[] } {
    const phrases: string[] = [];
    const text = query.replace(/["“]([^"“”]*)["”]/g, (_match, phrase: string) => {
        const trimmed = phrase.trim();
        if (trimmed !== '') phrases.push(trimmed);
        return ' ';
    });
    return { text: text.replace(/\s+/g, ' ').trim(), phrases };
}

/** One term of a keyword query: matched as a whole word, or as a CJK character or pair. */
export interface QueryTerm {
    term: string;
    kind: 'word' | 'cjk';
}

/** Most terms a keyword query scans for: each one costs a pass over every passage. */
export const MAX_QUERY_TERMS = 32;

/**
 * The distinct terms of a query, as `tokenize` would produce them. A long
 * query is cut down to {@link MAX_QUERY_TERMS}: first the single characters of
 * longer CJK runs (their pairs carry the meaning), then one- and two-letter
 * words, then whatever is left past the limit.
 */
export function queryTerms(query: string, maxTerms: number = MAX_QUERY_TERMS): QueryTerm[] {
    // How readily a term is dropped when the query is too long: 0 never, 1 a
    // one- or two-letter word, 2 a single character of a longer CJK run.
    const terms = new Map<string, QueryTerm & { droppable: 0 | 1 | 2 }>();
    const add = (term: string, kind: 'word' | 'cjk', droppable: 0 | 1 | 2) => {
        const key = `${kind}:${term}`;
        const known = terms.get(key);
        if (known) known.droppable = Math.min(known.droppable, droppable) as 0 | 1 | 2;
        else terms.set(key, { term, kind, droppable });
    };
    for (const run of splitRuns(normalizeText(query))) {
        if (run.kind === 'word') {
            add(run.text, 'word', run.text.length <= 2 ? 1 : 0);
            continue;
        }
        const chars = characters(run.text);
        for (let i = 0; i < chars.length; i += 1) {
            add(chars[i], 'cjk', chars.length > 1 ? 2 : 0);
            if (i + 1 < chars.length) add(chars[i] + chars[i + 1], 'cjk', 0);
        }
    }
    let list = [...terms.values()];
    for (const droppable of [2, 1] as const) {
        if (list.length <= maxTerms) break;
        const kept = list.filter((entry) => entry.droppable !== droppable);
        if (kept.length > 0) list = kept;
    }
    return list.slice(0, maxTerms).map(({ term, kind }) => ({ term, kind }));
}

/**
 * A 53-bit hash of a string, as base-36 text with the length appended. It
 * tells whether a text changed; it is not meant to resist anyone trying to
 * collide it.
 */
export function hashString(text: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return `${value.toString(36)}-${text.length.toString(36)}`;
}

/** The text cut to at most `max` characters at a word break where one is near, with an ellipsis. */
export function trimText(text: string, max: number): string {
    if (text.length <= max) return text;
    let end = max;
    // Never cut between the halves of a surrogate pair.
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    const space = Math.max(text.lastIndexOf(' ', end), text.lastIndexOf('\n', end));
    if (space > 0 && space > end - 100) end = space;
    return `${text.slice(0, end).trimEnd()} …`;
}

/** Waits for the event loop to turn once, so a long job does not hold the interface. */
export function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
