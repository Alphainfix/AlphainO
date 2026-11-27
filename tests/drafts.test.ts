import { describe, expect, it } from 'vitest';
import { DraftShelf, EMPTY_DRAFT, MAX_PARKED_DRAFTS, draftKey, isDraftEmpty } from '../src/view/drafts';

const draft = (text: string) => ({ text, notes: [], images: [], quote: null });

describe('drafts kept per conversation', () => {
    it('gives back what was parked for a conversation, once', () => {
        const shelf = new DraftShelf();
        shelf.park('a', { text: 'half a thought', notes: ['Bees.md'], images: [], quote: null });
        expect(shelf.take('a')).toEqual({ text: 'half a thought', notes: ['Bees.md'], images: [], quote: null });
        expect(shelf.take('a')).toBe(EMPTY_DRAFT);
    });

    it('lets an empty draft go instead of keeping it', () => {
        const shelf = new DraftShelf();
        shelf.park('a', draft('something'));
        shelf.park('a', draft('   '));
        expect(shelf.size).toBe(0);
        expect(isDraftEmpty(draft(' \n'))).toBe(true);
        expect(isDraftEmpty({ ...draft(''), notes: ['x.md'] })).toBe(false);
    });

    it('keeps the 50 most recent drafts, dropping the oldest', () => {
        const shelf = new DraftShelf();
        for (let i = 0; i <= MAX_PARKED_DRAFTS; i += 1) shelf.park(`c${i}`, draft(`text ${i}`));
        expect(shelf.size).toBe(MAX_PARKED_DRAFTS);
        expect(shelf.take('c0')).toBe(EMPTY_DRAFT);
        expect(shelf.take(`c${MAX_PARKED_DRAFTS}`).text).toBe(`text ${MAX_PARKED_DRAFTS}`);
    });

    it('files a new chat (no question yet) under the empty key, and a begun one under its id', () => {
        expect(draftKey({ id: 'x', runs: [] })).toBe('');
        expect(draftKey({ id: 'x', runs: [{}] })).toBe('x');
    });

    it('copies what it keeps, so later changes to the message box do not reach it', () => {
        const shelf = new DraftShelf();
        const notes = ['a.md'];
        shelf.park('a', { text: 't', notes, images: [], quote: null });
        notes.push('b.md');
        expect(shelf.take('a').notes).toEqual(['a.md']);
    });
});
