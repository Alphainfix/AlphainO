/**
 * The comments' tick rail: one short mark per thread at the right edge of the
 * comments list, in the order of the passages they are on, standing in for the
 * list's scroll bar. It is the chat's question rail (AlphainZ's
 * ConversationRail) for comments, drawn with the same classes, so the two
 * sidebars read alike.
 *
 * Pointing anywhere on the rail previews the thread whose mark is nearest (the
 * marks' hit areas tile the rail, and the one card moves with the pointer);
 * keyboard focus on a mark shows its card, the arrow keys move between marks.
 * A click or Enter brings the thread up in the list and shows its passage in
 * the note. The long accent mark is the focused thread, or else the thread at
 * the top of the list, and it follows the scroll.
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { clipText, nearestCentreIndex } from '@beaver/agent-ui/conversation/turns';
import { t, tn } from '../i18n';

/** What the rail shows of one thread. */
export interface RailThread {
    id: string;
    /** Who wrote the first comment. */
    author: string;
    /** The first comment. */
    text: string;
    /** The passage it is on, as it reads now. */
    quote: string;
    replies: number;
    resolved: boolean;
}

/** Space kept between the preview card and the edges of the comments area. */
const CARD_MARGIN = 8;
/** In an area shorter than this the card shows two lines of comment and of passage. */
const COMPACT_AREA_PX = 260;

function isKeyboardFocus(element: Element): boolean {
    try {
        return element.matches(':focus-visible');
    } catch {
        return true;
    }
}

/** The thread at the top of the list: the first card whose bottom is below the list's top edge. */
function topThreadIndex(list: HTMLElement, ids: readonly string[]): number {
    const top = list.getBoundingClientRect().top + 8;
    for (let index = 0; index < ids.length; index += 1) {
        const card = list.querySelector<HTMLElement>(`[data-thread="${ids[index]}"]`);
        if (card && card.getBoundingClientRect().bottom > top) return index;
    }
    return ids.length - 1;
}

export function CommentRail({ listRef, threads, focusedId, onJump }: {
    /** The comments list, the scroll container the marks stand for; each card carries `data-thread`. */
    listRef: React.RefObject<HTMLDivElement>;
    /** The threads the list shows, in its order. */
    threads: readonly RailThread[];
    focusedId: string | null;
    onJump: (id: string) => void;
}) {
    const count = threads.length;
    const cardId = useId();
    const marksRef = useRef<HTMLDivElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);

    // The mark nearest the pointer while the pointer is on the rail.
    const [hovered, setHovered] = useState<number | null>(null);
    const hoveredRef = useRef<number | null>(null);
    // The mark with keyboard focus.
    const [focusedMark, setFocusedMark] = useState<number | null>(null);
    // The mark the card last showed, so the card keeps its text while it fades out.
    const [lastShown, setLastShown] = useState<number | null>(null);
    // A mark whose card was put away (clicked, or Escape) until another mark is chosen.
    const [dismissed, setDismissed] = useState<number | null>(null);
    // The thread at the top of the list, followed as the list scrolls.
    const [topIndex, setTopIndex] = useState(0);
    const key = threads.map((thread) => thread.id).join('\n');

    useLayoutEffect(() => {
        const list = listRef.current;
        const win = list?.ownerDocument.defaultView;
        if (!list || !win) return;
        const ids = key ? key.split('\n') : [];
        let frame: number | null = null;
        const measure = () => {
            frame = null;
            // Hidden (a collapsed sidebar): keep the last answer.
            if (list.clientHeight === 0) return;
            const next = topThreadIndex(list, ids);
            setTopIndex((previous) => (previous === next ? previous : next));
        };
        const schedule = () => {
            if (frame === null) frame = win.requestAnimationFrame(measure);
        };
        measure();
        list.addEventListener('scroll', schedule, { passive: true });
        const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null;
        observer?.observe(list);
        return () => {
            list.removeEventListener('scroll', schedule);
            observer?.disconnect();
            if (frame !== null) win.cancelAnimationFrame(frame);
        };
    }, [listRef, key]);

    const focusedIndex = focusedId ? threads.findIndex((thread) => thread.id === focusedId) : -1;
    const current = focusedIndex >= 0 ? focusedIndex : Math.min(topIndex, count - 1);
    const inRange = (index: number | null) => (index !== null && index < count ? index : null);
    const active = inRange(hovered) ?? inRange(focusedMark);
    const visible = active !== null && active !== dismissed;
    const cardIndex = active ?? inRange(lastShown);
    const cardThread = cardIndex !== null ? threads[cardIndex] : undefined;
    const tabStop = inRange(focusedMark) ?? (current >= 0 ? current : 0);

    const jump = (index: number) => {
        const thread = threads[index];
        if (thread) onJump(thread.id);
        // Out of the way of the thread it just brought up.
        setDismissed(index);
    };

    // Set while the arrow keys move focus between marks: keyboard focus, whatever
    // the browser's focus-visible heuristic makes of a focus moved by script.
    const arrowingRef = useRef(false);
    const focusMark = (index: number) => {
        arrowingRef.current = true;
        try {
            (marksRef.current?.children[index] as HTMLElement | undefined)?.focus();
        } finally {
            arrowingRef.current = false;
        }
    };

    // Pointer and wheel, on the rail as a whole.
    useEffect(() => {
        const marks = marksRef.current;
        const win = marks?.ownerDocument.defaultView;
        if (!marks || !win) return;
        // Mark centres, read once per visit to the rail and again after a resize.
        let centres: number[] | null = null;
        const readCentres = () => Array.from(marks.children, (mark) => {
            const rect = mark.getBoundingClientRect();
            return rect.top + rect.height / 2;
        });
        const track = (event: PointerEvent) => {
            centres ??= readCentres();
            const index = nearestCentreIndex(centres, event.clientY);
            if (index < 0 || index === hoveredRef.current) return;
            hoveredRef.current = index;
            setHovered(index);
            setLastShown(index);
            setDismissed(null);
        };
        const enter = (event: PointerEvent) => {
            centres = null;
            track(event);
        };
        const leave = () => {
            centres = null;
            hoveredRef.current = null;
            setHovered(null);
            setDismissed(null);
        };
        // The wheel over the rail scrolls the list, not whatever surrounds the sidebar.
        const wheel = (event: WheelEvent) => {
            const list = listRef.current;
            if (!list) return;
            list.scrollTop += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
            event.preventDefault();
        };
        const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => { centres = null; }) : null;
        observer?.observe(marks);
        marks.addEventListener('pointerenter', enter);
        marks.addEventListener('pointermove', track);
        marks.addEventListener('pointerleave', leave);
        marks.addEventListener('pointercancel', leave);
        marks.addEventListener('wheel', wheel, { passive: false });
        return () => {
            marks.removeEventListener('pointerenter', enter);
            marks.removeEventListener('pointermove', track);
            marks.removeEventListener('pointerleave', leave);
            marks.removeEventListener('pointercancel', leave);
            marks.removeEventListener('wheel', wheel);
            observer?.disconnect();
        };
    }, [listRef, count]);

    // Place the card level with its mark, inside the comments area.
    const wasVisibleRef = useRef(false);
    useLayoutEffect(() => {
        const card = cardRef.current;
        const area = card?.parentElement;
        const mark = cardIndex !== null ? marksRef.current?.children[cardIndex] : undefined;
        if (!card || !area || !mark || !visible) {
            wasVisibleRef.current = visible;
            return;
        }
        const areaRect = area.getBoundingClientRect();
        card.dataset.compact = areaRect.height < COMPACT_AREA_PX ? 'true' : 'false';
        const markRect = mark.getBoundingClientRect();
        const height = card.offsetHeight;
        const centre = markRect.top + markRect.height / 2 - areaRect.top;
        const top = Math.max(CARD_MARGIN, Math.min(centre - height / 2, areaRect.height - height - CARD_MARGIN));
        if (wasVisibleRef.current) {
            card.style.setProperty('--conversation-peek-y', `${top}px`);
        } else {
            // Appearing: fade in where it belongs. Sliding is for moving between marks.
            card.style.transitionProperty = 'opacity';
            card.style.setProperty('--conversation-peek-y', `${top}px`);
            void card.offsetHeight;
            card.style.transitionProperty = '';
        }
        wasVisibleRef.current = true;
    }, [cardIndex, visible, cardThread]);

    if (count === 0) return null;

    return (
        <>
            <nav className="conversation-rail alphaino-comment-rail" aria-label={t('Comments on this note')}>
                <div ref={marksRef} className="conversation-rail-marks">
                    {threads.map((thread, index) => (
                        <button
                            key={thread.id}
                            type="button"
                            className={`conversation-rail-mark${index === current ? ' is-current' : ''}${index === active ? ' is-active' : ''}${thread.resolved ? ' is-resolved' : ''}`}
                            aria-label={t('Comment {number}: {text}', { number: index + 1, text: clipText(thread.text, 120) })}
                            aria-current={index === current ? 'location' : undefined}
                            aria-describedby={visible && index === active ? cardId : undefined}
                            tabIndex={index === tabStop ? 0 : -1}
                            onClick={(event) => {
                                // A click brings up the thread the card shows, the one nearest the pointer;
                                // Enter or Space on a focused mark is a click with no pointer.
                                jump(event.detail === 0 ? index : (hoveredRef.current ?? index));
                            }}
                            onFocus={(event) => {
                                if (!arrowingRef.current && !isKeyboardFocus(event.currentTarget)) {
                                    setFocusedMark(null);
                                    return;
                                }
                                setFocusedMark(index);
                                setLastShown(index);
                                setDismissed(null);
                            }}
                            onBlur={(event) => {
                                const next = event.relatedTarget as Node | null;
                                if (next && marksRef.current?.contains(next)) return;
                                setFocusedMark(null);
                            }}
                            onKeyDown={(event) => {
                                switch (event.key) {
                                    case 'ArrowUp':
                                        event.preventDefault();
                                        focusMark(Math.max(0, index - 1));
                                        break;
                                    case 'ArrowDown':
                                        event.preventDefault();
                                        focusMark(Math.min(count - 1, index + 1));
                                        break;
                                    case 'Home':
                                        event.preventDefault();
                                        focusMark(0);
                                        break;
                                    case 'End':
                                        event.preventDefault();
                                        focusMark(count - 1);
                                        break;
                                    case 'Escape':
                                        if (visible) {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            setDismissed(active);
                                        }
                                        break;
                                }
                            }}
                        />
                    ))}
                </div>
            </nav>
            <div
                ref={cardRef}
                id={cardId}
                role="tooltip"
                className="conversation-peek"
                data-visible={visible ? 'true' : 'false'}
                aria-hidden={visible ? undefined : true}
            >
                {cardThread && cardIndex !== null ? (
                    <>
                        <div className="conversation-peek-meta">
                            <span className="conversation-peek-number">{t('Comment {number}', { number: cardIndex + 1 })}</span>
                            <span>· {cardThread.author}</span>
                            {cardThread.replies > 0 ? <span>· {tn(cardThread.replies, '{count} reply', '{count} replies', { count: cardThread.replies })}</span> : null}
                            {cardThread.resolved ? <span>· {t('Resolved')}</span> : null}
                        </div>
                        <div className="conversation-peek-question">{cardThread.text}</div>
                        {cardThread.quote ? <div className="conversation-peek-answer">{t('“{quote}”', { quote: clipText(cardThread.quote, 300) })}</div> : null}
                        <div className="conversation-peek-foot">{hovered === null ? t('Press Enter to jump') : t('Click to jump')}</div>
                    </>
                ) : null}
            </div>
        </>
    );
}
