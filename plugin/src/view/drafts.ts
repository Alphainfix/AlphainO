/**
 * Half-written messages, kept per conversation, as AlphainZ keeps them
 * (`parkedComposerDraftsAtom`): leaving a chat (opening another, starting a
 * new one, closing the view) parks what is in the message box — the text, the
 * attached notes and images, a passage handed over — and coming back brings it
 * back. Kept while Obsidian runs, not written to disk.
 */
import type { AttachedImage, Quote } from '../agent/quote';

export interface ChatDraft {
    text: string;
    notes: string[];
    images: AttachedImage[];
    /** A passage handed over to the message box ("Ask about the selection"); a live selection is not kept. */
    quote: Quote | null;
}

export const EMPTY_DRAFT: ChatDraft = Object.freeze({ text: '', notes: [], images: [], quote: null }) as ChatDraft;

/** How many conversations' drafts are kept; the oldest goes first (AlphainZ's MAX_PARKED_DRAFTS). */
export const MAX_PARKED_DRAFTS = 50;

export function isDraftEmpty(draft: ChatDraft): boolean {
    return !draft.text.trim() && draft.notes.length === 0 && draft.images.length === 0 && !draft.quote;
}

/** The key a conversation's draft is kept under: its id once it has a question, '' for a new chat. */
export function draftKey(conversation: { id: string; runs: readonly unknown[] }): string {
    return conversation.runs.length > 0 ? conversation.id : '';
}

export class DraftShelf {
    private readonly drafts = new Map<string, ChatDraft>();

    /** Keep `draft` for the conversation `key` (an empty one is let go). */
    park(key: string, draft: ChatDraft): void {
        this.drafts.delete(key);
        if (isDraftEmpty(draft)) return;
        this.drafts.set(key, { text: draft.text, notes: [...draft.notes], images: [...draft.images], quote: draft.quote });
        while (this.drafts.size > MAX_PARKED_DRAFTS) {
            const oldest = this.drafts.keys().next().value;
            if (oldest === undefined) break;
            this.drafts.delete(oldest);
        }
    }

    /** The draft kept for `key`, which leaves the shelf; the empty draft when there is none. */
    take(key: string): ChatDraft {
        const draft = this.drafts.get(key);
        this.drafts.delete(key);
        return draft ?? EMPTY_DRAFT;
    }

    get size(): number {
        return this.drafts.size;
    }
}
