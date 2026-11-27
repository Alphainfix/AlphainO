/**
 * The note index's state in the chat's header, as AlphainZ's
 * EmbeddingIndexStatusButton shows its library index: the percentage on the
 * button's face and a turning icon while notes are being indexed, a red mark
 * when indexing failed (a click tries again). Hidden while there is nothing to
 * say — including the moment it takes to re-index a note being edited, which
 * would otherwise flicker in the header with every save.
 */
import React, { useEffect, useState } from 'react';
import { AlertIcon, Icon, SyncIcon } from '@beaver/agent-ui/icons';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import type { IndexStatus } from '../search/types';
import type { ImageIndexStatus } from '../search/imageIndex';
import { t } from '../i18n';

/** Fewer notes than this waiting is a note being edited, not indexing worth showing. */
const SHOW_FROM_PENDING = 4;

export interface IndexStatusView {
    visible: boolean;
    indexing: boolean;
    percent: number | null;
    title: string;
    detail?: string;
    /** Which index it is about, for the click. */
    about?: 'notes' | 'pictures';
}

/** What the button says for a status (pure, for tests). */
export function describeNoteIndex(status: IndexStatus | null): IndexStatusView {
    const hidden: IndexStatusView = { visible: false, indexing: false, percent: null, title: '' };
    if (!status) return hidden;
    if (status.state === 'error' || (status.state === 'paused' && status.lastError)) {
        return { visible: true, indexing: false, percent: null, title: t('Indexing Error'), detail: status.lastError || t('Click to retry') };
    }
    if (status.state !== 'indexing' || status.pending < SHOW_FROM_PENDING) return hidden;
    const total = status.notesTotal;
    const done = Math.max(0, Math.min(total, status.notesIndexed));
    const percent = total > 0 ? Math.round((done / total) * 100) : null;
    return {
        visible: true,
        indexing: true,
        percent,
        title: t('Indexing your notes'),
        detail: percent === null ? undefined : `${percent}% · ${t('{done}/{total} notes', { done: done.toLocaleString(), total: total.toLocaleString() })}`,
    };
}

/**
 * The notes first, as before; once they are done, the pictures being indexed
 * (Settings → Note search → Pictures), or why indexing them stopped.
 */
export function describeIndexes(notes: IndexStatus | null, pictures: ImageIndexStatus | null): IndexStatusView {
    const forNotes = describeNoteIndex(notes);
    if (forNotes.visible) return { ...forNotes, about: 'notes' };
    const hidden: IndexStatusView = { visible: false, indexing: false, percent: null, title: '' };
    if (!pictures || pictures.state === 'off') return hidden;
    if (pictures.state === 'error' || (pictures.state === 'paused' && pictures.lastError)) {
        return { visible: true, indexing: false, percent: null, title: t('Picture indexing error'), detail: pictures.lastError || t('Click to retry'), about: 'pictures' };
    }
    if (pictures.state !== 'indexing' || pictures.pending < SHOW_FROM_PENDING) return hidden;
    const total = Math.max(0, pictures.imagesTotal - pictures.skipped);
    const done = Math.max(0, Math.min(total, pictures.imagesIndexed));
    const percent = total > 0 ? Math.round((done / total) * 100) : null;
    return {
        visible: true,
        indexing: true,
        percent,
        title: t('Indexing your pictures'),
        detail: percent === null ? undefined : `${percent}% · ${t('{done}/{total} pictures', { done: done.toLocaleString(), total: total.toLocaleString() })}`,
        about: 'pictures',
    };
}

export function IndexStatusButton({
    status: read,
    subscribe,
    pictures: readPictures,
    subscribePictures,
    onRetry,
    onRetryPictures,
    onOpenSettings,
}: {
    status: () => IndexStatus | null;
    subscribe: (listener: (status: IndexStatus) => void) => () => void;
    pictures?: () => ImageIndexStatus | null;
    subscribePictures?: (listener: (status: ImageIndexStatus) => void) => () => void;
    onRetry: () => void;
    onRetryPictures?: () => void;
    onOpenSettings: () => void;
}) {
    const [status, setStatus] = useState<IndexStatus | null>(() => read());
    const [pictureStatus, setPictureStatus] = useState<ImageIndexStatus | null>(() => readPictures?.() ?? null);
    const [hovered, setHovered] = useState(false);
    useEffect(() => {
        setStatus(read());
        return subscribe(setStatus);
    }, [read, subscribe]);
    useEffect(() => {
        setPictureStatus(readPictures?.() ?? null);
        return subscribePictures?.(setPictureStatus);
    }, [readPictures, subscribePictures]);
    const view = describeIndexes(status, pictureStatus);
    if (!view.visible) return null;
    const icon = view.indexing ? SyncIcon : hovered ? SyncIcon : AlertIcon;
    const iconClass = view.indexing ? 'animate-spin' : hovered ? '' : 'font-color-red';
    const ariaLabel = view.indexing ? `${view.title}${view.percent !== null ? `, ${view.percent}%` : ''}` : t('Rebuild Search Index');
    return (
        <Tooltip content={view.title} secondaryContent={view.detail} showArrow singleLine>
            <button
                type="button"
                className="index-status-button variant-ghost has-text display-flex flex-row items-center gap-1"
                onClick={() => (view.indexing ? onOpenSettings() : view.about === 'pictures' ? onRetryPictures?.() : onRetry())}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                aria-label={ariaLabel}
            >
                <Icon icon={icon} className={`scale-11 ${iconClass}`} />
                {view.percent !== null ? <span className="text-sm font-color-secondary tabular-nums">{view.percent}%</span> : null}
            </button>
        </Tooltip>
    );
}
