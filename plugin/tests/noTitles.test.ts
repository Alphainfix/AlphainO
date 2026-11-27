import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { withoutTitleTooltips } from '../src/view/noTitles';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

describe('no native tooltips in AlphainO views', () => {
    it('moves title attributes to aria-label, now and as elements appear or change', async () => {
        const dom = new JSDOM('<!doctype html><body><div id="root"><button title="Retry">x</button><span title="Shown" aria-label="Kept">y</span></div></body>');
        const root = dom.window.document.getElementById('root');
        const stop = withoutTitleTooltips(root);
        const button = root.querySelector('button');
        expect(button.hasAttribute('title')).toBe(false);
        expect(button.getAttribute('aria-label')).toBe('Retry');
        expect(root.querySelector('span').getAttribute('aria-label')).toBe('Kept');

        const added = dom.window.document.createElement('div');
        added.innerHTML = '<a title="Open">link</a>';
        root.appendChild(added);
        button.setAttribute('title', 'Again');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(root.querySelector('a').hasAttribute('title')).toBe(false);
        expect(root.querySelector('a').getAttribute('aria-label')).toBe('Open');
        expect(button.hasAttribute('title')).toBe(false);

        stop();
        button.setAttribute('title', 'After');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(button.getAttribute('title')).toBe('After');
    });
});
