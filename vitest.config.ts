import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = path.resolve(here, process.env.ALPHAINZ_PACKAGES ?? './shared/packages');
const sharedI18n = path.resolve(here, process.env.ALPHAINZ_I18N ?? './shared/src/i18n');

export default defineConfig({
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
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
});
