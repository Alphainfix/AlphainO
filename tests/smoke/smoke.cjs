// End-to-end smoke test: loads the built plugin (build/main.js, copied to a .cjs file) against a
// stand-in Obsidian in jsdom, with a fake OpenAI-compatible model server, and checks the chat end to end:
// streaming, saving, titles, chips, context, selection, comments, edit & resend, outline and history.
//
//   npm run smoke   (builds, copies build/main.js to build/main.cjs and runs this file on it)
//
// DUMP_END / DUMP_COMPOSER / DUMP_OUTLINE / DUMP_HISTORY / DUMP_COMMENTS=<file> write the view's HTML for a visual check.
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const REPO = path.resolve(__dirname, '..', '..');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const w = dom.window;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? w : w[key], configurable: true, writable: true });
}
w.HTMLElement.prototype.empty = function () { this.replaceChildren(); };
w.HTMLElement.prototype.addClass = function (c) { this.classList.add(c); };
w.HTMLElement.prototype.toggleClass = function (c, on) { this.classList.toggle(c, on); };
w.HTMLElement.prototype.isShown = function () { return true; };
// Obsidian's element helpers, as far as the dialogs use them.
w.HTMLElement.prototype.setText = function (text) { this.textContent = text; };
w.HTMLElement.prototype.createEl = function (tag, options = {}) {
    const el = w.document.createElement(tag);
    if (options.text) el.textContent = options.text;
    if (options.cls) el.className = options.cls;
    this.appendChild(el);
    return el;
};
w.HTMLElement.prototype.createDiv = function (options = {}) { return this.createEl('div', options); };
Object.defineProperty(w.Node.prototype, 'doc', { get() { return this.ownerDocument; } });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
w.confirm = () => true;
w.HTMLElement.prototype.scrollTo = function (o) { this.scrollTop = (o && o.top) || 0; };
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const calls = [];

const icons = new Map();
// A few of Obsidian's built-in (Lucide) icons, so a dumped view shows them where they sit.
const LUCIDE = {
    'trash-2': '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    'more-horizontal': '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    'message-square-plus': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" x2="15" y1="10" y2="10"/><line x1="12" x2="12" y1="7" y2="13"/>',
};
class Component { load() {} unload() {} register() {} registerEvent() {} }
const views = {};
const settingTabs = [];
const obsidian = {
    apiVersion: '1.15.1',
    getLanguage: () => process.env.LANG_UI || 'en',
    normalizePath: (p) => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, ''),
    addIcon: (id, svg) => {
        calls.push(['addIcon', id]);
        icons.set(id, svg);
    },
    // As Obsidian draws an icon added with addIcon: its content in a 0 0 100 100 box.
    setIcon: (el, name) => {
        el.dataset.icon = name;
        const svg = icons.get(name);
        if (svg) el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="svg-icon" width="24" height="24">${svg}</svg>`;
        else if (LUCIDE[name]) el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="svg-icon lucide-${name}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LUCIDE[name]}</svg>`;
    },
    Component,
    Keymap: { isModEvent: () => false },
    Notice: class { constructor(m) { calls.push(['notice', m]); } },
    TFolder: class {},
    TFile: class {},
    FileSystemAdapter: class {},
    // A dialog shows in the document while open, so a check can answer it.
    Modal: class {
        constructor(app) { this.app = app; this.modalEl = w.document.createElement('div'); this.modalEl.className = 'modal'; this.titleEl = this.modalEl.appendChild(w.document.createElement('div')); this.contentEl = this.modalEl.appendChild(w.document.createElement('div')); }
        open() { w.document.body.appendChild(this.modalEl); this.onOpen(); }
        close() { if (!this.modalEl.isConnected) return; this.modalEl.remove(); this.onClose(); }
        onOpen() {} onClose() {}
    },
    FuzzySuggestModal: class { constructor(app) { this.app = app; } setPlaceholder() {} open() {} close() {} onClose() {} },
    ButtonComponent: class {}, TextComponent: class {}, ToggleComponent: class {}, DropdownComponent: class {},
    Menu: class { addItem() { return this; } addSeparator() { return this; } showAtMouseEvent() {} },
    editorInfoField: { name: 'editorInfoField' },
    prepareFuzzySearch: (q) => (text) => (text.toLowerCase().includes(q.toLowerCase()) ? { score: 1, matches: [] } : null),
    MarkdownView: class {},
    MarkdownRenderer: { render: async (app, md, el) => { el.textContent = md; } },
    Plugin: class extends Component {
        constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this._data = null; }
        async loadData() { return this._data; }
        async saveData(d) { this._data = JSON.parse(JSON.stringify(d)); }
        addRibbonIcon(icon, title) { calls.push(['ribbon', icon, title]); return w.document.createElement('div'); }
        addCommand(c) { calls.push(['command', c.id]); }
        addSettingTab(tab) { settingTabs.push(tab); }
        registerView(type, make) { views[type] = make; }
        registerEvent() {}
        registerHoverLinkSource() {}
        registerEditorExtension(ext) { calls.push(['editorExtension', !!ext]); }
        registerMarkdownPostProcessor() {}
        registerDomEvent() {}
        registerObsidianProtocolHandler(action, handler) { calls.push(['protocol', action]); globalThis.__protocol = handler; }
    },
    ItemView: class extends Component { constructor(leaf) { super(); this.leaf = leaf; this.app = globalThis.__app; this.contentEl = w.document.createElement('div'); w.document.body.appendChild(this.contentEl); } },
    PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = w.document.createElement('div'); } hide() {} },
    // Obsidian's setting row (name and description on the left, controls on the right), enough for the native sections.
    Setting: class {
        constructor(containerEl) {
            this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
            this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
            this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
            this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
            this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
        }
        setName(name) { if (typeof name === 'string') this.nameEl.textContent = name; else if (name) this.nameEl.replaceChildren(name); return this; }
        setDesc(desc) { if (typeof desc === 'string') this.descEl.textContent = desc; else if (desc) this.descEl.replaceChildren(desc); return this; }
        setHeading() { this.settingEl.classList.add('setting-item-heading'); return this; }
        setDisabled(off) { this.settingEl.classList.toggle('is-disabled', Boolean(off)); return this; }
        setClass(cls) { this.settingEl.classList.add(cls); return this; }
        then(callback) { callback(this); return this; }
        addText(callback) {
            const inputEl = this.controlEl.createEl('input');
            inputEl.type = 'text';
            const text = { inputEl, setValue(v) { inputEl.value = v ?? ''; return text; }, setPlaceholder(v) { inputEl.placeholder = v; return text; }, onChange(f) { inputEl.addEventListener('input', () => f(inputEl.value)); return text; }, setDisabled(v) { inputEl.disabled = Boolean(v); return text; } };
            callback(text);
            return this;
        }
        addToggle(callback) {
            const toggleEl = this.controlEl.createDiv({ cls: 'checkbox-container' });
            const toggle = { toggleEl, setValue(v) { toggleEl.classList.toggle('is-enabled', Boolean(v)); return toggle; }, onChange(f) { toggleEl.addEventListener('click', () => { toggleEl.classList.toggle('is-enabled'); f(toggleEl.classList.contains('is-enabled')); }); return toggle; }, setDisabled() { return toggle; }, setTooltip() { return toggle; } };
            callback(toggle);
            return this;
        }
        addButton(callback) {
            const buttonEl = this.controlEl.createEl('button');
            const button = { buttonEl, setButtonText(v) { buttonEl.textContent = v; return button; }, setCta() { buttonEl.classList.add('mod-cta'); return button; }, setWarning() { buttonEl.classList.add('mod-warning'); return button; }, onClick(f) { buttonEl.addEventListener('click', f); return button; }, setDisabled(v) { buttonEl.disabled = Boolean(v); return button; }, setTooltip() { return button; } };
            callback(button);
            return this;
        }
    },
    SecretComponent: class {},
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'obsidian') return 'obsidian';
    if (request.startsWith('@codemirror/')) return resolve.call(this, request, rest[0], rest[1], { paths: [path.join(REPO, 'node_modules')] });
    return resolve.call(this, request, ...rest);
};
require.cache.obsidian = { id: 'obsidian', filename: 'obsidian', loaded: true, exports: obsidian };

// A fake OpenAI-compatible endpoint: streams the answer, then answers the title request.
const seen = [];
const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        const request = JSON.parse(body || '{}');
        seen.push(request);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const isMain = Array.isArray(request.tools) && request.tools.length > 0;
        const slow = JSON.stringify(request.messages?.slice(-1) ?? []).includes('SLOW');
        const cut = JSON.stringify(request.messages?.slice(-1) ?? []).includes('CUTOFF');
        // STEPS: the answer first lists the tags and folders (two tool calls), then writes.
        const lastUser = [...(request.messages ?? [])].reverse().find((m) => m.role === 'user');
        const steps = JSON.stringify(lastUser ?? {}).includes('STEPS');
        const afterTools = request.messages?.[request.messages.length - 1]?.role === 'tool';
        const mainCount = seen.filter((r) => Array.isArray(r.tools) && r.tools.length > 0).length;
        // THINK: a reasoning model's stream: thinking before each step (two calls, then one more), then the answer.
        const think = JSON.stringify(lastUser ?? {}).includes('THINK');
        let toolsSinceUser = 0;
        for (let k = (request.messages ?? []).length - 1; k >= 0 && request.messages[k].role !== 'user'; k -= 1) if (request.messages[k].role === 'tool') toolsSinceUser += 1;
        const chunks = [];
        if (isMain && think && toolsSinceUser === 0) {
            chunks.push({ choices: [{ index: 0, delta: { reasoning_content: 'Let me read the note and search the vault.' } }] });
            chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_k1', type: 'function', function: { name: 'list_tags', arguments: '{}' } }] } }] });
            chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_k2', type: 'function', function: { name: 'list_folders', arguments: '{}' } }] } }] });
            chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else if (isMain && think && toolsSinceUser === 2) {
            chunks.push({ choices: [{ index: 0, delta: { reasoning_content: 'Let me also list the notes in Biology.' } }] });
            chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_k3', type: 'function', function: { name: 'list_notes', arguments: '{"folder":"Biology"}' } }] } }] });
            chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else if (isMain && think) {
            chunks.push({ choices: [{ index: 0, delta: { reasoning_content: 'I have enough. Let me write a short answer.' } }] });
            chunks.push({ choices: [{ index: 0, delta: { content: 'Your vault has two folders, two notes and no tags.' } }] });
            chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        } else if (!isMain) {
            chunks.push({ choices: [{ index: 0, delta: { content: 'Bees and nectar' } }] });
            chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        } else if (steps && !afterTools) {
            chunks.push({ choices: [{ index: 0, delta: { content: 'Let me look.' } }] });
            chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_t', type: 'function', function: { name: 'list_tags', arguments: '{}' } }] } }] });
            chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_f', type: 'function', function: { name: 'list_folders', arguments: '{}' } }] } }] });
            chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else if (steps) {
            chunks.push({ choices: [{ index: 0, delta: { content: 'Your vault has two folders and no tags.' } }] });
            chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        } else if (cut) {
            chunks.push({ choices: [{ index: 0, delta: { content: 'This answer runs out of' } }] });
            chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
        } else if (slow) {
            for (let n = 0; n < 60; n += 1) chunks.push({ choices: [{ index: 0, delta: { content: `word${n} ` } }] });
            chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        } else if (mainCount === 1) {
            for (const piece of ['Bees eat ', '**nectar** ', 'and pollen.']) chunks.push({ choices: [{ index: 0, delta: { content: piece } }] });
            const args = JSON.stringify({ suggestions: [{ text: 'More about pollen', query: 'Tell me about pollen' }] });
            chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'return_suggestions', arguments: args } }] } }] });
            chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else {
            chunks.push({ choices: [{ index: 0, delta: { content: 'Pollen is protein.' } }] });
            chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        }
        let i = 0;
        const tick = setInterval(() => {
            if (i < chunks.length) {
                res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
            } else {
                res.write('data: [DONE]\n\n');
                res.end();
                clearInterval(tick);
            }
        }, slow ? 40 : 15);
        res.on('close', () => clearInterval(tick));
    });
});

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const files = new Map(), folders = new Set(['Agent']);
    const NoteFile = require('obsidian').TFile;
    const bees = Object.assign(new NoteFile(), { path: 'Biology/Bees.md', basename: 'Bees', extension: 'md', stat: { mtime: 2 }, parent: { path: 'Biology' } });
    const flowers = Object.assign(new NoteFile(), { path: 'Biology/Flowers.md', basename: 'Flowers', extension: 'md', stat: { mtime: 1 }, parent: { path: 'Biology' } });
    const app = {
        vault: {
            getName: () => 'Test vault',
            getMarkdownFiles: () => [bees, flowers],
            getAbstractFileByPath: (p) => (p === bees.path ? bees : p === flowers.path ? flowers : null),
            cachedRead: async (file) => (file === bees ? (globalThis.__beesText ?? '') : ''),
            read: async (file) => (file === bees ? (globalThis.__beesText ?? '') : ''),
            offref() {},
            getFolderByPath: (p) => (folders.has(p) ? {} : null),
            on: () => ({}),
            adapter: {
                exists: async (p) => files.has(p) || folders.has(p),
                mkdir: async (p) => folders.add(p),
                read: async (p) => files.get(p),
                write: async (p, d) => files.set(p, d),
                remove: async (p) => files.delete(p),
                list: async (p) => ({
                    files: [...files.keys()].filter((f) => f.startsWith(p + '/') && !f.slice(p.length + 1).includes('/')),
                    folders: [...folders].filter((f) => f.startsWith(p + '/') && !f.slice(p.length + 1).includes('/')),
                }),
            },
        },
        workspace: { on: () => ({}), trigger() {}, onLayoutReady: (cb) => cb(), getActiveFile: () => bees, getLastOpenFiles: () => ['Biology/Flowers.md'], offref() {}, getMostRecentLeaf: () => null, rootSplit: {}, getActiveViewOfType: () => null, getLeavesOfType: () => [], getRightLeaf: () => null, revealLeaf: async () => {} },
        secretStorage: { getSecret: () => null },
        loadLocalStorage: () => null,
        saveLocalStorage: () => {},
    };
    globalThis.__app = app;
    const Plugin = require(path.resolve(process.argv[2])).default;
    const plugin = new Plugin(app, { id: 'alphaino', version: '0.0.1' });
    // DUMP_NOMODEL: open the chat with nothing set up and write it out (the "No model" card), skipping the checks.
    plugin._data = process.env.DUMP_NOMODEL ? { prefs: {} } : { prefs: { llmProvider: 'ollama', llmModel: 'fake-model', ollamaBaseUrl: `http://127.0.0.1:${port}` } };
    await plugin.onload();
    const view = views['alphaino-chat']({});
    await view.onOpen();
    await new Promise((r) => setTimeout(r, 50));
    const root = view.contentEl;
    let reopened = null;
    if (process.env.DUMP_NOMODEL) {
        require('node:fs').writeFileSync(process.env.DUMP_NOMODEL, root.outerHTML);
        await view.onClose();
        await plugin.onunload();
        server.close();
        return;
    }
    const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) process.exitCode = 1; };
    check('the view renders the chat (header, empty state, composer)', !!root.querySelector('.alphaino-chat .alphaino-header') && !!root.querySelector('#welcome-page') && !!root.querySelector('textarea'));
    check('empty view: AlphainZ’s greeting with the message box in the middle', (root.querySelector('#welcome-page .text-2xl')?.textContent ?? '') === 'How can I help you?' && !!root.querySelector('#welcome-page .alphaino-composer textarea'));
    check('the model button names the model', root.querySelector('.alphaino-model-name')?.textContent === 'fake-model');
    check('the panda icon is registered and used for the ribbon', calls.some((c) => c[0] === 'addIcon' && c[1] === 'alphaino-panda') && calls.some((c) => c[0] === 'ribbon' && c[1] === 'alphaino-panda'));

    const textarea = root.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, 'What do bees eat?');
    textarea.dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    root.querySelector('.alphaino-composer button[aria-label="Send message"]').click();

    let answered = false;
    for (let i = 0; i < 100 && !answered; i += 1) {
        await new Promise((r) => setTimeout(r, 30));
        answered = [...files.keys()].some((f) => f.startsWith('Agent/.alphaino/conversations/')) && root.textContent.includes('and pollen.');
    }
    check('the answer streamed into the view', root.textContent.includes('Bees eat **nectar** and pollen.'));
    check('the question went to the model with the system prompt and the tools', seen[0]?.messages?.[0]?.role === 'system' && JSON.stringify(seen[0].messages).includes('What do bees eat?') && seen[0].model === 'fake-model' && seen[0].stream === true && seen[0].tools.some((tool) => tool.function?.name === 'return_suggestions'));
    await new Promise((r) => setTimeout(r, 400));
    const file = [...files.entries()].find(([f]) => f.startsWith('Agent/.alphaino/conversations/'));
    const saved = file && JSON.parse(file[1]);
    check('the conversation was saved under Agent/.alphaino/conversations', !!saved && saved.format === 'alphainz.conversation');
    check('the saved run is completed and holds the answer', saved?.runs?.[0]?.status === 'completed' && JSON.stringify(saved.runs[0].model_messages).includes('and pollen.'));
    check('the conversation got a title from the model', saved?.thread?.name === 'Bees and nectar');
    check('the header is AlphainZ’s: history, new chat, outline with the question count', !!root.querySelector('#alphainz-header [aria-label="Show chat history"]') && root.querySelector('.conversation-outline-count')?.textContent === '1');
    check('no notices (no save errors)', !calls.some((c) => c[0] === 'notice'));
    check('the question rail shows one mark per question', root.querySelectorAll('.conversation-rail-mark').length === 1);
    check('each run and its question carry the ids the rail jumps to', !!root.querySelector('[id^="run-"]') && !!root.querySelector('[id^="user-request-"]'));
    if (process.env.DUMP_HTML) require('node:fs').writeFileSync(process.env.DUMP_HTML, root.outerHTML);
    // Follow-up chips from the suggestions tool; clicking one asks it.
    const chip = root.querySelector('.alphaino-suggestions button.variant-surface-light');
    check('the suggestions tool drew a follow-up chip', chip?.textContent === 'More about pollen' && (root.querySelector('.alphaino-suggestions')?.textContent ?? '').startsWith('Next steps'));
    check('the suggestions call has no row of its own', !root.textContent.includes('return_suggestions'));
    chip?.click();
    for (let i = 0; i < 100 && !root.textContent.includes('Pollen is protein.'); i += 1) await new Promise((r) => setTimeout(r, 30));
    check('clicking the chip asked its question', root.textContent.includes('Tell me about pollen') && root.textContent.includes('Pollen is protein.'));
    await new Promise((r) => setTimeout(r, 200));
    check('the rail has a mark for each question', root.querySelectorAll('.conversation-rail-mark').length === 2);
    check('the chip went with the newer answer', !root.querySelector('.alphaino-suggestion'));
    // selection chat: a passage asked about lands in the composer and goes to the model with its source.
    const noteText = Array.from({ length: 11 }, (_, i) => `Line ${i + 1} about bees.`).join('\n') + '\nBees dance to say\nwhere the flowers are.\nMore after.';
    const lineStart = (line) => noteText.split('\n').slice(0, line).reduce((n, l) => n + l.length + 1, 0);
    const editor = {
        getCursor: (which) => (which === 'from' ? { line: 11, ch: 0 } : { line: 12, ch: 22 }),
        getSelection: () => 'Bees dance to say\nwhere the flowers are.',
        getValue: () => noteText,
        posToOffset: (pos) => lineStart(pos.line) + pos.ch,
    };
    await plugin.askAbout(editor, { file: { path: 'Biology/Bees.md' } });
    await new Promise((r) => setTimeout(r, 50));
    const composerChips = [...root.querySelectorAll('.alphaino-composer .composer-attachments .source-button')].map((b) => b.textContent.trim());
    check('context chips: the open note and the passage wait above the message box', composerChips.includes('Bees') && composerChips.includes('Text Selection'));
    check('context chips: the editor extension is registered', calls.some((c) => c[0] === 'editorExtension'));
    if (process.env.DUMP_COMPOSER) require('node:fs').writeFileSync(process.env.DUMP_COMPOSER, root.outerHTML);
    const box = root.querySelector('textarea');
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(box, 'Why do they dance?');
    box.dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    root.querySelector('.alphaino-composer button[aria-label="Send message"]').click();
    for (let i = 0; i < 100 && seen.filter((r) => Array.isArray(r.tools)).length < 3; i += 1) await new Promise((r) => setTimeout(r, 30));
    await new Promise((r) => setTimeout(r, 300));
    const lastMain = seen.filter((r) => Array.isArray(r.tools)).pop();
    const sentText = JSON.stringify(lastMain?.messages?.[lastMain.messages.length - 1] ?? {});
    check('selection chat: the model reads the open note, the passage, its note and its lines', sentText.includes('Currently open in the editor: [[Biology/Bees]].') && sentText.includes('[[Biology/Bees]] (lines 12–13)') && sentText.includes('Bees dance to say') && sentText.includes('Why do they dance?'));
    const allRuns = root.querySelectorAll('.alphaino-run');
    const sentChips = [...(allRuns[allRuns.length - 1]?.querySelectorAll('.alphaino-user .source-button') ?? [])].map((b) => b.textContent.trim());
    const leftChips = [...root.querySelectorAll('.alphaino-composer .composer-attachments .source-button')].map((b) => b.textContent.trim());
    check('selection chat: the question shows what it carried, and the passage left the composer', sentChips.includes('Text Selection') && sentChips.includes('Bees') && !leftChips.includes('Text Selection'));
    const storedFile = [...files.entries()].filter(([f]) => f.startsWith('Agent/.alphaino/conversations/')).pop();
    const storedRun = storedFile && JSON.parse(storedFile[1]).runs.pop();
    check('selection chat: the stored question keeps its passage with an Orbit anchor', storedRun?.user_prompt?.alphaino_quote?.anchor?.quote === 'Bees dance to say\nwhere the flowers are.' && storedRun?.user_prompt?.alphaino_note === 'Biology/Bees.md');
    // An answer about a passage offers to keep it as a comment on the passage (AlphainZ's "Save to the highlight?").
    const offerCard = root.querySelector('.alphaino-comment-offer');
    check('passage answers: an offer to save it as a comment, with a preview', !!offerCard && (offerCard.textContent ?? '').includes('— AlphainO') && (offerCard.textContent ?? '').includes('Q: Why do they dance?'));
    if (process.env.DUMP_OFFER) require('node:fs').writeFileSync(process.env.DUMP_OFFER, root.outerHTML);
    [...(offerCard?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Not now')?.click();
    await new Promise((r) => setTimeout(r, 30));
    check('passage answers: "Not now" puts the offer away', !root.querySelector('.alphaino-comment-offer'));
    if (process.env.DUMP_END) require('node:fs').writeFileSync(process.env.DUMP_END, root.outerHTML);
    // The outline lists every question; the history lists the chat.
    root.querySelector('.conversation-outline-button')?.click();
    await new Promise((r) => setTimeout(r, 30));
    check('outline: every question listed', root.querySelectorAll('.thread-overlay-panel [role="option"]').length === 3);
    if (process.env.DUMP_OUTLINE) require('node:fs').writeFileSync(process.env.DUMP_OUTLINE, root.outerHTML);
    root.querySelector('.thread-overlay-backdrop')?.click();
    await new Promise((r) => setTimeout(r, 30));
    root.querySelector('[aria-label="Show chat history"]')?.click();
    for (let i = 0; i < 50 && !root.querySelector('.thread-list-item'); i += 1) await new Promise((r) => setTimeout(r, 20));
    check('history: the chat is listed under Today, marked current', root.querySelector('.thread-group-header')?.textContent === 'Today' && (root.querySelector('.thread-list-item-time')?.textContent ?? '').includes('current chat'));
    if (process.env.DUMP_HISTORY) require('node:fs').writeFileSync(process.env.DUMP_HISTORY, root.outerHTML);
    root.querySelector('.thread-overlay-backdrop')?.click();
    await new Promise((r) => setTimeout(r, 30));
    // Editing a sent question: click it, change it, send; the answers after it are replaced.
    const boxes = root.querySelectorAll('.user-request-view');
    const before = root.querySelectorAll('.alphaino-run').length;
    boxes[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 30));
    const questionEditor = root.querySelector('.user-request-edit-overlay textarea');
    if (process.env.DUMP_EDIT) require('node:fs').writeFileSync(process.env.DUMP_EDIT, root.outerHTML);
    check('edit & resend: clicking a question opens it for editing, with its text', questionEditor?.value === 'Tell me about pollen');
    if (questionEditor) {
        Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(questionEditor, 'What is pollen made of?');
        questionEditor.dispatchEvent(new w.Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 20));
        const sendButton = root.querySelector('.user-request-edit-overlay button[type="submit"]');
        sendButton?.click();
        // Replacing a later answer is asked first, in Obsidian's dialog (AlphainZ's "Retry from here?").
        for (let i = 0; i < 50 && !w.document.querySelector('.modal .mod-warning'); i += 1) await new Promise((r) => setTimeout(r, 10));
        const retryDialog = w.document.querySelector('.modal')?.textContent ?? '';
        w.document.querySelector('.modal .mod-warning')?.click();
        check('edit & resend: replacing the later answer is asked first', retryDialog.includes('Retry from here?') && retryDialog.includes('removes the question and answer after it'));
        for (let i = 0; i < 100 && !root.textContent.includes('What is pollen made of?'); i += 1) await new Promise((r) => setTimeout(r, 30));
        await new Promise((r) => setTimeout(r, 500));
        const runsAfter = root.querySelectorAll('.alphaino-run').length;
        check('edit & resend: the edited question replaced it and the answers after it', before === 3 && runsAfter === 2 && root.textContent.includes('What is pollen made of?') && !root.textContent.includes('Why do they dance?'));
        const savedNow = [...files.entries()].filter(([f]) => f.startsWith('Agent/.alphaino/conversations/')).map(([, v]) => JSON.parse(v));
        check('edit & resend: the saved conversation has the edited question and no later ones', savedNow.some((c) => c.runs.length === 2 && c.runs[1].user_prompt.content === 'What is pollen made of?'));
    }
    // "@" in the message box opens AlphainZ's Add Sources search; what follows it is the query, picking attaches.
    {
        const area = root.querySelector('.alphaino-composer textarea');
        const setValue = async (text) => {
            Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(area, text);
            area.dispatchEvent(new w.Event('input', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 30));
        };
        await setValue('Compare @');
        await setValue('Compare @Flo');
        const option = [...w.document.querySelectorAll('[role="option"], [role="menuitem"], .search-menu-item, button')].find((el) => (el.textContent ?? '').includes('Flowers'));
        if (!option && process.env.DEBUG_AT) console.log('AT-DEBUG', area.value, '|', (w.document.body.innerHTML.match(/.{0,300}Flowers.{0,200}/) ?? ['(no Flowers)'])[0], '| menus:', w.document.querySelectorAll('.search-menu').length);
        check('@ search: typing after "@" lists matching notes', !!option);
        option?.click();
        await new Promise((r) => setTimeout(r, 60));
        const chips = [...root.querySelectorAll('.alphaino-composer .composer-attachments .source-button')].map((b) => b.textContent.trim());
        check('@ search: picking attaches the note and takes "@query" out of the message', chips.includes('Flowers') && area.value === 'Compare ');
        await setValue('');
        [...root.querySelectorAll('.alphaino-composer .composer-attachments .source-button')].find((b) => b.textContent.trim() === 'Flowers')?.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true }));
    }
    // A new chat shows the empty view again, with the chat just had listed as related to the open note.
    root.querySelector('#alphainz-header [aria-label="New chat"]')?.click();
    for (let i = 0; i < 50 && !root.querySelector('.recent-chats-item'); i += 1) await new Promise((r) => setTimeout(r, 20));
    const recentLabel = root.querySelector('.recent-chats-label')?.textContent ?? '';
    const recentItems = [...root.querySelectorAll('.recent-chats-item')];
    check('empty view: the chat is listed under "Related to this note"', recentLabel === 'Related to this note' && recentItems.length === 1 && (recentItems[0].textContent ?? '').length > 0);
    if (process.env.DUMP_HOME) require('node:fs').writeFileSync(process.env.DUMP_HOME, root.outerHTML);
    [...root.querySelectorAll('.recent-chats-header button')].find((b) => b.textContent === 'View All')?.click();
    for (let i = 0; i < 50 && !root.querySelector('.thread-filter-count'); i += 1) await new Promise((r) => setTimeout(r, 20));
    check('empty view: View All opens the history filtered to the note', (root.querySelector('.thread-filter-chip')?.textContent ?? '').includes('Bees') && (root.querySelector('.thread-filter-count')?.textContent ?? '') === 'Showing 1 chat related to Bees');
    root.querySelector('.thread-overlay-backdrop')?.click();
    await new Promise((r) => setTimeout(r, 30));
    root.querySelector('.recent-chats-item')?.click();
    for (let i = 0; i < 50 && !root.querySelector('.alphaino-run'); i += 1) await new Promise((r) => setTimeout(r, 20));
    check('empty view: clicking a listed chat opens it', root.querySelectorAll('.alphaino-run').length === 2 && !root.querySelector('#welcome-page'));
    // Explain: the passage and the question go at once, and the message box is left empty.
    const requestsBefore = seen.filter((r) => Array.isArray(r.tools)).length;
    await plugin.handOver(plugin.editorPassage(editor, { file: { path: 'Biology/Bees.md' } }), 'Explain this, please.', true);
    for (let i = 0; i < 100 && seen.filter((r) => Array.isArray(r.tools)).length === requestsBefore; i += 1) await new Promise((r) => setTimeout(r, 30));
    await new Promise((r) => setTimeout(r, 300));
    const explainSent = JSON.stringify(seen.filter((r) => Array.isArray(r.tools)).pop()?.messages?.slice(-1) ?? {});
    const leftInBox = root.querySelector('.alphaino-composer textarea')?.value ?? '';
    const leftChipsAfter = [...root.querySelectorAll('.alphaino-composer .composer-attachments .source-button')].map((b) => b.textContent.trim());
    check('explain: the passage and the question were sent at once', explainSent.includes('Explain this, please.') && explainSent.includes('Bees dance to say') && root.querySelectorAll('.alphaino-run').length === 3);
    check('explain: the message box is empty afterwards', leftInBox === '' && !leftChipsAfter.includes('Text Selection'));
    // Drafts: closing the chat keeps its conversation and the half-written message; a new chat parks the draft.
    const typeInto = async (container, text) => {
        const area = container.querySelector('.alphaino-composer textarea');
        Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(area, text);
        area.dispatchEvent(new w.Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 30));
    };
    await typeInto(root, 'half a thought');
    await view.onClose();
    reopened = views['alphaino-chat']({});
    await reopened.onOpen();
    await new Promise((r) => setTimeout(r, 100));
    const root2 = reopened.contentEl;
    const boxValue = () => root2.querySelector('.alphaino-composer textarea')?.value;
    check('drafts: the chat reopens with its conversation and the half-written message', root2.querySelectorAll('.alphaino-run').length === 3 && boxValue() === 'half a thought');
    root2.querySelector('#alphainz-header [aria-label="New chat"]')?.click();
    await new Promise((r) => setTimeout(r, 60));
    const inNewChat = boxValue();
    for (let i = 0; i < 50 && !root2.querySelector('.recent-chats-item'); i += 1) await new Promise((r) => setTimeout(r, 20));
    root2.querySelector('.recent-chats-item')?.click();
    for (let i = 0; i < 50 && !root2.querySelector('.alphaino-run'); i += 1) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 30));
    check('drafts: a new chat starts empty, and going back brings the draft back', inNewChat === '' && boxValue() === 'half a thought');
    // A new chat while it answers: asked first; yes stops the answer, which is kept in its chat.
    await typeInto(root2, 'Answer SLOW please');
    root2.querySelector('.alphaino-composer button[aria-label="Send message"]').click();
    for (let i = 0; i < 100 && !(root2.textContent ?? '').includes('word3'); i += 1) await new Promise((r) => setTimeout(r, 20));
    const slowChat = (() => { const files2 = [...files.entries()].filter(([f]) => f.startsWith('Agent/.alphaino/conversations/')); return files2.length; })();
    const savedWhileAnswering = [...files.entries()].filter(([f]) => f.startsWith('Agent/.alphaino/conversations/')).map(([, v]) => JSON.parse(v)).flatMap((c) => c.runs).find((r) => r.user_prompt.content === 'Answer SLOW please');
    check('while answering: the question is saved before the answer ends', !!savedWhileAnswering && savedWhileAnswering.status === 'in_progress');
    const newChatButton = root2.querySelector('#alphainz-header [aria-label="New chat"]');
    const newChatEnabled = !!newChatButton && !newChatButton.disabled;
    newChatButton?.click();
    for (let i = 0; i < 50 && !w.document.querySelector('.modal .mod-warning'); i += 1) await new Promise((r) => setTimeout(r, 10));
    const dialogText = w.document.querySelector('.modal')?.textContent ?? '';
    w.document.querySelector('.modal .mod-warning')?.click();
    for (let i = 0; i < 100 && !root2.querySelector('#welcome-page'); i += 1) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 400));
    const keptRun = [...files.entries()].filter(([f]) => f.startsWith('Agent/.alphaino/conversations/')).map(([, v]) => JSON.parse(v)).flatMap((c) => c.runs).find((r) => r.user_prompt.content === 'Answer SLOW please');
    check('while answering: New chat stays usable and asks before stopping the answer', newChatEnabled && dialogText.includes('Start new chat?') && dialogText.includes('Starting a new chat will stop it.'));
    const whileAnsweringOk = !!root2.querySelector('#welcome-page');
    check('while answering: yes opens a new chat and keeps the stopped answer in its own chat', !!root2.querySelector('#welcome-page') && root2.querySelectorAll('.alphaino-run').length === 0 && !!keptRun && keptRun.status !== 'in_progress' && slowChat >= 1);
    // Archiving the chat while it answers: it stays in the archive (the stopped answer is not saved back over it).
    if (whileAnsweringOk) {
        await typeInto(root2, 'Archive me SLOW');
        root2.querySelector('.alphaino-composer button[aria-label="Send message"]').click();
        for (let i = 0; i < 100 && !(root2.textContent ?? '').includes('word2'); i += 1) await new Promise((r) => setTimeout(r, 20));
        root2.querySelector('#alphainz-header [aria-label="Show chat history"]')?.click();
        for (let i = 0; i < 50 && !root2.querySelector('.thread-list-item'); i += 1) await new Promise((r) => setTimeout(r, 20));
        const currentRow = [...root2.querySelectorAll('.thread-list-item')].find((row) => (row.textContent ?? '').includes('current chat'));
        currentRow?.querySelector('[aria-label="Move this chat to the archive"]')?.click();
        await new Promise((r) => setTimeout(r, 1500));
        const archivedChat = [...files.entries()].filter(([f]) => f.startsWith('Agent/.alphaino/conversations/')).map(([, v]) => JSON.parse(v)).find((c) => c.runs.some((r) => r.user_prompt.content === 'Archive me SLOW'));
        check('while answering: a chat archived from the history stays archived', !!currentRow && !!archivedChat && !!archivedChat.thread.archivedAt);
        root2.querySelector('.thread-overlay-backdrop')?.click();
        await new Promise((r) => setTimeout(r, 30));
    }
    // A cut-off answer comes with AlphainZ's warning box, which links to the settings and can be dismissed.
    if (whileAnsweringOk) {
        await typeInto(root2, 'CUTOFF here');
        root2.querySelector('.alphaino-composer button[aria-label="Send message"]').click();
        for (let i = 0; i < 100 && !root2.querySelector('[data-warning-tone]'); i += 1) await new Promise((r) => setTimeout(r, 30));
        const warningBox = root2.querySelector('[data-warning-tone="warning"]');
        if (process.env.DUMP_WARNING) require('node:fs').writeFileSync(process.env.DUMP_WARNING, root2.outerHTML);
        check('warnings: a cut-off answer shows the warning box with a settings link', !!warningBox && (warningBox.textContent ?? '').includes('Open Settings'));
        warningBox?.querySelector('[aria-label="Dismiss this warning"]')?.click();
        await new Promise((r) => setTimeout(r, 30));
        check('warnings: dismissing puts it away', !root2.querySelector('[data-warning-tone="warning"]'));
    }
    // A link to an answer (obsidian://alphaino?thread=…&run=…) opens its chat in the view.
    if (reopened && globalThis.__protocol) {
        const savedChats = [...files.entries()].filter(([f]) => f.startsWith('Agent/.alphaino/conversations/')).map(([, v]) => JSON.parse(v));
        // The chat with the most questions (not the one on screen, which has one).
        const target = savedChats.sort((a, b) => b.runs.length - a.runs.length)[0];
        const want = target?.runs.length ?? -1;
        if (target) {
            globalThis.__protocol({ action: 'alphaino', thread: target.thread.id, run: target.runs[1].id });
            for (let i = 0; i < 100 && reopened.contentEl.querySelectorAll('.alphaino-run').length !== want; i += 1) await new Promise((r) => setTimeout(r, 20));
        }
        check('links: obsidian://alphaino?thread=… opens that chat', want > 1 && reopened.contentEl.querySelectorAll('.alphaino-run').length === want && calls.some((c) => c[0] === 'protocol' && c[1] === 'alphaino'));
        // A chat whose answer was still being written when Obsidian closed shows it as interrupted, with Retry.
        if (target) {
            const cut = JSON.parse(JSON.stringify(target));
            cut.thread.id = 'cut-off-chat';
            cut.thread.updatedAt = new Date().toISOString();
            cut.runs = cut.runs.slice(0, 1).map((r) => ({ ...r, id: 'cut-run', thread_id: 'cut-off-chat', status: 'in_progress' }));
            files.set('Agent/.alphaino/conversations/cut-off-chat.json', JSON.stringify(cut));
            globalThis.__protocol({ action: 'alphaino', thread: 'cut-off-chat' });
            for (let i = 0; i < 100 && !reopened.contentEl.querySelector('.alphaino-interrupted'); i += 1) await new Promise((r) => setTimeout(r, 20));
            const card = reopened.contentEl.querySelector('.alphaino-interrupted');
            check('interrupted: an answer cut off by closing shows AlphainZ’s card with Retry', !!card && (card.textContent ?? '').includes('Response interrupted') && (card.textContent ?? '').includes('Retry'));
            globalThis.__protocol({ action: 'alphaino', thread: target.thread.id });
            for (let i = 0; i < 100 && reopened.contentEl.querySelectorAll('.alphaino-run').length !== want; i += 1) await new Promise((r) => setTimeout(r, 20));
        }
        const menuButton = reopened.contentEl.querySelector('#alphainz-header [aria-label="Chat actions"]');
        check('chat actions: the ⋯ menu is in the header of a chat with questions', !!menuButton);
        // Working steps fold behind one line once the answer is done (AlphainZ's work stream, collapsed by default).
        const rootR = reopened.contentEl;
        const runsBefore = rootR.querySelectorAll('.alphaino-run').length;
        await typeInto(rootR, 'Show STEPS please');
        rootR.querySelector('.alphaino-composer button[aria-label="Send message"]').click();
        for (let i = 0; i < 150 && !(rootR.textContent ?? '').includes('Your vault has two folders'); i += 1) await new Promise((r) => setTimeout(r, 30));
        await new Promise((r) => setTimeout(r, 200));
        const lastRun = [...rootR.querySelectorAll('.alphaino-run')].pop();
        const fold = lastRun?.querySelector('.work-stream');
        const foldButton = fold?.querySelector('[data-step-group="true"]');
        if (process.env.DUMP_STEPS) require('node:fs').writeFileSync(process.env.DUMP_STEPS, rootR.outerHTML);
        check('steps: the work folds behind one line, closed, naming what it did', rootR.querySelectorAll('.alphaino-run').length === runsBefore + 1 && !!fold && foldButton?.getAttribute('aria-expanded') === 'false' && (foldButton?.textContent ?? '').includes('List tags') && (foldButton?.textContent ?? '').includes('List folders'));
        check('steps: the answer stays outside the fold', (lastRun?.textContent ?? '').includes('Your vault has two folders') && !(fold?.textContent ?? '').includes('Your vault has two folders'));
        foldButton?.click();
        await new Promise((r) => setTimeout(r, 30));
        check('steps: a click opens the fold, with the narration and the steps inside', (lastRun?.querySelector('.work-stream')?.textContent ?? '').includes('Let me look.'));
        plugin.prefs.set('streamDisplay', 'answer');
        // The eye menu writes the same setting; a new view reads it.
        await reopened.onClose();
        reopened = views['alphaino-chat']({});
        await reopened.onOpen();
        await new Promise((r) => setTimeout(r, 100));
        const lastAfter = [...reopened.contentEl.querySelectorAll('.alphaino-run')].pop();
        check('steps: "Answer only" leaves just the answer', !!lastAfter && !lastAfter.querySelector('.work-stream') && !(lastAfter.textContent ?? '').includes('Let me look.') && (lastAfter.textContent ?? '').includes('Your vault has two folders'));
        plugin.prefs.set('streamDisplay', 'collapsed');
        // Thinking between the steps, the fold opened (DUMP_THINK for a visual check): every row in AlphainZ's frame.
        await reopened.onClose();
        reopened = views['alphaino-chat']({});
        await reopened.onOpen();
        await new Promise((r) => setTimeout(r, 100));
        const rootT = reopened.contentEl;
        await typeInto(rootT, 'THINK then answer');
        rootT.querySelector('.alphaino-composer button[aria-label="Send message"]').click();
        for (let i = 0; i < 200 && !(rootT.textContent ?? '').includes('two notes and no tags'); i += 1) await new Promise((r) => setTimeout(r, 30));
        await new Promise((r) => setTimeout(r, 200));
        const thinkRun = [...rootT.querySelectorAll('.alphaino-run')].pop();
        thinkRun?.querySelector('.work-stream [data-step-group="true"]')?.click();
        await new Promise((r) => setTimeout(r, 50));
        if (process.env.DUMP_THINK) require('node:fs').writeFileSync(process.env.DUMP_THINK, rootT.outerHTML);
        if (process.env.DUMP_THINK_OPEN) {
            // The same fold with the first thought and the notes list opened.
            thinkRun?.querySelector('.work-stream .alphaino-thinking button')?.click();
            [...(thinkRun?.querySelectorAll('.work-stream .alphaino-tool button') ?? [])].pop()?.click();
            await new Promise((r) => setTimeout(r, 50));
            require('node:fs').writeFileSync(process.env.DUMP_THINK_OPEN, rootT.outerHTML);
        }
        const stepRows = [...(thinkRun?.querySelectorAll('.work-stream .alphaino-thinking, .work-stream .alphaino-tool') ?? [])];
        check('steps: thinking rows between the tool rows, each row in the same px-3 frame', stepRows.filter((r) => r.classList.contains('alphaino-thinking')).length === 3 && stepRows.filter((r) => r.classList.contains('alphaino-tool')).length === 3 && stepRows.every((r) => !!r.querySelector(':scope > div > button > .px-3')));
    }
    // Comments: a thread written through the store shows in the comments view of the open note.
    globalThis.__beesText = noteText;
    const commentsView = views['alphaino-comments']?.({});
    check('comments: the comments view is registered', !!commentsView);
    if (commentsView) {
        await commentsView.onOpen();
        await new Promise((r) => setTimeout(r, 30));
        const anchor = plugin.anchorFor('Biology/Bees.md', noteText, noteText.indexOf('Bees dance'), noteText.indexOf('Bees dance') + 'Bees dance to say'.length);
        await plugin.comments.addThread({ actor: 'user', anchor, text: 'Is this from von Frisch?' });
        await new Promise((r) => setTimeout(r, 60));
        const cards = commentsView.contentEl.querySelectorAll('.alphaino-thread');
        check('comments: the new thread shows on the open note, with its passage', cards.length === 1 && cards[0].textContent.includes('Bees dance to say') && cards[0].textContent.includes('Is this from von Frisch?'));
        const eventFiles = [...files.keys()].filter((f) => f.startsWith('Agent/.alphaino/comments/'));
        check('comments: one Orbit event file under Agent/.alphaino/comments/<month>/', eventFiles.length === 1 && /comments\/\d{4}-\d{2}\/[0-9a-f-]{36}\.json$/.test(eventFiles[0]));
        // The Unresolved / All switch says which is on; the rail has a tick per thread shown.
        const switchButtons = [...commentsView.contentEl.querySelectorAll('.alphaino-segmented button')];
        check('comments: the switch marks the option that is on', switchButtons.length === 2 && switchButtons[0].getAttribute('aria-pressed') === 'true' && switchButtons[1].getAttribute('aria-pressed') === 'false' && switchButtons[0].classList.contains('is-active'));
        const anchor2 = plugin.anchorFor('Biology/Bees.md', noteText, 0, 4);
        const second = await plugin.comments.addThread({ actor: 'user', anchor: anchor2, text: 'A second comment' });
        const reply = await plugin.comments.reply({ actor: 'user', threadId: second.root.id, text: 'A reply to delete' });
        await new Promise((r) => setTimeout(r, 60));
        const marks = commentsView.contentEl.querySelectorAll('.alphaino-comment-rail .conversation-rail-mark');
        check('comments: one tick per thread on the rail, beside the list', marks.length === 2 && !!commentsView.contentEl.querySelector('.alphaino-comments-body.has-rail'));
        // Delete a reply, then the whole thread from its first comment; Undo brings the thread back.
        const card2 = () => commentsView.contentEl.querySelector(`[data-thread="${second.root.id}"]`);
        card2()?.querySelectorAll('.alphaino-comment-delete')[1]?.click();
        await new Promise((r) => setTimeout(r, 60));
        check('comments: a reply’s delete removes just that reply', !!card2() && !(card2()?.textContent ?? '').includes('A reply to delete') && (card2()?.textContent ?? '').includes('A second comment') && plugin.comments.thread(second.root.id)?.replies.find((x) => x.id === reply.id)?.deleted === true);
        const noticesBefore = calls.filter((c) => c[0] === 'notice').length;
        card2()?.querySelector('.alphaino-comment-delete')?.click();
        await new Promise((r) => setTimeout(r, 60));
        const deletedNotice = calls.filter((c) => c[0] === 'notice').slice(noticesBefore).pop()?.[1];
        check('comments: the first comment’s delete removes the thread, with Undo in the notice', !card2() && commentsView.contentEl.querySelectorAll('.alphaino-comment-rail .conversation-rail-mark').length === 1 && !!deletedNotice?.querySelector?.('.alphaino-notice-undo'));
        deletedNotice?.querySelector('.alphaino-notice-undo')?.click();
        await new Promise((r) => setTimeout(r, 80));
        check('comments: Undo brings the thread back', !!card2() && (card2()?.textContent ?? '').includes('A second comment'));
        if (process.env.DUMP_COMMENTS) require('node:fs').writeFileSync(process.env.DUMP_COMMENTS, commentsView.contentEl.outerHTML);
        if (process.env.DUMP_COMMENTS_PEEK) {
            // The pointer on the rail: the card previews the nearest thread (no layout here, so the first).
            commentsView.contentEl.querySelector('.alphaino-comment-rail .conversation-rail-marks')?.dispatchEvent(new w.MouseEvent('pointerenter', { clientY: 0 }));
            await new Promise((r) => setTimeout(r, 50));
            require('node:fs').writeFileSync(process.env.DUMP_COMMENTS_PEEK, commentsView.contentEl.outerHTML);
        }
        await commentsView.onClose();
    }
    // Settings: AlphainZ's model settings and AlphainO's own sections in one page (DUMP_SETTINGS for a visual check).
    const tab = settingTabs[0];
    check('settings: a settings tab is registered', !!tab);
    if (tab) {
        w.document.body.appendChild(tab.containerEl);
        tab.display();
        await new Promise((r) => setTimeout(r, 300));
        const page = tab.containerEl.querySelector('[data-testid="alphaino-settings"]');
        check('settings: the model settings and the native sections draw', !!page && tab.containerEl.querySelectorAll('.setting-item-heading').length >= 2 && tab.containerEl.querySelectorAll('select').length >= 2);
        if (process.env.DUMP_SETTINGS) require('node:fs').writeFileSync(process.env.DUMP_SETTINGS, tab.containerEl.outerHTML);
        tab.hide();
    }
    await (reopened ?? view).onClose();
    await plugin.onunload();
    server.close();
})().catch((error) => { console.error('SMOKE ERROR', error); process.exitCode = 1; server.close(); });
