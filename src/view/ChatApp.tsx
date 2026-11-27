/**
 * The chat in the right sidebar: one conversation at a time, the answer
 * streaming in as Obsidian-rendered Markdown, a history of past conversations,
 * and the composer.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Menu, Notice } from 'obsidian';
import type { AgentRun, ThinkingPart, ToolReturnPart } from '@beaver/agent-core/agents/types';
import { generateThreadTitle } from '@beaver/agent-llm/threadTitle';
import { isInterruptedRun } from '@beaver/agent-core/run-state/runResumeHelpers';
import {
    ConversationRail,
    attachReadingRoom,
    clearReadingRoom,
    detachReadingRoom,
    endWheelTurn,
    flashQuestion,
    holdReadingScroll,
    isLaidOut,
    jumpToRun,
    noteReaderInput,
    sameTurns,
    settleReadingRoom,
    type ConversationTurn,
} from '@beaver/agent-ui/conversation';
import type AlphainOPlugin from '../main';
import type { Conversation } from '../store/conversations';
import { answerText, newRun, runTurn, type RunWarning, type TurnState } from '../agent/runTurn';
import { PANDA_ICON } from '../icon';
import { t, tn } from '../i18n';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { ModelButton } from './ModelButton';
import { TextareaComposer } from '@beaver/agent-ui/composer/TextareaComposer';
import { useAddSourcesMenu, type AddSourcesMenuHandle } from '@beaver/agent-ui/composer/useAddSourcesMenu';
import Button from '@beaver/agent-ui/primitives/Button';
import { selectedModel } from '../agent/models';
import {
    RunErrorCard,
    RunFooter,
    RunStatusRow,
    RunWarningRow,
    STREAM_DISPLAY_HINTS,
    STREAM_DISPLAY_LABELS,
    STREAM_DISPLAY_MODES,
    SUGGESTIONS_TOOL,
    SuggestionChips,
    ThinkingRow,
    ToolCallRow,
    WRITE_TOOLS,
    WorkStreamFold,
    readStreamDisplay,
    suggestionsOf,
    toolBaseName,
    warningTone,
    type StreamDisplayMode,
    type Suggestion,
} from './parts';
import { groupStreamUnits, planRunStream, summarizeGroup, type StreamUnit } from '@beaver/agent-ui/conversation/workStream';
import { buildTurns } from './turns';
import { prepareAnswerMarkdown } from './markdownFixes';
import { attachedNotesOf, imagesOf, openNoteOf, quoteOf, type AttachedImage, type QuestionContext, type Quote } from '../agent/quote';
import { AlertCircleIcon, AlertIcon, ArrowDownIcon, RepeatIcon, BulletListIcon, CancelIcon, ChattingIcon, HighlighterIcon, EditIcon, Icon as SharedIcon, MoreHorizontalIcon, PlusSignIcon, SettingsIcon, StopIcon, ViewIcon } from '@beaver/agent-ui/icons';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { questionCountLabel } from '@beaver/agent-ui/conversation/turns';
import { ConversationOutline } from './ConversationOutline';
import { ThreadListPanel } from './ThreadListPanel';
import { RecentChats } from './RecentChats';
import { IndexStatusButton } from './IndexStatusButton';
import { EMPTY_DRAFT, draftKey, type ChatDraft } from './drafts';
import { confirmInModal, promptInModal } from '../settings/confirm';
import { chatMarkdown } from './chatContent';
import type { EditorContextSnapshot, EditorSelection } from '../context/editorContext';
import { AddNotesButton, ImageChip, MAX_SHOWN_NOTES, NoteChip, OverflowChip, SelectionChip } from './chips';

/** Input tokens a chat must resend with every message before it counts as long (AlphainZ's LONG_CHAT_INPUT_TOKENS). */
const LONG_CHAT_INPUT_TOKENS = 100_000;

/**
 * What the chat resends with every message, when that makes it long: the first request of the newest answer
 * (instructions, history and the question), as AlphainZ measures it; null otherwise.
 */
function longChatInputTokens(run: AgentRun | undefined): number | null {
    const usage = run?.total_usage as { model_requests?: Array<{ input_tokens?: number }>; requests?: number; input_tokens?: number } | undefined;
    if (!usage) return null;
    const first = usage.model_requests?.[0]?.input_tokens ?? (usage.requests === 1 ? usage.input_tokens : undefined);
    return typeof first === 'number' && first > LONG_CHAT_INPUT_TOKENS ? first : null;
}

/** The answer itself, without the narration on the way to it (AlphainZ's finalAnswerText), else all of its text. */
function finalAnswerText(run: AgentRun): string {
    const units = planRunStream(run.model_messages, () => false, { writeTools: WRITE_TOOLS }).filter((unit) => unit.role === 'answer');
    const text = units
        .flatMap((unit) => {
            const message = run.model_messages[unit.messageIndex];
            return message && message.kind === 'response' ? message.parts.filter((part) => part && part.part_kind === 'text').map((part) => (part as { content: string }).content) : [];
        })
        .join('\n\n')
        .trim();
    return text || answerText(run);
}

/** How often an answer being written is saved, so quitting Obsidian loses at most this much of it. */
const AUTOSAVE_MS = 8_000;

/**
 * A conversation as read from its file, with any answer still marked as being written — Obsidian closed (or
 * the computer slept) before it finished — shown as interrupted, as AlphainZ shows a run the client left.
 * Only the view changes; the file keeps what was saved until the chat is next saved.
 */
function withInterruptedRuns(conversation: Conversation): Conversation {
    if (!conversation.runs.some((run) => run.status === 'in_progress' || run.status === 'awaiting_deferred')) return conversation;
    return {
        ...conversation,
        runs: conversation.runs.map((run) =>
            run.status === 'in_progress' || run.status === 'awaiting_deferred'
                ? ({
                      ...run,
                      status: 'canceled',
                      error: { type: 'interrupted', message: 'Obsidian closed before this response finished.', reason_code: 'client_closed' },
                  } as AgentRun)
                : run,
        ),
    };
}

/** A passage's question and answer as a comment, as AlphainZ writes them into a highlight's comment. */
function commentEntry(question: string, answer: string): string {
    return `— AlphainO\nQ: ${question.trim()}\nA: ${answer.trim()}`;
}

/** Text handed to the message box, after what the user had already written there (which is never dropped). */
function addToDraft(draft: string, text: string): string {
    return draft.trim() ? `${draft.trimEnd()}\n${text}` : text;
}

/** Tokens as AlphainZ writes them: 950, 12.3k, 456k, 1.2M. */
function formatTokens(total: number): string {
    if (total < 1000) return String(total);
    if (total < 1_000_000) return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k`;
    return `${(total / 1_000_000).toFixed(1)}M`;
}

/** How far from the end the view may be before the scroll-down button shows (AlphainZ's BOTTOM_THRESHOLD). */
const BOTTOM_THRESHOLD = 120;

function blankConversation(): Conversation {
    const now = new Date().toISOString();
    return { id: crypto.randomUUID(), name: '', createdAt: now, updatedAt: now, runs: [] };
}

function shortDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A selection on offer, as the passage a question would carry. */
function selectionQuote(selection: EditorSelection): Quote {
    return { text: selection.text, path: selection.path, from: selection.fromLine, to: selection.toLine, ...(selection.page ? { page: selection.page } : {}) };
}

/** Identifies a selection, so a dismissed one stays dismissed until another is made. */
function selectionKey(selection: EditorSelection | null): string {
    return selection ? `${selection.path}\u0000${selection.from}\u0000${selection.to}\u0000${selection.text.length}` : '';
}

/** What a sent question carried, as chips at the top of it (AlphainZ's request chips). */
function RequestChips({ run, plugin }: { run: AgentRun; plugin: AlphainOPlugin }) {
    const note = openNoteOf(run.user_prompt);
    const notes = attachedNotesOf(run.user_prompt).filter((path) => path !== note);
    const quote = quoteOf(run.user_prompt);
    const images = imagesOf(run.user_prompt);
    if (!note && notes.length === 0 && !quote && images.length === 0) return null;
    const open = (path: string) => void plugin.openNote(path);
    return (
        <div className="alphaino-request-chips display-flex flex-wrap gap-col-3 gap-row-2 mb-2">
            {note ? <NoteChip path={note} current onOpen={open} /> : null}
            {notes.slice(0, MAX_SHOWN_NOTES).map((path) => (
                <NoteChip key={path} path={path} onOpen={open} />
            ))}
            <OverflowChip paths={notes.slice(MAX_SHOWN_NOTES)} />
            {images.map((image) => (
                <ImageChip key={image.path} image={image} source={plugin.app.vault.adapter.getResourcePath(image.path)} />
            ))}
            {quote ? <SelectionChip quote={quote} onReveal={(q) => void plugin.revealQuote(q)} /> : null}
        </div>
    );
}

/** How tall a question is shown before it fades out (AlphainZ's UserRequestView). */
const MAX_QUESTION_HEIGHT = 200;

/** A question's text, faded out at the bottom when it is long, as AlphainZ shows it. */
function QuestionText({ text }: { text: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const [fade, setFade] = useState(false);
    useLayoutEffect(() => {
        const el = ref.current;
        if (el) setFade(el.scrollHeight > MAX_QUESTION_HEIGHT);
    }, [text]);
    return (
        <div
            ref={ref}
            className={`user-select-text user-request-content border-transparent ${fade ? 'user-request-content-fade' : ''}`}
            style={{ maxHeight: `${MAX_QUESTION_HEIGHT}px`, overflow: 'hidden', whiteSpace: 'pre-wrap', display: 'block' }}
        >
            {text}
        </div>
    );
}

/**
 * A question as sent: its context chips and text. As in AlphainZ, a click
 * opens it for editing (with the chips above, the model button, Cancel and
 * Send ⏎ below); sending again replaces the answers after it.
 */
function QuestionBox(props: {
    plugin: AlphainOPlugin;
    run: AgentRun;
    canEdit: boolean;
    editing: boolean;
    onEdit?: (editing: boolean) => void;
    onResend?: (text: string) => void;
}) {
    const { plugin, run, canEdit, editing, onEdit, onResend } = props;
    const [hovered, setHovered] = useState(false);
    const [draft, setDraft] = useState('');
    const inputRef = useRef<HTMLElement | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const text = run.user_prompt?.content ?? '';
    // The editor opens with the caret at the end of the question.
    useLayoutEffect(() => {
        if (!editing) return;
        const el = inputRef.current as HTMLTextAreaElement | null;
        if (!el) return;
        el.focus();
        if (typeof el.setSelectionRange === 'function') el.setSelectionRange(el.value.length, el.value.length);
    }, [editing]);
    // As in AlphainZ, a click outside the editor (not in a menu) or scrolling it out of view closes it.
    useEffect(() => {
        if (!editing) return;
        const doc = containerRef.current?.ownerDocument;
        if (!doc) return;
        const outside = (event: MouseEvent) => {
            const target = event.target as Node;
            if (overlayRef.current?.contains(target)) return;
            if ((target as Element).closest?.('.context-menu, .search-menu, .dropdown-menu, [role="menu"], .menu, .modal-container')) return;
            onEdit?.(false);
        };
        doc.addEventListener('mousedown', outside, true);
        return () => doc.removeEventListener('mousedown', outside, true);
    }, [editing, onEdit]);
    useEffect(() => {
        const element = containerRef.current;
        const win = element?.ownerDocument.defaultView;
        if (!editing || !element || !win?.IntersectionObserver) return;
        const observer = new win.IntersectionObserver(
            ([entry]) => {
                if (!entry.isIntersecting) onEdit?.(false);
            },
            { root: element.closest('#alphainz-thread-view'), threshold: 0 },
        );
        observer.observe(element);
        return () => observer.disconnect();
    }, [editing, onEdit]);
    const submit = () => {
        const next = draft.trim();
        if (next || quoteOf(run.user_prompt) || imagesOf(run.user_prompt).length > 0) onResend?.(next);
    };
    return (
        <div className="alphaino-request relative" ref={containerRef}>
            <div
                id={`user-request-${run.id}`}
                className={`user-message-display user-request-view alphaino-user ${hovered && !editing && canEdit ? 'user-request-view-hover' : ''} ${editing ? 'user-request-view-editing' : ''}`}
                style={{ cursor: canEdit ? 'pointer' : 'default' }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onClick={(event) => {
                    if (event.button !== 0 || editing || !canEdit || !onEdit) return;
                    // A click that ends a text selection in the question is not a request to edit it.
                    if ((event.currentTarget.ownerDocument.getSelection()?.toString() ?? '') !== '') return;
                    setDraft(text);
                    onEdit(true);
                }}
            >
                <RequestChips run={run} plugin={plugin} />
                {text ? <QuestionText text={text} /> : null}
                {hovered && !editing && canEdit ? (
                    <div className="user-request-edit-icon mb-075">
                        <SharedIcon icon={EditIcon} />
                    </div>
                ) : null}
            </div>
            {editing ? (
                <div ref={overlayRef} className="user-request-edit-overlay user-message-display alphaino-user" onClick={(event) => event.stopPropagation()}>
                    <RequestChips run={run} plugin={plugin} />
                    <form
                        className="display-flex flex-col"
                        onSubmit={(event) => {
                            event.preventDefault();
                            submit();
                        }}
                    >
                        {/* The same editor as the message box (AlphainZ edits with its composer engine). */}
                        <div className="mb-2 -ml-1">
                            <TextareaComposer
                                value={draft}
                                onChange={setDraft}
                                onSubmit={submit}
                                placeholder={t('Edit your message...')}
                                ariaLabel={t('Edit message')}
                                onKeyDown={(event) => {
                                    if (event.key === 'Escape') {
                                        event.preventDefault();
                                        onEdit?.(false);
                                    }
                                }}
                                onContentEditableRef={(el) => {
                                    inputRef.current = el;
                                }}
                            />
                        </div>
                        <div className="display-flex flex-row items-center pt-2">
                            <ModelButton plugin={plugin} disabled={false} />
                            <div className="flex-1" />
                            <div className="display-flex flex-row items-center gap-4">
                                <Button type="button" variant="ghost" style={{ padding: '2px 5px' }} onClick={() => onEdit?.(false)}>
                                    {t('Cancel')}
                                </Button>
                                <Button type="submit" variant="solid" style={{ padding: '2px 5px' }} disabled={!draft.trim() && !quoteOf(run.user_prompt) && imagesOf(run.user_prompt).length === 0}>
                                    <span>
                                        {t('Send')} <span className="opacity-50">⏎</span>
                                    </span>
                                </Button>
                            </div>
                        </div>
                    </form>
                </div>
            ) : null}
        </div>
    );
}

function RunBlock(props: {
    plugin: AlphainOPlugin;
    run: AgentRun;
    warnings?: RunWarning[];
    onDismissWarning?: (warning: RunWarning) => void;
    retrying?: string | null;
    live?: boolean;
    /** The last run of the conversation offers its follow-up chips. */
    last?: boolean;
    onAsk?: (query: string) => void;
    /** Editing the question: whether it may be edited now, and what to do with the new text. */
    canEdit?: boolean;
    editing?: boolean;
    onEdit?: (editing: boolean) => void;
    onResend?: (text: string) => void;
    /** How many questions follow this one, and asking it again. */
    laterCount?: number;
    onRetry?: () => void;
    /** While live: when the last streamed event arrived (for the status line). */
    lastEventAt?: number;
    /** How much of the working steps to show (the eye menu). */
    mode?: StreamDisplayMode;
}) {
    const { plugin, run, warnings, onDismissWarning, retrying, live, last, onAsk, canEdit, editing, onEdit, onResend, laterCount, onRetry, lastEventAt, mode = 'collapsed' } = props;
    // The follow-up questions can be put away (AlphainZ's dismiss), for as long as the chat is open.
    const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
    const sourcePath = plugin.app.workspace.getActiveFile()?.path ?? '';
    const answer = answerText(run);

    // Each tool call's result, by call id, from the requests that carried them back.
    const results = new Map<string, ToolReturnPart>();
    for (const message of run.model_messages) {
        if (message.kind !== 'request') continue;
        for (const part of message.parts) {
            if (part.part_kind === 'tool-return') results.set(part.tool_call_id, part as ToolReturnPart);
        }
    }

    // The answer split as AlphainZ splits it (the shared planRunStream): the work that led to it (thinking, the
    // sentences on the way, the tool calls) and the answer itself. Work folds behind one line, per the eye menu.
    let suggestions: Suggestion[] = [];
    for (const message of run.model_messages) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts) {
            if (part && part.part_kind === 'tool-call' && part.tool_name === SUGGESTIONS_TOOL) suggestions = suggestionsOf(part);
        }
    }
    const lastResponseIndex = run.model_messages.reduce((found, message, index) => (message.kind === 'response' ? index : found), -1);
    const renderUnit = (unit: StreamUnit) => {
        const message = run.model_messages[unit.messageIndex];
        if (!message || message.kind !== 'response') return null;
        const parts = message.parts.filter(Boolean);
        const rows: React.ReactNode[] = [];
        if (unit.thinking) {
            const thinkingParts = parts.filter((part): part is ThinkingPart => part.part_kind === 'thinking');
            // Still thinking: the newest message of a live answer, with nothing after its thinking yet.
            const stillThinking = Boolean(live) && run.status === 'in_progress' && unit.messageIndex === lastResponseIndex && parts.every((part) => part.part_kind === 'thinking');
            rows.push(<ThinkingRow key="thinking" id={`${run.id}-${unit.key}`} parts={thinkingParts} thinking={stillThinking} plugin={plugin} />);
        }
        if (unit.text) {
            parts.forEach((part, index) => {
                if (part.part_kind === 'text' && part.content) rows.push(<Markdown key={`text-${index}`} app={plugin.app} text={prepareAnswerMarkdown(part.content)} sourcePath={sourcePath} />);
            });
        }
        if (unit.tools === 'settled') {
            parts.forEach((part, index) => {
                if (part.part_kind === 'tool-call' && part.tool_name !== SUGGESTIONS_TOOL) {
                    rows.push(<ToolCallRow key={`tool-${index}`} part={part} result={results.get(part.tool_call_id)} plugin={plugin} runStatus={run.status} />);
                }
            });
        }
        return rows.length > 0 ? <React.Fragment key={unit.key}>{rows}</React.Fragment> : null;
    };
    const groups = groupStreamUnits(planRunStream(run.model_messages, () => false, { streaming: Boolean(live), writeTools: WRITE_TOOLS }));
    const lastWorkGroupKey = [...groups].reverse().find((group) => group.kind === 'work')?.key;
    const blocks = groups.map((group) => {
        if (group.kind !== 'work') return <React.Fragment key={group.key}>{group.units.map(renderUnit)}</React.Fragment>;
        // The last stretch of work of an answer still coming is the one being done.
        const working = Boolean(live) && group.key === lastWorkGroupKey;
        // Answer only: everything while it works, then nothing but the answer.
        if (mode === 'answer') {
            if (!live) return null;
            return <div key={group.key} className="display-flex flex-col gap-1">{group.units.map(renderUnit)}</div>;
        }
        // One row is already one line: no fold for it.
        if (mode === 'expanded' || group.rows < 2) return <div key={group.key} className="display-flex flex-col gap-1">{group.units.map(renderUnit)}</div>;
        return (
            <WorkStreamFold key={group.key} streamId={`${run.id}:${group.key}`} summary={summarizeGroup(group, toolBaseName)} working={working}>
                <div className="display-flex flex-col gap-1">{group.units.map(renderUnit)}</div>
            </WorkStreamFold>
        );
    });

    return (
        <div className="alphaino-run" id={`run-${run.id}`}>
            <QuestionBox plugin={plugin} run={run} canEdit={Boolean(canEdit)} editing={Boolean(editing)} onEdit={onEdit} onResend={onResend} />
            <div className="alphaino-answer display-flex flex-col gap-1">
                {/* AlphainZ's one rhythm between the work and the answer (ModelMessagesView's gap-4). */}
                {blocks.some(Boolean) ? <div className="display-flex flex-col gap-4 alphaino-stream">{blocks}</div> : null}
                {live ? <RunStatusRow run={run} results={results} lastEventAt={lastEventAt ?? Date.now()} retrying={retrying ?? null} /> : null}
                {/* Warnings come right under the answer, before an error or interruption card (AlphainZ's AgentRunView). */}
                {(warnings ?? []).length > 0 ? (
                    <div className="display-flex flex-col gap-2">
                        {(warnings ?? []).map((warning) => (
                            <RunWarningRow key={warning.id} warning={warning} onDismiss={() => onDismissWarning?.(warning)} onOpenSettings={() => plugin.openSettings()} />
                        ))}
                    </div>
                ) : null}
                {run.status === 'error' && run.error ? (
                    <RunErrorCard run={run} isLastRun={Boolean(last) || Boolean(live)} onRetry={onRetry} onOpenSettings={() => plugin.openSettings()} />
                ) : null}
                {isInterruptedRun(run) ? (
                    // AlphainZ's RunInterruptedDisplay: nothing failed; the answer was cut off when Obsidian closed.
                    <div className="rounded-md display-flex flex-col min-w-0 p-3 gap-3 alphaino-interrupted" style={{ background: 'var(--fill-senary)', border: '1px solid var(--fill-quinary)' }}>
                        <div className="display-flex flex-row gap-2">
                            <div className="display-flex mt-010 font-color-secondary">
                                <SharedIcon icon={AlertCircleIcon} />
                            </div>
                            <div className="display-flex flex-col gap-1">
                                <div className="text-base font-color-primary font-medium">{t('Response interrupted')}</div>
                                <div className="text-base font-color-secondary">{t('Obsidian closed before this response finished.')}</div>
                            </div>
                        </div>
                        {last && onRetry ? (
                            <div className="display-flex flex-row items-center justify-end">
                                <Button variant="outline" rightIcon={RepeatIcon} onClick={onRetry}>
                                    {t('Retry')}
                                </Button>
                            </div>
                        ) : null}
                    </div>
                ) : run.status === 'canceled' ? (
                    <div className="alphaino-note">{t('Stopped.')}</div>
                ) : null}
                {/* As in AlphainZ, a failed last answer has no footer: its card carries Retry. */}
                {!live && !(run.status === 'error' && last) ? <RunFooter plugin={plugin} run={run} answer={answer} laterCount={laterCount ?? 0} onRetry={onRetry} /> : null}
                {/* The follow-up questions, under the footer of the last answer (AlphainZ's AgentRunView). */}
                {!live && last && onAsk && !suggestionsDismissed ? (
                    <SuggestionChips suggestions={suggestions} onAsk={onAsk} onDismiss={() => setSuggestionsDismissed(true)} />
                ) : null}
            </div>
        </div>
    );
}

/**
 * What stops a question before it is sent, with the way to fix it, as
 * AlphainZ's home page shows "No model is configured yet" (HomePage's
 * NoModelConfiguredMessage): the same box, text and button.
 */
function SetupCard({ message, onOpenSettings }: { message: string; onOpenSettings: () => void }) {
    return (
        <div className="display-flex flex-row items-center gap-2 text-sm p-2 rounded-md bg-quinary alphaino-setup-card" role="status">
            <span className="flex-1 font-color-secondary">{message}</span>
            <Button variant="outline" icon={SettingsIcon} onClick={onOpenSettings}>
                {t('Open Settings')}
            </Button>
        </div>
    );
}

export function ChatApp({ plugin }: { plugin: AlphainOPlugin }) {
    // The chat reopens where it was closed, with what was being written in it (AlphainZ's pane keeps both).
    const [boot] = useState(() => {
        const last = plugin.lastConversation;
        plugin.lastConversation = null;
        const conversation = last ?? blankConversation();
        return { conversation, draft: plugin.drafts.take(last ? last.id : draftKey(conversation)) };
    });
    const [conversation, setConversation] = useState<Conversation>(boot.conversation);
    const [live, setLive] = useState<TurnState | null>(null);
    const [runWarnings, setRunWarnings] = useState<Record<string, RunWarning[]>>({});
    // After an answer about a passage: the offer to keep it as a comment on the passage (AlphainZ's "Save to the highlight?").
    const [commentOffer, setCommentOffer] = useState<{ threadId: string; quote: Quote; text: string; failed?: boolean } | null>(null);
    // Chats whose long-chat notice was put away this session.
    const [longChatDismissed, setLongChatDismissed] = useState<ReadonlySet<string>>(() => new Set());
    // Warnings put away: by id, or (a notice) by what it says, for the rest of the session (AlphainZ's dismissWarning).
    const [dismissedWarnings, setDismissedWarnings] = useState<ReadonlySet<string>>(() => new Set());
    // "Explain" that opened the chat: its passage and question are sent on their own, the message box left as it was.
    const handedSendRef = useRef<{ quote: Quote | null; text: string } | null>(null);
    const [handedAtBoot] = useState(() => {
        if (!plugin.pendingSend) return false;
        handedSendRef.current = { quote: plugin.pendingQuote, text: plugin.pendingInput ?? '' };
        plugin.pendingSend = false;
        plugin.pendingQuote = null;
        plugin.pendingInput = null;
        return true;
    });
    const [input, setInput] = useState(() => {
        const pending = plugin.pendingInput;
        plugin.pendingInput = null;
        return pending ? addToDraft(boot.draft.text, pending) : boot.draft.text;
    });
    const [problem, setProblem] = useState<string | null>(null);
    // The panel over the chat area: the chat history or the conversation outline (AlphainZ's overlays).
    const [panel, setPanel] = useState<'history' | 'outline' | null>(null);
    // The note the history is filtered to ("View All" under the empty view), and a count bumped when it closes.
    const [historyFilter, setHistoryFilter] = useState<string | null>(null);
    const [historyVersion, setHistoryVersion] = useState(0);
    // Asks for the cursor in the message box once the view has drawn it (the box moves between the empty view and the bottom).
    const [focusRequest, setFocusRequest] = useState(0);
    const focusComposer = useCallback(() => setFocusRequest((n) => n + 1), []);
    const outlineButtonRef = useRef<HTMLButtonElement>(null);
    // A passage handed over by "Ask about the selection", waiting in the composer.
    const [quote, setQuote] = useState<Quote | null>(() => {
        const pending = plugin.pendingQuote;
        plugin.pendingQuote = null;
        // What was handed over is taken here, on the first draw (see the plugin's handOver).
        plugin.pendingHandOver = null;
        return pending ?? boot.draft.quote;
    });
    // "Explain": the handed-over passage and question are sent as soon as the chat has them.
    const [sendRequest, setSendRequest] = useState(() => (handedAtBoot ? 1 : 0));
    // The note in view and the passage selected in it, followed live.
    const [editorContext, setEditorContext] = useState<EditorContextSnapshot>(() => plugin.editorContext.current);
    // A selection the user took off the composer (or already asked about) stays off until another is made.
    const [dismissedSelection, setDismissedSelection] = useState('');
    // Notes attached with the "+" button.
    const [attachedNotes, setAttachedNotes] = useState<string[]>(() => boot.draft.notes);
    // Images pasted or dropped into the message box.
    const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => boot.draft.images);
    // The question being edited, by run id.
    const [editingRun, setEditingRun] = useState<string | null>(null);

    const conversationRef = useRef(conversation);
    conversationRef.current = conversation;
    // Chats archived or deleted while they answered: the stopped answer is not saved back into them.
    const removedIdsRef = useRef(new Set<string>());
    // The running answer's saves, in order: a removal waits for the one being written.
    const savingRef = useRef<Promise<void>>(Promise.resolve());
    /** Mark a chat as being removed and wait out any save of it under way. */
    const holdSaves = useCallback(async (id: string) => {
        removedIdsRef.current.add(id);
        await savingRef.current.catch(() => {});
    }, []);
    // What is in the message box now, parked with the conversation when the chat leaves it.
    const draftRef = useRef<ChatDraft>(EMPTY_DRAFT);
    draftRef.current = { text: input, notes: attachedNotes, images: attachedImages, quote };
    const applyDraft = useCallback((draft: ChatDraft) => {
        setInput(draft.text);
        setAttachedNotes(draft.notes);
        setAttachedImages(draft.images);
        setQuote(draft.quote);
    }, []);
    const controllerRef = useRef<AbortController | null>(null);
    // When the running answer last streamed something, for its status line.
    const lastEventRef = useRef(Date.now());
    const scrollRef = useRef<HTMLDivElement>(null);
    const columnRef = useRef<HTMLDivElement>(null);
    const roomRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    // AlphainZ's Add Sources menu: "+" opens it with its own search field, a typed "@" opens it searching what follows.
    const addSourcesMenuRef = useRef<AddSourcesMenuHandle | null>(null);
    const addSources = useAddSourcesMenu({
        verticalPosition: conversation.runs.length === 0 && !live ? 'below' : 'above',
        deleteTrailingQuery: (length) => setInput((value) => value.slice(0, Math.max(0, value.length - length))),
        focusEditor: () => textareaRef.current?.focus(),
        setMessageContent: setInput,
        menuRef: addSourcesMenuRef,
    });
    // What the view does next, as in AlphainZ's thread view: bring a question
    // just sent to the top unmarked, bring a finished answer's question back up
    // marked, or open a conversation at its end.
    const [pendingScroll, setPendingScroll] = useState<
        { kind: 'sent' | 'finished' | 'jump'; runId: string } | { kind: 'opened' } | null
    >(() => (boot.conversation.runs.length > 0 ? { kind: 'opened' } : null));
    const busy = live !== null;
    // Whether a model is set up (Send waits for one, as in AlphainZ); read again when the settings change.
    const [settingsVersion, setSettingsVersion] = useState(0);
    useEffect(
        () =>
            plugin.onSettingsChange(() => {
                setSettingsVersion((v) => v + 1);
                // What stopped the last send may be fixed now: the card is shown again only if it still is.
                setProblem(null);
            }),
        [plugin],
    );
    const hasModel = useMemo(() => selectedModel(plugin) !== null, [plugin, settingsVersion]);
    // How much of each answer's working steps to show (the eye menu, kept as AlphainZ's pref `streamDisplay`).
    const [streamMode, setStreamModeState] = useState<StreamDisplayMode>(() => readStreamDisplay(plugin.prefs.get('streamDisplay')));
    const setStreamMode = useCallback(
        (mode: StreamDisplayMode) => {
            plugin.prefs.set('streamDisplay', mode);
            setStreamModeState(mode);
        },
        [plugin],
    );
    // The question rail beside the conversation (Settings → Conversation view, as in AlphainZ).
    const railOn = useMemo(() => plugin.prefs.get('conversationRail') !== false, [plugin, settingsVersion]);

    // The passage on offer: one handed over explicitly, else the live selection unless it was taken off.
    const liveSelection =
        editorContext.selection && selectionKey(editorContext.selection) !== dismissedSelection ? editorContext.selection : null;
    const offeredQuote: Quote | null = quote ?? (liveSelection ? selectionQuote(liveSelection) : null);
    const openNote = editorContext.note;
    const removeSelection = useCallback(() => {
        setQuote(null);
        setDismissedSelection(selectionKey(plugin.editorContext.current.selection));
    }, [plugin]);
    const removableCount = attachedNotes.length + attachedImages.length + (offeredQuote ? 1 : 0);
    const removeAll =
        removableCount > 1
            ? () => {
                  setAttachedNotes([]);
                  setAttachedImages([]);
                  removeSelection();
              }
            : undefined;

    const runs = useMemo(() => (live ? [...conversation.runs, live.run] : conversation.runs), [conversation.runs, live]);
    // The rail re-renders only when what it draws changes, not on every streamed token.
    const turnsRef = useRef<ConversationTurn[]>([]);
    const turns = useMemo(() => {
        const next = buildTurns(runs);
        if (!sameTurns(turnsRef.current, next)) turnsRef.current = next;
        return turnsRef.current;
    }, [runs]);

    useEffect(
        () =>
            plugin.editorContext.subscribe((next) => {
                setEditorContext((previous) => {
                    // A new selection replaces a passage handed over earlier.
                    if (next.selection && selectionKey(next.selection) !== selectionKey(previous.selection)) setQuote(null);
                    return next;
                });
            }),
        [plugin],
    );

    useEffect(
        () =>
            plugin.onQuote((next, text, sendNow) => {
                plugin.pendingQuote = null;
                plugin.pendingSend = false;
                plugin.pendingInput = null;
                setPanel(null);
                if (sendNow) {
                    // Sent on its own: the message box and what is attached there stay as they are.
                    handedSendRef.current = { quote: next, text: text ?? '' };
                    setSendRequest((n) => n + 1);
                    return;
                }
                if (next) setQuote(next);
                if (text) setInput((draft) => addToDraft(draft, text));
                focusComposer();
            }),
        [plugin, focusComposer],
    );

    useEffect(() => {
        if (focusRequest) textareaRef.current?.focus();
    }, [focusRequest]);

    // Closing the view stops a run still streaming, and keeps the conversation and its draft for when it reopens.
    useEffect(
        () => () => {
            const answering = controllerRef.current !== null;
            controllerRef.current?.abort();
            const current = conversationRef.current;
            // A chat whose first answer was still coming is reopened from its file (the stopped answer is saved there).
            plugin.lastConversation = current.runs.length > 0 || answering ? current : null;
            plugin.drafts.park(answering ? current.id : draftKey(current), draftRef.current);
        },
        [plugin],
    );

    // A reopened conversation is read again: another computer may have added to it, or it may have been archived since.
    useEffect(() => {
        const id = boot.conversation.id;
        let cancelled = false;
        plugin.conversations
            .load(id)
            .then((fresh) => {
                if (cancelled || controllerRef.current || conversationRef.current.id !== id) return;
                if (!fresh || fresh.archivedAt) setConversation(blankConversation());
                else if (fresh.updatedAt !== conversationRef.current.updatedAt) setConversation(withInterruptedRuns(fresh));
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [plugin, boot]);

    // The room below the conversation, which lets a question be read from the
    // top of the view while its answer streams in below it (readingRoom.ts).
    useLayoutEffect(() => {
        const container = scrollRef.current;
        if (container && columnRef.current && roomRef.current) {
            attachReadingRoom(container, columnRef.current, roomRef.current);
        }
    });

    // Whether the view is away from the end of the conversation, for the scroll-down button (AlphainZ's userScrolled).
    const [scrolledAway, setScrolledAway] = useState(false);

    // Room below a view at rest is given back; the reader's own scrolling counts as reading.
    const hasRuns = runs.length > 0;
    useEffect(() => {
        const container = scrollRef.current;
        if (!container || !hasRuns) return;
        // The view no longer follows an answer down, so content can grow past the end with no scroll to say so:
        // the distance is noted on scroll and whenever the conversation changes size.
        const noteDistance = () => {
            if (!isLaidOut(container)) return;
            setScrolledAway(container.scrollHeight - container.scrollTop - container.clientHeight > BOTTOM_THRESHOLD);
        };
        const owner = container.ownerDocument.defaultView;
        const sizes = owner?.ResizeObserver ? new owner.ResizeObserver(noteDistance) : null;
        sizes?.observe(container);
        if (columnRef.current) sizes?.observe(columnRef.current);
        container.addEventListener('scroll', noteDistance, { passive: true });
        const settle = () => settleReadingRoom(container);
        const input = (event: Event) => {
            if (event.type === 'pointerdown') {
                if (event.target !== container) return;
                holdReadingScroll(container, true);
            }
            noteReaderInput(container);
            endWheelTurn(container);
        };
        const release = () => holdReadingScroll(container, false);
        const inputs = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const;
        const releases = ['pointerup', 'pointercancel', 'blur'] as const;
        container.addEventListener('scrollend', settle);
        for (const type of inputs) container.addEventListener(type, input, { passive: true });
        for (const type of releases) owner?.addEventListener(type, release, true);
        return () => {
            container.removeEventListener('scrollend', settle);
            for (const type of inputs) container.removeEventListener(type, input);
            for (const type of releases) owner?.removeEventListener(type, release, true);
            container.removeEventListener('scroll', noteDistance);
            sizes?.disconnect();
            detachReadingRoom(container);
            setScrolledAway(false);
        };
    }, [hasRuns]);

    /** Back to the end of the conversation (AlphainZ's scroll-down button). */
    const scrollToEnd = useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;
        setScrolledAway(false);
        container.scrollTo({ top: Math.max(container.scrollHeight - container.clientHeight, 0), behavior: 'smooth' });
    }, []);

    useLayoutEffect(() => {
        const container = scrollRef.current;
        if (!pendingScroll || !container) return;
        setPendingScroll(null);
        if (pendingScroll.kind === 'opened') {
            container.scrollTop = container.scrollHeight;
            return;
        }
        if (!isLaidOut(container)) return;
        // A question just sent goes to the top; a finished answer only marks its question, and the view stays
        // where the reader is (AlphainZ jumps back only when steps fold away above the answer).
        if (pendingScroll.kind === 'finished') flashQuestion(container, pendingScroll.runId);
        // A link to an answer (obsidian://alphaino?…&run=…) brings its question to the top, marked.
        else if (pendingScroll.kind === 'jump') jumpToRun(container, pendingScroll.runId, null, { flash: true });
        else jumpToRun(container, pendingScroll.runId, null, { flash: false });
    }, [pendingScroll]);


    const save = useCallback(async (next: Conversation) => {
        try {
            await plugin.conversations.save(next);
        } catch (error) {
            new Notice(t('Could not save the conversation: {reason}', { reason: String((error as Error)?.message ?? error) }));
        }
    }, [plugin]);

    const send = useCallback(async (asked?: string, replay?: { base: Conversation; context: QuestionContext }) => {
        const question = (asked ?? input).trim();
        const hasImages = asked === undefined && !replay && attachedImages.length > 0;
        // A passage alone is a question too: what does it mean. A suggestion chip asks without the composer's context;
        // an edited question keeps the context it was first sent with.
        let passage = replay ? replay.context.quote ?? null : asked === undefined ? offeredQuote : null;
        if (passage && !passage.anchor && !replay) {
            // Anchor the live selection in the text it was made in, so it can be found again after edits.
            const selection = plugin.editorContext.current.selection;
            if (selection && !quote) {
                const anchor = selection.from >= 0 ? plugin.anchorFor(selection.path, selection.source, selection.from, selection.to) : null;
                if (anchor) passage = { ...passage, anchor };
            }
        }
        if ((!question && !passage && !hasImages && !(replay && (replay.context.images?.length ?? 0) > 0)) || controllerRef.current) return;
        const built = plugin.buildProvider();
        if (!built.ok) {
            setProblem(built.message);
            return;
        }
        setProblem(null);

        const before = replay?.base ?? conversationRef.current;
        const stillHere = () => conversationRef.current.id === before.id;
        if (replay) {
            // The answers after an edited question are replaced: they leave the view now.
            setConversation(replay.base);
            conversationRef.current = replay.base;
        }
        const run = newRun({
            id: crypto.randomUUID(),
            threadId: before.id,
            question,
            model: built.model,
            providerLabel: built.providerLabel,
            now: new Date(),
            context: replay
                ? { ...replay.context, quote: passage }
                : asked === undefined
                    ? { note: openNote, notes: attachedNotes, quote: passage, images: attachedImages }
                    : { note: openNote },
        });
        const controller = new AbortController();
        controllerRef.current = controller;
        if (asked === undefined && !replay) {
            setInput('');
            setAttachedNotes([]);
            setAttachedImages([]);
            if (passage) removeSelection();
            // The first question moves the box from the middle of the empty view to the bottom; the cursor goes with it.
            const box = textareaRef.current;
            if (box && box.ownerDocument.activeElement === box) focusComposer();
        }
        setLive({ run, warnings: [], retrying: null });
        setPendingScroll({ kind: 'sent', runId: run.id });
        setCommentOffer(null);

        // The question is saved as soon as it is sent, and the answer every few seconds while it is written, so
        // quitting Obsidian mid-answer loses neither (AlphainZ stores runs as they go). Saves run one after another,
        // and the last one is the finished answer's.
        let saving: Promise<void> = Promise.resolve();
        const saveInFlight = (inFlight: AgentRun) => {
            if (!stillHere() || removedIdsRef.current.has(before.id)) return;
            // The chat's own fields as on screen now (a rename while it answers), its questions as sent.
            const shown = conversationRef.current;
            const snapshot: Conversation = {
                ...before,
                name: shown.name,
                archivedAt: shown.archivedAt ?? null,
                runs: [...before.runs, inFlight],
                updatedAt: new Date().toISOString(),
            };
            saving = saving.then(() => (removedIdsRef.current.has(before.id) ? undefined : save(snapshot))).catch(() => {});
            savingRef.current = saving;
        };
        saveInFlight(run);

        // Streaming sends dozens of updates a second; the screen needs one per frame.
        lastEventRef.current = Date.now();
        let pending: TurnState | null = null;
        let frame = 0;
        const autosave = window.setInterval(() => {
            const current = pending as TurnState | null;
            if (current) saveInFlight(current.run);
        }, AUTOSAVE_MS);
        const setup = await plugin.prepareRun(controller.signal, { vision: built.supportsVision });
        const final = await runTurn({
            run,
            priorRuns: before.runs,
            provider: built.provider,
            systemPrompt: setup.systemPrompt,
            outputTokenLimit: built.outputTokenLimit,
            maxModelRequests: plugin.maxModelRequests(),
            tools: setup.tools,
            dispatch: setup.dispatch,
            customInstructions: plugin.prefs.string('customInstructions'),
            loadImage: (path) => plugin.loadImage(path),
            vision: built.supportsVision,
            signal: controller.signal,
            onUpdate: (state) => {
                lastEventRef.current = Date.now();
                pending = state;
                if (!frame) {
                    frame = requestAnimationFrame(() => {
                        frame = 0;
                        // The user may have left for another chat (which stops this answer): it is not drawn there.
                        if (pending && stillHere()) setLive(pending);
                    });
                }
            },
        });
        if (frame) cancelAnimationFrame(frame);
        window.clearInterval(autosave);
        // A save of the answer in progress still under way lands before the finished one.
        await saving;
        if (controllerRef.current === controller) controllerRef.current = null;

        // What may have changed while it answered: a new name, or the chat archived or deleted from the history
        // (the chat then left, so it is read back from its file).
        const here = stillHere();
        // Archived or deleted while it answered (here, from the ⋯ menu or the history): left as it is.
        if (removedIdsRef.current.has(before.id)) {
            // Every save of this answer has run by now; a chat restored and opened again saves as usual.
            removedIdsRef.current.delete(before.id);
            setLive((current) => (current?.run.id === run.id ? null : current));
            return;
        }
        // The question was saved when it was sent, so the file is what to build on when the chat was left.
        const latest = here ? conversationRef.current : await plugin.conversations.load(before.id).catch(() => null);
        if (!latest) {
            // Deleted for good while it answered: nothing to save it into.
            setLive((current) => (current?.run.id === run.id ? null : current));
            return;
        }
        const next: Conversation = {
            ...before,
            name: latest.name,
            archivedAt: latest.archivedAt ?? null,
            runs: [...before.runs, final.run],
            updatedAt: new Date().toISOString(),
        };
        if (final.warnings.length > 0) setRunWarnings((all) => ({ ...all, [final.run.id]: final.warnings }));
        if (here) {
            conversationRef.current = next;
            setConversation(next);
            setLive(null);
            setPendingScroll({ kind: 'finished', runId: final.run.id });
        }
        await save(next);

        // An answer about a passage of a note can be kept as a comment on that passage.
        const passageAsked = quoteOf(final.run.user_prompt);
        if (final.run.status === 'completed' && passageAsked?.anchor && /\.md$/i.test(passageAsked.path)) {
            const answered = finalAnswerText(final.run);
            if (answered) {
                const text = commentEntry(final.run.user_prompt?.content || t('Explain this passage.'), answered);
                if (plugin.prefs.get('selectionChatAutoComment') === true) {
                    await plugin.comments.addThread({ actor: 'alphaino', anchor: passageAsked.anchor, text }).catch(() => new Notice(t('The answer was not saved.')));
                } else if (stillHere()) {
                    setCommentOffer({ threadId: before.id, quote: passageAsked, text });
                }
            }
        }

        if (!next.name && before.runs.length === 0 && final.run.status === 'completed') {
            const title = await generateThreadTitle(built.provider, question, answerText(final.run)).catch(() => null);
            if (title && !removedIdsRef.current.has(next.id)) {
                const shown = conversationRef.current;
                if (shown.id === next.id) {
                    if (!shown.name) {
                        const named = { ...shown, name: title };
                        conversationRef.current = named;
                        setConversation(named);
                        // Only the name changes in the file: an answer may be streaming into it (its saves carry the name too).
                        await plugin.conversations.rename(next.id, title).catch(() => {});
                    }
                } else {
                    // Named even when the user has moved on to another chat, as AlphainZ names it.
                    const saved = await plugin.conversations.load(next.id).catch(() => null);
                    if (saved && !saved.name) await plugin.conversations.rename(next.id, title).catch(() => {});
                }
            }
        }
    }, [attachedImages, attachedNotes, focusComposer, input, offeredQuote, openNote, plugin, quote, removeSelection, save]);

    const stop = useCallback(() => controllerRef.current?.abort(), []);

    /**
     * Leaving a chat while it answers stops the answer, after asking (AlphainZ's "Start new chat?" and "Switch
     * chat?"). The answer as it stood is saved into its chat. Resolves to whether the chat may be left.
     */
    const leaveRunningAnswer = useCallback(
        async (title: string, text: string, confirmLabel: string): Promise<boolean> => {
            if (!controllerRef.current) return true;
            if (!(await confirmInModal(plugin.app, title, text, confirmLabel))) return false;
            controllerRef.current?.abort();
            controllerRef.current = null;
            setLive(null);
            return true;
        },
        [plugin],
    );

    // Send what "Explain" handed over, once it is in the message box (this render has it). If an answer is
    // still coming, or no model is set up, it waits there to be sent by hand.
    const sendRef = useRef(send);
    sendRef.current = send;
    useEffect(() => {
        const handed = handedSendRef.current;
        handedSendRef.current = null;
        if (!sendRequest || !handed) return;
        if (controllerRef.current || selectedModel(plugin) === null) {
            // An answer is still coming, or no model is set up: it waits in the message box to be sent by hand.
            if (handed.quote) setQuote(handed.quote);
            if (handed.text) setInput((draft) => addToDraft(draft, handed.text));
            return;
        }
        void sendRef.current(handed.text, { base: conversationRef.current, context: { note: plugin.editorContext.current.note, quote: handed.quote } });
        // The selection it explained is not offered again in the message box.
        if (handed.quote) setDismissedSelection(selectionKey(plugin.editorContext.current.selection));
    }, [sendRequest, plugin]);

    /** Send an edited question again: the answers from it on are replaced, its context kept. */
    const resend = useCallback(
        async (runId: string, text: string) => {
            const current = conversationRef.current;
            const index = current.runs.findIndex((run) => run.id === runId);
            if (index < 0 || controllerRef.current) return;
            const later = current.runs.length - 1 - index;
            if (later > 0) {
                // AlphainZ asks the same before any retry that takes later exchanges with it (edit and retry included).
                const sentence = tn(
                    later,
                    'Retrying this message also removes the question and answer after it in this chat.',
                    'Retrying this message also removes the {count} questions and answers after it in this chat.',
                );
                const ok = await confirmInModal(plugin.app, t('Retry from here?'), `${sentence} ${t('They cannot be brought back.')}`, t('Retry'));
                if (!ok || controllerRef.current || conversationRef.current !== current) return;
            }
            const prompt = current.runs[index].user_prompt;
            setEditingRun(null);
            void send(text, {
                base: { ...current, runs: current.runs.slice(0, index) },
                context: { note: openNoteOf(prompt), notes: attachedNotesOf(prompt), quote: quoteOf(prompt), images: imagesOf(prompt) },
            });
        },
        [plugin, send],
    );

    const newChat = useCallback(async () => {
        // The chat being left, by id when its first answer is still coming (it has no saved question in view yet).
        const leavingKey = controllerRef.current ? conversationRef.current.id : draftKey(conversationRef.current);
        const stopped = await leaveRunningAnswer(
            t('Start new chat?'),
            t('AlphainO is still generating a response in this chat. Starting a new chat will stop it.'),
            t('Start New Chat'),
        );
        if (!stopped) return;
        clearReadingRoom(scrollRef.current);
        // The draft stays with the chat being left; a new chat gets the one left in a new chat, if any.
        plugin.drafts.park(leavingKey, draftRef.current);
        applyDraft(plugin.drafts.take(''));
        const blank = blankConversation();
        conversationRef.current = blank;
        setConversation(blank);
        setRunWarnings({});
        setPanel(null);
        setEditingRun(null);
        setProblem(null);
        focusComposer();
    }, [applyDraft, focusComposer, leaveRunningAnswer, plugin]);

    const openConversation = useCallback(async (id: string, runId?: string) => {
        if (id === conversationRef.current.id && (conversationRef.current.runs.length > 0 || controllerRef.current !== null)) {
            // The chat on screen: nothing to switch.
            setPanel(null);
            if (runId) setPendingScroll({ kind: 'jump', runId });
            return;
        }
        const leavingKey = controllerRef.current ? conversationRef.current.id : draftKey(conversationRef.current);
        const stopped = await leaveRunningAnswer(
            t('Switch chat?'),
            t('AlphainO is still generating a response in this chat. Switching chats will stop it.'),
            t('Switch Chat'),
        );
        if (!stopped) return;
        const read = await plugin.conversations.load(id);
        if (!read) return;
        const loaded = withInterruptedRuns(read);
        clearReadingRoom(scrollRef.current);
        // The draft stays with the chat being left, and the one left in the chat opened comes back.
        plugin.drafts.park(leavingKey, draftRef.current);
        applyDraft(plugin.drafts.take(draftKey(loaded)));
        conversationRef.current = loaded;
        setConversation(loaded);
        setRunWarnings({});
        setPanel(null);
        setEditingRun(null);
        setPendingScroll(runId && loaded.runs.some((run) => run.id === runId) ? { kind: 'jump', runId } : { kind: 'opened' });
    }, [applyDraft, leaveRunningAnswer, plugin]);

    // A link to a chat (obsidian://alphaino?thread=…) opens it here: one that opened the view, or one followed while it is open.
    useEffect(() => {
        const pending = plugin.pendingThread;
        if (pending) {
            plugin.pendingThread = null;
            void openConversation(pending.id, pending.runId);
        }
        return plugin.onOpenThread((id, runId) => void openConversation(id, runId));
    }, [plugin, openConversation]);

    // Commands from the palette or a hotkey.
    useEffect(
        () =>
            plugin.onChatCommand((command) => {
                if (command === 'new-chat') void newChat();
                else if (command === 'history') {
                    setHistoryFilter(null);
                    setPanel((open) => (open === 'history' ? null : 'history'));
                } else if (command === 'outline') setPanel((open) => (open === 'outline' || conversationRef.current.runs.length === 0 ? null : 'outline'));
                else focusComposer();
            }),
        [plugin, newChat, focusComposer],
    );

    /** A note dragged from the file list (or a [[link]] or obsidian:// link) onto the message box is attached. */
    const dropNotes = useCallback(
        (data: DataTransfer): boolean => {
            const text = data.getData('text/plain');
            const paths = new Set<string>();
            // A drag from Obsidian's own file list carries the files in its drag manager (not in the public API, so read with care).
            const dragged = (plugin.app as unknown as { dragManager?: { draggable?: { type?: string; file?: { path?: string; extension?: string }; files?: Array<{ path?: string; extension?: string }> } } }).dragManager?.draggable;
            for (const file of [dragged?.file, ...(dragged?.files ?? [])]) {
                if (file?.path && file.extension === 'md') paths.add(file.path);
            }
            for (const match of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
                const file = plugin.app.metadataCache.getFirstLinkpathDest(match[1].trim(), '');
                if (file && file.extension === 'md') paths.add(file.path);
            }
            for (const match of text.matchAll(/obsidian:\/\/open\?[^\s]*/g)) {
                try {
                    const url = new URL(match[0]);
                    const name = url.searchParams.get('file');
                    const file = name ? plugin.app.metadataCache.getFirstLinkpathDest(name, '') : null;
                    if (file && file.extension === 'md') paths.add(file.path);
                } catch {
                    // Not a link this can read.
                }
            }
            if (paths.size === 0) return false;
            setAttachedNotes((notes) => [...notes, ...[...paths].filter((path) => !notes.includes(path))]);
            return true;
        },
        [plugin],
    );

    /** Keep pasted or dropped images and show them above the message box. */
    const attachImages = useCallback(
        async (files: File[]) => {
            for (const file of files) {
                try {
                    const image = await plugin.saveAttachment(file);
                    if (image) setAttachedImages((images) => [...images, image]);
                } catch (error) {
                    new Notice(String((error as Error)?.message ?? error));
                }
            }
        },
        [plugin],
    );

    const jumpTo = useCallback((runId: string) => {
        const container = scrollRef.current;
        if (container) jumpToRun(container, runId, null, { flash: true });
    }, []);

    const openSettings = useCallback(() => plugin.openSettings(), [plugin]);
    const readIndexStatus = useCallback(() => plugin.noteIndex?.status() ?? null, [plugin]);
    const subscribeIndex = useCallback((listener: Parameters<NonNullable<typeof plugin.noteIndex>['onStatusChange']>[0]) => plugin.noteIndex?.onStatusChange(listener) ?? (() => {}), [plugin]);
    const readPictureStatus = useCallback(() => plugin.imageIndex?.status() ?? null, [plugin]);
    const subscribePictures = useCallback((listener: Parameters<NonNullable<typeof plugin.imageIndex>['onStatusChange']>[0]) => plugin.imageIndex?.onStatusChange(listener) ?? (() => {}), [plugin]);

    /** The chat's own actions, as AlphainZ's ThreadMenuButton offers them. */
    const chatMenuItems = (): MenuItem[] => {
        const current = conversation;
        const hasRuns = current.runs.length > 0;
        const link = (runId: string) => plugin.chatLink(current.id, runId);
        return [
            {
                label: t('Copy entire chat'),
                onClick: () => void navigator.clipboard.writeText(chatMarkdown(current, { link })).then(() => new Notice(t('Copied'))),
                disabled: !hasRuns,
            },
            { label: t('Save chat as note…'), onClick: () => void plugin.saveChatAsNote(current), disabled: !hasRuns },
            {
                label: t('Append chat to the open note'),
                onClick: () => void plugin.appendToOpenNote(chatMarkdown(current, { link, quoteQuestions: true })),
                disabled: !hasRuns || !openNote || !openNote.endsWith('.md'),
            },
            {
                label: t('Copy link to chat'),
                onClick: () => void navigator.clipboard.writeText(plugin.chatLink(current.id)).then(() => new Notice(t('Copied'))),
                disabled: !hasRuns,
            },
            { label: 'chat-actions-divider', onClick: () => {}, isDivider: true },
            {
                label: t('Rename chat'),
                onClick: () =>
                    void (async () => {
                        const name = await promptInModal(plugin.app, t('Rename chat'), t('Enter a new name for this chat:'), current.name || t('Unnamed conversation'));
                        const trimmed = name?.trim();
                        if (!trimmed || trimmed === current.name) return;
                        try {
                            await plugin.conversations.rename(current.id, trimmed);
                            if (conversationRef.current.id === current.id) {
                                const renamed = { ...conversationRef.current, name: trimmed };
                                conversationRef.current = renamed;
                                setConversation(renamed);
                            }
                        } catch (error) {
                            new Notice(String((error as Error)?.message ?? error));
                        }
                    })(),
                disabled: !hasRuns,
            },
            {
                label: t('Delete chat'),
                onClick: () =>
                    void (async () => {
                        const ok = await confirmInModal(
                            plugin.app,
                            t('Delete chat?'),
                            t('This chat moves to the archive. You can restore it from Chat history → Archive.'),
                            t('Delete'),
                        );
                        if (!ok) return;
                        // An answer still coming stops; the delete was confirmed already. It is not saved back into the chat.
                        if (controllerRef.current) await holdSaves(current.id);
                        controllerRef.current?.abort();
                        controllerRef.current = null;
                        setLive(null);
                        try {
                            await plugin.conversations.archive(current.id);
                        } catch (error) {
                            new Notice(String((error as Error)?.message ?? error));
                            return;
                        }
                        if (conversationRef.current.id === current.id) {
                            clearReadingRoom(scrollRef.current);
                            const blank = blankConversation();
                            conversationRef.current = blank;
                            setConversation(blank);
                            setPanel(null);
                            focusComposer();
                        }
                    })(),
                disabled: !hasRuns,
            },
        ];
    };
    // Which warnings each answer shows: a notice, or a warning shown once per chat, only with the first answer
    // that carries it, and none the user put away (AlphainZ's selectRunWarnings).
    const shownWarnings = useMemo(() => {
        const seen = new Set<string>();
        const shown: Record<string, RunWarning[]> = {};
        for (const run of conversation.runs) {
            const list: RunWarning[] = [];
            for (const warning of runWarnings[run.id] ?? []) {
                const once = warningTone(warning.type) === 'notice' ? `notice:${warning.type}\u0000${warning.message}` : warning.type === 'semantic_search_failed' ? `once:${warning.type}` : null;
                if (once) {
                    if (seen.has(once)) continue;
                    seen.add(once);
                    if (dismissedWarnings.has(once)) continue;
                } else if (dismissedWarnings.has(warning.id)) continue;
                list.push(warning);
            }
            if (list.length > 0) shown[run.id] = list;
        }
        return shown;
    }, [conversation.runs, runWarnings, dismissedWarnings]);
    const dismissWarning = useCallback((warning: RunWarning) => {
        const key = warningTone(warning.type) === 'notice' ? `notice:${warning.type}\u0000${warning.message}` : warning.type === 'semantic_search_failed' ? `once:${warning.type}` : warning.id;
        setDismissedWarnings((all) => new Set([...all, key]));
    }, []);
    const listConversations = useCallback(() => plugin.conversations.list(), [plugin]);
    const closeHistory = useCallback(() => {
        setPanel(null);
        // Chats archived or renamed there show in the list under the empty view.
        setHistoryVersion((n) => n + 1);
    }, []);
    // No question yet: AlphainZ's home page (greeting, the message box in the middle, recent chats below).
    const empty = runs.length === 0;
    // What stops a question: the last send's problem, or no model at all yet.
    const setupMessage = problem ?? (hasModel ? null : t('No model is configured yet. Choose a provider and paste your API key to start.'));

    const longTokens = !busy && !longChatDismissed.has(conversation.id) ? longChatInputTokens(conversation.runs[conversation.runs.length - 1]) : null;
    // The offer belongs to the chat it was made in.
    const offer = commentOffer && commentOffer.threadId === conversation.id ? commentOffer : null;
    const saveOffer = async () => {
        if (!offer?.quote.anchor) return;
        try {
            await plugin.comments.addThread({ actor: 'alphaino', anchor: offer.quote.anchor, text: offer.text });
            setCommentOffer(null);
            new Notice(t('Saved as a comment on the passage.'));
        } catch {
            setCommentOffer({ ...offer, failed: true });
        }
    };

    const composer = (
        <div
            className="user-message-display alphaino-composer"
            style={{ minHeight: 'fit-content' }}
            onClick={(event) => {
                // A click on an empty part of the box puts the cursor in the message (AlphainZ's handleContainerClick).
                const target = event.target as HTMLElement;
                if (target.closest('button, a, input, textarea, [role="button"], [contenteditable="true"]')) return;
                textareaRef.current?.focus();
            }}
            onDragOver={(event) => {
                if (event.dataTransfer.types.includes('Files') || event.dataTransfer.types.includes('text/plain')) event.preventDefault();
            }}
            onDrop={(event) => {
                const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/'));
                if (files.length > 0) {
                    event.preventDefault();
                    void attachImages(files);
                    return;
                }
                if (dropNotes(event.dataTransfer)) event.preventDefault();
            }}
        >
            {longTokens !== null ? (
                // AlphainZ's HighTokenUsageWarningBar: every message resends so much that a new chat would be faster.
                <div className="high-token-usage-warning-bar display-flex flex-row items-start px-3 py-15 gap-2">
                    <SharedIcon icon={AlertIcon} className="font-color-orange scale-10 mt-010" />
                    <span className="font-color-secondary text-sm">
                        {t('This chat is long — each message sends about {tokens} tokens to the model.', { tokens: formatTokens(longTokens) })}{' '}
                        {(() => {
                            const [before, after] = t('{link} for a new topic: replies get faster and cheaper.').split('{link}');
                            return (
                                <>
                                    {before}
                                    <a
                                        href="#"
                                        className="font-color-secondary transition text-sm text-underline"
                                        onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            void newChat();
                                        }}
                                    >
                                        {t('Start a new chat')}
                                    </a>
                                    {after ?? ''}
                                </>
                            );
                        })()}
                    </span>
                    <div className="flex-1" />
                    <IconButton
                        variant="ghost-secondary"
                        icon={CancelIcon}
                        ariaLabel={t('Dismiss long chat warning')}
                        onClick={(event) => {
                            event.stopPropagation();
                            setLongChatDismissed((all) => new Set([...all, conversation.id]));
                        }}
                        className="scale-85 mt-010"
                    />
                </div>
            ) : null}
            <div className="composer-attachments display-flex flex-wrap gap-col-3 gap-row-2 mb-2">
                <AddNotesButton
                    menu={addSources}
                    verticalPosition={empty ? 'below' : 'above'}
                    app={plugin.app}
                    attached={new Set([...attachedNotes, ...(openNote ? [openNote] : [])])}
                    onPick={(path) => setAttachedNotes((notes) => (notes.includes(path) ? notes : [...notes, path]))}
                    showText={!openNote && attachedNotes.length === 0 && !offeredQuote}
                    disabled={busy}
                />
                {openNote ? <NoteChip path={openNote} current onOpen={(path) => void plugin.openNote(path)} /> : null}
                {attachedNotes.slice(0, MAX_SHOWN_NOTES).map((path) => (
                    <NoteChip
                        key={path}
                        path={path}
                        onOpen={(target) => void plugin.openNote(target)}
                        onRemove={() => setAttachedNotes((notes) => notes.filter((note) => note !== path))}
                        onRemoveAll={removeAll}
                    />
                ))}
                <OverflowChip paths={attachedNotes.slice(MAX_SHOWN_NOTES)} />
                {attachedImages.map((image) => (
                    <ImageChip
                        key={image.path}
                        image={image}
                        source={plugin.app.vault.adapter.getResourcePath(image.path)}
                        onRemove={() => setAttachedImages((images) => images.filter((other) => other.path !== image.path))}
                        onRemoveAll={removeAll}
                    />
                ))}
                {offeredQuote ? (
                    <SelectionChip quote={offeredQuote} onReveal={(q) => void plugin.revealQuote(q)} onRemove={removeSelection} onRemoveAll={removeAll} />
                ) : null}
            </div>
            <form
                className="display-flex flex-col"
                onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                }}
            >
                <div className="mb-2 -ml-1">
                    <TextareaComposer
                        value={input}
                        onChange={(value) => {
                            // While "@" search is open, typing is its query; a new "@" opens it.
                            if (addSources.handleChange(value)) return;
                            const box = textareaRef.current;
                            if (box && addSources.handleTrigger(value, box.getBoundingClientRect())) return;
                            setInput(value);
                        }}
                        onKeyDown={(event) => {
                            addSources.handleKeyDown(event);
                        }}
                        inlineHint={addSources.isOpen && addSources.querySource === 'editor' && addSources.query.length === 0 ? t('Type to search') : null}
                        onSubmit={() => {
                            if (!addSources.isOpen) void send();
                        }}
                        placeholder={t('Ask anything… @ to add a note')}
                        ariaLabel={t('Message AlphainO')}
                        pasteHandlers={{
                            onPasteFiles: (files) => {
                                const images = files.filter((file) => file.type.startsWith('image/'));
                                if (images.length > 0) void attachImages(images);
                            },
                        }}
                        onContentEditableRef={(el) => {
                            textareaRef.current = el as HTMLTextAreaElement | null;
                        }}
                    />
                </div>
                <div className="composer-controls display-flex flex-row items-center pt-2 min-w-0">
                    <ModelButton plugin={plugin} disabled={false} />
                    <div className="flex-1 min-w-0" />
                    <div className="display-flex flex-row items-center gap-4">
                        <Button
                            rightIcon={busy ? StopIcon : undefined}
                            ariaLabel={busy ? t('Stop generating') : t('Send message')}
                            type="button"
                            variant={busy ? 'surface' : 'solid'}
                            style={{ padding: '2px 5px' }}
                            onClick={() => (busy ? stop() : void send())}
                            disabled={!busy && ((!input.trim() && !offeredQuote && attachedImages.length === 0) || !hasModel)}
                        >
                            {busy ? (
                                t('Stop')
                            ) : (
                                <span>
                                    {t('Send')} <span className="opacity-50">⏎</span>
                                </span>
                            )}
                        </Button>
                    </div>
                </div>
            </form>
        </div>
    );

    return (
        <div className="alphaino-chat">
            <div id="alphainz-header" className="alphaino-header display-flex flex-row px-3 py-2">
                <div className="flex-1 display-flex gap-4 items-center">
                    <Tooltip content={t('Chat history')} showArrow singleLine>
                        <IconButton
                            icon={ChattingIcon}
                            onClick={() => {
                                if (panel === 'history') closeHistory();
                                else {
                                    setHistoryFilter(null);
                                    setPanel('history');
                                }
                            }}
                            className={`scale-14 ${panel === 'history' ? 'thread-list-toggle-active' : ''}`}
                            ariaLabel={t('Show chat history')}
                        />
                    </Tooltip>
                    <Tooltip content={t('New chat')} showArrow singleLine>
                        <IconButton icon={PlusSignIcon} onClick={() => void newChat()} className="scale-14" ariaLabel={t('New chat')} disabled={runs.length === 0} />
                    </Tooltip>
                    {turns.length > 0 ? (
                        <Tooltip content={t('Conversation outline')} secondaryContent={questionCountLabel(turns.length)} showArrow singleLine>
                            <button
                                ref={outlineButtonRef}
                                type="button"
                                className={`variant-ghost icon-only conversation-outline-button scale-14 ${panel === 'outline' ? 'thread-list-toggle-active' : ''}`}
                                aria-label={t('Conversation outline')}
                                aria-haspopup="dialog"
                                aria-expanded={panel === 'outline'}
                                onClick={() => setPanel(panel === 'outline' ? null : 'outline')}
                            >
                                <SharedIcon icon={BulletListIcon} />
                                <span className="conversation-outline-count" aria-hidden="true">
                                    {turns.length > 99 ? '99+' : turns.length}
                                </span>
                            </button>
                        </Tooltip>
                    ) : null}
                </div>
                <div className="display-flex gap-4 items-center">
                    {/* The note index while it is being built or has failed (AlphainZ's index status button). */}
                    <IndexStatusButton
                        status={readIndexStatus}
                        subscribe={subscribeIndex}
                        pictures={readPictureStatus}
                        subscribePictures={subscribePictures}
                        onRetry={() => plugin.noteIndex?.retry()}
                        onRetryPictures={() => plugin.imageIndex?.retry()}
                        onOpenSettings={openSettings}
                    />
                    {/* AlphainZ's eye: how much of the working steps to show. */}
                    <MenuButton
                        icon={ViewIcon}
                        menuItems={STREAM_DISPLAY_MODES.map((option): MenuItem => ({
                            label: t(STREAM_DISPLAY_LABELS[option]),
                            role: 'menuitemradio',
                            ariaChecked: streamMode === option,
                            onClick: () => setStreamMode(option),
                            customContent: (
                                <div className="display-flex flex-col min-w-0">
                                    <span className={`text-sm ${streamMode === option ? 'font-color-primary font-semibold' : 'font-color-primary'}`}>{t(STREAM_DISPLAY_LABELS[option])}</span>
                                    <span className="text-xs font-color-tertiary">{t(STREAM_DISPLAY_HINTS[option])}</span>
                                </div>
                            ),
                        }))}
                        className="scale-14"
                        ariaLabel={t('Step display')}
                        variant="ghost"
                        tooltipContent={t(STREAM_DISPLAY_LABELS[streamMode])}
                        showArrow={true}
                    />
                    {conversation.runs.length > 0 ? (
                        <MenuButton
                            icon={MoreHorizontalIcon}
                            menuItems={chatMenuItems()}
                            className="scale-14"
                            ariaLabel={t('Chat actions')}
                            variant="ghost"
                            tooltipContent={t('Chat actions')}
                            showArrow={true}
                        />
                    ) : null}
                    <Tooltip content={t('Comments')} showArrow singleLine>
                        <button type="button" className="variant-ghost icon-only scale-14 alphaino-header-obsidian-icon" aria-label={t('Open comments')} onClick={() => void plugin.openComments()}>
                            <Icon name="message-square-text" />
                        </button>
                    </Tooltip>
                    <Tooltip content={t('AlphainO settings')} showArrow singleLine>
                        <IconButton icon={SettingsIcon} onClick={() => plugin.openSettings()} className="scale-14" ariaLabel={t('AlphainO settings')} />
                    </Tooltip>
                </div>
            </div>

            <div className="alphaino-body">
                {empty ? (
                    <div id="welcome-page" className="display-flex flex-col flex-1 min-h-0 alphaino-welcome">
                        <div className="display-flex flex-col flex-1 overflow-y-auto scrollbar px-3 pt-4 gap-4">
                            <div className="flex-1" style={{ minHeight: '2vh', maxHeight: '4vh' }} />
                            <div className="display-flex flex-col items-center gap-2">
                                <Icon name={PANDA_ICON} className="alphaino-empty-icon" />
                                <div className="text-2xl font-semibold text-center p-2">{t('How can I help you?')}</div>
                            </div>
                            {composer}
                            {setupMessage ? <SetupCard message={setupMessage} onOpenSettings={openSettings} /> : null}
                            <div className="flex-1" />
                        </div>
                        <div id="alphainz-home-footer" className="flex-none px-25 pb-3">
                            <RecentChats
                                list={listConversations}
                                note={openNote}
                                currentId={conversation.id}
                                version={historyVersion}
                                onOpen={(id) => void openConversation(id)}
                                onViewAll={(note) => {
                                    setHistoryFilter(note);
                                    setPanel('history');
                                }}
                            />
                        </div>
                    </div>
                ) : (
                    <div className={`conversation-view alphaino-conversation${railOn ? ' has-rail' : ''}`}>
                        <div
                            id="alphainz-thread-view"
                            className="alphaino-messages"
                            ref={scrollRef}
                            role="log"
                            aria-label={t('Chat history')}
                            onContextMenu={(event) => {
                                // Right-click on selected text: Copy (AlphainZ's selection menu; Obsidian views get no native one).
                                const text = event.currentTarget.ownerDocument.defaultView?.getSelection()?.toString() ?? '';
                                if (!text.trim()) return;
                                event.preventDefault();
                                const menu = new Menu();
                                menu.addItem((item) =>
                                    item
                                        .setTitle(t('Copy'))
                                        .setIcon('copy')
                                        .onClick(() => void navigator.clipboard.writeText(text).then(() => new Notice(t('Copied')))),
                                );
                                menu.showAtMouseEvent(event.nativeEvent);
                            }}
                        >
                            <div ref={columnRef} className="thread-column alphaino-column">
                                {conversation.runs.map((run, index) => (
                                    <RunBlock
                                        key={run.id}
                                        plugin={plugin}
                                        run={run}
                                        mode={streamMode}
                                        warnings={shownWarnings[run.id]}
                                        onDismissWarning={dismissWarning}
                                        last={!live && index === conversation.runs.length - 1}
                                        onAsk={(query) => void send(query)}
                                        canEdit={!busy}
                                        editing={editingRun === run.id}
                                        onEdit={(on) => setEditingRun(on ? run.id : null)}
                                        onResend={(text) => resend(run.id, text)}
                                        laterCount={conversation.runs.length - 1 - index}
                                        onRetry={busy ? undefined : () => resend(run.id, run.user_prompt?.content ?? '')}
                                    />
                                ))}
                                {live ? <RunBlock plugin={plugin} run={live.run} warnings={live.warnings} retrying={live.retrying} live lastEventAt={lastEventRef.current} mode={streamMode} /> : null}
                                <div ref={roomRef} className="thread-reading-room" aria-hidden="true" />
                            </div>
                        </div>
                        {railOn ? <ConversationRail containerRef={scrollRef} turns={turns} onScrolled={setScrolledAway} /> : null}
                    </div>
                )}
                {panel === 'history' ? (
                    <ThreadListPanel
                        plugin={plugin}
                        currentId={conversation.id}
                        onOpen={(id) => void openConversation(id)}
                        onRemoving={async (id) => {
                            // Before the file changes: a stopped answer must not save the chat back.
                            if (conversationRef.current.id === id && controllerRef.current) await holdSaves(id);
                        }}
                        onRemoved={(id) => {
                            if (conversationRef.current.id !== id) return;
                            // The chat on screen went to the archive (or for good): an answer still coming stops, and a new chat takes its place.
                            controllerRef.current?.abort();
                            controllerRef.current = null;
                            setLive(null);
                            const blank = blankConversation();
                            conversationRef.current = blank;
                            setConversation(blank);
                        }}
                        onRenamed={(id, name) => {
                            if (conversationRef.current.id === id) setConversation({ ...conversationRef.current, name });
                        }}
                        onClose={closeHistory}
                        filter={historyFilter}
                        onClearFilter={() => setHistoryFilter(null)}
                    />
                ) : null}
                {panel === 'outline' ? (
                    <ConversationOutline turns={turns} containerRef={scrollRef} buttonRef={outlineButtonRef} onJump={jumpTo} onClose={() => setPanel(null)} />
                ) : null}
            </div>

            {!empty && setupMessage ? (
                <div className="alphaino-setup-row">
                    <SetupCard message={setupMessage} onOpenSettings={openSettings} />
                </div>
            ) : null}
            {offer ? (
                <div className="alphaino-setup-row">
                    <div className="display-flex flex-col p-3 gap-1 rounded-lg bg-quinary alphaino-comment-offer" role="dialog" aria-label={t('Save as a comment on the passage?')}>
                        <div className="font-semibold text-sm">{t('Save as a comment on the passage?')}</div>
                        <div className="display-flex flex-row items-start gap-2 py-15 cursor-pointer" onClick={() => void plugin.revealQuote(offer.quote)}>
                            <SharedIcon icon={HighlighterIcon} className="font-color-secondary mt-010" />
                            <div className="display-flex flex-row min-w-0 flex-1 justify-between gap-3">
                                <div className="truncate">{offer.quote.text.replace(/\s+/g, ' ')}</div>
                                <div className="font-color-tertiary whitespace-nowrap">{offer.quote.path.split('/').pop()?.replace(/\.md$/i, '')}</div>
                            </div>
                        </div>
                        <div className="text-sm font-color-secondary mt-1 overflow-y-auto" style={{ maxHeight: 120, whiteSpace: 'pre-wrap' }}>
                            {offer.text}
                        </div>
                        {offer.failed ? (
                            <div className="text-sm font-color-red mt-1" role="alert">
                                {t('The answer was not saved.')}
                            </div>
                        ) : null}
                        <div className="display-flex flex-row gap-2 pt-2">
                            <div className="flex-1" />
                            <Button variant="outline" onClick={() => setCommentOffer(null)}>
                                {t('Not now')}
                            </Button>
                            <Button variant="solid" onClick={() => void saveOffer()}>
                                {t('Save')}
                            </Button>
                        </div>
                    </div>
                </div>
            ) : null}
            {empty ? null : (
                // AlphainZ's ScrollDownButton: centred just above the message box, faded in while the view is away from the end.
                <div className="relative w-full h-0">
                    <div className={`transition-opacity duration-300 ${scrolledAway && panel === null ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                        <div className="absolute top-0 left-1/2 -translate-x-1/2 z-10">
                            <button type="button" onClick={scrollToEnd} className="scroll-down-button variant-ghost-secondary" aria-label={t('Scroll to the end')} tabIndex={scrolledAway ? 0 : -1}>
                                <SharedIcon icon={ArrowDownIcon} />
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {empty ? null : composer}
        </div>
    );
}
