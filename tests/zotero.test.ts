import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    isToolImagesResult,
    runAgentLoop,
    toolImagesToContent,
    type ToolDispatcher,
    type ToolImagesResult,
} from '@beaver/agent-llm/agentLoop';
import type { ChatProvider, ChatRequest, StreamEvent, ToolSchema } from '@beaver/agent-llm/types';
import {
    AlphainZClient,
    AlphainZError,
    DEFAULT_ZOTERO_PORT,
    ZOTERO_UNAVAILABLE_MESSAGE,
    type McpCallResult,
    type McpTool,
} from '../src/zotero/client';
import { MAX_IMAGE_BASE64_CHARS, convertCallResult } from '../src/zotero/result';
import { zoteroTools } from '../src/zotero/tools';

// ---------------------------------------------------------------------------
// A fake of AlphainZ's MCP server, on a random port
// ---------------------------------------------------------------------------

interface Seen {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    rawBody: string;
    rpc: { jsonrpc?: string; id?: number | string | null; method?: string; params?: any };
}

/** What the fake answers with. Unless `status` says otherwise, 200 like AlphainZ's. */
interface Reply {
    status?: number;
    json?: unknown;
    text?: string;
    delayMs?: number;
    /** Never answers. */
    hang?: boolean;
    /** Closes the connection without answering. */
    drop?: boolean;
    /** Writes the body in two pieces, split at this byte offset. */
    splitAt?: number;
}

interface Fake {
    port: number;
    seen: Seen[];
    /** Requests whose connection closed before the fake had answered. */
    cancelled: number;
    /** Requests dropped by the browser guard. */
    dropped: number;
    close(): Promise<void>;
}

const fakes: Fake[] = [];
const clients: AlphainZClient[] = [];

afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

/**
 * Zotero 10 drops a request that looks like a browser's unless it carries
 * `Zotero-Allowed-Request: 1`; the fake does the same, so a client that forgets
 * the header or sends an Origin fails here as it would in Zotero.
 */
function looksLikeBrowser(headers: http.IncomingHttpHeaders): boolean {
    return headers.origin !== undefined || /^Mozilla\//.test(String(headers['user-agent'] ?? ''));
}

async function startFake(handle: (seen: Seen) => Reply | Promise<Reply>): Promise<Fake> {
    const fake: Fake = { port: 0, seen: [], cancelled: 0, dropped: 0, close: async () => {} };
    const server = http.createServer((req, res) => {
        if (looksLikeBrowser(req.headers) && req.headers['zotero-allowed-request'] !== '1') {
            fake.dropped += 1;
            req.socket.destroy();
            return;
        }
        res.on('close', () => {
            if (!res.writableFinished) fake.cancelled += 1;
        });
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let rpc: Seen['rpc'] = {};
            try {
                rpc = JSON.parse(rawBody);
            } catch {
                // left empty: a handler may want to see a body that is not JSON
            }
            const seen: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, rawBody, rpc };
            fake.seen.push(seen);
            const reply = await handle(seen);
            if (reply.hang) return;
            if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
            if (res.destroyed) return;
            if (reply.drop) {
                req.socket.destroy();
                return;
            }
            const body = Buffer.from(reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json)), 'utf8');
            res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
            if (reply.splitAt !== undefined) {
                res.write(body.subarray(0, reply.splitAt));
                setTimeout(() => res.end(body.subarray(reply.splitAt)), 30);
            } else {
                res.end(body);
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    fake.port = (server.address() as AddressInfo).port;
    fake.close = () =>
        new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
        });
    fakes.push(fake);
    return fake;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

function clientFor(port: number, options: { timeoutMs?: number; probeTimeoutMs?: number } = {}): AlphainZClient {
    const client = new AlphainZClient({ port, ...options });
    clients.push(client);
    return client;
}

// ---------------------------------------------------------------------------
// AlphainZ's tools, as the fake serves them
// ---------------------------------------------------------------------------

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function def(
    name: string,
    description: string,
    properties: Record<string, unknown> = {},
    required: string[] = [],
    annotations: McpTool['annotations'] = READ_ONLY,
): McpTool {
    return { name, description, inputSchema: { type: 'object', properties, required }, annotations: { title: name, ...annotations } };
}

interface ToolEntry {
    def: McpTool;
    /** What the handler returns, before the server packs it (as `handleToolsCall` does). */
    run: (args: Record<string, any>) => unknown | Promise<unknown>;
}

const JPEG = '/9j/4AAQSkZJRgABAQ';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAA';
const ITEM = {
    item_id: 'u-ABCD1234',
    title: 'Bees and flowers',
    authors: 'Smith',
    year: 2004,
    zotero_uri: 'zotero://select/library/items/ABCD1234',
    attachments: [{ attachment_id: 'u-EFGH5678', status: 'available' }],
};

const LIBRARY: ToolEntry[] = [
    {
        def: def(
            'search_by_topic',
            "Search the user's Zotero library by topic. Each result includes attachment IDs that can be used with `read_attachment` to read full-text content.",
            {
                topic_query: { type: 'string', description: 'A concise topic phrase.' },
                tags_filter: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Zotero tags to filter results; use `list_tags` to discover them.',
                },
                limit: { type: 'integer', description: 'Max results per page.', default: 5 },
            },
            ['topic_query'],
        ),
        run: () => ({ has_more: false, next_offset: null, results: [ITEM] }),
    },
    {
        def: def(
            'read_attachment',
            'Read the text of a PDF. Get the attachment_id from `search_by_topic` or get_item_details.',
            { attachment_id: { type: 'string', description: 'As search_by_topic returns it.' } },
            ['attachment_id'],
        ),
        run: () => '<page1>\nBees visit flowers.\n</page1>',
    },
    {
        def: def(
            'view_page_images',
            'Render pages of a PDF as images.',
            { attachment_id: { type: 'string' }, pages: { type: 'array', items: { type: 'integer' } } },
            ['attachment_id'],
        ),
        run: () => ({
            content: [
                { type: 'text', text: 'Rendered pages 3, 4. Document has 12 pages total.' },
                { type: 'image', data: JPEG, mimeType: 'image/jpeg' },
                { type: 'image', data: PNG, mimeType: 'image/png' },
            ],
        }),
    },
    {
        def: def('view_attachment_image', 'Look at an image file. For a page of a PDF, use view_page_images.', { attachment_id: { type: 'string' } }, ['attachment_id']),
        run: () => 'not used',
    },
    {
        def: def('list_tags', 'List tags in the library.', { name_query: { type: 'string', description: 'Only tags containing this text.' } }),
        run: () => ({ tags: [{ tag: 'bees', item_count: 3 }] }),
    },
    {
        def: def('create_note', 'Create a Zotero note.', { title: { type: 'string' }, content: { type: 'string' } }, ['title', 'content'], WRITES),
        run: () => 'Created.',
    },
];

/** The server's `handleToolsCall` packing: a string is text, `{content}` passes through, anything else is pretty-printed JSON. */
function pack(value: unknown): unknown {
    if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
    if (value && Array.isArray((value as { content?: unknown }).content)) return value;
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** AlphainZ's `mcpService.ts`, in behaviour: stateless, no handshake required, errors as HTTP 200. */
function alphainz(tools: ToolEntry[] = LIBRARY): (seen: Seen) => Promise<Reply> {
    return async ({ rpc }) => {
        if (rpc.id === undefined || rpc.id === null) return { status: 202, text: '' };
        const ok = (result: unknown): Reply => ({ json: { jsonrpc: '2.0', id: rpc.id, result } });
        const fail = (message: string): Reply => ({ json: { jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message } } });
        switch (rpc.method) {
            case 'initialize':
                return ok({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'alphainz-zotero', version: '1.0.0' } });
            case 'ping':
                return ok({});
            case 'tools/list':
                return ok({ tools: tools.map((entry) => entry.def) });
            case 'tools/call': {
                if (!rpc.params?.name) return fail('Missing tool name');
                const entry = tools.find((candidate) => candidate.def.name === rpc.params.name);
                if (!entry) return fail(`Unknown tool: ${rpc.params.name}`);
                return ok(pack(await entry.run(rpc.params.arguments ?? {})));
            }
            default:
                return fail(`Method not found: ${rpc.method}`);
        }
    };
}

const callsTo = (fake: Fake, tool: string) => fake.seen.filter((s) => s.rpc.method === 'tools/call' && s.rpc.params?.name === tool);
const listings = (fake: Fake) => fake.seen.filter((s) => s.rpc.method === 'tools/list');

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

describe('AlphainZClient', () => {
    it('is only believable because the fake drops what Zotero 10 drops', async () => {
        const fake = await startFake(alphainz());
        const attempt = (headers: Record<string, string>) =>
            new Promise<number | undefined>((resolve, reject) => {
                const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
                const req = http.request(
                    { host: '127.0.0.1', port: fake.port, method: 'POST', path: '/alphainz/mcp', agent: false, headers: { 'content-type': 'application/json', 'content-length': body.length, ...headers } },
                    (res) => { res.resume(); resolve(res.statusCode); },
                );
                req.on('error', reject);
                req.end(body);
            });
        // What Obsidian's own fetch sends: an Origin header.
        await expect(attempt({ origin: 'app://obsidian.md' })).rejects.toThrow(/socket hang up|ECONNRESET/);
        await expect(attempt({ 'user-agent': 'Mozilla/5.0 (Macintosh)' })).rejects.toThrow(/socket hang up|ECONNRESET/);
        expect(fake.dropped).toBe(2);
        // The same request with the allow header goes through.
        await expect(attempt({ origin: 'app://obsidian.md', 'zotero-allowed-request': '1' })).resolves.toBe(200);
    });

    it('sends the allow header, a byte-accurate Content-Length, no Origin and a non-browser User-Agent', async () => {
        const fake = await startFake(alphainz());
        const result = await clientFor(fake.port).callTool('read_attachment', { attachment_id: '蜜蜂 🐝' });
        expect(result.isError).toBeUndefined();

        const [request] = fake.seen;
        expect(fake.dropped).toBe(0);
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/alphainz/mcp');
        expect(request.headers['zotero-allowed-request']).toBe('1');
        expect(request.headers['content-type']).toBe('application/json');
        expect(request.headers.origin).toBeUndefined();
        expect(request.headers['user-agent']).toBe('AlphainO');
        // Characters and bytes differ for this body; the header counts bytes.
        expect(request.rawBody.length).toBeLessThan(Buffer.byteLength(request.rawBody));
        expect(request.headers['content-length']).toBe(String(Buffer.byteLength(request.rawBody)));
        expect(request.headers['transfer-encoding']).toBeUndefined();
        expect(request.rpc.params.arguments.attachment_id).toBe('蜜蜂 🐝');
    });

    it('sends JSON-RPC 2.0 requests with their own increasing ids', async () => {
        const fake = await startFake(alphainz());
        const client = clientFor(fake.port);
        await client.listTools();
        await client.callTool('list_tags', {});
        await client.available();
        expect(fake.seen.map((s) => s.rpc.jsonrpc)).toEqual(['2.0', '2.0', '2.0']);
        const ids = fake.seen.map((s) => s.rpc.id as number);
        expect(ids.every((id) => typeof id === 'number')).toBe(true);
        expect(new Set(ids).size).toBe(3);
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
    });

    it('needs no handshake: the server is stateless, so none is sent', async () => {
        const fake = await startFake(alphainz());
        const client = clientFor(fake.port);
        expect(await client.available()).toBe(true);
        expect((await client.listTools()).length).toBe(LIBRARY.length);
        await client.callTool('list_tags', {});
        // No `initialize`, no notification (a message without an id): every request is a plain call.
        expect(fake.seen.map((s) => s.rpc.method)).toEqual(['ping', 'tools/list', 'tools/call']);
        expect(fake.seen.every((s) => s.rpc.id !== undefined)).toBe(true);
    });

    it('lists the tools with their schemas and annotations', async () => {
        const fake = await startFake(alphainz());
        const tools = await clientFor(fake.port).listTools();
        expect(tools.map((tool) => tool.name)).toEqual(LIBRARY.map((entry) => entry.def.name));
        const search = tools.find((tool) => tool.name === 'search_by_topic')!;
        expect(search.inputSchema?.required).toEqual(['topic_query']);
        expect(search.annotations?.readOnlyHint).toBe(true);
    });

    it('keeps only the entries of a listing that are tools', async () => {
        const fake = await startFake(({ rpc }) => ({
            json: { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'ok' }, { nope: 1 }, 'text', null, { name: '' }] } },
        }));
        expect((await clientFor(fake.port).listTools()).map((tool) => tool.name)).toEqual(['ok']);
    });

    it('answers whether the server is there', async () => {
        const up = await startFake(alphainz());
        expect(await clientFor(up.port).available()).toBe(true);

        expect(await clientFor(await closedPort()).available()).toBe(false);

        const off = await startFake(() => ({ status: 404, text: 'No endpoint found' }));
        expect(await clientFor(off.port).available()).toBe(false);

        const stuck = await startFake(() => ({ hang: true }));
        expect(await clientFor(stuck.port, { probeTimeoutMs: 40 }).available()).toBe(false);
    });

    it('defaults to Zotero’s port and ignores a port that cannot be one', () => {
        expect(new AlphainZClient().port).toBe(DEFAULT_ZOTERO_PORT);
        expect(new AlphainZClient({ port: 23120 }).port).toBe(23120);
        for (const port of [0, -1, 70000, 1.5, Number.NaN]) expect(new AlphainZClient({ port }).port).toBe(DEFAULT_ZOTERO_PORT);
    });

    describe('when Zotero is not running', () => {
        it('turns a refused connection into a tool result that says so, and does not throw', async () => {
            const client = clientFor(await closedPort());
            const result = await client.callTool('search_by_topic', { topic_query: 'bees' });
            expect(result).toEqual({ content: [{ type: 'text', text: ZOTERO_UNAVAILABLE_MESSAGE }], isError: true });
            expect(ZOTERO_UNAVAILABLE_MESSAGE).toBe("Zotero is not running, or AlphainZ's MCP server is turned off in its settings");
        });

        it('rejects a listing with an AlphainZError that carries the same words', async () => {
            const client = clientFor(await closedPort());
            const error = await client.listTools().catch((e: unknown) => e);
            expect(error).toBeInstanceOf(AlphainZError);
            expect(error).toMatchObject({ kind: 'unavailable', message: ZOTERO_UNAVAILABLE_MESSAGE });
        });

        it('says the same when Zotero answers but the MCP endpoint is not registered', async () => {
            const fake = await startFake(() => ({ status: 404, text: 'No endpoint found' }));
            const client = clientFor(fake.port);
            expect(await client.callTool('list_tags')).toMatchObject({ isError: true, content: [{ text: ZOTERO_UNAVAILABLE_MESSAGE }] });
            await expect(client.listTools()).rejects.toMatchObject({ kind: 'unavailable' });
        });
    });

    describe('when the answer is not a normal one', () => {
        it('reports an error the server returns as a tool result with the server’s words', async () => {
            const fake = await startFake(alphainz());
            const result = await clientFor(fake.port).callTool('no_such_tool', {});
            expect(result).toEqual({ content: [{ type: 'text', text: 'Unknown tool: no_such_tool' }], isError: true });
        });

        it('rejects a listing the server answers with an error', async () => {
            const fake = await startFake(({ rpc }) => ({ json: { jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'boom' } } }));
            await expect(clientFor(fake.port).listTools()).rejects.toMatchObject({ kind: 'failed', message: 'boom' });
        });

        it('names the HTTP status of any other failure', async () => {
            const fake = await startFake(() => ({ status: 500, text: 'Internal Server Error' }));
            const result = await clientFor(fake.port).callTool('list_tags');
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('HTTP 500');
            expect(result.content[0].text).toContain('Internal Server Error');
        });

        it('does not take an unreadable answer for a result', async () => {
            const notJson = await startFake(() => ({ text: '<html>proxy</html>' }));
            expect(await clientFor(notJson.port).callTool('list_tags')).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('not valid JSON') }] });

            const wrongId = await startFake(() => ({ json: { jsonrpc: '2.0', id: 999999, result: { content: [] } } }));
            expect(await clientFor(wrongId.port).callTool('list_tags')).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('not the JSON-RPC reply') }] });
        });

        it('reports a connection that closes without an answer', async () => {
            const fake = await startFake(() => ({ drop: true }));
            const result = await clientFor(fake.port).callTool('list_tags');
            expect(result).toMatchObject({ isError: true, content: [{ text: 'Zotero closed the connection without answering.' }] });
        });

        it('wraps a result that has no content blocks as text', async () => {
            const fake = await startFake(({ rpc }) => ({ json: { jsonrpc: '2.0', id: rpc.id, result: { odd: true } } }));
            expect(await clientFor(fake.port).callTool('list_tags')).toEqual({ content: [{ type: 'text', text: '{"odd":true}' }] });
        });

        it('reads an answer whose characters arrive split across chunks', async () => {
            const text = '蜜蜂采蜜';
            const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } });
            const at = Buffer.from(body).indexOf(Buffer.from('蜂')) + 1; // inside the 3-byte character
            const fake = await startFake(({ rpc }) => ({
                text: body.replace('"id":1', `"id":${rpc.id}`),
                splitAt: at,
            }));
            const result = await clientFor(fake.port).callTool('list_tags');
            expect(result.content[0].text).toBe(text);
        });
    });

    describe('timeouts and stopping', () => {
        it('gives up on a call after its timeout and says so in the result', async () => {
            const fake = await startFake(() => ({ hang: true }));
            const started = Date.now();
            const result = await clientFor(fake.port, { timeoutMs: 60 }).callTool('read_attachment', { attachment_id: 'u-X' });
            expect(Date.now() - started).toBeLessThan(1000);
            expect(result).toMatchObject({ isError: true, content: [{ text: 'AlphainZ did not answer within 60 ms.' }] });
            await vi.waitFor(() => expect(fake.cancelled).toBe(1));
        });

        it('rejects a listing that is not answered in time with a timeout error', async () => {
            const fake = await startFake(() => ({ hang: true }));
            await expect(clientFor(fake.port, { probeTimeoutMs: 60 }).listTools()).rejects.toMatchObject({ kind: 'timeout' });
        });

        it('gives a tool call longer than a listing', async () => {
            const fake = await startFake(async (seen) => {
                const reply = await alphainz()(seen);
                return { ...reply, delayMs: 120 };
            });
            const client = clientFor(fake.port, { timeoutMs: 1000, probeTimeoutMs: 40 });
            await expect(client.listTools()).rejects.toMatchObject({ kind: 'timeout' });
            expect((await client.callTool('list_tags', {})).isError).toBeUndefined();
        });

        it('stops a call in flight when the signal aborts, and closes the connection', async () => {
            const fake = await startFake(() => ({ hang: true }));
            const controller = new AbortController();
            const call = clientFor(fake.port).callTool('read_attachment', { attachment_id: 'u-X' }, controller.signal);
            await vi.waitFor(() => expect(fake.seen.length).toBe(1));
            controller.abort();
            await expect(call).rejects.toMatchObject({ name: 'AbortError' });
            await vi.waitFor(() => expect(fake.cancelled).toBe(1));
        });

        it('sends nothing when the signal is already aborted', async () => {
            const fake = await startFake(alphainz());
            const controller = new AbortController();
            controller.abort();
            const client = clientFor(fake.port);
            await expect(client.callTool('list_tags', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
            await expect(client.listTools(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
            expect(await client.available(controller.signal)).toBe(false);
            expect(fake.seen).toHaveLength(0);
        });

        it('ends requests in flight and refuses new ones once disposed', async () => {
            const fake = await startFake(() => ({ hang: true }));
            const client = clientFor(fake.port);
            const call = client.callTool('read_attachment', { attachment_id: 'u-X' });
            await vi.waitFor(() => expect(fake.seen.length).toBe(1));
            client.dispose();
            await expect(call).rejects.toMatchObject({ name: 'AbortError' });
            await expect(client.callTool('list_tags', {})).rejects.toMatchObject({ name: 'AbortError' });
            expect(await client.available()).toBe(false);
            expect(fake.seen).toHaveLength(1);
        });
    });
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const text = (value: string) => ({ type: 'text', text: value });
const image = (data: string, mimeType = 'image/jpeg') => ({ type: 'image', data, mimeType });
const result = (...content: McpCallResult['content']): McpCallResult => ({ content });

describe('convertCallResult', () => {
    it('gives plain text as a string', () => {
        expect(convertCallResult(result(text('<page1>Bees.</page1>')))).toBe('<page1>Bees.</page1>');
    });

    it('gives the parsed value when the text is a JSON object or array', () => {
        expect(convertCallResult(result(text(JSON.stringify({ results: [ITEM] }, null, 2))))).toEqual({ results: [ITEM] });
        expect(convertCallResult(result(text('[1, 2]')))).toEqual([1, 2]);
    });

    it('keeps the string when the text only looks like JSON', () => {
        for (const raw of ['{"results": [', '42', 'true', 'null', '"quoted"', '{"cut":"short"}\n…[truncated 4000 characters]']) {
            expect(convertCallResult(result(text(raw)))).toBe(raw);
        }
    });

    it('joins several text blocks', () => {
        expect(convertCallResult(result(text('one'), text('two')))).toBe('one\n\ntwo');
    });

    it('says so when a result holds nothing', () => {
        expect(convertCallResult(result())).toBe('The tool returned no content.');
    });

    it('turns isError into { error } with the text', () => {
        expect(convertCallResult({ content: [text('Search failed: boom')], isError: true })).toEqual({ error: 'Search failed: boom' });
        expect(convertCallResult({ content: [], isError: true })).toEqual({ error: 'The tool reported an error without saying why.' });
        // A failing call is not shown as its images.
        expect(convertCallResult({ content: [text('Render failed'), image(JPEG)], isError: true })).toEqual({ error: 'Render failed' });
    });

    it('gives images in the shape the loop turns into image parts', () => {
        const value = convertCallResult(result(text('Rendered pages 3, 4.'), image(JPEG), image(PNG, 'image/png')));
        expect(isToolImagesResult(value)).toBe(true);
        expect(toolImagesToContent(value as ToolImagesResult)).toEqual([
            { type: 'text', text: 'Rendered pages 3, 4.' },
            { type: 'image', mimeType: 'image/jpeg', base64: JPEG, label: 'image 1' },
            { type: 'image', mimeType: 'image/png', base64: PNG, label: 'image 2' },
        ]);
    });

    it('leaves the text out of an image result when there is none, and lets the loop word it', () => {
        const value = convertCallResult(result(image(JPEG))) as ToolImagesResult;
        expect(value).not.toHaveProperty('text');
        expect(toolImagesToContent(value)[0]).toEqual({ type: 'text', text: '1 image returned.' });
    });

    it('leaves out an image over the size limit and says which', () => {
        const big = 'A'.repeat(MAX_IMAGE_BASE64_CHARS + 1);
        const value = convertCallResult(result(text('Rendered pages 3, 4.'), image(JPEG), image(big))) as ToolImagesResult;
        expect(isToolImagesResult(value)).toBe(true);
        expect(value.images.map((i) => i.base64)).toEqual([JPEG]);
        expect(value.text).toBe(
            'Rendered pages 3, 4.\n\n[Image 2 of 2 was left out: 701 KB is over the 700 KB limit for images sent to the model.]',
        );
    });

    it('keeps an image exactly at the limit', () => {
        const edge = 'A'.repeat(MAX_IMAGE_BASE64_CHARS);
        const value = convertCallResult(result(image(edge))) as ToolImagesResult;
        expect(value.images).toHaveLength(1);
    });

    it('falls back to the text, with the note, when every image is too large', () => {
        const value = convertCallResult(result(text('Rendered page 3.'), image('A'.repeat(2 * 1024 * 1024))));
        expect(typeof value).toBe('string');
        expect(value).toContain('Rendered page 3.');
        expect(value).toContain('Image 1 of 1 was left out: 2.0 MB is over the 700 KB limit');
    });

    it('does not parse text that has a note appended', () => {
        const value = convertCallResult(result(text('{"pages":[3]}'), image('A'.repeat(MAX_IMAGE_BASE64_CHARS + 5))));
        expect(typeof value).toBe('string');
        expect(value).toContain('{"pages":[3]}');
    });

    it('takes its own limit from the options', () => {
        // JPEG is 18 characters, the other 100.
        const value = convertCallResult(result(image(JPEG), image('A'.repeat(100))), { maxImageBase64Chars: 50 }) as ToolImagesResult;
        expect(value.images.map((i) => i.base64)).toEqual([JPEG]);
        expect(value.text).toContain('Image 2 of 2 was left out');
        expect(convertCallResult(result(image('A'.repeat(100))), { maxImageBase64Chars: 200 })).toHaveProperty('kind', 'tool-images');
    });

    it('rounds a size over the limit up, so it never reads as within it', () => {
        const note = (chars: number, limit: number) =>
            convertCallResult(result(image('A'.repeat(chars))), { maxImageBase64Chars: limit }) as string;
        expect(note(716_801, 716_800)).toContain('701 KB is over the 700 KB limit');
        expect(note(3 * 1024 * 1024 + 1, 3 * 1024 * 1024)).toContain('3.1 MB is over the 3.0 MB limit');
    });

    it('names what it cannot show instead of dropping it silently', () => {
        const value = convertCallResult(result(text('Here.'), { type: 'audio', data: 'x', mimeType: 'audio/wav' }, { type: 'image', mimeType: 'image/png' }, image(PNG, 'application/pdf')));
        expect(typeof value).toBe('string');
        expect(value).toContain('Here.');
        expect(value).toContain('Image 1 of 2 was left out: it has no image data');
        expect(value).toContain('Image 2 of 2 was left out: it has no image data');
        expect(value).toContain('Content of type audio was left out');
    });
});

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

describe('zoteroTools', () => {
    async function setup(tools: ToolEntry[] = LIBRARY, options: Parameters<typeof zoteroTools>[1] = {}) {
        const fake = await startFake(alphainz(tools));
        const client = clientFor(fake.port);
        return { fake, client, zotero: zoteroTools(client, options) };
    }

    describe('schemas', () => {
        it('prefixes every name with zotero_ and keeps the schema', async () => {
            const { zotero } = await setup();
            const schemas = await zotero.schemas();
            // create_note changes the library, so it is not offered unless asked for.
            expect(schemas.map((s) => s.name)).toEqual([
                'zotero_search_by_topic',
                'zotero_read_attachment',
                'zotero_view_page_images',
                'zotero_view_attachment_image',
                'zotero_list_tags',
            ]);
            const search = schemas[0];
            expect(search.parameters.type).toBe('object');
            expect(Object.keys(search.parameters.properties)).toEqual(['topic_query', 'tags_filter', 'limit']);
            expect(search.parameters.required).toEqual(['topic_query']);
            expect(search.parameters.properties.limit).toEqual({ type: 'integer', description: 'Max results per page.', default: 5 });
            const tags = schemas.find((s) => s.name === 'zotero_list_tags')!;
            expect(tags.parameters.required).toEqual([]);
        });

        it('uses only the characters a function name may have, at most 64', async () => {
            const odd = (name: string): ToolEntry => ({ def: def(name, `The ${name} tool.`), run: () => name });
            const long = 'x'.repeat(80);
            const { zotero } = await setup([odd('weird.name'), odd('a b'), odd(long), odd(`${long}y`), odd('x.y'), odd('x_y'), odd('ünï')]);
            const names = (await zotero.schemas()).map((s) => s.name);
            expect(names).toHaveLength(7);
            expect(new Set(names).size).toBe(7);
            for (const name of names) {
                expect(name).toMatch(/^zotero_[a-zA-Z0-9_-]+$/);
                expect(name.length).toBeLessThanOrEqual(64);
            }
            expect(names[0]).toBe('zotero_weird_name');
            expect(names[1]).toBe('zotero_a_b');
        });

        it('still reaches the right server tool when a name had to be changed', async () => {
            const odd = (name: string): ToolEntry => ({ def: def(name, 'Odd.'), run: () => `ran ${name}` });
            const { fake, zotero } = await setup([odd('x.y'), odd('x_y')]);
            const [dotted, underscored] = (await zotero.schemas()).map((s) => s.name);
            expect(dotted).not.toBe(underscored);
            const dispatch = zotero.dispatcher();
            expect(await dispatch(dotted, {}, { toolCallId: 'c1' })).toBe('ran x.y');
            expect(await dispatch(underscored, {}, { toolCallId: 'c2' })).toBe('ran x_y');
            expect(fake.seen.filter((s) => s.rpc.method === 'tools/call').map((s) => s.rpc.params.name)).toEqual(['x.y', 'x_y']);
        });

        it('adds the citation line to every description', async () => {
            const { zotero } = await setup();
            const schemas = await zotero.schemas();
            expect(schemas.length).toBeGreaterThan(0);
            for (const schema of schemas) {
                const lines = schema.description.split('\n');
                const last = lines[lines.length - 1];
                expect(last).toContain('`zotero://` links');
                expect(last).toContain('never make up a link');
            }
            expect(schemas[0].description).toContain("Search the user's Zotero library by topic.");
        });

        it('points the descriptions at the prefixed names', async () => {
            const { zotero } = await setup();
            const schemas = await zotero.schemas();
            const byName = Object.fromEntries(schemas.map((s) => [s.name, s]));
            // Backticked and bare mentions, in tool descriptions and in parameter descriptions.
            expect(byName.zotero_search_by_topic.description).toContain('used with `zotero_read_attachment` to read');
            expect(JSON.stringify(byName.zotero_search_by_topic.parameters)).toContain('use `zotero_list_tags` to discover');
            expect(byName.zotero_read_attachment.description).toContain('from `zotero_search_by_topic` or get_item_details');
            expect(JSON.stringify(byName.zotero_read_attachment.parameters)).toContain('As zotero_search_by_topic returns it.');
            expect(byName.zotero_view_attachment_image.description).toContain('use zotero_view_page_images.');
            // No mention of a server name is left without its prefix.
            const everything = JSON.stringify(schemas);
            for (const original of ['search_by_topic', 'read_attachment', 'view_page_images', 'list_tags']) {
                expect(everything).not.toMatch(new RegExp(`(?<!zotero_)${original}`));
            }
        });

        it('does not rewrite plain words or names that already carry the prefix', async () => {
            const tools: ToolEntry[] = [
                { def: def('search', 'Search the library; search sparingly. Related: zotero_list_tags and list_tags.'), run: () => 'x' },
                { def: def('list_tags', 'Lists tags.'), run: () => 'x' },
            ];
            const { zotero } = await setup(tools);
            const [search, listTags] = await zotero.schemas();
            expect(search.name).toBe('zotero_search');
            expect(search.description).toContain('Search the library; search sparingly. Related: zotero_list_tags and zotero_list_tags.');
            expect(listTags.name).toBe('zotero_list_tags');
        });

        it('lists only required parameters that exist, and tolerates a missing schema', async () => {
            const tools: ToolEntry[] = [
                { def: { name: 'bare', annotations: READ_ONLY }, run: () => 'x' },
                { def: def('odd_required', 'Odd.', { a: { type: 'string' } }, ['a', 'ghost']), run: () => 'x' },
            ];
            const { zotero } = await setup(tools);
            const [bare, odd] = await zotero.schemas();
            expect(bare).toMatchObject({ name: 'zotero_bare', parameters: { type: 'object', properties: {}, required: [] } });
            expect(bare.description.split('\n')[0]).toBe('bare');
            expect(odd.parameters.required).toEqual(['a']);
        });

        it('is empty, without throwing, when Zotero is not running', async () => {
            const zotero = zoteroTools(clientFor(await closedPort()));
            expect(await zotero.schemas()).toEqual([]);
        });

        it('is empty when the MCP endpoint is not registered, and when the answer is garbage', async () => {
            const off = await startFake(() => ({ status: 404, text: 'No endpoint found' }));
            expect(await zoteroTools(clientFor(off.port)).schemas()).toEqual([]);
            const junk = await startFake(() => ({ text: 'nope' }));
            expect(await zoteroTools(clientFor(junk.port)).schemas()).toEqual([]);
        });

        it('is empty, quickly, when the signal stops it', async () => {
            const fake = await startFake(() => ({ hang: true }));
            const controller = new AbortController();
            const zotero = zoteroTools(clientFor(fake.port));
            const pending = zotero.schemas(controller.signal);
            await vi.waitFor(() => expect(fake.seen.length).toBe(1));
            controller.abort();
            expect(await pending).toEqual([]);
        });

        it('hands out a copy, so a caller cannot change the cached list', async () => {
            const { zotero } = await setup();
            const first = await zotero.schemas();
            first.length = 0;
            expect((await zotero.schemas()).length).toBe(5);
        });
    });

    describe('the listing cache', () => {
        it('asks the server once while the listing is fresh and again after the time to live', async () => {
            let clock = 1_000_000;
            const { fake, zotero } = await setup(LIBRARY, { now: () => clock, ttlMs: 60_000 });
            await zotero.schemas();
            await zotero.schemas();
            clock += 59_000;
            await zotero.schemas();
            expect(listings(fake)).toHaveLength(1);
            clock += 1_001;
            await zotero.schemas();
            expect(listings(fake)).toHaveLength(2);
        });

        it('defaults to about a minute', async () => {
            let clock = 5_000;
            const { fake, zotero } = await setup(LIBRARY, { now: () => clock });
            await zotero.schemas();
            clock += 59_999;
            await zotero.schemas();
            expect(listings(fake)).toHaveLength(1);
            clock += 2;
            await zotero.schemas();
            expect(listings(fake)).toHaveLength(2);
        });

        it('asks once however many turns ask at the same moment', async () => {
            const fake = await startFake(async (seen) => ({ ...(await alphainz()(seen)), delayMs: 40 }));
            const zotero = zoteroTools(clientFor(fake.port));
            const all = await Promise.all([zotero.schemas(), zotero.schemas(), zotero.schemas()]);
            expect(listings(fake)).toHaveLength(1);
            expect(all.map((schemas) => schemas.length)).toEqual([5, 5, 5]);
        });

        it('offers nothing once Zotero has gone, and the tools again when it is back', async () => {
            let mode: 'up' | 'down' = 'up';
            let clock = 0;
            const up = alphainz();
            const fake = await startFake((seen) => (mode === 'up' ? up(seen) : { drop: true }));
            const zotero = zoteroTools(clientFor(fake.port), { now: () => clock });
            expect((await zotero.schemas()).length).toBe(5);
            mode = 'down';
            clock += 61_000;
            expect(await zotero.schemas()).toEqual([]);
            // No stale listing is served in its place.
            expect(await zotero.schemas()).toEqual([]);
            mode = 'up';
            expect((await zotero.schemas()).length).toBe(5);
        });
    });

    describe('the dispatcher', () => {
        it('strips the prefix, calls the tool with the arguments, and gives the parsed JSON', async () => {
            const { fake, zotero } = await setup();
            const value = await zotero.dispatcher()('zotero_search_by_topic', { topic_query: 'bees', limit: 3 }, { toolCallId: 'c1' });
            expect(value).toEqual({ has_more: false, next_offset: null, results: [ITEM] });
            const [call] = callsTo(fake, 'search_by_topic');
            expect(call.rpc.params).toEqual({ name: 'search_by_topic', arguments: { topic_query: 'bees', limit: 3 } });
        });

        it('keeps the item keys and zotero:// links in what it returns', async () => {
            const { zotero } = await setup();
            const value = (await zotero.dispatcher()('zotero_search_by_topic', { topic_query: 'bees' }, { toolCallId: 'c1' })) as { results: Array<Record<string, any>> };
            expect(value.results[0].item_id).toBe('u-ABCD1234');
            expect(value.results[0].zotero_uri).toBe('zotero://select/library/items/ABCD1234');
            expect(value.results[0].attachments[0].attachment_id).toBe('u-EFGH5678');
        });

        it('gives text that is not JSON as a string', async () => {
            const { zotero } = await setup();
            expect(await zotero.dispatcher()('zotero_read_attachment', { attachment_id: 'u-EFGH5678' }, { toolCallId: 'c1' })).toBe('<page1>\nBees visit flowers.\n</page1>');
        });

        it('leaves out arguments the model sent as null', async () => {
            const { fake, zotero } = await setup();
            await zotero.dispatcher()('zotero_search_by_topic', { topic_query: 'bees', limit: null, tags_filter: undefined, offset: 0 }, { toolCallId: 'c1' });
            expect(callsTo(fake, 'search_by_topic')[0].rpc.params.arguments).toEqual({ topic_query: 'bees', offset: 0 });
        });

        it('gives images as an image result the loop can read', async () => {
            const { zotero } = await setup();
            const value = await zotero.dispatcher()('zotero_view_page_images', { attachment_id: 'u-EFGH5678', pages: [3, 4] }, { toolCallId: 'c1' });
            expect(isToolImagesResult(value)).toBe(true);
            expect(toolImagesToContent(value as ToolImagesResult)).toEqual([
                { type: 'text', text: 'Rendered pages 3, 4. Document has 12 pages total.' },
                { type: 'image', mimeType: 'image/jpeg', base64: JPEG, label: 'image 1' },
                { type: 'image', mimeType: 'image/png', base64: PNG, label: 'image 2' },
            ]);
        });

        it('leaves out an oversized image, over a real connection, and says so', async () => {
            const big = 'A'.repeat(MAX_IMAGE_BASE64_CHARS + 1024);
            const tools: ToolEntry[] = [
                {
                    def: def('view_page_images', 'Render pages.', { attachment_id: { type: 'string' } }, ['attachment_id']),
                    run: () => ({ content: [text('Rendered pages 1, 2.'), image(JPEG), image(big)] }),
                },
            ];
            const { zotero } = await setup(tools);
            const value = (await zotero.dispatcher()('zotero_view_page_images', { attachment_id: 'u-X' }, { toolCallId: 'c1' })) as ToolImagesResult;
            expect(value.images).toHaveLength(1);
            expect(value.images[0].base64).toBe(JPEG);
            expect(value.text).toContain('Image 2 of 2 was left out: 701 KB is over the 700 KB limit');
        });

        it('returns { error } when the server flags the result as an error', async () => {
            const tools: ToolEntry[] = [
                { def: def('search_by_metadata', 'Search.'), run: () => ({ content: [text('Search failed: no embedding model')], isError: true }) },
            ];
            const { zotero } = await setup(tools);
            const value = await zotero.dispatcher()('zotero_search_by_metadata', {}, { toolCallId: 'c1' });
            expect(value).toEqual({ error: 'Search failed: no embedding model' });
        });

        it('returns the server’s own words for a tool it does not have', async () => {
            const { zotero } = await setup();
            expect(await zotero.dispatcher()('zotero_made_up', {}, { toolCallId: 'c1' })).toEqual({ error: 'Unknown tool: made_up' });
        });

        it('says Zotero is not running, as a result and not a throw, when it is not', async () => {
            const zotero = zoteroTools(clientFor(await closedPort()));
            const value = await zotero.dispatcher()('zotero_search_by_topic', { topic_query: 'bees' }, { toolCallId: 'c1' });
            expect(value).toEqual({ error: ZOTERO_UNAVAILABLE_MESSAGE });
        });

        it('says so too when Zotero closed after the tools were listed', async () => {
            const fake = await startFake(alphainz());
            const zotero = zoteroTools(clientFor(fake.port));
            await zotero.schemas();
            await fake.close();
            const value = await zotero.dispatcher()('zotero_list_tags', {}, { toolCallId: 'c1' });
            expect(value).toEqual({ error: ZOTERO_UNAVAILABLE_MESSAGE });
        });

        it('knows which names are its own, and throws for another', async () => {
            const { fake, zotero } = await setup();
            expect(zotero.owns('zotero_list_tags')).toBe(true);
            expect(zotero.owns('read_note')).toBe(false);
            expect(zotero.owns('list_tags')).toBe(false);
            await expect(zotero.dispatcher()('read_note', {}, { toolCallId: 'c1' })).rejects.toThrow('"read_note" is not a Zotero tool.');
            expect(fake.seen).toHaveLength(0);
        });

        it('stops the request in flight when the turn is stopped', async () => {
            const tools: ToolEntry[] = [{ def: def('read_attachment', 'Read.'), run: () => new Promise(() => {}) }];
            const { fake, zotero } = await setup(tools);
            const controller = new AbortController();
            const dispatch = zotero.dispatcher(controller.signal);
            const pending = dispatch('zotero_read_attachment', {}, { toolCallId: 'c1' });
            await vi.waitFor(() => expect(callsTo(fake, 'read_attachment')).toHaveLength(1));
            controller.abort();
            await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
            await vi.waitFor(() => expect(fake.cancelled).toBe(1));
        });

        it('is assignable to the loop’s ToolDispatcher', async () => {
            const { zotero } = await setup();
            const dispatch: ToolDispatcher = zotero.dispatcher();
            expect(typeof dispatch).toBe('function');
        });
    });

    describe('tools that change the library', () => {
        it('are not offered, and a call to one never reaches Zotero', async () => {
            const { fake, zotero } = await setup();
            expect((await zotero.schemas()).map((s) => s.name)).not.toContain('zotero_create_note');
            const value = await zotero.dispatcher()('zotero_create_note', { title: 'T', content: 'C' }, { toolCallId: 'c1' });
            expect(value).toEqual({ error: expect.stringContaining('turned off in AlphainO') });
            expect(callsTo(fake, 'create_note')).toHaveLength(0);
        });

        it('are blocked whichever way the model reaches them', async () => {
            const { fake, zotero } = await setup();
            // Before any listing was taken, the dispatcher takes one itself.
            const value = await zotero.dispatcher()('zotero_create_note', { title: 'T', content: 'C' }, { toolCallId: 'c1' });
            expect(value).toMatchObject({ error: expect.any(String) });
            expect(callsTo(fake, 'create_note')).toHaveLength(0);
        });

        it('count as writing unless the server says read-only', async () => {
            const tools: ToolEntry[] = [
                { def: { name: 'no_hint', description: 'No annotations at all.' }, run: () => 'x' },
                { def: def('hinted_false', 'Says false.', {}, [], { readOnlyHint: false }), run: () => 'x' },
                { def: def('hinted_true', 'Says true.'), run: () => 'x' },
            ];
            const { zotero } = await setup(tools);
            expect((await zotero.schemas()).map((s) => s.name)).toEqual(['zotero_hinted_true']);
        });

        it('are offered and run when asked for', async () => {
            const { fake, zotero } = await setup(LIBRARY, { includeWriteTools: true });
            expect((await zotero.schemas()).map((s) => s.name)).toContain('zotero_create_note');
            expect(await zotero.dispatcher()('zotero_create_note', { title: 'T', content: 'C' }, { toolCallId: 'c1' })).toBe('Created.');
            expect(callsTo(fake, 'create_note')).toHaveLength(1);
        });
    });
});

// ---------------------------------------------------------------------------
// Through the real agent loop
// ---------------------------------------------------------------------------

describe('in the agent loop', () => {
    type Step = (emit: (event: StreamEvent) => void) => void;

    function scripted(steps: Step[], seen: ChatRequest[] = []): ChatProvider {
        let turn = 0;
        return {
            label: 'Fake',
            model: 'fake-1',
            wireFormat: 'openai',
            async stream(request, onEvent) {
                seen.push({ ...request, messages: [...request.messages] });
                const step = steps[turn++];
                if (step) step(onEvent);
                else onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
            },
        };
    }

    const callTool = (name: string, args: Record<string, unknown>): Step => (emit) => {
        const call = { index: 0, id: 'call-1', name, argumentsJson: JSON.stringify(args) };
        emit({ type: 'tool_call_start', index: 0, id: call.id, name });
        emit({ type: 'done', stopReason: 'tool_calls', toolCalls: [call] });
    };
    const answer = (words: string): Step => (emit) => {
        emit({ type: 'text', text: words });
        emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
    };

    async function run(port: number, tool: string, args: Record<string, unknown>) {
        const zotero = zoteroTools(clientFor(port));
        const tools: ToolSchema[] = await zotero.schemas();
        const requests: ChatRequest[] = [];
        const events: Array<{ type: string; ok?: boolean; name?: string; summary?: string }> = [];
        const outcome = await runAgentLoop([{ role: 'user', content: 'What do I have on bees?' }], {
            provider: scripted([callTool(tool, args), answer('Smith 2004 covers it.')], requests),
            tools,
            dispatch: zotero.dispatcher(),
            onEvent: (event) => events.push(event as never),
        });
        const toolMessage = outcome.messages.find((message) => message.role === 'tool');
        return { outcome, requests, events, toolMessage, tools };
    }

    it('offers the prefixed tools and feeds a JSON result back as compact JSON', async () => {
        const fake = await startFake(alphainz());
        const { outcome, requests, events, toolMessage } = await run(fake.port, 'zotero_search_by_topic', { topic_query: 'bees', limit: null });

        expect(outcome.reason).toBe('completed');
        expect(outcome.text).toBe('Smith 2004 covers it.');
        expect(requests[0].tools?.map((t) => t.name)).toContain('zotero_search_by_topic');
        expect(toolMessage).toMatchObject({ role: 'tool', toolCallId: 'call-1', name: 'zotero_search_by_topic' });
        const content = (toolMessage as { content: string }).content;
        expect(content).toBe(JSON.stringify({ has_more: false, next_offset: null, results: [ITEM] }));
        expect(content).toContain('zotero://select/library/items/ABCD1234');
        expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, name: 'zotero_search_by_topic' });
        // Nothing was sent for the null limit.
        expect(callsTo(fake, 'search_by_topic')[0].rpc.params.arguments).toEqual({ topic_query: 'bees' });
    });

    it('feeds page images back as image parts of the tool message', async () => {
        const fake = await startFake(alphainz());
        const { outcome, toolMessage } = await run(fake.port, 'zotero_view_page_images', { attachment_id: 'u-EFGH5678', pages: [3, 4] });
        expect(outcome.reason).toBe('completed');
        expect((toolMessage as { content: unknown }).content).toEqual([
            { type: 'text', text: 'Rendered pages 3, 4. Document has 12 pages total.' },
            { type: 'image', mimeType: 'image/jpeg', base64: JPEG, label: 'image 1' },
            { type: 'image', mimeType: 'image/png', base64: PNG, label: 'image 2' },
        ]);
    });

    it('lets the turn carry on when Zotero closed after the tools were listed', async () => {
        const fake = await startFake(alphainz());
        const zotero = zoteroTools(clientFor(fake.port));
        const tools = await zotero.schemas();
        await fake.close();
        const outcome = await runAgentLoop([{ role: 'user', content: 'What do I have on bees?' }], {
            provider: scripted([callTool('zotero_search_by_topic', { topic_query: 'bees' }), answer('Zotero is closed, so I cannot look.')]),
            tools,
            dispatch: zotero.dispatcher(),
        });
        expect(outcome.reason).toBe('completed');
        const toolMessage = outcome.messages.find((message) => message.role === 'tool') as { content: string };
        expect(JSON.parse(toolMessage.content)).toEqual({ error: ZOTERO_UNAVAILABLE_MESSAGE });
        expect(outcome.text).toBe('Zotero is closed, so I cannot look.');
    });

    it('runs a plain chat turn without Zotero: no tools are offered', async () => {
        const zotero = zoteroTools(clientFor(await closedPort()));
        const requests: ChatRequest[] = [];
        const outcome = await runAgentLoop([{ role: 'user', content: 'Hello' }], {
            provider: scripted([answer('Hi.')], requests),
            tools: await zotero.schemas(),
            dispatch: zotero.dispatcher(),
        });
        expect(outcome.reason).toBe('completed');
        expect(requests[0].tools).toEqual([]);
    });
});
