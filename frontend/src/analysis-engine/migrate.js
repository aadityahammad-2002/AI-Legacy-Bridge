/**
 * migrate.js — Phase 3, batch 1 (Migrate page).
 *
 *   1. File-level Migration Risk Score — combines blast radius (safeToTouch
 *      from Phase 1), complexity, and known security issues into one score
 *      per file, so the Migrate page can rank "migrate this first" vs
 *      "handle this one carefully".
 *   2. Dependency-safe migration order — a topological ordering over the
 *      file dependency graph: files nothing else depends on go first
 *      (changing them is locally contained), files everything depends on
 *      go last. Cycles are broken and flagged rather than silently ignored.
 */

/**
 * Combines complexity, blast radius and security findings into one 0-100
 * risk score per file. Deterministic weighted sum — tagged INFERENCE
 * because "risk" is a judgment call built from several heuristic signals,
 * not a single verified fact.
 */
export function computeMigrationRisk({ files, safeToTouch, securityIssues }) {
    const secByFile = new Map();
    (securityIssues || []).forEach((s) => {
        secByFile.set(s.file || s.path, (secByFile.get(s.file || s.path) || 0) + 1);
    });

    const risk = {};
    files.forEach((file) => {
        const blast = safeToTouch?.[file.path] || { level: 'low', directDependents: 0, transitiveDependents: 0 };
        const complexityScore = file.complexity?.score || 0;
        const secCount = secByFile.get(file.path) || 0;

        const blastPoints = { low: 5, medium: 25, high: 55, critical: 80 }[blast.level] ?? 5;
        const complexityPoints = Math.min(30, complexityScore);
        const securityPoints = Math.min(20, secCount * 10);

        const score = Math.min(100, Math.round(blastPoints * 0.6 + complexityPoints * 0.25 + securityPoints * 0.15));

        let level = 'low';
        if (score >= 70) level = 'critical';
        else if (score >= 45) level = 'high';
        else if (score >= 20) level = 'medium';

        risk[file.path] = {
            score,
            level,
            factors: {
                dependents: blast.directDependents,
                transitiveDependents: blast.transitiveDependents,
                complexity: complexityScore,
                securityIssues: secCount,
            },
            confidence: 'INFERENCE',
            confidenceReason: 'Weighted combination of blast radius, complexity, and known security findings — a relative ranking signal, not a certified risk assessment.',
        };
    });
    return risk;
}

/**
 * Kahn's algorithm topological sort over the file dependency graph, where
 * an edge d.source -> d.target means "target depends on source" (target
 * imports/calls into source, per extractFileDependencies' convention).
 * Migrating in this order means: migrate a file only after everything it
 * depends on has already moved — so at any point, an already-migrated file
 * never depends on an unmigrated one.
 *
 * Cycles (common in real codebases) can't be strictly ordered; files caught
 * in a cycle are placed together in one batch, in original-encounter order,
 * flagged so the user knows to migrate them as a single unit.
 */
export function computeMigrationOrder({ files, dependencies }) {
    const paths = files.map((f) => f.path);
    const dependsOn = new Map(paths.map((p) => [p, new Set()])); // p -> set of files p depends on
    const dependents = new Map(paths.map((p) => [p, new Set()])); // p -> set of files that depend on p

    dependencies.forEach((d) => {
        if (!dependsOn.has(d.target) || !dependsOn.has(d.source)) return; // skip edges to files outside this set
        dependsOn.get(d.target).add(d.source);
        dependents.get(d.source).add(d.target);
    });

    const inDegree = new Map(paths.map((p) => [p, dependsOn.get(p).size]));
    const order = [];
    let queue = paths.filter((p) => inDegree.get(p) === 0).sort();
    const done = new Set();

    let batchNum = 0;
    while (queue.length) {
        batchNum++;
        const thisBatch = queue;
        queue = [];
        thisBatch.forEach((p) => {
            order.push({ file: p, batch: batchNum, reason: 'Nothing left unmigrated depends on this file.' });
            done.add(p);
        });
        thisBatch.forEach((p) => {
            dependents.get(p).forEach((dep) => {
                if (done.has(dep)) return;
                inDegree.set(dep, inDegree.get(dep) - 1);
                if (inDegree.get(dep) === 0) queue.push(dep);
            });
        });
        queue.sort();
    }

    // Anything left is part of a cycle — group it as one flagged batch.
    const remaining = paths.filter((p) => !done.has(p));
    if (remaining.length) {
        batchNum++;
        remaining.forEach((p) => {
            order.push({
                file: p,
                batch: batchNum,
                reason: 'Part of a circular dependency — cannot be strictly ordered relative to the others in this batch. Migrate together, or break the cycle first.',
                inCycle: true,
            });
        });
    }

    return {
        order,
        totalBatches: batchNum,
        confidence: remaining.length ? 'UNCERTAIN' : 'FACT',
        confidenceReason: remaining.length
            ? `${remaining.length} file(s) are in a dependency cycle and couldn't be strictly ordered.`
            : 'Derived directly from the static dependency graph via topological sort — no cycles found.',
    };
}
