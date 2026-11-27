import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = path.resolve(here, process.env.ALPHAINZ_PACKAGES ?? './shared/packages');
const sharedI18n = path.resolve(here, process.env.ALPHAINZ_I18N ?? './shared/src/i18n');

export default defineConfig({
    plugins: [
        // A Markdown file imports as its text, as esbuild's text loader bundles Obsidian's skills (src/skills).
        {
            name: 'markdown-as-text',
            enforce: 'pre',
            load(id) {
                const file = id.split('?')[0];
                return file.endsWith('.md') ? `export default ${JSON.stringify(readFileSync(file, 'utf8'))};` : null;
            },
        },
    ],
    resolve: {
        alias: [
            { find: /^@beaver\/agent-core\/(.*)$/, replacement: `${shared}/agent-core/src/$1` },
            { find: /^@beaver\/agent-llm\/(.*)$/, replacement: `${shared}/agent-llm/src/$1` },
            { find: /^@beaver\/agent-ui\/(.*)$/, replacement: `${shared}/agent-ui/src/$1` },
            { find: /^@alphainz\/i18n\/(.*)$/, replacement: `${sharedI18n}/$1` },
            // The obsidian package ships types only; tests run against a small stand-in.
            { find: /^obsidian$/, replacement: path.join(here, 'tests/obsidianStub.ts') },
        ],
    },
    test: {
        // `npm run benchmark` runs the search benchmark (tests/benchmark), which needs an embedding model.
        include: process.env.ALPHAINO_BENCHMARK ? ['tests/benchmark/**/*.bench.ts'] : ['tests/**/*.test.ts'],
        environment: 'node',
    },
});
