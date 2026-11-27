import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({ getLanguage: () => 'en' }));

const { describeNoteIndex } = await import('../src/view/IndexStatusButton');

const base = { state: 'idle' as const, model: null, notesIndexed: 10, notesTotal: 10, chunks: 40, pending: 0, lastError: null, retryAt: null };

describe('the note index in the header', () => {
    it('is hidden while there is nothing to say', () => {
        expect(describeNoteIndex(null).visible).toBe(false);
        expect(describeNoteIndex(base).visible).toBe(false);
        expect(describeNoteIndex({ ...base, state: 'off' }).visible).toBe(false);
    });

    it('stays hidden while a note being edited is re-indexed', () => {
        expect(describeNoteIndex({ ...base, state: 'indexing', pending: 1 }).visible).toBe(false);
    });

    it('shows the percentage while many notes are being indexed', () => {
        const view = describeNoteIndex({ ...base, state: 'indexing', notesIndexed: 25, notesTotal: 200, pending: 175 });
        expect(view).toMatchObject({ visible: true, indexing: true, percent: 13, title: 'Indexing your notes' });
        expect(view.detail).toBe('13% · 25/200 notes');
    });

    it('shows an error, with its reason, until it is retried', () => {
        expect(describeNoteIndex({ ...base, state: 'error', lastError: 'The disk is full.' })).toMatchObject({ visible: true, indexing: false, title: 'Indexing Error', detail: 'The disk is full.' });
        expect(describeNoteIndex({ ...base, state: 'paused', lastError: 'Gemini is limiting requests.' }).visible).toBe(true);
    });
});
