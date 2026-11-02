/**
 * Safe, incremental dependency-edge resolution for a stable repository context.
 * No dependency edge is reused when the repository's file namespace, type
 * declaration namespace, or resolution configuration changes. Source content
 * reuse is gated by the engine's existing SHA-256 per-file cache keys.
 * Function/call graphs and downstream analysis are intentionally rebuilt.
 */
import { extractFileDependencies } from './moduleResolution.js';
import { createFileAnalysisCacheKey } from './analysisCache.js';

const MAX_CHECKPOINT_BYTES = 6 * 1024 * 1024;
const SOURCE_DIAGNOSTICS = ['unresolvedLocalImports', 'unresolvedPackageMembers', 'ambiguousImports'];
const clone = (value) => JSON.parse(JSON.stringify(value));

async function resolutionContextKey(files, classes) {
    const namespace = files.map(({ path, content }) => ({
        path, config: /(?:^|\/)(?:tsconfig(?:\.[^/]*)?\.json|jsconfig(?:\.[^/]*)?\.json|package\.json)$/i.test(path)
            ? content : null,
    })).sort((a,b) => a.path.localeCompare(b.path));
    const types = classes.map(({ file, name, package: pkg }) => [file, name, pkg || ''])
        .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return createFileAnalysisCacheKey('__dependency_resolution_context__', JSON.stringify({ namespace, types }));
}

/**
 * Partial execution is applied only when we have a complete, compatible
 * previous checkpoint and SHA-256 keys for every participating source.
 */
export async function resolveIncrementalDependencies(files, classes, fileCacheKeys, previousResult) {
    const contextKey = await resolutionContextKey(files, classes);
    // Non-code input files (SQL/config/etc.) do not have parser cache keys.
    // Their source-owned resolution stage still needs stable hashes, otherwise
    // one such file would disable incremental execution for the entire repo.
    const sourceKeys = new Map(fileCacheKeys);
    for (const file of files) {
        if (!sourceKeys.has(file.path)) sourceKeys.set(file.path,
            await createFileAnalysisCacheKey(file.path, file.content, { dependencyOnly: true }));
    }
    const checkpoint = previousResult?.dependencyResolutionCheckpoint;
    const eligible = Boolean(contextKey && checkpoint?.schemaVersion === 1 &&
        checkpoint.contextKey === contextKey && Array.isArray(checkpoint.entries) &&
        checkpoint.entries.length === files.length && files.every((f) => sourceKeys.has(f.path) && sourceKeys.get(f.path)));
    const previous = eligible ? new Map(checkpoint.entries.map((row) => [row.path, row])) : new Map();
    const reusable = eligible && previous.size === files.length && files.every((f) => previous.has(f.path));
    const changedPaths = reusable ? files.filter((f) => previous.get(f.path).key !== sourceKeys.get(f.path)).map((f) => f.path)
        : files.map((f) => f.path);
    const changedSet = new Set(changedPaths);
    const freshDiagnostics = {};
    const fresh = extractFileDependencies(files, classes, freshDiagnostics,
        reusable ? { sourcePaths: changedPaths } : {});
    let edges = fresh;
    let diagnostics = freshDiagnostics;
    if (reusable) {
        for (const file of files) {
            if (changedSet.has(file.path)) continue;
            edges.push(...clone(previous.get(file.path).edges));
        }
        diagnostics = { ...freshDiagnostics };
        for (const field of SOURCE_DIAGNOSTICS) {
            diagnostics[field] = [...(freshDiagnostics[field] || []),
                ...files.filter((f) => !changedSet.has(f.path))
                    .flatMap((f) => clone(previous.get(f.path).diagnostics?.[field] || []))];
            diagnostics[field].sort((a,b) => a.path.localeCompare(b.path) || (a.line || 0) - (b.line || 0));
        }
    }
    // Keep deterministic output equivalent to normal full extraction order.
    const ordered = new Map(files.map((f,i) => [f.path, i]));
    edges.sort((a,b) => (ordered.get(a.source) ?? 0) - (ordered.get(b.source) ?? 0) ||
        (a.line || 0) - (b.line || 0) || a.target.localeCompare(b.target));
    let bytes = 0;
    const entries = [];
    let checkpointComplete = Boolean(contextKey);
    const edgesBySource = new Map();
    for (const edge of edges) {
        if (!edgesBySource.has(edge.source)) edgesBySource.set(edge.source, []);
        edgesBySource.get(edge.source).push(edge);
    }
    const diagnosticsBySource = new Map();
    for (const field of SOURCE_DIAGNOSTICS) {
        for (const diagnostic of diagnostics[field] || []) {
            if (!diagnosticsBySource.has(diagnostic.path)) {
                diagnosticsBySource.set(diagnostic.path,
                    Object.fromEntries(SOURCE_DIAGNOSTICS.map((key) => [key, []])));
            }
            diagnosticsBySource.get(diagnostic.path)[field].push(diagnostic);
        }
    }
    for (const file of files) {
        const entry = {
            path: file.path, key: sourceKeys.get(file.path),
            edges: edgesBySource.get(file.path) || [],
            diagnostics: diagnosticsBySource.get(file.path) || {},
        };
        if (!entry.key) { checkpointComplete = false; break; }
        const size = JSON.stringify(entry).length * 2;
        if (bytes + size > MAX_CHECKPOINT_BYTES) { checkpointComplete = false; break; }
        bytes += size;
        entries.push(entry);
    }
    return {
        edges, diagnostics,
        checkpoint: checkpointComplete ? { schemaVersion: 1, contextKey, entries } : null,
        execution: {
            schemaVersion: 1, mode: reusable ? 'partial-dependency-resolution' : 'full-dependency-resolution',
            reusedSourceFiles: reusable ? files.length - changedPaths.length : 0,
            recalculatedSourceFiles: changedPaths.length,
            checkpointAvailable: checkpointComplete,
            contextInvalidated: Boolean(checkpoint && checkpoint.contextKey !== contextKey),
            semantics: 'Only source-owned dependency extraction is reused. SHA-256 file keys and a full repository namespace/configuration/type signature gate reuse. All downstream call graphs, security and cross-system analyses recompute.',
        },
    };
}
