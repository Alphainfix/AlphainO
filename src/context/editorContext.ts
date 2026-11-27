/**
 * What the user has open: the note in view and the passage selected in it.
 * The chat shows both above the message box and sends them with the next
 * question, as AlphainZ does with the paper open in Zotero's reader and the
 * passage selected in it.
 *
 * The open note is the most recently active Markdown file (it stays the same
 * while the chat has focus). The selection is followed through a CodeMirror
 * listener in every Markdown editor: a non-empty selection is offered, and
 * collapsing it takes it away again. Clicking into the chat leaves the
 * editor's selection as it was, so it stays on offer.
 */
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { MarkdownView, editorInfoField, type App, type TFile } from 'obsidian';
import { LINE_END_ATTR, LINE_START_ATTR, findInSource, liveSectionInfo } from './readingSelection';

/** A passage selected in a note, with the editor state it was selected in. */
export interface EditorSelection {
    path: string;
    text: string;
    /** UTF-16 offsets in the note's text; -1 when a Reading view selection could not be placed in the source. */
    from: number;
    to: number;
    /** 1-based first and last line of the selection. */
    fromLine: number;
    toLine: number;
    /** The note's text the offsets count in ('' when they are unknown), for capturing an anchor later. */
    source: string;
    /** Where it was made. */
    mode: 'source' | 'reading' | 'pdf';
    /** In a PDF: the page it is on, counting from 1. */
    page?: number;
}

export interface EditorContextSnapshot {
    /** The note in view, by vault path, or null. */
    note: string | null;
    selection: EditorSelection | null;
}

/** Selections longer than this are offered cut: the model can read the rest with its tools. */
export const MAX_SELECTION_CHARS = 20_000;

const SETTLE_MS = 120;

export class EditorContext {
    private snapshot: EditorContextSnapshot = { note: null, selection: null };
    private readonly listeners = new Set<(snapshot: EditorContextSnapshot) => void>();
    private pending: { view: EditorView } | null = null;
    private timer: number | null = null;

    /**
     * `offered` says whether a note may go with a question: one in a folder the user left out of AlphainO is not
     * offered, as AlphainZ refuses a reader question from an excluded library.
     */
    constructor(
        private readonly app: App,
        private readonly offered: (path: string) => boolean = () => true,
    ) {}

    get current(): EditorContextSnapshot {
        return this.snapshot;
    }

    subscribe(listener: (snapshot: EditorContextSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** The CodeMirror extension that reports selections; registered once by the plugin. */
    extension() {
        return EditorView.updateListener.of((update: ViewUpdate) => {
            if (!update.selectionSet && !update.docChanged) return;
            this.pending = { view: update.view };
            // A drag-selection sends an update per pixel; the chip needs the one it ends on.
            if (this.timer === null) {
                this.timer = window.setTimeout(() => {
                    this.timer = null;
                    const pending = this.pending;
                    this.pending = null;
                    if (pending) this.readSelection(pending.view);
                }, SETTLE_MS);
            }
        });
    }

    /** Re-read which note is in view (on a leaf or file change). */
    refreshNote(): void {
        const file = this.app.workspace.getActiveFile();
        const note = file && file.extension === 'md' ? file.path : null;
        if (note === this.snapshot.note) return;
        // A selection belongs to its note; another note in view drops it.
        const selection = this.snapshot.selection && this.snapshot.selection.path === note ? this.snapshot.selection : null;
        this.set({ note, selection });
    }

    /** Apply the `offered` rule again (the excluded folders changed): a note now left out is dropped. */
    recheck(): void {
        this.set(this.snapshot);
    }

    /** A note was renamed or moved. */
    renamed(file: TFile, oldPath: string): void {
        const note = this.snapshot.note === oldPath ? file.path : this.snapshot.note;
        const selection =
            this.snapshot.selection && this.snapshot.selection.path === oldPath ? { ...this.snapshot.selection, path: file.path } : this.snapshot.selection;
        if (note !== this.snapshot.note || selection !== this.snapshot.selection) this.set({ note, selection });
    }

    /** A note was deleted. */
    deleted(path: string): void {
        if (this.snapshot.note !== path && this.snapshot.selection?.path !== path) return;
        this.set({
            note: this.snapshot.note === path ? null : this.snapshot.note,
            selection: this.snapshot.selection?.path === path ? null : this.snapshot.selection,
        });
    }

    dispose(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
        if (this.readingTimer !== null) window.clearTimeout(this.readingTimer);
        this.timer = null;
        this.pending = null;
        this.listeners.clear();
    }

    private readSelection(view: EditorView): void {
        const file = view.state.field(editorInfoField, false)?.file;
        if (!file || file.extension !== 'md') return;
        const range = view.state.selection.main;
        if (range.empty) {
            // Collapsing the selection in the note it came from takes it away.
            if (this.snapshot.selection?.path === file.path) this.set({ ...this.snapshot, selection: null });
            return;
        }
        const doc = view.state.doc;
        const text = view.state.sliceDoc(range.from, range.to);
        if (!text.trim()) return;
        const first = doc.lineAt(range.from);
        const last = doc.lineAt(range.to);
        // A selection ending at the start of a line does not include that line.
        const toLine = range.to === last.from && last.number > first.number ? last.number - 1 : last.number;
        const previous = this.snapshot.selection;
        if (previous && previous.path === file.path && previous.from === range.from && previous.to === range.to && previous.text === text) return;
        this.set({
            note: this.snapshot.note ?? file.path,
            selection: { path: file.path, text, from: range.from, to: range.to, fromLine: first.number, toLine, source: view.state.doc.toString(), mode: 'source' },
        });
    }

    private readingTimer: number | null = null;

    /** The document's selection changed: read it if it is in a note's Reading view. */
    readingSelectionChanged(doc: Document): void {
        if (this.readingTimer !== null) window.clearTimeout(this.readingTimer);
        this.readingTimer = window.setTimeout(() => {
            this.readingTimer = null;
            this.readReadingSelection(doc);
        }, SETTLE_MS);
    }

    private readReadingSelection(doc: Document): void {
        const selection = doc.getSelection();
        const anchor = selection?.anchorNode;
        const element = anchor instanceof Element ? anchor : anchor?.parentElement;
        if (selection && element && this.readPdfSelection(selection, element)) return;
        const preview = element?.closest('.markdown-preview-view');
        if (!selection || !preview) return;
        const view = this.app.workspace
            .getLeavesOfType('markdown')
            .map((leaf) => leaf.view)
            .find((candidate): candidate is MarkdownView => candidate instanceof MarkdownView && candidate.containerEl.contains(preview));
        const file = view?.file;
        if (!view || !file) return;
        const text = selection.toString();
        if (selection.isCollapsed || !text.trim()) {
            if (this.snapshot.selection?.mode === 'reading' && this.snapshot.selection.path === file.path) this.set({ ...this.snapshot, selection: null });
            return;
        }
        const range = selection.getRangeAt(0);
        const elementOf = (node: Node) => (node instanceof Element ? node : node.parentElement);
        const clear = () => {
            if (this.snapshot.selection?.mode === 'reading' && this.snapshot.selection.path === file.path) this.set({ ...this.snapshot, selection: null });
        };
        // Text in an embedded note (![[…]]) is that note's, not this one's: offered as its passage, without lines.
        const embed = elementOf(range.startContainer)?.closest('.internal-embed, .markdown-embed') ?? elementOf(range.endContainer)?.closest('.internal-embed, .markdown-embed');
        if (embed) {
            const link = (embed.getAttribute('src') ?? embed.closest('[src]')?.getAttribute('src') ?? '').split('#')[0].trim();
            const target = link ? this.app.metadataCache.getFirstLinkpathDest(link, file.path) : null;
            if (!target || target.extension !== 'md') {
                clear();
                return;
            }
            const previousEmbed = this.snapshot.selection;
            if (previousEmbed && previousEmbed.mode === 'reading' && previousEmbed.path === target.path && previousEmbed.text === text) return;
            this.set({
                note: this.snapshot.note ?? file.path,
                selection: { path: target.path, text, from: -1, to: -1, fromLine: 0, toLine: 0, source: '', mode: 'reading' },
            });
            return;
        }
        const blockOf = (node: Node) => elementOf(node)?.closest(`[${LINE_START_ATTR}]`) ?? null;
        const first = blockOf(range.startContainer);
        const last = blockOf(range.endContainer);
        // Outside the note's own blocks (the title, the backlinks under it, the properties): not a passage of it.
        if (!first || !last) {
            clear();
            return;
        }
        // Where the blocks are now (asked of Obsidian), else where they were when drawn.
        const linesOf = (block: Element) => liveSectionInfo.get(block)?.() ?? null;
        const firstLine = linesOf(first)?.lineStart ?? Number(first.getAttribute(LINE_START_ATTR) ?? NaN);
        const lastLine = linesOf(last)?.lineEnd ?? Number(last.getAttribute(LINE_END_ATTR) ?? NaN);
        const source = view.editor.getValue();
        const lineCount = source.split('\n').length;
        // Found in its blocks; failing that (lines moved since), anywhere in the note.
        const found =
            (Number.isFinite(firstLine) && Number.isFinite(lastLine) ? findInSource(source, text, firstLine, lastLine) : null) ??
            findInSource(source, text, 0, lineCount - 1);
        const lineOf = (offset: number) => source.slice(0, offset).split('\n').length;
        const previous = this.snapshot.selection;
        if (previous && previous.mode === 'reading' && previous.path === file.path && previous.text === text) return;
        this.set({
            note: this.snapshot.note ?? file.path,
            selection: found
                ? { path: file.path, text: source.slice(found.from, found.to), from: found.from, to: found.to, fromLine: lineOf(found.from), toLine: lineOf(found.to), source, mode: 'reading' }
                : {
                      path: file.path,
                      text,
                      from: -1,
                      to: -1,
                      fromLine: Number.isFinite(firstLine) ? firstLine + 1 : 1,
                      toLine: Number.isFinite(lastLine) ? lastLine + 1 : 1,
                      source: '',
                      mode: 'reading',
                  },
        });
    }

    /**
     * A selection in Obsidian's own PDF viewer: its text and page only (the
     * text layer has no source to anchor in). Returns whether it was one.
     */
    private readPdfSelection(selection: Selection, element: Element): boolean {
        const viewer = element.closest('.pdf-viewer, .pdf-container, .pdfViewer');
        if (!viewer) return false;
        const leaf = this.app.workspace.getLeavesOfType('pdf').find((candidate) => candidate.view.containerEl.contains(viewer));
        const file = (leaf?.view as { file?: TFile | null } | undefined)?.file;
        if (!file) return false;
        const text = selection.toString();
        if (selection.isCollapsed || !text.trim()) {
            if (this.snapshot.selection?.mode === 'pdf' && this.snapshot.selection.path === file.path) this.set({ ...this.snapshot, selection: null });
            return true;
        }
        const pageEl = element.closest('[data-page-number]');
        const page = Number(pageEl?.getAttribute('data-page-number') ?? NaN);
        const previous = this.snapshot.selection;
        if (previous && previous.mode === 'pdf' && previous.path === file.path && previous.text === text) return true;
        this.set({
            note: this.snapshot.note,
            selection: { path: file.path, text, from: -1, to: -1, fromLine: 0, toLine: 0, source: '', mode: 'pdf', ...(Number.isFinite(page) ? { page } : {}) },
        });
        return true;
    }

    private set(proposed: EditorContextSnapshot): void {
        const next: EditorContextSnapshot = {
            note: proposed.note && this.offered(proposed.note) ? proposed.note : null,
            selection: proposed.selection && this.offered(proposed.selection.path) ? proposed.selection : null,
        };
        if (next.note === this.snapshot.note && next.selection === this.snapshot.selection) return;
        this.snapshot = next;
        for (const listener of this.listeners) listener(next);
    }
}
