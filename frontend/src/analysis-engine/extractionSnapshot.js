/** Portable, bounded parser checkpoint. Keys include SHA-256 source fingerprint,
 * path, capability configuration and parser cache version. Graphs must be
 * recomputed after any repository change, even when parsing is reused. */
import { ENGINE_VERSION } from './engineVersion.js';
const MAX_ENTRIES = 500;
const MAX_BYTES = 8 * 1024 * 1024;
const clone = (value) => JSON.parse(JSON.stringify(value));
export function indexPreviousExtraction(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.engineVersion !== ENGINE_VERSION || !Array.isArray(snapshot.entries)) return new Map();
    return new Map(snapshot.entries.filter((entry) => entry?.key && entry?.path && Array.isArray(entry.functions))
        .map((entry) => [entry.path, entry]));
}
export function lookupPreviousExtraction(index, path, key) {
    const entry = key ? index.get(path) : null;
    if (!entry || entry.key !== key) return null;
    return clone({ functions: entry.functions, diagnostics: entry.diagnostics || {}, complexity: entry.complexity || null });
}
export function createExtractionSnapshot(files, cacheKeys, extractionByFile) {
    let bytes = 0;
    const entries = [];
    let excluded = 0;
    for (const file of files) {
        const key = cacheKeys.get(file.path);
        const extraction = extractionByFile.get(file.path);
        if (!key || !extraction) continue;
        const entry = { path: file.path, key, functions: extraction.functions, diagnostics: extraction.diagnostics || {}, complexity: file.complexity || null };
        const encoded = JSON.stringify(entry);
        const entryBytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(encoded).length : encoded.length * 2;
        if (entries.length >= MAX_ENTRIES || bytes + entryBytes > MAX_BYTES) { excluded++; continue; }
        bytes += entryBytes;
        entries.push(entry);
    }
    return { schemaVersion: 1, engineVersion: ENGINE_VERSION, entries,
        summary: { savedFiles: entries.length, excludedFiles: excluded, serializedBytes: bytes, maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES },
        semantics: 'Content-keyed parsing/complexity checkpoint only. Previous results can be reused after a reload when keys match exactly. Repository-wide dependency, call, API and security analysis still runs anew.' };
}
