/**
 * What an answer is made of, drawn the way AlphainZ draws it: the thinking as
 * a collapsible row with a glimpse of the thought, each tool call as a row
 * with its label and state, the follow-up suggestions as chips, and a footer
 * with copy and usage. Same markup and shared classes as AlphainZ's
 * ThinkingPartView, ToolCallPartView and SuggestionsView, so the shared sheets
 * style both alike; text goes through Obsidian's own Markdown renderer.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Notice } from 'obsidian';
import type { AgentRun, ThinkingPart, ToolCallPart, ToolReturnPart } from '@beaver/agent-core/agents/types';
import { getToolCallLabel } from '@beaver/agent-core/run-state/toolLabels';
import { toolBaseLabel } from '@beaver/agent-core/run-state/toolCallRequest';
import { getRunErrorTitle, stripRunErrorTypePrefix } from '@beaver/agent-core/run-state/runErrorCopy';
import { shouldShowRunStatus } from '@beaver/agent-core/run-state/runStatusVisibility';
import { runStatusText } from '@beaver/agent-core/run-state/runStatusCopy';
import type { ToolCallStatus } from '@beaver/agent-core/run-state/atoms';
import {
    AlertCircleIcon,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    BrainIcon,
    CancelIcon,
    ChattingIcon,
    CopyIcon,
    DocumentValidationIcon,
    FileViewIcon,
    FolderDetailIcon,
    HighlighterIcon,
    InformationCircleIcon,
    LinkIcon,
    PropertyEditIcon,
    PuzzleIcon,
    SearchIcon,
    TagIcon,
    TextAlignLeftIcon,
    ToolsIcon,
    ViewIcon,
    Icon,
    LibraryIcon as BookIcon,
    MoreHorizontalIcon,
    NoteIcon,
    RepeatIcon,
    SettingsIcon,
    Spinner,
    TickIcon,
} from '@beaver/agent-ui/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import type AlphainOPlugin from '../main';
import { t, tn } from '../i18n';
import { Markdown } from './Markdown';
import { prepareAnswerMarkdown } from './markdownFixes';
import type { RunWarning } from '../agent/runTurn';
import { answerWithSteps } from './chatContent';

/**
 * AlphainO's own tools, labelled as AlphainZ labels its library tools: a base
 * label that stays the same while the call runs and after (the icon shows
 * which), then what the call is about.
 */
const OWN_TOOL_LABELS: Record<string, string> = {
    search_vault_fulltext: 'Searching your notes',
    note_search_by_topic: 'Note search',
    note_search_by_metadata: 'Note search',
    read_note: 'Reading',
    search_in_note: 'Searching in note',
    list_notes: 'List notes',
    list_folders: 'List folders',
    list_tags: 'List tags',
    get_note_metadata: 'Note details',
    get_note_links: 'Links',
    get_active_note: 'Looking at the open note',
    search_vault_images: 'Finding pictures',
    view_vault_image: 'Looking at a picture',
    get_comments: 'Get comments',
    find_comments: 'Find comments',
    add_comment: 'Commenting',
    reply_to_comment: 'Replying to a comment',
    resolve_comment: 'Resolving a comment',
    edit_note: 'Editing note',
    create_note: 'Creating a note',
};

/** The tools that act on an answer already reached (a comment, an edit, a note): never folded away as work. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['add_comment', 'reply_to_comment', 'resolve_comment', 'edit_note', 'create_note']);

/** A tool's short name for the fold's summary line ("Searching your notes ×3 · Reading"). */
export function toolBaseName(toolName: string): string | undefined {
    const own = OWN_TOOL_LABELS[toolName];
    if (own) return t(own);
    return toolName.startsWith('zotero_') ? toolBaseLabel(toolName.slice('zotero_'.length)) : toolBaseLabel(toolName);
}

/** How much of an answer's working steps the chat shows (AlphainZ's `streamDisplay`). */
export type StreamDisplayMode = 'expanded' | 'collapsed' | 'answer';
export const STREAM_DISPLAY_MODES: StreamDisplayMode[] = ['expanded', 'collapsed', 'answer'];
export const STREAM_DISPLAY_LABELS: Record<StreamDisplayMode, string> = {
    expanded: 'Show all steps',
    collapsed: 'Collapse steps',
    answer: 'Answer only',
};
export const STREAM_DISPLAY_HINTS: Record<StreamDisplayMode, string> = {
    expanded: 'Thinking and tool calls inline',
    collapsed: 'One line you can open',
    answer: 'Everything while it works, then just the answer',
};

/** The display mode as stored (pref `streamDisplay`, AlphainZ's key), collapsed when unset. */
export function readStreamDisplay(value: unknown): StreamDisplayMode {
    if (STREAM_DISPLAY_MODES.includes(value as StreamDisplayMode)) return value as StreamDisplayMode;
    return value === 'hidden' ? 'answer' : 'collapsed';
}

/** Which folds are open, by id, while Obsidian runs (AlphainZ keeps them with the thinking rows). */
const openFolds = new Map<string, boolean>();

/**
 * An answer's working steps behind one line, as AlphainZ's WorkStreamView:
 * open while it works, closed once it is done; a click either way is kept.
 */
export function WorkStreamFold({ streamId, summary, working, children }: { streamId: string; summary: string; working: boolean; children: React.ReactNode }) {
    const [chosen, setChosen] = useState<boolean | undefined>(() => openFolds.get(streamId));
    const [hovered, setHovered] = useState(false);
    const expanded = chosen ?? working;
    const icon = expanded ? ArrowDownIcon : hovered ? ArrowRightIcon : working ? Spinner : ToolsIcon;
    return (
        <div className={`work-stream rounded-md display-flex flex-col min-w-0 ${expanded ? 'border-popup' : ''}`}>
            <div className={`display-flex flex-row py-15 ${expanded ? 'border-bottom-quinary bg-senary' : ''}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
                <button
                    type="button"
                    className="alphaino-row-button display-flex flex-row cursor-pointer gap-2 w-full text-left"
                    aria-expanded={expanded}
                    aria-controls={`work-stream-${streamId}`}
                    data-step-group="true"
                    onClick={() => {
                        openFolds.set(streamId, !expanded);
                        setChosen(!expanded);
                    }}
                >
                    <div className="display-flex flex-row px-3 gap-2 min-w-0">
                        <div className={`flex-1 display-flex mt-010 ${expanded ? 'font-color-primary' : ''}`}>
                            <Icon icon={icon} />
                        </div>
                        <div className={`display-flex truncate ${expanded ? 'font-color-primary' : 'font-color-secondary'} ${working ? 'alphaino-shimmer' : ''}`}>{summary}</div>
                    </div>
                </button>
                <div className="flex-1" />
            </div>
            {expanded ? (
                <div id={`work-stream-${streamId}`} className="px-1 py-1">
                    {children}
                </div>
            ) : null}
        </div>
    );
}

function noteName(value: unknown): string {
    const raw = typeof value === 'string' ? value.trim().replace(/^\[\[|\]\]$/g, '').split('|')[0] : '';
    const path = raw.split('#')[0];
    return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

function short(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The SUGGESTIONS_TOOL has no row; this is never asked for it. */
export function ownToolLabel(part: ToolCallPart): string | null {
    const base = OWN_TOOL_LABELS[part.tool_name];
    if (!base) return null;
    const label = t(base);
    const args = argsOf(part);
    const quoted = (value: unknown, max = 40) => (typeof value === 'string' && value.trim() ? t('{label}: "{text}"', { label, text: short(value.trim(), max) }) : null);
    const named = (value: unknown) => {
        const name = noteName(value);
        return name ? t('{label}: {name}', { label, name }) : null;
    };
    switch (part.tool_name) {
        case 'search_vault_fulltext':
        case 'find_comments':
            return quoted(part.tool_name === 'find_comments' ? args.text_contains : args.query, 48) ?? label;
        case 'note_search_by_topic':
            return quoted(args.topic_query) ?? label;
        case 'search_vault_images':
            return quoted(args.query, 48) ?? label;
        case 'view_vault_image': {
            const raw = typeof args.path === 'string' ? args.path.trim().replace(/^!?\[\[|\]\]$/g, '').split('|')[0] : '';
            const name = raw.slice(raw.lastIndexOf('/') + 1);
            return name ? t('{label}: {name}', { label, name }) : label;
        }
        case 'note_search_by_metadata':
            return quoted([args.title_query, args.tag, args.property, args.folder].filter((v) => typeof v === 'string' && v.trim()).join(' · ')) ?? label;
        case 'search_in_note': {
            const name = noteName(args.note_id);
            const query = typeof args.query === 'string' ? args.query.trim() : '';
            if (query && name) return t('{label}: "{query}" in {name}', { label, query: short(query, 32), name });
            return quoted(query) ?? label;
        }
        case 'read_note': {
            const name = noteName(args.note_id ?? args.path);
            const heading = typeof args.heading === 'string' && args.heading.trim() ? args.heading.trim() : '';
            const lines = Number.isInteger(args.start_line) ? (Number.isInteger(args.end_line) ? `${args.start_line}–${args.end_line}` : `${args.start_line}–`) : '';
            const where = heading ? `#${heading}` : lines ? t('lines {lines}', { lines }) : '';
            if (name) return where ? t('{label}: {name}, {where}', { label, name, where }) : t('{label}: {name}', { label, name });
            return label;
        }
        case 'list_notes':
            return quoted(args.folder ?? args.tag) ?? label;
        case 'get_note_links':
        case 'get_comments':
        case 'add_comment':
        case 'edit_note':
            return named(args.note_id) ?? label;
        case 'create_note':
            return quoted(args.title) ?? label;
        case 'resolve_comment':
            return args.resolved === false ? t('Reopening a comment') : label;
        default:
            return label;
    }
}

/** The tool that offers follow-up chips; it has no row of its own. */
export const SUGGESTIONS_TOOL = 'return_suggestions';

export function toolLabel(part: ToolCallPart, status: ToolCallStatus): string {
    const own = ownToolLabel(part);
    if (own) return own;
    // AlphainZ's library tools reach AlphainO prefixed; their labels are AlphainZ's own.
    const name = part.tool_name.startsWith('zotero_') ? part.tool_name.slice('zotero_'.length) : part.tool_name;
    return getToolCallLabel({ ...part, tool_name: name }, status);
}

export function argsOf(part: ToolCallPart): Record<string, unknown> {
    if (part.args && typeof part.args === 'object') return part.args as Record<string, unknown>;
    if (typeof part.args === 'string') {
        try {
            const parsed = JSON.parse(part.args);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return part.streaming_args ?? {};
        }
    }
    return part.streaming_args ?? {};
}

/** Which thinking rows are open, by id, while Obsidian runs (AlphainZ's thinkingVisibilityAtom). */
const openThinking = new Map<string, boolean>();

/**
 * A run of thinking as one row, as AlphainZ's ThinkingPartView: "Thinking" with
 * a spinner while it thinks, then "Thoughts" with the first line of the thought;
 * a click opens the thought. The open state is kept by id across redraws.
 */
export function ThinkingRow({ id, parts, thinking, plugin }: { id: string; parts: ThinkingPart[]; thinking: boolean; plugin: AlphainOPlugin }) {
    const [expanded, setExpandedState] = useState(() => openThinking.get(id) ?? false);
    const setExpanded = (open: boolean) => {
        openThinking.set(id, open);
        setExpandedState(open);
    };
    const [hovered, setHovered] = useState(false);
    const content = parts.map((part) => part.content).join('\n\n').trim().replace(/^undefined/, '');
    if (!content) return null;
    const icon = expanded ? ArrowDownIcon : hovered ? ArrowRightIcon : thinking ? Spinner : BrainIcon;
    // A glimpse of the thought, not just the word: each run's rows read as its story.
    const preview = !thinking && !expanded ? content.split('\n')[0].replace(/[*_`#>]/g, '').trim() : '';
    return (
        <div className={`thinking-block alphaino-thinking rounded-md display-flex flex-col min-w-0 ${expanded ? 'border-popup mb-2' : 'border-transparent'}`}>
            <div
                className={`display-flex flex-row py-15 ${expanded ? 'border-bottom-quinary bg-senary' : ''}`}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
            >
                <button
                    type="button"
                    className="alphaino-row-button display-flex flex-row cursor-pointer gap-2 w-full text-left min-w-0"
                    aria-expanded={expanded}
                    aria-controls={`thinking-content-${id}`}
                    onClick={() => setExpanded(!expanded)}
                >
                    <div className="display-flex flex-row px-3 gap-2 min-w-0">
                        <div className={`flex-1 display-flex mt-010 ${expanded ? 'font-color-primary' : ''}`}>
                            <Icon icon={icon} />
                        </div>
                        <div className={`display-flex flex-shrink-0 ${expanded ? 'font-color-primary' : ''} ${thinking ? 'alphaino-shimmer' : ''}`}>
                            {thinking ? t('Thinking') : t('Thoughts')}
                        </div>
                        {preview ? <div className="display-flex truncate font-color-tertiary min-w-0">{preview}</div> : null}
                    </div>
                </button>
                <div className="flex-1" />
            </div>
            {expanded ? (
                <div className="opacity-70 p-3 text-sm alphaino-thinking-text" id={`thinking-content-${id}`}>
                    <Markdown app={plugin.app} text={prepareAnswerMarkdown(content)} sourcePath="" />
                </div>
            ) : null}
        </div>
    );
}

/** Each tool's own icon once it is done, as AlphainZ's TOOL_ICONS gives them (AlphainZ's tools keep theirs after the prefix). */
const TOOL_ICONS: Record<string, React.FC<React.SVGProps<SVGSVGElement>>> = {
    search_vault_fulltext: SearchIcon,
    note_search_by_topic: SearchIcon,
    note_search_by_metadata: SearchIcon,
    item_search_by_topic: SearchIcon,
    item_search_by_metadata: SearchIcon,
    search_library_fulltext: SearchIcon,
    search_by_topic: SearchIcon,
    search_by_metadata: SearchIcon,
    search_in_note: SearchIcon,
    search_in_document: SearchIcon,
    read_note: TextAlignLeftIcon,
    read_document: TextAlignLeftIcon,
    read_attachment: TextAlignLeftIcon,
    list_notes: TextAlignLeftIcon,
    list_items: TextAlignLeftIcon,
    get_active_note: FileViewIcon,
    list_folders: FolderDetailIcon,
    list_collections: FolderDetailIcon,
    list_tags: TagIcon,
    get_note_metadata: FileViewIcon,
    get_metadata: FileViewIcon,
    get_item_details: FileViewIcon,
    get_note_links: LinkIcon,
    get_comments: ChattingIcon,
    find_comments: ChattingIcon,
    add_comment: ChattingIcon,
    reply_to_comment: ChattingIcon,
    resolve_comment: ChattingIcon,
    get_annotations: HighlighterIcon,
    find_annotations: HighlighterIcon,
    view_page_images: ViewIcon,
    view_attachment_image: ViewIcon,
    view_vault_image: ViewIcon,
    search_vault_images: SearchIcon,
    search_library_figures: SearchIcon,
    edit_note: PropertyEditIcon,
    create_note: DocumentValidationIcon,
};

function toolIcon(name: string): React.FC<React.SVGProps<SVGSVGElement>> {
    const own = name.startsWith('zotero_') ? name.slice('zotero_'.length) : name;
    return TOOL_ICONS[own] ?? PuzzleIcon;
}

/** Whether a result has nothing to show when opened: an error, or a search that found nothing. */
function emptyResult(result: ToolReturnPart): boolean {
    const content = result.content as Record<string, unknown> | string | null;
    if (result.outcome !== undefined && result.outcome !== 'success') return true;
    if (!content || typeof content !== 'object') return !content;
    if ('error' in content) return true;
    for (const name of ['hits', 'matches', 'items', 'threads', 'folders', 'tags']) {
        const list = (content as Record<string, unknown>)[name];
        if (Array.isArray(list)) return list.length === 0;
    }
    return false;
}

/**
 * One tool call, as AlphainZ's ToolCallPartView draws it: a spinner while it
 * runs (an alert once the run stopped or failed under it), the tool's own icon
 * when done, an arrow on hover when there is something to open; a failed call
 * or an empty search does not open.
 */
export function ToolCallRow({ part, result, plugin, runStatus }: { part: ToolCallPart; result: ToolReturnPart | undefined; plugin: AlphainOPlugin; runStatus: AgentRun['status'] }) {
    const [expanded, setExpanded] = useState(false);
    const [hovered, setHovered] = useState(false);
    const failed = result?.outcome !== undefined && result.outcome !== 'success';
    const status: ToolCallStatus = !result ? 'in_progress' : failed ? 'error' : 'completed';
    const inProgress = status === 'in_progress';
    const cutOff = inProgress && (runStatus === 'canceled' || runStatus === 'error');
    const canExpand = Boolean(result) && !emptyResult(result as ToolReturnPart);
    const open = expanded && canExpand;
    const icon = cutOff ? AlertIcon : inProgress ? Spinner : failed ? AlertIcon : open ? ArrowDownIcon : hovered && canExpand ? ArrowRightIcon : toolIcon(part.tool_name);
    const label = part.progress && inProgress && !cutOff ? part.progress : toolLabel(part, status);
    const shimmering = inProgress && runStatus === 'in_progress';
    // AlphainZ's label colour: the open row is primary, a row that cannot open stays secondary, and a row that
    // can takes the button's colour, which brightens on hover like the thinking row's.
    const labelColor = open ? 'font-color-primary' : canExpand ? '' : 'font-color-secondary';
    // The same frame as the thinking row and AlphainZ's ToolCallPartView (a py-15 row, the icon and label in a
    // px-3 group), so every step in a fold starts at the same edge.
    return (
        <div className={`alphaino-tool rounded-md display-flex flex-col min-w-0 ${open ? 'border-popup mb-2' : 'border-transparent'}`}>
            <div
                className={`display-flex flex-row py-15 ${open ? 'border-bottom-quinary bg-senary' : ''}`}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
            >
                <button
                    type="button"
                    className={`alphaino-row-button display-flex flex-row gap-2 w-full text-left min-w-0 ${canExpand ? 'cursor-pointer' : 'is-static'}`}
                    aria-expanded={canExpand ? open : undefined}
                    disabled={!canExpand}
                    onClick={() => canExpand && setExpanded(!expanded)}
                >
                    <div className="display-flex flex-row px-3 gap-2 min-w-0">
                        <div className={`flex-1 display-flex mt-010 ${failed || cutOff ? 'font-color-red' : labelColor}`}>
                            <Icon icon={icon} />
                        </div>
                        <div className={`min-w-0 truncate ${labelColor} ${shimmering ? 'alphaino-shimmer' : ''}`}>{label}</div>
                    </div>
                </button>
                <div className="flex-1" />
            </div>
            {open && result ? <ToolResultBody result={result} plugin={plugin} /> : null}
        </div>
    );
}

/** The list a result is mostly about, under whichever name the tool gives it. */
const RESULT_LISTS = ['hits', 'matches', 'items', 'threads', 'folders', 'tags', 'backlinks', 'links_out'] as const;

/** A note row's link target (`Folder/Note#Heading`), from its `link` or `note_id`. */
function rowTarget(row: Record<string, unknown>): string {
    const link = typeof row.link === 'string' ? row.link : '';
    const inner = /^\[\[([^\]|]+)/.exec(link)?.[1];
    if (inner) return inner;
    return String(row.note_id ?? row.path ?? '');
}

/** A tool's result, shown when its row is opened: the notes it found as links, anything else as text. */
function ToolResultBody({ result, plugin }: { result: ToolReturnPart; plugin: AlphainOPlugin }) {
    const content = result.content as Record<string, unknown> | string | null;
    const listName = content && typeof content === 'object' ? RESULT_LISTS.find((name) => Array.isArray((content as Record<string, unknown>)[name])) : undefined;
    const rows = listName ? ((content as Record<string, unknown>)[listName] as Array<Record<string, unknown>>) : null;
    if (rows && rows.length > 0 && rows.some((row) => row && (row.link || row.note_id || row.path))) {
        return (
            <ul className="alphaino-tool-hits">
                {rows.map((row, index) => {
                    const target = rowTarget(row);
                    const title = String(row.title ?? (target.split('#')[0].split('/').pop() || target));
                    const heading = row.heading ? String(row.heading) : target.includes('#') ? target.slice(target.indexOf('#') + 1) : '';
                    const lines = row.start_line ? ` · ${row.start_line}${row.end_line && row.end_line !== row.start_line ? `–${row.end_line}` : ''}` : row.line ? ` · ${row.line}` : '';
                    return (
                        <li key={index}>
                            <a
                                className="internal-link"
                                data-href={target}
                                onClick={(event) => {
                                    event.preventDefault();
                                    void plugin.app.workspace.openLinkText(target, '', false);
                                }}
                            >
                                {title}
                            </a>
                            {heading ? <span className="font-color-tertiary"> › {heading}</span> : null}
                            {lines ? <span className="font-color-tertiary">{lines}</span> : null}
                        </li>
                    );
                })}
            </ul>
        );
    }
    // Items from the Zotero library (AlphainZ's tools): title, who and when, each opening in Zotero.
    if (rows && rows.length > 0 && rows.some((row) => row && (typeof row.zotero_uri === 'string' || typeof row.open_uri === 'string'))) {
        return (
            <ul className="alphaino-tool-hits">
                {rows.map((row, index) => {
                    const uri = String(row.open_uri ?? row.zotero_uri ?? '');
                    const title = String(row.title ?? row.name ?? row.item_id ?? uri);
                    const who = zoteroByline(row);
                    return (
                        <li key={index}>
                            <a className="external-link" href={uri} target="_blank" rel="noopener">
                                {title}
                            </a>
                            {who ? <span className="font-color-tertiary"> · {who}</span> : null}
                        </li>
                    );
                })}
            </ul>
        );
    }
    // Anything else as AlphainZ shows it in a release build: what it says in a line, never raw data.
    return <div className="alphaino-tool-result">{resultSummary(content)}</div>;
}

/** "Smith, Lee · 2004" from a Zotero item's creators and year. */
function zoteroByline(row: Record<string, unknown>): string {
    const people = Array.isArray(row.creators) ? row.creators : Array.isArray(row.authors) ? row.authors : [];
    const names = people
        .map((person) => (typeof person === 'string' ? person : person && typeof person === 'object' ? String((person as Record<string, unknown>).lastName ?? (person as Record<string, unknown>).name ?? '') : ''))
        .filter(Boolean);
    const who = names.length > 2 ? `${names[0]} et al.` : names.join(', ');
    const year = row.year ?? (typeof row.date === 'string' ? /\d{4}/.exec(row.date)?.[0] : undefined);
    return [who, year ? String(year) : ''].filter(Boolean).join(' · ');
}

/** A tool result in a line or a short text: its message, its error, how many it found, or the text it returned. */
export function resultSummary(content: unknown): string {
    if (typeof content === 'string') return content.length > 1200 ? `${content.slice(0, 1200)}…` : content;
    if (content && typeof content === 'object' && !Array.isArray(content)) {
        const record = content as Record<string, unknown>;
        for (const key of ['error', 'message', 'summary', 'status', 'result']) {
            if (typeof record[key] === 'string' && (record[key] as string).trim()) return (record[key] as string).trim();
        }
        const list = Object.values(record).find(Array.isArray) as unknown[] | undefined;
        if (list) {
            if (list.every((value) => typeof value === 'string')) return list.length > 0 ? list.slice(0, 40).join(', ') + (list.length > 40 ? '…' : '') : t('No results');
            return tn(list.length, '{count} result', '{count} results');
        }
    }
    if (Array.isArray(content)) return tn(content.length, '{count} result', '{count} results');
    return t('Tool results not available');
}

export interface Suggestion {
    text: string;
    query: string;
}

export function suggestionsOf(part: ToolCallPart): Suggestion[] {
    const raw = argsOf(part).suggestions;
    if (!Array.isArray(raw)) return [];
    return raw
        .map((item) => ({ text: String((item as any)?.text ?? '').trim(), query: String((item as any)?.query ?? (item as any)?.text ?? '').trim() }))
        .filter((item) => item.text && item.query)
        .slice(0, 3);
}

/**
 * Follow-up questions under the last answer, as AlphainZ's SuggestionsView:
 * a "Next steps" heading that can be dismissed, one full-width button each.
 */
export function SuggestionChips({ suggestions, onAsk, disabled, onDismiss }: { suggestions: Suggestion[]; onAsk: (query: string) => void; disabled?: boolean; onDismiss?: () => void }) {
    if (suggestions.length === 0) return null;
    return (
        <div className="display-flex flex-col gap-2 pt-3 alphaino-suggestions">
            <div className="display-flex flex-row items-center justify-between gap-2">
                <div className="font-color-tertiary text-xs font-semibold uppercase" style={{ letterSpacing: '0.05em' }}>
                    {t('Next steps')}
                </div>
                {onDismiss ? <IconButton icon={CancelIcon} onClick={onDismiss} ariaLabel={t('Dismiss suggestions')} variant="ghost-secondary" className="scale-80" /> : null}
            </div>
            <div className="display-flex flex-col gap-1">
                {suggestions.map((suggestion, index) => (
                    <Button
                        key={index}
                        variant="surface-light"
                        className="truncate text-left w-full"
                        style={{ display: 'block' }}
                        onClick={() => {
                            if (!disabled) onAsk(suggestion.query);
                        }}
                        disabled={disabled}
                    >
                        {suggestion.text}
                    </Button>
                ))}
            </div>
        </div>
    );
}

/** A warning's tone, as AlphainZ's `warningTone` sorts them: a quiet notice, a warning about the answer, or a change that failed. */
export function warningTone(type: string): 'notice' | 'warning' | 'error' {
    if (type === 'semantic_search_unavailable') return 'notice';
    if (type === 'write_failed') return 'error';
    return 'warning';
}

/** The warnings whose text points at a setting (AlphainZ links them to its Model and Advanced tabs). */
const SETTINGS_WARNINGS = new Set(['semantic_search_unavailable', 'semantic_search_failed', 'output_limit', 'iteration_limit']);

/** Text with its line breaks kept. */
function withLineBreaks(text: string): React.ReactNode {
    const lines = text.split('\n');
    return lines.map((line, index) => (
        <React.Fragment key={index}>
            {index > 0 ? <br /> : null}
            {line}
        </React.Fragment>
    ));
}

/**
 * A warning that came with an answer, as AlphainZ's RunWarningDisplay: the
 * answer is still there. A notice is a quiet line, a warning about the answer
 * a box with an orange mark, a change that could not be applied an error box;
 * each can be dismissed, and those about a setting link to the settings.
 */
export function RunWarningRow({ warning, onDismiss, onOpenSettings }: { warning: RunWarning; onDismiss: () => void; onOpenSettings: () => void }) {
    const tone = warningTone(warning.type);
    const link = SETTINGS_WARNINGS.has(warning.type) ? (
        <button type="button" className={`${tone === 'notice' ? 'text-link-muted' : 'text-link'} text-sm alphaino-plain-button`} style={{ padding: 0 }} onClick={onOpenSettings}>
            {t('Open Settings')}
        </button>
    ) : null;
    if (tone === 'notice') {
        return (
            <div className="display-flex flex-row gap-2 items-start font-color-tertiary" role="note" data-warning-tone="notice">
                <Icon icon={InformationCircleIcon} className="scale-90 mt-010 flex-shrink-0" />
                <div className="text-sm flex-1 min-w-0">
                    {withLineBreaks(warning.message)}
                    {link ? <> {link}</> : null}
                </div>
                <IconButton
                    variant="ghost-tertiary"
                    icon={CancelIcon}
                    className="scale-85"
                    ariaLabel={t('Hide this notice for the rest of the session')}
                    aria-label={t('Hide for the rest of the session')}
                    onClick={onDismiss}
                />
            </div>
        );
    }
    const isError = tone === 'error';
    return (
        <div
            className={`display-flex flex-col p-3 gap-3 rounded-lg ${isError ? 'border-error' : 'bg-quinary'}`}
            style={isError ? { background: 'var(--tag-red-quinary)' } : { boxShadow: 'inset 3px 0 0 var(--tag-orange-secondary)' }}
            data-warning-tone={tone}
        >
            <div className={`${isError ? 'font-color-red' : 'font-color-secondary'} display-flex flex-row gap-3 items-start`}>
                <Icon icon={AlertIcon} className={`scale-11 mt-020 flex-shrink-0 ${isError ? 'font-color-red' : 'font-color-orange'}`} />
                <div className="display-flex flex-col flex-1 gap-2 min-w-0">
                    <div className="display-flex flex-row gap-2 items-start">
                        <div className="display-flex flex-col gap-1 min-w-0">
                            <div className="text-base">{withLineBreaks(warning.message)}</div>
                            {link ? <div>{link}</div> : null}
                        </div>
                        <div className="flex-1" />
                        <IconButton variant="ghost-secondary" icon={CancelIcon} className="mr-1 scale-90 mt-015" ariaLabel={t('Dismiss this warning')} onClick={onDismiss} />
                    </div>
                </div>
            </div>
        </div>
    );
}

/** A note or Zotero item an answer cites: its link target and what to call it. */
export interface CitedSource {
    kind: 'note' | 'zotero';
    target: string;
    title: string;
}

/** The notes ([[links]]) and Zotero items (zotero:// links) an answer cites, each once, in order of first mention. */
export function citedSources(answer: string): CitedSource[] {
    const seen = new Set<string>();
    const sources: CitedSource[] = [];
    const pattern = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]|\[([^\]]+)\]\((zotero:\/\/[^)\s]+)\)/g;
    for (const match of answer.matchAll(pattern)) {
        if (match[1]) {
            const target = match[1].trim();
            if (!target || seen.has(`note:${target}`)) continue;
            seen.add(`note:${target}`);
            sources.push({ kind: 'note', target: `${target}${match[2] ?? ''}`, title: target.slice(target.lastIndexOf('/') + 1) });
        } else if (match[5]) {
            const url = match[5];
            const key = url.replace(/[?#].*$/, '');
            if (seen.has(`zotero:${key}`)) continue;
            seen.add(`zotero:${key}`);
            sources.push({ kind: 'zotero', target: url, title: match[4] });
        }
    }
    return sources;
}

function CopyAnswerButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <IconButton
            icon={copied ? TickIcon : CopyIcon}
            className="scale-11"
            variant="ghost"
            ariaLabel={t('Copy')}
            onClick={(event) => {
                event.stopPropagation();
                void navigator.clipboard.writeText(text).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 600);
                });
            }}
        />
    );
}

/**
 * Under an answer, as AlphainZ has it: the sources it cites (folded), then
 * More (copy, save as a note, put it into the open note, copy the message's
 * id), Retry, and Copy.
 */
export function RunFooter(props: {
    plugin: AlphainOPlugin;
    run: AgentRun;
    answer: string;
    /** How many questions come after this one: a retry removes them. */
    laterCount: number;
    onRetry?: () => void;
}) {
    const { plugin, run, answer, laterCount, onRetry } = props;
    const [sourcesOpen, setSourcesOpen] = useState(false);
    const sources = useMemo(() => citedSources(answer), [answer]);
    const question = run.user_prompt?.content ?? '';
    const noteText = () => {
        const sections: string[] = [];
        if (question) sections.push(`## ${t('User')}\n\n> ${question.replace(/\n/g, '\n> ')}`);
        sections.push(`## AlphainO\n\n${answer}`);
        return sections.join('\n\n---\n\n');
    };
    const retryLabel = laterCount > 0
        ? tn(laterCount, 'Retry from here — removes the later message', 'Retry from here — removes the {count} later messages')
        : t('Retry');
    const menuItems = [
        // As AlphainZ copies an answer: its text and a line for each step it took.
        { label: t('Copy'), onClick: () => void navigator.clipboard.writeText(answerWithSteps(run) || answer).then(() => new Notice(t('Copied'))) },
        { label: t('Save as note'), onClick: () => void plugin.saveAnswerAsNote(question, noteText()), disabled: !answer },
        { label: t('Insert into the open note'), onClick: () => plugin.insertIntoOpenNote(answer), disabled: !answer },
        {
            label: t('Copy link to message'),
            onClick: () => void navigator.clipboard.writeText(plugin.chatLink(run.thread_id ?? '', run.id)).then(() => new Notice(t('Copied'))),
            disabled: !run.thread_id,
        },
        { label: t('Copy message ID'), onClick: () => void navigator.clipboard.writeText(run.id).then(() => new Notice(t('Copied'))) },
    ];
    const usage = run.total_usage as { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number } | undefined;
    const tokens = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_tokens ?? 0) : 0;
    return (
        <div className="alphaino-run-footer">
            <div className="display-flex flex-row items-center pt-2">
                <div className="flex-1 display-flex flex-row items-center gap-2 min-w-0">
                    {sources.length > 0 ? (
                        <Button
                            variant="ghost"
                            onClick={() => setSourcesOpen(!sourcesOpen)}
                            icon={sourcesOpen ? ArrowDownIcon : ArrowRightIcon}
                            iconClassName="mr-0 scale-12 -ml-1"
                        >
                            <span>{tn(sources.length, '{count} Source', '{count} Sources')}</span>
                        </Button>
                    ) : null}
                    <span className="font-color-tertiary text-xs truncate alphaino-run-model">
                        {[run.model_name, tokens > 0 ? t('{count} tokens', { count: tokens.toLocaleString() }) : ''].filter(Boolean).join(' · ')}
                    </span>
                </div>
                <div className="display-flex gap-4 items-center">
                    <MenuButton
                        icon={MoreHorizontalIcon}
                        iconClassName="scale-12"
                        menuItems={menuItems}
                        className="scale-11"
                        width="max-content"
                        maxWidth="min(22rem, calc(100vw - 16px))"
                        ariaLabel={t('Share')}
                        variant="ghost"
                        positionAdjustment={{ x: 0, y: 0 }}
                        tooltipContent={t('More options')}
                    />
                    {onRetry ? (
                        <Tooltip content={retryLabel} showArrow>
                            <IconButton icon={RepeatIcon} onClick={() => onRetry()} className="scale-11" ariaLabel={retryLabel} />
                        </Tooltip>
                    ) : null}
                    {answer ? (
                        <Tooltip content={t('Copy')} showArrow>
                            <CopyAnswerButton text={answer} />
                        </Tooltip>
                    ) : null}
                </div>
            </div>
            {sourcesOpen ? (
                <ul className="alphaino-sources">
                    {sources.map((source) => (
                        <li key={`${source.kind}:${source.target}`}>
                            <Icon icon={source.kind === 'note' ? NoteIcon : BookIcon} className="font-color-secondary" />
                            <a
                                className={source.kind === 'note' ? 'internal-link' : 'external-link'}
                                data-href={source.kind === 'note' ? source.target : undefined}
                                href={source.kind === 'zotero' ? source.target : undefined}
                                onClick={(event) => {
                                    if (source.kind !== 'note') return;
                                    event.preventDefault();
                                    void plugin.app.workspace.openLinkText(source.target, '', false);
                                }}
                            >
                                {source.title}
                            </a>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

/** Errors whose fix is in the model settings: the card offers to open them (AlphainZ's MODEL_SETTINGS_ERROR_TYPES). */
const MODEL_SETTINGS_ERROR_TYPES = new Set([
    'not_configured',
    'model_requires_api_key',
    'llm_auth_error',
    'llm_model_access_denied',
    'llm_invalid_model',
    'llm_insufficient_credits',
    'llm_quota_exceeded',
]);

/** Text with its line breaks kept and its web addresses clickable. */
function textWithLinks(text: string): React.ReactNode {
    return text.split('\n').map((line, index, lines) => (
        <React.Fragment key={index}>
            {line.split(/(https?:\/\/[^\s)]+)/g).map((piece, i) =>
                /^https?:\/\//.test(piece) ? (
                    <a key={i} className="text-link-red" href={piece} target="_blank" rel="noopener">
                        {piece}
                    </a>
                ) : (
                    <React.Fragment key={i}>{piece}</React.Fragment>
                ),
            )}
            {index < lines.length - 1 ? <br /> : null}
        </React.Fragment>
    ));
}

/**
 * A failed answer, as AlphainZ's RunErrorDisplay shows it: a red card with
 * the error's title, open on the last run only, the message and its reason,
 * and (on the last run) Open Settings → Model for a key or model problem and
 * Retry, which asks the same question again in place.
 */
export function RunErrorCard(props: {
    run: AgentRun;
    isLastRun: boolean;
    onRetry?: () => void;
    onOpenSettings: () => void;
}) {
    const { run, isLastRun, onRetry, onOpenSettings } = props;
    const error = run.error;
    const [expanded, setExpanded] = useState(isLastRun);
    const [hovered, setHovered] = useState(false);
    const [openedSettings, setOpenedSettings] = useState(false);
    if (!error) return null;
    const message = stripRunErrorTypePrefix(error.message ?? '', error.type);
    const title = getRunErrorTitle(error.type);
    const canOpenSettings = isLastRun && MODEL_SETTINGS_ERROR_TYPES.has(error.type ?? '');
    // An error that does not say whether it is retryable keeps its Retry.
    const canRetry = Boolean(onRetry) && isLastRun && (error.is_retryable !== false || (canOpenSettings && openedSettings));
    return (
        <div className="user-select-text alphaino-run-error">
            <div className={`rounded-md flex flex-col min-w-0 border-error ${expanded ? 'mb-2' : ''}`} style={{ background: 'var(--tag-red-quinary)' }}>
                <div
                    className="display-flex flex-row py-15"
                    style={{ borderBottom: expanded ? '1px solid var(--tag-red-quarternary)' : 'none' }}
                    onMouseEnter={() => setHovered(true)}
                    onMouseLeave={() => setHovered(false)}
                >
                    <button
                        type="button"
                        className="variant-ghost-secondary display-flex flex-row py-15 cursor-pointer gap-2 w-full text-left alphaino-plain-button"
                        aria-expanded={expanded}
                        onClick={() => setExpanded(!expanded)}
                    >
                        <div className="display-flex flex-row px-3 gap-2">
                            <div className="display-flex mt-010 font-color-red">
                                <Icon icon={hovered ? (expanded ? ArrowDownIcon : ArrowRightIcon) : AlertIcon} />
                            </div>
                            <div className="display-flex font-color-red font-medium">{title}</div>
                        </div>
                    </button>
                </div>
                {expanded ? (
                    <div className="p-3">
                        <div className="display-flex flex-col gap-4">
                            <div className="display-flex flex-col gap-1">
                                <div className="text-base font-color-red">{textWithLinks(message)}</div>
                                {error.user_facing_details ? (
                                    <div className="text-base font-color-red user-select-text" style={{ opacity: 0.75 }}>
                                        {textWithLinks(
                                            error.type === 'connection_error'
                                                ? t('Connection details: {details}', { details: error.user_facing_details })
                                                : t('Reason: {details}', { details: error.user_facing_details }),
                                        )}
                                    </div>
                                ) : null}
                            </div>
                            {canOpenSettings || canRetry ? (
                                <div className="display-flex flex-row gap-3 items-center">
                                    <div className="flex-1" />
                                    {canOpenSettings ? (
                                        <Button
                                            variant="error"
                                            iconClassName="font-color-red"
                                            rightIcon={SettingsIcon}
                                            onClick={() => {
                                                setOpenedSettings(true);
                                                onOpenSettings();
                                            }}
                                        >
                                            <span className="font-color-red">{t('Open Settings → Model')}</span>
                                        </Button>
                                    ) : null}
                                    {canRetry ? (
                                        <Button variant="error" iconClassName="font-color-red" rightIcon={RepeatIcon} onClick={() => onRetry?.()}>
                                            <span className="font-color-red">{t('Retry')}</span>
                                        </Button>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

/** After this long a wait shows its seconds (AlphainZ's COUNT_AFTER_MS). */
const COUNT_AFTER_MS = 8000;
/** A stream quiet this long counts as waiting (agent-core's streamActivity). */
const QUIET_MS = 1000;

/**
 * The status line while an answer is being waited for, as AlphainZ's
 * RunStatusIndicator: a spinner and a shimmering "Generating", with the seconds
 * after a while, or "Retrying…". Shown only when agent-core's
 * `shouldShowRunStatus` says so: nothing is on screen yet, or the stream has
 * gone quiet and no tool is running and the model is not thinking.
 */
export function RunStatusRow(props: { run: AgentRun; results: Map<string, ToolReturnPart>; lastEventAt: number; retrying: string | null }) {
    const { run, results, lastEventAt, retrying } = props;
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (run.status !== 'in_progress') return;
        const timer = window.setInterval(() => setNow(Date.now()), 500);
        return () => window.clearInterval(timer);
    }, [run.status]);
    const quiet = now - lastEventAt >= QUIET_MS;
    if (!retrying && !shouldShowRunStatus(run, results, { isStreamQuiet: quiet })) return null;
    const elapsed = Math.max(0, Math.floor((now - lastEventAt) / 1000));
    const text = retrying
        ? t('Retrying…')
        : runStatusText({ reconnect: null, backendRetry: null, idleLabel: t('Generating'), elapsedSeconds: now - lastEventAt >= COUNT_AFTER_MS ? elapsed : null });
    return (
        <div className="rounded-md flex flex-col min-w-0 border-transparent alphaino-run-status">
            <div className="display-flex flex-row py-15">
                <div className="display-flex flex-row gap-2 items-center" aria-busy="true">
                    <span className="display-flex font-color-secondary">
                        <Icon icon={Spinner} />
                    </span>
                    <span className="alphaino-shimmer font-color-secondary" aria-hidden="true">
                        {text}
                    </span>
                    <span className="sr-only" aria-live="polite">
                        {retrying ? t('Retrying…') : t('Generating')}
                    </span>
                </div>
            </div>
        </div>
    );
}
