import { ENGINE_VERSION } from '../engineVersion.js';
/**
 * Dependency-free call-graph metric regressions.
 * Verifies that the attribution denominator is based on resolved call-site units,
 * unresolved receiver calls are not mixed into it, and serialization sampling
 * does not cap the metrics. Includes JS/TS/Python/Java syntax-shaped fixtures.
 */
import assert from 'node:assert/strict';
import { buildCallGraph } from '../callGraph.js';
import { extractFileDependencies } from '../moduleResolution.js';
import { analyzeRepository } from '../orchestrator.js';

const fn = (name, file, line, endLine, extra = {}) => ({
    name, file, line, endLine, type: 'function', isTopLevel: true,
    code: `function ${name}() {}`, ...extra,
});

// A resolved call at module scope, one resolved call inside a function, and an
// unresolved typed receiver at module scope. The unresolved site must not reduce
// the resolved-call attribution percentage.
const mixedFiles = [
    { path: 'src/main.js', content: "import { work } from './service.js';\nfunction main() {\n  work();\n}\nmain();\nunknown.receiver.missing();" },
    { path: 'src/service.js', content: 'export function work() { return true; }' },
];
const mixedGraph = buildCallGraph(mixedFiles, [
    fn('main', 'src/main.js', 2, 4, { endLineConfidence: 'explicit' }),
    fn('work', 'src/service.js', 1, 1, { isExported: true }),
], extractFileDependencies(mixedFiles, []));
const mixed = mixedGraph.diagnostics;
assert.equal(mixed.functionCallSiteCount, 2, 'Only uniquely resolved call sites belong in the attribution denominator.');
assert.equal(mixed.locatedFunctionCallSiteCount, 2);
assert.equal(mixed.unattributedFunctionCallSiteCount, 1, 'The module-scope main() call is resolved but has no caller function.');
assert.equal(mixed.unresolvedUnattributedCallSiteCount, 1, 'The unresolved module-scope receiver call is tracked separately.');
assert.equal(Math.round(((mixed.functionCallSiteCount - mixed.unattributedFunctionCallSiteCount) / mixed.functionCallSiteCount) * 1000) / 10, 50);
assert.equal(mixed.totalCallNameReferences, mixed.resolvedCallNameReferences + mixed.unresolvedCallCount + mixed.ambiguousCallCount,
    'Call-reference totals must partition into resolved, unresolved and ambiguous units for this fixture.');

// Check the metrics make it through the public repository analysis output and
// the Markdown report, not just the lower-level call-graph builder.
const integrated = await analyzeRepository({ name: 'callgraph-metrics-contract', source: 'benchmark' }, mixedFiles);
assert.equal(integrated.engineVersion, ENGINE_VERSION);
assert.ok(integrated.analysisCoverage.callGraph);
assert.ok(integrated.analysisCoverage.callGraph.attributionPct == null ||
    (integrated.analysisCoverage.callGraph.attributionPct >= 0 && integrated.analysisCoverage.callGraph.attributionPct <= 100));
assert.ok(Object.hasOwn(integrated.analysisCoverage.callGraph, 'unresolvedUnattributedCallSiteCount'));
assert.ok(integrated.architectureReport.includes('missing call-site locators'));

// Metrics must use all source-located calls, even though only the first 20 per
// aggregate bare-call group are serialized as function-level edge examples.
const repeatedCalls = Array.from({ length: 25 }, () => '  run();').join('\n');
const manyFiles = [
    { path: 'src/many.js', content: `import { run } from './worker.js';\nfunction main() {\n${repeatedCalls}\n}\nmain();` },
    { path: 'src/worker.js', content: 'export function run() { return true; }' },
];
const manyGraph = buildCallGraph(manyFiles, [
    fn('main', 'src/many.js', 2, 28, { endLineConfidence: 'explicit' }),
    fn('run', 'src/worker.js', 1, 1, { isExported: true }),
], extractFileDependencies(manyFiles, []));
const many = manyGraph.diagnostics;
assert.equal(many.locatedFunctionCallSiteCount, 26, 'All 25 run() calls plus main() should be located.');
assert.equal(many.functionCallSiteCount, 26);
assert.equal(many.callSiteEvidenceMissingCount, 0);
assert.ok(many.functionCallSiteCount > manyGraph.functionConnections.length,
    'Metric denominator should not be capped at the serialized edge sample size.');
assert.ok(many.unattributedFunctionCallSiteCount <= many.functionCallSiteCount,
    'Attribution counters must be bounded by the resolved-call denominator.');

// Small cross-language fixtures: caller attribution is expected to work across
// JS, TS, Python and Java, while remaining explicit about syntax-specific limits.
const crossLanguageFixtures = [
    {
        language: 'javascript',
        files: [{ path: 'src/demo.js', content: 'function helper() { return true; }\nfunction entry() {\n  helper();\n}' }],
        functions: [fn('helper', 'src/demo.js', 1, 1), fn('entry', 'src/demo.js', 2, 4)],
    },
    {
        language: 'typescript',
        files: [{ path: 'src/demo.ts', content: 'function helper(): boolean { return true; }\nfunction entry(): boolean {\n  return helper();\n}' }],
        functions: [fn('helper', 'src/demo.ts', 1, 1), fn('entry', 'src/demo.ts', 2, 4)],
    },
    {
        language: 'python',
        files: [{ path: 'src/demo.py', content: 'def helper():\n    return True\n\ndef entry():\n    return helper()' }],
        functions: [fn('helper', 'src/demo.py', 1, 2, { code: 'def helper(): return True' }), fn('entry', 'src/demo.py', 4, 5, { code: 'def entry(): return helper()' })],
    },
    {
        language: 'java',
        files: [{ path: 'src/Demo.java', content: 'class Demo {\n  void helper() { }\n  void entry() {\n    helper();\n  }\n}' }],
        functions: [
            fn('helper', 'src/Demo.java', 2, 2, { type: 'method', className: 'Demo', isClassMethod: true, isTopLevel: false, code: 'void helper() {}' }),
            fn('entry', 'src/Demo.java', 3, 5, { type: 'method', className: 'Demo', isClassMethod: true, isTopLevel: false, code: 'void entry() { helper(); }' }),
        ],
    },
];
const externalClassificationGraph = buildCallGraph([
    { path: 'src/external-calls.js', content: 'function entry(items, service) {\n  console.log("hello");\n  items.map((item) => item);\n  service.findById();\n}' },
], [fn('entry', 'src/external-calls.js', 1, 5)], []);
assert.ok(externalClassificationGraph.diagnostics.externalLikelyReceiverCallCount >= 2,
    'Common logger and standard-library receiver calls should be separately classified as likely external.');
assert.ok(externalClassificationGraph.diagnostics.projectUnknownReceiverCallCount >= 1,
    'Unknown service methods should remain visible as project-or-unknown unresolved calls.');

for (const fixture of crossLanguageFixtures) {
    const graph = buildCallGraph(fixture.files, fixture.functions, extractFileDependencies(fixture.files, []));
    const diagnostics = graph.diagnostics;
    assert.ok(Number.isFinite(diagnostics.totalCallNameReferences), `${fixture.language}: total references should be numeric.`);
    assert.ok(diagnostics.unattributedFunctionCallSiteCount <= diagnostics.functionCallSiteCount,
        `${fixture.language}: unattributed resolved sites cannot exceed denominator.`);
    assert.ok(graph.functionConnections.length > 0, `${fixture.language}: expected at least one resolved function-level edge.`);
}

console.log(JSON.stringify({
    suite: 'callgraph-metrics-regression',
    status: 'passed',
    mixedCallSites: {
        totalReferences: mixed.totalCallNameReferences,
        resolvedReferences: mixed.resolvedCallNameReferences,
        resolvedCallSiteCount: mixed.functionCallSiteCount,
        attributedCallSiteCount: mixed.functionCallSiteCount - mixed.unattributedFunctionCallSiteCount,
        unresolvedUnattributedCallSiteCount: mixed.unresolvedUnattributedCallSiteCount,
    },
    sampledCallSites: {
        located: many.locatedFunctionCallSiteCount,
        denominator: many.functionCallSiteCount,
        serializedEdges: manyGraph.functionConnections.length,
    },
    languages: crossLanguageFixtures.map((fixture) => fixture.language),
}, null, 2));
