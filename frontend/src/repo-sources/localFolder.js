/**
 * repo-sources/localFolder.js
 *
 * Reads a locally-selected folder entirely in the browser. Supports two
 * input paths:
 *   1. `showDirectoryPicker()` (File System Access API — Chrome/Edge)
 *   2. A `FileList` from `<input type="file" webkitdirectory multiple>`
 *      (broader browser support, including Firefox/Safari)
 *
 * Both produce the same { path, content } file shape as the other repo sources.
 */

import { Parser } from '../analysis-engine/parser.js';
import { DEFAULT_EXCLUDED_DIRS, shouldSkipPath } from './ignoreList.js';

const MAX_FILE_SIZE_BYTES = 500 * 1024;

export function isFileSystemAccessSupported() {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Opens the native folder picker (Chrome/Edge only) and reads all files under it. */
export async function pickAndReadLocalFolder(onProgress) {
    const dirHandle = await window.showDirectoryPicker();
    onProgress?.({ phase: 'listing' });
    const collected = await readFromDirectoryHandle(dirHandle, onProgress);
    return readCollectedLocalFiles(collected, dirHandle.name, onProgress);
}

async function readFromDirectoryHandle(dirHandle, onProgress, prefix = '') {
    const collected = [];
    for await (const [name, handle] of dirHandle.entries()) {
        const relPath = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') {
            if (DEFAULT_EXCLUDED_DIRS.includes(name)) continue;
            collected.push(...(await readFromDirectoryHandle(handle, onProgress, relPath)));
        } else {
            if (shouldSkipPath(relPath)) continue;
            if (!Parser.isIncluded(name)) continue;
            const file = await handle.getFile();
            if (file.size > MAX_FILE_SIZE_BYTES) continue;
            collected.push({ path: relPath, fileObj: file });
        }
    }
    return collected;
}

/**
 * Reads files selected via a `webkitdirectory` <input>. `fileList[i].webkitRelativePath`
 * gives the path relative to the chosen folder (including the folder's own name as
 * the first segment, which we strip so paths are consistent with the other sources).
 *
 * @param {FileList} fileList
 * @param {(p: { phase: string, current?: number, total?: number }) => void} [onProgress]
 */
export async function readLocalFolderFromInput(fileList, onProgress) {
    const allFiles = Array.from(fileList);
    if (allFiles.length === 0) return { repoMeta: { name: 'local-folder', source: 'local' }, files: [] };

    const firstRelPath = allFiles[0].webkitRelativePath || allFiles[0].name;
    const rootFolderName = firstRelPath.split('/')[0];

    const candidates = allFiles.filter((f) => {
        const relPath = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name;
        if (shouldSkipPath(relPath)) return false;
        if (!Parser.isIncluded(f.name)) return false;
        if (f.size > MAX_FILE_SIZE_BYTES) return false;
        return true;
    });

    onProgress?.({ phase: 'reading', current: 0, total: candidates.length });
    const files = [];
    for (let i = 0; i < candidates.length; i++) {
        const f = candidates[i];
        const relPath = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name;
        try {
            const content = await f.text();
            files.push({ path: relPath, content });
        } catch (err) {
            console.warn(`[localFolder] failed to read ${relPath}:`, err.message);
        }
        onProgress?.({ phase: 'reading', current: i + 1, total: candidates.length });
    }

    return { repoMeta: { name: rootFolderName, source: 'local' }, files };
}

/** Reads files collected via the File System Access API path (which carries File handles, not text yet). */
export async function readCollectedLocalFiles(collected, rootName, onProgress) {
    onProgress?.({ phase: 'reading', current: 0, total: collected.length });
    const files = [];
    for (let i = 0; i < collected.length; i++) {
        const { path, fileObj } = collected[i];
        try {
            const content = await fileObj.text();
            files.push({ path, content });
        } catch (err) {
            console.warn(`[localFolder] failed to read ${path}:`, err.message);
        }
        onProgress?.({ phase: 'reading', current: i + 1, total: collected.length });
    }
    return { repoMeta: { name: rootName, source: 'local' }, files };
}
