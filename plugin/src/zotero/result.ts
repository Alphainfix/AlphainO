/**
 * An MCP tool result, in the shape the runner hands to the model.
 *
 * MCP answers with `content` blocks (text, or base64 images) and an `isError`
 * flag. The runner's loop wants a string or an object it can serialize, or a
 * `ToolImagesResult` when pixels are involved (agentLoop turns that into text
 * and image parts of the tool message, so the model can look at a page).
 */
import type { ToolImagesResult } from '@beaver/agent-llm/agentLoop';
import type { McpCallResult, McpContentPart } from './client';

/**
 * The largest image, as base64 characters, passed on to the model. Base64
 * images of about 1 MB are reported to crash Obsidian's renderer, so a larger
 * one is left out and the text says so.
 */
export const MAX_IMAGE_BASE64_CHARS = 700 * 1024;

export interface ConvertOptions {
    /** Overrides `MAX_IMAGE_BASE64_CHARS`. */
    maxImageBase64Chars?: number;
}

function isText(part: McpContentPart): part is McpContentPart & { text: string } {
    return part.type === 'text' && typeof part.text === 'string';
}

function isImage(part: McpContentPart): part is McpContentPart & { data: string; mimeType: string } {
    return (
        part.type === 'image'
        && typeof part.data === 'string'
        && part.data !== ''
        && typeof part.mimeType === 'string'
        && part.mimeType.startsWith('image/')
    );
}

/** A size in KB, or MB from 1 MB. An image over the limit is rounded up, so it never reads as no more than the limit. */
function formatSize(chars: number, round: (value: number) => number): string {
    const megabytes = chars / (1024 * 1024);
    return megabytes >= 1 ? `${(round(megabytes * 10) / 10).toFixed(1)} MB` : `${round(chars / 1024)} KB`;
}

/** The value a text block holds when it is a JSON object or array, otherwise undefined. */
function parseJsonObject(text: string): object | undefined {
    const trimmed = text.trim();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return undefined;
    try {
        const value: unknown = JSON.parse(trimmed);
        return typeof value === 'object' && value !== null ? value : undefined;
    } catch {
        // Not JSON after all, or JSON the server cut short; the model reads it as text.
        return undefined;
    }
}

/**
 * What the dispatcher returns for a finished tool call.
 *
 * - `isError`: `{ error: text }`.
 * - With images: a `ToolImagesResult` carrying the text and the images small
 *   enough to send.
 * - Otherwise the text: the parsed value when it is a JSON object or array
 *   (the loop serializes it compactly), else the string.
 *
 * Whatever is left out (an image over the size limit, a block of a kind this
 * client cannot show) is named in the text, so the model does not take a
 * partial result for the whole.
 */
export function convertCallResult(result: McpCallResult, options: ConvertOptions = {}): unknown {
    const limit = options.maxImageBase64Chars ?? MAX_IMAGE_BASE64_CHARS;
    const text = result.content.filter(isText).map((part) => part.text).join('\n\n');

    if (result.isError) return { error: text || 'The tool reported an error without saying why.' };

    const imageParts = result.content.filter((part) => part.type === 'image');
    const images: ToolImagesResult['images'] = [];
    const notes: string[] = [];
    imageParts.forEach((part, index) => {
        const position = `Image ${index + 1} of ${imageParts.length}`;
        if (!isImage(part)) {
            notes.push(`[${position} was left out: it has no image data this client can read.]`);
        } else if (part.data.length > limit) {
            const size = formatSize(part.data.length, Math.ceil);
            notes.push(`[${position} was left out: ${size} is over the ${formatSize(limit, Math.round)} limit for images sent to the model.]`);
        } else {
            images.push({ mimeType: part.mimeType, base64: part.data, label: `image ${index + 1}` });
        }
    });
    const kinds = new Set(result.content.map((part) => part.type).filter((type) => type !== 'text' && type !== 'image'));
    if (kinds.size > 0) notes.push(`[Content of type ${[...kinds].join(', ')} was left out: this client shows only text and images.]`);

    const described = [text, ...notes].filter(Boolean).join('\n\n');
    if (images.length > 0) {
        return { kind: 'tool-images', ...(described ? { text: described } : {}), images } satisfies ToolImagesResult;
    }
    if (notes.length === 0) {
        const parsed = parseJsonObject(text);
        if (parsed !== undefined) return parsed;
    }
    return described || 'The tool returned no content.';
}
