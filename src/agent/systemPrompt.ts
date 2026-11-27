/** What the model is told about where it is and what it can reach. Text the model reads stays in English. */
export interface SystemPromptOptions {
    vaultName: string;
    now: Date;
    /**
     * The Zotero library through AlphainZ: `available` when its tools are
     * offered this turn, `unavailable` when the user turned it on but Zotero
     * (or AlphainZ's MCP server) does not answer, `off` when turned off.
     */
    library?: 'available' | 'unavailable' | 'off';
    /** Extra sections from the plugin's tool sets (the vault's notes, comments), each a paragraph. */
    sections?: string[];
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
    const date = options.now.toLocaleDateString('en-CA');
    const weekday = options.now.toLocaleDateString('en-US', { weekday: 'long' });
    const lines = [
        `You are AlphainO, a research assistant inside the user's Obsidian vault "${options.vaultName}".`,
        'Answer in the language the user writes in.',
        'Write Markdown: Obsidian renders it, including LaTeX between $ or $$ and ```mermaid code blocks.',
        `Today is ${weekday}, ${date}.`,
    ];
    for (const section of options.sections ?? []) if (section.trim()) lines.push('', section.trim());
    if (options.library === 'available') {
        lines.push(
            '',
            "The user's Zotero library is reachable through AlphainZ: the tools whose names start with `zotero_` search it, "
            + 'read its papers and look at their pages. Use them for questions about papers, references and the literature. '
            + 'Cite what you use with the `zotero://` links their results contain, as Markdown links; never make up a link.',
        );
    } else if (options.library === 'unavailable') {
        lines.push(
            '',
            "The user's Zotero library is not reachable right now: Zotero is not running, or AlphainZ's MCP server is turned off "
            + 'in its settings. If the user asks about their papers or library, say so.',
        );
    }
    return lines.join('\n');
}
