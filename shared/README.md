# Shared code from AlphainZ

AlphainO is built on code it shares with [AlphainZ](https://github.com/Alphainfix/AlphainZ), the same
assistant for Zotero. This folder is a copy of the parts AlphainO uses, with AlphainZ's paths kept:

- `packages/agent-core`, `packages/agent-llm`, `packages/agent-ui`: conversations and runs, the model
  layer (providers, the agent loop, embeddings) and the chat interface. Only the files AlphainO's build
  and tests read are here; the whole packages are in AlphainZ's `plugin/packages/`.
- `src/i18n/zh-CN.ts`: AlphainZ's Chinese interface text, which AlphainO uses for the shared parts.
- `addon/content/styles/beaver.css`: AlphainZ's stylesheet. The build keeps only the rules for its chat
  pane and scopes them to AlphainO's view.

A few composer files import Lexical's types, so `lexical` and `@lexical/react` are development
dependencies; AlphainO's bundle does not contain Lexical.

Changes to this code are made in AlphainZ first and copied here when AlphainO is released. It is under the
same licence as the rest of this repository (AGPL-3.0); parts of it come from
[Beaver](https://github.com/jlegewie/beaver-zotero) by Joscha Legewie.
