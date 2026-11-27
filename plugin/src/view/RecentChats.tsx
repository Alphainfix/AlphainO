/**
 * The chats under the empty view, as AlphainZ's RecentChats: the three most
 * recent, or, while a note is open, the three latest about it ("Related to
 * this note", "Related to this file" for a PDF). "View All" opens the chat
 * history, filtered to that note when the list was. Same markup and classes,
 * so AlphainZ's sheet draws it.
 */
import React, { useEffect, useState } from 'react';
import Button from '@beaver/agent-ui/primitives/Button';
import type { ConversationSummary } from '../store/conversations';
import { t } from '../i18n';
import { compactTime } from './time';

const MAX_RECENT = 3;

export type RecentContext = 'recent' | 'note' | 'file';

/** What the list shows: chats about the open note when there are any, else the latest chats. Archived chats never. */
export function recentChats(all: readonly ConversationSummary[], note: string | null): { threads: ConversationSummary[]; context: RecentContext } {
    const live = all.filter((thread) => !thread.archivedAt);
    if (note) {
        const related = live.filter((thread) => thread.notes.includes(note));
        if (related.length > 0) return { threads: related.slice(0, MAX_RECENT), context: /\.pdf$/i.test(note) ? 'file' : 'note' };
    }
    return { threads: live.slice(0, MAX_RECENT), context: 'recent' };
}

export function RecentChats(props: {
    /** Lists the conversations (the store's `list`, most recent first). */
    list: () => Promise<ConversationSummary[]>;
    /** The note open in the editor, if any. */
    note: string | null;
    currentId: string;
    /** Bumped when the conversations may have changed (a chat archived or renamed in the history). */
    version: number;
    onOpen: (id: string) => void;
    /** Open the history; `note` when the list was about it. */
    onViewAll: (note: string | null) => void;
}) {
    const { list, note, currentId, version, onOpen, onViewAll } = props;
    const [shown, setShown] = useState<{ threads: ConversationSummary[]; context: RecentContext } | null>(null);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        let cancelled = false;
        list()
            .then((all) => {
                if (cancelled) return;
                setShown(recentChats(all, note));
                setNow(Date.now());
            })
            .catch(() => {
                if (!cancelled) setShown({ threads: [], context: 'recent' });
            });
        return () => {
            cancelled = true;
        };
    }, [list, note, version]);

    // Nothing until the first read, and nothing when there are no chats yet.
    if (!shown || shown.threads.length === 0) return null;

    const headerLabel = shown.context === 'file' ? t('Related to this file') : shown.context === 'note' ? t('Related to this note') : t('Recent');
    const open = (thread: ConversationSummary) => {
        if (thread.id !== currentId) onOpen(thread.id);
    };

    return (
        <div className="pt-2 recent-chats">
            <div className="recent-chats-header">
                <span className="recent-chats-label">{headerLabel}</span>
                <Button variant="ghost-secondary" onClick={() => onViewAll(shown.context === 'recent' ? null : note)} style={{ padding: '0px' }}>
                    {t('View All')}
                </Button>
            </div>
            {shown.threads.map((thread) => {
                const name = thread.name || t('Unnamed conversation');
                const age = compactTime(thread.updatedAt, now);
                return (
                    <div
                        key={thread.id}
                        className="recent-chats-item"
                        role="button"
                        tabIndex={0}
                        aria-label={`${name}, ${age}`}
                        onClick={() => open(thread)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                open(thread);
                            }
                        }}
                    >
                        <span className="recent-chats-item-name truncate">{name}</span>
                        <span className="recent-chats-item-time">{age}</span>
                    </div>
                );
            })}
        </div>
    );
}
