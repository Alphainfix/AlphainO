/**
 * The vault's pictures as tools.
 *
 * - `search_vault_images` finds pictures by what they show, from the picture
 *   index (AlphainZ's `search_library_figures`, for the vault). Each hit says
 *   which notes show or link the picture, and how to show it in an answer.
 * - `view_vault_image` hands one picture to the chat model to look at
 *   (AlphainZ's `view_attachment_image`), offered only to a model that can see
 *   pictures.
 *
 * Excluded and hidden folders are a boundary for both, as for every tool.
 */
import type { App, TFile } from 'obsidian';
import type { ToolDispatcher, ToolImagesResult } from '@beaver/agent-llm/agentLoop';
import type { ToolSchema } from '@beaver/agent-llm/types';
import type { ImageIndex } from '../search/imageIndex';
import { extensionOf, isPicturePath, prepareImage, READABLE_IMAGE_EXTENSIONS, VIEW_IMAGE, type PreparedImage } from '../search/imagePrep';
import { hasHiddenSegment, isExcludedPath, normalizeFolderPath, wikilink } from '../search/paths';

export const IMAGE_TOOL_NAMES = ['search_vault_images', 'view_vault_image'] as const;

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;
/** Notes listed for a picture. */
const MAX_NOTES_PER_IMAGE = 5;

export const EXCLUDED_IMAGE_ERROR = 'That picture is in a folder left out of AlphainO (Settings → Excluded folders), so it cannot be looked at.';

export const SEARCH_VAULT_IMAGES: ToolSchema = {
    name: 'search_vault_images',
    description:
        "Find pictures in the user's vault — screenshots, photos, charts, diagrams, scanned pages — by what they show, described in words. " +
        'Pictures are indexed as images, so this matches what is in them, not their file names (formats this app cannot open, such as HEIC, are not indexed). ' +
        'Results are ranked by how closely they look like the description, and a weak match can still come first: ' +
        'do not say what a picture shows without having looked at it. ' +
        'Each hit lists the notes that show or link it. To show a picture in your answer, write its `embed` on a line of its own. ' +
        'For what notes say, use note_search_by_topic or search_vault_fulltext.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description:
                    'The picture described as you would to a person: what it shows, what kind of image it is (a photo, a screenshot, a chart, a hand drawing), words or labels you would expect in it. English works best; any language is matched.',
            },
            limit: { type: 'integer', description: `Maximum pictures to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
            folder: { type: 'string', description: 'Only pictures inside this folder (a path from the vault root).' },
        },
        required: ['query'],
    },
};

export const VIEW_VAULT_IMAGE: ToolSchema = {
    name: 'view_vault_image',
    description:
        "Look at a picture in the user's vault: a hit from search_vault_images, or a picture a note shows (`![[...]]`). " +
        'Call this before saying what a picture shows: its name and a search rank are not what is in it.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The picture: its path from the vault root as a search gave it, or its name as a note links it.',
            },
        },
        required: ['path'],
    },
};

export interface ImageToolsOptions {
    app: App;
    /** The picture index, or null. Asked on every call. */
    getIndex: () => ImageIndex | null;
    /** Folders the user left out. Asked on every call. */
    getExcludedFolders?: () => readonly string[];
    /** Turns a picture file into what the chat model is shown. Default: decoded and shrunk in the app. */
    prepare?: (bytes: ArrayBuffer, extension: string) => Promise<PreparedImage>;
    /**
     * How the model these results go to can look at a picture: with view_vault_image ('tool'), by opening
     * the file itself ('file', a client over MCP), or not at all ('none', a model that cannot see pictures).
     */
    looking?: 'tool' | 'file' | 'none';
}

const LOOK_HINTS: Record<NonNullable<ImageToolsOptions['looking']>, string> = {
    tool: 'Pictures, ranked by how closely they look like the description. Look at one with view_vault_image before saying what it shows.',
    file: 'Pictures, ranked by how closely they look like the description; paths are from the vault root. Open one before saying what it shows.',
    none: 'Pictures, ranked by how closely they look like the description. You cannot see pictures here: say what one shows only from the notes it appears in, and say you have not seen it; show one to the user with its embed.',
};

/** The tools to offer: the search while the picture index is on, the viewer to a model that sees pictures. */
export function imageToolSchemas(options: { search: boolean; view: boolean }): ToolSchema[] {
    return [...(options.search ? [SEARCH_VAULT_IMAGES] : []), ...(options.view ? [VIEW_VAULT_IMAGE] : [])];
}

function textArg(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function countArg(value: unknown): number | undefined {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
    const whole = Math.trunc(number);
    return whole >= 1 ? whole : undefined;
}

function isFile(file: unknown): file is TFile {
    return typeof file === 'object' && file !== null && 'extension' in file && 'stat' in file;
}

/** The notes that show or link each picture, from Obsidian's resolved links, leaving out hidden and excluded notes. */
function notesShowing(app: App, paths: readonly string[], excluded: readonly string[]): Map<string, string[]> {
    const wanted = new Set(paths);
    const found = new Map<string, string[]>();
    const links = (app.metadataCache?.resolvedLinks ?? {}) as Record<string, Record<string, number>>;
    for (const [source, targets] of Object.entries(links)) {
        if (hasHiddenSegment(source) || isExcludedPath(source, excluded)) continue;
        for (const target of Object.keys(targets)) {
            if (!wanted.has(target)) continue;
            const list = found.get(target) ?? [];
            if (list.length < MAX_NOTES_PER_IMAGE) list.push(wikilink(source));
            found.set(target, list);
        }
    }
    return found;
}

/** A picture asked for by path or by name, as a note links it. */
function locatePicture(app: App, request: string, excluded: readonly string[]): { file: TFile } | { error: string } {
    const cleaned = request.replace(/^!?\[\[|\]\]$/g, '').split('|')[0].trim();
    const direct = app.vault.getAbstractFileByPath(normalizeFolderPath(cleaned));
    const file = isFile(direct) ? direct : app.metadataCache?.getFirstLinkpathDest?.(cleaned, '') ?? null;
    if (!isFile(file) || !isPicturePath(file.path)) return { error: `No picture "${request}" in the vault. Use the path search_vault_images gave, or the name a note links.` };
    if (hasHiddenSegment(file.path) || isExcludedPath(file.path, excluded)) return { error: EXCLUDED_IMAGE_ERROR };
    if (!READABLE_IMAGE_EXTENSIONS.has(extensionOf(file.path))) {
        return { error: `${extensionOf(file.path).toUpperCase()} pictures cannot be opened here.` };
    }
    return { file };
}

export function createImageToolDispatcher(options: ImageToolsOptions): ToolDispatcher {
    // The main window's document: a popout window that closes would take its canvas along.
    const prepare = options.prepare ?? ((bytes: ArrayBuffer, extension: string) => prepareImage(bytes, extension, { ...VIEW_IMAGE, doc: document }));
    return async (name, args) => {
        const excluded = options.getExcludedFolders?.() ?? [];
        try {
            if (name === 'search_vault_images') {
                const query = textArg(args.query);
                if (!query) return { error: 'Tool "search_vault_images" requires: query.' };
                const index = options.getIndex();
                if (!index) return { error: 'Picture search is turned off in AlphainO’s settings.' };
                const folder = textArg(args.folder);
                const response = await index.search(query, { limit: Math.min(MAX_LIMIT, countArg(args.limit) ?? DEFAULT_LIMIT), ...(folder ? { folder } : {}) });
                const coverage = response.warnings.join(' ');
                if (response.hits.length === 0) return { images: [], note: `No indexed picture matched.${coverage ? ` ${coverage}` : ''}` };
                const notes = notesShowing(options.app, response.hits.map((hit) => hit.path), excluded);
                return {
                    note: LOOK_HINTS[options.looking ?? 'tool'],
                    ...(coverage ? { coverage } : {}),
                    images: response.hits.map((hit) => ({
                        path: hit.path,
                        name: hit.name,
                        similarity: Number(hit.similarity.toFixed(3)),
                        embed: `![[${hit.path}]]`,
                        shown_in: notes.get(hit.path) ?? [],
                    })),
                };
            }
            if (name === 'view_vault_image') {
                const request = textArg(args.path);
                if (!request) return { error: 'Tool "view_vault_image" requires: path.' };
                const located = locatePicture(options.app, request, excluded);
                if ('error' in located) return located;
                const bytes = await options.app.vault.readBinary(located.file);
                const image = await prepare(bytes, extensionOf(located.file.path));
                const result: ToolImagesResult = {
                    kind: 'tool-images',
                    text: `The picture ${located.file.path} (${image.width}×${image.height} as shown here). Embed it in an answer as ![[${located.file.path}]].`,
                    images: [{ mimeType: image.mimeType, base64: image.base64, label: located.file.name }],
                };
                return result;
            }
            return { error: `Unknown tool "${name}". Available tools: ${IMAGE_TOOL_NAMES.join(', ')}.` };
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    };
}
