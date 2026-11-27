/**
 * Splitting a note into passages that can be embedded and searched.
 *
 * Markdown-aware: a heading starts a new section, a section is cut at
 * paragraph breaks into passages of about {@link TARGET_UNITS}, and a fenced
 * code block or a `$$` math block is never cut. Every passage keeps the
 * heading path it sits under and the 1-based lines it covers in the file, so a
 * hit can be cited and read in place. YAML frontmatter is left out; the lines
 * still count.
 *
 * Pure: text in, passages out.
 */
import { hashString } from './text';

/** Bumped when the way notes are cut changes, so stored passages are cut again. */
export const CHUNKER_VERSION = 1;

/**
 * Size of a passage in units: a character is one unit, a CJK character three.
 * A CJK character carries about as much as three Latin ones, so this keeps a
 * passage near the same number of tokens in either script. 1200 matches the
 * passage size AlphainZ uses for papers.
 */
export const TARGET_UNITS = 1200;
export const CJK_UNIT_WEIGHT = 3;

/** The floor for a target size: below it a CJK character alone would not fit. */
const MIN_TARGET_UNITS = 60;

/** An unbreakable block (code, math) longer than this keeps only its first lines. */
export const MAX_ATOMIC_CHARS = 8000;

/** Most of a passage that is sent to the embedding model, in units. */
export const EMBED_MAX_UNITS = 6000;

export interface NoteChunk {
    /** Position among the note's passages, from 0. */
    index: number;
    /** The headings above the passage, outermost first; empty before the first heading. */
    heading: string[];
    /** First and last line of the passage in the file, 1-based. */
    startLine: number;
    endLine: number;
    /** The Markdown of those lines. */
    text: string;
}

/** The lines of a note, split the way the editor splits them. */
export function splitLines(text: string): string[] {
    return text.replace(/^﻿/, '').split(/\r\n?|\n/);
}

/** Index of the first line after the frontmatter; 0 when the note has none. */
export function frontmatterEnd(lines: string[]): number {
    if (lines.length === 0 || !/^---[ \t]*$/.test(lines[0])) return 0;
    for (let i = 1; i < lines.length; i += 1) {
        if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i])) return i + 1;
    }
    return 0;
}

function isCjkUnit(code: number): boolean {
    return (
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xf900 && code <= 0xfaff)
    );
}

/** The size of a text in units (see {@link TARGET_UNITS}). */
export function textUnits(text: string): number {
    let units = 0;
    for (let i = 0; i < text.length; i += 1) units += isCjkUnit(text.charCodeAt(i)) ? CJK_UNIT_WEIGHT : 1;
    return units;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/** A run of lines (0-based, inclusive) that is cut as a whole when it fits. */
interface Block {
    kind: 'text' | 'atomic';
    start: number;
    end: number;
}

interface Section {
    heading: string[];
    blocks: Block[];
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** An opening code fence: its character and length. */
function fenceOpening(line: string): { char: string; length: number } | null {
    const match = /^[ \t>]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) return null;
    // A backtick fence cannot have a backtick in its info string: that is inline code.
    if (match[1][0] === '`' && match[2].includes('`')) return null;
    return { char: match[1][0], length: match[1].length };
}

/** Index of the line that closes the fence opened at `from`; the last line when it never closes. */
function fenceEnd(lines: string[], from: number, fence: { char: string; length: number }): number {
    const closing = new RegExp(`^[ \\t>]*\\${fence.char}{${fence.length},}[ \\t]*$`);
    for (let i = from + 1; i < lines.length; i += 1) {
        if (closing.test(lines[i])) return i;
    }
    return lines.length - 1;
}

/** Whether a line opens a `$$` block: it starts with `$$` and has an odd number of them. */
function opensMath(line: string): boolean {
    const text = line.replace(/^[ \t>]+/, '');
    if (!text.startsWith('$$')) return false;
    return (text.split('$$').length - 1) % 2 === 1;
}

/** Index of the line that closes the `$$` block opened at `from`; -1 when none does. */
function mathEnd(lines: string[], from: number): number {
    for (let i = from + 1; i < lines.length; i += 1) {
        if (lines[i].includes('$$')) return i;
    }
    return -1;
}

function parseSections(lines: string[], from: number): Section[] {
    const sections: Section[] = [];
    const stack: Array<{ level: number; text: string }> = [];
    let current: Section = { heading: [], blocks: [] };
    let textStart = -1;
    // One `$$` that never closes would swallow the rest of the note; after the
    // first such line none is treated as opening a block.
    let mathDisabled = false;

    const endText = (before: number) => {
        if (textStart >= 0) current.blocks.push({ kind: 'text', start: textStart, end: before - 1 });
        textStart = -1;
    };

    let i = from;
    while (i < lines.length) {
        const line = lines[i];
        const fence = fenceOpening(line);
        if (fence) {
            endText(i);
            const end = fenceEnd(lines, i, fence);
            current.blocks.push({ kind: 'atomic', start: i, end });
            i = end + 1;
            continue;
        }
        if (!mathDisabled && opensMath(line)) {
            const end = mathEnd(lines, i);
            if (end >= 0) {
                endText(i);
                current.blocks.push({ kind: 'atomic', start: i, end });
                i = end + 1;
                continue;
            }
            mathDisabled = true;
        }
        const heading = HEADING.exec(line);
        if (heading && heading[2].trim() !== '') {
            endText(i);
            const level = heading[1].length;
            while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
            stack.push({ level, text: heading[2].trim() });
            if (current.blocks.length > 0) sections.push(current);
            current = { heading: stack.map((entry) => entry.text), blocks: [] };
            i += 1;
            continue;
        }
        if (line.trim() === '') {
            endText(i);
        } else if (textStart < 0) {
            textStart = i;
        }
        i += 1;
    }
    endText(lines.length);
    if (current.blocks.length > 0) sections.push(current);
    return sections;
}

/** The headings of a note, from its text: not those in frontmatter, code or math. `line` counts from 0. */
export function noteHeadings(lines: string[]): Array<{ heading: string; level: number; line: number }> {
    const found: Array<{ heading: string; level: number; line: number }> = [];
    let mathDisabled = false;
    let i = frontmatterEnd(lines);
    while (i < lines.length) {
        const fence = fenceOpening(lines[i]);
        if (fence) {
            i = fenceEnd(lines, i, fence) + 1;
            continue;
        }
        if (!mathDisabled && opensMath(lines[i])) {
            const end = mathEnd(lines, i);
            if (end >= 0) {
                i = end + 1;
                continue;
            }
            mathDisabled = true;
        }
        const heading = HEADING.exec(lines[i]);
        if (heading && heading[2].trim() !== '') found.push({ heading: heading[2].trim(), level: heading[1].length, line: i });
        i += 1;
    }
    return found;
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/** A passage before its text is read out: a line range, or text cut from within one line. */
interface Piece {
    start: number;
    end: number;
    text?: string;
}

function blockUnits(lines: string[], block: Block): number {
    let units = 0;
    for (let i = block.start; i <= block.end; i += 1) units += textUnits(lines[i]) + 1;
    return units - 1;
}

function isSentenceEnd(line: string, at: number): boolean {
    const char = line[at];
    if ('。！？；…!?;'.includes(char)) return true;
    return char === '.' && (at + 1 >= line.length || /\s/.test(line[at + 1]));
}

/** A single long line cut into pieces of at most `target` units, at sentence ends where it can. */
function splitLine(line: string, target: number): string[] {
    const pieces: string[] = [];
    let start = 0;
    while (start < line.length) {
        let end = start;
        let units = 0;
        let sentenceEnd = -1;
        let space = -1;
        while (end < line.length) {
            const code = line.charCodeAt(end);
            units += isCjkUnit(code) ? CJK_UNIT_WEIGHT : 1;
            if (units > target) break;
            end += 1;
            if (isSentenceEnd(line, end - 1)) sentenceEnd = end;
            else if (code === 32 || code === 9) space = end;
        }
        if (end >= line.length) {
            pieces.push(line.slice(start));
            break;
        }
        const width = end - start;
        let cut = end;
        if (sentenceEnd > start + width * 0.4) cut = sentenceEnd;
        else if (space > start + width * 0.6) cut = space;
        // Never cut between the halves of a surrogate pair.
        const before = line.charCodeAt(cut - 1);
        if (cut > start + 1 && before >= 0xd800 && before <= 0xdbff) cut -= 1;
        if (cut <= start) cut = Math.min(start + 1, line.length);
        pieces.push(line.slice(start, cut));
        start = cut;
    }
    return pieces.map((piece) => piece.trim()).filter((piece) => piece !== '');
}

/** An over-long run of text lines cut at line breaks; a line that is itself too long is cut within. */
function splitTextBlock(lines: string[], block: Block, target: number): Piece[] {
    const pieces: Piece[] = [];
    let start = -1;
    let end = -1;
    let units = 0;
    const flush = () => {
        if (start >= 0) pieces.push({ start, end });
        start = -1;
        units = 0;
    };
    for (let i = block.start; i <= block.end; i += 1) {
        const lineUnits = textUnits(lines[i]);
        if (lineUnits > target) {
            flush();
            for (const text of splitLine(lines[i], target)) pieces.push({ start: i, end: i, text });
            continue;
        }
        if (start >= 0 && units + lineUnits + 1 > target) flush();
        if (start < 0) start = i;
        end = i;
        units += lineUnits + 1;
    }
    flush();
    return pieces;
}

/** An over-long code or math block as one passage, cut off after {@link MAX_ATOMIC_CHARS}. */
function atomicPiece(lines: string[], block: Block): Piece {
    if (lines[block.start].length > MAX_ATOMIC_CHARS) {
        return { start: block.start, end: block.start, text: lines[block.start].slice(0, MAX_ATOMIC_CHARS) };
    }
    let end = block.start;
    let chars = lines[block.start].length;
    while (end < block.end && chars + 1 + lines[end + 1].length <= MAX_ATOMIC_CHARS) {
        end += 1;
        chars += 1 + lines[end].length;
    }
    return { start: block.start, end };
}

function packSection(section: Section, lines: string[], target: number): Piece[] {
    const pieces: Piece[] = [];
    const group: Block[] = [];
    let groupUnits = 0;
    const flush = () => {
        if (group.length > 0) pieces.push({ start: group[0].start, end: group[group.length - 1].end });
        group.length = 0;
        groupUnits = 0;
    };
    for (const block of section.blocks) {
        const units = blockUnits(lines, block);
        if (units > target) {
            flush();
            if (block.kind === 'atomic') pieces.push(atomicPiece(lines, block));
            else pieces.push(...splitTextBlock(lines, block, target));
            continue;
        }
        if (group.length > 0 && groupUnits + units + 1 > target) flush();
        groupUnits += group.length > 0 ? units + 1 : units;
        group.push(block);
    }
    flush();
    return pieces;
}

/** The passages of a note's Markdown. */
export function chunkNote(raw: string, options: { targetUnits?: number } = {}): NoteChunk[] {
    const target = Math.max(options.targetUnits ?? TARGET_UNITS, MIN_TARGET_UNITS);
    const lines = splitLines(raw);
    const chunks: NoteChunk[] = [];
    for (const section of parseSections(lines, frontmatterEnd(lines))) {
        for (const piece of packSection(section, lines, target)) {
            let end = piece.end;
            if (piece.text === undefined) {
                while (end > piece.start && lines[end].trim() === '') end -= 1;
            }
            const text = piece.text ?? lines.slice(piece.start, end + 1).join('\n');
            // A passage with nothing to read in it (an image embed, a rule) is not worth keeping.
            if (text.trim() === '' || cleanForEmbedding(text) === '') continue;
            chunks.push({ index: chunks.length, heading: section.heading, startLine: piece.start + 1, endLine: end + 1, text });
        }
    }
    return chunks;
}

// ---------------------------------------------------------------------------
// What is embedded
// ---------------------------------------------------------------------------

/** The label of a wikilink target: the note's name, and the heading when there is one. */
function linkLabel(target: string): string {
    const [page, ...rest] = target.split('#');
    const name = page.slice(page.lastIndexOf('/') + 1).trim();
    const anchor = rest.join(' ').replace(/\^.*$/, '').trim();
    return [name, anchor].filter((part) => part !== '').join(' ');
}

/** Inline Markdown reduced to its words: links, embeds and emphasis marks. */
function cleanInline(text: string): string {
    return text
        .replace(/!\[\[[^\]]*\]\]/g, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_match, target: string, alias?: string) => (alias && alias.trim()) || linkLabel(target))
        .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '$1')
        .replace(/https?:\/\/([^\s/)>\]]+)[^\s)>\]]*/g, '$1')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/==([^=\n]+)==/g, '$1');
}

/**
 * Markdown scaffolding taken out before embedding: comments, link targets,
 * embeds, heading marks, quote marks, table rules and pipes. The words, code
 * and notation stay.
 */
export function cleanForEmbedding(text: string): string {
    return cleanInline(text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/%%[\s\S]*?%%/g, ' '))
        .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '')
        .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '')
        .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_match, row: string) => row.replace(/\|/g, ' '))
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
        .replace(/^[ \t]*(?:>[ \t]?)+/gm, '')
        .replace(/\[![\w-]+\][+-]?[ \t]*/g, '')
        .replace(/^([ \t]*[-*+][ \t]+)\[[ xX]\][ \t]+/gm, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** `Title › Heading › Sub`: where a passage sits, with neighbouring repeats (a first heading equal to the title) dropped. */
export function breadcrumb(title: string, heading: string[]): string {
    const parts: string[] = [];
    for (const raw of [title, ...heading]) {
        const part = cleanInline(raw).replace(/\s+/g, ' ').trim();
        if (part === '') continue;
        if (parts.length > 0 && parts[parts.length - 1].toLowerCase() === part.toLowerCase()) continue;
        parts.push(part);
    }
    return parts.join(' › ');
}

function capUnits(text: string, max: number): string {
    let units = 0;
    for (let i = 0; i < text.length; i += 1) {
        units += isCjkUnit(text.charCodeAt(i)) ? CJK_UNIT_WEIGHT : 1;
        if (units > max) {
            const before = text.charCodeAt(i - 1);
            return text.slice(0, before >= 0xd800 && before <= 0xdbff ? i - 1 : i);
        }
    }
    return text;
}

/** What the embedding model reads for a passage: its place in the note, then its words. */
export function embeddingText(title: string, heading: string[], text: string): string {
    return capUnits(`${breadcrumb(title, heading)}\n\n${cleanForEmbedding(text)}`, EMBED_MAX_UNITS);
}

/**
 * Identifies what a passage's vector was made from. The heading path counts
 * (a renamed heading changes the embedded text) and the title does not (a
 * renamed note keeps its vectors).
 */
export function chunkHash(heading: string[], text: string): string {
    return hashString(`${heading.join(' › ')}\u0001${text}`);
}
