/**
 * One question and its answer.
 *
 * The shared runner (`runLocalAgent`) streams the answer as protocol events;
 * agent-core's run-state reducers fold them into an `AgentRun`, the same
 * record AlphainZ stores, so a conversation file means the same thing to both
 * plugins.
 */
import type { AgentRun } from '@beaver/agent-core/agents/types';
import type {
    WSPartEvent,
    WSRunCompleteEvent,
    WSToolCallArgsStreamEvent,
    WSToolCallProgressEvent,
    WSToolReturnEvent,
} from '@beaver/agent-core/protocol/agentProtocol';
import {
    updateRunComplete,
    updateRunWithPart,
    updateRunWithToolCallArgsStream,
    updateRunWithToolCallProgress,
    updateRunWithToolReturn,
} from '@beaver/agent-core/run-state/atoms';
import { runLocalAgent } from '@beaver/agent-llm/localRunner';
import { buildRunMessages } from '@beaver/agent-llm/runRequestToMessages';
import type { ToolDispatcher } from '@beaver/agent-llm/agentLoop';
import type { ChatProvider, ToolSchema } from '@beaver/agent-llm/types';
import { imagesOf, promptForModel, promptWithContext, runsForModel, type QuestionContext } from './quote';

/** A warning that came with an answer (the shared runner's warning event): what kind, and what it says. */
export interface RunWarning {
    id: string;
    /** `output_limit`, `iteration_limit`, `empty_response`, `content_filter`, `semantic_search_failed`, … */
    type: string;
    message: string;
}

export interface TurnState {
    run: AgentRun;
    /** Warnings the runner raised for this run (an empty reply, a cut-off answer). */
    warnings: RunWarning[];
    /** Set while a failed request is being sent again. */
    retrying: string | null;
}

export interface RunTurnOptions {
    run: AgentRun;
    /** Earlier runs of the conversation, oldest first. */
    priorRuns: AgentRun[];
    provider: ChatProvider;
    systemPrompt: string;
    outputTokenLimit?: number;
    maxModelRequests?: number;
    /** The tools the model may call, and what runs them. */
    tools?: ToolSchema[];
    /**
     * Reads an attached image (the question's `alphaino_images`) for the
     * model; when absent, or when the model cannot see images (`vision`
     * false), the question says an image was attached instead.
     */
    loadImage?: (path: string) => Promise<{ mimeType: string; base64: string } | null>;
    vision?: boolean;
    dispatch?: ToolDispatcher;
    /**
     * The user's standing instructions (Settings → Custom instructions). They go
     * at the end of the system message, as AlphainZ sends them, not into the
     * question, and are not stored with the run.
     */
    customInstructions?: string;
    signal: AbortSignal;
    onUpdate: (state: TurnState) => void;
}

/** A new run for a question, before anything has been sent. */
export function newRun(options: {
    id: string;
    threadId: string;
    question: string;
    model: string;
    providerLabel: string;
    now: Date;
    /** What goes with the question: the open note, attached notes, a selected passage. */
    context?: QuestionContext;
}): AgentRun {
    return {
        id: options.id,
        user_id: 'local',
        thread_id: options.threadId,
        agent_name: 'alphaino',
        user_prompt: promptWithContext(options.question, options.context ?? {}) as AgentRun['user_prompt'],
        status: 'in_progress',
        model_messages: [],
        model_name: options.model,
        provider_name: options.providerLabel,
        created_at: options.now.toISOString(),
        consent_to_share: false,
    };
}

/** The answer's text: every text part of every response, in order. */
export function answerText(run: AgentRun): string {
    return run.model_messages
        .filter((message) => message.kind === 'response')
        .flatMap((message) => message.parts)
        .filter((part) => part.part_kind === 'text')
        .map((part) => (part as { content: string }).content)
        .join('\n\n')
        .trim();
}

/** The request's prompt with the user's standing instructions on it, when there are any. */
function withCustomInstructions(prompt: AgentRun['user_prompt'], instructions: string | undefined): AgentRun['user_prompt'] {
    const text = instructions?.trim();
    return text ? { ...prompt, custom_instructions: text } : prompt;
}

export async function runTurn(options: RunTurnOptions): Promise<TurnState> {
    const { provider, signal, onUpdate } = options;
    const state: TurnState = { run: options.run, warnings: [], retrying: null };
    const update = (next: Partial<TurnState>) => {
        Object.assign(state, next);
        onUpdate({ ...state });
    };

    const messages = buildRunMessages({
        priorRuns: runsForModel(options.priorRuns),
        prompt: withCustomInstructions(promptForModel(options.run.user_prompt), options.customInstructions),
        systemPrompt: options.systemPrompt,
    });
    // The question's own images go with it as image parts (earlier questions' images are not sent again).
    const images = imagesOf(options.run.user_prompt);
    const last = messages[messages.length - 1];
    if (images.length > 0 && last && last.role === 'user' && typeof last.content === 'string') {
        if (options.vision !== false && options.loadImage) {
            const parts: Array<{ type: 'image'; mimeType: string; base64: string; label?: string }> = [];
            for (const image of images) {
                const data = await options.loadImage(image.path).catch(() => null);
                if (data) parts.push({ type: 'image', mimeType: data.mimeType, base64: data.base64, label: image.name });
            }
            last.content = parts.length > 0 ? [{ type: 'text', text: last.content }, ...parts] : `${last.content}\n\n(The attached image could not be read.)`;
        } else {
            last.content = `${last.content}\n\n(The chosen model cannot see images, so the attached image is not shown to it. Say so if the question needs it.)`;
        }
    }

    try {
        await runLocalAgent({
            runId: state.run.id,
            threadId: state.run.thread_id ?? state.run.id,
            messages,
            provider,
            signal,
            outputTokenLimit: options.outputTokenLimit,
            maxIterations: options.maxModelRequests,
            tools: options.tools,
            dispatch: options.dispatch,
            callbacks: {
                onThread: () => {},
                onReady: () => {},
                onPart: (event) => update({ run: updateRunWithPart(state.run, event as unknown as WSPartEvent), retrying: null }),
                onToolCallArgsStream: (event) =>
                    update({ run: updateRunWithToolCallArgsStream(state.run, event as unknown as WSToolCallArgsStreamEvent) }),
                onToolReturn: (event) => update({ run: updateRunWithToolReturn(state.run, event as unknown as WSToolReturnEvent) }),
                onToolCallProgress: (event) =>
                    update({ run: updateRunWithToolCallProgress(state.run, event as unknown as WSToolCallProgressEvent) }),
                onRunComplete: (event) => update({ run: updateRunComplete(state.run, event as unknown as WSRunCompleteEvent) }),
                onWarning: (event) =>
                    update({ warnings: [...state.warnings, { id: `${state.run.id}:${state.warnings.length}`, type: event.type, message: event.message }] }),
                onRetry: (event) => update({ retrying: event.reason }),
                onError: (event) =>
                    update({
                        run: {
                            ...state.run,
                            status: 'error',
                            error: {
                                type: event.type,
                                message: event.message,
                                user_facing_details: event.user_facing_details,
                                details: event.details,
                                is_retryable: event.is_retryable,
                                retry_after: event.retry_after,
                            },
                        },
                    }),
                onDone: () => {},
            },
        });
    } catch {
        // The runner has already reported the failure through onError.
    }

    const completedAt = new Date().toISOString();
    if (signal.aborted && state.run.status === 'in_progress') {
        update({
            run: {
                ...state.run,
                status: 'canceled',
                error: { type: 'canceled', message: 'Stopped.', reason_code: 'client_cancel' },
                completed_at: completedAt,
            },
            retrying: null,
        });
    } else if (state.run.status === 'in_progress') {
        update({ run: { ...state.run, status: 'completed', completed_at: completedAt }, retrying: null });
    } else if (!state.run.completed_at) {
        update({ run: { ...state.run, completed_at: completedAt }, retrying: null });
    }
    return state;
}
