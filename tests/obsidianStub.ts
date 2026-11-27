/** The few runtime pieces of the obsidian API that the tested modules touch. */
export const apiVersion = '1.15.1';
let language = 'en';
export function getLanguage(): string {
    return language;
}
/** Tests switch the interface language with this. */
export function setLanguageForTests(next: string): void {
    language = next;
}
export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

// ---------------------------------------------------------------------------
// An in-memory vault for tests of code that reads notes and follows changes.
// ---------------------------------------------------------------------------

export interface FakeNoteFile {
    path: string;
    name: string;
    basename: string;
    extension: string;
    stat: { ctime: number; mtime: number; size: number };
    parent: null;
}

export interface FakeNoteFolder {
    path: string;
    name: string;
    children: unknown[];
}

/**
 * The parts of `Vault` that note search touches. `write`, `remove` and
 * `rename` change a note and announce it the way Obsidian does; `silent`
 * changes it without an event, as an edit made while Obsidian was closed.
 */
export class FakeNoteVault {
    readonly files = new Map<string, { content: string; file: FakeNoteFile }>();
    /** How many times a note was read. */
    reads = 0;
    private clock = 1_700_000_000_000;
    private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

    constructor(private readonly name = 'Test vault') {}

    private makeFile(path: string, content: string, ctime: number): FakeNoteFile {
        const name = path.slice(path.lastIndexOf('/') + 1);
        const dot = name.lastIndexOf('.');
        this.clock += 1000;
        return {
            path,
            name,
            basename: dot > 0 ? name.slice(0, dot) : name,
            extension: dot > 0 ? name.slice(dot + 1) : '',
            stat: { ctime, mtime: this.clock, size: new TextEncoder().encode(content).length },
            parent: null,
        };
    }

    getName(): string {
        return this.name;
    }

    getMarkdownFiles(): FakeNoteFile[] {
        return [...this.files.values()].map((entry) => entry.file).filter((file) => file.extension === 'md');
    }

    getFiles(): FakeNoteFile[] {
        return [...this.files.values()].map((entry) => entry.file);
    }

    /** A file's bytes: its text, encoded (a picture in tests is a short description of what it shows). */
    reads_binary = 0;
    async readBinary(file: { path: string }): Promise<ArrayBuffer> {
        this.reads_binary += 1;
        const entry = this.files.get(file.path);
        if (!entry) throw new Error(`No such file: ${file.path}`);
        const bytes = new TextEncoder().encode(entry.content);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    folderPaths(): string[] {
        const folders = new Set<string>();
        for (const path of this.files.keys()) {
            const parts = path.split('/').slice(0, -1);
            for (let i = 1; i <= parts.length; i += 1) folders.add(parts.slice(0, i).join('/'));
        }
        return [...folders];
    }

    getFolderByPath(path: string): FakeNoteFolder | null {
        return this.folderPaths().includes(path) ? { path, name: path.slice(path.lastIndexOf('/') + 1), children: [] } : null;
    }

    getAllFolders(): FakeNoteFolder[] {
        return this.folderPaths().map((path) => ({ path, name: path.slice(path.lastIndexOf('/') + 1), children: [] }));
    }

    getAbstractFileByPath(path: string): FakeNoteFile | FakeNoteFolder | null {
        return this.files.get(path)?.file ?? this.getFolderByPath(path);
    }

    async read(file: { path: string }): Promise<string> {
        this.reads += 1;
        const entry = this.files.get(file.path);
        if (!entry) throw new Error(`No such file: ${file.path}`);
        return entry.content;
    }

    cachedRead(file: { path: string }): Promise<string> {
        return this.read(file);
    }

    on(name: string, callback: (...args: any[]) => void): { name: string; callback: (...args: any[]) => void } {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name)?.add(callback);
        return { name, callback };
    }

    offref(ref: { name: string; callback: (...args: any[]) => void }): void {
        this.listeners.get(ref.name)?.delete(ref.callback);
    }

    listenerCount(): number {
        return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
    }

    private emit(name: string, ...args: unknown[]): void {
        for (const callback of [...(this.listeners.get(name) ?? [])]) callback(...args);
    }

    /** Creates or changes a note. */
    write(path: string, content: string, options: { silent?: boolean } = {}): FakeNoteFile {
        const existing = this.files.get(path);
        const file = this.makeFile(path, content, existing?.file.stat.ctime ?? this.clock + 1000);
        // Obsidian updates a note's file object in place.
        if (existing) Object.assign(existing.file.stat, file.stat);
        const entry = existing ?? { content, file };
        entry.content = content;
        this.files.set(path, entry);
        if (!options.silent) this.emit(existing ? 'modify' : 'create', entry.file);
        return entry.file;
    }

    /** Changes the modified time without changing the text, and says nothing: a sync client touching a file. */
    touch(path: string): void {
        const entry = this.files.get(path);
        if (!entry) throw new Error(`No such file: ${path}`);
        this.clock += 1000;
        entry.file.stat.mtime = this.clock;
    }

    remove(path: string, options: { silent?: boolean } = {}): void {
        const entry = this.files.get(path);
        if (!entry) return;
        this.files.delete(path);
        if (!options.silent) this.emit('delete', entry.file);
    }

    rename(oldPath: string, newPath: string, options: { silent?: boolean } = {}): void {
        const entry = this.files.get(oldPath);
        if (!entry) throw new Error(`No such file: ${oldPath}`);
        this.files.delete(oldPath);
        const name = newPath.slice(newPath.lastIndexOf('/') + 1);
        const dot = name.lastIndexOf('.');
        const file: FakeNoteFile = {
            ...entry.file,
            path: newPath,
            name,
            basename: dot > 0 ? name.slice(0, dot) : name,
            extension: dot > 0 ? name.slice(dot + 1) : '',
            stat: { ...entry.file.stat },
        };
        this.files.set(newPath, { content: entry.content, file });
        if (!options.silent) this.emit('rename', file, oldPath);
    }

    /** Moves every note in a folder and announces the folder once, as Obsidian does. */
    renameFolder(oldFolder: string, newFolder: string): void {
        for (const path of [...this.files.keys()]) {
            if (path.startsWith(`${oldFolder}/`)) this.rename(path, `${newFolder}${path.slice(oldFolder.length)}`, { silent: true });
        }
        this.emit('rename', { path: newFolder, name: newFolder.slice(newFolder.lastIndexOf('/') + 1), children: [] }, oldFolder);
    }

    /** Deletes every note in a folder and announces the folder once. */
    removeFolder(folder: string): void {
        for (const path of [...this.files.keys()]) {
            if (path.startsWith(`${folder}/`)) this.remove(path, { silent: true });
        }
        this.emit('delete', { path: folder, name: folder.slice(folder.lastIndexOf('/') + 1), children: [] });
    }
}
