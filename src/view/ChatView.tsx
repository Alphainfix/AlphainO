import React from 'react';
import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import type AlphainOPlugin from '../main';
import { PANDA_ICON } from '../icon';
import { ChatApp } from './ChatApp';

export { VIEW_TYPE_CHAT } from './viewType';
import { VIEW_TYPE_CHAT } from './viewType';

/** The chat as a sidebar view: its tab shows the panda next to Backlinks and Outline. */
export class ChatView extends ItemView {
    private root: Root | null = null;

    constructor(leaf: WorkspaceLeaf, private readonly plugin: AlphainOPlugin) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_CHAT;
    }

    getDisplayText(): string {
        return 'AlphainO';
    }

    getIcon(): string {
        return PANDA_ICON;
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('alphaino-view');
        // The shared AlphainZ sheets style what is inside `.alphainz-root`.
        this.contentEl.addClass('alphainz-root');
        this.watchStatusBar();
        this.root = createRoot(this.contentEl);
        this.root.render(<ChatApp plugin={this.plugin} />);
    }

    async onClose(): Promise<void> {
        this.root?.unmount();
        this.root = null;
    }

    /**
     * Obsidian's status bar is fixed to the window's bottom right corner, over
     * whatever view is there — in the right sidebar, the composer's last line.
     * Measure how far it reaches into this view and leave that much room at
     * the bottom; none when it does not overlap (hidden, or the view elsewhere).
     */
    private watchStatusBar(): void {
        const doc = this.contentEl.doc;
        const update = () => {
            const bar = doc.querySelector<HTMLElement>('.status-bar');
            let inset = 0;
            // Not `isShown()`: it tests `offsetParent`, which a fixed element never has.
            const b = bar?.getBoundingClientRect();
            if (b && b.width > 0 && b.height > 0) {
                const c = this.contentEl.getBoundingClientRect();
                const overlapsAcross = b.left < c.right && b.right > c.left;
                if (overlapsAcross && b.top < c.bottom && b.bottom > c.top) inset = Math.ceil(c.bottom - b.top);
            }
            this.contentEl.style.setProperty('--alphaino-bottom-inset', `${Math.max(0, inset)}px`);
        };
        const observer = new ResizeObserver(() => update());
        observer.observe(this.contentEl);
        const bar = doc.querySelector<HTMLElement>('.status-bar');
        if (bar) observer.observe(bar);
        this.register(() => observer.disconnect());
        this.registerEvent(this.app.workspace.on('layout-change', update));
        this.registerEvent(this.app.workspace.on('resize', update));
        update();
    }
}
