/**
 * Conservative reverse-dependency change impact estimation.
 * An edge `A -> B` means A depends on B, so a change to B may affect A.
 * Results are estimates, not guarantees of breakage or safety.
 */
const NORMALIZED_CONFIDENCE = {
    resolved: { label: 'high', rank: 3 },
    inferred: { label: 'medium', rank: 2 },
    ambiguous: { label: 'low', rank: 1 },
};

function normalizePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

/**
 * @param {string} changedPath Repository-relative file path being changed.
 * @param {Array} dependencies File dependency edges where source depends on target.
 * @param {object} diagnostics Optional dependency-resolution diagnostics.
 * @param {{maxNodes?:number}} options Bounds result size for large repositories.
 */
export function computeChangeImpact(changedPath, dependencies = [], diagnostics = {}, options = {}) {
    const target = normalizePath(changedPath);
    if (!target || target.startsWith('/') || /^[A-Za-z]:\//.test(target) || target.split('/').includes('..')) {
        throw new TypeError('A safe repository-relative changed path is required.');
    }
    const maxNodes = Math.max(1, Math.min(10000, Number(options.maxNodes) || 2000));
    const reverse = new Map();
    const ambiguousCandidatesByTarget = new Map();
    for (const edge of dependencies) {
        const source = normalizePath(edge?.source);
        const dependency = normalizePath(edge?.target);
        if (!source || !dependency || source === dependency) continue;
        // Ambiguous edges enumerate alternatives, not confirmed dependencies.
        // Keep them in a separate possible-impact list rather than presenting
        // each candidate as an ordinary affected file.
        if (edge?.resolution === 'ambiguous') {
            if (!ambiguousCandidatesByTarget.has(dependency)) ambiguousCandidatesByTarget.set(dependency, []);
            ambiguousCandidatesByTarget.get(dependency).push({ path: source, type: edge.type || 'dependency', line: Number.isInteger(edge.line) ? edge.line : null, evidence: edge.evidence || null });
            continue;
        }
        if (edge?.resolution === 'unresolved') continue;
        if (!reverse.has(dependency)) reverse.set(dependency, []);
        reverse.get(dependency).push({
            path: source,
            type: edge.type || 'dependency',
            resolution: edge.resolution || 'inferred',
            line: Number.isInteger(edge.line) ? edge.line : null,
            evidence: edge.evidence || null,
        });
    }

    // Breadth-first traversal finds the shortest dependency path. If two paths
    // reach a file at the same depth, retain the one backed by stronger edges.
    const bestByPath = new Map();
    const queue = [{ path: target, depth: 0, confidenceRank: 3, via: [] }];
    let cursor = 0;
    let truncated = false;
    while (cursor < queue.length) {
        const current = queue[cursor++];
        for (const edge of reverse.get(current.path) || []) {
            // A cycle can route back to the file being changed; it is not an
            // additional affected file and must not inflate the blast radius.
            if (edge.path === target) continue;
            const confidence = NORMALIZED_CONFIDENCE[edge.resolution] || NORMALIZED_CONFIDENCE.inferred;
            const depth = current.depth + 1;
            const candidate = {
                path: edge.path,
                depth,
                confidenceRank: Math.min(current.confidenceRank, confidence.rank),
                via: [...current.via, { from: current.path, to: edge.path, type: edge.type, resolution: edge.resolution, line: edge.line, evidence: edge.evidence }],
            };
            const previous = bestByPath.get(edge.path);
            const isBetter = !previous || candidate.depth < previous.depth ||
                (candidate.depth === previous.depth && candidate.confidenceRank > previous.confidenceRank);
            if (!isBetter) continue;
            if (!previous && bestByPath.size >= maxNodes) { truncated = true; break; }
            bestByPath.set(edge.path, candidate);
            queue.push(candidate);
        }
        if (bestByPath.size >= maxNodes) {
            if (cursor < queue.length) truncated = true;
            break;
        }
    }

    const affectedFiles = [...bestByPath.values()]
        .map((item) => ({
            path: item.path,
            depth: item.depth,
            relationship: item.depth === 1 ? 'direct' : 'transitive',
            confidence: item.confidenceRank >= 3 ? 'high' : item.confidenceRank === 2 ? 'medium' : 'low',
            via: item.via,
        }))
        .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
    const possibleDirectDependents = (ambiguousCandidatesByTarget.get(target) || [])
        .filter((item, index, list) => list.findIndex((candidate) => candidate.path === item.path) === index)
        .map((item) => ({ ...item, relationship: 'possible-direct-dependent', confidence: 'low', reason: 'The import target is ambiguous; this file is a candidate, not a confirmed dependent.' }))
        .sort((a, b) => a.path.localeCompare(b.path));
    const unresolvedCount = Array.isArray(diagnostics.unresolvedLocalImports) ? diagnostics.unresolvedLocalImports.length : 0;
    const ambiguousCount = Array.isArray(diagnostics.ambiguousImports) ? diagnostics.ambiguousImports.length : 0;
    const coverageStatus = diagnostics.coverageStatus || null;
    const incomplete = unresolvedCount > 0 || ambiguousCount > 0 || truncated || ['partial', 'failed', 'unknown'].includes(coverageStatus);
    return {
        schemaVersion: 1,
        changedPath: target,
        semantics: 'Potential reverse dependency impact only. Static analysis cannot guarantee that a change will or will not break runtime behavior.',
        completeness: incomplete ? 'partial' : 'based-on-known-edges',
        directDependents: affectedFiles.filter((item) => item.depth === 1),
        transitiveDependents: affectedFiles.filter((item) => item.depth > 1),
        affectedFiles,
        possibleDirectDependents,
        uncertainty: {
            unresolvedLocalImportCount: unresolvedCount,
            ambiguousImportCount: ambiguousCount,
            analysisCoverageStatus: coverageStatus || 'not-provided',
            resultLimitReached: truncated,
            notes: [
                ...(unresolvedCount ? ['Unresolved local imports may hide additional impact paths.'] : []),
                ...(ambiguousCount ? ['Ambiguous imports make some dependency paths uncertain; their candidate targets are not included as confirmed affected files.'] : []),
                ...(truncated ? [`Impact traversal was bounded at ${maxNodes} discovered dependent files.`] : []),
                ...(coverageStatus === 'partial' || coverageStatus === 'failed' || coverageStatus === 'unknown'
                    ? [`Underlying repository analysis coverage is ${coverageStatus}; unobserved relationships may hide impact paths.`] : []),
            ],
        },
    };
}

/**
 * Estimate reverse caller impact for a function whose key is
 * `${file}|${line}|${name}` (the same key used by the engine's function index).
 * Only uniquely resolved call targets are traversed. Caller attribution is
 * line-range heuristic, so this is an impact lead, not a proof of breakage.
 */
export function computeFunctionImpact(changedFunctionKey, functionConnections = [], diagnostics = {}, options = {}) {
    const target = String(changedFunctionKey || '').trim();
    if (!target || target.length > 2000) throw new TypeError('A valid function key is required.');
    const maxNodes = Math.max(1, Math.min(10000, Number(options.maxNodes) || 2000));
    const reverse = new Map();
    for (const edge of functionConnections || []) {
        const caller = edge?.callerFunctionKey;
        const callee = edge?.calleeFunctionKey;
        if (!caller || !callee || caller === callee || edge?.resolution !== 'resolved') continue;
        if (!reverse.has(callee)) reverse.set(callee, []);
        reverse.get(callee).push({
            callerFunctionKey: caller,
            callerFunctionName: edge.callerFunctionName || null,
            callerFile: edge.callerFile || null,
            callerStartLine: Number.isInteger(edge.callerStartLine) ? edge.callerStartLine : null,
            calleeFunctionKey: callee,
            calleeFunctionName: edge.calleeFunctionName || null,
            calleeFile: edge.calleeFile || null,
            calleeStartLine: Number.isInteger(edge.calleeStartLine) ? edge.calleeStartLine : null,
            callSiteLine: Number.isInteger(edge.callSiteLine) ? edge.callSiteLine : null,
            callSiteExcerpt: edge.callSiteExcerpt || null,
            resolution: edge.resolution,
            confidence: edge.confidence || 'medium',
            attribution: edge.attribution || 'unknown',
            resolvedBy: edge.resolvedBy || null,
        });
    }

    const confidenceRank = (value) => value === 'high' ? 3 : value === 'medium' ? 2 : 1;
    const bestByKey = new Map();
    const queue = [{ key: target, depth: 0, confidenceRank: 3, via: [] }];
    let cursor = 0;
    let truncated = false;
    while (cursor < queue.length) {
        const current = queue[cursor++];
        for (const edge of reverse.get(current.key) || []) {
            if (edge.callerFunctionKey === target) continue;
            const depth = current.depth + 1;
            const rank = Math.min(current.confidenceRank, confidenceRank(edge.confidence));
            const candidate = {
                key: edge.callerFunctionKey,
                name: edge.callerFunctionName,
                file: edge.callerFile,
                line: edge.callerStartLine,
                depth,
                confidenceRank: rank,
                via: [...current.via, {
                    callerFunctionKey: edge.callerFunctionKey,
                    calleeFunctionKey: edge.calleeFunctionKey,
                    callerFile: edge.callerFile,
                    calleeFile: edge.calleeFile,
                    callSiteLine: edge.callSiteLine,
                    callSiteExcerpt: edge.callSiteExcerpt,
                    resolution: edge.resolution,
                    attribution: edge.attribution,
                    resolvedBy: edge.resolvedBy,
                }],
            };
            const previous = bestByKey.get(edge.callerFunctionKey);
            const better = !previous || depth < previous.depth || (depth === previous.depth && rank > previous.confidenceRank);
            if (!better) continue;
            if (!previous && bestByKey.size >= maxNodes) { truncated = true; break; }
            bestByKey.set(edge.callerFunctionKey, candidate);
            queue.push(candidate);
        }
        if (bestByKey.size >= maxNodes) {
            if (cursor < queue.length) truncated = true;
            break;
        }
    }

    const affectedFunctions = [...bestByKey.values()].map((item) => ({
        functionKey: item.key,
        name: item.name,
        file: item.file,
        line: item.line,
        depth: item.depth,
        relationship: item.depth === 1 ? 'direct-caller' : 'transitive-caller',
        confidence: item.confidenceRank >= 3 ? 'high' : item.confidenceRank === 2 ? 'medium' : 'low',
        via: item.via,
    })).sort((a, b) => a.depth - b.depth || String(a.file).localeCompare(String(b.file)) || String(a.name).localeCompare(String(b.name)));

    const unresolved = Number(diagnostics.unresolvedCallCount) || 0;
    const ambiguous = Number(diagnostics.ambiguousCallCount) || 0;
    const unattributed = Number(diagnostics.unattributedFunctionCallSiteCount) || 0;
    const incomplete = truncated || unresolved > 0 || ambiguous > 0 || unattributed > 0;
    return {
        schemaVersion: 1,
        changedFunctionKey: target,
        semantics: 'Potential reverse caller impact based on uniquely resolved call names and heuristic source-line attribution. This cannot guarantee runtime impact or safety.',
        completeness: incomplete ? 'partial' : 'based-on-known-function-edges',
        directCallers: affectedFunctions.filter((item) => item.depth === 1),
        transitiveCallers: affectedFunctions.filter((item) => item.depth > 1),
        affectedFunctions,
        uncertainty: {
            unresolvedCallCount: unresolved,
            ambiguousCallCount: ambiguous,
            unattributedFunctionCallSiteCount: unattributed,
            resultLimitReached: truncated,
            notes: [
                ...(unresolved ? ['Unresolved call names may hide additional callers.'] : []),
                ...(ambiguous ? ['Ambiguous call names were excluded from confirmed function edges.'] : []),
                ...(unattributed ? ['Some resolved call sites could not be assigned to a containing function.'] : []),
                ...(truncated ? [`Function impact traversal was bounded at ${maxNodes} caller functions.`] : []),
            ],
        },
    };
}
