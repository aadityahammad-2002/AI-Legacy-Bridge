/** Executable with Node alone: no browser, network, or vitest dependency. */
import assert from 'node:assert/strict';
import { analyzeArchitectureIntelligence, recommendTestsForChanges } from '../architectureIntelligence.js';
import { analyzeRepository } from '../orchestrator.js';
import { computeModuleBoundaries } from '../architecture.js';

const paths = ['src/A.ts', 'src/B.ts', 'src/C.ts', 'src/D.ts', 'src/A.test.ts'];
const files = paths.map((path) => ({ path }));
const edges = [
    { source: 'src/A.ts', target: 'src/B.ts', resolution: 'resolved', type: 'import', line: 1, evidence: "from './B'" },
    { source: 'src/B.ts', target: 'src/A.ts', resolution: 'inferred', type: 'import', line: 2 },
    { source: 'src/C.ts', target: 'src/B.ts', resolution: 'resolved', type: 'import', line: 3 },
    { source: 'src/D.ts', target: 'src/C.ts', resolution: 'resolved', type: 'import', line: 4 },
    { source: 'src/A.test.ts', target: 'src/A.ts', resolution: 'resolved', type: 'import', line: 5 },
    { source: 'src/D.ts', target: 'src/A.ts', resolution: 'ambiguous', type: 'import', line: 6 },
    { source: 'src/D.ts', target: 'src/A.ts', resolution: 'unresolved', type: 'import', line: 6 },
];
const result = analyzeArchitectureIntelligence(files, edges);
assert.equal(result.summary.cycleGroupCount, 1);
assert.deepEqual(result.cycles[0].files, ['src/A.ts', 'src/B.ts']);
assert.equal(result.cycles[0].confidence, 'medium');
assert.equal(result.uncertainty.ambiguous, 1);
assert.equal(result.uncertainty.unresolved, 1);
assert.equal(result.summary.observedDependencyPairs, 5);
assert.equal(result.hotspots.find((item) => item.path === 'src/B.ts').directDependents, 2);
assert.equal(result.hotspots.find((item) => item.path === 'src/B.ts').estimatedTransitiveDependents, 4);
assert.equal(result.cycles[0].evidence.some((item) => item.references[0]?.line === 1), true);
assert.deepEqual(result, analyzeArchitectureIntelligence([...files].reverse(), [...edges].reverse()), 'graph results should be deterministic regardless of input ordering');

const selection = recommendTestsForChanges(['src/B.ts'], edges, {
    bySource: { 'src/A.ts': [{ testFile: 'src/A.test.ts', confidence: 'high', relationship: 'imports', evidence: { type: 'dependency-edge' } }] },
});
assert.equal(selection.recommendedTests.length, 1);
assert.deepEqual(selection.recommendedTests[0], {
    testFile: 'src/A.test.ts', changedFile: 'src/B.ts', linkedSourceFile: 'src/A.ts',
    relationship: 'indirect-dependency-link', hops: 1, confidence: 'high', linkRelationship: 'imports',
    evidence: { type: 'dependency-edge' }, dependencyPath: [
        { from: 'src/B.ts', to: 'src/A.ts', type: 'import', resolution: 'resolved', line: 1, evidence: "from './B'" },
    ],
});
const direct = recommendTestsForChanges(['src/A.ts'], edges, {
    bySource: { 'src/A.ts': [{ testFile: 'src/A.test.ts', confidence: 'low', relationship: 'filename-convention' }] },
});
assert.equal(direct.recommendedTests[0].relationship, 'direct-source-link');
assert.equal(direct.recommendedTests[0].confidence, 'low');
const changedTest = recommendTestsForChanges(['src/A.test.ts'], edges, {}, {}, { existingPaths: paths });
assert.equal(changedTest.recommendedTests[0].relationship, 'changed-test-file');
const removedTest = recommendTestsForChanges(['src/A.test.ts'], edges, {}, {}, { existingPaths: ['src/A.ts'] });
assert.equal(removedTest.recommendedTests.length, 0);

const tiny = analyzeArchitectureIntelligence(files, edges, { maxEdges: 2, maxCycles: 1 });
assert.equal(tiny.uncertainty.inputEdgeLimitReached, true);
assert.equal(tiny.status, 'partial');
assert.equal(tiny.summary.observedDependencyPairs, 2);
assert.deepEqual(computeModuleBoundaries({ files: [
    { path: 'src/orders/service.ts' }, { path: 'src/payments/gateway.ts' },
], dependencies: [{ source: 'src/orders/service.ts', target: 'src/payments/gateway.ts', resolution: 'ambiguous' }] }).edges, []);

// Long chain verifies stack-safe SCC traversal and bounded reporting.
const size = 8000;
const chain = Array.from({ length: size }, (_, i) => ({ path: `mod/${i}.ts` }));
const chainEdges = chain.slice(1).map((file, i) => ({ source: file.path, target: chain[i].path, resolution: 'resolved' }));
const large = analyzeArchitectureIntelligence(chain, chainEdges, { maxHotspots: 4 });
assert.equal(large.summary.cycleGroupCount, 0);
assert.equal(large.summary.observedDependencyPairs, size - 1);
assert.equal(large.hotspots[0].estimatedTransitiveDependents, 5000);
assert.equal(large.hotspots[0].reachLimitReached, true); // default max reach 5000

// End-to-end integration: no fake tests, actual dependency graph and snapshot diff.
const initial = [
    { path: 'src/A.ts', content: "import { f } from './B';\nexport function start() { return f(); }" },
    { path: 'src/B.ts', content: 'export function f() { return 1; }' },
    { path: 'src/A.test.ts', content: "import { start } from './A';\nexport function testRun() { return start(); }" },
];
const old = await analyzeRepository({ name: 'graph-power-test' }, initial);
const current = await analyzeRepository({ name: 'graph-power-test' }, initial.map((f) =>
    f.path === 'src/B.ts' ? { ...f, content: 'export function f() { return 2; }' } : f), null, { previousResult: old });
assert.equal(current.architectureIntelligence.summary.observedDependencyPairs >= 2, true);
assert.equal(current.analysisCoverage.stages.architectureIntelligence.status, 'complete');
assert.deepEqual(current.incrementalAnalysis.changedFiles, ['src/B.ts']);
assert.equal(current.changeReview.available, true);
assert.equal(current.changeReview.recommendedTests.find((t) => t.testFile === 'src/A.test.ts').hops, 1);
assert.match(current.architectureReport, /Dependency Cycles and Structural Hotspots/);
assert.match(current.architectureReport, /Tests to Review for Changed Files/);
// Removed source files can still recommend surviving tests via baseline evidence.
const removed = await analyzeRepository({ name: 'graph-power-test' }, initial.filter((file) => file.path !== 'src/B.ts'), null, { previousResult: old });
assert.equal(removed.changeReview.available, true);
assert.equal(removed.changeReview.recommendedTests.some((test) => test.testFile === 'src/A.test.ts'), true);
// Deleted test files must never appear as runnable suggestions.
const withoutTests = await analyzeRepository({ name: 'graph-power-test' }, [
    { path: 'src/A.ts', content: 'export function start() { return 1; }' },
    { path: 'src/B.ts', content: 'export function f() { return 3; }' },
], null, { previousResult: old });
assert.equal(withoutTests.changeReview.recommendedTests.some((test) => test.testFile === 'src/A.test.ts'), false);
console.log(JSON.stringify({ status: 'passed', benchmark: 'architecture-intelligence-regression', checks: [
    'strongly connected cycles and edge confidence', 'evidence and deterministic output',
    'ambiguous/unresolved edge exclusion', 'direct and indirect test suggestions',
    'truncation reported', '8000-file iterative graph traversal', 'end-to-end snapshot integration',
], largeGraph: { files: size, edges: chainEdges.length } }, null, 2));
