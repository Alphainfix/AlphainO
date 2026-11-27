/**
 * Context chips: what goes with a question, shown above the message box and
 * at the top of each question sent, the way AlphainZ shows the paper open in
 * the reader, the items attached and the passage selected.
 *
 * `ChipButton`, `ChipRemovableIcon` and `useRemoveContextMenu` are AlphainZ's
 * own (react/components/agentRuns/requestChips, react/hooks), carried over
 * unchanged apart from where their icons and strings come from; the hover
 * cards and menus are the shared ones from @beaver/agent-ui.
 */
import React, { forwardRef, useCallback, useMemo, useRef, useState } from 'react';
import { prepareFuzzySearch, type App, type TFile } from 'obsidian';
import { ChipWithListPopup, ChipWithPopup, type ChipPopupContent } from '@beaver/agent-ui/chat/ChipPopup';
import ContextMenu, { type MenuItem, type MenuPosition } from '@beaver/agent-ui/primitives/ContextMenu';
import SearchMenu, { type SearchMenuCloseReason, type SearchMenuItem } from '@beaver/agent-ui/primitives/SearchMenu';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { CancelIcon, DeleteIcon, FileViewIcon, Icon, NoteIcon, PictureInPictureIcon as ImageIcon, PlusSignIcon, TextAlignLeftIcon } from '@beaver/agent-ui/icons';
import { t } from '../i18n';
import type { AttachedImage, Quote } from '../agent/quote';
import { noteTitle } from '../agent/quote';

// ---------------------------------------------------------------------------
// The chip shell (AlphainZ's ChipButton / ChipRemovableIcon / useRemoveContextMenu)
// ---------------------------------------------------------------------------

/** Only a primary click activates a chip; a right-click opens its menu instead. */
function stopLeftClick(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (event.button !== 0) event.preventDefault();
}

export const ChipButton = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }>(
    function ChipButton({ children, className = '', onClick, disabled, ...rest }, ref) {
        return (
            <button
                ref={ref}
                type="button"
                style={{ height: '22px' }}
                className={`variant-outline source-button ${className}`}
                disabled={disabled}
                onClick={(event) => {
                    stopLeftClick(event);
                    if (event.button === 0) onClick?.(event);
                }}
                {...rest}
            >
                {children}
            </button>
        );
    },
);

/** The leading icon, which turns into the remove "x" while the chip is hovered. */
export function ChipRemovableIcon({
    normalIcon,
    removeHandlers,
    removeMenuOpen = false,
}: {
    normalIcon: React.ReactNode;
    removeHandlers: React.HTMLAttributes<HTMLSpanElement>;
    removeMenuOpen?: boolean;
}) {
    return (
        <span className={`chip-icon-slot${removeMenuOpen ? ' chip-icon-slot-remove-open' : ''}`}>
            {normalIcon ? <span className="chip-icon-slot-normal">{normalIcon}</span> : null}
            <span role="button" aria-label={t('Remove')} className="source-remove chip-icon-slot-remove" {...removeHandlers}>
                <Icon icon={CancelIcon} className="scale-80" />
            </span>
        </span>
    );
}

/**
 * The chip's right-click menu: its own actions (open, reveal), then Remove,
 * and Remove all when more than one thing is attached. A left-click on the
 * "x" removes just this chip.
 */
export function useRemoveContextMenu({
    onRemove,
    onRemoveAll,
    canEdit = true,
    disabled = false,
    extraMenuItems,
}: {
    onRemove: () => void;
    onRemoveAll?: () => void;
    canEdit?: boolean;
    disabled?: boolean;
    extraMenuItems?: MenuItem[];
}) {
    const hasExtraItems = !!extraMenuItems && extraMenuItems.length > 0;
    const canShowMenu = !disabled && (canEdit || hasExtraItems);
    const [isRemoveMenuOpen, setIsRemoveMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });

    const removeItems: MenuItem[] = canEdit
        ? [
              ...(hasExtraItems ? [{ label: 'divider', isDivider: true, onClick: () => {} }] : []),
              { label: t('Remove'), icon: CancelIcon, onClick: () => onRemove() },
              ...(onRemoveAll ? [{ label: t('Remove all'), icon: DeleteIcon, onClick: () => onRemoveAll() }] : []),
          ]
        : [];

    const removeMenu = canShowMenu ? (
        <ContextMenu
            menuItems={[...(extraMenuItems ?? []), ...removeItems]}
            isOpen={isRemoveMenuOpen}
            onClose={() => setIsRemoveMenuOpen(false)}
            position={menuPosition}
            useFixedPosition={true}
            width={hasExtraItems ? '145px' : '110px'}
            itemLabelClassName="text-sm font-color-secondary truncate"
            itemIconClassName="font-color-secondary flex-shrink-0 scale-95"
        />
    ) : null;

    return {
        isRemoveMenuOpen,
        contextMenuHandlers: {
            onContextMenu: (event: React.MouseEvent) => {
                if (!canShowMenu) return;
                event.preventDefault();
                event.stopPropagation();
                setMenuPosition({ x: event.clientX, y: event.clientY });
                setIsRemoveMenuOpen(true);
            },
        },
        removeHandlers: {
            onClick: (event: React.MouseEvent<HTMLSpanElement>) => {
                event.stopPropagation();
                onRemove();
            },
        },
        removeMenu,
    };
}

// ---------------------------------------------------------------------------
// Notes and passages
// ---------------------------------------------------------------------------

/** Where a note is: its folder, or the vault itself. */
function folderOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash > 0 ? path.slice(0, slash) : t('Vault root');
}

function lineLabel(quote: Quote): string {
    if (/\.pdf$/i.test(quote.path)) return quote.page ? t('Page {page}', { page: quote.page }) : 'PDF';
    // A passage known by its text only (selected in an embedded note) has no line to name.
    if (quote.from <= 0) return '';
    return quote.from === quote.to ? t('Line {line}', { line: quote.from }) : t('Lines {from}–{to}', { from: quote.from, to: quote.to });
}

const MAX_SELECTION_PREVIEW = 160;

/** A note: the open one (not removable), or one the user attached. */
export function NoteChip(props: {
    path: string;
    onOpen: (path: string) => void;
    onRemove?: () => void;
    onRemoveAll?: () => void;
    /** Marks the note in view rather than one attached by hand. */
    current?: boolean;
    disabled?: boolean;
}) {
    const { path, onOpen, onRemove, onRemoveAll, current, disabled } = props;
    const canEdit = Boolean(onRemove);
    const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
        onRemove: () => onRemove?.(),
        onRemoveAll,
        canEdit,
        disabled,
        extraMenuItems: [{ label: t('Open note'), icon: FileViewIcon, onClick: () => onOpen(path) }],
    });
    const icon = <Icon icon={NoteIcon} className="mt-015 font-color-secondary" />;
    const popup = useMemo<ChipPopupContent>(
        () => ({
            icon: <Icon icon={NoteIcon} className="scale-90 font-color-primary mt-020" />,
            title: noteTitle(path),
            subtitle: { text: current ? t('Open in the editor · {folder}', { folder: folderOf(path) }) : folderOf(path) },
            action: { icon: FileViewIcon, label: t('Open note') },
        }),
        [path, current],
    );
    return (
        <>
            <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
                <ChipButton
                    {...contextMenuHandlers}
                    className={disabled ? 'disabled-but-styled' : ''}
                    disabled={disabled}
                    onClick={() => onOpen(path)}
                >
                    {canEdit ? <ChipRemovableIcon normalIcon={icon} removeHandlers={removeHandlers} removeMenuOpen={isRemoveMenuOpen} /> : icon}
                    <span className="truncate">{noteTitle(path)}</span>
                </ChipButton>
            </ChipWithPopup>
            {removeMenu}
        </>
    );
}

/** A passage selected in a note: on offer above the message box, or sent with a question. */
export function SelectionChip(props: {
    quote: Quote;
    onReveal: (quote: Quote) => void;
    onRemove?: () => void;
    onRemoveAll?: () => void;
    disabled?: boolean;
}) {
    const { quote, onReveal, onRemove, onRemoveAll, disabled } = props;
    const canEdit = Boolean(onRemove);
    const revealLabel = t('Reveal in note');
    const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
        onRemove: () => onRemove?.(),
        onRemoveAll,
        canEdit,
        disabled,
        extraMenuItems: [{ label: revealLabel, icon: FileViewIcon, onClick: () => onReveal(quote) }],
    });
    const popup = useMemo<ChipPopupContent>(() => {
        const flat = quote.text.replace(/\s+/g, ' ').trim();
        const text = flat.length > MAX_SELECTION_PREVIEW ? `${flat.slice(0, MAX_SELECTION_PREVIEW)}…` : flat;
        return {
            icon: <Icon icon={TextAlignLeftIcon} className="scale-90 font-color-primary mt-020" />,
            title: t('Text Selection'),
            subtitle: text ? { text } : null,
            status: { label: lineLabel(quote) ? `${noteTitle(quote.path)} · ${lineLabel(quote)}` : noteTitle(quote.path) },
            action: { icon: FileViewIcon, label: revealLabel },
        };
    }, [quote, revealLabel]);
    const icon = <Icon icon={TextAlignLeftIcon} className="mt-015 font-color-secondary" />;
    return (
        <>
            <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
                <ChipButton
                    {...contextMenuHandlers}
                    className={disabled ? 'disabled-but-styled' : ''}
                    disabled={disabled}
                    onClick={() => onReveal(quote)}
                >
                    {canEdit ? <ChipRemovableIcon normalIcon={icon} removeHandlers={removeHandlers} removeMenuOpen={isRemoveMenuOpen} /> : icon}
                    <span className="truncate">{t('Text Selection')}</span>
                </ChipButton>
            </ChipWithPopup>
            {removeMenu}
        </>
    );
}

/** An image pasted or dropped into the message box, or sent with a question; its card shows it. */
export function ImageChip(props: { image: AttachedImage; source: string; onRemove?: () => void; onRemoveAll?: () => void; disabled?: boolean }) {
    const { image, source, onRemove, onRemoveAll, disabled } = props;
    const canEdit = Boolean(onRemove);
    const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
        onRemove: () => onRemove?.(),
        onRemoveAll,
        canEdit,
        disabled,
    });
    const popup = useMemo<ChipPopupContent>(
        () => ({
            icon: <Icon icon={ImageIcon} className="scale-90 font-color-primary mt-020" />,
            title: image.name,
            subtitle: null,
            media: source ? <img className="alphaino-chip-image" src={source} alt={image.name} /> : undefined,
        }),
        [image.name, source],
    );
    const icon = <Icon icon={ImageIcon} className="mt-015 font-color-secondary" />;
    return (
        <>
            <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
                <ChipButton {...contextMenuHandlers} className={disabled ? 'disabled-but-styled' : ''} disabled={disabled}>
                    {canEdit ? <ChipRemovableIcon normalIcon={icon} removeHandlers={removeHandlers} removeMenuOpen={isRemoveMenuOpen} /> : icon}
                    <span className="truncate">{image.name}</span>
                </ChipButton>
            </ChipWithPopup>
            {removeMenu}
        </>
    );
}

/** More than four attached notes collapse into "+N", whose card lists the rest. */
export const MAX_SHOWN_NOTES = 4;

export function OverflowChip({ paths }: { paths: string[] }) {
    if (paths.length === 0) return null;
    return (
        <ChipWithListPopup
            content={{
                rows: paths.slice(0, 12).map((path) => ({
                    key: path,
                    icon: <Icon icon={NoteIcon} className="scale-90 font-color-secondary" />,
                    title: noteTitle(path),
                    subtitle: { text: folderOf(path) },
                })),
                footer: paths.length > 12 ? t('{count} more notes', { count: paths.length - 12 }) : null,
            }}
        >
            <button type="button" className="variant-outline source-button" style={{ height: '22px' }}>
                +{paths.length}
            </button>
        </ChipWithListPopup>
    );
}

// ---------------------------------------------------------------------------
// Adding notes
// ---------------------------------------------------------------------------

/** How many notes the menu proposes before anything is typed. */
const RECENT_LIMIT = 6;
const RESULT_LIMIT = 30;

function noteMenuItem(file: TFile, query: string, onPick: (path: string) => void): SearchMenuItem {
    const folder = file.parent && file.parent.path !== '/' ? file.parent.path : '';
    return {
        label: file.basename,
        icon: NoteIcon,
        onClick: () => onPick(file.path),
        customContent: (
            <span className="display-flex items-center gap-2 w-full min-w-0">
                <Icon icon={NoteIcon} size={14} className="font-color-secondary flex-shrink-0" />
                <span className="display-flex flex-col min-w-0 flex-1">
                    <span className="text-sm font-color-secondary truncate">{highlight(file.basename, query)}</span>
                    {folder ? <span className="text-xs font-color-tertiary truncate">{folder}</span> : null}
                </span>
            </span>
        ),
    };
}

function highlight(label: string, query: string): React.ReactNode {
    const needle = query.trim().toLowerCase();
    if (!needle) return label;
    const at = label.toLowerCase().indexOf(needle);
    if (at === -1) return label;
    return (
        <>
            {label.slice(0, at)}
            <span className="font-color-accent-blue">{label.slice(at, at + needle.length)}</span>
            {label.slice(at + needle.length)}
        </>
    );
}

/** The vault's notes that match a query, best first; the recently opened ones when it is empty. */
export function findNotes(app: App, query: string, exclude: ReadonlySet<string>): TFile[] {
    const files = app.vault.getMarkdownFiles().filter((file) => !exclude.has(file.path));
    const trimmed = query.trim();
    if (!trimmed) {
        const byPath = new Map(files.map((file) => [file.path, file]));
        const recent = app.workspace
            .getLastOpenFiles()
            .map((path) => byPath.get(path))
            .filter((file): file is TFile => Boolean(file));
        const fill = files.filter((file) => !recent.includes(file)).sort((a, b) => b.stat.mtime - a.stat.mtime);
        return [...recent, ...fill].slice(0, RECENT_LIMIT);
    }
    const match = prepareFuzzySearch(trimmed);
    return files
        .map((file) => {
            const byName = match(file.basename);
            const byPath = byName ? null : match(file.path);
            const result = byName ?? byPath;
            return result ? { file, score: result.score + (byName ? 1 : 0) } : null;
        })
        .filter((hit): hit is { file: TFile; score: number } => hit !== null)
        .sort((a, b) => b.score - a.score || b.file.stat.mtime - a.file.stat.mtime)
        .slice(0, RESULT_LIMIT)
        .map((hit) => hit.file);
}

/** The "+" button: search the vault's notes and attach one to the question. */
/** The Add Sources menu's state, from the shared `useAddSourcesMenu` (opened by "+" or by typing "@"). */
export interface AddSourcesMenuState {
    isOpen: boolean;
    position: MenuPosition;
    query: string;
    /** `editor`: opened by a typed "@", the query is what follows it in the message box; `menu`: opened by "+". */
    querySource: 'editor' | 'menu';
    setQuery: (value: string) => void;
    openFromButton: (at: MenuPosition) => void;
    dismiss: (reason?: SearchMenuCloseReason) => void;
    commit: () => void;
}

export function AddNotesButton(props: {
    app: App;
    attached: ReadonlySet<string>;
    onPick: (path: string) => void;
    /** Show "Add Sources" beside the "+" while nothing else is in the row. */
    showText: boolean;
    disabled?: boolean;
    menu: AddSourcesMenuState;
    /** Where the menu opens: above the box at the bottom, below it in the middle of the empty view. */
    verticalPosition?: 'above' | 'below';
}) {
    const { app, attached, onPick, showText, disabled, menu, verticalPosition = 'above' } = props;
    const buttonRef = useRef<HTMLButtonElement>(null);

    const items = useMemo<SearchMenuItem[]>(() => {
        if (!menu.isOpen) return [];
        const notes = findNotes(app, menu.query, attached);
        const header: SearchMenuItem[] = menu.query.trim() ? [] : [{ label: t('Recent notes'), isGroupHeader: true, onClick: () => {} }];
        return [
            ...header,
            ...notes.map((file) =>
                noteMenuItem(file, menu.query, (path) => {
                    onPick(path);
                    // A typed "@query" did its job as a search box: it leaves the message.
                    menu.commit();
                }),
            ),
        ];
    }, [app, attached, onPick, menu]);

    return (
        <>
            <Tooltip content={t('Add Sources')} showArrow singleLine placement="top">
                <button
                    ref={buttonRef}
                    type="button"
                    className="variant-outline source-button"
                    style={{ height: '22px', paddingRight: '4px', paddingLeft: '4px', paddingTop: '3px', paddingBottom: '3px' }}
                    aria-label={t('Add Sources')}
                    aria-haspopup="menu"
                    aria-expanded={menu.isOpen}
                    disabled={disabled}
                    onClick={(event) => {
                        event.stopPropagation();
                        const rect = buttonRef.current?.getBoundingClientRect();
                        if (!rect) return;
                        menu.openFromButton({ x: rect.left, y: verticalPosition === 'above' ? rect.top - 5 : rect.bottom + 5 });
                        buttonRef.current?.blur();
                    }}
                >
                    <Icon icon={PlusSignIcon} className="scale-12" />
                    {showText ? <span>{t('Add Sources')}</span> : null}
                </button>
            </Tooltip>
            <SearchMenu
                menuItems={items}
                isOpen={menu.isOpen}
                onClose={(reason) => {
                    menu.dismiss(reason);
                    if (reason === 'keyboard' && menu.querySource === 'menu') buttonRef.current?.focus();
                }}
                position={menu.position}
                useFixedPosition={true}
                verticalPosition={verticalPosition}
                width="250px"
                maxHeight="300px"
                onSearch={() => {}}
                noResultsText={t('No notes found')}
                placeholder={t('Search notes')}
                closeOnSelect={false}
                searchQuery={menu.query}
                setSearchQuery={menu.setQuery}
                showSearchInput={menu.querySource === 'menu'}
            />
        </>
    );
}
