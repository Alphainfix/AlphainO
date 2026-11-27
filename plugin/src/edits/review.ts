/**
 * Reviewing an edit in the note itself, as an IDE shows a suggested change:
 * the edit is already in the text (one transaction, so one undo takes all of
 * it back), each changed span is marked (new text green, removed text shown
 * struck through in red where it was), and each has Accept / Reject. Reject
 * puts the old text back for that span only; Accept just removes the marks.
 *
 * The spans follow the user's own typing (they are mapped through every
 * change). An undo that takes the edit back drops its marks.
 */
import { StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

export interface ReviewChunk {
    id: string;
    /** The edit it belongs to (one tool call). */
    editId: string;
    /** The new text's span in the document. */
    from: number;
    to: number;
    /** What is in that span now (kept current as the user types in it). */
    inserted: string;
    /** The old text it replaced, put back by Reject. */
    deleted: string;
}

export type ChunkOutcome = 'accepted' | 'rejected';

/** New chunks; their positions are in the document after the transaction they come with. */
export const addReview = StateEffect.define<ReviewChunk[]>();
/** Chunks the user decided, by id. */
export const settleChunks = StateEffect.define<{ ids: string[]; outcome: ChunkOutcome }>();

export const reviewField = StateField.define<ReviewChunk[]>({
    create: () => [],
    update(chunks, tr: Transaction) {
        let next = chunks;
        if (tr.docChanged && next.length > 0) {
            const undoing = tr.isUserEvent('undo') || tr.isUserEvent('redo');
            next = next.map((chunk) => {
                const from = tr.changes.mapPos(chunk.from, 1);
                const to = Math.max(from, tr.changes.mapPos(chunk.to, -1));
                return { ...chunk, from, to };
            });
            // An undo that takes the edit back leaves text that is no longer the edit's: its marks go.
            next = undoing
                ? next.filter((chunk) => tr.state.doc.sliceString(chunk.from, chunk.to) === chunk.inserted)
                : next.map((chunk) => ({ ...chunk, inserted: tr.state.doc.sliceString(chunk.from, chunk.to) }));
        }
        for (const effect of tr.effects) {
            if (effect.is(addReview)) next = [...next, ...effect.value];
            if (effect.is(settleChunks)) next = next.filter((chunk) => !effect.value.ids.includes(chunk.id));
        }
        return next.filter((chunk) => chunk.to > chunk.from || chunk.deleted !== '').sort((a, b) => a.from - b.from || a.to - b.to);
    },
    provide: (field) => EditorView.decorations.from(field, (chunks) => buildDecorations(chunks)),
});

class DeletedText extends WidgetType {
    constructor(private readonly text: string) {
        super();
    }
    eq(other: DeletedText) {
        return other.text === this.text;
    }
    toDOM() {
        const span = document.createElement('span');
        span.className = 'alphaino-edit-delete';
        span.textContent = this.text;
        return span;
    }
    ignoreEvent() {
        return true;
    }
}

class ChunkActions extends WidgetType {
    constructor(private readonly id: string) {
        super();
    }
    eq(other: ChunkActions) {
        return other.id === this.id;
    }
    toDOM(view: EditorView) {
        const wrap = document.createElement('span');
        wrap.className = 'alphaino-edit-actions';
        wrap.setAttribute('contenteditable', 'false');
        const button = (label: string, title: string, outcome: ChunkOutcome) => {
            const b = document.createElement('button');
            b.className = `alphaino-edit-${outcome === 'accepted' ? 'accept' : 'reject'}`;
            b.textContent = label;
            b.setAttribute('aria-label', title);
            b.addEventListener('mousedown', (event) => event.preventDefault());
            b.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                settleChunk(view, this.id, outcome);
            });
            return b;
        };
        wrap.append(button('✓', reviewLabels.accept, 'accepted'), button('✕', reviewLabels.reject, 'rejected'));
        return wrap;
    }
    ignoreEvent() {
        return true;
    }
}

/** The buttons' titles, in the interface language (set by the plugin). */
export const reviewLabels = { accept: 'Accept change', reject: 'Reject change' };

function buildDecorations(chunks: ReviewChunk[]): DecorationSet {
    const ranges = [];
    for (const chunk of chunks) {
        if (chunk.deleted) ranges.push(Decoration.widget({ widget: new DeletedText(chunk.deleted), side: -1 }).range(chunk.from));
        if (chunk.to > chunk.from) ranges.push(Decoration.mark({ class: 'alphaino-edit-insert', attributes: { 'data-alphaino-chunk': chunk.id } }).range(chunk.from, chunk.to));
        ranges.push(Decoration.widget({ widget: new ChunkActions(chunk.id), side: 1 }).range(chunk.to));
    }
    return Decoration.set(ranges, true);
}

/** Told about every decision, to keep the edit's record (`EditRegistry`). */
let onSettled: ((chunk: ReviewChunk, outcome: ChunkOutcome) => void) | null = null;
export function setSettledListener(listener: ((chunk: ReviewChunk, outcome: ChunkOutcome) => void) | null): void {
    onSettled = listener;
}

/** Accept or reject one chunk. Reject puts its old text back, as its own undo step. */
export function settleChunk(view: EditorView, id: string, outcome: ChunkOutcome): boolean {
    const chunk = view.state.field(reviewField, false)?.find((candidate) => candidate.id === id);
    if (!chunk) return false;
    view.dispatch({
        ...(outcome === 'rejected' ? { changes: { from: chunk.from, to: chunk.to, insert: chunk.deleted } } : {}),
        effects: settleChunks.of({ ids: [id], outcome }),
        userEvent: outcome === 'rejected' ? 'alphaino.reject' : 'alphaino.accept',
    });
    onSettled?.(chunk, outcome);
    return true;
}

/** Accept or reject every chunk (of one edit, or all). */
export function settleAll(view: EditorView, outcome: ChunkOutcome, editId?: string): number {
    const chunks = (view.state.field(reviewField, false) ?? []).filter((chunk) => !editId || chunk.editId === editId);
    if (chunks.length === 0) return 0;
    view.dispatch({
        ...(outcome === 'rejected' ? { changes: chunks.map((chunk) => ({ from: chunk.from, to: chunk.to, insert: chunk.deleted })) } : {}),
        effects: settleChunks.of({ ids: chunks.map((chunk) => chunk.id), outcome }),
        userEvent: outcome === 'rejected' ? 'alphaino.reject' : 'alphaino.accept',
    });
    for (const chunk of chunks) onSettled?.(chunk, outcome);
    return chunks.length;
}

/** The chunk at the cursor, else the next one after it. */
export function chunkAt(view: EditorView, position = view.state.selection.main.head): ReviewChunk | null {
    const chunks = view.state.field(reviewField, false) ?? [];
    return chunks.find((chunk) => position >= chunk.from && position <= chunk.to) ?? null;
}

/** Move the cursor to the next (or previous) chunk; returns whether there was one. */
export function jumpToChunk(view: EditorView, direction: 1 | -1): boolean {
    const chunks = view.state.field(reviewField, false) ?? [];
    if (chunks.length === 0) return false;
    const head = view.state.selection.main.head;
    const target =
        direction === 1
            ? chunks.find((chunk) => chunk.from > head) ?? chunks[0]
            : [...chunks].reverse().find((chunk) => chunk.to < head) ?? chunks[chunks.length - 1];
    view.dispatch({ selection: { anchor: target.from, head: target.to }, scrollIntoView: true });
    return true;
}

export function reviewExtension(): Extension {
    return reviewField;
}
