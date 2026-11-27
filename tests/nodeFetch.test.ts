import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeFetch } from '../src/agent/nodeFetch';

let server: http.Server;
let base = '';

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.url === '/stream') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            let n = 0;
            const tick = setInterval(() => {
                n += 1;
                res.write(`data: ${n}\n\n`);
                if (n === 3) {
                    clearInterval(tick);
                    res.end();
                }
            }, 20);
            return;
        }
        if (req.url === '/forever') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: first\n\n');
            return; // never ends
        }
        if (req.url === '/empty') {
            res.writeHead(204);
            res.end();
            return;
        }
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            res.writeHead(401, { 'content-type': 'application/json', 'x-echo-auth': String(req.headers.authorization) });
            res.end(JSON.stringify({ method: req.method, body }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
    server.closeAllConnections?.();
    server.close();
});

describe('nodeFetch', () => {
    it('streams the body as it arrives instead of buffering it', async () => {
        const response = await nodeFetch(`${base}/stream`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        const reader = response.body!.getReader();
        const chunks: string[] = [];
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            chunks.push(new TextDecoder().decode(value));
        }
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.join('')).toBe('data: 1\n\ndata: 2\n\ndata: 3\n\n');
    });

    it('sends the method, headers and body, and passes an error status through', async () => {
        const response = await nodeFetch(`${base}/echo`, {
            method: 'POST',
            headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' },
            body: '{"q":"bees"}',
        });
        expect(response.status).toBe(401);
        expect(response.headers.get('x-echo-auth')).toBe('Bearer k');
        expect(await response.json()).toEqual({ method: 'POST', body: '{"q":"bees"}' });
    });

    it('stops a stream when the signal aborts, with an AbortError', async () => {
        const controller = new AbortController();
        const response = await nodeFetch(`${base}/forever`, { signal: controller.signal });
        const reader = response.body!.getReader();
        await reader.read();
        controller.abort();
        await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects at once when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(nodeFetch(`${base}/stream`, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('gives a response with no body for 204', async () => {
        const response = await nodeFetch(`${base}/empty`);
        expect(response.status).toBe(204);
        expect(response.body).toBeNull();
    });
});
