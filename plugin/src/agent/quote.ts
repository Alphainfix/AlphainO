/**
 * What a question carries besides its text, the way an AlphainZ question
 * carries the paper open in the reader, the items attached and the passage
 * selected: the note open in the editor, notes the user attached, and a
 * passage selected in a note.
 *
 * They ride on the question's stored prompt (`alphaino_note`,
 * `alphaino_notes`, `alphaino_quote`), so the conversation file keeps what each
 * question was about. The model reads them as a preamble worded like
 * AlphainZ's (agent-llm `describePromptContext`): it names the notes, and the
 * model reads them with its tools; a selected passage is quoted in full.
 */
import type { AgentRun, BeaverAgentPrompt } from '@beaver/agent-core/agents/types';
import type { CommentAnchor } from '../comments/anchor';

export interface Quote {
    /** The selected text, as it was. */
    text: string;
    /** The note's path in the vault. */
    path: string;
    /** 1-based first and last line of the selection. */
    from: number;
    to: number;
    /** Where the passage is, in a form that survives edits to the note (Orbit's comment anchor). */
    anchor?: CommentAnchor;
    /** For a passage selected in a PDF: its page, counting from 1 (`from`/`to` are then 0). */
    page?: number;
}

/** An image the user pasted or dropped into the message box, kept as a file in the data folder. */
export interface AttachedImage {
    /** Vault path of the saved image. */
    path: string;
    mimeType: string;
    /** What to call it: the pasted file's name, or "Pasted image". */
    name: string;
}

/** What goes with a question. */
export interface QuestionContext {
    /** Images pasted or dropped into the message box. */
    images?: AttachedImage[];
    /** The note open in the editor. */
    note?: string | null;
    /** Notes the user attached. */
    notes?: string[];
    /** A passage selected in a note. */
    quote?: Quote | null;
}

export type PromptWithContext = BeaverAgentPrompt & {
    alphaino_quote?: Quote;
    alphaino_note?: string;
    alphaino_notes?: string[];
    alphaino_images?: AttachedImage[];
};

/** The longest passage carried into a question; the rest is said to be cut. */
const MAX_QUOTE_CHARS = 8_000;

export function quoteOf(prompt: BeaverAgentPrompt | undefined): Quote | null {
    const quote = (prompt as PromptWithContext | undefined)?.alphaino_quote;
    return quote && typeof quote.text === 'string' && quote.text ? quote : null;
}

/** The note that was open when the question was asked, if any. */
export function openNoteOf(prompt: BeaverAgentPrompt | undefined): string | null {
    const note = (prompt as PromptWithContext | undefined)?.alphaino_note;
    return typeof note === 'string' && note ? note : null;
}

/** The notes attached to a question. */
export function attachedNotesOf(prompt: BeaverAgentPrompt | undefined): string[] {
    const notes = (prompt as PromptWithContext | undefined)?.alphaino_notes;
    return Array.isArray(notes) ? notes.filter((path): path is string => typeof path === 'string' && path !== '') : [];
}

/** The images attached to a question. */
export function imagesOf(prompt: BeaverAgentPrompt | undefined): AttachedImage[] {
    const images = (prompt as PromptWithContext | undefined)?.alphaino_images;
    return Array.isArray(images) ? images.filter((image) => image && typeof image.path === 'string' && image.path !== '') : [];
}

/** The stored prompt for a question and what it carries. */
export function promptWithContext(question: string, context: QuestionContext): PromptWithContext {
    const prompt: PromptWithContext = { content: question };
    if (context.note) prompt.alphaino_note = context.note;
    if (context.notes && context.notes.length > 0) prompt.alphaino_notes = [...context.notes];
    if (context.quote) prompt.alphaino_quote = context.quote;
    if (context.images && context.images.length > 0) prompt.alphaino_images = context.images.map((image) => ({ ...image }));
    return prompt;
}

/** The note link for a path: `[[folder/Note]]`, no `.md`. */
export function noteLink(path: string): string {
    return `[[${path.replace(/\.md$/i, '')}]]`;
}

/** A note's title: its file name without the extension. */
export function noteTitle(path: string): string {
    return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
}

/** What the question carries, as the model reads it before the question. */
export function describeContext(prompt: BeaverAgentPrompt): string | null {
    const lines: string[] = [];
    const note = openNoteOf(prompt);
    const notes = attachedNotesOf(prompt).filter((path) => path !== note);
    const quote = quoteOf(prompt);
    if (note) lines.push(`Currently open in the editor: ${noteLink(note)}.`);
    if (notes.length > 0) {
        lines.push('Notes attached to this message:');
        for (const path of notes) lines.push(`- ${noteLink(path)}`);
    }
    const images = imagesOf(prompt);
    if (images.length > 0) {
        lines.push(images.length === 1 ? 'The user attached an image to this message.' : `The user attached ${images.length} images to this message.`);
    }
    if (quote) {
        const text = quote.text.length > MAX_QUOTE_CHARS ? `${quote.text.slice(0, MAX_QUOTE_CHARS)}…` : quote.text;
        const pdf = /\.pdf$/i.test(quote.path);
        const where = pdf
            ? (quote.page ? `page ${quote.page}` : 'the PDF')
            : quote.from <= 0
                ? ''
                : quote.from === quote.to
                    ? `line ${quote.from}`
                    : `lines ${quote.from}–${quote.to}`;
        const source = pdf ? `[[${quote.path}]]` : noteLink(quote.path);
        // A passage known only by its text (selected in an embedded note) is named without lines.
        lines.push(`The user has selected this passage in ${source}${where ? ` (${where})` : ''}, which is what "this" refers to:`);
        lines.push(`"""\n${text.trim()}\n"""`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
}

/** The question as the model reads it: what it carries, then what the user typed. */
export function questionForModel(prompt: BeaverAgentPrompt): string {
    const question = prompt.content ?? '';
    const context = describeContext(prompt);
    if (!context) return question;
    const asked = question.trim() || (quoteOf(prompt) ? 'Explain this passage.' : imagesOf(prompt).length > 0 ? 'What does this show?' : '');
    return asked ? `${context}\n\n${asked}` : context;
}

/** The prompt with what it carries folded into the text the model reads. */
export function promptForModel(prompt: BeaverAgentPrompt): BeaverAgentPrompt {
    return describeContext(prompt) ? { ...prompt, content: questionForModel(prompt) } : prompt;
}

/** Runs as the model replays them: each question with what it carried. */
export function runsForModel(runs: readonly AgentRun[]): AgentRun[] {
    return runs.map((run) => (describeContext(run.user_prompt) ? { ...run, user_prompt: promptForModel(run.user_prompt) } : run));
}
