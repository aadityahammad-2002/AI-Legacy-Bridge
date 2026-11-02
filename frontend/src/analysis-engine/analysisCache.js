/**
 * Small in-memory LRU cache for deterministic per-file analysis passes.
 *
 * Only extracted symbols and complexity metrics are cached. Repository-wide
 * graph/finding stages are always recomputed, so adding/removing files cannot
 * leave a stale dependency graph. SHA-256 content fingerprints and a cache
 * version make changed source or parser configuration miss the cache.
 */
const CACHE_VERSION = 'analysis-file-cache-v2-language63';
const MAX_ENTRIES = 500;
const MAX_APPROX_BYTES = 20 * 1024 * 1024;
const records = new Map();
let approximateBytes = 0;

function clone(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
}

function estimateSize(value) {
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
    catch { return 0; }
}

function touch(key, record) {
    records.delete(key);
    records.set(key, record);
}

function evictIfNeeded() {
    while (records.size > MAX_ENTRIES || approximateBytes > MAX_APPROX_BYTES) {
        const oldestKey = records.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = records.get(oldestKey);
        approximateBytes -= oldest?.size || 0;
        records.delete(oldestKey);
    }
}

export async function createFileAnalysisCacheKey(path, content, capabilities = {}) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof TextEncoder === 'undefined') return null;
    const bytes = new TextEncoder().encode(String(content ?? ''));
    try {
        const digest = await subtle.digest('SHA-256', bytes);
        const fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const normalizedPath = String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
        const capabilityKey = `acorn:${!!capabilities.acorn}|babel:${!!capabilities.Babel}|treeSitter:${capabilities.treeSitter || 'disabled'}`;
        return `${CACHE_VERSION}|${capabilityKey}|${normalizedPath}|${fingerprint}`;
    } catch {
        // Caching is an optimization only; unsupported crypto must not break analysis.
        return null;
    }
}

export function getCachedExtraction(key) {
    if (!key || !records.has(key)) return null;
    const record = records.get(key);
    if (!Object.prototype.hasOwnProperty.call(record, 'extraction')) return null;
    touch(key, record);
    return clone(record.extraction);
}

export function setCachedExtraction(key, extraction) {
    if (!key || !extraction) return;
    const old = records.get(key);
    const next = { ...(old || {}), extraction: clone(extraction) };
    next.size = estimateSize({ extraction: next.extraction, complexity: next.complexity });
    approximateBytes += next.size - (old?.size || 0);
    touch(key, next);
    evictIfNeeded();
}

export function getCachedComplexity(key) {
    if (!key || !records.has(key)) return null;
    const record = records.get(key);
    if (!Object.prototype.hasOwnProperty.call(record, 'complexity')) return null;
    touch(key, record);
    return clone(record.complexity);
}

export function setCachedComplexity(key, complexity) {
    if (!key || !complexity) return;
    const old = records.get(key);
    const next = { ...(old || {}), complexity: clone(complexity) };
    next.size = estimateSize({ extraction: next.extraction, complexity: next.complexity });
    approximateBytes += next.size - (old?.size || 0);
    touch(key, next);
    evictIfNeeded();
}

export function clearAnalysisCache() {
    records.clear();
    approximateBytes = 0;
}

export function getAnalysisCacheStats() {
    return { entries: records.size, approximateBytes, maxEntries: MAX_ENTRIES, maxApproximateBytes: MAX_APPROX_BYTES, version: CACHE_VERSION };
}
