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
const MAX_ARCHIVE_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_EXTRACTED_BYTES = 50 * 1024 * 1024;
const MAX_CANDIDATE_FILES = 5000;

function shouldSkipPath(path) {
    const normalized = String(path || '').replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) return true;
    const segments = normalized.split('/');
    if (segments.some((seg) => seg === '..' || seg === '.')) return true;
    return segments.some((seg) => DEFAULT_EXCLUDED_DIRS.includes(seg));
}

function hasUnsafeArchivePath(path) {
    const normalized = String(path || '').replace(/\\/g, '/');
    return normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) ||
        normalized.split('/').some((segment) => segment === '..');
}

/**
 * @param {File} zipFile - a File object from an <input type="file"> or drag-and-drop
 * @param {(p: { phase: string, current?: number, total?: number }) => void} [onProgress]
 * @returns {Promise<{ repoMeta: object, files: Array<{path: string, content: string}> }>}
 */
export async function readZipRepositoryMainThread(zipFile, onProgress) {
    if (!zipFile || typeof zipFile.size !== 'number') {
        throw new Error('Please select a valid ZIP file.');
    }
    if (zipFile.size > MAX_ARCHIVE_SIZE_BYTES) {
        throw new Error(`ZIP archive exceeds the ${Math.round(MAX_ARCHIVE_SIZE_BYTES / (1024 * 1024))} MB compressed-size limit.`);
    }

    onProgress?.({ phase: 'unzipping' });
    const zip = await JSZip.loadAsync(zipFile, { checkCRC32: false });

    // ZIPs of GitHub repos are typically wrapped in a single top-level folder
    // (e.g. "my-repo-main/"). Strip it so paths match what GitHub/local-folder give us.
    const allPaths = Object.keys(zip.files);
    const topLevelFolders = new Set(
        allPaths
            .map((p) => p.split('/')[0])
            .filter((p, i, arr) => arr.indexOf(p) === i)
    );
    const commonPrefix =
        topLevelFolders.size === 1 && allPaths.every((p) => p.startsWith(`${[...topLevelFolders][0]}/`))
            ? `${[...topLevelFolders][0]}/`
            : '';

    let unsafePathCount = 0;
    const candidates = Object.values(zip.files).filter((entry) => {
        if (entry.dir) return false;
        const originalPath = entry.unsafeOriginalName || entry.name;
        if (hasUnsafeArchivePath(originalPath)) { unsafePathCount++; return false; }
        const relPath = commonPrefix ? entry.name.slice(commonPrefix.length) : entry.name;
        if (!relPath) return false;
        if (shouldSkipPath(relPath)) return false;
        const name = relPath.split('/').pop();
        if (!Parser.isIncluded(name)) return false;
        return true;
    });

    if (candidates.length > MAX_CANDIDATE_FILES) {
        throw new Error(`ZIP contains too many source-file candidates (${candidates.length}); limit is ${MAX_CANDIDATE_FILES}.`);
    }

    // JSZip exposes declared uncompressed sizes from the ZIP directory before
    // entry.async() decompresses file contents. Reject oversized entries and
    // enforce a total budget before allocating their decoded strings.
    let declaredTotalBytes = 0;
    const boundedCandidates = [];
    let oversizedCount = 0;
    let unverifiedSizeCount = 0;
    for (const entry of candidates) {
        const declaredSize = entry?._data?.uncompressedSize;
        if (!Number.isFinite(declaredSize) || declaredSize < 0) {
            console.warn(`[zip] skipping ${entry.name}: archive does not provide a reliable uncompressed size`);
            unverifiedSizeCount++;
            continue;
        }
        if (declaredSize > MAX_FILE_SIZE_BYTES) {
            oversizedCount++;
            continue;
        }
        declaredTotalBytes += declaredSize;
        if (declaredTotalBytes > MAX_TOTAL_EXTRACTED_BYTES) {
            throw new Error(`ZIP extracted source exceeds the ${Math.round(MAX_TOTAL_EXTRACTED_BYTES / (1024 * 1024))} MB total-size limit.`);
        }
        boundedCandidates.push(entry);
    }

    onProgress?.({ phase: 'reading', current: 0, total: boundedCandidates.length });
    const files = [];
    let readFailureCount = 0;
    for (let i = 0; i < boundedCandidates.length; i++) {
        const entry = boundedCandidates[i];
        const relPath = commonPrefix ? entry.name.slice(commonPrefix.length) : entry.name;
        try {
            const content = await entry.async('string');
            // UTF-16 JS string length differs from byte length; this second check
            // is a defensive post-decompression guard, not the primary protection.
            if (new TextEncoder().encode(content).byteLength <= MAX_FILE_SIZE_BYTES) {
                files.push({ path: relPath, content });
            } else {
                oversizedCount++;
            }
        } catch (err) {
            readFailureCount++;
            console.warn(`[zip] failed to read ${relPath}:`, err.message);
        }
        onProgress?.({ phase: 'reading', current: i + 1, total: boundedCandidates.length });
    }

    const repoName = zipFile.name.replace(/\.zip$/i, '');
    const warnings = [];
    if (oversizedCount) warnings.push(`${oversizedCount} file(s) skipped because they exceed the ${Math.round(MAX_FILE_SIZE_BYTES / 1024)} KB per-file limit.`);
    if (unverifiedSizeCount) warnings.push(`${unverifiedSizeCount} file(s) skipped because their uncompressed size could not be verified.`);
    if (unsafePathCount) warnings.push(`${unsafePathCount} file(s) skipped because their archive paths were unsafe.`);
    if (readFailureCount) warnings.push(`${readFailureCount} file(s) could not be read from the archive.`);
    return {
        repoMeta: { name: repoName, source: 'zip' },
        files,
        warnings,
    };
}
