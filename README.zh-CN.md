<h1 align="center">AlphainO</h1>

<p align="center">
  <a href="https://obsidian.md"><img alt="Obsidian 1.11.4 或更新，电脑版" src="https://img.shields.io/badge/Obsidian-1.11.4%2B%20desktop-555?style=flat-square"></a>
  <a href="LICENSE"><img alt="许可证：AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square"></a>
</p>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

**开源免费。** AlphainO 是 Obsidian 侧栏里的研究助手，就是 [AlphainZ](https://github.com/Alphainfix/AlphainZ)（Zotero 版）的那个助手，换成在你的笔记上干活。你用自己的模型和 API key 和它对话，不用注册账号，问题从你的电脑直接发给你选的模型厂商。

## 能做什么

- **问你的笔记。** 提问时可以带上正在看的笔记、用「@」加进来的笔记，以及你选中的一段话，编辑模式和阅读视图里都能选。
- **它会自己在库里找。** 按关键词找，按意思找（用嵌入模型给笔记建的索引），按标题、标签、属性、文件夹和日期找，也会顺着笔记之间的链接找，再读它需要的笔记。
- **按画面内容找图**（默认关闭）。用能看图的嵌入模型时，描述一下就能找到那张截图、照片或图表，回答里会直接显示出来。
- **给段落写评论。** 笔记改了，评论照样跟着原来那段话。AlphainO 读评论时会连同对应的原文一起看，也能写评论、回复评论。
- **改稿你来审。** AlphainO 改笔记时，改动直接写进笔记（撤销一次就能退回），每一处改动都有「接受」和「拒绝」。
- **也能查 Zotero 文献库。** Zotero 里开着 AlphainZ 时，AlphainO 可以通过它搜你的文献库、读论文。
- **给 Claude 用**（默认关闭）：打开 MCP 服务后，Claude Code 和 Claude Desktop 可以通过 AlphainO 搜索、阅读和评论你的库，改稿也要你审过。
- 对话存成库里的文件，笔记里可以放指向某次对话的链接，界面有中文和英文。

## 模型

自带 DeepSeek、OpenRouter、智谱（BigModel）、Google Gemini、OpenAI，以及在你自己电脑上跑的 Ollama。其他兼容 OpenAI API 的服务也可以手动添加。模型设置和 AlphainZ 一样：每个模型可以设思考档位、上下文长度和输出上限。

按意思搜索要一个嵌入模型：Gemini Embedding 2、OpenAI，或者 Ollama 里的 EmbeddingGemma 2。没有的话，笔记只按关键词搜。

## 联网和你的数据

- 你的问题，以及回答它需要的笔记内容，会发给你选的模型厂商。用按意思搜索时，笔记会发给嵌入模型的厂商建索引；打开按画面找图后，图片也会缩小后发过去。
- AlphainO 还会连本机上的程序：用 Ollama 时连 `127.0.0.1:11434`，连 Zotero（`127.0.0.1:23119`）是为了用 AlphainZ（设置 → Zotero 文献库（AlphainZ）里可以关掉）。MCP 服务打开后监听 `127.0.0.1:23129`，只回应本机发来的请求。
- 没有遥测，不用账号，运行时不下载代码。
- API key 存在你输入它的那台电脑上的 Obsidian 密钥存储里。插件的设置文件会跟着库同步，里面只记每个 key 的名字。
- 对话和评论是 `Agent/.alphaino/`（没有 Agent 文件夹时是库根目录的 `.alphaino/`）里的文件。这是隐藏文件夹，Obsidian 搜索时会跳过它。搜索索引存在每台电脑上 Obsidian 自己的本地存储里。
- 除了这份本地存储，AlphainO 只读写你的库里的东西。Claude Desktop 那边，它只把要加进 Claude 配置的那一段显示给你，不会自己去改那个文件。

## 安装

AlphainO 还没进 Obsidian 的社区插件目录，现在要从源码构建：

```bash
git clone https://github.com/Alphainfix/AlphainO.git
cd AlphainO
npm ci
npm run build        # 生成 build/main.js、build/manifest.json 和 build/styles.css
```

把这三个文件拷进 `<你的库>/.obsidian/plugins/alphaino/`（或者运行 `ALPHAINO_VAULT="<你的库>" node esbuild.config.mjs production`），再到 设置 → 第三方插件 里打开 AlphainO。只支持电脑版，要 Obsidian 1.11.4 或更新。

## 开发

```bash
npm test             # 单元测试
npm run smoke        # 构建，然后在模拟的 Obsidian 里接一个假的模型服务，把插件从头到尾跑一遍
```

AlphainO 和 AlphainZ 共用的代码在 [`shared/`](shared/README.md)。

## 许可证

AlphainO 是自由软件，许可证是 [GNU Affero General Public License v3.0 或更新版本](LICENSE)，和它共用代码的 AlphainZ 一样。

- [AlphainZ](https://github.com/Alphainfix/AlphainZ)：模型层、对话界面和模型设置。
- [Beaver](https://github.com/jlegewie/beaver-zotero)，作者 Joscha Legewie：AlphainZ 是在它的基础上做的。
- Orbit Comments：评论的锚点和文件格式（MIT 许可，版权声明保留在 `src/comments/anchor.ts`）。
