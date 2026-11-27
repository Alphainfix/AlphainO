/**
 * Pictures in the vault: which files are pictures, and turning one into a
 * JPEG small enough to send — for the picture index (a modest size, what an
 * embedding model needs) and for showing one to the chat model (larger, but
 * under the size past which a base64 picture slows Obsidian to a crawl).
 *
 * Decoding uses the app's own image decoder (Chromium): PNG, JPEG, GIF (the
 * first frame), WebP, BMP, AVIF and SVG. HEIC and TIFF, which phones and
 * scanners produce, cannot be decoded here; they are counted, not indexed.
 */

/** Pictures the app can decode. */
export const READABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg']);
/** Pictures it cannot: they are listed as left out, so the count says why they are not found. */
export const UNREADABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['heic', 'heif', 'tif', 'tiff']);

const MIME_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
};

/** The file's extension, lower case, without the dot. */
export function extensionOf(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Whether the file is a picture of any kind, readable here or not. */
export function isPicturePath(path: string): boolean {
    const extension = extensionOf(path);
    return READABLE_IMAGE_EXTENSIONS.has(extension) || UNREADABLE_IMAGE_EXTENSIONS.has(extension);
}

export interface PreparedImage {
    mimeType: string;
    base64: string;
    /** Size as sent, in pixels. */
    width: number;
    height: number;
}

/** A picture this app cannot decode: its format, or a broken file. */
export class UnreadableImageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnreadableImageError';
    }
}

export interface PrepareOptions {
    /** The longest side of the result, in pixels. */
    maxSide: number;
    /** Most bytes of the result: the quality, then the size, are lowered until it fits. */
    maxBytes?: number;
    /** The document to draw in. Default: the active one. */
    doc?: Document;
}

/** For the picture index: what an embedding model looks at. */
export const INDEX_IMAGE: Pick<PrepareOptions, 'maxSide' | 'maxBytes'> = { maxSide: 1024, maxBytes: 400 * 1024 };
/** For the chat model: enough to read a screenshot, under what Obsidian takes in its stride. */
export const VIEW_IMAGE: Pick<PrepareOptions, 'maxSide' | 'maxBytes'> = { maxSide: 1568, maxBytes: 512 * 1024 };

function base64Bytes(dataUrl: string): number {
    const comma = dataUrl.indexOf(',');
    return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}

async function decode(bytes: ArrayBuffer, extension: string, doc: Document): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
    const type = MIME_TYPES[extension];
    if (!type) throw new UnreadableImageError(`${extension.toUpperCase()} pictures cannot be opened here.`);
    const blob = new Blob([bytes], { type });
    if (extension === 'svg') {
        // A drawing has no pixels of its own: draw it through an <img>.
        const view = doc.defaultView ?? window;
        const url = view.URL.createObjectURL(blob);
        const img = doc.createElement('img');
        img.src = url;
        try {
            await img.decode();
        } catch {
            view.URL.revokeObjectURL(url);
            throw new UnreadableImageError('The drawing could not be read.');
        }
        return { source: img, width: img.naturalWidth || 1024, height: img.naturalHeight || 1024, release: () => view.URL.revokeObjectURL(url) };
    }
    try {
        const bitmap = await createImageBitmap(blob);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
        throw new UnreadableImageError('The picture could not be read: the file is damaged, or in a form this app cannot open.');
    }
}

/**
 * The picture as a JPEG no longer than `maxSide` on its longest side (never
 * enlarged), on white (a transparent PNG would otherwise turn black), and
 * under `maxBytes` when given.
 */
export async function prepareImage(bytes: ArrayBuffer, extension: string, options: PrepareOptions): Promise<PreparedImage> {
    const doc = options.doc ?? (typeof activeDocument !== 'undefined' ? activeDocument : document);
    const image = await decode(bytes, extension, doc);
    try {
        if (image.width < 1 || image.height < 1) throw new UnreadableImageError('The picture is empty.');
        let side = Math.min(options.maxSide, Math.max(image.width, image.height));
        for (let attempt = 0; attempt < 6; attempt += 1) {
            const scale = side / Math.max(image.width, image.height);
            const width = Math.max(1, Math.round(image.width * scale));
            const height = Math.max(1, Math.round(image.height * scale));
            const canvas = doc.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('No canvas to draw the picture on.');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, width, height);
            context.drawImage(image.source, 0, 0, width, height);
            for (const quality of [0.85, 0.7, 0.55]) {
                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                if (!options.maxBytes || base64Bytes(dataUrl) <= options.maxBytes) {
                    return { mimeType: 'image/jpeg', base64: dataUrl.slice(dataUrl.indexOf(',') + 1), width, height };
                }
            }
            side = Math.max(64, Math.floor(side * 0.75));
        }
        throw new Error('The picture could not be made small enough to send.');
    } finally {
        image.release();
    }
}
