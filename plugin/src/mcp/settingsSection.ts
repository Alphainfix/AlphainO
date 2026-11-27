/**
 * The settings for the MCP server: on/off (off by default), the port, what
 * state the server is in, and what to paste into Claude Code or Claude
 * Desktop to connect. AlphainO never writes into Claude's own configuration.
 */
import { Notice, Setting } from 'obsidian';
import type AlphainOPlugin from '../main';
import { t } from '../i18n';
import { validPort } from '../settings';
import { DEFAULT_MCP_PORT, MCP_SERVER_NAME } from './server';

function copy(text: string): void {
    void navigator.clipboard.writeText(text).then(() => new Notice(t('Copied')));
}

/** The command that registers the server in Claude Code. */
export function claudeCodeCommand(plugin: AlphainOPlugin): string {
    return `claude mcp add --transport http ${MCP_SERVER_NAME} ${plugin.mcpUrl()}`;
}

/** The entry for Claude Desktop's configuration, through the stdio bridge. */
export function claudeDesktopConfig(plugin: AlphainOPlugin): string | null {
    const bridge = plugin.mcpBridgePath().absolute;
    if (!bridge) return null;
    const args = plugin.mcpPort() === DEFAULT_MCP_PORT ? [bridge] : [bridge, String(plugin.mcpPort())];
    return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: 'node', args } } }, null, 2);
}

/** Renders the section; returns a cleanup for the status listener. */
export function renderMcpSettings(containerEl: HTMLElement, plugin: AlphainOPlugin, redisplay: () => void): () => void {
    new Setting(containerEl).setName(t('Claude (MCP)')).setHeading();
    containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: t('Lets Claude Code and Claude Desktop search and read this vault, read and write comments, and create notes, through AlphainO. Only programs on this computer can connect; web pages cannot.'),
    });
    new Setting(containerEl).setName(t('Enable MCP Server')).addToggle((toggle) =>
        toggle.setValue(plugin.mcpEnabled()).onChange((value) => {
            plugin.prefs.set('mcpServerEnabled', value);
            redisplay();
        }),
    );
    if (!plugin.mcpEnabled()) return () => {};

    new Setting(containerEl)
        .setName(t('Port'))
        .setDesc(t('Keep the default unless another program uses it. Claude must be told the new address after a change.'))
        .addText((text) =>
            text
                .setPlaceholder(String(DEFAULT_MCP_PORT))
                .setValue(plugin.mcpPort() === DEFAULT_MCP_PORT ? '' : String(plugin.mcpPort()))
                .onChange((value) => {
                    const port = validPort(value);
                    if (port === null || port === DEFAULT_MCP_PORT) plugin.prefs.clear('mcpServerPort');
                    else plugin.prefs.set('mcpServerPort', port);
                }),
        );

    const status = new Setting(containerEl).setName(t('Status'));
    const showStatus = () => {
        const state = plugin.mcp?.state ?? { state: 'stopped' as const };
        status.setDesc(
            state.state === 'running'
                ? t('Listening at {url}', { url: plugin.mcpUrl() })
                : state.state === 'error'
                    ? t('Could not start: {reason}', { reason: state.message })
                    : t('Starting…'),
        );
    };
    showStatus();
    const unsubscribe = plugin.onMcpChange(showStatus);

    const command = claudeCodeCommand(plugin);
    new Setting(containerEl)
        .setName(t('Claude Code'))
        .setDesc(command)
        .addButton((button) => button.setButtonText(t('Copy command')).onClick(() => copy(command)));

    const desktop = claudeDesktopConfig(plugin);
    if (desktop) {
        new Setting(containerEl)
            .setName(t('Claude Desktop'))
            .setDesc(t('Add this to Claude Desktop’s configuration (Settings → Developer → Edit Config). It runs a small bridge AlphainO keeps in its plugin folder.'))
            .addButton((button) => button.setButtonText(t('Copy config')).onClick(() => copy(desktop)));
    }
    return unsubscribe;
}
