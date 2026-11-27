/**
 * Vault paths: which notes are searched, and how a note is named in a link.
 */

/** A folder path as the index compares it: forward slashes, no leading or trailing slash; '' is the vault root. */
export function normalizeFolderPath(folder: string): string {
    const parts = folder
        .replace(/\\/g, '/')
        .split('/')
        .map((part) => part.trim())
        .filter((part) => part !== '' && part !== '.');
    return parts.join('/');
}

/** Whether `path` is inside `folder` (or is it). Case does not matter: most vaults live on case-insensitive disks. */
export function isUnderFolder(path: string, folder: string): boolean {
    const wanted = normalizeFolderPath(folder).toLowerCase();
    if (wanted === '') return true;
    const lower = path.toLowerCase();
    return lower === wanted || lower.startsWith(`${wanted}/`);
}

/** Whether any folder or the file name in the path starts with a dot: Obsidian hides those from its file list and search. */
export function hasHiddenSegment(path: string): boolean {
    return path.split('/').some((segment) => segment.startsWith('.'));
}

/** Whether `path` is inside one of the folders the user left out of AlphainO (Settings → Excluded folders). */
export function isExcludedPath(path: string, excludedFolders: readonly string[]): boolean {
    return excludedFolders.some((folder) => normalizeFolderPath(folder) !== '' && isUnderFolder(path, folder));
}

/** Whether a Markdown note at `path` is searched: not hidden, and not inside an excluded folder. */
export function isIndexablePath(path: string, excludedFolders: readonly string[]): boolean {
    if (!/\.md$/i.test(path)) return false;
    if (hasHiddenSegment(path)) return false;
    return !excludedFolders.some((folder) => normalizeFolderPath(folder) !== '' && isUnderFolder(path, folder));
}

/** The note's title: its file name without the extension. */
export function titleOf(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1);
    return name.replace(/\.md$/i, '');
}

/** The path as a link target: no `.md`. */
export function linkTarget(path: string): string {
    return path.replace(/\.md$/i, '');
}

/**
 * A heading as Obsidian writes it into a link: the characters that would end
 * or confuse the link (`# | ^ : \`, line breaks, `%%`, `[[`, `]]`) become a
 * space and runs of spaces collapse.
 */
export function headingForLink(heading: string): string {
    return heading
        .replace(/[:#|^\\\r\n]|%%|\[\[|\]\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** A wikilink to a note, or to a heading in it: `[[Folder/Note]]`, `[[Folder/Note#Heading]]`. */
export function wikilink(path: string, heading = ''): string {
    const anchor = headingForLink(heading);
    return anchor ? `[[${linkTarget(path)}#${anchor}]]` : `[[${linkTarget(path)}]]`;
}
