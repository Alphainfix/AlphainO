<h1 align="center">AlphainO</h1>

<p align="center">
  <a href="https://obsidian.md"><img alt="Obsidian 1.11.4 or later, desktop" src="https://img.shields.io/badge/Obsidian-1.11.4%2B%20desktop-555?style=flat-square"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square"></a>
</p>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>

**Free and open source.** AlphainO is a research assistant in Obsidian's sidebar: the assistant of
[AlphainZ](https://github.com/Alphainfix/AlphainZ) (for Zotero), working on your notes. You chat with it using
your own models and API keys, and there is no account to sign up for: your questions go from your computer
straight to the model provider you chose.

## What it does

- **Ask about your notes.** A question can carry the open note, notes you add with "@", and a passage you
  selected, in the editor or in Reading view.
- **It searches your vault.** By keyword, by meaning (an index of your notes made with an embedding model),
  by title, tag, property, folder and date, and along the links between notes; then it reads the notes it needs.
- **Pictures by what they show** (off by default). With an embedding model that takes images, a description
  finds the screenshot, photo or chart, and the answer shows it.
- **Comments on passages.** A comment stays with its text after the note changes. AlphainO reads comments
  together with their passages, and can add and answer them.
- **Edits you review.** When AlphainO changes a note, the change goes in at once (one undo), and each changed
  span has Accept and Reject.
- **Your Zotero library too.** While AlphainZ runs in Zotero, AlphainO can search your library and read papers
  through it.
- **For Claude** (off by default): an MCP server lets Claude Code and Claude Desktop search, read and comment
  on your vault, and propose edits you review.
- Conversations are files in your vault, a chat can be linked to from a note, and the interface is in English
  or Chinese.

## Models

Built in: DeepSeek, OpenRouter, Zhipu (BigModel), Google Gemini, OpenAI, and Ollama on your own computer.
Anything else that speaks the OpenAI API can be added by hand. The model settings are AlphainZ's: each
model's thinking levels, context window and output limit.

Search by meaning needs an embedding model: Gemini Embedding 2, OpenAI, or EmbeddingGemma 2 in Ollama.
Without one, notes are searched by keyword.

## Network use and your data

- Your questions, and the parts of your notes they need, go to the model provider you chose. With search by
  meaning, your notes are sent to the embedding provider to be indexed; with picture search on, so are your
  pictures, shrunk.
- AlphainO also talks to programs on this computer: Ollama (`127.0.0.1:11434`) if you use it, and Zotero
  (`127.0.0.1:23119`) to reach AlphainZ (Settings → Zotero library (AlphainZ) turns this off). Its MCP server, once you
  turn it on, listens on `127.0.0.1:23129` and answers only requests from this computer.
- No telemetry, no account, and no code downloaded while it runs.
- API keys stay in Obsidian's secret storage on the computer you entered them on. The plugin's settings file,
  which syncs with your vault, holds only the name of each key.
- Conversations and comments are files in `Agent/.alphaino/` (or `.alphaino/` at the vault root), a hidden
  folder that Obsidian leaves out of search. The search indexes stay in Obsidian's local storage on each
  computer.
- Apart from that local storage, AlphainO reads and writes only inside your vault. For Claude Desktop it
  shows the entry to add to Claude's configuration; it does not change that file itself.

## Install

AlphainO is not in Obsidian's community plugin directory yet. Build it from source:

```bash
git clone https://github.com/Alphainfix/AlphainO.git
cd AlphainO
npm ci
npm run build        # writes build/main.js, build/manifest.json and build/styles.css
```

Copy the three files into `<your vault>/.obsidian/plugins/alphaino/` (or run
`ALPHAINO_VAULT="<your vault>" node esbuild.config.mjs production`), then turn AlphainO on in
Settings → Community plugins. Desktop only; Obsidian 1.11.4 or later.

## Development

```bash
npm test             # unit tests
npm run smoke        # builds, then drives the plugin in a stand-in Obsidian against a fake model server
```

The code AlphainO shares with AlphainZ is in [`shared/`](shared/README.md).

## License

AlphainO is free software under the [GNU Affero General Public License v3.0 or later](LICENSE), like AlphainZ,
whose code it shares.

- [AlphainZ](https://github.com/Alphainfix/AlphainZ): the model layer, the chat interface and the model settings.
- [Beaver](https://github.com/jlegewie/beaver-zotero), by Joscha Legewie: the plugin AlphainZ is based on.
- Orbit Comments: the comment anchors and their file format (MIT; its notice is kept in
  `src/comments/anchor.ts`).
