/** Normalize engine JSON exports for consistent, version-aware comparisons. */
function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function countBy(items, key) {
    const result = {};
    for (const item of items || []) {
        const value = String(item?.[key] || 'unknown').toLowerCase();
        result[value] = (result[value] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function round1(value) {
    return value == null ? null : Math.round(value * 10) / 10;
}

/** Accepts a regular engine result or the exported { repository, analysis } envelope. */
export function summarizeAnalysisExport(exported = {}, sourceFile = null) {
    const analysis = exported?.analysis && typeof exported.analysis === 'object' ? exported.analysis : exported;
    const repository = exported?.repository || analysis?.repository || {};
    const coverage = analysis?.analysisCoverage || {};
    const parser = coverage?.parserCoverage || {};
    const perLanguage = parser.byLanguage || {};
    const callCoverage = coverage?.callGraph || {};
    const callDiagnostics = analysis?.callGraph?.diagnostics || {};
    const findings = Array.isArray(analysis?.findings) ? analysis.findings : Array.isArray(analysis?.issues) ? analysis.issues : [];
    // Security analyzer findings are left intact in exports; show them separately
    // so non-security engine progress can be compared without blending scopes.
    const isSecurityFinding = (item) => {
        const category = String(item?.category || '').toLowerCase();
        const ruleId = String(item?.ruleId || '').toLowerCase();
        return category === 'security' || category.startsWith('security.') || ruleId.startsWith('security.');
    };
    const securityFindings = findings.filter(isSecurityFinding);
    const nonSecurityFindings = findings.filter((item) => !isSecurityFinding(item));
    const input = analysis?.analysisInput || {};
    const health = analysis?.healthScoreDetails || analysis?.healthScore || {};
    const metrics = analysis?.analysisMetrics || {};
    const findingMetrics = metrics?.findings || {};
    const byLanguage = Object.fromEntries(Object.entries(perLanguage).sort(([a], [b]) => a.localeCompare(b)).map(([language, stats]) => [language, {
        files: stats.files ?? stats.codeFiles ?? 0,
        astFiles: stats.astFiles ?? 0,
        heuristicFiles: stats.heuristicFiles ?? 0,
        astSharePct: stats.astSharePct ?? null,
    }]));
    const totalCallRefs = finite(callCoverage.totalCallNameReferences ?? callDiagnostics.totalCallNameReferences) ?? 0;
    const resolvedCallRefs = finite(callCoverage.resolvedCallNameReferences ?? callDiagnostics.resolvedCallNameReferences) ?? 0;
    const callSiteCount = finite(callCoverage.functionCallSiteCount ?? callDiagnostics.functionCallSiteCount);
    const unattributed = finite(callCoverage.unattributedFunctionCallSiteCount ?? callDiagnostics.unattributedFunctionCallSiteCount);
    const attributedCount = finite(callCoverage.attributedFunctionCallSiteCount) ?? (callSiteCount != null && unattributed != null ? Math.max(0, callSiteCount - unattributed) : null);
    const resolutionPct = finite(callCoverage.resolutionPct) ?? (totalCallRefs > 0 ? round1(resolvedCallRefs / totalCallRefs * 100) : null);
    const attributionPct = finite(callCoverage.attributionPct) ?? (callSiteCount > 0 && attributedCount != null ? round1(attributedCount / callSiteCount * 100) : null);
    const evidencePct = finite(findingMetrics.evidenceAvailablePct);
    return {
        sourceFile,
        repository: String(repository.name || analysis?.name || 'unknown-repository'),
        repositorySource: repository.source || null,
        exportedAt: exported?.exportedAt || null,
        engineVersion: analysis?.engineVersion || analysis?.analysisSnapshot?.engineVersion || null,
        snapshotId: analysis?.analysisSnapshot?.id || null,
        fileCount: finite(input.discoveredFiles ?? analysis?.analysisSnapshot?.fileCount ?? analysis?.files?.length),
        codeFileCount: finite(input.codeFiles),
        findingCount: findings.length,
        findingCategories: countBy(findings, 'category'),
        findingSeverities: countBy(findings, 'severity'),
        securityFindingCount: securityFindings.length,
        nonSecurityFindingCount: nonSecurityFindings.length,
        securityFindingCategories: countBy(securityFindings, 'category'),
        nonSecurityFindingCategories: countBy(nonSecurityFindings, 'category'),
        nonSecurityFindingSeverities: countBy(nonSecurityFindings, 'severity'),
        apiContractMismatchCount: findings.filter((item) => String(item?.ruleId || '').toLowerCase() === 'api-contract.route-mismatch').length,
        healthScore: finite(health.score ?? analysis?.healthScoreDetails?.score),
        healthGrade: health.grade || null,
        coverageStatus: coverage.status || null,
        astFileCount: finite(parser.astPreferredFiles) ?? Object.values(perLanguage).reduce((sum, item) => sum + (Number(item.astFiles) || 0), 0),
        heuristicFileCount: finite(parser.heuristicParserFiles) ?? Object.values(perLanguage).reduce((sum, item) => sum + (Number(item.heuristicFiles) || 0), 0),
        parserAstSharePct: finite(metrics.analysisQuality?.astSharePct) ?? (input.codeFiles ? round1(((finite(parser.astPreferredFiles) || 0) / input.codeFiles) * 100) : null),
        parserByLanguage: byLanguage,
        callGraph: {
            totalCallNameReferences: totalCallRefs,
            resolvedCallNameReferences: resolvedCallRefs,
            resolutionPct,
            unresolvedCallCount: finite(callCoverage.unresolvedCallCount ?? callDiagnostics.unresolvedCallCount) ?? 0,
            projectUnresolvedCallCount: finite(callCoverage.projectUnresolvedCallCount) ?? Math.max(0, (finite(callCoverage.unresolvedCallCount ?? callDiagnostics.unresolvedCallCount) ?? 0) - (finite(callCoverage.externalLikelyReceiverCallCount ?? callDiagnostics.externalLikelyReceiverCallCount) ?? 0)),
            externalLikelyReceiverCallCount: finite(callCoverage.externalLikelyReceiverCallCount ?? callDiagnostics.externalLikelyReceiverCallCount) ?? 0,
            projectUnknownReceiverCallCount: finite(callCoverage.projectUnknownReceiverCallCount ?? callDiagnostics.projectUnknownReceiverCallCount) ?? 0,
            ambiguousCallCount: finite(callCoverage.ambiguousCallCount ?? callDiagnostics.ambiguousCallCount) ?? 0,
            functionCallSiteCount: callSiteCount,
            attributedFunctionCallSiteCount: attributedCount,
            unattributedFunctionCallSiteCount: unattributed,
            attributionPct,
            overallAttributionPct: finite(callCoverage.overallAttributionPct) ?? (callSiteCount > 0 && attributedCount != null ? round1(attributedCount / callSiteCount * 100) : null),
            locatedFunctionCallSiteCount: finite(callCoverage.locatedFunctionCallSiteCount ?? callDiagnostics.locatedFunctionCallSiteCount),
            callSiteEvidenceMissingCount: finite(callCoverage.callSiteEvidenceMissingCount ?? callDiagnostics.callSiteEvidenceMissingCount),
            unresolvedUnattributedCallSiteCount: finite(callCoverage.unresolvedUnattributedCallSiteCount ?? callDiagnostics.unresolvedUnattributedCallSiteCount),
        },
        findingEvidencePct: evidencePct,
        exactDuplicateCount: finite(analysis?.findingDeduplication?.duplicateCount),
        performance: analysis?.performanceMetrics || analysis?.analysisMetrics?.performance || null,
    };
}

function delta(current, previous, key) {
    const a = current?.[key];
    const b = previous?.[key];
    return Number.isFinite(a) && Number.isFinite(b) ? round1(a - b) : null;
}

export function compareRepositoryRuns(summaries = []) {
    const groups = new Map();
    for (const summary of summaries) {
        const name = summary.repository || 'unknown-repository';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(summary);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([repository, rawRuns]) => {
        const runs = [...rawRuns].sort((a, b) => String(a.exportedAt || '').localeCompare(String(b.exportedAt || '')));
        const first = runs[0];
        const latest = runs[runs.length - 1];
        const categoryNames = [...new Set(runs.flatMap((run) => Object.keys(run.findingCategories || {})))].sort();
        const nonSecurityCategoryNames = [...new Set(runs.flatMap((run) => Object.keys(run.nonSecurityFindingCategories || {})))].sort();
        const severityNames = [...new Set(runs.flatMap((run) => Object.keys(run.findingSeverities || {})))].sort();
        return {
            repository,
            runCount: runs.length,
            baselineVersion: first.engineVersion,
            latestVersion: latest.engineVersion,
            baselineSnapshotId: first.snapshotId,
            latestSnapshotId: latest.snapshotId,
            deltas: {
                fileCount: delta(latest, first, 'fileCount'),
                findingCount: delta(latest, first, 'findingCount'),
                nonSecurityFindingCount: delta(latest, first, 'nonSecurityFindingCount'),
                securityFindingCount: delta(latest, first, 'securityFindingCount'),
                healthScore: delta(latest, first, 'healthScore'),
                astFileCount: delta(latest, first, 'astFileCount'),
                heuristicFileCount: delta(latest, first, 'heuristicFileCount'),
                apiContractMismatchCount: delta(latest, first, 'apiContractMismatchCount'),
                callGraphResolutionPct: delta(latest.callGraph, first.callGraph, 'resolutionPct'),
                callGraphAttributionPct: delta(latest.callGraph, first.callGraph, 'attributionPct'),
                callGraphOverallAttributionPct: delta(latest.callGraph, first.callGraph, 'overallAttributionPct'),
                projectUnresolvedCallCount: delta(latest.callGraph, first.callGraph, 'projectUnresolvedCallCount'),
                externalLikelyReceiverCallCount: delta(latest.callGraph, first.callGraph, 'externalLikelyReceiverCallCount'),
                unattributedCallSiteCount: delta(latest.callGraph, first.callGraph, 'unattributedFunctionCallSiteCount'),
            },
            findingCategoryDeltas: Object.fromEntries(categoryNames.map((name) => [name, (latest.findingCategories[name] || 0) - (first.findingCategories[name] || 0)])),
            nonSecurityFindingCategoryDeltas: Object.fromEntries(nonSecurityCategoryNames.map((name) => [name, (latest.nonSecurityFindingCategories[name] || 0) - (first.nonSecurityFindingCategories[name] || 0)])),
            findingSeverityDeltas: Object.fromEntries(severityNames.map((name) => [name, (latest.findingSeverities[name] || 0) - (first.findingSeverities[name] || 0)])),
            runs,
        };
    });
}
