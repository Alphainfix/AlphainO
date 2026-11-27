/**
 * AlphainO's MCP server: the vault's tools for Claude (Claude Code over HTTP,
 * Claude Desktop through the stdio bridge), the way AlphainZ serves the
 * Zotero library at `/alphainz/mcp`.
 *
 * It is off until turned on in the settings, listens on 127.0.0.1 only, and
 * has no token. What keeps other programs' web pages out instead:
 * - the Host header must name this computer on this port (no DNS rebinding);
 * - a request that looks like it comes from a browser (an Origin header, or a
 *   browser's User-Agent) is refused unless it carries
 *   `AlphainO-Allowed-Request`, which a page cannot send without a CORS
 *   preflight this server never answers;
 * - nothing answers OPTIONS, so no page gets CORS permission.
 * Programs on this computer can read the vault's files directly anyway, so a
 * token would add no protection against them.
 *
 * Every request stands alone (Streamable HTTP, JSON responses, no session):
 * the 2026-07-28 protocol needs no handshake, and the older ones get theirs.
 */
import * as http from 'http';
import type { ToolDispatcher } from '@beaver/agent-llm/agentLoop';
import type { ToolSchema } from '@beaver/agent-llm/types';

export const MCP_PATH = '/alphaino/mcp';
export const MCP_SERVER_NAME = 'alphaino-obsidian';
export const DEFAULT_MCP_PORT = 23129;
export const ALLOW_HEADER = 'alphaino-allowed-request';
/** Newest first; an `initialize` naming one of these gets it back, anything else the newest. */
export const SUPPORTED_PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpTools {
    schemas: ToolSchema[];
    dispatch: ToolDispatcher;
    /** Whether a tool only reads (MCP's `readOnlyHint`). */
    readOnly(name: string): boolean;
}

export interface McpServerOptions {
    port: number;
    version: string;
    /** The tools on offer, asked on every request. */
    tools: () => McpTools;
    /** What the client is told about the server (`initialize`'s `instructions`). */
    instructions: string;
    log?: (message: string) => void;
}

export type McpServerState = { state: 'stopped' } | { state: 'running'; port: number } | { state: 'error'; port: number; message: string };

interface JsonRpcRequest {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
}

export class AlphainOMcpServer {
    private server: http.Server | null = null;
    private current: McpServerState = { state: 'stopped' };
    private readonly listeners = new Set<(state: McpServerState) => void>();

    constructor(private readonly options: McpServerOptions) {}

    get state(): McpServerState {
        return this.current;
    }

    onStateChange(listener: (state: McpServerState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async start(): Promise<McpServerState> {
        await this.stop();
        const port = this.options.port;
        const server = http.createServer((request, response) => void this.handle(request, response));
        await new Promise<void>((resolve) => {
            server.once('error', (error: NodeJS.ErrnoException) => {
                const message = error.code === 'EADDRINUSE' ? `Port ${port} is in use by another program.` : String(error.message ?? error);
                this.set({ state: 'error', port, message });
                resolve();
            });
            server.listen(port, '127.0.0.1', () => {
                this.server = server;
                this.set({ state: 'running', port });
                resolve();
            });
        });
        return this.current;
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = null;
        if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            server.closeAllConnections?.();
        }
        if (this.current.state !== 'stopped') this.set({ state: 'stopped' });
    }

    private set(state: McpServerState): void {
        this.current = state;
        for (const listener of this.listeners) listener(state);
    }

    /** Whether a request may be served at all (see the module comment). */
    refusal(headers: http.IncomingHttpHeaders): string | null {
        const port = this.options.port;
        const host = String(headers.host ?? '').toLowerCase();
        if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return 'This server answers only requests addressed to this computer.';
        const allowed = headers[ALLOW_HEADER] !== undefined;
        const browserLike = headers.origin !== undefined || /^mozilla\//i.test(String(headers['user-agent'] ?? ''));
        if (browserLike && !allowed) return 'Requests from web pages are not accepted.';
        return null;
    }

    private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        const send = (status: number, body?: unknown, extra: Record<string, string> = {}) => {
            const text = body === undefined ? '' : JSON.stringify(body);
            response.writeHead(status, { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra });
            response.end(text);
        };
        const refused = this.refusal(request.headers);
        if (refused) return send(403, { error: refused });
        const path = (request.url ?? '').split('?')[0];
        if (path !== MCP_PATH && path !== '/mcp') return send(404, { error: `Not found. The MCP endpoint is ${MCP_PATH}.` });
        if (request.method !== 'POST') return send(405, { error: 'Use POST.' }, { Allow: 'POST' });

        let raw = '';
        let size = 0;
        try {
            await new Promise<void>((resolve, reject) => {
                request.setEncoding('utf8');
                request.on('data', (chunk: string) => {
                    size += Buffer.byteLength(chunk);
                    if (size > MAX_BODY_BYTES) reject(new Error('too large'));
                    else raw += chunk;
                });
                request.on('end', () => resolve());
                request.on('error', reject);
            });
        } catch {
            return send(413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'The request is too large.' } });
        }

        let message: JsonRpcRequest;
        try {
            message = JSON.parse(raw);
        } catch {
            return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } });
        }
        if (Array.isArray(message) || !message || typeof message !== 'object') {
            return send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send one JSON-RPC request per POST.' } });
        }
        // A notification (no id) is acknowledged with no body.
        if (message.id === undefined || message.id === null) return send(202);
        const reply = await this.answer(message);
        send(200, { jsonrpc: '2.0', id: message.id, ...reply });
    }

    /** The result (or error) for one request. */
    async answer(message: JsonRpcRequest): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
        const params = message.params ?? {};
        switch (message.method) {
            case 'initialize': {
                const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
                return {
                    result: {
                        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: { name: MCP_SERVER_NAME, title: 'AlphainO (Obsidian)', version: this.options.version },
                        instructions: this.options.instructions,
                    },
                };
            }
            case 'ping':
                return { result: {} };
            case 'tools/list': {
                const tools = this.options.tools();
                return {
                    result: {
                        tools: tools.schemas.map((schema) => ({
                            name: schema.name,
                            description: schema.description,
                            inputSchema: schema.parameters,
                            annotations: {
                                readOnlyHint: tools.readOnly(schema.name),
                                destructiveHint: false,
                                openWorldHint: false,
                            },
                        })),
                    },
                };
            }
            case 'tools/call': {
                const name = typeof params.name === 'string' ? params.name : '';
                const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
                const tools = this.options.tools();
                if (!tools.schemas.some((schema) => schema.name === name)) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
                try {
                    const value = await tools.dispatch(name, args, { toolCallId: `mcp-${Date.now().toString(36)}` });
                    const failed = Boolean(value && typeof value === 'object' && 'error' in (value as Record<string, unknown>));
                    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
                    return { result: { content: [{ type: 'text', text }], isError: failed } };
                } catch (error) {
                    this.options.log?.(`MCP tool ${name} failed: ${String(error)}`);
                    return { result: { content: [{ type: 'text', text: `The tool failed: ${String((error as Error)?.message ?? error)}` }], isError: true } };
                }
            }
            default:
                return { error: { code: -32601, message: `Method not found: ${message.method ?? ''}` } };
        }
    }
}

/**
 * The bridge Claude Desktop runs as a stdio MCP server: it hands each line to
 * AlphainO's HTTP endpoint (AlphainZ ships the same bridge for Zotero).
 */
export function bridgeScript(port: number): string {
    return String.raw`#!/usr/bin/env node
// AlphainO MCP stdio bridge
// Connects MCP clients that speak stdio (e.g. Claude Desktop) to AlphainO's endpoint in Obsidian.
// Written by AlphainO. Do not edit; it is rewritten when the settings change.
//
// Usage: node alphaino-mcp-stdio.mjs [port]
import { createInterface } from "node:readline";
import { request } from "node:http";

const PORT = process.argv[2] || process.env.ALPHAINO_MCP_PORT || "${port}";

function post(body) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port: PORT,
      path: "${MCP_PATH}",
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const isNotification = msg.id === undefined || msg.id === null;
  try {
    const response = await post(line);
    if (!isNotification && response) process.stdout.write(response + "\n");
  } catch (err) {
    if (!isNotification) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "Cannot reach AlphainO in Obsidian. Is Obsidian open, with the MCP server on in AlphainO's settings? (" + err.message + ")" },
      }) + "\n");
    }
  }
});
rl.on("close", () => process.exit(0));
`;
}
