/**
 * What an edit changed, as reviewable chunks: each chunk is a span of the old
 * text replaced by a span of the new one. Text is compared as words, spaces
 * and punctuation, with each CJK character on its own, so a changed word is one
 * chunk rather than a whole paragraph, and Chinese text is compared character
 * by character. Only the part between the texts' common beginning and end is
 * compared, which keeps an edit of a long note cheap.
 */

export interface DiffChunk {
    /** The replaced span of the old text. */
    fromA: number;
    toA: number;
    /** The span of the new text that replaces it. */
    fromB: number;
    toB: number;
}

const TOKEN = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]|[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]/gu;

function tokens(text: string): string[] {
    return text.match(TOKEN) ?? [];
}

/** The longest common subsequence of two token lists, as matched index pairs (Myers' O(ND) algorithm). */
function matches(a: string[], b: string[]): Array<[number, number]> {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    if (max === 0) return [];
    const offset = max;
    let v = new Int32Array(2 * max + 2);
    const trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= max && found < 0; d++) {
        trace.push(v.slice());
        const next = v.slice();
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            next[offset + k] = x;
            if (x >= n && y >= m) {
                found = d;
                break;
            }
        }
        v = next;
    }
    // Walk back through the trace to recover the matched pairs.
    const pairs: Array<[number, number]> = [];
    let x = n;
    let y = m;
    for (let d = found; d > 0; d--) {
        const prev = trace[d];
        const k = x - y;
        const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1;
        const prevX = prev[offset + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            pairs.push([x - 1, y - 1]);
            x--;
            y--;
        }
        x = prevX;
        y = prevY;
    }
    while (x > 0 && y > 0) {
        pairs.push([x - 1, y - 1]);
        x--;
        y--;
    }
    return pairs.reverse();
}

/** The largest number of tokens compared exactly; past it the changed region is one chunk. */
const MAX_TOKENS = 4000;

export function diffChunks(oldText: string, newText: string): DiffChunk[] {
    if (oldText === newText) return [];
    let start = 0;
    const limit = Math.min(oldText.length, newText.length);
    while (start < limit && oldText[start] === newText[start]) start++;
    let endA = oldText.length;
    let endB = newText.length;
    while (endA > start && endB > start && oldText[endA - 1] === newText[endB - 1]) {
        endA--;
        endB--;
    }
    // Do not split a surrogate pair or a word at the edges: widen to token boundaries.
    while (start > 0 && /[\p{L}\p{N}_]/u.test(oldText[start - 1] ?? '') && /[\p{L}\p{N}_]/u.test(oldText[start] ?? newText[start] ?? '')) start--;
    while (endA < oldText.length && endB < newText.length && /[\p{L}\p{N}_]/u.test(oldText[endA] ?? '') && /[\p{L}\p{N}_]/u.test(oldText[endA - 1] ?? '')) {
        endA++;
        endB++;
    }
    const regionA = oldText.slice(start, endA);
    const regionB = newText.slice(start, endB);
    const ta = tokens(regionA);
    const tb = tokens(regionB);
    if (ta.join('') !== regionA || tb.join('') !== regionB || ta.length + tb.length > MAX_TOKENS) {
        return [{ fromA: start, toA: endA, fromB: start, toB: endB }];
    }
    const pairs = matches(ta, tb);
    const posA = [0];
    for (const token of ta) posA.push(posA[posA.length - 1] + token.length);
    const posB = [0];
    for (const token of tb) posB.push(posB[posB.length - 1] + token.length);

    const chunks: DiffChunk[] = [];
    let i = 0;
    let j = 0;
    const emit = (toI: number, toJ: number) => {
        if (toI > i || toJ > j) chunks.push({ fromA: start + posA[i], toA: start + posA[toI], fromB: start + posB[j], toB: start + posB[toJ] });
    };
    for (const [pi, pj] of pairs) {
        emit(pi, pj);
        i = pi + 1;
        j = pj + 1;
    }
    emit(ta.length, tb.length);
    return mergeClose(chunks, oldText, newText);
}

/** Chunks separated only by a space are one change to review, not two. */
function mergeClose(chunks: DiffChunk[], oldText: string, newText: string): DiffChunk[] {
    const merged: DiffChunk[] = [];
    for (const chunk of chunks) {
        const last = merged[merged.length - 1];
        if (last && chunk.fromA - last.toA <= 1 && /^\s*$/.test(oldText.slice(last.toA, chunk.fromA)) && newText.slice(last.toB, chunk.fromB) === oldText.slice(last.toA, chunk.fromA)) {
            last.toA = chunk.toA;
            last.toB = chunk.toB;
        } else {
            merged.push({ ...chunk });
        }
    }
    return merged;
}
