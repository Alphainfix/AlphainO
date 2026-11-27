import { describe, expect, it } from 'vitest';
import type { Vault } from 'obsidian';
import { defaultDataFolder, followRename } from '../src/dataFolder';

const vaultWith = (folders: string[]) => ({ getFolderByPath: (path: string) => (folders.includes(path) ? {} : null) }) as unknown as Vault;

describe('data folder', () => {
    it('goes inside Agent when the vault has one, at the root otherwise', () => {
        expect(defaultDataFolder(vaultWith(['Agent']))).toBe('Agent/.alphaino');
        expect(defaultDataFolder(vaultWith([]))).toBe('.alphaino');
    });

    it('moves with a renamed folder that contains it', () => {
        expect(followRename('Agent/.alphaino', 'Agent', 'AI')).toBe('AI/.alphaino');
        expect(followRename('Notes/Agent/.alphaino', 'Notes', 'Archive/Notes')).toBe('Archive/Notes/Agent/.alphaino');
    });

    it('stays put when the rename is elsewhere, even a folder whose name it starts with', () => {
        expect(followRename('Agent/.alphaino', 'Agen', 'Other')).toBeNull();
        expect(followRename('Agent/.alphaino', 'Papers', 'Reading')).toBeNull();
    });
});
