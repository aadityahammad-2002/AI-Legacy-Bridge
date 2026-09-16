/**
 * suggestions.js
 *
 * Derives the "Actions" tab's prioritized recommendation cards from data we
 * already compute (issues, securityIssues, duplicates, files) — same spirit
 * as buildIssues() in callGraph.js: no new analysis, just a different view
 * over existing results. Kept separate from the frontend/backend ingest
 * contract (not part of analyzeRepository()'s return value) since it's pure
 * UI-derived data the RepositoryPanel computes on the fly.
 */
export function buildSuggestions({ issues, securityIssues, duplicates, files }) {
    const suggestions = [];
    const plural = (n, s = '', p = 's') => (n === 1 ? s : p);

    const highSec = (securityIssues || []).filter((s) => s.severity === 'high');
    if (highSec.length) {
        suggestions.push({
            icon: 'shield', title: 'Fix Security Issues', priority: 'HIGH',
            desc: `${highSec.length} high-severity security issue${plural(highSec.length)} found.`,
            action: 'Review each flagged file and remediate — move secrets to env vars, use parameterized queries, sanitize HTML output.',
            benefit: 'Reduces risk of credential leaks and injection attacks',
        });
    }

    const largeFiles = (issues || []).find((i) => i.title.includes('Large Files'));
    if (largeFiles) {
        suggestions.push({
            icon: 'split', title: 'Split Large Files', priority: 'HIGH',
            desc: `${largeFiles.items.length} file${plural(largeFiles.items.length)} have too many functions. Split by responsibility.`,
            action: 'Group related functions and extract to separate modules',
            benefit: 'Improves code navigation and testing',
        });
    }

    const codeDups = (duplicates || []).filter((d) => d.type === 'code');
    if (codeDups.length) {
        suggestions.push({
            icon: 'copy', title: 'Extract Duplicated Code', priority: 'HIGH',
            desc: `${codeDups.length} instance${plural(codeDups.length)} of similar code found. DRY principle violation.`,
            action: 'Create shared utility functions',
            benefit: 'Reduces maintenance burden and potential bugs',
        });
    }

    const archViolations = (issues || []).find((i) => i.title.includes('Architecture Violations'));
    if (archViolations) {
        suggestions.push({
            icon: 'layers', title: 'Fix Architecture Violations', priority: 'HIGH',
            desc: `${archViolations.items.length} layer violation${plural(archViolations.items.length)} found. Lower layers should not depend on higher layers.`,
            action: 'Invert dependencies or use interfaces/events',
            benefit: 'Improves architecture and testability',
        });
    }

    const highCoupled = (issues || []).find((i) => i.title.includes('Highly Coupled'));
    if (highCoupled) {
        suggestions.push({
            icon: 'link', title: 'Reduce Coupling', priority: 'MEDIUM',
            desc: `${highCoupled.items.length} file${plural(highCoupled.items.length)} are imported by many others. Consider if this is intentional.`,
            action: 'Review if these should be split or if importers should be consolidated',
            benefit: 'Reduces blast radius of changes',
        });
    }

    const nameDups = (duplicates || []).filter((d) => d.type === 'name');
    if (nameDups.length) {
        suggestions.push({
            icon: 'copy2', title: 'Resolve Naming Conflicts', priority: 'MEDIUM',
            desc: `${nameDups.length} function name${plural(nameDups.length)} are duplicated across files. This can cause confusion.`,
            action: 'Rename functions to be more specific or consolidate into a shared module',
            benefit: 'Prevents bugs from importing the wrong function',
        });
    }

    const testFiles = (files || []).filter(
        (f) => /\.(spec|test)\.[jt]sx?$/.test(f.path) || f.path.includes('__tests__') || /\/tests?\//.test(f.path)
    );
    const testPct = files && files.length ? Math.round((testFiles.length / files.length) * 100) : 0;
    if (testFiles.length === 0 || testPct < 20) {
        suggestions.push({
            icon: 'flask', title: 'Add Test Coverage', priority: testFiles.length === 0 ? 'MEDIUM' : 'LOW',
            desc: `Only ${testFiles.length} test file${plural(testFiles.length)} found (${testPct}%). Consider adding more tests.`,
            action: 'Focus on testing critical paths and high-complexity files',
            benefit: 'Prevents regressions and improves confidence',
        });
    }

    return suggestions;
}
