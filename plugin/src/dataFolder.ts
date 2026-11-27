/**
 * Where AlphainO keeps its files in the vault.
 *
 * A dot-folder: Obsidian leaves it out of the file list, search and graph, and
 * it syncs with the vault like any other folder. By default it sits inside the
 * vault's `Agent` folder, where the AI's work lives, when there is one; at the
 * vault's root otherwise.
 */
import { normalizePath, type Vault } from 'obsidian';

export const AGENT_FOLDER = 'Agent';
export const DATA_FOLDER_NAME = '.alphaino';

export function defaultDataFolder(vault: Vault): string {
    return vault.getFolderByPath(AGENT_FOLDER) ? `${AGENT_FOLDER}/${DATA_FOLDER_NAME}` : DATA_FOLDER_NAME;
}

/**
 * The data folder after a folder rename: when the renamed folder contains it,
 * it moved with it (renaming a folder moves everything inside, hidden folders
 * included). Null when the rename does not touch it.
 */
export function followRename(dataFolder: string, oldPath: string, newPath: string): string | null {
    const folder = normalizePath(dataFolder);
    if (folder === oldPath || folder.startsWith(`${oldPath}/`)) {
        return normalizePath(newPath + folder.slice(oldPath.length));
    }
    return null;
}
