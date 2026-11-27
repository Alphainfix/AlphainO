/**
 * A passage selected in Reading view: which note it belongs to and where it is now, as the message box offers it.
 */
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async () => {
    class MarkdownView {
        containerEl: any;
        file: any;
        editor: any;
        constructor(containerEl: any, file: any, source: string) {
            this.containerEl = containerEl;
            this.file = file;
            this.editor = { getValue: () => source };
        }
    }
    return { MarkdownView, editorInfoField: {}, getLanguage: () => 'en' };
});

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

import { MarkdownView } from 'obsidian';
import { EditorContext } from '../src/context/editorContext';
import { LINE_END_ATTR, LINE_START_ATTR, liveSectionInfo } from '../src/context/readingSelection';

function setup(source: string, sizerHtml: string) {
    const dom = new JSDOM(`<!doctype html><body><div class="workspace-leaf-content"><div class="markdown-reading-view"><div class="markdown-preview-view"><div class="markdown-preview-sizer">${sizerHtml}</div></div></div></div></body>`);
    (globalThis as any).Element = dom.window.Element;
    (globalThis as any).Node = dom.window.Node;
    const doc = dom.window.document;
    const file = { path: 'Host.md', extension: 'md' };
    const view = new (MarkdownView as any)(doc.querySelector('.workspace-leaf-content'), file, source);
    const app: any = {
        workspace: { getLeavesOfType: (type: string) => (type === 'markdown' ? [{ view }] : []) },
        metadataCache: { getFirstLinkpathDest: (link: string) => (link === 'Other' ? { path: 'Other.md', extension: 'md' } : null) },
    };
    const ctx = new EditorContext(app);
    return { doc, ctx };
}

function selectText(doc: any, node: any, start: number, end: number) {
    const range = doc.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

const HOST = ['# Host', '', 'Intro paragraph.', '', '![[Other]]', '', 'Closing paragraph.'].join('\n');

describe('Reading view: whose passage a selection is', () => {
    it('text in an embedded note is that note’s passage, named without lines (not the host’s, at the embed’s line numbers)', () => {
        const { doc, ctx } = setup(
            HOST,
            `<div ${LINE_START_ATTR}="0" ${LINE_END_ATTR}="0"><h1>Host</h1></div>
             <div ${LINE_START_ATTR}="4" ${LINE_END_ATTR}="4"><div class="internal-embed markdown-embed" src="Other"><div class="markdown-embed-content"><div class="markdown-preview-view"><div class="markdown-preview-sizer">
                <div ${LINE_START_ATTR}="9" ${LINE_END_ATTR}="9"><p id="emb">A sentence that lives in Other.md.</p></div>
             </div></div></div></div></div>`,
        );
        const textNode = doc.getElementById('emb').firstChild;
        selectText(doc, textNode, 0, textNode.textContent.length);
        (ctx as any).readReadingSelection(doc);
        const s = ctx.current.selection!;
        expect(s.path).toBe('Other.md');
        expect([s.from, s.fromLine, s.toLine]).toEqual([-1, 0, 0]);
        expect(s.text).toBe('A sentence that lives in Other.md.');
    });

    it('text outside the note’s own blocks (the title, the backlinks under it) is not offered', () => {
        const { doc, ctx } = setup(
            HOST,
            `<div class="mod-header"><div class="inline-title">Host</div></div>
             <div ${LINE_START_ATTR}="2" ${LINE_END_ATTR}="2"><p>Intro paragraph.</p></div>
             <div class="mod-footer"><div class="embedded-backlinks"><div class="search-result-file-match" id="bl">Text quoted from Some Other Note that links here.</div></div></div>`,
        );
        const textNode = doc.getElementById('bl').firstChild;
        selectText(doc, textNode, 0, 20);
        (ctx as any).readReadingSelection(doc);
        expect(ctx.current.selection).toBeNull();
    });
});

describe('Reading view: where a passage is after lines were added above it', () => {
    // When drawn, the quote was on line 8 and the paragraph on line 10 (0-based 7 and 9). Two lines were then added at the top.
    const before = ['# Bees', '', 'Intro.', '', 'More.', '', '', '> Bees eat nectar.', '', 'Bees eat nectar and pollen.'].join('\n');
    const after = ['New line A', 'New line B', ...before.split('\n')].join('\n');

    it('asks Obsidian where the block is now, and finds the passage there, not in the block that slid under the old lines', () => {
        const { doc, ctx } = setup(after, `<div ${LINE_START_ATTR}="9" ${LINE_END_ATTR}="9" id="para"><p id="p">Bees eat nectar and pollen.</p></div>`);
        liveSectionInfo.set(doc.getElementById('para'), () => ({ lineStart: 11, lineEnd: 11 }));
        const textNode = doc.getElementById('p').firstChild;
        selectText(doc, textNode, 0, 'Bees eat nectar'.length);
        (ctx as any).readReadingSelection(doc);
        const s = ctx.current.selection!;
        expect([s.fromLine, s.toLine]).toEqual([12, 12]);
        expect(after.slice(s.from, s.to)).toBe('Bees eat nectar');
    });

    it('without Obsidian’s answer, a passage no longer under its old lines is looked for in the whole note', () => {
        const { doc, ctx } = setup(after, `<div ${LINE_START_ATTR}="9" ${LINE_END_ATTR}="9"><p id="p">Bees eat nectar and pollen.</p></div>`);
        const textNode = doc.getElementById('p').firstChild;
        selectText(doc, textNode, 'Bees eat '.length, 'Bees eat nectar and pollen'.length);
        (ctx as any).readReadingSelection(doc);
        const s = ctx.current.selection!;
        expect(after.slice(s.from, s.to)).toBe('nectar and pollen');
        expect(s.fromLine).toBe(12);
    });
});
