/**
 * Repository snapshot preparation and bounded ingestion.
 *
 * This module does not walk a filesystem or extract archives. The caller supplies
 * [{ path, content }] records; this module canonicalizes and filters that snapshot
 * before any analyzers run. Excluded files are always accounted for in diagnostics.
 */
const DEFAULT_LIMITS = Object.freeze({
    maxFiles: 10_000,
    maxTotalBytes: 100 * 1024 * 1024,
    maxFileBytes: 5 * 1024 * 1024,
    maxPathDepth: 80,
});

const DEFAULT_EXCLUDED_DIRS = new Set([
    '.git', '.hg', '.svn', '.idea', '.vscode',
    'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'target',
    'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
    '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle',
]);
const GENERATED_FILE_RE = /(?:\.min\.(?:js|css)|\.generated\.[^.]+|\.g\.[^.]+|\.pb\.[^.]+|\.designer\.[^.]+|\.bundle\.[^.]+)$/i;

function toByteLength(content) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(content).byteLength;
    return Buffer.byteLength(content, 'utf8');
}

function normalizePath(rawPath, index) {
    const path = rawPath.replace(/\\/g, '/');
    if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').some((part) => part === '..')) {
        throw new Error(`Unsafe repository-relative path at index ${index}: ${rawPath}`);
    }
    const normalized = path.split('/').filter((part) => part && part !== '.').join('/');
    if (!normalized) throw new Error(`Empty repository-relative path at index ${index}: ${rawPath}`);
    return normalized;
}

function exclusionReason(path, options) {
    const segments = path.split('/');
    if (options.excludeDefaultDirectories !== false && segments.some((segment) => DEFAULT_EXCLUDED_DIRS.has(segment.toLowerCase()))) {
        return 'generated/vendor/build/cache directory excluded by ingestion policy';
    }
    if (options.excludeGenerated !== false && GENERATED_FILE_RE.test(path)) {
        return 'generated/minified/bundled file excluded by ingestion policy';
    }
    for (const rawPattern of options.excludePaths || []) {
        if (typeof rawPattern !== 'string' || !rawPattern.trim()) continue;
        const pattern = rawPattern.replace(/\\/g, '/').trim();
        if (pattern.endsWith('/')) {
            if (path.startsWith(pattern) || path.split('/').includes(pattern.slice(0, -1))) return `matched excluded path rule: ${pattern}`;
        } else if (path === pattern || path.startsWith(`${pattern}/`) || path.split('/').includes(pattern)) {
            return `matched excluded path rule: ${pattern}`;
        }
    }
    if (typeof options.includeExtensions === 'object' && options.includeExtensions.length) {
        const ext = path.includes('.') ? `.${path.split('.').pop().toLowerCase()}` : '';
        const allowed = new Set(options.includeExtensions.map((value) => String(value).startsWith('.') ? String(value).toLowerCase() : `.${String(value).toLowerCase()}`));
        if (!allowed.has(ext)) return 'extension not included by ingestion policy';
    }
    return null;
}

function isClearlyBinary(content) {
    if (!content) return false;
    const sample = content.slice(0, Math.min(content.length, 4096));
    if (sample.includes('\0')) return true;
    let control = 0;
    for (const char of sample) {
        const code = char.charCodeAt(0);
        if ((code < 8 || (code > 13 && code < 32)) && code !== 9) control++;
    }
    return sample.length > 0 && control / sample.length > 0.02;
}

/**
 * @param {Array<{path:string,content:string}>} rawFiles
 * @param {{maxFiles?:number,maxTotalBytes?:number,maxFileBytes?:number,maxPathDepth?:number,excludeDefaultDirectories?:boolean,excludeGenerated?:boolean,excludePaths?:string[],includeExtensions?:string[],skipBinary?:boolean}} options
 */
export function prepareRepositoryFiles(rawFiles, options = {}) {
    if (!Array.isArray(rawFiles)) throw new TypeError('Repository files must be provided as an array.');
    const limits = {
        maxFiles: Math.max(1, Number(options.maxFiles) || DEFAULT_LIMITS.maxFiles),
        maxTotalBytes: Math.max(1, Number(options.maxTotalBytes) || DEFAULT_LIMITS.maxTotalBytes),
        maxFileBytes: Math.max(1, Number(options.maxFileBytes) || DEFAULT_LIMITS.maxFileBytes),
        maxPathDepth: Math.max(1, Number(options.maxPathDepth) || DEFAULT_LIMITS.maxPathDepth),
    };
    const diagnostics = {
        schemaVersion: 1,
        inputFiles: rawFiles.length,
        includedFiles: 0,
        excludedFiles: 0,
        excludedByReason: {},
        skippedFiles: [],
        limits,
        totalInputBytes: 0,
        includedBytes: 0,
        status: 'complete',
        statusReasons: [],
        semantics: 'Files excluded by policy or safety bounds are not analyzed. Review skippedFiles before interpreting results as repository-wide.',
    };
    const files = [];
    const seen = new Set();
    const excluded = (path, reason, bytes = 0) => {
        diagnostics.excludedFiles++;
        diagnostics.excludedByReason[reason] = (diagnostics.excludedByReason[reason] || 0) + 1;
        diagnostics.skippedFiles.push({ path, reason, ...(bytes ? { bytes } : {}) });
        diagnostics.status = 'partial';
        if (!diagnostics.statusReasons.includes(reason)) diagnostics.statusReasons.push(reason);
    };

    rawFiles.forEach((file, index) => {
        if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
            throw new TypeError(`File at index ${index} must include a string path and string content.`);
        }
        const path = normalizePath(file.path, index);
        if (seen.has(path)) throw new Error(`Duplicate repository path after normalization: ${path}`);
        seen.add(path);
        if (path.split('/').length > limits.maxPathDepth) {
            excluded(path, `path depth exceeds configured limit (${limits.maxPathDepth})`);
            return;
        }
        const byteLength = toByteLength(file.content);
        diagnostics.totalInputBytes += byteLength;
        if (options.skipBinary !== false && isClearlyBinary(file.content)) {
            excluded(path, 'binary or control-heavy content skipped', byteLength);
            return;
        }
        const excludedWhy = exclusionReason(path, options);
        if (excludedWhy) {
            excluded(path, excludedWhy, byteLength);
            return;
        }
        if (byteLength > limits.maxFileBytes) {
            excluded(path, `file exceeds per-file byte limit (${limits.maxFileBytes})`, byteLength);
            return;
        }
        if (files.length >= limits.maxFiles) {
            excluded(path, `file count exceeds configured limit (${limits.maxFiles})`, byteLength);
            return;
        }
        if (diagnostics.includedBytes + byteLength > limits.maxTotalBytes) {
            excluded(path, `repository byte budget exceeded (${limits.maxTotalBytes})`, byteLength);
            return;
        }
        files.push({ ...file, path, name: path.split('/').pop() });
        diagnostics.includedBytes += byteLength;
    });
    diagnostics.includedFiles = files.length;
    if (diagnostics.excludedFiles > 0 && !diagnostics.statusReasons.includes(`${diagnostics.excludedFiles} file(s) were excluded by ingestion policy or safety bounds.`)) {
        diagnostics.statusReasons.push(`${diagnostics.excludedFiles} file(s) were excluded by ingestion policy or safety bounds.`);
    }
    return { files, totalBytes: diagnostics.includedBytes, diagnostics };
}

export { DEFAULT_LIMITS as REPOSITORY_INPUT_LIMITS };
