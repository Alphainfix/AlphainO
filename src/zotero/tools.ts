/**
 * AlphainZ's library tools, as tools of the chat's agent loop.
 *
 * `zoteroTools(client)` turns the tools AlphainZ's MCP server lists into the
 * runner's `ToolSchema`s and gives a dispatcher that runs them. Every name
 * gets the prefix `zotero_`, which keeps them apart from AlphainO's own tools
 * and lets a combined dispatcher tell whose a call is (`owns`).
 *
 * Zotero being closed is not an error here: the schemas are then empty, the
 * chat carries on without a library, and a call made after the listing was
 * taken returns the reason as its result.
 */
import type { ToolDispatcher } from '@beaver/agent-llm/agentLoop';
import { untilAborted } from '@beaver/agent-llm/sse';
import type { ToolSchema } from '@beaver/agent-llm/types';
import type { AlphainZClient, McpTool } from './client';
import { convertCallResult } from './result';

export const ZOTERO_TOOL_PREFIX = 'zotero_';

/** Function names are limited to 64 characters of `[a-zA-Z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;

/** How long a tool listing is reused before the server is asked again. */
const LISTING_TTL_MS = 60_000;

/** Added to every description: the results carry `zotero://` links the answer can cite. */
const CITATION_LINE =
    'Cite what you use with the `zotero://` links the results contain (`zotero_uri` opens the item, `open_uri` opens the PDF at that page); never make up a link.';

/** The part of the client the tools use, so tests and wiring can stand in for it. */
type ZoteroClient = Pick<AlphainZClient, 'listTools' | 'callTool'>;

export interface ZoteroToolsOptions {
    /** How long a tool listing is reused. Default 60 s. */
    ttlMs?: number;
    /**
     * Offer the tools that change the Zotero library (AlphainZ's optional
     * `create_note`). Default false: AlphainO has no review step for them yet.
     * A tool counts as read-only only when the server says so (`readOnlyHint`).
     */
    includeWriteTools?: boolean;
    /** Overrides the size limit for images passed to the model; see `convertCallResult`. */
    maxImageBase64Chars?: number;
    /** The clock, in milliseconds. */
    now?: () => number;
}

export interface ZoteroTools {
    /**
     * The tools to offer the model now, `zotero_`-prefixed. Empty when
     * AlphainZ cannot be reached, or when `signal` stops while the listing is
     * being fetched. Never rejects. A listing is reused for `ttlMs`.
     */
    schemas(signal?: AbortSignal): Promise<ToolSchema[]>;
    /**
     * A dispatcher for the `zotero_` tools. `signal` ends the request in
     * flight when the user stops the turn. A call that fails resolves to
     * `{ error }` (with the reason when Zotero is not running); only a stop
     * rejects, and so does a name that is not a Zotero tool.
     */
    dispatcher(signal?: AbortSignal): ToolDispatcher;
    /** Whether `name` is one of this module's tools (carries the prefix). */
    owns(name: string): boolean;
}

interface Listing {
    fetchedAt: number;
    schemas: ToolSchema[];
    /** The server's name for each tool offered, by the name the model sees. */
    originals: Map<string, string>;
    /** Names of the tools left out because they change the library. */
    withheld: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The model-facing name for a server tool: prefixed, in the allowed characters, at most 64 long, and unique. */
function modelName(original: string, used: Set<string>): string {
    const base = `${ZOTERO_TOOL_PREFIX}${original.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    let name = base.slice(0, MAX_TOOL_NAME_LENGTH);
    for (let n = 2; used.has(name); n += 1) {
        const suffix = `_${n}`;
        name = base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
    }
    used.add(name);
    return name;
}

/**
 * A function that rewrites the server's tool names in a text to the names the
 * model sees. AlphainZ's descriptions point at sibling tools ("use
 * `read_attachment`"), and those names no longer exist once prefixed. Only
 * names with an underscore or hyphen are rewritten: a one-word tool name would
 * also match ordinary prose.
 */
function referenceRewriter(names: Map<string, string>): (text: string) => string {
    const rewritable = [...names.keys()].filter((original) => /[_-]/.test(original));
    if (rewritable.length === 0) return (text) => text;
    const alternatives = rewritable
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|');
    const pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${alternatives})(?![A-Za-z0-9_-])`, 'g');
    return (text) => text.replace(pattern, (match) => names.get(match) ?? match);
}

/** A copy of a JSON Schema fragment with the tool names in its `description` strings rewritten. */
function rewriteDescriptions(value: unknown, rewrite: (text: string) => string): unknown {
    if (Array.isArray(value)) return value.map((item) => rewriteDescriptions(item, rewrite));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
        out[key] = key === 'description' && typeof field === 'string' ? rewrite(field) : rewriteDescriptions(field, rewrite);
    }
    return out;
}

function toSchema(tool: McpTool, name: string, rewrite: (text: string) => string): ToolSchema {
    const input = isRecord(tool.inputSchema) ? tool.inputSchema : {};
    const properties = isRecord(input.properties) ? (rewriteDescriptions(input.properties, rewrite) as Record<string, unknown>) : {};
    const required = (Array.isArray(input.required) ? input.required : []).filter(
        (key): key is string => typeof key === 'string' && Object.prototype.hasOwnProperty.call(properties, key),
    );
    const description = rewrite(tool.description ?? tool.annotations?.title ?? tool.name).trim();
    return {
        name,
        description: `${description}\n${CITATION_LINE}`,
        parameters: { type: 'object', properties, required },
    };
}

function buildListing(tools: McpTool[], includeWriteTools: boolean, fetchedAt: number): Listing {
    const used = new Set<string>();
    const seen = new Set<string>();
    const originals = new Map<string, string>();
    const withheld = new Set<string>();
    const offered: Array<{ tool: McpTool; name: string }> = [];

    for (const tool of tools) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        const name = modelName(tool.name, used);
        if (tool.annotations?.readOnlyHint !== true && !includeWriteTools) {
            withheld.add(name);
            continue;
        }
        originals.set(name, tool.name);
        offered.push({ tool, name });
    }

    const rewrite = referenceRewriter(new Map(offered.map(({ tool, name }) => [tool.name, name])));
    return {
        fetchedAt,
        schemas: offered.map(({ tool, name }) => toSchema(tool, name, rewrite)),
        originals,
        withheld,
    };
}

/** The arguments without the empty ones: a model's `null` means "not given". */
function withoutEmpty(args: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null && value !== undefined));
}

export function zoteroTools(client: ZoteroClient, options: ZoteroToolsOptions = {}): ZoteroTools {
    const ttlMs = options.ttlMs ?? LISTING_TTL_MS;
    const now = options.now ?? Date.now;
    const includeWriteTools = options.includeWriteTools === true;

    /** The latest listing, kept after it goes stale so a call can still find the server's name for a tool. */
    let listing: Listing | null = null;
    let loading: Promise<Listing | null> | null = null;

    /** Fetches the listing once however many callers ask at the same time. */
    const load = (): Promise<Listing | null> => {
        if (!loading) {
            loading = (async () => {
                try {
                    listing = buildListing(await client.listTools(), includeWriteTools, now());
                } catch {
                    // Zotero is closed or not answering: offer nothing, and let a call say why.
                    listing = null;
                }
                return listing;
            })().finally(() => {
                loading = null;
            });
        }
        return loading;
    };

    /** A fresh listing, or null when the server cannot be reached. Rejects only when `signal` stops. */
    const current = (signal?: AbortSignal): Promise<Listing | null> => {
        if (listing && now() - listing.fetchedAt < ttlMs) return Promise.resolve(listing);
        return untilAborted(load(), signal);
    };

    const owns = (name: string): boolean => name.startsWith(ZOTERO_TOOL_PREFIX);

    return {
        async schemas(signal) {
            try {
                return [...((await current(signal))?.schemas ?? [])];
            } catch {
                return [];
            }
        },

        dispatcher(signal) {
            return async (name, args) => {
                if (!owns(name)) throw new Error(`"${name}" is not a Zotero tool.`);
                const known = await current(signal);
                if (known?.withheld.has(name)) {
                    return { error: `The tool "${name}" is turned off in AlphainO because it changes the Zotero library.` };
                }
                const original = known?.originals.get(name) ?? name.slice(ZOTERO_TOOL_PREFIX.length);
                const result = await client.callTool(original, withoutEmpty(args), signal);
                return convertCallResult(result, { maxImageBase64Chars: options.maxImageBase64Chars });
            };
        },

        owns,
    };
}
