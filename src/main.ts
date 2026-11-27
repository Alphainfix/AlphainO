/**
 * AlphainO: AlphainZ's research assistant, in Obsidian's right sidebar.
 */
import { FileSystemAdapter, MarkdownView, Notice, Plugin, TFile, TFolder, addIcon, type Editor, type WorkspaceLeaf, type WorkspaceSplit } from 'obsidian';
import { watch, type FSWatcher } from 'fs';
import * as nodePath from 'path';
import { PROVIDER_PRESETS, type ProviderPresetId } from '@beaver/agent-llm/openAICompatible';
import { readRunLimits } from '@beaver/agent-llm/runLimits';
import { buildChatProvider, type BuiltProvider } from './agent/provider';
import { nodeFetch } from './agent/nodeFetch';
import { buildSystemPrompt, type SystemPromptOptions } from './agent/systemPrompt';
import type { AttachedImage, Quote } from './agent/quote';
import { explainPrompt } from './agent/explain';
import { captureAnchor, normalized, resolveAnchor } from './comments/anchor';
import { EditorContext } from './context/editorContext';
import { isExcludedPath } from './search/paths';
import { LINE_END_ATTR, LINE_START_ATTR, liveSectionInfo } from './context/readingSelection';
import { CommentStore } from './comments/store';
import { commentToolSchemas, createCommentToolDispatcher } from './comments/tools';
import { CommentsView, VIEW_TYPE_COMMENTS, type CommentDraft } from './comments/CommentsView';
import { commentMarks, focusThread, refreshComments } from './comments/decorations';
import type { CommentAnchor } from './comments/anchor';
import type { StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { SUGGESTIONS_TOOLS, combineToolSets, type ToolSet } from './agent/tools';
import { AlphainZClient, zoteroTools, type ZoteroTools } from './zotero';
import { NoteIndex } from './search';
import { buildNoteEmbedder, isEmbeddingPreset } from './search/embedder';
import { ImageIndex } from './search/imageIndex';
import { createImageToolDispatcher, imageToolSchemas } from './tools/imageTools';
import { vaultTools } from './tools/vaultTools';
import { createNoteMetaToolDispatcher, noteMetaToolSchemas } from './tools/noteMetaTools';
import { CREATE_NOTE_SCHEMA, createNoteDispatcher, safeTitle } from './tools/createNote';
import { EDIT_NOTE_SCHEMA, EDIT_STATUS_SCHEMA, EditRegistry, createEditDispatcher } from './edits/tool';
import { chunkAt, jumpToChunk, reviewExtension, reviewLabels, setSettledListener, settleAll, settleChunk } from './edits/review';
import { AlphainOMcpServer, DEFAULT_MCP_PORT, MCP_PATH, MCP_SERVER_NAME, bridgeScript, type McpTools } from './mcp/server';
import { COMMENT_WRITE_TOOLS } from './comments/tools';
import { validPort } from './settings';
import { ollamaApiBaseUrl } from './agent/provider';
import { defaultDataFolder, followRename } from './dataFolder';
import { t } from './i18n';
import { PANDA_ICON, PANDA_SVG } from './icon';
import { installRuntime } from './runtime';
import { DEFAULT_SETTINGS, PrefStore, normalizeSettings, type AlphainOSettings } from './settings';
import { AlphainOSettingTab } from './settingsTab';
import { ConversationStore, type Conversation } from './store/conversations';
import { DraftShelf } from './view/drafts';
import { chatMarkdown } from './view/chatContent';
import { chooseFolder } from './settings/confirm';
import { ChatView, VIEW_TYPE_CHAT } from './view/ChatView';

const DEVICE_ID_KEY = 'alphaino-device-id';

/** What a chat command asks of the open chat. */
export type ChatCommand = 'new-chat' | 'history' | 'outline' | 'focus';

/** What Claude is told about this server when it connects (it reads English). */
const MCP_INSTRUCTIONS = [
    "You have access to the user's Obsidian vault through AlphainO.",
    'Use these tools when the task would benefit from the user’s own notes: what they wrote about a topic, their plans, drafts and',
    'references, or the comments they left on their notes.',
    '',
    '## Tool strategy',
    '- `get_active_note` tells you which note the user has open and what they selected.',
    '- To find notes by meaning use `note_search_by_topic` when it is listed; by words or a quoted phrase, `search_vault_fulltext`;',
    '  by title, tag, property, folder or date, `note_search_by_metadata`. `list_notes`, `list_folders` and `list_tags` show how the vault is organised.',
    '- Read a note with `read_note` (whole, by heading, or by lines) before making claims about it; `search_in_note` finds where a word is',
    '  in a long note, and `get_note_metadata` gives its outline. `get_note_links` follows links and backlinks.',
    '- Comments: `get_comments` and `find_comments` read the threads (each with its passage); `add_comment`, `reply_to_comment` and',
    '  `resolve_comment` write them, signed as Claude. Quote passages exactly as they appear in the note.',
    '- `create_note` adds a new note (it never changes an existing one).',
    '',
    '## Citations',
    'Name notes with the `link` the results give, e.g. `[[Folder/Note#Heading]]`, so the user can open them in Obsidian.',
].join('\n');

/** How the model is told to use the comments (it reads English). */
const COMMENT_GUIDANCE = [
    'The user comments on passages of their notes, like margin notes in a document review. `get_comments` lists the threads on a note',
    '(with the passage each is on) and `find_comments` searches them across the vault. You can comment too (`add_comment`, quoting the passage',
    'exactly), answer in a thread (`reply_to_comment`) and resolve one (`resolve_comment`). When asked to work through comments, take the',
    'threads one by one: do what each asks, say in a reply what you did, then resolve it. Comment only when asked to review or annotate.',
].join(' ');

/** How the model is told to use the vault's tools (it reads English). */
const VAULT_GUIDANCE = [
    "The user's notes are reachable through the vault tools: `get_active_note` (the note open in the editor and any selected text),",
    '`read_note` (a note, whole or by heading or lines), `search_in_note` (where a word is in one note), `get_note_metadata` (properties,',
    'tags, outline, links), `get_note_links` (links and backlinks), `note_search_by_metadata` (by title, tag, property, folder, date),',
    '`list_notes`, `list_folders`, `list_tags`, `search_vault_fulltext` (words and quoted phrases) and, when an embedding model is set up,',
    '`note_search_by_topic` (by meaning). Read a note before you answer about it; do not answer from its title. Cite notes with the',
    '`link` the results give (`[[Note#Heading]]`), so the user can click through; never make up a link.',
].join(' ');

/** What a question's tool sets may depend on: whether the chosen model can see pictures. */
export interface RunContext {
    vision: boolean;
}

export default class AlphainOPlugin extends Plugin {
    settings: AlphainOSettings = { ...DEFAULT_SETTINGS };
    prefs!: PrefStore;
    conversations!: ConversationStore;
    private saveTimer: number | null = null;
    private ribbonEl: HTMLElement | null = null;
    private readonly settingsListeners = new Set<() => void>();
    private readonly quoteListeners = new Set<(quote: Quote | null, text?: string, sendNow?: boolean) => void>();
    private readonly commentListeners = new Set<(request: { kind: 'draft' } | { kind: 'thread'; threadId: string }) => void>();
    private commentDraft: CommentDraft | null = null;
    /** Text for the chat's message box, handed over with a passage (Ask AlphainO about a comment). */
    pendingInput: string | null = null;
    /** A passage asked about before the chat was open, for it to pick up. */
    pendingQuote: Quote | null = null;
    /** Half-written messages, per conversation, kept while Obsidian runs (AlphainZ's parked drafts). */
    readonly drafts = new DraftShelf();
    /** The conversation the chat showed when it was closed; it reopens with it, as AlphainZ's pane keeps its chat. */
    lastConversation: Conversation | null = null;
    /** A chat a link asked for (obsidian://alphaino?thread=…), until the chat opens it. */
    pendingThread: { id: string; runId?: string } | null = null;
    private readonly threadListeners = new Set<(id: string, runId?: string) => void>();
    /** The handed-over passage and question go at once ("Explain"), once the chat is open. */
    pendingSend = false;
    /** What `handOver` is delivering, until a chat takes it (see there). */
    pendingHandOver: object | null = null;
    /** AlphainZ's library tools, while the Zotero setting is on. */
    zotero: ZoteroTools | null = null;
    /** The note in view and the passage selected in it, for the chat's context chips. */
    editorContext!: EditorContext;
    /** The comment threads on the vault's notes (Orbit's journal, in the data folder). */
    comments!: CommentStore;
    private commentsWatcher: FSWatcher | null = null;
    private commentsWatchTimer: number | null = null;
    /** The search index of the vault's notes (keywords always, meanings with an embedding model). */
    noteIndex: NoteIndex | null = null;
    /** The vault's pictures, found by what they show (Settings → Note search → Pictures). */
    imageIndex: ImageIndex | null = null;
    /** What became of the edits the assistant (or Claude) made, piece by piece. */
    readonly edits = new EditRegistry();
    /** The MCP server for Claude, while it is turned on. */
    mcp: AlphainOMcpServer | null = null;
    private mcpKey = '';
    private embedderKey = '';
    zoteroClient: AlphainZClient | null = null;
    private zoteroKey = '';

    async onload(): Promise<void> {
        this.settings = normalizeSettings(await this.loadData());
        // Keys live in Obsidian's secret storage from the start, so a hand-added endpoint's key is there for the first question.
        this.prefs = new PrefStore(() => this.settings, () => this.requestSave(), this.app.secretStorage);
        installRuntime(this.prefs, false);
        this.syncZotero();
        this.settingsListeners.add(() => this.syncZotero());
        this.embedderKey = this.embedderSignature();
        const embedder = this.buildEmbedder();
        this.noteIndex = new NoteIndex({ app: this.app, embedder, excludedFolders: this.excludedFolders() });
        // The pictures share the notes' embedding model and wait for the notes to be indexed first.
        this.imageIndex = new ImageIndex({
            app: this.app,
            embedder,
            enabled: this.prefs.get('vaultImageIndex') === true,
            excludedFolders: this.excludedFolders(),
            waitForTurn: () => this.noteIndex?.whenIdle() ?? Promise.resolve(),
        });
        this.settingsListeners.add(() => this.syncNoteIndex());
        // A change of excluded folders takes a note now left out off the message box, and offers one let back in.
        this.settingsListeners.add(() => {
            this.editorContext?.recheck();
            this.editorContext?.refreshNote();
        });
        const vault = vaultTools({ app: this.app, getIndex: () => this.noteIndex, getExcludedFolders: () => this.excludedFolders() });
        this.toolSets.push(() => ({ schemas: vault.schemas(), dispatch: vault.dispatcher }));
        const noteMeta = createNoteMetaToolDispatcher({ app: this.app, getExcludedFolders: () => this.excludedFolders() });
        this.toolSets.push(() => ({ schemas: noteMetaToolSchemas(), dispatch: noteMeta }));
        // Pictures: the search while the picture index is on; the viewer for a model that can see pictures.
        const imageTools = (looking: 'tool' | 'file' | 'none') =>
            createImageToolDispatcher({ app: this.app, getIndex: () => this.imageIndex, getExcludedFolders: () => this.excludedFolders(), looking });
        const imagesSeen = imageTools('tool');
        const imagesUnseen = imageTools('none');
        const imagesOverMcp = imageTools('file');
        this.toolSets.push((context) => {
            const schemas = imageToolSchemas({ search: this.imageIndex?.active() === true, view: context.vision });
            return schemas.length > 0 ? { schemas, dispatch: context.vision ? imagesSeen : imagesUnseen } : null;
        });
        // Edits go into the note at once, marked for review piece by piece (src/edits).
        reviewLabels.accept = t('Accept change');
        reviewLabels.reject = t('Reject change');
        this.registerEditorExtension(reviewExtension());
        setSettledListener((chunk, outcome) => this.edits.settle(chunk, outcome));
        this.register(() => setSettledListener(null));
        const edit = createEditDispatcher({ app: this.app, registry: this.edits, newId: () => crypto.randomUUID(), getExcludedFolders: () => this.excludedFolders() });
        this.toolSets.push(() => ({ schemas: [EDIT_NOTE_SCHEMA], dispatch: edit }));
        this.addReviewCommands();
        // Claude gets the same tools through MCP, writing comments as Claude, plus create_note.
        const claudeComments = createCommentToolDispatcher({ app: this.app, store: this.comments, actor: 'claude', getExcludedFolders: () => this.excludedFolders() });
        const createNote = createNoteDispatcher(this.app);
        this.mcpTools = () => {
            const combined = combineToolSets([
                { schemas: vault.schemas(), dispatch: vault.dispatcher },
                { schemas: noteMetaToolSchemas(), dispatch: noteMeta },
                // MCP results carry text only here: Claude gets the search, and reads a picture it finds from the file.
                { schemas: imageToolSchemas({ search: this.imageIndex?.active() === true, view: false }), dispatch: imagesOverMcp },
                { schemas: commentToolSchemas(), dispatch: claudeComments },
                { schemas: [CREATE_NOTE_SCHEMA], dispatch: createNote },
                { schemas: [EDIT_NOTE_SCHEMA, EDIT_STATUS_SCHEMA], dispatch: edit },
            ]);
            const writes = new Set<string>([...COMMENT_WRITE_TOOLS, 'create_note', 'edit_note']);
            return { schemas: combined.schemas, dispatch: combined.dispatch, readOnly: (name) => !writes.has(name) };
        };
        this.settingsListeners.add(() => void this.syncMcp());
        this.promptSections.push(() => VAULT_GUIDANCE);
        this.conversations = new ConversationStore(
            this.app.vault.adapter,
            () => this.dataFolder(),
            this.manifest.version,
            this.deviceId(),
        );

        this.comments = new CommentStore(this.app.vault.adapter, () => this.dataFolder());
        this.toolSets.push(() => ({
            schemas: commentToolSchemas(),
            dispatch: createCommentToolDispatcher({ app: this.app, store: this.comments, actor: 'alphaino', getExcludedFolders: () => this.excludedFolders() }),
        }));
        this.promptSections.push(() => COMMENT_GUIDANCE);
        this.registerView(VIEW_TYPE_COMMENTS, (leaf) => new CommentsView(leaf, this));
        this.registerEditorExtension(
            commentMarks({ threadsOn: (path) => this.comments.threadsOn(path), openThread: (id) => void this.openThread(id) }),
        );
        this.register(this.comments.subscribe(() => this.dispatchToEditors(refreshComments.of(null))));
        this.addCommand({ id: 'open-comments', name: t('Open comments'), callback: () => void this.openComments() });
        this.addCommand({
            id: 'comment',
            name: t('Comment on the selection or the whole note'),
            editorCheckCallback: (checking, _editor, view) => {
                if (!(view instanceof MarkdownView) || !view.file) return false;
                if (!checking) this.startComment();
                return true;
            },
        });
        // A note in an excluded folder is not offered with questions (AlphainZ's exclusion boundary).
        this.editorContext = new EditorContext(this.app, (path) => !isExcludedPath(path, this.excludedFolders()));
        this.registerEditorExtension(this.editorContext.extension());
        // Reading view: every rendered block carries the source lines it came from, so a selection there can be found in the note.
        this.registerMarkdownPostProcessor((el, ctx) => {
            const info = ctx.getSectionInfo(el);
            if (!info) return;
            el.setAttribute(LINE_START_ATTR, String(info.lineStart));
            el.setAttribute(LINE_END_ATTR, String(info.lineEnd));
            // The lines now, when a selection in it is read (the stamps go stale when lines are added above).
            liveSectionInfo.set(el, () => {
                const now = ctx.getSectionInfo(el);
                return now ? { lineStart: now.lineStart, lineEnd: now.lineEnd } : null;
            });
        });
        this.registerDomEvent(document, 'selectionchange', () => this.editorContext.readingSelectionChanged(document));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.editorContext.refreshNote()));
        this.registerEvent(this.app.workspace.on('file-open', () => this.editorContext.refreshNote()));
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (!(file instanceof TFile)) return;
                this.editorContext.renamed(file, oldPath);
                // A note's comment threads move with it.
                if (file.extension === 'md') void this.comments.load().then(() => this.comments.noteMoved('user', oldPath, file.path));
            }),
        );
        this.registerEvent(this.app.vault.on('delete', (file) => this.editorContext.deleted(file.path)));

        addIcon(PANDA_ICON, PANDA_SVG);
        this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
        // Links in answers show Obsidian's page preview on hover, as links in a note do.
        this.registerHoverLinkSource(VIEW_TYPE_CHAT, { display: 'AlphainO', defaultMod: false });
        this.ribbonEl = this.addRibbonIcon(PANDA_ICON, 'AlphainO', () => void this.openChat());
        // Like AlphainZ's toolbar button: a line drawing at rest, in colour while the chat is in view.
        this.registerEvent(this.app.workspace.on('layout-change', () => this.updateRibbonState()));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateRibbonState()));
        this.addCommand({ id: 'open-chat', name: t('Open chat'), callback: () => void this.openChat() });
        // AlphainZ's chat shortcuts, as commands one can give a hotkey.
        this.addCommand({ id: 'new-chat', name: t('New chat'), callback: () => void this.chatCommand('new-chat') });
        this.addCommand({ id: 'chat-history', name: t('Show chat history'), callback: () => void this.chatCommand('history') });
        this.addCommand({ id: 'conversation-outline', name: t('Conversation outline'), callback: () => void this.chatCommand('outline') });
        this.addCommand({ id: 'focus-composer', name: t('Focus the message box'), callback: () => void this.chatCommand('focus') });
        this.addSettingTab(new AlphainOSettingTab(this.app, this));

        // Links to a chat or one of its answers (AlphainZ's zotero://alphainz/thread/…): obsidian://alphaino?thread=…&run=…
        this.registerObsidianProtocolHandler('alphaino', (params) => {
            if (typeof params.thread === 'string' && params.thread) void this.openChatThread(params.thread, typeof params.run === 'string' && params.run ? params.run : undefined);
        });

        // Selection chat: ask about the passage selected in a note (editor, Reading view or PDF), or have it explained at once.
        this.addCommand({
            id: 'ask-about-selection',
            name: t('Ask about the selection'),
            checkCallback: (checking) => {
                const quote = this.selectedPassage();
                if (!quote) return false;
                if (!checking) void this.handOver(quote);
                return true;
            },
        });
        this.addCommand({
            id: 'explain-selection',
            name: t('Explain the selection'),
            checkCallback: (checking) => {
                const quote = this.selectedPassage();
                if (!quote) return false;
                if (!checking) void this.handOver(quote, explainPrompt(this.prefs), true);
                return true;
            },
        });
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                if (!editor.somethingSelected() || !(view instanceof MarkdownView) || !view.file) return;
                menu.addItem((item) =>
                    item.setTitle(t('Ask AlphainO about this')).setIcon(PANDA_ICON).onClick(() => void this.askAbout(editor, view)),
                );
                menu.addItem((item) =>
                    item
                        .setTitle(t('Explain'))
                        .setIcon('lightbulb')
                        .onClick(() => void this.handOver(this.editorPassage(editor, view), explainPrompt(this.prefs), true)),
                );
                menu.addItem((item) => item.setTitle(t('Comment')).setIcon('message-square-plus').onClick(() => this.startComment()));
            }),
        );

        this.app.workspace.onLayoutReady(() => {
            if (!this.settings.dataFolder) {
                this.settings.dataFolder = defaultDataFolder(this.app.vault);
                this.requestSave();
            }
            this.editorContext.refreshNote();
            void this.comments.load().then(() => this.watchComments());
            void this.noteIndex?.start((ref) => this.registerEvent(ref));
            void this.imageIndex?.start((ref) => this.registerEvent(ref));
            void this.placeChatOnce().then(() => {
                this.updateRibbonState();
                // A comments tab opened before this rule sits right of the chat's: it moves to its left.
                this.placeCommentsBeforeChat();
            });
            void this.syncMcp();
        });
        // The data folder moves with a renamed folder that contains it.
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (!(file instanceof TFolder)) return;
                const moved = followRename(this.dataFolder(), oldPath, file.path);
                if (moved) {
                    this.settings.dataFolder = moved;
                    this.requestSave();
                }
            }),
        );
    }

    async onunload(): Promise<void> {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
            await this.saveData(this.settings);
        }
        this.settingsListeners.clear();
        this.editorContext?.dispose();
        // A server change still queued finishes first; none starts after this.
        this.mcpUnloaded = true;
        await this.mcpSyncing;
        await this.mcp?.stop();
        this.mcp = null;
        this.commentsWatcher?.close();
        this.commentsWatcher = null;
        if (this.commentsWatchTimer !== null) window.clearTimeout(this.commentsWatchTimer);
        // The pictures first: their indexing may be waiting on the notes.
        await this.imageIndex?.stop();
        this.imageIndex = null;
        await this.noteIndex?.stop();
        this.noteIndex = null;
        this.zoteroClient?.dispose();
        this.zoteroClient = null;
        this.zotero = null;
    }

    /**
     * Comment files written on another computer reach the vault without
     * Obsidian telling plugins (the folder is hidden), so the folder is watched
     * on disk and read again, a moment after it settles.
     */
    private watchComments(): void {
        this.commentsWatcher?.close();
        this.commentsWatcher = null;
        const adapter = this.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) return;
        const folder = nodePath.join(adapter.getBasePath(), this.comments.folder());
        try {
            this.commentsWatcher = watch(folder, { recursive: true }, () => {
                if (this.commentsWatchTimer !== null) window.clearTimeout(this.commentsWatchTimer);
                this.commentsWatchTimer = window.setTimeout(() => {
                    this.commentsWatchTimer = null;
                    void this.comments.load();
                }, 700);
            });
            this.commentsWatcher.on('error', () => {
                this.commentsWatcher?.close();
                this.commentsWatcher = null;
            });
        } catch {
            // No comments folder yet: the first comment creates it, and the plugin's own writes need no watching.
        }
    }

    /** Commands for reviewing an edit in the note: next/previous change, accept/reject one, accept/reject all. */
    private addReviewCommands(): void {
        const withEditor = (run: (view: EditorView) => boolean) => (checking: boolean, editor: Editor) => {
            const cm = (editor as unknown as { cm?: EditorView }).cm;
            if (!cm) return false;
            if (checking) return true;
            run(cm);
            return true;
        };
        this.addCommand({ id: 'review-next-change', name: t('Next change'), editorCheckCallback: withEditor((view) => jumpToChunk(view, 1)) });
        this.addCommand({ id: 'review-previous-change', name: t('Previous change'), editorCheckCallback: withEditor((view) => jumpToChunk(view, -1)) });
        this.addCommand({
            id: 'review-accept-change',
            name: t('Accept change'),
            editorCheckCallback: withEditor((view) => {
                const chunk = chunkAt(view);
                const done = chunk ? settleChunk(view, chunk.id, 'accepted') : false;
                jumpToChunk(view, 1);
                return done;
            }),
        });
        this.addCommand({
            id: 'review-reject-change',
            name: t('Reject change'),
            editorCheckCallback: withEditor((view) => {
                const chunk = chunkAt(view);
                const done = chunk ? settleChunk(view, chunk.id, 'rejected') : false;
                jumpToChunk(view, 1);
                return done;
            }),
        });
        this.addCommand({ id: 'review-accept-all', name: t('Accept all changes'), editorCheckCallback: withEditor((view) => settleAll(view, 'accepted') > 0) });
        this.addCommand({ id: 'review-reject-all', name: t('Reject all changes'), editorCheckCallback: withEditor((view) => settleAll(view, 'rejected') > 0) });
    }

    /** The tools Claude gets through MCP (set up in onload). */
    mcpTools: () => McpTools = () => ({ schemas: [], dispatch: async () => ({ error: 'Not ready.' }), readOnly: () => true });

    /** The MCP port: the setting, or the default. */
    mcpPort(): number {
        return validPort(this.prefs.get('mcpServerPort')) ?? DEFAULT_MCP_PORT;
    }

    mcpEnabled(): boolean {
        return this.prefs.get('mcpServerEnabled') === true;
    }

    /** The URL Claude Code is given. */
    mcpUrl(): string {
        return `http://127.0.0.1:${this.mcpPort()}${MCP_PATH}`;
    }

    /** Where the stdio bridge for Claude Desktop is written: the plugin's own folder. */
    mcpBridgePath(): { vaultPath: string; absolute: string | null } {
        const vaultPath = `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/alphaino-mcp-stdio.mjs`;
        const adapter = this.app.vault.adapter;
        return { vaultPath, absolute: adapter instanceof FileSystemAdapter ? nodePath.join(adapter.getBasePath(), vaultPath) : null };
    }

    /** Start, restart or stop the MCP server to match the settings. */
    /** The server changes one after another, each reading the settings as they are when it runs. */
    private mcpSyncing: Promise<void> = Promise.resolve();
    private mcpUnloaded = false;

    /**
     * Start, stop or move the MCP server to match the settings. Changes queue: typing a port digit by digit
     * changes the settings at every keystroke, and two of these running at once would leave a server running on
     * a port typed on the way.
     */
    syncMcp(): Promise<void> {
        this.mcpSyncing = this.mcpSyncing.then(() => this.syncMcpNow()).catch((error) => console.warn('[AlphainO] MCP server:', error));
        return this.mcpSyncing;
    }

    private async syncMcpNow(): Promise<void> {
        if (this.mcpUnloaded) return;
        const key = this.mcpEnabled() ? `on:${this.mcpPort()}` : 'off';
        if (key === this.mcpKey) return;
        this.mcpKey = key;
        await this.mcp?.stop();
        this.mcp = null;
        if (key === 'off') {
            this.notifyMcp();
            return;
        }
        const server = new AlphainOMcpServer({
            port: this.mcpPort(),
            version: this.manifest.version,
            tools: () => this.mcpTools(),
            instructions: MCP_INSTRUCTIONS,
            log: (message) => console.warn(`[AlphainO] ${message}`),
        });
        this.mcp = server;
        server.onStateChange(() => this.notifyMcp());
        await server.start();
        try {
            await this.app.vault.adapter.write(this.mcpBridgePath().vaultPath, bridgeScript(this.mcpPort()));
        } catch {
            // The bridge is only for Claude Desktop; Claude Code connects over HTTP.
        }
    }

    private readonly mcpListeners = new Set<() => void>();

    /** Be told when the MCP server starts, stops or fails; returns the unsubscribe. */
    onMcpChange(listener: () => void): () => void {
        this.mcpListeners.add(listener);
        return () => this.mcpListeners.delete(listener);
    }

    private notifyMcp(): void {
        for (const listener of this.mcpListeners) listener();
    }

    /** Folders left out of note search and listing (vault paths). */
    excludedFolders(): string[] {
        const raw = this.prefs.get('vaultExcludedFolders');
        try {
            const list = typeof raw === 'string' && raw ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
            return Array.isArray(list) ? list.map(String).map((folder) => folder.trim()).filter(Boolean) : [];
        } catch {
            return [];
        }
    }

    /**
     * The embedding model for note search, chosen as AlphainZ chooses it
     * (`embeddingProvider`; the key of the same vendor, Google's own embedding
     * key first), or null while none is chosen or its key is missing.
     */
    private buildEmbedder() {
        const preset = this.prefs.string('embeddingProvider');
        if (!preset || !isEmbeddingPreset(preset)) return null;
        const apiKey =
            preset === 'ollama'
                ? ''
                : preset === 'google'
                    ? this.secretValue('embeddingKeyGoogle') || this.apiKey('google')
                    : this.apiKey(preset as ProviderPresetId);
        const built = buildNoteEmbedder(
            { preset, apiKey, ...(preset === 'ollama' ? { baseUrl: ollamaApiBaseUrl(this.prefs) } : {}) },
            nodeFetch as unknown as typeof fetch,
        );
        return built.ok ? built.embedder : null;
    }

    /** A key kept under a setting's own secret (not a provider's), or ''. */
    private secretValue(setting: string): string {
        const secret = (this.settings.keySecrets as Record<string, string | undefined>)[setting];
        return secret ? (this.app.secretStorage.getSecret(secret) ?? '').trim() : '';
    }

    /** What the embedding model is built from; it is rebuilt when this changes. */
    private embedderSignature(): string {
        const preset = this.prefs.string('embeddingProvider');
        if (!preset || !isEmbeddingPreset(preset)) return '';
        if (preset === 'ollama') return `ollama|${ollamaApiBaseUrl(this.prefs)}`;
        const key = preset === 'google' ? this.secretValue('embeddingKeyGoogle') || this.apiKey('google') : this.apiKey(preset as ProviderPresetId);
        return `${preset}|${key}`;
    }

    /** Hand the note index a new embedding model or folder list when the settings change. */
    private syncNoteIndex(): void {
        if (!this.noteIndex) return;
        const key = this.embedderSignature();
        if (key !== this.embedderKey) {
            this.embedderKey = key;
            const embedder = this.buildEmbedder();
            this.noteIndex.setEmbedder(embedder);
            this.imageIndex?.setEmbedder(embedder);
        }
        this.noteIndex.setExcludedFolders(this.excludedFolders());
        this.imageIndex?.setExcludedFolders(this.excludedFolders());
        this.imageIndex?.setEnabled(this.prefs.get('vaultImageIndex') === true);
    }

    /** Build (or drop) the Zotero client when its settings change. */
    private syncZotero(): void {
        const key = this.settings.zoteroEnabled ? `on:${this.settings.zoteroPort}` : 'off';
        if (key === this.zoteroKey) return;
        this.zoteroKey = key;
        this.zoteroClient?.dispose();
        this.zoteroClient = null;
        this.zotero = null;
        if (!this.settings.zoteroEnabled) return;
        this.zoteroClient = new AlphainZClient({ port: this.settings.zoteroPort });
        this.zotero = zoteroTools(this.zoteroClient);
    }

    /** Hand the selected passage to the chat, opening it if need be. */
    async askAbout(editor: Editor, view: MarkdownView): Promise<void> {
        await this.handOver(this.editorPassage(editor, view));
    }

    /** The passage selected in an editor, anchored in its note. */
    editorPassage(editor: Editor, view: MarkdownView): Quote {
        const path = view.file?.path ?? '';
        const from = editor.getCursor('from');
        const to = editor.getCursor('to');
        const quote: Quote = {
            text: editor.getSelection(),
            path,
            from: from.line + 1,
            // A selection ending at the start of a line does not include that line.
            to: to.ch === 0 && to.line > from.line ? to.line : to.line + 1,
        };
        const anchor = this.anchorFor(path, editor.getValue(), editor.posToOffset(from), editor.posToOffset(to));
        if (anchor) quote.anchor = anchor;
        return quote;
    }

    /**
     * The passage selected now, wherever it was made: the active note's editor,
     * or (Reading view, a PDF) the selection the chat follows. Null when nothing
     * is selected.
     */
    selectedPassage(): Quote | null {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.file && view.getMode() === 'source' && view.editor.somethingSelected()) return this.editorPassage(view.editor, view);
        const selection = this.editorContext.current.selection;
        if (!selection || !selection.text.trim()) return null;
        const quote: Quote = {
            text: selection.text,
            path: selection.path,
            from: selection.fromLine,
            to: selection.toLine,
            ...(selection.page ? { page: selection.page } : {}),
        };
        const anchor = selection.from >= 0 ? this.anchorFor(selection.path, selection.source, selection.from, selection.to) : null;
        if (anchor) quote.anchor = anchor;
        return quote;
    }

    /**
     * Give the chat a passage, opening it if need be: in the message box with
     * `question` typed under it, or sent at once (`sendNow`, AlphainZ's Explain).
     */
    async handOver(quote: Quote | null, question?: string, sendNow = false): Promise<void> {
        const handed = { quote, question };
        this.pendingQuote = quote;
        if (question !== undefined) this.pendingInput = question;
        this.pendingSend = sendNow;
        this.pendingHandOver = handed;
        await this.openChat();
        // A chat that opened just now took it when it first drew; one already open takes it here.
        if (this.pendingHandOver !== handed) return;
        this.pendingHandOver = null;
        for (const listener of this.quoteListeners) listener(quote, question, sendNow);
    }

    /**
     * The comment anchor for a passage of a note (Orbit's format): the passage,
     * its context and offsets, so it can be found again after the note changes.
     * Null when it cannot be one (a passage over 4,000 characters, a blank one).
     */
    anchorFor(path: string, text: string, from: number, to: number): Quote['anchor'] | null {
        try {
            return captureAnchor(path, text, { from, to });
        } catch {
            return null;
        }
    }

    /** Open the note a passage came from, with the passage selected: where it is now, if the note changed since. */
    async revealQuote(quote: Quote): Promise<void> {
        if (/\.pdf$/i.test(quote.path)) {
            // A PDF opens at the page the passage is on.
            await this.app.workspace.openLinkText(quote.page ? `${quote.path}#page=${quote.page}` : quote.path, '', false);
            return;
        }
        await this.app.workspace.openLinkText(quote.path, '', false);
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.file?.path !== quote.path) return;
        const editor = view.editor;
        if (quote.anchor) {
            const text = editor.getValue();
            const place = resolveAnchor(quote.anchor, text);
            if (place.status === 'attached' && (place.to > place.from || place.deleted)) {
                // The anchor counts in LF text; the editor's text is LF too.
                const length = normalized(text).length;
                const start = editor.offsetToPos(Math.min(place.from, length));
                const end = editor.offsetToPos(Math.min(place.to, length));
                editor.setSelection(start, end);
                editor.scrollIntoView({ from: start, to: end }, true);
                return;
            }
        }
        if (quote.from <= 0) {
            // Known by its text only: find it in the note.
            const at = editor.getValue().indexOf(quote.text);
            if (at >= 0) {
                const start = editor.offsetToPos(at);
                const end = editor.offsetToPos(at + quote.text.length);
                editor.setSelection(start, end);
                editor.scrollIntoView({ from: start, to: end }, true);
            }
            return;
        }
        const last = Math.min(quote.to, editor.lineCount()) - 1;
        const from = { line: Math.max(0, quote.from - 1), ch: 0 };
        const to = { line: Math.max(from.line, last), ch: editor.getLine(Math.max(from.line, last)).length };
        editor.setSelection(from, to);
        editor.scrollIntoView({ from, to }, true);
    }

    /** The largest image the message box takes (its bytes go to the model base64-encoded). */
    static readonly MAX_IMAGE_BYTES = 8 * 1024 * 1024;

    /** Keep an image pasted or dropped into the message box as a file in the data folder; null when it is not one. */
    async saveAttachment(file: File): Promise<AttachedImage | null> {
        const types: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
        const extension = types[file.type];
        if (!extension) return null;
        if (file.size > AlphainOPlugin.MAX_IMAGE_BYTES) {
            new Notice(t('This image is too large to send (at most {size} MB).', { size: AlphainOPlugin.MAX_IMAGE_BYTES / 1024 / 1024 }));
            return null;
        }
        const folder = `${this.dataFolder()}/attachments`;
        const parts = folder.split('/');
        for (let i = 1; i <= parts.length; i += 1) {
            const path = parts.slice(0, i).join('/');
            if (!(await this.app.vault.adapter.exists(path))) await this.app.vault.adapter.mkdir(path);
        }
        const path = `${folder}/${crypto.randomUUID()}.${extension}`;
        await this.app.vault.adapter.writeBinary(path, await file.arrayBuffer());
        return { path, mimeType: file.type, name: file.name && file.name !== 'image.png' ? file.name : t('Pasted image') };
    }

    /** An attached image's bytes, for the model. */
    async loadImage(path: string): Promise<{ mimeType: string; base64: string } | null> {
        if (!(await this.app.vault.adapter.exists(path))) return null;
        const data = await this.app.vault.adapter.readBinary(path);
        const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        const mimeType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'gif' ? 'image/gif' : extension === 'webp' ? 'image/webp' : 'image/png';
        return { mimeType, base64: Buffer.from(data).toString('base64') };
    }

    /** Save an answer (with its question) as a new note in the agent folder, as AlphainZ saves one as a Zotero note. */
    async saveAnswerAsNote(question: string, content: string): Promise<void> {
        const title = safeTitle(question.split('\n')[0].slice(0, 60)) || t('AlphainO answer');
        const result = (await createNoteDispatcher(this.app)('create_note', { title, content }, { toolCallId: 'save' })) as { ok?: boolean; note_id?: string; error?: string };
        if (result.ok && result.note_id) new Notice(t('Saved as {note}', { note: result.note_id }));
        else new Notice(t('Could not save note: {reason}', { reason: result.error ?? '' }));
    }

    /** The link to a chat, or to one of its answers, that opens it here (obsidian://alphaino?…). */
    chatLink(threadId: string, runId?: string): string {
        const params = new URLSearchParams({ vault: this.app.vault.getName(), thread: threadId });
        if (runId) params.set('run', runId);
        return `obsidian://alphaino?${params.toString().replace(/\+/g, '%20')}`;
    }

    /** Open a chat in the chat view (a link to it, or to one of its answers), opening the view if need be. */
    async openChatThread(id: string, runId?: string): Promise<void> {
        const asked = { id, runId };
        this.pendingThread = asked;
        await this.openChat();
        // A chat that opened just now took it when it first drew; one already open takes it here.
        if (this.pendingThread !== asked) return;
        this.pendingThread = null;
        for (const listener of this.threadListeners) listener(id, runId);
    }

    onOpenThread(listener: (id: string, runId?: string) => void): () => void {
        this.threadListeners.add(listener);
        return () => this.threadListeners.delete(listener);
    }

    /**
     * Save a whole chat as a note, in a folder the user picks (AlphainZ's "Save
     * chat as note…"): the chat as AlphainZ writes it, each question linking
     * back to its place in the chat.
     */
    async saveChatAsNote(conversation: Conversation): Promise<void> {
        const agent = this.app.vault.getAbstractFileByPath('Agent');
        const first = agent instanceof TFolder ? agent : this.app.vault.getRoot();
        const folder = await chooseFolder(this.app, first);
        if (!folder) return;
        const title = safeTitle(conversation.name || conversation.runs[0]?.user_prompt?.content?.split('\n')[0]?.slice(0, 60) || '') || t('AlphainO chat');
        const content = chatMarkdown({ name: '', runs: conversation.runs }, { link: (runId) => this.chatLink(conversation.id, runId), quoteQuestions: true });
        const result = (await createNoteDispatcher(this.app)('create_note', { title, content, folder: folder.isRoot() ? '' : folder.path }, { toolCallId: 'save-chat' })) as { ok?: boolean; note_id?: string; error?: string };
        if (result.ok && result.note_id) new Notice(t('Saved as {note}', { note: result.note_id }));
        else new Notice(t('Could not save note: {reason}', { reason: result.error ?? '' }));
    }

    /** Add text at the end of the open note (the chat's "Append chat to the open note"). */
    async appendToOpenNote(text: string): Promise<void> {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.recentMarkdownView();
        const file = view?.file;
        if (!file) {
            new Notice(t('Open a note to add the chat to it.'));
            return;
        }
        await this.app.vault.process(file, (data) => `${data.replace(/\s+$/, '')}${data.trim() ? '\n\n' : ''}${text.trim()}\n`);
        new Notice(t('Added to {note}', { note: file.basename }));
    }

    /** Put an answer into the open note at its cursor (AlphainZ's "save as child note", for a note). */
    insertIntoOpenNote(text: string): void {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.recentMarkdownView();
        if (!view) {
            new Notice(t('Open a note to insert into it.'));
            return;
        }
        const editor = view.editor;
        const cursor = editor.getCursor('to');
        const line = editor.getLine(cursor.line);
        const before = cursor.ch === 0 && line === '' ? '' : '\n\n';
        editor.replaceRange(`${before}${text.trim()}\n`, cursor);
        new Notice(t('Inserted into {note}', { note: view.file?.basename ?? '' }));
    }

    /** Open a note, in a new tab when it is not open yet. */
    async openNote(path: string): Promise<void> {
        await this.app.workspace.openLinkText(path, '', false);
    }

    // -----------------------------------------------------------------------
    // Comments
    // -----------------------------------------------------------------------

    /** Open (or show) the comments view in the right sidebar. */
    async openComments(): Promise<void> {
        const { workspace } = this.app;
        let leaf = this.placeCommentsBeforeChat() ?? workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)[0];
        if (!leaf) {
            const right = this.leafBeforeChat() ?? workspace.getRightLeaf(false);
            if (!right) return;
            await right.setViewState({ type: VIEW_TYPE_COMMENTS, active: true });
            leaf = right;
        }
        await workspace.revealLeaf(leaf);
    }

    /**
     * A new tab just left of the chat's, in its tab group: the chat's tab, whose panda lights up, stays the
     * rightmost (the owner, 11-26). Null when the chat is not open in a tab group.
     */
    private leafBeforeChat(): WorkspaceLeaf | null {
        const chat = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
        const group = chat?.parent as unknown as { children?: unknown[] } | undefined;
        if (!chat || !group || !Array.isArray(group.children)) return null;
        const index = group.children.indexOf(chat);
        if (index < 0) return null;
        return this.app.workspace.createLeafInParent(group as unknown as WorkspaceSplit, index);
    }

    /** Move a comments tab found right of the chat's to its left; returns the comments tab when it moved one. */
    private placeCommentsBeforeChat(): WorkspaceLeaf | null {
        const { workspace } = this.app;
        const chat = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
        const comments = workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)[0];
        const group = chat?.parent as unknown as { children?: unknown[] } | undefined;
        if (!chat || !comments || !group || comments.parent !== chat.parent || !Array.isArray(group.children)) return null;
        if (group.children.indexOf(comments) < group.children.indexOf(chat)) return null;
        const state = comments.getViewState();
        comments.detach();
        const moved = this.leafBeforeChat();
        if (!moved) return null;
        void moved.setViewState({ ...state, active: false });
        return moved;
    }

    /** Be told when a comment is to be written or a thread shown; returns the unsubscribe. */
    onCommentRequest(listener: (request: { kind: 'draft' } | { kind: 'thread'; threadId: string }) => void): () => void {
        this.commentListeners.add(listener);
        return () => this.commentListeners.delete(listener);
    }

    /** The comment waiting to be written, taken once. */
    takeCommentDraft(): CommentDraft | null {
        const draft = this.commentDraft;
        this.commentDraft = null;
        return draft;
    }

    /** Start a comment on the selection in the open note (editor or Reading view), or on the whole note when nothing is selected. */
    startComment(): void {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.recentMarkdownView();
        const file = view?.file;
        if (!view || !file) {
            new Notice(t('Open a note to comment on it.'));
            return;
        }
        const editor = view.editor;
        let text = editor.getValue();
        let from = 0;
        let to = 0;
        const reading = this.editorContext.current.selection;
        if (view.getMode() === 'preview' && reading && reading.mode === 'reading' && reading.path === file.path) {
            if (reading.from < 0) {
                new Notice(t('This selection could not be found in the note’s text. Select it in the editor instead.'));
                return;
            }
            text = reading.source;
            from = reading.from;
            to = reading.to;
        } else if (editor.somethingSelected()) {
            from = editor.posToOffset(editor.getCursor('from'));
            to = editor.posToOffset(editor.getCursor('to'));
        }
        const anchor = this.anchorFor(file.path, text, from, to);
        if (!anchor) {
            new Notice(t('This passage is too long to keep as a comment range.'));
            return;
        }
        this.commentDraft = { anchor };
        void this.openComments().then(() => {
            for (const listener of this.commentListeners) listener({ kind: 'draft' });
        });
    }

    /** Show a thread in the comments view. */
    async openThread(threadId: string): Promise<void> {
        await this.openComments();
        for (const listener of this.commentListeners) listener({ kind: 'thread', threadId });
    }

    /** Ask the chat about a comment thread: its passage as the quote, its comment as the question. */
    async askAboutThread(threadId: string): Promise<void> {
        const thread = this.comments.thread(threadId);
        const anchor = thread?.root.anchor;
        if (!thread || !anchor) return;
        const comment = thread.root.deleted ? '' : thread.root.text;
        const quote: Quote | null =
            anchor.kind === 'range' ? { text: anchor.quote, path: anchor.path, from: 0, to: 0, anchor } : null;
        if (quote) {
            const file = this.app.vault.getAbstractFileByPath(anchor.path);
            const text = file instanceof TFile ? await this.app.vault.cachedRead(file) : '';
            const place = text ? resolveAnchor(anchor, text) : null;
            const line = place && place.status === 'attached' ? place.line + 1 : normalized(text).slice(0, anchor.from).split('\n').length;
            const lines = (place && place.status === 'attached' ? place.quote : anchor.quote).split('\n').length;
            quote.from = line;
            quote.to = line + lines - 1;
            if (place && place.status === 'attached' && !place.deleted) quote.text = place.quote;
        }
        await this.handOver(quote, t('About this comment: {comment}', { comment }));
    }

    /** Open a note with an anchored passage selected, where it is now. */
    async revealAnchor(anchor: CommentAnchor): Promise<void> {
        await this.app.workspace.openLinkText(anchor.path, '', false);
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.file?.path !== anchor.path || anchor.kind === 'document') return;
        const editor = view.editor;
        const text = editor.getValue();
        const place = resolveAnchor(anchor, text);
        const length = normalized(text).length;
        const [from, to] = place.status === 'attached' ? [place.from, place.to] : [Math.min(anchor.from, length), Math.min(anchor.from, length)];
        const start = editor.offsetToPos(Math.min(from, length));
        const end = editor.offsetToPos(Math.min(to, length));
        editor.setSelection(start, end);
        editor.scrollIntoView({ from: start, to: end }, true);
    }

    /** Draw one thread's passage stronger in every editor (null: none). */
    focusThreadInEditors(threadId: string | null): void {
        this.dispatchToEditors(focusThread.of(threadId));
    }

    private dispatchToEditors(effect: StateEffect<unknown>): void {
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view;
            if (!(view instanceof MarkdownView)) continue;
            // The editor's CodeMirror view: not in the public typings, but every editor extension relies on it.
            const cm = (view.editor as unknown as { cm?: EditorView }).cm;
            cm?.dispatch({ effects: effect });
        }
    }

    /** The Markdown view last used in the main area, while a sidebar has focus. */
    private recentMarkdownView(): MarkdownView | null {
        const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
        return leaf && leaf.view instanceof MarkdownView ? leaf.view : null;
    }

    private readonly chatCommandListeners = new Set<(command: ChatCommand) => void>();

    /** Be told about chat commands run from the palette or a hotkey; returns the unsubscribe. */
    onChatCommand(listener: (command: ChatCommand) => void): () => void {
        this.chatCommandListeners.add(listener);
        return () => this.chatCommandListeners.delete(listener);
    }

    private async chatCommand(command: ChatCommand): Promise<void> {
        await this.openChat();
        for (const listener of this.chatCommandListeners) listener(command);
    }

    /** Be handed passages to ask about; returns the unsubscribe. */
    onQuote(listener: (quote: Quote | null, text?: string, sendNow?: boolean) => void): () => void {
        this.quoteListeners.add(listener);
        return () => this.quoteListeners.delete(listener);
    }

    /** Save the settings shortly, once however many changes arrive together. */
    requestSave(): void {
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.saveData(this.settings);
        }, 300);
        for (const listener of this.settingsListeners) listener();
    }

    /** Be told when a setting changes; returns the unsubscribe. */
    onSettingsChange(listener: () => void): () => void {
        this.settingsListeners.add(listener);
        return () => this.settingsListeners.delete(listener);
    }

    dataFolder(): string {
        return this.settings.dataFolder || defaultDataFolder(this.app.vault);
    }

    /** This computer's id, recorded in the files it writes. Kept in local storage: it must not sync. */
    private deviceId(): string {
        const stored = this.app.loadLocalStorage(DEVICE_ID_KEY);
        if (typeof stored === 'string' && stored) return stored;
        const id = crypto.randomUUID();
        this.app.saveLocalStorage(DEVICE_ID_KEY, id);
        return id;
    }

    /** The API key for a provider, from Obsidian's secret storage; '' when none is set. */
    apiKey(providerId: ProviderPresetId): string {
        const secret = this.settings.keySecrets[providerId];
        if (!secret) return '';
        return (this.app.secretStorage.getSecret(secret) ?? '').trim();
    }

    buildProvider(): BuiltProvider {
        return buildChatProvider(this.prefs, (id) => this.apiKey(id), nodeFetch as unknown as typeof fetch);
    }

    /** "DeepSeek · deepseek-flash", or what is missing. */
    modelLabel(): string {
        const id = this.prefs.string('llmProvider');
        if (!(id in PROVIDER_PRESETS)) return t('Choose a provider');
        const preset = PROVIDER_PRESETS[id as ProviderPresetId];
        return `${preset.label} · ${this.prefs.string('llmModel') || preset.defaultModel}`;
    }

    systemPrompt(options: Partial<SystemPromptOptions> = {}): string {
        return buildSystemPrompt({ vaultName: this.app.vault.getName(), now: new Date(), ...options });
    }

    /**
     * The tool sets a question runs with, each asked when a question is sent.
     * Others (the vault's notes, comments) register here.
     */
    readonly toolSets: Array<(context: RunContext) => ToolSet | null> = [() => SUGGESTIONS_TOOLS];
    /** Paragraphs for the system prompt, from the tool sets that are on. */
    readonly promptSections: Array<() => string | null> = [];

    /**
     * What a question runs with: the system prompt, the tools and their
     * dispatcher. Asks AlphainZ which library tools it offers (a listing is
     * reused for a minute); `signal` stops that and every library call.
     */
    async prepareRun(signal: AbortSignal, context: RunContext = { vision: true }): Promise<{ systemPrompt: string; tools: ToolSet['schemas']; dispatch: ToolSet['dispatch'] }> {
        const sets = this.toolSets.map((get) => get(context)).filter((set): set is ToolSet => set !== null);
        let library: SystemPromptOptions['library'] = 'off';
        if (this.zotero) {
            const schemas = await this.zotero.schemas(signal);
            library = schemas.length > 0 ? 'available' : 'unavailable';
            if (schemas.length > 0) sets.push({ schemas, dispatch: this.zotero.dispatcher(signal) });
        }
        const combined = combineToolSets(sets);
        const sections = this.promptSections.map((get) => get()).filter((section): section is string => Boolean(section));
        return { systemPrompt: this.systemPrompt({ library, sections }), tools: combined.schemas, dispatch: combined.dispatch };
    }

    maxModelRequests(): number {
        return readRunLimits().modelRequests;
    }

    /** Whether a chat view is on screen: its tab selected and its sidebar open. */
    chatInView(): boolean {
        return this.app.workspace
            .getLeavesOfType(VIEW_TYPE_CHAT)
            .some((leaf) => leaf.view.containerEl.isShown());
    }

    updateRibbonState(): void {
        this.ribbonEl?.toggleClass('is-alphaino-open', this.chatInView());
    }

    /**
     * On the first run, put the chat in the right sidebar without focusing it,
     * so its tab is there to find. Once only: closing it is the user's choice.
     */
    private async placeChatOnce(): Promise<void> {
        if (this.settings.chatPlaced) return;
        this.settings.chatPlaced = true;
        this.requestSave();
        const { workspace } = this.app;
        if (workspace.getLeavesOfType(VIEW_TYPE_CHAT).length > 0) return;
        await workspace.getRightLeaf(false)?.setViewState({ type: VIEW_TYPE_CHAT, active: false });
    }

    async openChat(): Promise<void> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
        if (!leaf) {
            const right = workspace.getRightLeaf(false);
            if (!right) return;
            await right.setViewState({ type: VIEW_TYPE_CHAT, active: true });
            leaf = right;
        }
        await workspace.revealLeaf(leaf);
    }

    openSettings(): void {
        // Not in the public API, but every plugin's settings button does this.
        const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
        setting?.open();
        setting?.openTabById(this.manifest.id);
    }
}
