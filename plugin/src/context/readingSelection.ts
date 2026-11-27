/**
 * A selection in Reading view, found in the note's source.
 *
 * Reading view shows rendered text, so a selection there has no source
 * offsets. Two public pieces make them recoverable: a Markdown post-processor
 * stamps every rendered block with the source lines it came from
 * (`getSectionInfo`), and the selected text is then looked for in those lines,
 * first word for word and then with Markdown's markup (emphasis, code ticks,
 * link brackets, headings, list and quote markers) left out of the comparison.
 * When it cannot be found there, the selection is not offered: nothing is
 * guessed elsewhere in the note.
 */

/** The attributes the post-processor stamps on each rendered block. */
export const LINE_START_ATTR = 'data-alphaino-line';
export const LINE_END_ATTR = 'data-alphaino-line-end';

export interface SourceRange {
    from: number;
    to: number;
}

/** Offsets of each line's start in a text. */
function lineStarts(text: string): number[] {
    const starts = [0];
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
    return starts;
}

/**
 * The text with Markdown markup removed, and for every character kept, its
 * offset in the original. Collapses runs of whitespace to one space.
 */
export function plainWithMap(source: string): { plain: string; map: number[] } {
    let plain = '';
    const map: number[] = [];
    let i = 0;
    let lineStart = true;
    let lastSpace = false;
    const push = (ch: string, at: number) => {
        if (/\s/.test(ch)) {
            if (lastSpace || plain === '') return;
            plain += ' ';
            map.push(at);
            lastSpace = true;
            return;
        }
        plain += ch;
        map.push(at);
        lastSpace = false;
    };
    while (i < source.length) {
        const ch = source[i];
        if (lineStart) {
            // Heading, quote, list and task markers at the start of a line.
            const marker = /^(?:[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+))+/.exec(source.slice(i));
            if (marker) {
                i += marker[0].length;
                lineStart = false;
                continue;
            }
            lineStart = false;
        }
        if (ch === '\n') {
            push(' ', i);
            i += 1;
            lineStart = true;
            continue;
        }
        // [[target|alias]] shows the alias; [[target]] the target; ![[...]] embeds show nothing selectable.
        if (source.startsWith('[[', i) || source.startsWith('![[', i)) {
            const open = source.startsWith('![[', i) ? 3 : 2;
            const close = source.indexOf(']]', i + open);
            if (close !== -1) {
                const inner = source.slice(i + open, close);
                const bar = inner.indexOf('|');
                const shownFrom = bar >= 0 ? i + open + bar + 1 : i + open;
                if (open === 2) for (let k = shownFrom; k < close; k++) push(source[k], k);
                i = close + 2;
                continue;
            }
        }
        // [text](url) shows the text.
        if (ch === '[') {
            const m = /^\[([^\]\n]*)\]\([^)\n]*\)/.exec(source.slice(i));
            if (m) {
                for (let k = 0; k < m[1].length; k++) push(source[i + 1 + k], i + 1 + k);
                i += m[0].length;
                continue;
            }
        }
        // Emphasis, strike, highlight and code markers are not shown.
        if (ch === '*' || ch === '_' || ch === '~' || ch === '`' || (ch === '=' && source[i + 1] === '=')) {
            i += ch === '=' ? 2 : 1;
            continue;
        }
        push(ch, i);
        i += 1;
    }
    return { plain, map };
}

function squash(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Where a selected (rendered) text is in the source, within the given lines
 * (0-based, inclusive), or null. A word-for-word match wins; otherwise the
 * text is matched against the lines with their markup left out.
 */
export function findInSource(source: string, selected: string, firstLine: number, lastLine: number): SourceRange | null {
    const wanted = squash(selected);
    if (!wanted) return null;
    const starts = lineStarts(source);
    const from = starts[Math.max(0, Math.min(firstLine, starts.length - 1))];
    const end = lastLine + 1 < starts.length ? starts[lastLine + 1] : source.length;
    const region = source.slice(from, end);

    const exact = region.indexOf(selected.trim());
    if (exact !== -1 && region.indexOf(selected.trim(), exact + 1) === -1) return { from: from + exact, to: from + exact + selected.trim().length };

    const { plain, map } = plainWithMap(region);
    const at = plain.indexOf(wanted);
    if (at === -1 || plain.indexOf(wanted, at + 1) !== -1) return null;
    const startOffset = map[at];
    const lastOffset = map[at + wanted.length - 1];
    if (startOffset === undefined || lastOffset === undefined) return null;
    let start = from + startOffset;
    let to = from + lastOffset + 1;
    // Keep markup whole: close what the passage opened ("**bold**", not "**bold"), and open what it closes.
    const count = (text: string, marker: string) =>
        (marker.length === 2 ? text : text.replace(/\*\*|__|~~|==/g, '')).split(marker).length - 1;
    for (const marker of ['**', '__', '~~', '==', '`', '*', '_']) {
        if (count(source.slice(start, to), marker) % 2 === 0) continue;
        if (source.startsWith(marker, to)) to += marker.length;
        else if (start - marker.length >= from && source.slice(start - marker.length, start) === marker) start -= marker.length;
    }
    return { from: start, to };
}

/**
 * Where each rendered block of a note is now, asked of Obsidian when a selection is read rather than
 * remembered from when the block was drawn: a block that did not change keeps its element, and the lines it
 * was stamped with go stale as soon as lines are added above it.
 */
export const liveSectionInfo = new WeakMap<Element, () => { lineStart: number; lineEnd: number } | null>();
