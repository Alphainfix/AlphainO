/**
 * The comments of the open note, in the right sidebar beside the chat: one
 * card per thread, in the order of the passages they are on, with the
 * passage, the comments and replies, and Reply / Resolve / Delete / Ask
 * AlphainO. A new comment on a selection starts as a draft card at the top.
 * The wording of lost passages and the Unresolved / All switch follow Orbit
 * Comments.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ItemView, MarkdownView, Menu, Notice, TFile, type WorkspaceLeaf } from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import { withoutTitleTooltips } from '../view/noTitles';
import type AlphainOPlugin from '../main';
import { t } from '../i18n';
import { timeAgo } from '../view/time';
import { Icon } from '../view/Icon';
import { Markdown } from '../view/Markdown';
import { noteTitle } from '../agent/quote';
import { resolveAnchor, type AnchorResolution, type CommentAnchor } from './anchor';
import type { CommentActor, CommentRecord, CommentThread } from './journal';
import { CommentRail, type RailThread } from './CommentRail';

export const VIEW_TYPE_COMMENTS = 'alphaino-comments';

/** A comment about to be written: the passage (or whole note) it will be on. */
export interface CommentDraft {
    anchor: CommentAnchor;
}

export class CommentsView extends ItemView {
    private root: Root | null = null;

    constructor(leaf: WorkspaceLeaf, private readonly plugin: AlphainOPlugin) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_COMMENTS;
    }

    getDisplayText(): string {
        return t('Comments');
    }

    getIcon(): string {
        return 'message-square-text';
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('alphaino-view');
        this.contentEl.addClass('alphainz-root');
        this.contentEl.addClass('alphaino-comments-view');
        this.stopTitles?.();
        this.stopTitles = withoutTitleTooltips(this.contentEl);
        this.root = createRoot(this.contentEl);
        this.root.render(<CommentsPanel plugin={this.plugin} />);
    }

    async onClose(): Promise<void> {
        this.root?.unmount();
        this.root = null;
        this.stopTitles?.();
        this.stopTitles = null;
    }

    private stopTitles: (() => void) | null = null;
}

export function authorName(actor: string): string {
    if (actor === 'user') return t('You');
    if (actor === 'alphaino') return 'AlphainO';
    if (actor === 'claude') return 'Claude';
    return actor;
}

/** The note's text as the user sees it: the open editor's, else the saved file. */
async function noteText(plugin: AlphainOPlugin, path: string): Promise<string | null> {
    for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file?.path === path) return view.editor.getValue();
    }
    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    try {
        return await plugin.app.vault.cachedRead(file);
    } catch {
        return null;
    }
}

interface Placed {
    thread: CommentThread;
    place: AnchorResolution | null;
    /** For ordering: the line the passage is on, -1 for the whole note, Infinity when lost. */
    order: number;
}

function placeThreads(threads: CommentThread[], text: string | null): Placed[] {
    return threads
        .map((thread) => {
            const anchor = thread.root.anchor as CommentAnchor;
            if (anchor.kind === 'document') return { thread, place: null, order: -1 };
            const place = text === null ? ({ status: 'detached' } as AnchorResolution) : resolveAnchor(anchor, text);
            return { thread, place, order: place.status === 'attached' ? place.line : Number.POSITIVE_INFINITY };
        })
        .sort((a, b) => a.order - b.order || a.thread.root.createdAt.localeCompare(b.thread.root.createdAt));
}

/** Orbit's words for a passage that cannot be shown where it was. */
function lostMessage(place: AnchorResolution | null): string | null {
    if (!place) return null;
    if (place.status !== 'attached') {
        return place.status === 'ambiguous' ? t('This passage appears more than once in the note.') : t('The commented text was changed or removed.');
    }
    return place.deleted ? t('The commented text was deleted.') : null;
}

function CommentsPanel({ plugin }: { plugin: AlphainOPlugin }) {
    const [note, setNote] = useState<string | null>(() => plugin.editorContext.current.note);
    const [threads, setThreads] = useState<CommentThread[]>(() => (note ? plugin.comments.threadsOn(note) : []));
    const [text, setText] = useState<string | null>(null);
    const [showAll, setShowAll] = useState(false);
    const [draft, setDraft] = useState<CommentDraft | null>(() => plugin.takeCommentDraft());
    const [focused, setFocused] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    // Ticks instead of a scroll bar, as in the chat (the same setting).
    const [railOn, setRailOn] = useState(() => plugin.prefs.get('conversationRail') !== false);
    useEffect(() => plugin.onSettingsChange(() => setRailOn(plugin.prefs.get('conversationRail') !== false)), [plugin]);

    useEffect(() => plugin.editorContext.subscribe((snapshot) => setNote(snapshot.note)), [plugin]);
    useEffect(() => {
        const update = () => setThreads(note ? plugin.comments.threadsOn(note) : []);
        update();
        void plugin.comments.load();
        return plugin.comments.subscribe(update);
    }, [plugin, note]);

    // The note's text, read again when it changes, to place each thread on its passage.
    useEffect(() => {
        let alive = true;
        let timer: number | null = null;
        const read = () => {
            if (!note) return setText(null);
            void noteText(plugin, note).then((value) => alive && setText(value));
        };
        read();
        const ref = plugin.app.workspace.on('editor-change', () => {
            if (timer !== null) window.clearTimeout(timer);
            timer = window.setTimeout(read, 500);
        });
        const modified = plugin.app.vault.on('modify', (file) => {
            if (file.path === note) read();
        });
        return () => {
            alive = false;
            if (timer !== null) window.clearTimeout(timer);
            plugin.app.workspace.offref(ref);
            plugin.app.vault.offref(modified);
        };
    }, [plugin, note, threads]);

    useEffect(
        () =>
            plugin.onCommentRequest((request) => {
                if (request.kind === 'draft') {
                    setDraft(plugin.takeCommentDraft());
                    setFocused(null);
                } else {
                    setShowAll((all) => all || Boolean(plugin.comments.thread(request.threadId)?.root.resolved));
                    setFocused(request.threadId);
                }
            }),
        [plugin],
    );

    // Bring a focused thread into view (a mark on the rail has already brought its thread to the top).
    const jumpedRef = useRef<string | null>(null);
    useEffect(() => {
        if (!focused) return;
        if (jumpedRef.current === focused) {
            jumpedRef.current = null;
        } else {
            const card = listRef.current?.querySelector<HTMLElement>(`[data-thread="${focused}"]`);
            card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        plugin.focusThreadInEditors(focused);
    }, [focused, plugin, threads]);

    const placed = useMemo(() => placeThreads(threads, text), [threads, text]);
    const shown = placed.filter((item) => showAll || !item.thread.root.resolved || item.thread.root.id === focused);
    const unresolved = placed.filter((item) => !item.thread.root.resolved).length;
    const railThreads = useMemo<RailThread[]>(
        () =>
            shown.map(({ thread, place }) => ({
                id: thread.root.id,
                author: authorName(thread.root.owner),
                text: thread.root.deleted ? t('This comment was deleted.') : thread.root.text,
                quote: place && place.status === 'attached' && !place.deleted ? place.quote : (thread.root.anchor as CommentAnchor).quote,
                replies: thread.replies.filter((reply) => !reply.deleted).length,
                resolved: thread.root.resolved,
            })),
        [shown],
    );
    // A mark brings its thread to the top of the list and shows its passage in the note.
    const jumpTo = useCallback(
        (id: string) => {
            const card = listRef.current?.querySelector<HTMLElement>(`[data-thread="${id}"]`);
            card?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            if (id === focused) {
                plugin.focusThreadInEditors(id);
                return;
            }
            jumpedRef.current = id;
            setFocused(id);
        },
        [focused, plugin],
    );

    if (!note) {
        return (
            <div className="alphaino-comments">
                <div className="alphaino-comments-empty">{t('Open a note to see its comments.')}</div>
            </div>
        );
    }

    return (
        <div className="alphaino-comments">
            <div className="alphaino-comments-header">
                <div className="alphaino-comments-title">
                    {t('Comments')}
                    {unresolved > 0 ? <span className="alphaino-comments-count">{unresolved}</span> : null}
                </div>
                <div className="alphaino-segmented" role="group" aria-label={t('Show')}>
                    <button type="button" className={!showAll ? 'is-active' : ''} aria-pressed={!showAll} onClick={() => setShowAll(false)}>
                        {t('Unresolved')}
                    </button>
                    <button type="button" className={showAll ? 'is-active' : ''} aria-pressed={showAll} onClick={() => setShowAll(true)}>
                        {t('All')}
                    </button>
                </div>
                <button
                    type="button"
                    className="clickable-icon"
                    aria-label={t('Comment on the selection or the whole note')}
                    onClick={() => plugin.startComment()}
                >
                    <Icon name="message-square-plus" />
                </button>
            </div>
            <div className="alphaino-comments-note">{noteTitle(note)}</div>
            <div className={`alphaino-comments-body${railOn && railThreads.length > 0 ? ' has-rail' : ''}`}>
            <div className="alphaino-comments-list" ref={listRef}>
                {draft && draft.anchor.path === note ? (
                    <DraftCard plugin={plugin} draft={draft} onDone={() => setDraft(null)} />
                ) : null}
                {shown.length === 0 && !draft ? (
                    <div className="alphaino-comments-empty">
                        {placed.length === 0 ? t('No comments on this note yet. Select text and choose “Comment”.') : t('Every comment here is resolved.')}
                    </div>
                ) : null}
                {shown.map((item) => (
                    <ThreadCard
                        key={item.thread.root.id}
                        plugin={plugin}
                        thread={item.thread}
                        place={item.place}
                        focused={item.thread.root.id === focused}
                        onFocus={() => setFocused(item.thread.root.id)}
                    />
                ))}
            </div>
            {railOn ? <CommentRail listRef={listRef} threads={railThreads} focusedId={focused} onJump={jumpTo} /> : null}
            </div>
        </div>
    );
}

function Composer(props: { placeholder: string; submitLabel: string; onSubmit: (text: string) => Promise<void>; onCancel: () => void; autoFocus?: boolean }) {
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const ref = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        if (props.autoFocus) ref.current?.focus();
    }, [props.autoFocus]);
    const submit = useCallback(async () => {
        if (!value.trim() || busy) return;
        setBusy(true);
        try {
            await props.onSubmit(value);
            setValue('');
        } catch (error) {
            new Notice(String((error as Error)?.message ?? error));
        } finally {
            setBusy(false);
        }
    }, [busy, props, value]);
    return (
        <div className="alphaino-comment-composer">
            <textarea
                ref={ref}
                rows={2}
                value={value}
                placeholder={props.placeholder}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void submit();
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        props.onCancel();
                    }
                }}
            />
            <div className="alphaino-comment-composer-bar">
                <button type="button" onClick={props.onCancel}>
                    {t('Cancel')}
                </button>
                <button type="button" className="mod-cta" disabled={!value.trim() || busy} onClick={() => void submit()}>
                    {props.submitLabel}
                </button>
            </div>
        </div>
    );
}

function Passage({ plugin, anchor, place }: { plugin: AlphainOPlugin; anchor: CommentAnchor; place: AnchorResolution | null }) {
    if (anchor.kind === 'document') return <div className="alphaino-comment-whole">{t('Whole note')}</div>;
    const current = place && place.status === 'attached' && !place.deleted ? place.quote : anchor.quote;
    const lost = lostMessage(place);
    return (
        <>
            <button type="button" className="alphaino-comment-passage" onClick={() => void plugin.revealAnchor(anchor)} aria-label={t('Reveal in note')}>
                {current.length > 400 ? `${current.slice(0, 400)}…` : current}
            </button>
            {lost ? <div className="alphaino-comment-lost">{lost}</div> : null}
        </>
    );
}

function CommentBody({ plugin, record, path, onDelete, deleteLabel }: { plugin: AlphainOPlugin; record: CommentRecord; path: string; onDelete?: () => void; deleteLabel?: string }) {
    return (
        <div className="alphaino-comment">
            <div className="alphaino-comment-meta">
                <span className={`alphaino-comment-author is-${record.owner}`}>{authorName(record.owner)}</span>
                <span className="alphaino-comment-time">
                    {timeAgo(record.createdAt)}
                </span>
                {onDelete && !record.deleted ? (
                    <button
                        type="button"
                        className="clickable-icon alphaino-comment-delete"
                        aria-label={deleteLabel ?? t('Delete')}
                        onClick={(event) => {
                            // Not a click on the card, which would focus the thread.
                            event.stopPropagation();
                            onDelete();
                        }}
                    >
                        <Icon name="trash-2" />
                    </button>
                ) : null}
            </div>
            {record.deleted ? (
                <div className="alphaino-comment-deleted">{t('This comment was deleted.')}</div>
            ) : (
                <div className="alphaino-comment-text">
                    <Markdown app={plugin.app} text={record.text} sourcePath={path} />
                </div>
            )}
        </div>
    );
}

function ThreadCard(props: { plugin: AlphainOPlugin; thread: CommentThread; place: AnchorResolution | null; focused: boolean; onFocus: () => void }) {
    const { plugin, thread, place, focused, onFocus } = props;
    const [replying, setReplying] = useState(false);
    const anchor = thread.root.anchor as CommentAnchor;
    const actor: CommentActor = 'user';
    const resolved = thread.root.resolved;

    // Deleting marks comments deleted in the journal; the notice's Undo marks them not deleted again.
    const remove = async (ids: string[], message: string) => {
        if (ids.length === 0) return;
        try {
            for (const id of ids) await plugin.comments.setDeleted({ actor, id, deleted: true });
        } catch (error) {
            new Notice(String((error as Error)?.message ?? error));
            return;
        }
        const doc = typeof activeDocument !== 'undefined' ? activeDocument : document;
        const fragment = doc.createDocumentFragment();
        fragment.append(`${message} `);
        const undo = doc.createElement('a');
        undo.href = '#';
        undo.className = 'alphaino-notice-undo';
        undo.textContent = t('Undo');
        fragment.append(undo);
        const notice = new Notice(fragment, 8000);
        undo.addEventListener('click', (event) => {
            event.preventDefault();
            notice.hide?.();
            void (async () => {
                try {
                    for (const id of [...ids].reverse()) await plugin.comments.setDeleted({ actor, id, deleted: false });
                } catch (error) {
                    new Notice(String((error as Error)?.message ?? error));
                }
            })();
        });
    };
    // The first comment stands for its thread: deleting it deletes the replies too, as in a shared document.
    const liveReplies = thread.replies.filter((reply) => !reply.deleted);
    const deleteThread = () =>
        void remove(
            [...liveReplies.map((reply) => reply.id), ...(thread.root.deleted ? [] : [thread.root.id])],
            liveReplies.length > 0 ? t('Comment and its replies deleted.') : t('Comment deleted.'),
        );
    const deleteReply = (reply: CommentRecord) => void remove([reply.id], t('Reply deleted.'));

    const menu = (event: React.MouseEvent) => {
        const items = new Menu();
        items.addItem((item) =>
            item.setTitle(t('Ask AlphainO about this')).setIcon('alphaino-panda').onClick(() => void plugin.askAboutThread(thread.root.id)),
        );
        items.addItem((item) => item.setTitle(t('Reveal in note')).setIcon('file-search').onClick(() => void plugin.revealAnchor(anchor)));
        items.addSeparator();
        items.addItem((item) =>
            item
                .setTitle(t('Delete'))
                .setIcon('trash-2')
                .setWarning(true)
                .onClick(deleteThread),
        );
        items.showAtMouseEvent(event.nativeEvent);
    };

    return (
        <div
            className={`alphaino-thread${focused ? ' is-focused' : ''}${resolved ? ' is-resolved' : ''}`}
            data-thread={thread.root.id}
            onClick={onFocus}
            onMouseEnter={() => plugin.focusThreadInEditors(thread.root.id)}
            onMouseLeave={() => plugin.focusThreadInEditors(focused ? thread.root.id : null)}
        >
            <Passage plugin={plugin} anchor={anchor} place={place} />
            <CommentBody
                plugin={plugin}
                record={thread.root}
                path={anchor.path}
                onDelete={deleteThread}
                deleteLabel={liveReplies.length > 0 ? t('Delete this comment and its replies') : t('Delete comment')}
            />
            {/* A deleted reply leaves no trace; a deleted first comment keeps its place while replies remain. */}
            {liveReplies.map((reply) => (
                <CommentBody key={reply.id} plugin={plugin} record={reply} path={anchor.path} onDelete={() => deleteReply(reply)} deleteLabel={t('Delete reply')} />
            ))}
            {replying ? (
                <Composer
                    placeholder={t('Reply…')}
                    submitLabel={t('Reply')}
                    autoFocus
                    onCancel={() => setReplying(false)}
                    onSubmit={async (value) => {
                        await plugin.comments.reply({ actor, threadId: thread.root.id, text: value });
                        setReplying(false);
                    }}
                />
            ) : (
                <div className="alphaino-thread-actions">
                    {!resolved ? (
                        <button type="button" className="alphaino-link-button" onClick={() => setReplying(true)}>
                            {t('Reply')}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="alphaino-link-button"
                        onClick={() => void plugin.comments.setResolved({ actor, threadId: thread.root.id, resolved: !resolved })}
                    >
                        {resolved ? t('Reopen') : t('Resolve')}
                    </button>
                    <div className="alphaino-spacer" />
                    <button type="button" className="clickable-icon" aria-label={t('More')} onClick={menu}>
                        <Icon name="more-horizontal" />
                    </button>
                </div>
            )}
        </div>
    );
}

function DraftCard({ plugin, draft, onDone }: { plugin: AlphainOPlugin; draft: CommentDraft; onDone: () => void }) {
    return (
        <div className="alphaino-thread is-draft is-focused">
            <Passage plugin={plugin} anchor={draft.anchor} place={null} />
            <Composer
                placeholder={t('Add a comment…')}
                submitLabel={t('Comment')}
                autoFocus
                onCancel={onDone}
                onSubmit={async (value) => {
                    const thread = await plugin.comments.addThread({ actor: 'user', anchor: draft.anchor, text: value });
                    onDone();
                    plugin.focusThreadInEditors(thread.root.id);
                }}
            />
        </div>
    );
}
