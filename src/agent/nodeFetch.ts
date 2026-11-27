/**
 * `fetch` over Node's http/https, for model requests.
 *
 * Obsidian's own `fetch` runs in the renderer, so every request carries the
 * app's origin and is subject to CORS: a provider that sends no CORS headers
 * cannot be reached at all. `requestUrl` avoids CORS but buffers the whole
 * response, which would turn every streamed answer into one block at the end.
 * Node's client has neither problem, and the desktop app has it (AlphainO is
 * desktop-only). The result is a standard `Response` with a streaming body, so
 * the shared model layer reads it exactly as it reads a browser response.
 */
import * as http from 'http';
import * as https from 'https';

type HeadersLike = Record<string, string> | Headers | Array<[string, string]> | undefined;

export interface NodeFetchInit {
    method?: string;
    headers?: HeadersLike;
    body?: string | Uint8Array | ArrayBuffer | null;
    signal?: AbortSignal | null;
}

function headerRecord(headers: HeadersLike): Record<string, string> {
    const out: Record<string, string> = {};
    if (!headers) return out;
    if (typeof (headers as Headers).forEach === 'function' && !Array.isArray(headers)) {
        (headers as Headers).forEach((value, name) => { out[name.toLowerCase()] = value; });
        return out;
    }
    const entries = Array.isArray(headers) ? headers : Object.entries(headers);
    for (const [name, value] of entries) out[name.toLowerCase()] = String(value);
    return out;
}

function bodyBytes(body: NodeFetchInit['body']): Uint8Array | undefined {
    if (body == null) return undefined;
    if (typeof body === 'string') return new TextEncoder().encode(body);
    return body instanceof Uint8Array ? body : new Uint8Array(body);
}

function abortError(signal: AbortSignal): Error {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}

/** Statuses whose response has no body; `new Response` refuses one for them. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export function nodeFetch(input: string | URL, init: NodeFetchInit = {}): Promise<Response> {
    const url = new URL(String(input));
    const client = url.protocol === 'http:' ? http : https;
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = headerRecord(init.headers);
    const body = bodyBytes(init.body);
    if (body && headers['content-length'] === undefined) headers['content-length'] = String(body.byteLength);
    const signal = init.signal ?? undefined;

    return new Promise<Response>((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError(signal));
            return;
        }
        const request = client.request(url, { method, headers }, (response) => {
            const status = response.statusCode ?? 0;
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
                if (value === undefined) continue;
                for (const one of Array.isArray(value) ? value : [value]) responseHeaders.append(name, one);
            }
            let stream: ReadableStream<Uint8Array> | null = null;
            if (NULL_BODY_STATUS.has(status) || method === 'HEAD') {
                response.resume();
            } else {
                let settled = false;
                stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        response.on('data', (chunk: Buffer) => {
                            if (!settled) controller.enqueue(new Uint8Array(chunk));
                        });
                        response.on('end', () => {
                            if (settled) return;
                            settled = true;
                            controller.close();
                        });
                        const fail = (error: Error) => {
                            if (settled) return;
                            settled = true;
                            controller.error(signal?.aborted ? abortError(signal) : error);
                        };
                        response.on('error', fail);
                        // A connection cut after the headers ends the body without 'end'.
                        response.on('close', () => fail(new Error('The connection closed before the response finished.')));
                    },
                    cancel() {
                        settled = true;
                        response.destroy();
                    },
                });
            }
            resolve(new Response(stream, {
                status: status >= 200 && status <= 599 ? status : 502,
                statusText: response.statusMessage ?? '',
                headers: responseHeaders,
            }));
        });
        request.on('error', (error) => reject(signal?.aborted ? abortError(signal) : error));
        signal?.addEventListener('abort', () => request.destroy(abortError(signal)), { once: true });
        if (body) request.write(body);
        request.end();
    });
}
