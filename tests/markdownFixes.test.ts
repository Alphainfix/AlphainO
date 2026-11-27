import { describe, expect, it } from 'vitest';
import { prepareAnswerMarkdown, processPartialContent } from '../src/view/markdownFixes';

describe('answer Markdown before Obsidian renders it (AlphainZ’s fixes)', () => {
    it('turns \\( \\) and \\[ \\] into $ and $$', () => {
        expect(prepareAnswerMarkdown('The half-life \\( t_{1/2} \\) grows.')).toBe('The half-life $t_{1/2}$ grows.');
        expect(prepareAnswerMarkdown('So:\\[E = mc^2\\]done')).toContain('$$\nE = mc^2\n$$');
    });

    it('leaves code alone', () => {
        expect(prepareAnswerMarkdown('Write `\\(x\\)` for inline math.')).toBe('Write `\\(x\\)` for inline math.');
    });

    it('keeps two prices from becoming one formula', () => {
        expect(prepareAnswerMarkdown('It costs $5 and then $10.')).not.toMatch(/(^|[^\\])\$5 and then \$10/);
    });

    it('keeps Chinese full-width punctuation (unlike NFKC)', () => {
        expect(processPartialContent('你好，世界！（测试）：完成。')).toBe('你好，世界！（测试）：完成。');
    });

    it('closes a dangling ** and holds back a half-written $$ block while streaming', () => {
        expect(processPartialContent('This is **bold')).toBe('This is **bold**');
        expect(processPartialContent('Before\n$$\nE = m')).toBe('Before\n');
        expect(processPartialContent('Text <span class="x"')).toBe('Text ');
    });
});
