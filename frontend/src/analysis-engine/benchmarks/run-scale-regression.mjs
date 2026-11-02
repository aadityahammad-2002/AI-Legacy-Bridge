/**
 * Synthetic scale/regression benchmark for the analysis engine.
 * Run from frontend/: node src/analysis-engine/benchmarks/run-scale-regression.mjs
 * This measures deterministic behavior on generated TypeScript-like modules; it
 * is not a real-world performance SLA or a compiler-semantic correctness claim.
 */
import assert from 'node:assert/strict';
import { analyzeRepository } from '../orchestrator.js';

const moduleCount = Math.max(20, Math.min(500, Number(process.env.ANALYSIS_BENCH_MODULES) || 120));
const files = [];
for (let index = 0; index < moduleCount; index += 1) {
    const next = index + 1;
    const importsNext = next < moduleCount
        ? `import { fn${next} } from './module-${next}.js';\n`
        : '';
    const body = next < moduleCount
        ? `export function fn${index}() {\n  return fn${next}();\n}\n`
        : `export function fn${index}() {\n  return 'done';\n}\n`;
    files.push({ path: `src/module-${index}.ts`, content: `${importsNext}${body}` });
}

const repository = { name: `analysis-engine-scale-${moduleCount}`, source: 'local' };
const firstStarted = performance.now();
const first = await analyzeRepository(repository, files);
const firstMs = Math.round((performance.now() - firstStarted) * 100) / 100;

const expectedEdges = moduleCount - 1;
const matchingEdges = first.dependencies.filter((edge) => edge.resolution === 'resolved' && /^src\/module-\d+\.ts$/.test(edge.source) && /^src\/module-\d+\.ts$/.test(edge.target));
assert.equal(matchingEdges.length, expectedEdges, `Expected ${expectedEdges} resolved module dependencies, got ${matchingEdges.length}`);
assert.equal(first.analysisInput.discoveredFiles, moduleCount, 'All synthetic files should be represented in analysis input.');
assert.equal(first.callGraph.functionConnections.length, expectedEdges, 'Expected one resolved function call for every adjacent module pair.');
assert.equal(first.functionComplexity.analyzedFunctions, moduleCount, 'Function complexity should analyze every generated full source span.');

const secondStarted = performance.now();
const second = await analyzeRepository(repository, files);
const secondMs = Math.round((performance.now() - secondStarted) * 100) / 100;
assert.ok(second.analysisCache.extractionHits >= moduleCount - 1, 'Second run should hit extraction cache for nearly all files.');
assert.ok(second.analysisCache.complexityHits >= moduleCount - 1, 'Second run should hit complexity cache for nearly all files.');
assert.equal(second.dependencies.length, first.dependencies.length, 'Repeated analysis must not change dependency graph shape.');
assert.equal(second.callGraph.functionConnections.length, first.callGraph.functionConnections.length, 'Repeated analysis must not change call graph shape.');

// Content change must invalidate only the affected file cache and rebuild
// repository-wide edges from the new snapshot (no stale dependency/call edge).
const changedFiles = files.map((file) => file.path === 'src/module-0.ts'
    ? { ...file, content: "export function fn0() {\n  return 'changed';\n}\n" }
    : file);
const changed = await analyzeRepository(repository, changedFiles);
assert.ok(changed.analysisCache.extractionMisses >= 1, 'Changed content must miss the extraction cache.');
assert.ok(changed.analysisCache.complexityMisses >= 1, 'Changed content must miss the complexity cache.');
assert.equal(changed.dependencies.some((edge) => edge.source === 'src/module-0.ts'), false, 'Changed content must not retain stale dependency edges.');
assert.equal(changed.callGraph.functionConnections.some((edge) => edge.callerFile === 'src/module-0.ts'), false, 'Changed content must not retain stale call edges.');
assert.equal(changed.dependencies.filter((edge) => edge.resolution === 'resolved').length, expectedEdges - 1, 'Graph must be recomputed after one module loses its dependency.');
const removedPath = `src/module-${moduleCount - 1}.ts`;
const removed = await analyzeRepository(repository, changedFiles.filter((file) => file.path !== removedPath));
assert.equal(removed.analysisInput.discoveredFiles, moduleCount - 1, 'Removed files must disappear from the active repository snapshot.');
assert.equal(removed.dependencies.some((edge) => edge.target === removedPath), false, 'Removed files must not remain as stale dependency graph targets.');
assert.equal(removed.callGraph.functionConnections.some((edge) => edge.calleeFile === removedPath), false, 'Removed files must not remain as stale call graph targets.');

console.log(JSON.stringify({
    status: 'passed',
    benchmark: 'synthetic-scale-regression',
    moduleCount,
    expectedResolvedDependencies: expectedEdges,
    resolvedDependenciesObserved: matchingEdges.length,
    expectedFunctionCallEdges: expectedEdges,
    functionCallEdgesObserved: first.callGraph.functionConnections.length,
    functionComplexity: {
        analyzedFunctions: first.functionComplexity.analyzedFunctions,
        skippedFunctions: first.functionComplexity.skippedFunctions,
        coveragePct: first.functionComplexity.coveragePct,
        averageEstimatedComplexity: first.functionComplexity.averageEstimatedComplexity,
    },
    cacheHitsSecondRun: {
        extraction: second.analysisCache.extractionHits,
        complexity: second.analysisCache.complexityHits,
    },
    timingMs: { firstRun: firstMs, secondRun: secondMs },
    contentChangeInvalidation: { status: 'passed', extractionMisses: changed.analysisCache.extractionMisses, complexityMisses: changed.analysisCache.complexityMisses, resolvedDependenciesAfterChange: changed.dependencies.filter((edge) => edge.resolution === 'resolved').length },
    fileRemovalInvalidation: { status: 'passed', removedPath, activeFilesAfterRemoval: removed.analysisInput.discoveredFiles },
    coverageStatus: first.analysisCoverage?.status || 'unknown',
    limitations: [
        'Synthetic modules exercise repeatable graph depth and cache behavior, not framework-specific code or real repository distributions.',
        'Timing depends on the runtime environment and must not be treated as a performance guarantee.',
        'Resolved edges are checked against generated fixture semantics, not a language compiler or type checker.',
    ],
}, null, 2));
