import assert from 'node:assert/strict';
import { summarizeAnalysisExport, compareRepositoryRuns } from '../reportComparison.js';

const oldRun = summarizeAnalysisExport({
    exportedAt: '2026-10-13T00:00:00.000Z', repository: { name: 'demo' }, analysis: {
        engineVersion: '6.0.0', analysisSnapshot: { id: 'old', fileCount: 10 },
        analysisInput: { discoveredFiles: 10, codeFiles: 8 },
        analysisCoverage: { status: 'partial', parserCoverage: { astPreferredFiles: 4, heuristicParserFiles: 4 }, callGraph: { totalCallNameReferences: 100, resolvedCallNameReferences: 80, resolutionPct: 80, functionCallSiteCount: 50, unattributedFunctionCallSiteCount: 20, attributionPct: 60 } },
        healthScore: { score: 70, grade: 'C' }, findings: [{ category: 'security', severity: 'high' }, { category: 'quality', severity: 'low' }],
    },
});
const newRun = summarizeAnalysisExport({
    exportedAt: '2026-10-14T00:00:00.000Z', repository: { name: 'demo' }, analysis: {
        engineVersion: '6.0.3', analysisSnapshot: { id: 'new', fileCount: 10 },
        analysisInput: { discoveredFiles: 10, codeFiles: 8 },
        analysisCoverage: { status: 'partial', parserCoverage: { astPreferredFiles: 6, heuristicParserFiles: 2 }, callGraph: { totalCallNameReferences: 100, resolvedCallNameReferences: 90, resolutionPct: 90, functionCallSiteCount: 40, unattributedFunctionCallSiteCount: 4, attributionPct: 90 } },
        healthScore: { score: 75, grade: 'B' }, findings: [{ category: 'security', severity: 'high' }, { category: 'api', severity: 'medium', ruleId: 'api-contract.route-mismatch' }],
    },
});
const comparison = compareRepositoryRuns([newRun, oldRun]);
assert.equal(comparison.length, 1);
assert.equal(comparison[0].baselineVersion, '6.0.0');
assert.equal(comparison[0].latestVersion, '6.0.3');
assert.equal(comparison[0].deltas.findingCount, 0);
assert.equal(comparison[0].deltas.nonSecurityFindingCount, 0);
assert.equal(comparison[0].deltas.securityFindingCount, 0);
assert.equal(oldRun.securityFindingCount, 1);
assert.equal(oldRun.nonSecurityFindingCount, 1);
assert.equal(newRun.securityFindingCount, 1);
assert.equal(newRun.nonSecurityFindingCount, 1);
assert.equal(comparison[0].deltas.callGraphResolutionPct, 10);
assert.equal(comparison[0].deltas.callGraphAttributionPct, 30);
assert.equal(comparison[0].deltas.astFileCount, 2);
assert.equal(newRun.apiContractMismatchCount, 1);
console.log(JSON.stringify({ suite: 'report-comparison-regression', status: 'passed', comparison: comparison[0].deltas }, null, 2));
