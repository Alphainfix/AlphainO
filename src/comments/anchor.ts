/*
 * Comment anchors: where in a note a comment points, and how that place is
 * found again after the note changes.
 *
 * Ported from Orbit Comments (its comment-anchor.js),
 * with the same anchor format and the same relocation rules, so a comment
 * written here means the same thing to Orbit.
 *
 * MIT License
 *
 * Copyright (c) 2026 Orbit Labs
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { createHash } from 'crypto';

/**
 * Where a comment points. A whole-note anchor has zero offsets and no text; a
 * range anchor keeps the passage (at most 4,000 UTF-16 code units), up to 64
 * units of text on each side, and its half-open UTF-16 offsets in the note's
 * text with line endings normalised to LF and any BOM removed.
 */
export interface CommentAnchor {
    kind: 'document' | 'range';
    /** The note's path in the vault when the comment was made. */
    path: string;
    /** '' or the note's `orbit_document_id`. */
    documentKey: string;
    /** SHA-256 (hex) of the note's raw text. */
    documentHash: string;
    /** SHA-256 (hex) of the normalised text the offsets count in. */
    textHash: string;
    from: number;
    to: number;
    quote: string;
    prefix: string;
    suffix: string;
}

/** A place found for an anchor in the current text. */
export type AnchorResolution =
    | {
          status: 'attached';
          from: number;
          to: number;
          /** Zero-based line of `from`. */
          line: number;
          /** True when the recorded offsets still hold; false when the content found it. */
          exact: boolean;
          quote: string;
          strong: boolean;
          /** The passage was deleted while its context stayed: the range is a point. */
          deleted?: boolean;
      }
    | { status: 'detached' | 'ambiguous' };

/** A later position for an anchor, recorded when the place was chosen or followed (Orbit's anchor hints). */
export interface AnchorHint {
    source: 'selected' | 'mapped' | 'confirmed';
    at?: string;
    writer?: string;
    device?: string;
    anchorHash?: string;
    textHash: string;
    from: number;
    to: number;
    quote: string;
    prefix: string;
    suffix: string;
}

export const MAX_QUOTE = 4000;
export const MAX_CONTEXT = 64;
const MAX_OFFSET = 1048576;

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ANCHOR_KEYS = 'documentHash,documentKey,from,kind,path,prefix,quote,suffix,textHash,to';

/** SHA-256 of a text, as lowercase hex. */
export function digest(text: string): string {
    return createHash('sha256').update(String(text ?? '')).digest('hex');
}

/** The text offsets count in: LF line endings, no BOM. */
export function normalized(text: string): string {
    return text.indexOf('\r') === -1 && text.charCodeAt(0) !== 0xfeff ? text : text.replace(/\r\n/g, '\n').replace(/^﻿/, '');
}

/**
 * A note path an anchor may name: a Markdown file, no hidden folder, no
 * control characters. (Orbit also refuses its team's private and archive
 * folders; a single user's vault has no such rule.)
 */
export function anchorPath(path: unknown): path is string {
    return (
        typeof path === 'string'
        && path.length > 0
        && path.length <= 1024
        && path === path.trim()
        && path.toLowerCase().endsWith('.md')
        && !/[\\:*?"<>|\u0000-\u001f\u007f]/.test(path)
        && path.split('/').every((part) => part && part === part.trim() && !part.startsWith('.'))
    );
}

interface ValidatedMeta {
    id: number;
    keyCount: number;
    kind: CommentAnchor['kind'];
    path: string;
    documentKey: string;
    documentHash: string;
    textHash: string;
    from: number;
    to: number;
    quote: string;
    prefix: string;
    suffix: string;
    hash: string;
}

let nextAnchorId = 1;
const validatedAnchors = new WeakMap<object, ValidatedMeta>();

function getValidatedMeta(anchor: unknown): ValidatedMeta | null {
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return null;
    const cached = validatedAnchors.get(anchor);
    const a = anchor as CommentAnchor;
    if (
        cached
        && cached.keyCount === Object.keys(anchor).length
        && cached.kind === a.kind
        && cached.path === a.path
        && cached.documentKey === a.documentKey
        && cached.documentHash === a.documentHash
        && cached.textHash === a.textHash
        && cached.from === a.from
        && cached.to === a.to
        && cached.quote === a.quote
        && cached.prefix === a.prefix
        && cached.suffix === a.suffix
    ) {
        return cached;
    }
    return null;
}

/** The anchor itself when it is well formed; throws otherwise. */
export function validateAnchor(anchor: unknown): CommentAnchor {
    if (getValidatedMeta(anchor)) return anchor as CommentAnchor;
    const a = anchor as CommentAnchor;
    if (
        !anchor
        || typeof anchor !== 'object'
        || Array.isArray(anchor)
        || Object.keys(anchor).sort().join(',') !== ANCHOR_KEYS
        || !anchorPath(a.path)
        || !HASH.test(a.documentHash)
        || !HASH.test(a.textHash)
        || !(a.documentKey === '' || UUID.test(a.documentKey))
        || !['document', 'range'].includes(a.kind)
        || !Number.isInteger(a.from)
        || !Number.isInteger(a.to)
        || a.from < 0
        || a.to < a.from
        || a.to > MAX_OFFSET
        || (['quote', 'prefix', 'suffix'] as const).some((key) => typeof a[key] !== 'string' || a[key].includes('\0'))
        || a.quote.length > MAX_QUOTE
        || a.prefix.length > MAX_CONTEXT
        || a.suffix.length > MAX_CONTEXT
    ) {
        throw new Error('Invalid document comment anchor.');
    }
    if (a.kind === 'document' ? a.from !== 0 || a.to !== 0 || a.quote || a.prefix || a.suffix : !a.quote.trim() || a.to - a.from !== a.quote.length) {
        throw new Error('Invalid document comment range.');
    }
    validatedAnchors.set(anchor, {
        id: nextAnchorId++,
        keyCount: 10,
        kind: a.kind,
        path: a.path,
        documentKey: a.documentKey,
        documentHash: a.documentHash,
        textHash: a.textHash,
        from: a.from,
        to: a.to,
        quote: a.quote,
        prefix: a.prefix,
        suffix: a.suffix,
        hash: '',
    });
    return a;
}

/**
 * The anchor for a selection in a note's raw text; `from === to` anchors the
 * whole note. Offsets count in the normalised text (see `normalized`).
 */
export function captureAnchor(
    path: string,
    raw: string,
    { from = 0, to = 0, documentKey = '' }: { from?: number; to?: number; documentKey?: string } = {},
): CommentAnchor {
    const text = normalized(raw);
    const kind = from === to ? 'document' : 'range';
    if (to > text.length) throw new Error('Selection is outside the saved document.');
    return validateAnchor({
        kind,
        path,
        documentKey,
        documentHash: digest(raw),
        textHash: digest(text),
        from: kind === 'range' ? from : 0,
        to: kind === 'range' ? to : 0,
        quote: kind === 'range' ? text.slice(from, to) : '',
        prefix: kind === 'range' ? text.slice(Math.max(0, from - MAX_CONTEXT), from) : '',
        suffix: kind === 'range' ? text.slice(to, to + MAX_CONTEXT) : '',
    });
}

const MAX_HITS = 200,
    SHORT_QUOTE = 12,
    MIN_CONTEXT = 4,
    CLEAR_LEAD = 3,
    SIMILAR = 0.5,
    LIKENESS = 24,
    MAX_PAIRS = 400,
    STRONG = 8;
const TAILS = [32, 24, 16, 12, 8, 6],
    SKIPS = [0, 8, 16];
const HEADING_LINE = /(?:^|\n)[ \t]{0,3}#{1,6}(?=[ \t\n]|$)/,
    HEADING_INSIDE = /\n[ \t]{0,3}#{1,6}(?=[ \t\n]|$)/;
const CJK = '\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}';
const TOKEN = new RegExp(`[${CJK}]+|(?:(?![${CJK}])[\\p{L}\\p{N}_])+`, 'gu'),
    CJK_RUN = new RegExp(`^[${CJK}]`, 'u'),
    CJK_CHAR = new RegExp(`[${CJK}]`, 'u');

/** Length with each CJK character counted three times: a CJK character carries about as much as a short word. */
function weightedLength(text: string): number {
    const str = String(text || '');
    let score = 0;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code < 0x2e80) {
            score++;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
            const pair = str.slice(i, i + 2);
            score += CJK_CHAR.test(pair) ? 3 : 1;
            i++;
        } else {
            score += CJK_CHAR.test(str[i]) ? 3 : 1;
        }
    }
    return score;
}

function cjkSimilarity(a: string, b: string): number {
    const ca = Array.from(String(a || '').replace(/\s+/g, '')),
        cb = Array.from(String(b || '').replace(/\s+/g, ''));
    if (!ca.length || !cb.length) return 0;
    const counts = new Map<string, number>();
    for (const ch of ca) counts.set(ch, (counts.get(ch) || 0) + 1);
    let shared = 0;
    for (const ch of cb) {
        const left = counts.get(ch) || 0;
        if (left > 0) {
            shared++;
            counts.set(ch, left - 1);
        }
    }
    return (2 * shared) / (ca.length + cb.length);
}

const RANK: Record<string, number> = { selected: 3, mapped: 2, confirmed: 1 };
const EDGE = [24, 16, 12, 8, 6, 4, 3],
    ALIGNED = 6,
    KEEP = 0.75;
const DOC_CACHE_MAX = 32;
const DOC_CACHE_MAX_LEN = 262144;
const DOC_CACHE_MAX_CHARS = 4 * 1024 * 1024;
const LARGE_DOC_CACHE_MAX = 2;
const ANCHOR_RES_CACHE_MAX = 512;

interface DocEntry {
    raw: string;
    text: string;
    hash: string;
    matterEnd: number;
    lineStarts: Int32Array | null;
    resolutions: Map<string, AnchorResolution>;
}

const docCache = new Map<string, DocEntry>();
const largeDocCache = new Map<string, DocEntry>();
const lineStartsCache = new Map<string, Int32Array>();
const cachedChars = new Map<Map<string, unknown>, number>([
    [docCache, 0],
    [largeDocCache, 0],
    [lineStartsCache, 0],
]);

function touchCached<T>(cache: Map<string, T>, key: string): T | undefined {
    const value = cache.get(key);
    if (value === undefined) return undefined;
    cache.delete(key);
    cache.set(key, value);
    return value;
}

function rememberCached<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): T {
    cache.set(key, value);
    cachedChars.set(cache, (cachedChars.get(cache) ?? 0) + key.length);
    for (const oldest of cache.keys()) {
        if (cache.size <= maxEntries && (cachedChars.get(cache) ?? 0) <= DOC_CACHE_MAX_CHARS) break;
        if (oldest === key) break;
        cache.delete(oldest);
        cachedChars.set(cache, (cachedChars.get(cache) ?? 0) - oldest.length);
    }
    return value;
}

function buildLineStartsArray(text: string): Int32Array {
    let count = 1;
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
    const arr = new Int32Array(count);
    let idx = 1;
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) arr[idx++] = at + 1;
    return arr;
}

function getLineStartsFor(text: string): Int32Array {
    if (text.length > DOC_CACHE_MAX_LEN) return buildLineStartsArray(text);
    return touchCached(lineStartsCache, text) ?? rememberCached(lineStartsCache, text, buildLineStartsArray(text), DOC_CACHE_MAX);
}

function docOf(raw: string, knownDocumentHash = ''): DocEntry {
    const cache = raw.length <= DOC_CACHE_MAX_LEN ? docCache : largeDocCache;
    const hit = touchCached(cache, raw);
    if (hit) return hit;
    const text = normalized(raw);
    const hash = text === raw && HASH.test(knownDocumentHash) ? knownDocumentHash : digest(text);
    const entry: DocEntry = { raw, text, hash, matterEnd: frontMatterEnd(text), lineStarts: null, resolutions: new Map() };
    return rememberCached(cache, raw, entry, cache === docCache ? DOC_CACHE_MAX : LARGE_DOC_CACHE_MAX);
}

/** A value with every object's keys sorted, so equal values serialise alike. */
export function canonical(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonical);
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
}

function validatedMetaOf(anchor: CommentAnchor): ValidatedMeta | null {
    const meta = getValidatedMeta(anchor);
    if (meta) return meta;
    try {
        validateAnchor(anchor);
    } catch {
        return null;
    }
    return getValidatedMeta(anchor);
}

/** A hash naming this exact anchor: a re-anchored comment gets a new one. */
export function anchorHash(anchor: CommentAnchor): string {
    const meta = validatedMetaOf(anchor);
    if (meta) {
        if (!meta.hash) meta.hash = digest(JSON.stringify(canonical(anchor)));
        return meta.hash;
    }
    return digest(JSON.stringify(canonical(anchor)));
}

function lineIndexIn(starts: Int32Array, length: number, offset: number): number {
    if (offset <= 0 || !length) return 0;
    if (offset >= length) return starts.length - 1;
    let lo = 0,
        hi = starts.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (starts[mid] <= offset) lo = mid + 1;
        else hi = mid;
    }
    return lo - 1;
}

/** The zero-based line an offset of the text falls on. */
export function lineAt(text: string, offset: number): number {
    if (offset <= 0 || !text) return 0;
    return lineIndexIn(getLineStartsFor(text), text.length, offset);
}

function entryLineAt(entry: DocEntry, offset: number): number {
    if (offset <= 0 || !entry.text) return 0;
    entry.lineStarts ??= getLineStartsFor(entry.text);
    return lineIndexIn(entry.lineStarts, entry.text.length, offset);
}

export function commonSuffix(a: string, b: string): number {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
}

export function commonPrefix(a: string, b: string): number {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
}

function frontMatterEnd(text: string): number {
    if (!text.startsWith('---\n')) return 0;
    const close = text.indexOf('\n---', 3);
    return close === -1 ? 0 : close + 4;
}

interface Basis {
    from: number;
    to: number;
    quote: string;
    prefix: string;
    suffix: string;
    textHash: string;
    source?: string;
    at?: string;
    writer?: string;
    device?: string;
    anchorHash?: string;
}

function plausibleGap(text: string, from: number, to: number, basis: Basis, matterEnd: number): boolean {
    if (matterEnd && from < matterEnd && to > matterEnd && !basis.quote.includes('\n---')) return false;
    const gap = (from === 0 || text[from - 1] === '\n' ? '\n' : '') + text.slice(from, to);
    return !HEADING_INSIDE.test(gap) || HEADING_LINE.test(basis.quote);
}

function lastHeadingEnd(region: string): number {
    let end = -1;
    for (const match of region.matchAll(/(?:^|\n)[ \t]{0,3}#{1,6}(?:[ \t][^\n]*)?(?=\n|$)/g)) end = (match.index ?? 0) + match[0].length;
    return end;
}

interface Token {
    value: string;
    from: number;
    to: number;
}

/** Words, and CJK text as overlapping pairs of characters. */
function tokenList(text: string, base = 0): Token[] {
    const tokens: Token[] = [];
    for (const match of text.matchAll(TOKEN)) {
        const value = match[0],
            at = base + (match.index ?? 0);
        if (!CJK_RUN.test(value)) {
            tokens.push({ value, from: at, to: at + value.length });
            continue;
        }
        const chars = Array.from(value);
        let offset = at;
        if (chars.length === 1) {
            tokens.push({ value, from: at, to: at + value.length });
            continue;
        }
        for (let i = 0; i + 1 < chars.length; i++) {
            tokens.push({ value: chars[i] + chars[i + 1], from: offset, to: offset + chars[i].length + chars[i + 1].length });
            offset += chars[i].length;
        }
    }
    return tokens;
}

interface Bag {
    counts: Map<string, number>;
    size: number;
}

function bag(tokens: Token[]): Bag {
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token.value, (counts.get(token.value) || 0) + 1);
    return { counts, size: tokens.length };
}

function likeness(a: Bag, b: Bag): number {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const [value, count] of b.counts) shared += Math.min(count, a.counts.get(value) || 0);
    return (2 * shared) / (a.size + b.size);
}

function attached(entry: DocEntry, from: number, to: number, exact: boolean, strong = exact): AnchorResolution {
    const result: AnchorResolution = { status: 'attached', from, to, line: entryLineAt(entry, from), exact, quote: entry.text.slice(from, to), strong };
    if (to === from) result.deleted = true;
    return result;
}

function validBasis(basis: unknown, hash: string): basis is Basis {
    const b = basis as Basis;
    return (
        Boolean(basis)
        && typeof basis === 'object'
        && Number.isInteger(b.from)
        && Number.isInteger(b.to)
        && b.from >= 0
        && b.to >= b.from
        && (['quote', 'prefix', 'suffix', 'textHash'] as const).every((key) => typeof b[key] === 'string')
        && b.to - b.from === b.quote.length
        && (b.anchorHash === undefined || b.anchorHash === hash)
    );
}

function hitsOf(text: string, needle: string, keepLast: boolean): { hits: number[]; overflow: boolean } {
    const hits: number[] = [];
    for (let at = text.indexOf(needle); at !== -1 && hits.length < MAX_HITS; at = text.indexOf(needle, at + 1)) hits.push(at);
    return { hits: hits.filter((at, i) => (keepLast ? hits[i + 1] !== at + 1 : hits[i - 1] !== at - 1)), overflow: hits.length >= MAX_HITS };
}

interface Edge {
    at: number;
    size: number;
}

function contextEnds(text: string, prefix: string): { list: Edge[]; overflow: boolean } {
    if (!prefix) return { list: [{ at: 0, size: 0 }], overflow: false };
    const tails = CJK_CHAR.test(prefix) ? [...TAILS, 4] : TAILS;
    for (const skip of SKIPS) {
        for (const size of tails) {
            if (size + skip > prefix.length) continue;
            const piece = prefix.slice(prefix.length - size - skip, prefix.length - skip);
            if (size < TAILS[TAILS.length - 1] && weightedLength(piece) < SHORT_QUOTE) continue;
            const found = hitsOf(text, piece, true);
            if (found.overflow) return { list: [], overflow: false };
            if (found.hits.length) return { list: found.hits.map((at) => ({ at: at + size + skip, size: weightedLength(piece) })), overflow: false };
        }
    }
    return {
        list: prefix.length < tails[tails.length - 1] && text.startsWith(prefix) ? [{ at: prefix.length, size: weightedLength(prefix) }] : [],
        overflow: false,
    };
}

function contextStarts(text: string, suffix: string): { list: Edge[]; overflow: boolean } {
    if (!suffix) return { list: [{ at: text.length, size: 0 }], overflow: false };
    const tails = CJK_CHAR.test(suffix) ? [...TAILS, 4] : TAILS;
    for (const skip of SKIPS) {
        for (const size of tails) {
            if (size + skip > suffix.length) continue;
            const piece = suffix.slice(skip, skip + size);
            if (size < TAILS[TAILS.length - 1] && weightedLength(piece) < SHORT_QUOTE) continue;
            const found = hitsOf(text, piece, false);
            if (found.overflow) return { list: [], overflow: false };
            if (found.hits.length) return { list: found.hits.map((at) => ({ at: Math.max(0, at - skip), size: weightedLength(piece) })), overflow: false };
        }
    }
    return {
        list: suffix.length < tails[tails.length - 1] && text.endsWith(suffix) ? [{ at: text.length - suffix.length, size: weightedLength(suffix) }] : [],
        overflow: false,
    };
}

function trimmed(text: string, from: number, to: number, quote: string): [number, number] {
    if (!/^\s/.test(quote)) while (from < to && /\s/.test(text[from])) from++;
    if (!/\s$/.test(quote)) while (to > from && /\s/.test(text[to - 1])) to--;
    return [from, to];
}

/** Cut a recovered span to where the quote's head and tail occur in it, so text typed at its edges stays out. */
function aligned(text: string, from: number, to: number, quote: string): [number, number] {
    const gap = text.slice(from, to),
        keep = Math.ceil(quote.length * KEEP),
        cjkQuote = CJK_CHAR.test(quote);
    if (gap === quote || (!cjkQuote && quote.length < ALIGNED) || quote.length < 2) return [from, to];
    const edges = cjkQuote ? [...EDGE, 2] : EDGE;
    let start = 0,
        end = gap.length;
    if (commonPrefix(gap, quote) < (cjkQuote ? 2 : ALIGNED)) {
        for (const size of edges) {
            if (size > quote.length) continue;
            const head = quote.slice(0, size);
            if (size < 3 && !CJK_CHAR.test(head)) continue;
            const at = gap.indexOf(head);
            if (at === -1) continue;
            if (at > 0 && gap.length - at >= keep) start = at;
            break;
        }
    }
    if (commonSuffix(gap, quote) < (cjkQuote ? 2 : ALIGNED)) {
        for (const size of edges) {
            if (size > quote.length) continue;
            const tail = quote.slice(-size);
            if (size < 3 && !CJK_CHAR.test(tail)) continue;
            const at = gap.lastIndexOf(tail);
            if (at === -1) continue;
            if (at + size < gap.length && at + size - start >= keep) end = at + size;
            break;
        }
    }
    return start === 0 && end === gap.length ? [from, to] : trimmed(text, from + start, from + end, quote);
}

function approximate(text: string, basis: Basis, quote: Bag, edge: number, forward: boolean): { from: number; to: number; dice: number } | null {
    if (!quote.size) return null;
    const cjkShort = CJK_CHAR.test(basis.quote) && basis.quote.trim().length < SHORT_QUOTE;
    const reach = 2 * basis.quote.length + 200;
    let region = forward ? text.slice(edge, edge + reach) : text.slice(Math.max(0, edge - reach), edge),
        base = forward ? edge : edge - region.length;
    if (!HEADING_LINE.test(basis.quote)) {
        if (forward) {
            const cut = region.search(HEADING_INSIDE);
            if (cut !== -1) region = region.slice(0, cut);
        } else {
            const cut = lastHeadingEnd(region);
            if (cut !== -1) {
                base += cut;
                region = region.slice(cut);
            }
        }
    }
    const tokens = tokenList(region, base);
    if (!forward) tokens.reverse();
    const seen = new Map<string, number>();
    let shared = 0,
        best: { dice: number; at: number } | null = null;
    for (let i = 0; i < tokens.length && i < 2 * quote.size + 8; i++) {
        const value = tokens[i].value,
            count = seen.get(value) || 0;
        if (count < (quote.counts.get(value) || 0)) shared++;
        seen.set(value, count + 1);
        let dice = (2 * shared) / (quote.size + i + 1);
        if (cjkShort) {
            const spanFrom = forward ? edge : tokens[i].from,
                spanTo = forward ? tokens[i].to : edge;
            const charSim = cjkSimilarity(basis.quote, text.slice(spanFrom, spanTo));
            if (charSim > dice) dice = charSim;
        }
        if (!best || dice > best.dice) best = { dice, at: forward ? tokens[i].to : tokens[i].from };
    }
    if (!best || best.dice < SIMILAR) return null;
    return forward ? { from: edge, to: best.at, dice: best.dice } : { from: best.at, to: edge, dice: best.dice };
}

interface Candidate {
    from: number;
    to: number;
    score: number;
    strong: boolean;
    exact: boolean;
}

function locateBasis(
    text: string,
    basis: Basis,
    matterEnd: number,
    memo: Map<string, unknown>,
): { found: Candidate } | { ambiguous: true } | null {
    const once = <T>(kind: string, key: string, run: () => T): T => {
        const id = `${kind}\0${key}`;
        if (!memo.has(id)) memo.set(id, run());
        return memo.get(id) as T;
    };
    let quoteBag: Bag | null = null;
    const getQuoteBag = () => (quoteBag ||= bag(tokenList(basis.quote)));
    const candidates = new Map<string, Candidate>(),
        short = weightedLength(basis.quote.trim()) < SHORT_QUOTE;
    const cjkShort = CJK_CHAR.test(basis.quote) && basis.quote.trim().length < SHORT_QUOTE;
    let overflow = false;
    const offer = (from: number, to: number, score: number, strong: boolean, exact = false) => {
        const key = `${from}:${to}`,
            old = candidates.get(key);
        if (!old || old.score < score) candidates.set(key, { from, to, score, strong: strong || Boolean(old?.strong), exact: exact || Boolean(old?.exact) });
        else if (exact) old.exact = true;
    };
    if (basis.quote) {
        const found = once('quote', basis.quote, () => hitsOf(text, basis.quote, false));
        overflow ||= found.overflow;
        if (!overflow && found.hits.length === 1 && !short && basis.prefix.length >= TAILS[0] && basis.suffix.length >= TAILS[0]) {
            const at = found.hits[0],
                end = at + basis.quote.length;
            if (
                at >= basis.prefix.length
                && end + basis.suffix.length <= text.length
                && text.startsWith(basis.prefix, at - basis.prefix.length)
                && text.startsWith(basis.suffix, end)
                && !CJK_CHAR.test(basis.prefix)
                && !CJK_CHAR.test(basis.suffix)
            ) {
                const pTail = basis.prefix.slice(basis.prefix.length - TAILS[0]);
                const sHead = basis.suffix.slice(0, TAILS[0]);
                const pPos = at - TAILS[0];
                if (text.indexOf(pTail) === pPos && text.indexOf(pTail, pPos + 1) === -1 && text.indexOf(sHead) === end && text.indexOf(sHead, end + 1) === -1) {
                    const context = weightedLength(basis.prefix) + weightedLength(basis.suffix);
                    return { found: { from: at, to: end, score: context + LIKENESS, strong: context >= 2 * STRONG, exact: true } };
                }
            }
        }
        for (const at of found.hits) {
            const end = at + basis.quote.length;
            const rawBefore = commonSuffix(basis.prefix, text.slice(Math.max(0, at - basis.prefix.length), at));
            const rawAfter = commonPrefix(basis.suffix, text.slice(end, end + basis.suffix.length));
            const context =
                (rawBefore ? weightedLength(basis.prefix.slice(basis.prefix.length - rawBefore)) : 0)
                + (rawAfter ? weightedLength(basis.suffix.slice(0, rawAfter)) : 0);
            if (!short || context >= MIN_CONTEXT) offer(at, end, context + LIKENESS, context >= 2 * STRONG, true);
        }
    }
    const ends = once('ends', basis.prefix, () => contextEnds(text, basis.prefix)),
        starts = once('starts', basis.suffix, () => contextStarts(text, basis.suffix));
    const maxGap = 4 * basis.quote.length + 200;
    const sorted = [...starts.list].sort((a, b) => a.at - b.at);
    let pairs = 0;
    for (const end of ends.list) {
        let low = 0,
            high = sorted.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (sorted[mid].at < end.at - 8) low = mid + 1;
            else high = mid;
        }
        for (let i = low; i < sorted.length && sorted[i].at <= end.at + maxGap && pairs < MAX_PAIRS; i++, pairs++) {
            const start = sorted[i];
            let [from, to] = start.at < end.at ? [start.at, start.at] : trimmed(text, end.at, start.at, basis.quote);
            if (to > from && basis.quote) [from, to] = aligned(text, from, to, basis.quote);
            if (to > from && !plausibleGap(text, from, to, basis, matterEnd)) continue;
            const rawBefore = commonSuffix(basis.prefix, text.slice(Math.max(0, end.at - basis.prefix.length), end.at));
            const rawAfter = commonPrefix(basis.suffix, text.slice(start.at, start.at + basis.suffix.length));
            const before = Math.max(end.size, rawBefore ? weightedLength(basis.prefix.slice(basis.prefix.length - rawBefore)) : 0);
            const after = Math.max(start.size, rawAfter ? weightedLength(basis.suffix.slice(0, rawAfter)) : 0);
            const gap = text.slice(from, to);
            let like = basis.quote ? likeness(getQuoteBag(), bag(tokenList(gap))) : gap.trim() ? 0 : 1;
            if (cjkShort && basis.quote && like < SIMILAR) like = Math.max(like, cjkSimilarity(basis.quote, gap));
            offer(from, to, before + after + LIKENESS * like, Math.min(before, after) >= STRONG);
        }
    }
    if (!candidates.size && basis.quote) {
        const qBag = getQuoteBag();
        for (const end of ends.list.slice(0, 20)) {
            const found = approximate(text, basis, qBag, end.at, true);
            if (!found) continue;
            const [from, to] = aligned(text, ...trimmed(text, found.from, found.to, basis.quote), basis.quote);
            if (to > from && plausibleGap(text, from, to, basis, matterEnd)) offer(from, to, end.size + LIKENESS * found.dice, false);
        }
        for (const start of starts.list.slice(0, 20)) {
            const found = approximate(text, basis, qBag, start.at, false);
            if (!found) continue;
            const [from, to] = aligned(text, ...trimmed(text, found.from, found.to, basis.quote), basis.quote);
            if (to > from && plausibleGap(text, from, to, basis, matterEnd)) offer(from, to, start.size + LIKENESS * found.dice, false);
        }
    }
    if (!short && [...candidates.values()].some((item) => item.exact)) {
        for (const [key, item] of candidates) if (item.from === item.to) candidates.delete(key);
    }
    for (const hit of [...candidates.values()].filter((item) => item.exact)) {
        for (const [key, item] of candidates) {
            if (item.exact || item.from > hit.from || item.to < hit.to) continue;
            candidates.delete(key);
            if (item.score > hit.score) {
                hit.score = item.score;
                hit.strong ||= item.strong;
            }
        }
    }
    const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
    if (!ranked.length) return overflow ? { ambiguous: true } : null;
    const [best, second] = ranked;
    if (overflow || (second && best.score - second.score < CLEAR_LEAD)) return { ambiguous: true };
    return { found: best };
}

function strictly(entry: DocEntry, bases: Basis[]): AnchorResolution {
    const text = entry.text;
    let ambiguous = false;
    for (const basis of bases) {
        if (!basis.quote) continue;
        const { hits, overflow } = hitsOf(text, basis.quote, false);
        if (hits.length > 1 || overflow) {
            ambiguous = true;
            continue;
        }
        const at = hits[0];
        if (at === undefined) continue;
        const end = at + basis.quote.length;
        if (text.slice(Math.max(0, at - basis.prefix.length), at) === basis.prefix && text.slice(end, end + basis.suffix.length) === basis.suffix) {
            return attached(entry, at, end, false, true);
        }
    }
    return { status: ambiguous ? 'ambiguous' : 'detached' };
}

function placeOf(text: string, hash: string, basis: Basis | undefined): { from: number; to: number } | null {
    if (!basis) return null;
    if (basis.textHash === hash && basis.to <= text.length && text.slice(basis.from, basis.to) === basis.quote) return { from: basis.from, to: basis.to };
    const located = locateBasis(text, basis, frontMatterEnd(text), new Map());
    return located && 'found' in located ? located.found : null;
}

const meets = (a: { from: number; to: number }, b: { from: number; to: number }) =>
    a.from === a.to || b.from === b.to ? a.from <= b.to && b.from <= a.to : a.from < b.to && b.from < a.to;

function afterChoice(text: string, hash: string, hints: Basis[], chosen: string, order: (a: Basis, b: Basis) => number): Basis[] {
    const pick = hints.filter((hint) => hint.source === 'selected' && String(hint.at || '') === chosen).sort(order)[0];
    const span = placeOf(text, hash, pick);
    return hints.filter(
        (hint) =>
            hint === pick
            || (hint.source !== 'selected'
                && String(hint.at || '') >= chosen
                && ((hint.writer === pick.writer && hint.device === pick.device)
                    || (span !== null && ((place) => place !== null && meets(place, span))(placeOf(text, hash, hint))))),
    );
}

function hintsCacheKey(hints: unknown): string {
    if (!Array.isArray(hints) || !hints.length) return '';
    let out = '';
    for (const h of hints) {
        if (!h || typeof h !== 'object') {
            out += '?;';
            continue;
        }
        out += `${h.source || ''}:${h.at || ''}:${h.writer || ''}:${h.device || ''}:${h.anchorHash || ''}:${h.textHash || ''}:${h.from}:${h.to}:${h.quote?.length || 0};`;
    }
    return out;
}

/**
 * Find an anchor's passage in a note's current raw text. The recorded offsets
 * win while they still hold; otherwise the passage is searched by its text and
 * its context (CJK text compared by adjacent character pairs), and placed only
 * when one candidate clearly beats the rest. `strict` accepts only an exact
 * basis or a unique quote with unchanged context.
 */
export function resolveAnchor(
    anchor: CommentAnchor,
    raw: string,
    hints: AnchorHint[] = [],
    { strict = false, documentHash = '' }: { strict?: boolean; documentHash?: string } = {},
): AnchorResolution {
    validateAnchor(anchor);
    if (anchor.kind === 'document') return { status: 'attached', from: 0, to: 0, line: 0, exact: true, quote: '', strong: true };
    const docEntry = docOf(raw, documentHash);
    const { text, hash, matterEnd, resolutions } = docEntry;
    const meta = getValidatedMeta(anchor);
    const hKey = hintsCacheKey(hints);
    const resKey = meta ? `${meta.id}\0${strict ? 1 : 0}\0${hKey}` : '';
    if (resKey) {
        const hit = resolutions.get(resKey);
        if (hit) return { ...hit };
    }
    const remember = (result: AnchorResolution) => {
        if (resKey) {
            if (resolutions.size >= ANCHOR_RES_CACHE_MAX) resolutions.delete(resolutions.keys().next().value as string);
            resolutions.set(resKey, result);
        }
        return { ...result };
    };
    const revision = Array.isArray(hints) && hints.length ? anchorHash(anchor) : '';
    const order = (a: Basis, b: Basis) => (RANK[b.source ?? ''] || 0) - (RANK[a.source ?? ''] || 0) || String(b.at || '').localeCompare(String(a.at || ''));
    let valid = (Array.isArray(hints) ? hints : []).filter((hint): hint is AnchorHint & Basis => validBasis(hint, revision)) as Basis[];
    const selectedAt = valid
        .filter((hint) => hint.source === 'selected')
        .map((hint) => String(hint.at || ''))
        .sort();
    const chosen = selectedAt.length > 0 ? selectedAt[selectedAt.length - 1] : undefined;
    if (chosen !== undefined) valid = afterChoice(text, hash, valid, chosen, order);
    const bases: Basis[] = [...valid.sort(order), ...(chosen === undefined ? [anchor as Basis] : [])];
    for (const basis of bases) {
        if (basis.textHash === hash && basis.to <= text.length && text.slice(basis.from, basis.to) === basis.quote) {
            return remember(attached(docEntry, basis.from, basis.to, true));
        }
    }
    if (strict) return remember(strictly(docEntry, bases));
    const memo = new Map<string, unknown>();
    let ambiguous = false,
        best: Candidate | null = null,
        verbatim: Candidate | null = null;
    for (const basis of bases) {
        const found = locateBasis(text, basis, matterEnd, memo);
        const candidate = found && 'found' in found ? found.found : null;
        if (found && 'ambiguous' in found) ambiguous = true;
        else if (candidate && (!best || candidate.score > best.score)) best = candidate;
        if (candidate?.exact && candidate.to > candidate.from && (!verbatim || candidate.score > verbatim.score)) verbatim = candidate;
        if (best && candidate === best && best.to > best.from && best.score >= weightedLength(basis.prefix) + weightedLength(basis.suffix) + LIKENESS) break;
    }
    if (best && best.from === best.to && verbatim) best = verbatim;
    return remember(best ? attached(docEntry, best.from, best.to, false, best.strong) : { status: ambiguous ? 'ambiguous' : 'detached' });
}
