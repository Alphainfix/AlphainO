/**
 * A conversation as the question rail and the outline see it: one entry per
 * question, in the shared shape (@beaver/agent-ui/conversation/turns), built
 * from AlphainO's runs.
 */
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { clipText, type ConversationTurn, type TurnStatus } from '@beaver/agent-ui/conversation/turns';
import { getRunErrorTitle, stripRunErrorTypePrefix } from '@beaver/agent-core/run-state/runErrorCopy';
import { isInterruptedRun } from '@beaver/agent-core/run-state/runResumeHelpers';
import { answerText } from '../agent/runTurn';
import { imagesOf, noteTitle, quoteOf } from '../agent/quote';
import { t, tn } from '../i18n';
import { WRITE_TOOLS } from './parts';

/** Long enough to search a long answer, short enough that a hundred of them stay cheap. */
const MAX_ANSWER_CHARS = 20_000;
const MAX_QUESTION_CHARS = 1_000;
const MAX_ERROR_CHARS = 140;

/** Markdown as one line of plain text: what the rail's card and the outline show. */
export function plainText(markdown: string): string {
    return markdown
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[\[[^\]]*\]\]/g, ' ')
        .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => alias ?? target)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+[.)]\s+/gm, '')
        .replace(/(\*\*|__|\*|_|~~|`)/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

interface RunSummary {
    answer: string;
    citations: number;
    changes: number;
}

/*
 * A finished run never changes, so its summary is computed once, as AlphainZ
 * does: the conversation hands back the same run objects on every streamed
 * token, which keeps rebuilding the turns as cheap as the one run still working.
 */
const runSummaries = new WeakMap<AgentRun, RunSummary>();

function summarizeRun(run: AgentRun): RunSummary {
    const cached = runSummaries.get(run);
    if (cached) return cached;
    const markdown = answerText(run);
    let changes = 0;
    for (const message of run.model_messages ?? []) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts ?? []) {
            if (part && part.part_kind === 'tool-call' && WRITE_TOOLS.has(part.tool_name)) changes++;
        }
    }
    const summary = {
        answer: clipText(plainText(markdown), MAX_ANSWER_CHARS),
        // Notes cited as wikilinks.
        citations: (markdown.match(/\[\[[^\]]+\]\]/g) ?? []).length,
        changes,
    };
    runSummaries.set(run, summary);
    return summary;
}

function statusOf(run: AgentRun): TurnStatus {
    switch (run.status) {
        case 'in_progress':
            return 'answering';
        case 'awaiting_deferred':
            return 'waiting';
        case 'error':
            return 'failed';
        case 'canceled':
            return 'stopped';
        default:
            return 'done';
    }
}

/** One short line saying why a run failed (AlphainZ's failureLine). */
function failureLine(run: AgentRun): string {
    const error = run.error;
    const message = error?.message ? plainText(stripRunErrorTypePrefix(error.message, error.type)) : '';
    const sentence = message.match(/^.*?[.!?。！？](?=\s|$)/)?.[0] ?? message;
    return t('Failed: {reason}', { reason: clipText(sentence || getRunErrorTitle(error?.type), MAX_ERROR_CHARS) });
}

/** What a question is called on the rail: its text, else what it carried. */
function questionText(run: AgentRun): string {
    const text = (run.user_prompt?.content ?? '').replace(/\s+/g, ' ').trim();
    if (text) return clipText(text, MAX_QUESTION_CHARS);
    const quote = quoteOf(run.user_prompt);
    if (quote) return t('Text Selection · {note}', { note: noteTitle(quote.path) });
    const images = imagesOf(run.user_prompt).length;
    if (images > 0) return tn(images, '{count} image', '{count} images');
    return t('Untitled question');
}

export function buildTurns(runs: readonly AgentRun[]): ConversationTurn[] {
    return runs.map((run, index) => {
        const status = statusOf(run);
        let answer: string;
        let citations = 0;
        if (status === 'answering') answer = t('Answering…');
        else if (status === 'waiting') answer = t('Waiting for your approval…');
        else {
            const summary = summarizeRun(run);
            citations = summary.citations;
            const written = summary.changes > 0 ? `${summary.answer} ${tn(summary.changes, '({count} note change)', '({count} note changes)')}`.trim() : summary.answer;
            if (status === 'failed') answer = failureLine(run);
            else if (written) answer = written;
            else if (status === 'stopped') answer = isInterruptedRun(run) ? t('Cut off before it answered.') : t('Stopped before it answered.');
            else answer = t('No written answer.');
        }
        return {
            runId: run.id,
            index,
            question: questionText(run),
            answer,
            status,
            createdAt: run.created_at,
            citations,
        };
    });
}
