/** Compare one or more exported analysis JSON files; no source code required. */
import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { summarizeAnalysisExport, compareRepositoryRuns } from '../reportComparison.js';

const inputPaths = process.argv.slice(2);
if (!inputPaths.length) {
    console.error('Usage: node analysis-engine/benchmarks/compare-analysis-reports.mjs <report-1.json> [report-2.json ...]');
    process.exitCode = 2;
} else {
    try {
        const summaries = [];
        for (const inputPath of inputPaths) {
            const absolutePath = resolve(inputPath);
            const data = JSON.parse(await readFile(absolutePath, 'utf8'));
            summaries.push(summarizeAnalysisExport(data, basename(absolutePath)));
        }
        const repositoryComparisons = compareRepositoryRuns(summaries);
        console.log(JSON.stringify({
            report: 'analysis-engine-multi-repository-comparison',
            inputCount: summaries.length,
            repositoryCount: new Set(summaries.map((item) => item.repository)).size,
            summaries,
            repositoryComparisons,
            limitations: [
                'A finding-count change is not itself an accuracy improvement; findings can be missed, duplicated or false positives.',
                'Resolution/attribution metrics are comparable only when their definitions match across engine versions.',
                'Precision/recall require manually reviewed ground-truth labels; exports alone cannot establish them.',
                'Timing/memory are included only when present in the export; otherwise they must be measured by the runtime profile.',
            ],
        }, null, 2));
    } catch (error) {
        console.error(`Report comparison failed: ${String(error?.message || error)}`);
        process.exitCode = 1;
    }
}
