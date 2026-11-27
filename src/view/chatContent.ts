/**
 * A conversation as Markdown, the way AlphainZ copies and saves a chat
 * (`extractThreadContent`): the chat's name as the title, then each question
 * under "User" and each answer under "AlphainO" — its text and a line for each
 * step it took — separated by rules. In a note, each question links back to
 * its place in the chat.
 */
import type { AgentRun, ToolCallPart } from '@beaver/agent-core/agents/types';
import type { Conversation } from '../store/conversations';

import { t } from '../i18n';
import { SUGGESTIONS_TOOL, toolLabel } from './parts';

/** An answer as text: what it wrote, and a line for each step it took (AlphainZ's `extractRunResponseContent`). */
export function answerWithSteps(run: AgentRun): string {
    const parts: string[] = [];
    for (const message of run.model_messages) {
        if (message.kind !== 'response') continue;
        const text = message.parts
            .filter((part) => part.part_kind === 'text')
            .map((part) => (part as { content: string }).content)
            .filter(Boolean)
            .join('\n\n');
        if (text) parts.push(text);
        const steps = message.parts
            .filter((part): part is ToolCallPart => part.part_kind === 'tool-call' && part.tool_name !== SUGGESTIONS_TOOL)
            .map((part) => `*${toolLabel(part, 'completed')}*`);
        if (steps.length > 0) parts.push(steps.join('\n\n'));
    }
    return parts.filter(Boolean).join('\n\n').trim();
}

export interface ChatMarkdownOptions {
    /** Each question's heading links to it in the chat (`obsidian://alphaino?…`). */
    link?: (runId: string) => string;
    /** Questions as quotes, as AlphainZ writes them into a note. */
    quoteQuestions?: boolean;
}

export function chatMarkdown(conversation: Pick<Conversation, 'name' | 'runs'>, options: ChatMarkdownOptions = {}): string {
    const sections: string[] = [];
    if (conversation.name) sections.push(`# ${conversation.name}`);
    for (const run of conversation.runs) {
        const question = run.user_prompt?.content ?? '';
        if (question) {
            const heading = options.link ? `[${t('User')} ↗](${options.link(run.id)})` : t('User');
            const body = options.quoteQuestions ? `> ${question.replace(/\n/g, '\n> ')}` : question;
            sections.push(`## ${heading}\n\n${body}`);
        }
        const answer = answerWithSteps(run);
        if (answer) sections.push(`## AlphainO\n\n${answer}`);
    }
    return sections.join('\n\n---\n\n');
}
