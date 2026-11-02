/**
 * Dogfood the engine against its own JavaScript source.
 * Run from frontend/: node src/analysis-engine/benchmarks/run-self-analysis.mjs
 * This is an integration smoke test, not a ground-truth accuracy benchmark.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '../orchestrator.js';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (['__tests__', 'benchmarks'].includes(entry.name)) continue;
            found.push(...await walk(fullPath));
        } else if (/\.(?:js|mjs|cjs)$/i.test(entry.name)) {
            found.push(fullPath);
        }
    }
    return found.sort();
}

const paths = await walk(engineRoot);
assert.ok(paths.length >= 10, `Expected to find a substantive set of engine modules, found ${paths.length}.`);
const files = await Promise.all(paths.map(async (fullPath) => ({
    path: path.relative(engineRoot, fullPath).split(path.sep).join('/'),
    content: await readFile(fullPath, 'utf8'),
})));
const started = performance.now();
const result = await analyzeRepository({ name: 'analysis-engine-self-analysis', source: 'local' }, files);
const durationMs = Math.round((performance.now() - started) * 100) / 100;
assert.equal(result.analysisInput.discoveredFiles, files.length, 'Every selected engine source file should be counted.');
assert.ok(result.functions.length > 0, 'Self-analysis should extract functions from the engine code.');
assert.ok(result.analysisCoverage?.dependencyResolution, 'Self-analysis should report dependency resolution coverage.');
assert.ok(result.functionComplexity?.analyzedFunctions > 0, 'Self-analysis should produce function-level complexity estimates.');
assert.ok(result.dependencies.every((edge) => edge.source && edge.target && edge.resolution), 'Every dependency edge should have source, target and resolution status.');

console.log(JSON.stringify({
    status: 'passed',
    benchmark: 'analysis-engine-self-analysis',
    sourceFiles: files.length,
    extractedFunctions: result.functions.length,
    extractedClasses: result.classes.length,
    dependencyEdges: result.dependencies.length,
    resolvedEdges: result.dependencies.filter((edge) => edge.resolution === 'resolved').length,
    unresolvedLocalImports: result.analysisCoverage.dependencyResolution.unresolvedLocalImports.length,
    ambiguousImports: result.analysisCoverage.dependencyResolution.ambiguousImports.length,
    functionComplexity: {
        analyzedFunctions: result.functionComplexity.analyzedFunctions,
        skippedFunctions: result.functionComplexity.skippedFunctions,
        highComplexityCount: result.functionComplexity.highComplexityCount,
    },
    analysisCoverageStatus: result.analysisCoverage.status,
    durationMs,
    limitations: [
        'Dogfooding against the engine source checks integration and invariants, not exact semantic correctness.',
        'An unresolved or ambiguous dependency may be intentional (e.g. runtime/dynamic imports) and requires review.',
        'The self-analysis result should be compared across releases; counts alone do not establish quality.',
    ],
}, null, 2));
