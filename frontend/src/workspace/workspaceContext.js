/** Pure repository-scoped file focus model. No path or relationship is invented. */
import { asArray, safePath, sensitivePath } from './workspaceData.js';

export function sourcePathSet(result = {}) {
    const paths = new Set();
    for (const file of asArray(result?.files)) {
        if (safePath(file?.path) && !sensitivePath(file.path)) paths.add(file.path);
    }
    // Explicitly attached source map may hold files omitted from the summarized file records.
    if (result?.fileContents && typeof result.fileContents === 'object') {
        for (const path of Object.keys(result.fileContents)) {
            if (safePath(path) && !sensitivePath(path)) paths.add(path);
        }
    }
    return paths;
}

/** Invalid/out-of-snapshot paths never become navigable focused context. */
export function normalizeWorkspaceContext(input, availablePaths) {
    const file = input?.file;
    if (!safePath(file) || sensitivePath(file) || !availablePaths.has(file)) return null;
    const n = input?.line == null ? null : Number(input.line);
    const line = Number.isSafeInteger(n) && n > 0 ? n : null;
    return { file, line };
}

export function matchingRepositoryFiles(paths, query, limit = 240) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { matches: [], total: 0, truncated: false };
    const maximum = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 240)));
    const found = [];
    let total = 0;
    for (const item of paths) {
        const path = typeof item === 'string' ? item : item?.path;
        if (!safePath(path) || !path.toLowerCase().includes(q)) continue;
        total++;
        if (found.length < maximum) found.push(item);
    }
    return { matches: found, total, truncated: total > found.length };
}

// In-memory only: keeps focus while switching to unchanged legacy explorers.
// Not saved to disk, backend, localStorage, or exports.
const focusByRepository = new Map();
export function rememberWorkspaceFocus(repositoryId, context, paths) {
    if (typeof repositoryId !== 'string' || !repositoryId) return null;
    const valid = normalizeWorkspaceContext(context,paths);
    if(valid) {
        if(focusByRepository.size>16) focusByRepository.delete(focusByRepository.keys().next().value);
        focusByRepository.set(repositoryId,valid);
    }
    return valid;
}
export function recallWorkspaceFocus(repositoryId, paths) {
    if (typeof repositoryId !== 'string' || !repositoryId) return null;
    const valid=normalizeWorkspaceContext(focusByRepository.get(repositoryId),paths);
    if(!valid)focusByRepository.delete(repositoryId);
    return valid;
}
export function forgetWorkspaceFocus(repositoryId) {
    focusByRepository.delete(repositoryId);
}
