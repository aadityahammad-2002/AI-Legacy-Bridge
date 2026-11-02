import { computeChangeImpact } from './changeImpact.js';
import { stableFingerprint } from './findingQuality.js';

function canonicalPath(path) { return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/'); }
function contentDigest(content) {
    const value = String(content ?? '');
    // Include length and a small non-cryptographic fingerprint; used only for diff planning.
    return `${value.length}:${stableFingerprint(value)}`;
}

/** Compare two in-memory file snapshots. It deliberately does not claim to run analysis incrementally. */
export function compareFileSnapshots(previousFiles = [], currentFiles = []) {
    const previous = new Map(previousFiles.filter((file) => file && typeof file.path === 'string').map((file) => [canonicalPath(file.path), contentDigest(file.content)]));
    const current = new Map(currentFiles.filter((file) => file && typeof file.path === 'string').map((file) => [canonicalPath(file.path), contentDigest(file.content)]));
    const added = [];
    const modified = [];
    const unchanged = [];
    const removed = [];
    for (const [path, digest] of current) {
        if (!previous.has(path)) added.push(path);
        else if (previous.get(path) !== digest) modified.push(path);
        else unchanged.push(path);
    }
    for (const path of previous.keys()) if (!current.has(path)) removed.push(path);
    const sorted = (list) => list.sort((a, b) => a.localeCompare(b));
    return {
        schemaVersion: 1,
        added: sorted(added), modified: sorted(modified), unchanged: sorted(unchanged), removed: sorted(removed),
        changed: sorted([...added, ...modified, ...removed]),
        counts: { previous: previous.size, current: current.size, added: added.length, modified: modified.length, unchanged: unchanged.length, removed: removed.length },
        semantics: 'Snapshot comparison uses deterministic non-cryptographic fingerprints to identify likely content changes. It is a planning aid, not a security hash or proof of semantic equivalence.',
    };
}

/**
 * Build a review plan from an earlier analysis and the current snapshot.
 * Current analysis still runs fully; existing per-file caches may reuse extraction.
 */
export function buildIncrementalAnalysisPlan(previousResult, currentFiles = [], currentDependencies = [], dependencyDiagnostics = {}) {
    const previousFiles = previousResult?.sourceFiles || previousResult?.inputFiles || previousResult?.files || [];
    if (!previousResult || !Array.isArray(previousFiles)) {
        return {
            schemaVersion: 1, available: false,
            reason: 'Provide previousResult from an earlier engine run to produce a file-change plan.',
            semantics: 'No previous snapshot was available; no incremental comparison was performed.',
        };
    }
    const diff = compareFileSnapshots(previousFiles, currentFiles);
    const previousDependencies = Array.isArray(previousResult.dependencies) ? previousResult.dependencies : [];
    const combinedEdges = [...previousDependencies, ...currentDependencies];
    const impactedByChange = [];
    for (const path of [...diff.modified, ...diff.removed]) {
        try {
            const impact = computeChangeImpact(path, combinedEdges, dependencyDiagnostics, { maxNodes: 1000 });
            impactedByChange.push({ path, affectedCount: impact.affectedFiles.length, affectedFiles: impact.affectedFiles.slice(0, 100), possibleDirectDependents: impact.possibleDirectDependents.slice(0, 50), completeness: impact.completeness });
        } catch (error) {
            impactedByChange.push({ path, affectedCount: 0, affectedFiles: [], completeness: 'unknown', error: String(error.message || error).slice(0, 200) });
        }
    }
    return {
        schemaVersion: 1,
        available: true,
        diff,
        changedFiles: diff.changed,
        potentiallyImpactedFiles: [...new Set(impactedByChange.flatMap((item) => item.affectedFiles.map((entry) => entry.path)))].sort(),
        impactByChangedFile: impactedByChange,
        cacheStrategy: 'The current engine still recomputes repository-wide graphs. Per-file extraction/complexity caches can reuse matching content; dependency graphs are recomputed for correctness after add/remove/change.',
        incrementalExecutionImplemented: false,
        semantics: 'This is a diff/impact plan, not a claim that unchanged files or repository-wide stages were skipped. Dynamic/reflection-based dependencies may be missing.',
    };
}
