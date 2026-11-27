import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AlphainOMcpServer, MCP_PATH, bridgeScript, type McpTools } from '../src/mcp/server';

async function freePort(): Promise<number> {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
}

const tools: McpTools = {
    schemas: [
        { name: 'read_note', description: 'Read a note.', parameters: { type: 'object', properties: { note_id: { type: 'string' } }, required: ['note_id'] } },
        { name: 'add_comment', description: 'Comment.', parameters: { type: 'object', properties: {}, required: [] } },
    ],
    dispatch: async (name, args) => (name === 'read_note' && args.note_id === 'Bees' ? { text: 'Bees dance.' } : { error: 'No note found.' }),
    readOnly: (name) => name !== 'add_comment',
};

let server: AlphainOMcpServer | null = null;
afterEach(async () => {
    await server?.stop();
    server = null;
});

async function started(): Promise<number> {
    const port = await freePort();
    server = new AlphainOMcpServer({ port, version: '0.0.1', tools: () => tools, instructions: 'Use the vault tools.' });
    expect(await server.start()).toEqual({ state: 'running', port });
    return port;
}

function post(port: number, body: unknown, headers: Record<string, string> = {}, method = 'POST', pathname = MCP_PATH): Promise<{ status: number; body: string }> {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const request = http.request(
            { host: '127.0.0.1', port, path: pathname, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers } },
            (response) => {
                let data = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => (data += chunk));
                response.on('end', () => resolve({ status: response.statusCode ?? 0, body: data }));
            },
        );
        request.on('error', reject);
        request.end(text);
    });
}

describe('the MCP server for Claude', () => {
    it('answers the older handshake with the version asked for, and names itself', async () => {
        const port = await started();
        const reply = await post(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } });
        expect(reply.status).toBe(200);
        const body = JSON.parse(reply.body);
        expect(body.result).toMatchObject({ protocolVersion: '2024-11-05', serverInfo: { name: 'alphaino-obsidian' }, capabilities: { tools: {} } });
        expect(body.result.instructions).toBe('Use the vault tools.');
        const unknown = JSON.parse((await post(port, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).body);
        expect(unknown.result.protocolVersion).toBe('2026-07-28');
    });

    it('serves each request on its own, as the 2026-07-28 protocol does: tools/list and tools/call need no handshake', async () => {
        const port = await started();
        const listed = JSON.parse((await post(port, { jsonrpc: '2.0', id: 'a', method: 'tools/list' })).body);
        expect(listed.result.tools).toEqual([
            { name: 'read_note', description: 'Read a note.', inputSchema: tools.schemas[0].parameters, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
            { name: 'add_comment', description: 'Comment.', inputSchema: tools.schemas[1].parameters, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
        ]);
        const called = JSON.parse((await post(port, { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'read_note', arguments: { note_id: 'Bees' } } })).body);
        expect(called.result.isError).toBe(false);
        expect(JSON.parse(called.result.content[0].text)).toEqual({ text: 'Bees dance.' });
        const failed = JSON.parse((await post(port, { jsonrpc: '2.0', id: 'c', method: 'tools/call', params: { name: 'read_note', arguments: { note_id: 'Wasps' } } })).body);
        expect(failed.result.isError).toBe(true);
        const missing = JSON.parse((await post(port, { jsonrpc: '2.0', id: 'd', method: 'tools/call', params: { name: 'nope' } })).body);
        expect(missing.error.code).toBe(-32602);
        expect(JSON.parse((await post(port, { jsonrpc: '2.0', id: 'e', method: 'ping' })).body).result).toEqual({});
        expect(JSON.parse((await post(port, { jsonrpc: '2.0', id: 'f', method: 'resources/list' })).body).error.code).toBe(-32601);
    });

    it('acknowledges a notification with 202 and no body', async () => {
        const port = await started();
        expect(await post(port, { jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({ status: 202, body: '' });
    });

    it('refuses what could come from a web page: another Host, an Origin, a browser User-Agent', async () => {
        const port = await started();
        const call = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
        expect((await post(port, call, { Host: `evil.example:${port}` })).status).toBe(403);
        expect((await post(port, call, { Origin: 'https://evil.example' })).status).toBe(403);
        expect((await post(port, call, { 'User-Agent': 'Mozilla/5.0 (Macintosh)' })).status).toBe(403);
        // A local program that must send an Origin says so explicitly.
        expect((await post(port, call, { Origin: 'app://client', 'AlphainO-Allowed-Request': '1' })).status).toBe(200);
        expect((await post(port, call, { Host: `localhost:${port}` })).status).toBe(200);
    });

    it('answers only POST at its path, and refuses oversized bodies', async () => {
        const port = await started();
        expect((await post(port, '', {}, 'GET')).status).toBe(405);
        expect((await post(port, { jsonrpc: '2.0', id: 1, method: 'ping' }, {}, 'POST', '/other')).status).toBe(404);
        expect((await post(port, 'not json')).status).toBe(400);
        expect((await post(port, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status).toBe(400);
        expect((await post(port, 'x'.repeat(1024 * 1024 + 10))).status).toBe(413);
    });

    it('reports a port another program holds', async () => {
        const port = await started();
        const second = new AlphainOMcpServer({ port, version: '0', tools: () => tools, instructions: '' });
        const state = await second.start();
        expect(state).toMatchObject({ state: 'error', port });
        await second.stop();
    });

    it('the stdio bridge for Claude Desktop forwards each line and prints the answer', async () => {
        const port = await started();
        const dir = mkdtempSync(path.join(tmpdir(), 'alphaino-bridge-'));
        const script = path.join(dir, 'alphaino-mcp-stdio.mjs');
        writeFileSync(script, bridgeScript(port));
        const child = spawn(process.execPath, [script, String(port)], { stdio: ['pipe', 'pipe', 'inherit'] });
        const output = new Promise<string>((resolve) => {
            let data = '';
            child.stdout.on('data', (chunk) => {
                data += chunk;
                if (data.includes('\n')) resolve(data);
            });
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`);
        const line = JSON.parse((await output).trim().split('\n')[0]);
        child.stdin.end();
        expect(line.id).toBe(7);
        expect(line.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['read_note', 'add_comment']);
    });
});
