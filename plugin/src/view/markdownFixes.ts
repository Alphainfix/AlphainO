/**
 * Fixes applied to an answer's Markdown before Obsidian renders it, as AlphainZ
 * applies them before its renderer: math written as `\(…\)` / `\[…\]` or bare
 * `\begin{…}` environments becomes `$…$` / `$$…$$` (the only forms Obsidian's
 * math reads), dollar amounts are kept from turning into formulas, and text
 * still streaming has a dangling `**` closed and a half-written `$$` block or
 * HTML tag held back.
 *
 * The math part is AlphainZ's `react/utils/mathNormalization.ts`, carried over
 * unchanged (it belongs in the shared agent-ui package; move it there). The
 * streaming part is AlphainZ's `processPartialContent`, except that it uses NFC:
 * NFKC also turns Chinese full-width punctuation (，！（）：) into ASCII.
 */
const DELIMITERS: Array<[RegExp, (body: string) => string]> = [
    [/\\\[([\s\S]+?)\\\]/g, body => `\n$$\n${body.trim()}\n$$\n`],
    [/\\\(([\s\S]+?)\\\)/g, body => `$${body.trim()}$`],
];

/**
 * Rewrite `\(…\)` and `\[…\]` as `$…$` and `$$…$$`.
 *
 * This is the form a model reaches for most: asked in Chinese about
 * fermentation, gpt-5.6 wrote every symbol in the answer as `\(t_{1/2}\)`. Without
 * this the reader sees the backslashes.
 *
 * Code spans and fenced blocks are copied through untouched — `\(` inside code
 * is text about LaTeX, not LaTeX.
 */
export function normalizeMathDelimiters(text: string): string {
    return mapOutsideCode(text, segment => {
        let out = segment;
        for (const [pattern, wrap] of DELIMITERS) {
            out = out.replace(pattern, (_match, body: string) => wrap(body));
        }
        return out;
    });
}

/** Apply `transform` to every stretch of text that is not code. */
function mapOutsideCode(text: string, transform: (segment: string) => string): string {
    const out: string[] = [];
    let i = 0;
    let plain = 0;

    const flush = (end: number) => {
        if (end > plain) out.push(transform(text.slice(plain, end)));
    };

    while (i < text.length) {
        const fence = matchFence(text, i);
        if (fence !== null) {
            flush(i);
            out.push(text.slice(i, fence));
            i = plain = fence;
            continue;
        }
        if (text[i] === '`') {
            const end = closingBacktick(text, i);
            flush(i);
            out.push(text.slice(i, end));
            i = plain = end;
            continue;
        }
        i += 1;
    }
    flush(text.length);
    return out.join('');
}

/**
 * LaTeX environments a model emits at the top level, and what they become.
 *
 * The alignment environments map to their `aligned` counterparts rather than
 * being unwrapped: KaTeX has no top-level `align`, but `aligned` inside display
 * math produces the same alignment, so a multi-line derivation keeps its
 * columns instead of collapsing into one line.
 */
const ENVIRONMENTS: Array<[string, string | null]> = [
    ['equation*', null],
    ['equation', null],
    ['align*', 'aligned'],
    ['align', 'aligned'],
    ['gather*', 'gathered'],
    ['gather', 'gathered'],
    ['multline*', 'aligned'],
    ['multline', 'aligned'],
];

/**
 * Wrap top-level LaTeX environments in display math.
 *
 * Only environments that are not already inside `$…$` or `$$…$$` are touched —
 * a `\begin{aligned}` the model correctly placed inside `$$` is left exactly as
 * it is.
 */
export function normalizeMathEnvironments(text: string): string {
    let out = text;
    for (const [env, inner] of ENVIRONMENTS) {
        const pattern = new RegExp(
            String.raw`\\begin\{${env.replace('*', '\\*')}\}([\s\S]*?)\\end\{${env.replace('*', '\\*')}\}`,
            'g',
        );
        out = out.replace(pattern, (match, body: string, offset: number) => {
            if (isInsideMath(out, offset)) return match;
            const trimmed = body.trim();
            return inner
                ? `\n$$\n\\begin{${inner}}\n${trimmed}\n\\end{${inner}}\n$$\n`
                : `\n$$\n${trimmed}\n$$\n`;
        });
    }
    return out;
}

/** Whether `offset` falls inside a `$…$` or `$$…$$` span. */
function isInsideMath(text: string, offset: number): boolean {
    // Counting unescaped delimiters before the offset: an odd count means the
    // position is inside one.
    let count = 0;
    for (let i = 0; i < offset; i++) {
        if (text[i] !== '$') continue;
        if (i > 0 && text[i - 1] === '\\') continue;
        if (text[i + 1] === '$') {
            i++;
        }
        count++;
    }
    return count % 2 === 1;
}

/**
 * Escape `$` pairs that are currency rather than math.
 *
 * Inline math is recognised by having no whitespace against its delimiters —
 * `$x_2^*$` is math, `$5 and then $10` is two prices with prose between them.
 * Display math (`$$…$$`), code fences and inline code spans are skipped: their
 * contents are not the parser's business here.
 */
export function escapeCurrencyDollars(text: string): string {
    const out: string[] = [];
    let i = 0;

    while (i < text.length) {
        // Fenced code block — copied through untouched, delimiters and all.
        const fence = matchFence(text, i);
        if (fence !== null) {
            out.push(text.slice(i, fence));
            i = fence;
            continue;
        }

        // Inline code span.
        if (text[i] === '`') {
            const end = closingBacktick(text, i);
            out.push(text.slice(i, end));
            i = end;
            continue;
        }

        // An escaped dollar is already settled.
        if (text[i] === '\\' && text[i + 1] === '$') {
            out.push(text.slice(i, i + 2));
            i += 2;
            continue;
        }

        // Display math: hand it over whole.
        if (text[i] === '$' && text[i + 1] === '$') {
            const end = text.indexOf('$$', i + 2);
            if (end === -1) {
                out.push(text.slice(i));
                break;
            }
            out.push(text.slice(i, end + 2));
            i = end + 2;
            continue;
        }

        if (text[i] === '$') {
            const close = closingDollar(text, i);
            if (close === -1) {
                // Unpaired: nothing to escape, and nothing will parse as math.
                out.push('$');
                i += 1;
                continue;
            }
            const body = text.slice(i + 1, close);
            const isMath = body.length > 0 && !/^\s/.test(body) && !/\s$/.test(body);
            if (isMath) {
                out.push(text.slice(i, close + 1));
            } else {
                // Escape both ends, so each renders as a literal `$` and the
                // prose between them stays prose.
                out.push(`\\$${body}\\$`);
            }
            i = close + 1;
            continue;
        }

        out.push(text[i]);
        i += 1;
    }

    return out.join('');
}

/** End offset of a fenced code block starting at `i`, or null if none starts there. */
function matchFence(text: string, i: number): number | null {
    if (i !== 0 && text[i - 1] !== '\n') return null;
    const fence = /^(```+|~~~+)/.exec(text.slice(i));
    if (!fence) return null;
    const marker = fence[1];
    const closing = text.indexOf(`\n${marker}`, i + marker.length);
    if (closing === -1) return text.length;
    // Include the closing fence and its line ending.
    const lineEnd = text.indexOf('\n', closing + 1);
    return lineEnd === -1 ? text.length : lineEnd + 1;
}

/** Offset just past the closing backtick run, or the end of the text. */
function closingBacktick(text: string, i: number): number {
    const run = /^`+/.exec(text.slice(i))![0];
    const closing = text.indexOf(run, i + run.length);
    return closing === -1 ? text.length : closing + run.length;
}

/** Offset of the `$` closing the span opened at `i`, or -1. */
function closingDollar(text: string, i: number): number {
    for (let j = i + 1; j < text.length; j++) {
        if (text[j] === '\n' && text[j + 1] === '\n') return -1; // math does not span a blank line
        if (text[j] !== '$') continue;
        if (text[j - 1] === '\\') continue;
        return j;
    }
    return -1;
}

/** Streaming text made safe to render: as AlphainZ's processPartialContent, with NFC instead of NFKC. */
export function processPartialContent(content: string): string {
    let processed = content.normalize('NFC').replace(/[​-‍﻿­]/g, '');
    const boldMarkers = (processed.match(/\*\*/g) || []).length;
    if (boldMarkers % 2 === 1 && !processed.endsWith('**')) processed = `${processed}**`;
    processed = stripPartialTrailingTag(processed);
    processed = stripUnclosedDisplayMath(processed);
    return processed;
}

function stripPartialTrailingTag(content: string): string {
    const match = content.match(/<[a-z][a-z0-9]*(?:\s+[^>]*)?$/i) ?? content.match(/<\/[a-z]*$/i);
    return match && match.index !== undefined && match.index + match[0].length === content.length ? content.substring(0, match.index) : content;
}

function stripUnclosedDisplayMath(content: string): string {
    const delimiters = Array.from(content.matchAll(/\$\$/g));
    if (delimiters.length % 2 === 0) return content;
    const last = delimiters[delimiters.length - 1];
    return last.index === undefined ? content : content.substring(0, last.index);
}

/** An answer's Markdown as Obsidian should render it (streaming or done). */
export function prepareAnswerMarkdown(content: string): string {
    let text = processPartialContent(content);
    text = normalizeMathDelimiters(text);
    text = normalizeMathEnvironments(text);
    text = escapeCurrencyDollars(text);
    return text;
}
