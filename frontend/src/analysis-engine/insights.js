/**
 * insights.js — Phase 1 of the 48-item roadmap.
 *
 * Three items, kept in one file because they share the same dependency
 * graph / fnStats inputs that orchestrator.js already computes:
 *
 *   1. Entry-point detection + "Where to start reading" ranking, and
 *      "5 Most Important Files" (graph-centrality) ranking.
 *   2. Confidence/Provenance tagging — a MANDATORY output-format rule
 *      (FACT / INFERENCE / UNCERTAIN + reason) applied to every finding
 *      the engine already produces (issues, securityIssues, duplicates),
 *      not a standalone feature.
 *   3. Blast-radius → "Safe to touch" badge, precomputed for every file
 *      (calcBlast in parser.js already does the per-file math on demand;
 *      this wraps it into a repo-wide map + a human badge + a confidence tag).
 *
 * All heuristics here are deterministic (same input -> same output) and
 * conservative: when a rule can't be verified with certainty it is tagged
 * INFERENCE or UNCERTAIN rather than presented as FACT.
 */

import { calcBlast } from './parser.js';

// ---------------------------------------------------------------------
// 1. Entry-point detection + ranking
// ---------------------------------------------------------------------

const ENTRY_POINT_SIGNALS = [
    // [regex, label, confidence]
    [/@SpringBootApplication/, 'Spring Boot application root', 'FACT'],
    [/public\s+static\s+void\s+main\s*\(/, 'Java/Kotlin main() method', 'FACT'],
    [/if\s+__name__\s*==\s*['"]__main__['"]/, 'Python script entry (__main__)', 'FACT'],
    [/@(?:Get|Post|Put|Delete|Patch)Mapping|@RequestMapping/, 'Spring REST endpoint', 'FACT'],
    [/@(app|router)\.(get|post|put|delete|patch)\s*\(/, 'Flask/FastAPI/Express route', 'FACT'],
    [/app\.listen\s*\(/, 'Node/Express server bootstrap', 'FACT'],
    [/ReactDOM\.(createRoot|render)\s*\(/, 'React app mount point', 'FACT'],
    [/func\s+main\s*\(\s*\)/, 'Go main() function', 'FACT'],
    [/class\s+\w+\(unittest\.TestCase\)|describe\s*\(|def\s+test_/, 'Test entry point', 'INFERENCE'],
];

function detectEntrySignals(file) {
    const hits = [];
    for (const [re, label, confidence] of ENTRY_POINT_SIGNALS) {
        if (re.test(file.content || '')) hits.push({ label, confidence });
    }
    return hits;
}

/**
 * Ranks candidate entry points ("where should I start reading?") using:
 *  - explicit framework/runtime signals (main(), routes, app bootstrap) — FACT
 *  - zero incoming internal dependents but has outgoing calls (top of the
 *    call chain) — INFERENCE, since it's a structural guess not a literal match
 *
 * Returns the top N, each with a reason string and a confidence tag so the
 * UI can show "why" this file was picked, not just a bare ranking.
 */
export function computeEntryPoints({ files, dependencies, fnStats }, limit = 8) {
    const incomingCount = new Map();
    dependencies.forEach((d) => incomingCount.set(d.target, (incomingCount.get(d.target) || 0) + 1));
    const outgoingCount = new Map();
    dependencies.forEach((d) => outgoingCount.set(d.source, (outgoingCount.get(d.source) || 0) + 1));

    const candidates = [];
    files.forEach((file) => {
        const signals = detectEntrySignals(file);
        const hasNoIncoming = !incomingCount.has(file.path);
        const hasOutgoing = (outgoingCount.get(file.path) || 0) > 0;

        if (!signals.length && !(hasNoIncoming && hasOutgoing)) return;

        let score = 0;
        const reasons = [];
        let confidence = 'INFERENCE';

        signals.forEach((s) => {
            score += 10;
            reasons.push(s.label);
            if (s.confidence === 'FACT') confidence = 'FACT';
        });

        if (hasNoIncoming && hasOutgoing) {
            score += 2;
            reasons.push('Not imported by any other file in this repo, but calls out to others (top of the call chain)');
        }

        candidates.push({
            file: file.path,
            score,
            confidence,
            reasons,
        });
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit);
}

/**
 * "5 Most Important Files" — plain degree-centrality over the file-level
 * dependency graph (in-degree + out-degree), tie-broken by function count.
 * This is a standard, explainable centrality measure — not full PageRank —
 * so it's tagged INFERENCE (a reasonable proxy for importance, not a
 * verified fact about the codebase's design intent).
 */
export function computeImportantFiles({ files, dependencies }, limit = 5) {
    const inDeg = new Map();
    const outDeg = new Map();
    dependencies.forEach((d) => {
        inDeg.set(d.target, (inDeg.get(d.target) || 0) + 1);
        outDeg.set(d.source, (outDeg.get(d.source) || 0) + 1);
    });

    const ranked = files
        .map((f) => {
            const inbound = inDeg.get(f.path) || 0;
            const outbound = outDeg.get(f.path) || 0;
            return {
                file: f.path,
                centrality: inbound + outbound,
                inbound,
                outbound,
                functionCount: f.functionCount || 0,
                confidence: 'INFERENCE',
                reason: `${inbound} file${inbound === 1 ? '' : 's'} depend on this, it depends on ${outbound}`,
            };
        })
        .filter((r) => r.centrality > 0)
        .sort((a, b) => b.centrality - a.centrality || b.functionCount - a.functionCount);

    return ranked.slice(0, limit);
}

// ---------------------------------------------------------------------
// 2. Confidence / Provenance tagging (mandatory output-format rule)
// ---------------------------------------------------------------------

/**
 * Attaches { confidence, confidenceReason } to a single finding object.
 * `rule` describes how the confidence was decided, kept short and generic
 * so callers can reuse it across issue types.
 */
export function tagConfidence(item, confidence, reason) {
    return { ...item, confidence, confidenceReason: reason };
}

/**
 * Applies confidence tags across every finding-producing array the engine
 * already returns. Kept centralized here so every future item added to the
 * 48-item list only needs to call `tagConfidence` once instead of each
 * feature re-inventing its own labeling.
 *
 * Defaults (can be overridden per-item by passing an already-tagged item in):
 *  - Regex/keyword-based structural findings (circular deps, layer
 *    violations, dead code by naming convention) -> FACT if directly
 *    observed in source text, INFERENCE if derived from heuristics.
 *  - Similarity-based findings (duplicate code, "similar" names) -> INFERENCE
 *    since similarity thresholds are heuristic by nature.
 *  - Anything estimated from indirect signals (test-priority, blast-radius
 *    projections beyond depth 1) -> UNCERTAIN.
 */
export function tagFindings({ issues = [], securityIssues = [], duplicates = [] }) {
    const FACT_TITLES = ['Circular Dependencies', 'Architecture Violations', 'Large Files'];

    const taggedIssues = issues.map((issue) => {
        const isFact = FACT_TITLES.some((t) => issue.title && issue.title.includes(t));
        if (issue.title && issue.title.includes('Unused Functions')) {
            return tagConfidence(issue, 'INFERENCE', 'No call sites found within this repo — cannot rule out dynamic dispatch, reflection, or external callers.');
        }
        if (issue.title && issue.title.includes('Highly Coupled')) {
            return tagConfidence(issue, 'FACT', 'Import count measured directly from source files.');
        }
        if (issue.title && issue.title.includes('High Complexity')) {
            return tagConfidence(issue, 'INFERENCE', 'Complexity score is a heuristic metric (branching/nesting-based), not a verified defect.');
        }
        return tagConfidence(issue, isFact ? 'FACT' : 'INFERENCE', isFact
            ? 'Directly observed by parsing import/reference statements in source.'
            : 'Derived from heuristic pattern matching.');
    });

    const taggedSecurity = securityIssues.map((s) =>
        tagConfidence(s, 'INFERENCE', 'Matched by regex pattern (e.g. key=value literal) — may include false positives such as placeholder or test credentials.')
    );

    const taggedDuplicates = duplicates.map((d) =>
        tagConfidence(d, 'UNCERTAIN', d.type === 'code'
            ? 'Similarity computed via token/structure comparison above a threshold — flags "likely" duplication, not confirmed copy-paste.'
            : 'Same function name across files — may be intentional (e.g. interface implementations), not necessarily a conflict.')
    );

    return { issues: taggedIssues, securityIssues: taggedSecurity, duplicates: taggedDuplicates };
}

// ---------------------------------------------------------------------
// 3. Blast-radius -> "Safe to touch" badge (repo-wide, precomputed)
// ---------------------------------------------------------------------

function badgeForLevel(level) {
    switch (level) {
        case 'critical': return { badge: '🔴 High risk', safe: false };
        case 'high': return { badge: '🟠 Risky', safe: false };
        case 'medium': return { badge: '🟡 Moderate', safe: null };
        default: return { badge: '🟢 Safe to modify', safe: true };
    }
}

/**
 * Precomputes calcBlast() for every file so pages (Migrate, AI Explorer,
 * Visualization Explorer) can show a "Safe to touch" badge without each
 * one re-running the graph walk on demand. Every entry carries a
 * confidence tag because blast-radius beyond direct dependents (depth 1)
 * is a projection, not a guarantee — dynamic calls, reflection, and
 * string-based dispatch aren't tracked by the static call graph.
 */
export function computeSafeToTouch({ files, connections }) {
    const map = {};
    files.forEach((file) => {
        let blast;
        try {
            blast = calcBlast(file.path, connections, files);
        } catch {
            blast = { count: 0, transitiveCount: 0, level: 'low', affected: [], transitive: [] };
        }
        const { badge, safe } = badgeForLevel(blast.level);
        const confidence = blast.transitiveCount > blast.count ? 'UNCERTAIN' : (blast.count > 0 ? 'FACT' : 'INFERENCE');
        const reason = blast.count > 0
            ? `${blast.count} file${blast.count === 1 ? '' : 's'} directly depend on this` +
              (blast.transitiveCount > blast.count ? `, plus ${blast.transitiveCount - blast.count} more transitively (projected, not exhaustively verified)` : '')
            : 'No other file in this repo imports from this one (based on static import/call analysis — dynamic references aren\'t tracked)';

        map[file.path] = {
            level: blast.level,
            badge,
            safe,
            directDependents: blast.count,
            transitiveDependents: blast.transitiveCount,
            confidence,
            confidenceReason: reason,
        };
    });
    return map;
}
