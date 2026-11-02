/** usage: npm run analysis:system-labels -- /absolute/path/result.json /absolute/path/labels.json */
import { readFile } from 'node:fs/promises';
import { evaluateIntelligenceLabels } from '../intelligenceBenchmark.js';
const [resultPath,labelsPath] = process.argv.slice(2);
if (!resultPath || !labelsPath) {
    console.error('Usage: npm run analysis:system-labels -- <analysis-result.json> <manually-reviewed-labels.json>');
    process.exitCode = 2;
} else {
    const result = JSON.parse(await readFile(resultPath,'utf8'));
    const source = JSON.parse(await readFile(labelsPath,'utf8'));
    const labels = Array.isArray(source) ? source : source.labels;
    if (!Array.isArray(labels)) throw new Error('Label file must have an array named labels.');
    const evaluation = evaluateIntelligenceLabels(result,labels);
    console.log(JSON.stringify(evaluation,null,2));
    if (evaluation.status === 'not-labelled' || evaluation.diagnostics.length) process.exitCode = 1;
}
