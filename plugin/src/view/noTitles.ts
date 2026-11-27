/**
 * No hover tooltips in AlphainO (the owner's choice, 2026-11-26).
 *
 * Obsidian draws an element's aria-label as a black tooltip unless the CSS property --no-tooltip is "true"
 * on it; styles/alphaino.css sets that on AlphainO's views, and custom properties inherit. What is left are
 * the browser's own tooltips, from `title` attributes, which some shared AlphainZ components set. This moves
 * them out of a view as they appear: the text goes to aria-label when there is none, so screen readers keep it.
 */
export function withoutTitleTooltips(root: HTMLElement): () => void {
    const strip = (element: Element) => {
        const title = element.getAttribute('title');
        if (title === null) return;
        if (!element.hasAttribute('aria-label') && title.trim()) element.setAttribute('aria-label', title);
        element.removeAttribute('title');
    };
    const sweep = (node: Node) => {
        // nodeType, not instanceof: a view can live in a pop-out window with its own Element.
        if (node.nodeType !== 1) return;
        const element = node as Element;
        strip(element);
        element.querySelectorAll('[title]').forEach(strip);
    };
    sweep(root);
    // The view's own window: a pop-out window has its own MutationObserver.
    const Observer = root.ownerDocument?.defaultView?.MutationObserver ?? MutationObserver;
    const observer = new Observer((records) => {
        for (const record of records) {
            if (record.type === 'attributes') strip(record.target as Element);
            else record.addedNodes.forEach(sweep);
        }
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
    return () => observer.disconnect();
}
