import { EditorState, type TransactionSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { diffChunks } from '../src/edits/diff';
import { addReview, reviewField, settleChunks, type ReviewChunk } from '../src/edits/review';
import { applyOperation } from '../src/edits/tool';

/** Apply the chunks to the old text: the result must be the new text. */
function replay(oldText: string, newText: string): string {
    let out = '';
    let at = 0;
    for (const chunk of diffChunks(oldText, newText)) {
        out += oldText.slice(at, chunk.fromA) + newText.slice(chunk.fromB, chunk.toB);
        at = chunk.toA;
    }
    return out + oldText.slice(at);
}

describe('edit diff', () => {
    it('finds one chunk per changed word, not per paragraph', () => {
        const oldText = 'Bees eat nectar and pollen in the summer.';
        const newText = 'Bees eat nectar and honey in the summer.';
        expect(diffChunks(oldText, newText)).toEqual([{ fromA: 20, toA: 26, fromB: 20, toB: 25 }]);
        expect(replay(oldText, newText)).toBe(newText);
    });

    it('compares Chinese character by character', () => {
        const oldText = '蜜蜂吃花蜜和花粉。';
        const newText = '蜜蜂吃花蜜和蜂蜜。';
        const chunks = diffChunks(oldText, newText);
        expect(chunks).toHaveLength(1);
        expect(oldText.slice(chunks[0].fromA, chunks[0].toA)).toBe('花粉');
        expect(newText.slice(chunks[0].fromB, chunks[0].toB)).toBe('蜂蜜');
    });

    it('keeps insertions, deletions and several changes apart, and always replays to the new text', () => {
        const cases: Array<[string, string]> = [
            ['a b c', 'a b c d'],
            ['first line\nsecond line\nthird line', 'first line\nthird line'],
            ['The quick brown fox jumps.', 'The slow brown fox leaps.'],
            ['', 'all new'],
            ['all gone', ''],
            ['# Title\n\nPara one.\n\nPara two.', '# Title\n\nPara one, longer.\n\nPara 2.\n\nPara three.'],
        ];
        for (const [a, b] of cases) expect(replay(a, b)).toBe(b);
        expect(diffChunks('The quick brown fox jumps.', 'The slow brown fox leaps.')).toHaveLength(2);
        expect(diffChunks('same', 'same')).toEqual([]);
    });
});

describe('edit operations (AlphainZ’s edit_note arguments)', () => {
    const note = 'Intro.\nBees eat nectar.\nOutro.';
    it('replaces one exact, unique passage', () => {
        expect(applyOperation(note, { old_string: 'nectar', new_string: 'pollen' })).toEqual({ text: 'Intro.\nBees eat pollen.\nOutro.' });
        expect(applyOperation(note, { old_string: 'wasps', new_string: 'x' })).toMatchObject({ error: expect.stringMatching(/not in the note/) });
        expect(applyOperation('a a', { old_string: 'a', new_string: 'b' })).toMatchObject({ error: expect.stringMatching(/2 times/) });
        expect(applyOperation('a a', { operation: 'str_replace_all', old_string: 'a', new_string: 'b' })).toEqual({ text: 'b b' });
    });
    it('inserts around a passage, appends, rewrites', () => {
        expect(applyOperation(note, { operation: 'insert_after', old_string: 'Intro.', new_string: '\nMore.' })).toEqual({ text: 'Intro.\nMore.\nBees eat nectar.\nOutro.' });
        expect(applyOperation(note, { operation: 'insert_before', old_string: 'Outro.', new_string: 'Then: ' })).toEqual({ text: 'Intro.\nBees eat nectar.\nThen: Outro.' });
        expect(applyOperation(note, { operation: 'append', new_string: 'P.S.' })).toEqual({ text: `${note}\nP.S.` });
        expect(applyOperation(note, { operation: 'rewrite', new_string: 'New.' })).toEqual({ text: 'New.' });
        expect(applyOperation(note, { operation: 'insert_after', new_string: 'x' })).toMatchObject({ error: expect.stringMatching(/needs old_string/) });
    });
});

describe('the review in the note', () => {
    /** An edit dispatched as edit_note dispatches it: the changes and their chunks in one transaction. */
    function edited(oldText: string, newText: string) {
        const state = EditorState.create({ doc: oldText, extensions: [reviewField] });
        const pieces = diffChunks(oldText, newText);
        const chunks: ReviewChunk[] = pieces.map((piece, i) => ({
            id: `c${i}`,
            editId: 'e1',
            from: piece.fromB,
            to: piece.toB,
            inserted: newText.slice(piece.fromB, piece.toB),
            deleted: oldText.slice(piece.fromA, piece.toA),
        }));
        const spec: TransactionSpec = {
            changes: pieces.map((piece) => ({ from: piece.fromA, to: piece.toA, insert: newText.slice(piece.fromB, piece.toB) })),
            effects: addReview.of(chunks),
            userEvent: 'alphaino.edit',
        };
        return state.update(spec).state;
    }

    it('puts the edit in the text in one step and marks each changed piece', () => {
        const state = edited('Bees eat nectar and pollen.', 'Bees eat honey and pollen.');
        expect(state.doc.toString()).toBe('Bees eat honey and pollen.');
        expect(state.field(reviewField)).toMatchObject([{ id: 'c0', inserted: 'honey', deleted: 'nectar', from: 9, to: 14 }]);
    });

    it('follows the user’s typing elsewhere in the note', () => {
        let state = edited('Bees eat nectar and pollen.', 'Bees eat honey and pollen.');
        state = state.update({ changes: { from: 0, insert: 'Note: ' }, userEvent: 'input.type' }).state;
        const [chunk] = state.field(reviewField);
        expect(state.doc.sliceString(chunk.from, chunk.to)).toBe('honey');
    });

    it('reject puts the old text back for that piece only; accept just clears the mark', () => {
        let state = edited('one two three', 'one 2 three 4');
        const chunks = state.field(reviewField);
        expect(chunks).toHaveLength(2);
        const first = chunks[0];
        state = state.update({ changes: { from: first.from, to: first.to, insert: first.deleted }, effects: settleChunks.of({ ids: [first.id], outcome: 'rejected' }) }).state;
        expect(state.doc.toString()).toBe('one two three 4');
        expect(state.field(reviewField)).toHaveLength(1);
        state = state.update({ effects: settleChunks.of({ ids: [chunks[1].id], outcome: 'accepted' }) }).state;
        expect(state.doc.toString()).toBe('one two three 4');
        expect(state.field(reviewField)).toHaveLength(0);
    });

    it('an undo that takes the edit back drops its marks', () => {
        let state = edited('Bees eat nectar.', 'Bees eat honey.');
        const [chunk] = state.field(reviewField);
        state = state.update({ changes: { from: chunk.from, to: chunk.to, insert: 'nectar' }, userEvent: 'undo' }).state;
        expect(state.doc.toString()).toBe('Bees eat nectar.');
        expect(state.field(reviewField)).toHaveLength(0);
    });
});
