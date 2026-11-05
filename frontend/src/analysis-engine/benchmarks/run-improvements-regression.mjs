import { ENGINE_VERSION } from '../engineVersion.js';
import assert from 'node:assert/strict';
import { prepareRepositoryFiles } from '../repositoryInput.js';
import { createStableFindingId, deduplicateFindings } from '../findingQuality.js';
import { analyzeDependencyUsage } from '../dependencyUsage.js';
import { compareFileSnapshots, buildIncrementalAnalysisPlan } from '../incrementalAnalysis.js';
import { analyzeRepository } from '../orchestrator.js';
import { evaluateFindingBenchmark } from '../benchmarkMetrics.js';
import { extractDependencyInventory } from '../dependencies.js';
import { checkNamingConventions } from '../quality.js';
import { analyzeApiContracts, discoverEndpoints } from '../api.js';

const namingRegression = checkNamingConventions([
    { name: 'AppLayout', file: 'frontend/src/AppLayout.jsx', line: 1, code: 'function AppLayout() { return <div />; }', type: 'function' },
    { name: 'PerformancePage', file: 'frontend/src/PerformancePage.jsx', line: 1, code: 'const PerformancePage = () => <div />;', type: 'arrow' },
    { name: 'RoleSeed', file: 'backend/RoleSeed.java', line: 1, code: 'record RoleSeed(String name) {}', type: 'function' },
    { name: 'BadRequestException', file: 'backend/BadRequestException.java', line: 2, code: 'public BadRequestException(String message) { super(message); }', type: 'method', className: 'BadRequestException' },
    { name: 'Bad_Name', file: 'backend/example.py', line: 4, code: 'def Bad_Name(): pass', type: 'function' },
]);
assert.deepEqual(namingRegression.map((finding) => finding.name), ['Bad_Name']);

const apiFixtureFiles = [
    { path: 'backend/AttendanceController.java', content: '@RestController\n@RequestMapping("/api/attendance")\nclass AttendanceController {\n  @PostMapping("/api/attendance/check-in")\n  void checkIn() {}\n}' },
    { path: 'frontend/src/api.ts', content: "await fetch('/api/attendance/check-in', { method: 'POST' });" },
];
const apiContractRegression = analyzeApiContracts(apiFixtureFiles, discoverEndpoints(apiFixtureFiles));
assert.equal(apiContractRegression.mismatchCount, 1);
assert.equal(apiContractRegression.findings[0].ruleId, 'api-contract.route-mismatch');

// API route and client-call extraction must ignore comments and test/fixture code,
// while preserving actual production routes and source line numbers.
const apiNoiseFiles = [
    { path: 'backend/RealController.java', content: '// @GetMapping("/api/commented")\n/* @PostMapping("/api/also-commented") */\n@RestController\nclass RealController {\n  @GetMapping("/api/real")\n  void real() {}\n}' },
    { path: 'frontend/src/client.ts', content: `// fetch('/api/commented-client')\nawait fetch('/api/live-client');` },
    { path: 'frontend/src/client.test.ts', content: `await fetch('/api/test-only');` },
    { path: 'backend/src/test/java/ControllerTest.java', content: '@GetMapping("/api/test-route")\nclass ControllerTest {}' },
];
const discoveredNoiseRoutes = discoverEndpoints(apiNoiseFiles);
const noiseContracts = analyzeApiContracts(apiNoiseFiles, discoveredNoiseRoutes);
assert.deepEqual(discoveredNoiseRoutes.map((route) => route.path), ['/api/real']);
// With backend-route context, an unrelated /api URL is no longer
// accepted solely for having an API-looking prefix.
assert.equal(noiseContracts.clientCalls, 0);
assert.equal(noiseContracts.unknownCalls, 0);

const prepared = prepareRepositoryFiles([
    { path: 'src/main.js', content: "import React from 'react';\nimport { run } from './service.js';\nrun();" },
    { path: 'src/service.js', content: 'export function run() { return 1; }' },
    { path: 'node_modules/pkg/index.js', content: 'export const generated = true;' },
    { path: 'dist/app.min.js', content: '(()=>{})();' },
    { path: 'assets/image.bin', content: 'A\0B' },
]);
assert.deepEqual(prepared.files.map((file) => file.path), ['src/main.js', 'src/service.js']);
assert.equal(prepared.diagnostics.excludedFiles, 3);
assert.equal(prepared.diagnostics.status, 'partial');

const findingA = { ruleId: 'quality.large-file', category: 'quality', title: 'Large File', file: 'src/main.js', line: 2, severity: 'medium', message: 'Too many responsibilities' };
const findingB = { ...findingA };
assert.equal(createStableFindingId(findingA), createStableFindingId({ ...findingA, unrelatedIndex: 999 }));
const dedupe = deduplicateFindings([{ ...findingA, id: createStableFindingId(findingA) }, { ...findingB, id: createStableFindingId(findingB) }]);
assert.equal(dedupe.inputCount, 2);
assert.equal(dedupe.outputCount, 1);
assert.equal(dedupe.duplicateCount, 1);
assert.equal(dedupe.findings[0].duplicateCount, 2);

const inventory = { dependencies: [
    { name: 'react', version: '^18', ecosystem: 'npm', manifestFile: 'package.json' },
    { name: 'left-pad', version: '^1', ecosystem: 'npm', manifestFile: 'package.json' },
    { name: 'org.example:some-library', version: '1.0', ecosystem: 'maven', manifestFile: 'pom.xml' },
] };
const usage = analyzeDependencyUsage(prepared.files, inventory);
assert.equal(usage.staticUseDetected, 1);
assert.equal(usage.unusedCandidates, 1);
assert.equal(usage.notStaticallyMappable, 1);
assert.equal(usage.candidates[0].name, 'left-pad');

const inventoryWithMoreManifests = extractDependencyInventory([
    { path: 'pyproject.toml', content: '[project]\nname = \"fixture\"\ndependencies = [\"fastapi>=0.1\"]\n' },
    { path: 'Cargo.toml', content: '[dependencies]\nserde = \"1.0\"' },
    { path: 'composer.json', content: JSON.stringify({ require: { 'vendor/lib': '^1' } }) },
]);
assert.deepEqual(inventoryWithMoreManifests.dependencies.map((item) => item.name), ['fastapi', 'serde', 'vendor/lib']);
const evaluation = evaluateFindingBenchmark(
    [{ ruleId: 'r1', path: 'src/a.js', line: 2 }, { ruleId: 'r2', path: 'src/b.py', line: 4 }],
    [{ ruleId: 'r1', file: 'src/a.js', line: 2 }, { ruleId: 'r3', file: 'src/c.js', line: 8 }],
);
assert.deepEqual({ tp: evaluation.truePositives, fp: evaluation.falsePositives, fn: evaluation.falseNegatives, precision: evaluation.precision, recall: evaluation.recall, f1: evaluation.f1 }, { tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5, f1: 0.5 });
const scopedEvaluation = evaluateFindingBenchmark(
    [{ ruleId: 'api-contract.route-mismatch', category: 'api-contract', path: 'src/a.js', line: 2 }, { ruleId: 'security.secret', category: 'security', path: 'src/s.js', line: 1 }],
    [{ ruleId: 'api-contract.route-mismatch', category: 'api-contract', path: 'src/a.js', line: 2 }, { ruleId: 'security.secret', category: 'security', path: 'src/s.js', line: 1 }, { ruleId: 'quality.naming', category: 'quality', path: 'src/q.js', line: 3 }],
    { includeCategories: ['api-contract'], excludeCategories: ['security'] },
);
assert.equal(scopedEvaluation.truePositives, 1);
assert.equal(scopedEvaluation.falsePositives, 0);
assert.equal(scopedEvaluation.falseNegatives, 0);
assert.equal(scopedEvaluation.excludedActualFindingCount, 2);

const previousFiles = [
    { path: 'src/main.js', content: "import { run } from './service.js'; run();" },
    { path: 'src/service.js', content: 'export function run() { return 1; }' },
    { path: 'src/old.js', content: 'export const old = true;' },
];
const currentFiles = [
    { path: 'src/main.js', content: "import { run } from './service.js'; run();" },
    { path: 'src/service.js', content: 'export function run() { return 2; }' },
    { path: 'src/new.js', content: 'export const next = true;' },
];
const diff = compareFileSnapshots(previousFiles, currentFiles);
assert.deepEqual(diff.added, ['src/new.js']);
assert.deepEqual(diff.modified, ['src/service.js']);
assert.deepEqual(diff.removed, ['src/old.js']);
assert.deepEqual(diff.unchanged, ['src/main.js']);
const plan = buildIncrementalAnalysisPlan({
    files: previousFiles,
    dependencies: [{ source: 'src/main.js', target: 'src/service.js', type: 'import', resolution: 'resolved' }],
}, currentFiles, [{ source: 'src/main.js', target: 'src/service.js', type: 'import', resolution: 'resolved' }]);
assert.equal(plan.available, true);
assert.equal(plan.incrementalExecutionImplemented, false);
assert(plan.potentiallyImpactedFiles.includes('src/main.js'));

const result = await analyzeRepository({ name: 'improvement-fixture', source: 'local' }, [
    { path: 'package.json', content: JSON.stringify({ dependencies: { react: '^18.0.0', 'left-pad': '^1.0.0' } }) },
    { path: 'src/main.js', content: "import React from 'react';\nimport { run } from './service.js';\nrun();" },
    { path: 'src/service.js', content: 'export function run() { return 1; }' },
    { path: 'node_modules/pkg/index.js', content: 'export const ignored = true;' },
], { maxFiles: 50 });
assert.equal(result.engineVersion, ENGINE_VERSION);
assert.equal(result.analysisInput.suppliedFiles, 4);
assert.equal(result.analysisInput.discoveredFiles, 3);
assert.equal(result.analysisInput.excludedFiles, 1);
assert(result.analysisMetrics);
assert(result.analysisMetrics.repository.files > 0);
assert(result.analysisMetrics.analysisQuality);
assert(result.dependencyUsage);
assert(result.findingDeduplication);
assert(result.architectureReport.includes('Evidence Quality and Analysis Metrics'));
assert(result.analysisCoverage.inputPreparation);
assert.equal(result.outputContractValidation.status, 'valid');
assert.equal(result.outputContractValidation.errors.length, 0);

console.log(JSON.stringify({
    status: 'passed', benchmark: 'analysis-engine-improvements-regression',
    ingestion: { includedFiles: prepared.files.length, excludedFiles: prepared.diagnostics.excludedFiles },
    findingDeduplication: { input: dedupe.inputCount, output: dedupe.outputCount },
    dependencyUsage: { staticallyUsed: usage.staticUseDetected, unusedCandidates: usage.unusedCandidates, notMappable: usage.notStaticallyMappable },
    extraManifestParsers: inventoryWithMoreManifests.totalCount,
    labelledBenchmark: { precision: evaluation.precision, recall: evaluation.recall, f1: evaluation.f1 },
    snapshotDiff: diff.counts,
    incrementalExecutionClaimed: plan.incrementalExecutionImplemented,
    integratedEngineVersion: result.engineVersion,
    reportIncludesMetrics: result.architectureReport.includes('Evidence Quality and Analysis Metrics'),
    outputContractValidation: result.outputContractValidation.status,
    namingFalsePositiveRegression: { supplied: 5, findings: namingRegression.length, expectedFindings: 1 },
    apiContractRegression: { clientCalls: apiContractRegression.clientCalls, mismatchCount: apiContractRegression.mismatchCount, ruleId: apiContractRegression.findings[0].ruleId },
    apiNoiseRegression: { productionRoutes: discoveredNoiseRoutes.length, productionClientCalls: noiseContracts.clientCalls, unknownCalls: noiseContracts.unknownCalls, testAndCommentCallsExcluded: true },
    scopedBenchmark: { precision: scopedEvaluation.precision, recall: scopedEvaluation.recall, excludedActualFindings: scopedEvaluation.excludedActualFindingCount },
}, null, 2));
