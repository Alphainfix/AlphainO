/** Search over the vault's notes: the index, its embedding model, and the stores it can keep itself in. */
export { NoteIndex, SearchUnavailableError, type NoteIndexOptions } from './noteIndex';
export {
    buildNoteEmbedder,
    embedderFromProvider,
    isEmbeddingPreset,
    type BuiltEmbedder,
    type NoteEmbedder,
    type NoteEmbedderSettings,
} from './embedder';
export { noteHeadings, splitLines } from './chunker';
export { IdbIndexStore, indexDatabaseName } from './idbStore';
export { MemoryIndexStore } from './store';
export { headingForLink, isIndexablePath, isUnderFolder, linkTarget, normalizeFolderPath, titleOf, wikilink } from './paths';
export type {
    IndexState,
    IndexStatus,
    IndexStore,
    NoteSearcher,
    SearchHit,
    SearchMode,
    SearchOptions,
    SearchResponse,
} from './types';
