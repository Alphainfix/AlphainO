# Obsidian's skills

AlphainO carries three of the skills behind Obsidian's official [connectors](https://obsidian.md/help/connectors),
copied unchanged from [obsidianmd/obsidian-skills](https://github.com/obsidianmd/obsidian-skills)
(`plugins/obsidian/skills/`, version 1.2.3, commit `9c9560a`). They are Obsidian's own instructions for its
file formats, and they keep their MIT licence ([`LICENSE`](LICENSE)), not AlphainO's AGPL.

| Skill | What AlphainO uses it for |
| --- | --- |
| `obsidian-markdown` | Writing into notes: wikilinks, embeds, callouts, properties |
| `obsidian-bases` | `base` code blocks in notes, and reading `.base` files |
| `json-canvas` | Reading `.canvas` files |

The build bundles them into `main.js` (`src/skills/`). They are loaded as the
[Agent Skills guide](https://agentskills.io/client-implementation/adding-skills-support) describes: the system prompt
lists each skill's name and description, and `read_skill` gives the model a skill's instructions when a task calls
for it, and the files they link (`references/…`) one at a time.

The connector's other four skills are left out, because each needs a shell, which AlphainO does not have:
`obsidian-cli` drives the desktop app from outside (AlphainO works inside it, with its own vault tools),
`obsidian-headless` runs Sync and Publish without the app, and `defuddle` and `knap` are command-line tools.

To update them, copy the three folders and `LICENSE` again from a newer version, change the version above, and run
`npm test`: it checks that every file here is bundled and that the links between them resolve.
