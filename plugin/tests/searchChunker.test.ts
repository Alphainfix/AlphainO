import { describe, expect, it } from 'vitest';
import {
    EMBED_MAX_UNITS,
    MAX_ATOMIC_CHARS,
    breadcrumb,
    chunkHash,
    chunkNote,
    cleanForEmbedding,
    embeddingText,
    frontmatterEnd,
    noteHeadings,
    splitLines,
    textUnits,
} from '../src/search/chunker';

describe('chunkNote: structure', () => {
    it('leaves the frontmatter out but counts its lines', () => {
        const chunks = chunkNote('---\ntitle: x\ntags: [a]\n---\n# Heading\n\nA paragraph of text.\n');
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toMatchObject({ index: 0, heading: ['Heading'], startLine: 7, endLine: 7, text: 'A paragraph of text.' });
        expect(chunks.map((chunk) => chunk.text).join('')).not.toContain('title');
    });

    it('does not take a leading rule for frontmatter when it never closes', () => {
        const chunks = chunkNote('---\nnot yaml\n\nsome text\n');
        expect(chunks.map((chunk) => chunk.startLine)).toEqual([1]);
        expect(frontmatterEnd(splitLines('---\na: 1\n---\nx'))).toBe(3);
        expect(frontmatterEnd(splitLines('x\n---\na: 1\n---'))).toBe(0);
    });

    it('starts a section at each heading and keeps the path of headings above', () => {
        const note = ['intro line', '', '# A', '', 'under a', '', '## B', '', 'under b', '', '### C', '', 'under c', '', '## D', '', 'under d', '', '# E', '', 'under e'].join('\n');
        expect(chunkNote(note).map((chunk) => [chunk.heading, chunk.text, chunk.startLine])).toEqual([
            [[], 'intro line', 1],
            [['A'], 'under a', 5],
            [['A', 'B'], 'under b', 9],
            [['A', 'B', 'C'], 'under c', 13],
            [['A', 'D'], 'under d', 17],
            [['E'], 'under e', 21],
        ]);
    });

    it('skips a heading with nothing under it, and ignores closing hashes', () => {
        const chunks = chunkNote('# Empty\n## Real ##\n\ntext\n');
        expect(chunks).toHaveLength(1);
        expect(chunks[0].heading).toEqual(['Empty', 'Real']);
    });

    it('does not take a tag or a hash in a code block for a heading', () => {
        const chunks = chunkNote('#tag at the start\n\n```py\n# comment\n```\n');
        expect(chunks.every((chunk) => chunk.heading.length === 0)).toBe(true);
    });

    it('packs neighbouring paragraphs up to the target size and starts a new passage after it', () => {
        const paragraph = (letter: string) => letter.repeat(45);
        const note = [paragraph('a'), '', paragraph('b'), '', paragraph('c')].join('\n');
        const chunks = chunkNote(note, { targetUnits: 100 });
        expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
            [1, 3],
            [5, 5],
        ]);
        expect(chunks[0].text).toBe(`${paragraph('a')}\n\n${paragraph('b')}`);
    });

    it('numbers lines the way the editor does, whatever the line endings', () => {
        const chunks = chunkNote('﻿# T\r\n\r\nfirst\r\n\r\nsecond\r');
        expect(chunks[0]).toMatchObject({ heading: ['T'], startLine: 3, endLine: 5 });
    });

    it('returns nothing for an empty note, one with only frontmatter, or one with only images', () => {
        expect(chunkNote('')).toEqual([]);
        expect(chunkNote('---\na: 1\n---\n')).toEqual([]);
        expect(chunkNote('![[picture.png]]\n\n---\n')).toEqual([]);
    });
});

describe('chunkNote: blocks that are not cut', () => {
    it('keeps a fenced code block whole, however long, and does not read headings inside it', () => {
        const code = Array.from({ length: 300 }, (_, i) => `# line ${i} of the code`);
        const note = ['# Doc', '', 'before', '', '```py', ...code, '```', '', 'after'].join('\n');
        const chunks = chunkNote(note, { targetUnits: 100 });
        const block = chunks.find((chunk) => chunk.text.includes('```py'));
        expect(block).toBeDefined();
        expect(block?.text.startsWith('```py')).toBe(true);
        expect(block?.text.endsWith('```')).toBe(true);
        expect(block?.text).toContain('# line 299 of the code');
        expect(chunks.every((chunk) => chunk.heading.join() === 'Doc')).toBe(true);
    });

    it('keeps a $$ math block whole', () => {
        const math = ['$$', ...Array.from({ length: 40 }, (_, i) => `x_{${i}} = ${i} \\\\`), '$$'];
        const chunks = chunkNote(['intro', '', ...math, '', 'outro'].join('\n'), { targetUnits: 100 });
        const block = chunks.find((chunk) => chunk.text.startsWith('$$'));
        expect(block?.text.endsWith('$$')).toBe(true);
        expect(block?.text.split('\n')).toHaveLength(math.length);
    });

    it('does not let a $$ that never closes swallow the rest of the note', () => {
        const chunks = chunkNote('$$ stray\n\n# Heading\n\ntext\n');
        expect(chunks.map((chunk) => chunk.heading)).toEqual([[], ['Heading']]);
    });

    it('treats display math on one line as ordinary text', () => {
        expect(chunkNote('$$x = 1$$\n\nnext')).toHaveLength(1);
    });

    it('runs an unterminated code fence to the end of the note', () => {
        const chunks = chunkNote('text\n\n```js\nlet a = 1;\n\nlet b = 2;\n');
        const last = chunks[chunks.length - 1];
        expect(last.text.endsWith('```js\nlet a = 1;\n\nlet b = 2;')).toBe(true);
        expect(last.endLine).toBe(6);
    });

    it('keeps only the first lines of a code block longer than the cap', () => {
        const code = Array.from({ length: 2000 }, (_, i) => `const value${i} = ${i};`);
        const chunks = chunkNote(['```', ...code, '```'].join('\n'));
        expect(chunks).toHaveLength(1);
        expect(chunks[0].text.length).toBeLessThanOrEqual(MAX_ATOMIC_CHARS);
        expect(chunks[0].endLine).toBeLessThan(2002);
        expect(chunks[0].text).toBe(['```', ...code].join('\n').slice(0, chunks[0].text.length));
    });
});

describe('chunkNote: long text', () => {
    it('cuts a long line at sentence ends, into pieces within the target', () => {
        const sentences = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} is here.`);
        const chunks = chunkNote(sentences.join(' '), { targetUnits: 100 });
        expect(chunks.length).toBeGreaterThan(2);
        for (const chunk of chunks) {
            expect(textUnits(chunk.text)).toBeLessThanOrEqual(100);
            expect(chunk.text.endsWith('.')).toBe(true);
            expect(chunk.startLine).toBe(1);
            expect(chunk.endLine).toBe(1);
        }
        expect(chunks.map((chunk) => chunk.text).join(' ')).toBe(sentences.join(' '));
    });

    it('counts a CJK character as three units, so a Chinese passage is shorter in characters', () => {
        expect(textUnits('abc')).toBe(3);
        expect(textUnits('你好')).toBe(6);
        const sentences = Array.from({ length: 20 }, (_, i) => `我今天去了商店买东西${i % 10}。`);
        const chunks = chunkNote(sentences.join(''), { targetUnits: 120 });
        expect(chunks.length).toBeGreaterThanOrEqual(5);
        for (const chunk of chunks) {
            expect(textUnits(chunk.text)).toBeLessThanOrEqual(120);
            expect(chunk.text.endsWith('。')).toBe(true);
        }
        expect(chunks.map((chunk) => chunk.text).join('')).toBe(sentences.join(''));
    });

    it('cuts a block of many lines at line breaks', () => {
        const lines = Array.from({ length: 30 }, (_, i) => `- list item number ${i}`);
        const chunks = chunkNote(lines.join('\n'), { targetUnits: 120 });
        expect(chunks.length).toBeGreaterThan(2);
        for (const chunk of chunks) expect(chunk.text.split('\n').every((line) => line.startsWith('- list item'))).toBe(true);
        expect(chunks.map((chunk) => chunk.text).join('\n')).toBe(lines.join('\n'));
        expect(chunks[1].startLine).toBe(chunks[0].endLine + 1);
    });

    it('never cuts between the halves of a surrogate pair', () => {
        const chunks = chunkNote('😀'.repeat(400), { targetUnits: 100 });
        for (const chunk of chunks) expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(chunk.text)).toBe(false);
    });
});

describe('what is embedded', () => {
    it('prefixes the passage with the note title and its headings', () => {
        const text = embeddingText('My note', ['Intro', 'Details'], 'Some words here.');
        expect(text).toBe('My note › Intro › Details\n\nSome words here.');
    });

    it('does not repeat a first heading that is the title, in any case', () => {
        expect(breadcrumb('Title', ['title', 'Sub'])).toBe('Title › Sub');
        expect(breadcrumb('Title', [])).toBe('Title');
    });

    it('reduces Markdown to its words', () => {
        const cleaned = cleanForEmbedding(
            [
                '## Heading',
                '> [!note] Callout title',
                '> quoted words',
                'See [[Folder/Other note|the other]] and [[Plain]] and [[Note#Section]] and [link](https://example.com/page) at https://arxiv.org/abs/1 ok.',
                'Some **bold**, ~~struck~~ and ==marked== text %%hidden%% <!-- gone -->.',
                '![[picture.png]] ![alt text](img.png)',
                '- [x] done task',
                '| a | b |',
                '|---|---|',
                '| 1 | 2 |',
                '',
                '---',
                '',
                '',
                '',
                'end',
            ].join('\n'),
        );
        expect(cleaned).toContain('Heading');
        expect(cleaned).not.toContain('##');
        expect(cleaned).toContain('Callout title');
        expect(cleaned).not.toContain('[!note]');
        expect(cleaned).toContain('quoted words');
        expect(cleaned).toContain('the other');
        expect(cleaned).toContain('and Plain and');
        expect(cleaned).toContain('Note Section');
        expect(cleaned).toContain('and link at arxiv.org ok');
        expect(cleaned).toContain('Some bold, struck and marked text');
        expect(cleaned).not.toMatch(/hidden|gone|picture\.png|img\.png/);
        expect(cleaned).toContain('alt text');
        expect(cleaned).toContain('- done task');
        expect(cleaned).toContain('a b');
        expect(cleaned).not.toContain('---');
        expect(cleaned).not.toMatch(/\n\n\n/);
        expect(cleaned.endsWith('end')).toBe(true);
    });

    it('caps what is sent to the model', () => {
        const text = embeddingText('T', [], 'word '.repeat(5000));
        expect(textUnits(text)).toBeLessThanOrEqual(EMBED_MAX_UNITS);
        const chinese = embeddingText('T', [], '汉'.repeat(5000));
        expect(textUnits(chinese)).toBeLessThanOrEqual(EMBED_MAX_UNITS);
    });
});

describe('chunkHash', () => {
    it('depends on the heading path and the text', () => {
        expect(chunkHash(['A'], 'text')).toBe(chunkHash(['A'], 'text'));
        expect(chunkHash(['A'], 'text')).not.toBe(chunkHash(['B'], 'text'));
        expect(chunkHash(['A'], 'text')).not.toBe(chunkHash(['A'], 'other'));
        expect(chunkHash(['A', 'B'], 'x')).not.toBe(chunkHash(['A B'], 'x'.concat('')));
    });
});

describe('noteHeadings', () => {
    it('lists the headings with their level and line, from the text', () => {
        const lines = splitLines('# One\n\ntext\n\n## Two ##\n\n### Three\n');
        expect(noteHeadings(lines)).toEqual([
            { heading: 'One', level: 1, line: 0 },
            { heading: 'Two', level: 2, line: 4 },
            { heading: 'Three', level: 3, line: 6 },
        ]);
    });

    it('skips what is not a heading: frontmatter, code, math, tags, and a heading with no text', () => {
        const lines = splitLines(
            ['---', '# in the frontmatter', '---', '#tag', '```', '# in code', '```', '$$', '# in math', '$$', '#', '# Real'].join('\n'),
        );
        expect(noteHeadings(lines)).toEqual([{ heading: 'Real', level: 1, line: 11 }]);
    });
});
