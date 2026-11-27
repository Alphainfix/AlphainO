import React, { useEffect, useRef } from 'react';
import { Component, Keymap, MarkdownRenderer, type App } from 'obsidian';
import { VIEW_TYPE_CHAT } from './viewType';

/**
 * Markdown rendered by Obsidian itself, so an answer looks like a note: the
 * theme's typography, callouts, LaTeX, Mermaid, internal links.
 *
 * Each render goes into a fresh element: rendering is asynchronous, and a
 * render still finishing after the text changed then writes into an element
 * that is no longer shown instead of doubling the answer.
 *
 * Links behave as they do in a note: a click on a note link opens it (in a new
 * tab with the platform modifier), a hover shows Obsidian's page preview.
 */
export function Markdown({ app, text, sourcePath }: { app: App; text: string; sourcePath: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const host = ref.current;
        if (!host) return;
        const owner = new Component();
        owner.load();
        const target = document.createElement('div');
        host.replaceChildren(target);
        void MarkdownRenderer.render(app, text, target, sourcePath, owner);
        return () => owner.unload();
    }, [app, text, sourcePath]);

    const linkOf = (element: EventTarget | null): HTMLAnchorElement | null => {
        const link = (element as HTMLElement | null)?.closest?.('a.internal-link');
        return link instanceof HTMLAnchorElement ? link : null;
    };

    return (
        <div
            ref={ref}
            className="alphaino-markdown markdown-rendered"
            onClick={(event) => {
                const link = linkOf(event.target);
                if (!link) return;
                event.preventDefault();
                const linktext = link.getAttribute('data-href') ?? link.getAttribute('href') ?? '';
                void app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(event.nativeEvent));
            }}
            onMouseOver={(event) => {
                const link = linkOf(event.target);
                if (!link) return;
                app.workspace.trigger('hover-link', {
                    event: event.nativeEvent,
                    source: VIEW_TYPE_CHAT,
                    hoverParent: { hoverPopover: null },
                    targetEl: link,
                    linktext: link.getAttribute('data-href') ?? link.getAttribute('href') ?? '',
                    sourcePath,
                });
            }}
        />
    );
}
