/**
 * A client for AlphainZ's MCP server, which runs inside Zotero.
 *
 * What the server does (AlphainZ's `mcpService.ts`):
 * - `POST http://127.0.0.1:<port>/alphainz/mcp`, one JSON-RPC 2.0 message per
 *   request, answered in the response body. Protocol version 2024-11-05.
 * - It keeps no session. `tools/list` and `tools/call` work without an
 *   `initialize` first, so this client sends no handshake.
 * - A failure the server reports is still HTTP 200, with a JSON-RPC `error`
 *   member. AlphainZ registers the endpoint only while its "MCP server"
 *   setting is on, so an HTTP 404 (Zotero answers, has no such endpoint) is
 *   reported like a refused connection.
 *
 * Zotero 10 drops requests that look like a browser's (an `Origin` header, or a
 * `User-Agent` that starts with `Mozilla/`) unless they carry
 * `Zotero-Allowed-Request: 1`. Obsidian's `fetch` always sends
 * `Origin: app://obsidian.md`, so requests go through Node's `http` module
 * (AlphainO is desktop-only) with that header and no `Origin`.
 */
import * as http from 'http';

export const DEFAULT_ZOTERO_PORT = 23119;
export const MCP_PATH = '/alphainz/mcp';

/** What a tool call reports when nothing answers on Zotero's port, or the MCP endpoint is not there. */
export const ZOTERO_UNAVAILABLE_MESSAGE = "Zotero is not running, or AlphainZ's MCP server is turned off in its settings";

/** A tool call may read a long PDF, which AlphainZ allows up to 60 s. */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** Listing the tools or checking the server must not hold up a chat turn when Zotero is stuck. */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpTool {
    name: string;
    description?: string;
    inputSchema?: {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
    };
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
}

/** One block of a tool result: `text`, or `image` (base64 `data` and its `mimeType`). */
export interface McpContentPart {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
}

export interface McpCallResult {
    content: McpContentPart[];
    isError?: boolean;
}

export interface AlphainZClientOptions {
    /** Zotero's HTTP port. Default 23119. */
    port?: number;
    /** How long a tool call may take before it is given up on. Default 120 s. */
    timeoutMs?: number;
    /** How long listing the tools or checking the server may take. Default 5 s. */
    probeTimeoutMs?: number;
}

/**
 * Why a request to AlphainZ failed.
 * - `unavailable`: nothing listens on the port, or the MCP endpoint is not registered.
 * - `timeout`: no complete answer in time.
 * - `failed`: anything else (a dropped connection, an HTTP error, an unreadable answer, an error from the server).
 *
 * `message` is written to be shown, to the model or to the user.
 */
export class AlphainZError extends Error {
    constructor(readonly kind: 'unavailable' | 'timeout' | 'failed', message: string) {
        super(message);
        this.name = 'AlphainZError';
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortError(signal: AbortSignal): Error {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}

function describeDuration(ms: number): string {
    return ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`;
}

function positive(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function networkError(error: NodeJS.ErrnoException): AlphainZError {
    if (error.code === 'ECONNREFUSED') return new AlphainZError('unavailable', ZOTERO_UNAVAILABLE_MESSAGE);
    if (error.code === 'ECONNRESET') {
        return new AlphainZError('failed', 'Zotero closed the connection without answering.');
    }
    return new AlphainZError('failed', `Could not reach AlphainZ in Zotero (${error.code ?? error.message}).`);
}

/** A failed call as a tool result, the way the server reports its own failures. */
function errorResult(message: string): McpCallResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

/** The `result` of a tools/call answer, with anything unreadable dropped. */
function normalizeCallResult(result: unknown): McpCallResult {
    if (!isRecord(result) || !Array.isArray(result.content)) {
        return { content: [{ type: 'text', text: JSON.stringify(result) ?? 'null' }] };
    }
    const content = result.content.filter(
        (part): part is McpContentPart => isRecord(part) && typeof part.type === 'string',
    );
    return { content, ...(result.isError === true ? { isError: true } : {}) };
}

/** The `result` of a decoded HTTP answer, or the reason it is not one. */
function readAnswer(status: number, text: string, id: number): unknown {
    if (status === 404) throw new AlphainZError('unavailable', ZOTERO_UNAVAILABLE_MESSAGE);
    if (status !== 200) {
        const detail = text.trim().replace(/\s+/g, ' ').slice(0, 200);
        throw new AlphainZError('failed', `Zotero answered HTTP ${status}${detail ? `: ${detail}` : ''}.`);
    }
    let message: unknown;
    try {
        message = JSON.parse(text);
    } catch {
        throw new AlphainZError('failed', "AlphainZ's answer was not valid JSON.");
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0' || message.id !== id) {
        throw new AlphainZError('failed', "AlphainZ's answer was not the JSON-RPC reply to this request.");
    }
    if (isRecord(message.error)) {
        const reported = message.error.message;
        throw new AlphainZError(
            'failed',
            typeof reported === 'string' && reported ? reported : `AlphainZ reported error ${String(message.error.code)}.`,
        );
    }
    if (!('result' in message)) throw new AlphainZError('failed', "AlphainZ's answer had no result.");
    return message.result;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AlphainZClient {
    readonly port: number;
    private readonly timeoutMs: number;
    private readonly probeTimeoutMs: number;
    private lastId = 0;
    /** Aborted by `dispose()`, which ends every request still in flight. */
    private readonly lifetime = new AbortController();

    constructor(options: AlphainZClientOptions = {}) {
        const port = options.port;
        this.port = typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_ZOTERO_PORT;
        this.timeoutMs = positive(options.timeoutMs, DEFAULT_CALL_TIMEOUT_MS);
        this.probeTimeoutMs = positive(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
    }

    /** Whether the MCP server answers. Never throws. */
    async available(signal?: AbortSignal): Promise<boolean> {
        try {
            await this.request('ping', undefined, this.probeTimeoutMs, signal);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * The tools the server offers now. The server leaves a tool out when its
     * settings rule it out (a search with no embedding model set up), so the
     * list can change.
     *
     * Rejects with an `AlphainZError` when the server cannot be reached or
     * answers badly, and with an `AbortError` when stopped.
     */
    async listTools(signal?: AbortSignal): Promise<McpTool[]> {
        const result = await this.request('tools/list', undefined, this.probeTimeoutMs, signal);
        const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
        return tools.filter((tool): tool is McpTool => isRecord(tool) && typeof tool.name === 'string' && tool.name !== '');
    }

    /**
     * Runs one tool. A failure of any kind (Zotero not running, a timeout, an
     * error the server reports) comes back as a result with `isError` set and
     * the reason as text, which is what the model should read. Only a stop
     * rejects, with an `AbortError`.
     */
    async callTool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<McpCallResult> {
        try {
            const result = await this.request('tools/call', { name, arguments: args }, this.timeoutMs, signal);
            return normalizeCallResult(result);
        } catch (error) {
            if (error instanceof AlphainZError) return errorResult(error.message);
            throw error;
        }
    }

    /** Ends the requests in flight and refuses new ones. Call it when the plugin unloads. */
    dispose(): void {
        this.lifetime.abort();
    }

    /**
     * One JSON-RPC request over its own connection (`Connection: close`, no
     * shared agent), so a connection Zotero has already closed is never reused.
     * Resolves with the `result`.
     */
    private request(method: string, params: unknown, timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
        const id = ++this.lastId;
        const body = new TextEncoder().encode(
            JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
        );

        return new Promise<unknown>((resolve, reject) => {
            const sources = [signal, this.lifetime.signal].filter((source): source is AbortSignal => source !== undefined);
            const stopped = sources.find((source) => source.aborted);
            if (stopped) {
                reject(abortError(stopped));
                return;
            }

            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let request: http.ClientRequest | undefined;
            const detach = sources.map((source) => {
                const onAbort = () => fail(abortError(source));
                source.addEventListener('abort', onAbort, { once: true });
                return () => source.removeEventListener('abort', onAbort);
            });
            const settle = () => {
                settled = true;
                clearTimeout(timer);
                for (const off of detach) off();
            };
            const fail = (error: Error) => {
                if (settled) return;
                settle();
                request?.destroy();
                reject(error);
            };
            const succeed = (value: unknown) => {
                if (settled) return;
                settle();
                resolve(value);
            };

            timer = setTimeout(
                () => fail(new AlphainZError('timeout', `AlphainZ did not answer within ${describeDuration(timeoutMs)}.`)),
                timeoutMs,
            );

            request = http.request(
                {
                    host: '127.0.0.1',
                    port: this.port,
                    path: MCP_PATH,
                    method: 'POST',
                    agent: false,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': body.byteLength,
                        Accept: 'application/json',
                        'User-Agent': 'AlphainO',
                        'Zotero-Allowed-Request': '1',
                        Connection: 'close',
                    },
                },
                (response) => {
                    // Decoded as a stream, so a character split across two chunks stays whole.
                    const decoder = new TextDecoder();
                    let text = '';
                    response.on('data', (chunk: Uint8Array) => {
                        text += decoder.decode(chunk, { stream: true });
                    });
                    response.on('end', () => {
                        text += decoder.decode();
                        try {
                            succeed(readAnswer(response.statusCode ?? 0, text, id));
                        } catch (error) {
                            fail(error instanceof Error ? error : new Error(String(error)));
                        }
                    });
                    response.on('error', (error) => fail(networkError(error)));
                    // A connection cut mid-answer closes without 'end'.
                    response.on('close', () => fail(new AlphainZError('failed', 'The connection to Zotero closed before the answer was complete.')));
                },
            );
            request.on('error', (error) => fail(networkError(error)));
            request.end(body);
        });
    }
}
