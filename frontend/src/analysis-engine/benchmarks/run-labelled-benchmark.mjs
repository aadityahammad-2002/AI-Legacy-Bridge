import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeRepository } from '../orchestrator.js';
import { evaluateFindingBenchmark, evaluateHealthScoreCalibration } from '../benchmarkMetrics.js';
import { evaluateGraphEdges } from '../graphBenchmark.js';

const inputPath = process.argv[2];
if (!inputPath) {
    console.error('Usage: node analysis-engine/benchmarks/run-labelled-benchmark.mjs <ground-truth.json>');
    process.exitCode = 2;
} else {
    try {
        const absolutePath = resolve(inputPath);
        const parsed = JSON.parse(await readFile(absolutePath, 'utf8'));
        const repositories = Array.isArray(parsed.repositories) ? parsed.repositories : [parsed];
        const results = [];
        for (const item of repositories) {
            const files = Array.isArray(item.files) ? item.files : [];
            const analysis = await analyzeRepository({ name: item.name || item.repository?.name || 'labelled-benchmark', source: 'benchmark' }, files, null, item.analysisOptions || {});
            // Security rules remain present and unchanged in the engine, but this
            // improvement benchmark intentionally excludes them from progress metrics.
            const evaluationOptions = { excludeCategories: ['security'], ...(item.evaluationOptions || {}) };
            const evaluation = evaluateFindingBenchmark(item.expectedFindings || [], analysis.findings || [], evaluationOptions);
            results.push({
                repository: item.name || item.repository?.name || 'labelled-benchmark',
                engineVersion: analysis.engineVersion,
                actualHealthScore: analysis.healthScoreDetails?.score ?? null,
                actualHealthGrade: analysis.healthScoreDetails?.grade ?? null,
                expectedHealthScore: Number.isFinite(Number(item.expectedHealthScore)) ? Number(item.expectedHealthScore) : null,
                expectedHealthGrade: item.expectedHealthGrade || null,
                analysedFiles: analysis.analysisInput.discoveredFiles,
                coverageStatus: analysis.analysisCoverage.status,
                expectedFindingCount: evaluation.labelledExpectedCount,
                actualFindingCount: evaluation.actualFindingCount,
                excludedExpectedFindingCount: evaluation.excludedExpectedFindingCount,
                excludedActualFindingCount: evaluation.excludedActualFindingCount,
                evaluationPolicy: evaluation.evaluationPolicy,
                truePositives: evaluation.truePositives,
                falsePositives: evaluation.falsePositives,
                falseNegatives: evaluation.falseNegatives,
                precision: evaluation.precision,
                recall: evaluation.recall,
                f1: evaluation.f1,
                perRule: evaluation.perRule,
                dependencyEdgeEvaluation: evaluateGraphEdges(item.expectedDependencies || [], analysis.dependencies || []),
                callEdgeEvaluation: evaluateGraphEdges(item.expectedFunctionCalls || [], analysis.callGraph?.functionConnections || [], { kind: 'call' }),
                falsePositiveSamples: evaluation.falsePositiveSamples,
                falseNegativeSamples: evaluation.falseNegativeSamples,
                limitations: evaluation.limitations,
            });
        }
        const scoreCalibration = evaluateHealthScoreCalibration(repositories.filter((item) => item.expectedHealthScore != null).map((item) => {
            const result = results.find((entry) => entry.repository === (item.name || item.repository?.name || 'labelled-benchmark'));
            return { repository: result?.repository, expectedHealthScore: item.expectedHealthScore, actualHealthScore: result?.actualHealthScore, expectedGrade: item.expectedHealthGrade, actualGrade: result?.actualHealthGrade };
        }));
        console.log(JSON.stringify({ benchmark: 'manually-labelled-analysis-benchmark', sourceFile: absolutePath, scoreCalibration, results }, null, 2));
    } catch (error) {
        console.error(`Benchmark failed: ${String(error?.message || error)}`);
        process.exitCode = 1;
    }
}
