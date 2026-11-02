import { ENGINE_VERSION } from '../engineVersion.js';
import { describe, expect, it } from 'vitest';
import { prepareRepositoryFiles } from '../repositoryInput.js';
import { createStableFindingId, deduplicateFindings, buildFindingActionPlan } from '../findingQuality.js';
import { analyzeDependencyUsage } from '../dependencyUsage.js';
import { compareFileSnapshots, buildIncrementalAnalysisPlan } from '../incrementalAnalysis.js';
import { buildAnalysisMetrics } from '../analysisMetrics.js';
import { normalizeFinding, validateAnalysisResult } from '../analysisContracts.js';
import { analyzeRepository } from '../orchestrator.js';
import { extractDependencyInventory } from '../dependencies.js';
import { evaluateFindingBenchmark, evaluateHealthScoreCalibration } from '../benchmarkMetrics.js';

describe('repository snapshot preparation', () => {
    it('filters default generated/vendor locations and records excluded files', () => {
        const result = prepareRepositoryFiles([
            { path: 'src/main.js', content: 'export const main = true;' },
            { path: 'node_modules/a/index.js', content: 'module.exports = 1;' },
            { path: 'dist/bundle.min.js', content: '(()=>{})()' },
        ]);
        expect(result.files.map((file) => file.path)).toEqual(['src/main.js']);
        expect(result.diagnostics.excludedFiles).toBe(2);
        expect(result.diagnostics.status).toBe('partial');
    });

    it('rejects traversal and duplicates before analysis', () => {
        expect(() => prepareRepositoryFiles([{ path: '../bad.js', content: '' }])).toThrow(/Unsafe repository-relative path/);
        expect(() => prepareRepositoryFiles([
            { path: 'src/a.js', content: 'a' }, { path: './src/a.js', content: 'b' },
        ])).toThrow(/Duplicate repository path/);
    });
});

describe('finding identity and report quality', () => {
    it('generates stable IDs independent of display order', () => {
        const finding = { ruleId: 'quality.large-file', title: 'Large file', file: 'src/a.js', line: 3, message: 'Review complexity' };
        expect(createStableFindingId(finding)).toBe(createStableFindingId({ ...finding, order: 99 }));
        expect(normalizeFinding(finding, 'quality', 0).id).toBe(normalizeFinding(finding, 'quality', 10).id);
    });

    it('merges exact duplicate findings and preserves duplicate count', () => {
        const finding = { ruleId: 'quality.large-file', title: 'Large file', file: 'src/a.js', line: 3, message: 'Review complexity', severity: 'medium' };
        const result = deduplicateFindings([finding, { ...finding }, { ...finding, line: 4 }]);
        expect(result.outputCount).toBe(2);
        expect(result.duplicateCount).toBe(1);
        expect(result.findings.find((item) => item.line === 3).duplicateCount).toBe(2);
    });

    it('produces conservative next steps rather than claiming automated fixes', () => {
        const actionPlan = buildFindingActionPlan([{ title: 'Unused function', category: 'architecture', severity: 'low' }]);
        expect(actionPlan.items[0].action).toContain('dynamic references');
        expect(actionPlan.semantics).toContain('not automated fixes');
    });
});

describe('dependency usage and snapshot diff', () => {
    it('flags only low-confidence no-static-import candidates and avoids JVM guesses', () => {
        const result = analyzeDependencyUsage([
            { path: 'src/main.js', content: "import React from 'react';" },
        ], { dependencies: [
            { name: 'react', ecosystem: 'npm', version: '^18' },
            { name: 'left-pad', ecosystem: 'npm', version: '^1' },
            { name: 'org.example:library', ecosystem: 'maven', version: '1.0' },
        ] });
        expect(result.staticUseDetected).toBe(1);
        expect(result.unusedCandidates).toBe(1);
        expect(result.notStaticallyMappable).toBe(1);
        expect(result.candidates[0].confidence).toBe('low');
    });

    it('classifies added, modified, removed and unchanged files', () => {
        const diff = compareFileSnapshots([
            { path: 'a.js', content: 'a' }, { path: 'b.js', content: 'b' }, { path: 'gone.js', content: 'gone' },
        ], [
            { path: 'a.js', content: 'a' }, { path: 'b.js', content: 'changed' }, { path: 'new.js', content: 'new' },
        ]);
        expect(diff.added).toEqual(['new.js']);
        expect(diff.modified).toEqual(['b.js']);
        expect(diff.removed).toEqual(['gone.js']);
        expect(diff.unchanged).toEqual(['a.js']);
    });

    it('makes clear that the change-impact planner is not an incremental executor', () => {
        const previous = { files: [{ path: 'src/service.js', content: 'one' }], dependencies: [] };
        const plan = buildIncrementalAnalysisPlan(previous, [{ path: 'src/service.js', content: 'two' }], []);
        expect(plan.available).toBe(true);
        expect(plan.incrementalExecutionImplemented).toBe(false);
    });
});


describe('health-score calibration evaluator', () => {
    it('keeps the score uncalibrated until a minimum set of reviewed labels is available', () => {
        const result = evaluateHealthScoreCalibration([
            { repository: 'repo-a', expectedHealthScore: 80, actualHealthScore: 70 },
        ]);
        expect(result).toMatchObject({ status: 'insufficient-reviewed-labels', sampleCount: 1, calibrated: false, scoreFormulaChanged: false, meanAbsoluteError: 10, signedBias: -10 });
    });
});

describe('manifest support and labelled benchmarking', () => {
    it('parses common Cargo, Composer, Poetry and PEP 621 manifests', () => {
        const inventory = extractDependencyInventory([
            { path: 'Cargo.toml', content: '[dependencies]\nserde = \"1.0\"\n[dev-dependencies]\ninsta = \"2\"' },
            { path: 'composer.json', content: JSON.stringify({ require: { 'vendor/lib': '^1' }, 'require-dev': { phpunit: '^10' } }) },
            { path: 'pyproject.toml', content: '[project]\nname = \"example\"\ndependencies = [\"fastapi>=0.1\", \"requests==2.3\"]\n[project.optional-dependencies]\ntest = [\"pytest>=8\"]' },
        ]);
        expect(inventory.dependencies.map((dep) => dep.name)).toEqual(expect.arrayContaining(['serde', 'insta', 'vendor/lib', 'phpunit', 'fastapi', 'requests', 'pytest']));
    });

    it('calculates precision, recall and F1 from manually labelled expected findings', () => {
        const evaluation = evaluateFindingBenchmark(
            [{ ruleId: 'r1', path: 'src/a.js', line: 4 }, { ruleId: 'r2', path: 'src/b.py', line: 8 }],
            [{ ruleId: 'r1', location: { path: 'src/a.js', startLine: 4 } }, { ruleId: 'r3', file: 'src/c.js', line: 2 }],
        );
        expect(evaluation).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 1, precision: 0.5, recall: 0.5, f1: 0.5 });
        expect(evaluation.limitations.some((item) => item.includes('True negatives'))).toBe(true);
    });
});

describe('output contract validation', () => {
    it('detects inconsistent file counts and missing arrays', () => {
        const validation = validateAnalysisResult({ engineVersion: '6.0.2', repository: {}, analysisInput: { discoveredFiles: 2 }, files: [{ path: 'src/a.js' }], functions: [], classes: [], findings: [], dependencies: [], analysisCoverage: { status: 'partial' } });
        expect(validation.status).toBe('invalid');
        expect(validation.errors.some((message) => message.includes('discoveredFiles'))).toBe(true);
        expect(validation.warnings.some((message) => message.includes('precision/recall'))).toBe(true);
    });
});

describe('integrated metrics and engine version', () => {
    it('builds observational quality metrics with explicit limitations', () => {
        const metrics = buildAnalysisMetrics({
            files: [{ path: 'src/a.js', content: 'function a() {}\n' }],
            functions: [{ name: 'a' }],
            findings: [{ title: 'Example', severity: 'low', category: 'quality', evidenceAvailable: true, location: { path: 'src/a.js', startLine: 1 } }],
            analysisCoverage: { status: 'partial', parserCoverage: { codeFiles: 1, astPreferredFiles: 0 } },
        });
        expect(metrics.findings.total).toBe(1);
        expect(metrics.analysisQuality.status).toBe('partial');
        expect(metrics.analysisQuality.caveats.length).toBeGreaterThan(0);
    });

    it('includes metrics, input exclusions, action plan, and the current version in repository output', async () => {
        const result = await analyzeRepository({ name: 'test', source: 'local' }, [
            { path: 'src/main.js', content: "import { run } from './service.js'; run();" },
            { path: 'src/service.js', content: 'export function run() { return true; }' },
            { path: 'node_modules/ignored/index.js', content: 'export const x = 1;' },
        ]);
        expect(result.engineVersion).toBe(ENGINE_VERSION);
        expect(result.analysisInput.suppliedFiles).toBe(3);
        expect(result.analysisInput.discoveredFiles).toBe(2);
        expect(result.analysisInput.excludedFiles).toBe(1);
        expect(result.analysisCoverage.status).toBe('partial');
        expect(result.analysisMetrics.repository.files).toBe(2);
        expect(result.outputContractValidation.status).toBe('valid');
        expect(result.architectureReport).toContain('Evidence Quality and Analysis Metrics');
    });
});
