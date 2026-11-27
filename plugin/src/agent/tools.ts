/**
 * The tools a question runs with: the follow-up chips, plus whatever the
 * plugin adds (the vault's notes, AlphainZ's library), behind one dispatcher.
 */
import type { ToolDispatcher } from '@beaver/agent-llm/agentLoop';
import type { ToolSchema } from '@beaver/agent-llm/types';

/** AlphainZ's chips tool, worded for notes. The loop ends a run that closes with it. */
export const RETURN_SUGGESTIONS_TOOL: ToolSchema = {
    name: 'return_suggestions',
    description:
        'Offer two or three follow-up questions as one-click chips under your answer. Call it '
        + 'once, last, after your answer is written — and only when you have a specific next step '
        + 'in mind. A generic "tell me more" is worse than nothing; a suggestion that names a '
        + 'note, a comparison or a concrete task is what makes this worth the click. '
        + '**Write nothing after this call.** Your answer is already finished; a sign-off after '
        + 'the chips just repeats it.',
    parameters: {
        type: 'object',
        properties: {
            suggestions: {
                type: 'array',
                minItems: 1,
                maxItems: 3,
                items: {
                    type: 'object',
                    properties: {
                        text: { type: 'string', description: "What the chip says. A few words, in the user's language." },
                        query: {
                            type: 'string',
                            description: 'The question that is actually sent if the user clicks it. Write it in full, as the user would.',
                        },
                    },
                    required: ['text', 'query'],
                },
            },
        },
        required: ['suggestions'],
    },
};

/** A group of tools and the dispatcher that runs them. */
export interface ToolSet {
    schemas: ToolSchema[];
    dispatch: ToolDispatcher;
}

/** Several tool sets as one: each call goes to the set that offered the tool. */
export function combineToolSets(sets: ToolSet[]): ToolSet {
    const owner = new Map<string, ToolDispatcher>();
    const schemas: ToolSchema[] = [];
    for (const set of sets) {
        for (const schema of set.schemas) {
            if (owner.has(schema.name)) continue;
            owner.set(schema.name, set.dispatch);
            schemas.push(schema);
        }
    }
    return {
        schemas,
        dispatch: async (name, args, context) => {
            const dispatch = owner.get(name);
            if (!dispatch) return { error: `No tool named ${name}.` };
            return dispatch(name, args, context);
        },
    };
}

export const SUGGESTIONS_TOOLS: ToolSet = {
    schemas: [RETURN_SUGGESTIONS_TOOL],
    // The chips are drawn from the call's arguments; there is nothing to do.
    dispatch: async () => ({ ok: true }),
};
