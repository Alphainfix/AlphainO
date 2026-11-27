/**
 * Commented passages underlined in the editor, as Orbit Comments marks them:
 * view-only decorations, never a change to the note. Each unresolved thread's
 * anchor is found in the editor's text; while the user types, the marks follow
 * the edits (mapped through each change) and are found again from the anchors
 * once typing pauses. A click on a mark opens its thread.
 */
import { RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { resolveAnchor } from './anchor';
import type { CommentThread } from './journal';

/** Sent to every editor when the comments change. */
export const refreshComments = StateEffect.define<null>();
/** Sent when a thread is focused (its marks are drawn stronger), or null. */
export const focusThread = StateEffect.define<string | null>();

export interface CommentMarksHost {
    /** The unresolved threads on a note. */
    threadsOn(path: string): CommentThread[];
    /** A mark was clicked. */
    openThread(threadId: string): void;
}

const SETTLE_MS = 400;

interface Mark {
    from: number;
    to: number;
    threadId: string;
}

function marksFor(view: EditorView, host: CommentMarksHost): Mark[] {
    const path = view.state.field(editorInfoField, false)?.file?.path;
    if (!path) return [];
    const text = view.state.doc.toString();
    const marks: Mark[] = [];
    for (const thread of host.threadsOn(path)) {
        const anchor = thread.root.anchor;
        if (!anchor || anchor.kind !== 'range' || thread.root.resolved) continue;
        const place = resolveAnchor(anchor, text);
        if (place.status === 'attached' && place.to > place.from && place.to <= text.length) marks.push({ from: place.from, to: place.to, threadId: thread.root.id });
    }
    return marks.sort((a, b) => a.from - b.from || a.to - b.to);
}

function build(marks: Mark[], focused: string | null): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    for (const mark of marks) {
        builder.add(
            mark.from,
            mark.to,
            Decoration.mark({
                class: `alphaino-comment-mark${mark.threadId === focused ? ' is-focused' : ''}`,
                attributes: { 'data-alphaino-thread': mark.threadId },
            }),
        );
    }
    return builder.finish();
}

export function commentMarks(host: CommentMarksHost): Extension {
    const plugin = ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;
            private marks: Mark[];
            private focused: string | null = null;
            private timer: number | null = null;

            constructor(private readonly view: EditorView) {
                this.marks = marksFor(view, host);
                this.decorations = build(this.marks, this.focused);
            }

            update(update: ViewUpdate) {
                let rebuild = false;
                for (const tr of update.transactions) {
                    for (const effect of tr.effects) {
                        if (effect.is(refreshComments)) rebuild = true;
                        if (effect.is(focusThread)) {
                            this.focused = effect.value;
                            this.decorations = build(this.marks, this.focused);
                        }
                    }
                }
                if (rebuild) {
                    this.refresh();
                    return;
                }
                if (update.docChanged) {
                    // Follow the edits now; find the passages again once typing pauses.
                    this.marks = this.marks
                        .map((mark) => ({ ...mark, from: update.changes.mapPos(mark.from, 1), to: update.changes.mapPos(mark.to, -1) }))
                        .filter((mark) => mark.to > mark.from);
                    this.decorations = this.decorations.map(update.changes);
                    this.schedule();
                }
            }

            private schedule() {
                if (this.timer !== null) window.clearTimeout(this.timer);
                this.timer = window.setTimeout(() => {
                    this.timer = null;
                    this.view.dispatch({ effects: refreshComments.of(null) });
                }, SETTLE_MS);
            }

            private refresh() {
                this.marks = marksFor(this.view, host);
                this.decorations = build(this.marks, this.focused);
            }

            destroy() {
                if (this.timer !== null) window.clearTimeout(this.timer);
            }
        },
        { decorations: (value) => value.decorations },
    );
    const clicks = EditorView.domEventHandlers({
        click(event) {
            const target = (event.target as HTMLElement | null)?.closest?.('[data-alphaino-thread]');
            const id = target?.getAttribute('data-alphaino-thread');
            if (!id) return false;
            host.openThread(id);
            return false;
        },
    });
    return [plugin, clicks];
}
