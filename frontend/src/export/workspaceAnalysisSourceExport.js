/**
 * Workspace-only export boundary. The Analysis Engine is deliberately untouched.
 * Includes verbatim text contents from the repository snapshot alongside the
 * existing 82-key analysis payload. Never calls the backend or GitHub again.
 *
 * No implicit secret redaction is applied: this export is explicitly intended
 * to contain the raw repository source the user loaded. Treat the downloaded
 * JSON as sensitive, especially for private repositories.
 */
import { toDownloadableAnalysisJson } from '../analysis-engine/reportFormats.js';

function canonicalPath(path) {
    if (typeof path !== 'string' || !path || path.includes('\0')) {
        throw new Error('A repository source file has an invalid path.');
    }
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
    const segments = normalized.split('/');
    if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) ||
        segments.some((part) => !part || part === '..' || part === '.')) {
        throw new Error(`Unsafe repository source path: ${path}`);
    }
    return normalized;
}

/** Collect exactly the source that the importer retained, without trimming or
 * normalizing content. fileContents is authoritative for local session data;
 * files[].content supports browser sessions reopened from backend snapshots.
 */
export function collectRepositorySourceFiles(analysisResult = {}) {
    const byPath = new Map();
    for (const file of Array.isArray(analysisResult.files) ? analysisResult.files : []) {
        if (typeof file?.content !== 'string' || typeof file.path !== 'string') continue;
        const path = canonicalPath(file.path);
        byPath.set(path, file.content);
    }
    const store = analysisResult.fileContents;
    if (store && typeof store === 'object' && !Array.isArray(store)) {
        for (const [name, content] of Object.entries(store)) {
            if (typeof content !== 'string') continue;
            byPath.set(canonicalPath(name), content);
        }
    }
    const files = [...byPath].map(([path, content]) => ({ path, content }));
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return files;
}

export function toWorkspaceAnalysisSourceJson(analysisResult = {}, repository = null, exportedAt = new Date().toISOString()) {
    const sourceFiles = collectRepositorySourceFiles(analysisResult);
    if (!sourceFiles.length) {
        throw new Error('Raw repository source is unavailable in this session. Reanalyze the repository before downloading the source-inclusive JSON.');
    }
    // A partially reconstructed snapshot must not be represented as a complete
    // source export. It is better to ask for reanalysis than silently lose code.
    const sourcePaths = new Set(sourceFiles.map(file => file.path));
    const missing = (Array.isArray(analysisResult.files) ? analysisResult.files : [])
        .filter(file => typeof file?.path === 'string' && !sourcePaths.has(canonicalPath(file.path)))
        .map(file => file.path);
    if (missing.length) {
        throw new Error(`Raw source is missing for ${missing.length} analyzed file(s). Reanalyze the repository to restore the complete source snapshot.`);
    }

    // Preserve the engine's original analysis serialization and 82-key contract.
    const payload = JSON.parse(toDownloadableAnalysisJson(analysisResult, repository, exportedAt));
    payload.exportSchemaVersion = 2;
    payload.sourceCodeIncluded = true;
    payload.sourceScope = 'loaded-repository-text-files';
    payload.sourceFileCount = sourceFiles.length;
    payload.sourceFiles = sourceFiles;
    payload.note = 'Includes the full computed analysis and verbatim text for every source file retained by the repository loader. Files excluded by import rules, binary files and unavailable remote files are not included. The JSON may contain secrets; share carefully.';
    return JSON.stringify(payload, null, 2);
}
