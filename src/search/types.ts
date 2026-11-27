/**
 * The shapes note search exchanges with the rest of the plugin: what a query
 * takes and returns, what the index reports, and the records it keeps.
 */

export type SearchMode = 'hybrid' | 'semantic' | 'keyword';

export interface SearchOptions {
    /** Hits to return. Default 8. */
    limit?: number;
    /** Only notes inside this folder (a vault path, without a trailing slash). */
    folder?: string;
    /** Default 'hybrid': meaning and keywords together. */
    mode?: SearchMode;
    /** Ends the request that embeds the query. */
    signal?: AbortSignal;
}

export interface SearchHit {
    /** Path of the note in the vault, with `.md`. */
    path: string;
    /** The note's name. */
    title: string;
    /** The deepest heading above the passage; '' above the first heading. */
    heading: string;
    /** All the headings above the passage, outermost first. */
    headingPath: string[];
    /** The lines of the note the passage covers, 1-based. */
    startLine: number;
    endLine: number;
    /** The passage's Markdown, cut to about 1200 characters. */
    text: string;
    /**
     * Cosine similarity for a semantic hit, BM25 for a keyword hit, and for a
     * hybrid search the fused rank scaled to (0, 1]: 1 means first in both lists.
     */
    score: number;
    /** Which ranking found it. */
    source: 'semantic' | 'keyword' | 'both';
}

export interface SearchResponse {
    hits: SearchHit[];
    /** The mode that ran: a hybrid search falls back to keyword when meaning cannot be searched. */
    mode: SearchMode;
    /** What the caller should know about the answer: a part that did not run, an index still being built. */
    warnings: string[];
}

/** The part of the index the assistant's tools use. */
export interface NoteSearcher {
    searchDetailed(query: string, options?: SearchOptions): Promise<SearchResponse>;
    status(): IndexStatus;
}

export type IndexState = 'off' | 'idle' | 'indexing' | 'paused' | 'error';

export interface IndexStatus {
    state: IndexState;
    /** The embedding model the vectors belong to; null when only keywords are indexed. */
    model: string | null;
    /** Notes that are fully indexed (and embedded, when there is a model). */
    notesIndexed: number;
    /** Notes that are searched: Markdown, not hidden, not excluded, not too big. */
    notesTotal: number;
    /** Passages in the index. */
    chunks: number;
    /** Notes waiting to be indexed or embedded. */
    pending: number;
    /** Why the index is paused or in error, as a sentence for the user. */
    lastError: string | null;
    /** When a paused index tries again, in ms since the epoch; null when it waits for the user. */
    retryAt: number | null;
}

/** One passage as stored. */
export interface StoredChunk {
    path: string;
    index: number;
    heading: string[];
    startLine: number;
    endLine: number;
    text: string;
    /** Identifies what the vector was made from (see `chunkHash`). */
    textHash: string;
    /** int8 vector; null until the passage is embedded. */
    embedding: Int8Array | null;
    /** The model that made the vector; '' when there is none. */
    model: string;
    /** Length of the vector; 0 when there is none. */
    dimensions: number;
}

/** What is stored about a note besides its passages. */
export interface NoteInfo {
    path: string;
    /** Modification time and size when the note was read. */
    mtime: number;
    size: number;
    /** Hash of the note's whole text. */
    hash: string;
    /** Set when the embedding model refused this note's passages; it is not tried again until the note changes. */
    embedError?: string;
}

export interface StoredNote extends NoteInfo {
    chunks: StoredChunk[];
}

/** What the index records about itself. */
export interface IndexMeta {
    key: 'index';
    /** The layout of the stored records. */
    schema: number;
    /** How notes were cut (`CHUNKER_VERSION`). */
    chunker: number;
    /** The embedding model of the stored vectors; null for none. */
    model: string | null;
    dimensions: number | null;
}

export interface StoredIndex {
    meta: IndexMeta | null;
    notes: StoredNote[];
}

/** One change to the stored index. */
export type StoreOp =
    /** Writes a note's row, and its passages when given (replacing the old ones). */
    | { type: 'put'; note: NoteInfo; chunks?: StoredChunk[] }
    | { type: 'delete'; path: string }
    | { type: 'meta'; meta: IndexMeta };

/** Where the index is kept between runs. */
export interface IndexStore {
    open(): Promise<void>;
    load(): Promise<StoredIndex>;
    /** Applies the changes together: all of them or none. */
    write(ops: StoreOp[]): Promise<void>;
    /** Removes everything. */
    clear(): Promise<void>;
    close(): void;
}
