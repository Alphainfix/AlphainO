/**
 * The chat history, over the chat area as AlphainZ's ThreadListView: a search,
 * the chats grouped by date (Today, Yesterday, This Week, This Month, Older),
 * each with when it last changed; on hover Rename and Delete. Deleting moves a
 * chat to the Archive, where it can be restored or deleted for good, as in
 * AlphainZ. Same markup and classes, so AlphainZ's sheet draws it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Notice } from 'obsidian';
import { CancelIcon, ClockIcon, DeleteIcon, EditIcon, Icon, NoteIcon, PdfIcon, SearchIcon, TickIcon, UndoIcon } from '@beaver/agent-ui/icons';
import { ChipButton } from './chips';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { highlightSegments } from '@beaver/agent-ui/conversation/turns';
import type AlphainOPlugin from '../main';
import type { ConversationSummary } from '../store/conversations';
import { noteTitle } from '../agent/quote';
import { t, tn } from '../i18n';
import { confirmInModal } from '../settings/confirm';
import { dateGroup, timeAgo } from './time';

const GROUPS = ['Today', 'Yesterday', 'This Week', 'This Month', 'Older'] as const;

function Highlighted({ text, query }: { text: string; query: string }) {
    return (
        <>
            {highlightSegments(text, query).map((segment, i) =>
                segment.match ? (
                    <span key={i} className="font-color-accent-blue">
                        {segment.text}
                    </span>
                ) : (
                    <React.Fragment key={i}>{segment.text}</React.Fragment>
                ),
            )}
        </>
    );
}

export function ThreadListPanel(props: {
    plugin: AlphainOPlugin;
    currentId: string;
    onOpen: (id: string) => void;
    /** A chat is about to be archived or deleted (before its file changes). */
    onRemoving?: (id: string) => Promise<void> | void;
    /** A chat was archived or deleted: the open one is replaced by a new chat. */
    onRemoved: (id: string) => void;
    onRenamed: (id: string, name: string) => void;
    onClose: () => void;
    /** Only the chats about this note (AlphainZ's item filter, set by "View All" under the empty view). */
    filter?: string | null;
    onClearFilter?: () => void;
}) {
    const { plugin, currentId, onOpen, onRemoving, onRemoved, onRenamed, onClose, filter = null, onClearFilter } = props;
    const [threads, setThreads] = useState<ConversationSummary[] | null>(null);
    const [query, setQuery] = useState('');
    const [showArchive, setShowArchive] = useState(false);
    const [hovered, setHovered] = useState<string | null>(null);
    const [editing, setEditing] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const reload = useCallback(async () => setThreads(await plugin.conversations.list()), [plugin]);
    useEffect(() => {
        void reload();
        inputRef.current?.focus();
    }, [reload]);

    const activeQuery = query.trim();
    const visible = useMemo(() => {
        let list = (threads ?? []).filter((thread) => Boolean(thread.archivedAt) === showArchive);
        if (filter) list = list.filter((thread) => thread.notes.includes(filter));
        if (activeQuery) {
            // As in AlphainZ: chats whose name matches first, then those whose questions or answers do.
            const needle = activeQuery.toLowerCase();
            const byName = list.filter((thread) => (thread.name || t('Unnamed conversation')).toLowerCase().includes(needle));
            const byText = list.filter((thread) => !byName.includes(thread) && thread.searchText.includes(needle));
            list = [...byName, ...byText];
        }
        return list;
    }, [threads, showArchive, activeQuery, filter]);
    const filterLabel = filter ? noteTitle(filter) : '';
    const grouped = useMemo(() => {
        const groups = new Map<string, ConversationSummary[]>(GROUPS.map((group) => [group, []]));
        for (const thread of visible) groups.get(dateGroup(thread.updatedAt))?.push(thread);
        return groups;
    }, [visible]);

    const fail = (error: unknown) => new Notice(String((error as Error)?.message ?? error));

    const archive = async (id: string) => {
        try {
            await onRemoving?.(id);
            await plugin.conversations.archive(id);
            onRemoved(id);
            await reload();
        } catch (error) {
            fail(error);
        }
    };
    const restore = async (id: string) => {
        try {
            await plugin.conversations.restore(id);
            new Notice(t('The chat is back in your history.'));
            await reload();
        } catch (error) {
            fail(error);
        }
    };
    const purge = async (id: string) => {
        const ok = await confirmInModal(
            plugin.app,
            t('Delete forever?'),
            t('This permanently deletes the chat here and on your other synced computers. It cannot be undone.'),
            t('Delete'),
        );
        if (!ok) return;
        try {
            await onRemoving?.(id);
            await plugin.conversations.remove(id);
            onRemoved(id);
            await reload();
        } catch (error) {
            fail(error);
        }
    };
    const confirmRename = async (id: string) => {
        const name = editingName.trim();
        setEditing(null);
        if (!name) return;
        try {
            await plugin.conversations.rename(id, name);
            onRenamed(id, name);
            await reload();
        } catch (error) {
            fail(error);
        }
    };

    return (
        <div className="thread-overlay-container">
            <div className="thread-overlay-backdrop" onClick={onClose} />
            <div
                className="thread-overlay-panel"
                onKeyDown={(event) => {
                    if (event.key === 'Escape' && !editing) {
                        event.preventDefault();
                        onClose();
                    }
                }}
            >
                <div className="display-flex flex-col flex-1 min-h-0">
                    <div className="thread-overlay-title mb-1">{t('Chats')}</div>
                    <div className="px-3 pb-2">
                        <div className="thread-search-wrapper">
                            <SearchIcon width={14} height={14} className="thread-search-icon" />
                            <input
                                ref={inputRef}
                                type="text"
                                className="thread-search-input"
                                placeholder={t('Search chats...')}
                                aria-label={t('Search chats')}
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                            />
                        </div>
                    </div>
                    <div className="thread-filter-row">
                        <Tooltip content={showArchive ? t('Back to your chats') : t('Archive')} secondaryContent={showArchive ? undefined : t('Deleted chats are kept here and can be restored.')} width="220px">
                            <ChipButton className={showArchive ? 'thread-filter-chip' : undefined} onClick={() => setShowArchive((value) => !value)} aria-label={t('Archive')} aria-pressed={showArchive}>
                                <Icon icon={showArchive ? UndoIcon : ClockIcon} className="scale-80" />
                                <span className="truncate">{t('Archive')}</span>
                            </ChipButton>
                        </Tooltip>
                        {filter ? (
                            <>
                                <div className="thread-filter-divider" />
                                <ChipButton className="thread-filter-chip" onClick={() => {}} aria-label={t('Filtered by {label}', { label: filterLabel })}>
                                    <Icon icon={/\.pdf$/i.test(filter) ? PdfIcon : NoteIcon} className="scale-80" />
                                    <span className="truncate">{filterLabel}</span>
                                    <span
                                        role="button"
                                        aria-label={t('Remove filter')}
                                        className="thread-filter-chip-remove"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            onClearFilter?.();
                                            inputRef.current?.focus();
                                        }}
                                    >
                                        <Icon icon={CancelIcon} className="scale-70" />
                                    </span>
                                </ChipButton>
                            </>
                        ) : null}
                    </div>
                    {filter && threads !== null ? (
                        <div className="thread-filter-count">
                            {showArchive
                                ? tn(visible.length, 'Showing {count} archived chat related to {label}', 'Showing {count} archived chats related to {label}', { label: filterLabel })
                                : tn(visible.length, 'Showing {count} chat related to {label}', 'Showing {count} chats related to {label}', { label: filterLabel })}
                        </div>
                    ) : null}
                    <div className="flex-1 overflow-y-auto px-1">
                        {threads !== null && visible.length === 0 ? (
                            <div className="display-flex items-center justify-center py-6">
                                <span className="font-color-tertiary text-sm">
                                    {activeQuery
                                        ? t('No matching chats')
                                        : filter
                                            ? showArchive
                                                ? t('No archived chats about {label}', { label: filterLabel })
                                                : t('No chats about {label}', { label: filterLabel })
                                            : showArchive
                                                ? t('The archive is empty')
                                                : t('No chats yet')}
                                </span>
                            </div>
                        ) : null}
                        {GROUPS.map((group) => {
                            const list = grouped.get(group) ?? [];
                            if (list.length === 0) return null;
                            return (
                                <div key={group}>
                                    <div className="thread-group-header">{t(group)}</div>
                                    {list.map((thread) => {
                                        const name = thread.name || t('Unnamed conversation');
                                        const isCurrent = thread.id === currentId;
                                        const isEditing = editing === thread.id;
                                        const archived = Boolean(thread.archivedAt);
                                        return (
                                            <div
                                                key={thread.id}
                                                className={`thread-list-item ${isEditing ? 'thread-list-item-editing' : ''} ${hovered === thread.id ? 'thread-list-item-hovered' : ''}`}
                                                role={isEditing ? undefined : 'button'}
                                                tabIndex={isEditing ? undefined : 0}
                                                onClick={() => !isEditing && !archived && onOpen(thread.id)}
                                                onKeyDown={(event) => {
                                                    if (isEditing || event.target !== event.currentTarget) return;
                                                    if ((event.key === 'Enter' || event.key === ' ') && !archived) {
                                                        event.preventDefault();
                                                        onOpen(thread.id);
                                                    }
                                                }}
                                                onMouseEnter={() => setHovered(thread.id)}
                                                onMouseLeave={() => setHovered(null)}
                                            >
                                                <div className="flex-1 min-w-0">
                                                    {isEditing ? (
                                                        <input
                                                            type="text"
                                                            className="thread-rename-input"
                                                            value={editingName}
                                                            autoFocus
                                                            onChange={(event) => setEditingName(event.target.value)}
                                                            onClick={(event) => event.stopPropagation()}
                                                            onKeyDown={(event) => {
                                                                if (event.key === 'Enter') {
                                                                    event.preventDefault();
                                                                    void confirmRename(thread.id);
                                                                } else if (event.key === 'Escape') {
                                                                    event.preventDefault();
                                                                    event.stopPropagation();
                                                                    setEditing(null);
                                                                }
                                                            }}
                                                        />
                                                    ) : (
                                                        <div className="thread-list-item-name truncate">
                                                            <Highlighted text={name} query={activeQuery} />
                                                        </div>
                                                    )}
                                                    <div className="thread-list-item-time">
                                                        {timeAgo(thread.updatedAt)}
                                                        {isCurrent ? t(' (current chat)') : ''}
                                                    </div>
                                                </div>
                                                <div className="thread-list-item-actions">
                                                    {isEditing ? (
                                                        <div className="display-flex gap-2">
                                                            <IconButton
                                                                icon={CancelIcon}
                                                                variant="ghost-secondary"
                                                                className="scale-90"
                                                                ariaLabel={t('Cancel rename')}
                                                                onClick={(event) => {
                                                                    event.stopPropagation();
                                                                    setEditing(null);
                                                                }}
                                                            />
                                                            <IconButton
                                                                icon={TickIcon}
                                                                variant="ghost-secondary"
                                                                className="scale-11"
                                                                ariaLabel={t('Confirm rename')}
                                                                onClick={(event) => {
                                                                    event.stopPropagation();
                                                                    void confirmRename(thread.id);
                                                                }}
                                                            />
                                                        </div>
                                                    ) : (
                                                        <div className="display-flex gap-3">
                                                            {!archived ? (
                                                                <IconButton
                                                                    icon={EditIcon}
                                                                    variant="ghost-secondary"
                                                                    className="scale-95"
                                                                    ariaLabel={t('Rename thread')}
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                        setEditingName(name);
                                                                        setEditing(thread.id);
                                                                    }}
                                                                />
                                                            ) : null}
                                                            <IconButton
                                                                icon={archived ? UndoIcon : DeleteIcon}
                                                                variant="ghost-secondary"
                                                                className="scale-95"
                                                                ariaLabel={archived ? t('Restore this chat') : t('Move this chat to the archive')}
                                                                onClick={(event) => {
                                                                    event.stopPropagation();
                                                                    void (archived ? restore(thread.id) : archive(thread.id));
                                                                }}
                                                            />
                                                            {archived ? (
                                                                <IconButton
                                                                    icon={DeleteIcon}
                                                                    variant="ghost-secondary"
                                                                    className="scale-95"
                                                                    ariaLabel={t('Delete this chat forever, on every synced computer')}
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                        void purge(thread.id);
                                                                    }}
                                                                />
                                                            ) : null}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
