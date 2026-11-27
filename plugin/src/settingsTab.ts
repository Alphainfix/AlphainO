/**
 * AlphainO's settings tab.
 *
 * The model settings are AlphainZ's own, from @beaver/agent-ui/settings and
 * drawn the same way: one card per provider (its key and Test, its model
 * catalogue with Fetch available models, per-model thinking, context and
 * output, the address), endpoints added by hand, Ollama with its guide, the
 * model, note search, the limits per question, custom instructions and the
 * conversation view. Colours come from the Obsidian theme through the shared
 * sheets' token contract (styles/obsidian-theme.css). AlphainO's own sections
 * follow in Obsidian's settings rows: the Zotero library, Claude (MCP) and
 * storage.
 */
import React from 'react';
import { withoutTitleTooltips } from './view/noTitles';
import { createRoot, type Root } from 'react-dom/client';
import { PluginSettingTab, Setting, normalizePath, type App } from 'obsidian';
import type AlphainOPlugin from './main';
import { defaultDataFolder } from './dataFolder';
import { renderMcpSettings } from './mcp/settingsSection';
import { validPort } from './settings';
import { SettingsPage } from './settings/SettingsPage';
import { AlphainZError, DEFAULT_ZOTERO_PORT } from './zotero/client';
import { t } from './i18n';

export class AlphainOSettingTab extends PluginSettingTab {
    private root: Root | null = null;
    private sectionsEl: HTMLElement | null = null;
    private sectionsCleanup: (() => void) | null = null;
    private stopTitles: (() => void) | null = null;

    constructor(app: App, private readonly plugin: AlphainOPlugin) {
        super(app, plugin);
        // Keys typed into the settings go to Obsidian's secret storage, never
        // into data.json (see PrefStore).
        plugin.prefs.attachSecrets(app.secretStorage);
    }

    display(): void {
        this.teardown();
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('alphaino-settings');
        this.stopTitles = withoutTitleTooltips(containerEl);
        // The shared AlphainZ sheets style what is inside `.alphainz-root`.
        const modelEl = containerEl.createDiv({ cls: 'alphainz-root alphaino-settings-model' });
        this.root = createRoot(modelEl);
        this.root.render(React.createElement(SettingsPage, { plugin: this.plugin }));
        this.sectionsEl = containerEl.createDiv({ cls: 'alphaino-settings-native' });
        this.renderSections();
    }

    hide(): void {
        // Unmounting keeps what a provider card was given, as closing
        // AlphainZ's settings window does: a key just pasted is saved.
        this.teardown();
        super.hide();
    }

    private teardown(): void {
        this.stopTitles?.();
        this.stopTitles = null;
        this.sectionsCleanup?.();
        this.sectionsCleanup = null;
        this.root?.unmount();
        this.root = null;
        this.sectionsEl = null;
    }

    /** AlphainO's own sections; drawn again on their own when one of them changes shape. */
    private renderSections(): void {
        const el = this.sectionsEl;
        if (!el) return;
        this.sectionsCleanup?.();
        this.sectionsCleanup = null;
        el.empty();
        this.zotero(el);
        this.sectionsCleanup = renderMcpSettings(el, this.plugin, () => this.renderSections());
        this.storage(el);
    }

    private zotero(containerEl: HTMLElement): void {
        const { settings } = this.plugin;
        new Setting(containerEl).setName(t('Zotero library (AlphainZ)')).setHeading();
        containerEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('While Zotero is running, the chat can search your library, read papers and look at their pages through AlphainZ. Turn on “Enable MCP Server” in AlphainZ’s settings (Advanced). Nothing is sent to Zotero while it is closed.'),
        });
        new Setting(containerEl)
            .setName(t('Use the Zotero library'))
            .addToggle((toggle) =>
                toggle.setValue(settings.zoteroEnabled).onChange((value) => {
                    settings.zoteroEnabled = value;
                    this.plugin.requestSave();
                    this.renderSections();
                }),
            );
        if (!settings.zoteroEnabled) return;
        new Setting(containerEl)
            .setName(t('Zotero port'))
            .setDesc(t('Zotero’s local server port. Change it only if you changed it in Zotero.'))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_ZOTERO_PORT))
                    .setValue(settings.zoteroPort === DEFAULT_ZOTERO_PORT ? '' : String(settings.zoteroPort))
                    .onChange((value) => {
                        settings.zoteroPort = validPort(value) ?? DEFAULT_ZOTERO_PORT;
                        this.plugin.requestSave();
                    }),
            );
        const check = new Setting(containerEl).setName(t('Connection')).setDesc(t('Not checked yet.'));
        check.addButton((button) =>
            button.setButtonText(t('Check')).onClick(async () => {
                const client = this.plugin.zoteroClient;
                if (!client) return;
                button.setDisabled(true);
                check.setDesc(t('Checking…'));
                try {
                    const tools = await client.listTools();
                    check.setDesc(t('Connected: AlphainZ offers {count} tools.', { count: tools.length }));
                } catch (error) {
                    const kind = error instanceof AlphainZError ? error.kind : 'failed';
                    check.setDesc(
                        kind === 'unavailable'
                            ? t('Not reachable: Zotero is not running, or “Enable MCP Server” is off in AlphainZ’s settings.')
                            : kind === 'timeout'
                                ? t('Zotero did not answer in time.')
                                : t('The check failed: {reason}', { reason: String((error as Error)?.message ?? error) }),
                    );
                } finally {
                    button.setDisabled(false);
                }
            }),
        );
    }

    private storage(containerEl: HTMLElement): void {
        new Setting(containerEl).setName(t('Storage')).setHeading();
        new Setting(containerEl)
            .setName(t('Folder'))
            .setDesc(t('Where conversations and comments are kept, relative to the vault. A folder whose name starts with a dot stays out of Obsidian’s file list and search.'))
            .addText((text) =>
                text
                    .setPlaceholder(defaultDataFolder(this.app.vault))
                    .setValue(this.plugin.settings.dataFolder)
                    .onChange((value) => {
                        const trimmed = value.trim();
                        this.plugin.settings.dataFolder = trimmed ? normalizePath(trimmed) : '';
                        this.plugin.requestSave();
                    }),
            );
    }
}
