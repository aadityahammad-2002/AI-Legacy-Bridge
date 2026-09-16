/**
 * repo-sources/zip.js
 *
 * Reads a user-uploaded .zip file entirely in the browser via JSZip and
 * produces the same { path, content } file shape the other repo sources do.
 */

import JSZip from 'jszip';
import { Parser } from '../analysis-engine/parser.js';

const DEFAULT_EXCLUDED_DIRS = [
    'node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'target',
    '.next', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv',
];
const MAX_FILE_SIZE_BYTES = 500 * 1024;

function shouldSkipPath(path) {
    return path.split('/').some((seg) => DEFAULT_EXCLUDED_DIRS.includes(seg));
}

/**
 * @param {File} zipFile - a File object from an <input type="file"> or drag-and-drop
 * @param {(p: { phase: string, current?: number, total?: number }) => void} [onProgress]
 * @returns {Promise<{ repoMeta: object, files: Array<{path: string, content: string}> }>}
 */
export async function readZipRepository(zipFile, onProgress) {
    onProgress?.({ phase: 'unzipping' });
    const zip = await JSZip.loadAsync(zipFile);

    // ZIPs of GitHub repos are typically wrapped in a single top-level folder
    // (e.g. "my-repo-main/"). Strip it so paths match what GitHub/local-folder give us.
    const allPaths = Object.keys(zip.files);
    const topLevelFolders = new Set(
        allPaths
            .map((p) => p.split('/')[0])
            .filter((p, i, arr) => arr.indexOf(p) === i)
    );
    const commonPrefix =
        topLevelFolders.size === 1 && allPaths.every((p) => p.startsWith([...topLevelFolders][0]))
            ? `${[...topLevelFolders][0]}/`
            : '';

    const candidates = Object.values(zip.files).filter((entry) => {
        if (entry.dir) return false;
        const relPath = commonPrefix ? entry.name.slice(commonPrefix.length) : entry.name;
        if (!relPath) return false;
        if (shouldSkipPath(relPath)) return false;
        const name = relPath.split('/').pop();
        if (!Parser.isIncluded(name)) return false;
        return true;
    });

    onProgress?.({ phase: 'reading', current: 0, total: candidates.length });
    const files = [];
    for (let i = 0; i < candidates.length; i++) {
        const entry = candidates[i];
        const relPath = commonPrefix ? entry.name.slice(commonPrefix.length) : entry.name;
        try {
            // Peek at size cheaply via the compressed entry metadata isn't reliable across
            // zip tools, so just read as text and bail if it's clearly too large.
            const content = await entry.async('string');
            if (content.length <= MAX_FILE_SIZE_BYTES) {
                files.push({ path: relPath, content });
            }
        } catch (err) {
            console.warn(`[zip] failed to read ${relPath}:`, err.message);
        }
        onProgress?.({ phase: 'reading', current: i + 1, total: candidates.length });
    }

    const repoName = zipFile.name.replace(/\.zip$/i, '');
    return {
        repoMeta: { name: repoName, source: 'zip' },
        files,
    };
}
