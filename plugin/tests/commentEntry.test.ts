import { describe, expect, it } from 'vitest';
import { commentEntry } from '../src/view/commentEntry';

describe('a passage answer saved as a comment', () => {
    it('labels the question and the answer, with no signature line (the author is AlphainO)', () => {
        const text = commentEntry('  Why do they dance?  ', 'Because the hive needs to know.');
        expect(text).toBe('**Q:** Why do they dance?\n\n**A:** Because the hive needs to know.');
        expect(text).not.toContain('— AlphainO');
    });

    it('turns headings into bold lines and keeps the rest of the Markdown', () => {
        const answer = '## Why the stripes barely matter\nThe odometer reads **image motion**.\n\n### In your notes ##\nSee [[2026-10-07 Journal club]].';
        expect(commentEntry('Why?', answer)).toBe(
            '**Q:** Why?\n\n**A:** **Why the stripes barely matter**\nThe odometer reads **image motion**.\n\n**In your notes**\nSee [[2026-10-07 Journal club]].',
        );
    });

    it('leaves a # that is not a heading alone', () => {
        expect(commentEntry('Q', 'Issue #12 and #tag stay.')).toBe('**Q:** Q\n\n**A:** Issue #12 and #tag stay.');
    });
});
