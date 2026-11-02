/**
 * Bounded, evidence-preserving repository dependency intelligence.
 * Edges are importer -> imported. Ambiguous/unresolved candidates MUST NOT be
 * converted into known dependencies. No analysis here proves runtime usage.
 */
import { computeChangeImpact } from './changeImpact.js';
import { isTestFile } from './testLinkage.js';

const pathOf = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
const intLimit = (value, fallback, hardMax) => Number.isInteger(value) && value > 0 ? Math.min(value, hardMax) : fallback;
const rank = { high: 3, medium: 2, low: 1 };

function buildDependencyIndex(files, dependencies, maxEdges) {
    const nodes = [...new Set(files.map((f) => pathOf(f?.path)).filter(Boolean))].sort();
    const nodeSet = new Set(nodes);
    const pairMap = new Map();
    const exclusions = { ambiguous: 0, unresolved: 0, outsideSnapshot: 0, malformed: 0 };
    let inputLimitReached = false;
    for (const edge of dependencies) {
        const source = pathOf(edge?.source);
        const target = pathOf(edge?.target);
        if (!source || !target) { exclusions.malformed++; continue; }
        if (edge.resolution === 'ambiguous') { exclusions.ambiguous++; continue; }
        if (edge.resolution === 'unresolved') { exclusions.unresolved++; continue; }
        if (!nodeSet.has(source) || !nodeSet.has(target)) { exclusions.outsideSnapshot++; continue; }
        const key = JSON.stringify([source, target]);
        const quality = edge.resolution === 'resolved' ? 'high' : 'medium';
        if (!pairMap.has(key)) {
            if (pairMap.size >= maxEdges) { inputLimitReached = true; continue; }
            pairMap.set(key, { source, target, confidence: quality, references: [] });
        }
        const pair = pairMap.get(key);
        if (rank[quality] > rank[pair.confidence]) pair.confidence = quality;
        const reference = {
            type: edge.type || 'dependency',
            resolution: edge.resolution || 'inferred',
            line: Number.isInteger(edge.line) ? edge.line : null,
            evidence: typeof edge.evidence === 'string' ? edge.evidence.slice(0, 240) : null,
        };
        // Keep a deterministic bounded evidence sample even if dependency
        // extraction order changes between runs.
        pair.references.push(reference);
        pair.references.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        if (pair.references.length > 3) pair.references.length = 3;
    }
    const edges = [...pairMap.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
    const outgoing = new Map(nodes.map((node) => [node, []]));
    const incoming = new Map(nodes.map((node) => [node, []]));
    for (const edge of edges) {
        outgoing.get(edge.source).push(edge.target);
        incoming.get(edge.target).push(edge.source);
    }
    for (const paths of [...outgoing.values(), ...incoming.values()]) paths.sort();
    return { nodes, edges, outgoing, incoming, exclusions, inputLimitReached, pairMap };
}

/** Kosaraju with explicit stacks: a 10k-file dependency chain cannot overflow JS recursion. */
function stronglyConnected(index) {
    const visited = new Set();
    const finishing = [];
    for (const node of index.nodes) {
        if (visited.has(node)) continue;
        const stack = [{ node, next: 0 }];
        visited.add(node);
        while (stack.length) {
            const top = stack[stack.length - 1];
            const neighbors = index.outgoing.get(top.node);
            if (top.next >= neighbors.length) { finishing.push(top.node); stack.pop(); continue; }
            const next = neighbors[top.next++];
            if (!visited.has(next)) { visited.add(next); stack.push({ node: next, next: 0 }); }
        }
    }
    visited.clear();
    const components = [];
    for (let i = finishing.length - 1; i >= 0; i--) {
        const node = finishing[i];
        if (visited.has(node)) continue;
        const component = [];
        const stack = [node];
        visited.add(node);
        while (stack.length) {
            const item = stack.pop();
            component.push(item);
            for (const next of index.incoming.get(item)) {
                if (!visited.has(next)) { visited.add(next); stack.push(next); }
            }
        }
        component.sort();
        if (component.length > 1 || index.outgoing.get(component[0]).includes(component[0])) components.push(component);
    }
    return components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

function reachCount(start, incoming, maxNodes) {
    const seen = new Set([start]);
    const queue = [start];
    let current = 0;
    while (current < queue.length && seen.size - 1 < maxNodes) {
        for (const dependent of incoming.get(queue[current++]) || []) {
            if (seen.has(dependent)) continue;
            seen.add(dependent);
            queue.push(dependent);
            if (seen.size - 1 >= maxNodes) break;
        }
    }
    return { count: seen.size - 1, truncated: current < queue.length };
}

/**
 * Discover actual strongly-connected file sets and high-fan-in hotspots.
 * Outputs bounded samples, exact aggregate cycle counts, and explicit limits.
 * Hotspots reflect *static coupling*, not production failure probability.
 */
export function analyzeArchitectureIntelligence(files = [], dependencies = [], options = {}) {
    const maxEdges = intLimit(options.maxEdges, 100000, 250000);
    const maxCycles = intLimit(options.maxCycles, 100, 1000);
    const maxHotspots = intLimit(options.maxHotspots, 25, 250);
    const maxReach = intLimit(options.maxReach, 5000, 10000);
    const index = buildDependencyIndex(files, dependencies, maxEdges);
    const components = stronglyConnected(index);
    const cycleFiles = new Set(components.flat());
    const cycles = components.slice(0, maxCycles).map((component) => {
        const members = new Set(component);
        const internal = index.edges.filter((edge) => members.has(edge.source) && members.has(edge.target));
        return {
            memberCount: component.length,
            files: component.slice(0, 30), filesTruncated: component.length > 30,
            internalEdgeCount: internal.length,
            confidence: internal.every((edge) => edge.confidence === 'high') ? 'high' : 'medium',
            evidence: internal.slice(0, 10).map(({ source, target, confidence, references }) => ({ source, target, confidence, references })),
            semantics: 'Strongly connected static dependencies: each member can reach the others through observed dependency edges.',
        };
    });
    const potentialHotspots = index.nodes.filter((path) => index.incoming.get(path).length > 0)
        .sort((a, b) => index.incoming.get(b).length - index.incoming.get(a).length || a.localeCompare(b))
        .slice(0, maxHotspots);
    const hotspots = potentialHotspots.map((path) => {
        const impact = reachCount(path, index.incoming, maxReach);
        const callers = index.incoming.get(path);
        return {
            path, directDependents: callers.length, estimatedTransitiveDependents: impact.count,
            reachLimitReached: impact.truncated,
            directDependencies: index.outgoing.get(path).length,
            inCycle: cycleFiles.has(path),
            evidence: callers.slice(0, 5).map((source) => {
                const match = index.pairMap.get(JSON.stringify([source, path]));
                return { source, confidence: match.confidence, references: match.references.slice(0, 2) };
            }),
        };
    }).sort((a, b) => b.estimatedTransitiveDependents - a.estimatedTransitiveDependents || b.directDependents - a.directDependents || a.path.localeCompare(b.path));
    return {
        schemaVersion: 1,
        status: index.inputLimitReached || index.exclusions.ambiguous || index.exclusions.unresolved ? 'partial' : 'complete',
        summary: {
            analyzedFiles: index.nodes.length, observedDependencyPairs: index.edges.length,
            cycleGroupCount: components.length, filesInCycles: cycleFiles.size,
            hotspotCount: hotspots.length, omittedCycleGroups: Math.max(0, components.length - maxCycles),
        },
        cycles, hotspots,
        uncertainty: { ...index.exclusions, inputEdgeLimitReached: index.inputLimitReached,
            notes: ['Ambiguous and unresolved references are never treated as confirmed edges.', 'Graph cycles and impact reach are static leads; dynamic imports, runtime dispatch, and unsupported languages may conceal dependencies.', 'Hotspot ranking is by observed dependency reach, not production criticality.'] },
        semantics: 'Evidence-backed static dependency graph intelligence. Edge confidence comes from the underlying resolver. Cycles and reverse reach are computed over observed edges only.',
    };
}

/** Suggest impacted test files from the already-computed test linkage and reverse dependencies. */
export function recommendTestsForChanges(changedPaths = [], dependencies = [], testLinkage = {}, diagnostics = {}, options = {}) {
    const maxChanged = intLimit(options.maxChanged, 100, 1000);
    const maxTests = intLimit(options.maxTests, 100, 1000);
    const knownChanges = [...new Set(changedPaths.map(pathOf).filter(Boolean))].sort();
    const limitedChanges = knownChanges.slice(0, maxChanged);
    const tests = new Map();
    const unresolvedCount = Array.isArray(diagnostics?.unresolvedLocalImports) ? diagnostics.unresolvedLocalImports.length : 0;
    const ambiguousCount = Array.isArray(diagnostics?.ambiguousImports) ? diagnostics.ambiguousImports.length : 0;
    const bySource = testLinkage.bySource || {};
    const existingPaths = options.existingPaths ? new Set(options.existingPaths.map(pathOf)) : null;
    const strength = { high: 3, medium: 2, low: 1 };
    let dependencyTraversalTruncated = false;
    for (const changed of limitedChanges) {
        if (isTestFile(changed) && (!existingPaths || existingPaths.has(changed))) {
            tests.set(changed, {
                testFile: changed, changedFile: changed, linkedSourceFile: null,
                relationship: 'changed-test-file', hops: 0, confidence: 'high',
                linkRelationship: 'file-changed', evidence: { type: 'changed-test-file', path: changed }, dependencyPath: [],
            });
        }
        let affected;
        try {
            const impact = computeChangeImpact(changed, dependencies, diagnostics, { maxNodes: 2000 });
            dependencyTraversalTruncated ||= impact.uncertainty.resultLimitReached;
            affected = [{ path: changed, depth: 0, confidence: 'high', via: [] }, ...impact.affectedFiles];
        } catch {
            continue;
        }
        for (const source of affected) {
            for (const link of bySource[source.path] || []) {
                if (!link.testFile || (existingPaths && !existingPaths.has(pathOf(link.testFile)))) continue;
                const confidence = strength[link.confidence] < strength[source.confidence] ? link.confidence : source.confidence;
                const suggestion = {
                    testFile: link.testFile, changedFile: changed, linkedSourceFile: source.path,
                    relationship: source.depth === 0 ? 'direct-source-link' : 'indirect-dependency-link',
                    hops: source.depth, confidence, linkRelationship: link.relationship,
                    evidence: link.evidence || null, dependencyPath: source.via,
                };
                const existing = tests.get(link.testFile);
                if (!existing || suggestion.hops < existing.hops ||
                    (suggestion.hops === existing.hops && strength[suggestion.confidence] > strength[existing.confidence])) {
                    tests.set(link.testFile, suggestion);
                }
            }
        }
    }
    const all = [...tests.values()].sort((a, b) => a.hops - b.hops || strength[b.confidence] - strength[a.confidence] || a.testFile.localeCompare(b.testFile));
    return {
        schemaVersion: 1, changedFiles: limitedChanges, recommendedTests: all.slice(0, maxTests),
        summary: { changedFiles: knownChanges.length, suggestions: all.length, omittedSuggestions: Math.max(0, all.length - maxTests) },
        status: knownChanges.length > maxChanged || dependencyTraversalTruncated || all.length > maxTests || unresolvedCount || ambiguousCount ? 'partial' : 'complete',
        uncertainty: { changedFileLimitReached: knownChanges.length > maxChanged, dependencyTraversalTruncated, unresolvedLocalImportCount: unresolvedCount, ambiguousImportCount: ambiguousCount },
        semantics: 'A static test-review shortlist from file linkage and reverse dependencies. These are NOT executed tests and do not establish coverage, passing tests, or safe changes. Historical snapshot edges can conservatively include relationships that were removed in the current revision.',
    };
}
