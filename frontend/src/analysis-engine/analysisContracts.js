import { createStableFindingId } from './findingQuality.js';

/**
 * Stable contracts for analysis diagnostics.
 *
 * Important distinction: a stage being "complete" means its implementation
 * ran to completion. It does not claim that every language construct was
 * semantically understood. Parser-specific coverage should be reported
 * separately as those parsers expose more detailed diagnostics.
 */

const STATUS_VALUES = new Set(['complete', 'partial', 'failed', 'skipped', 'unsupported', 'unknown']);

export function normalizeStageStatus(value) {
    if (typeof value === 'string') {
        return { status: STATUS_VALUES.has(value) ? value : 'unknown' };
    }
    const status = value?.status;
    return {
        ...(value && typeof value === 'object' ? value : {}),
        status: STATUS_VALUES.has(status) ? status : 'unknown',
    };
}

/** Build honest repository-level coverage without treating a failed scan as clean. */
export function buildAnalysisCoverage({ files = [], fileStatuses = [], stageStatuses = {} } = {}) {
    const byPath = new Map(fileStatuses.map((item) => [item.path, item]));
    const perFile = files.map((file) => {
        const state = byPath.get(file.path) || {};
        return {
            path: file.path,
            language: state.language || 'unknown',
            parserStrategy: state.parserStrategy || 'unknown',
            extraction: normalizeStageStatus(state.extraction || 'unknown'),
            complexity: normalizeStageStatus(state.complexity || 'unknown'),
            errors: Array.isArray(state.errors) ? state.errors : [],
        };
    });

    const stages = Object.fromEntries(
        Object.entries(stageStatuses).map(([name, value]) => [name, normalizeStageStatus(value)])
    );
    const failedFiles = perFile.filter((file) =>
        file.extraction.status === 'failed' || file.complexity.status === 'failed'
    ).length;
    const failedStages = Object.values(stages).filter((stage) => stage.status === 'failed').length;
    const unsupportedStages = Object.values(stages).filter((stage) => stage.status === 'unsupported').length;
    const unsupportedFiles = perFile.filter((file) => file.extraction.status === 'unsupported').length;
    const skippedStages = Object.values(stages).filter((stage) => stage.status === 'skipped').length;
    const partialStages = Object.values(stages).filter((stage) => stage.status === 'partial').length;
    const unknownStages = Object.values(stages).filter((stage) => stage.status === 'unknown').length;
    const codeFiles = perFile.filter((file) => file.parserStrategy !== 'not-code');
    const heuristicParserFiles = codeFiles.filter((file) => !['ast', 'tree-sitter-ast', 'unknown'].includes(file.parserStrategy)).length;
    const astPreferredFiles = codeFiles.filter((file) => ['ast', 'tree-sitter-ast'].includes(file.parserStrategy)).length;
    const unknownParserFiles = codeFiles.filter((file) => file.parserStrategy === 'unknown').length;
    const skippedNonCodeFiles = perFile.filter((file) => file.parserStrategy === 'not-code').length;
    const parserStrategies = {};
    for (const file of codeFiles) parserStrategies[file.parserStrategy] = (parserStrategies[file.parserStrategy] || 0) + 1;
    const byLanguage = {};
    for (const file of perFile) {
        const language = file.language || 'unknown';
        const current = byLanguage[language] || {
            files: 0, codeFiles: 0, nonCodeFilesSkipped: 0,
            extractionCompleted: 0, extractionFailed: 0, extractionUnknown: 0,
            astFiles: 0, heuristicFiles: 0, unknownParserFiles: 0,
            complexityCompleted: 0, complexityFailed: 0, complexitySkipped: 0,
        };
        current.files += 1;
        if (file.parserStrategy === 'not-code') current.nonCodeFilesSkipped += 1;
        else {
            current.codeFiles += 1;
            if (['ast', 'tree-sitter-ast'].includes(file.parserStrategy)) current.astFiles += 1;
            else if (!['unknown', 'not-code'].includes(file.parserStrategy)) current.heuristicFiles += 1;
            else current.unknownParserFiles += 1;
        }
        if (file.extraction.status === 'complete') current.extractionCompleted += 1;
        else if (file.extraction.status === 'failed') current.extractionFailed += 1;
        else if (file.extraction.status === 'unknown') current.extractionUnknown += 1;
        if (file.complexity.status === 'complete') current.complexityCompleted += 1;
        else if (file.complexity.status === 'failed') current.complexityFailed += 1;
        else if (file.complexity.status === 'skipped') current.complexitySkipped += 1;
        byLanguage[language] = current;
    }
    Object.values(byLanguage).forEach((item) => {
        item.extractionCompletionPct = item.codeFiles ? Math.round(item.extractionCompleted / item.codeFiles * 1000) / 10 : null;
        item.astSharePct = item.codeFiles ? Math.round(item.astFiles / item.codeFiles * 1000) / 10 : null;
    });
    const incomplete = failedFiles > 0 || failedStages > 0 || unsupportedFiles > 0 || unsupportedStages > 0 || partialStages > 0 || skippedStages > 0 || unknownStages > 0 ||
        heuristicParserFiles > 0 || unknownParserFiles > 0 ||
        perFile.some((file) => file.extraction.status === 'unknown' || file.complexity.status === 'unknown');
    const statusReasons = [];
    if (failedFiles) statusReasons.push(`${failedFiles} file(s) failed extraction or complexity analysis.`);
    if (failedStages) statusReasons.push(`${failedStages} analysis stage(s) failed.`);
    if (heuristicParserFiles) statusReasons.push(`${heuristicParserFiles} code file(s) use heuristic/regex extraction rather than AST extraction.`);
    if (unknownParserFiles) statusReasons.push(`${unknownParserFiles} code file(s) have unknown parser strategy.`);
    if (unsupportedFiles || unsupportedStages) statusReasons.push('Some files or stages are unsupported.');
    if (unknownStages) statusReasons.push(`${unknownStages} analysis stage(s) have unknown status.`);
    if (skippedStages) statusReasons.push(`${skippedStages} analysis stage(s) were skipped.`);
    if (partialStages) statusReasons.push(`${partialStages} analysis stage(s) completed with partial coverage.`);

    return {
        schemaVersion: 1,
        status: incomplete ? 'partial' : 'complete',
        semantics: 'Stage completion means the pass ran; parser strategy and unresolved references are reported separately. Heuristic parsing is not equivalent to compiler-grade semantic analysis.',
        statusReasons,
        parserCoverage: {
            codeFiles: codeFiles.length,
            parserStrategies,
            byLanguage,
            heuristicParserFiles,
            astPreferredFiles,
            unknownParserFiles,
            nonCodeFilesSkipped: skippedNonCodeFiles,
        },
        files: {
            discovered: files.length,
            codeFiles: codeFiles.length,
            nonCodeFilesSkipped: skippedNonCodeFiles,
            extractionCompleted: perFile.filter((file) => file.extraction.status === 'complete').length,
            extractionFailed: perFile.filter((file) => file.extraction.status === 'failed').length,
            complexityCompleted: perFile.filter((file) => file.complexity.status === 'complete').length,
            complexityFailed: perFile.filter((file) => file.complexity.status === 'failed').length,
        },
        stages,
        failedStages,
        unsupportedStages,
        unsupportedFiles,
        skippedStages,
        partialStages,
        failedFiles,
        perFile,
    };
}

function slug(value) {
    return String(value || 'finding')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'finding';
}

/** Standard additive finding shape. Existing fields are preserved for UI compatibility. */
export function normalizeFinding(finding = {}, category = 'quality', index = 0, sourceFiles = []) {
    const file = finding.location?.path || finding.path || finding.file || finding.filePath || finding.filename || null;
    const rawStartLine = finding.location?.startLine ?? finding.startLine ?? finding.line ?? finding.lineNumber;
    const rawEndLine = finding.location?.endLine ?? finding.endLine ?? finding.line ?? finding.lineNumber;
    const startLine = Number.isInteger(rawStartLine) ? rawStartLine : null;
    const endLine = Number.isInteger(rawEndLine) ? rawEndLine : startLine;
    const confidence = finding.confidence || 'INFERENCE';
    let evidence = Array.isArray(finding.evidence) ? [...finding.evidence]
        : finding.evidence ? [finding.evidence] : [];

    // Attach an actual source excerpt only when we have an unambiguous file
    // and line. Never fabricate evidence from a filename-only heuristic.
    if (evidence.length === 0 && file && startLine !== null && startLine > 0) {
        const exactMatches = sourceFiles.filter((item) => item.path === file);
        const basename = String(file).split('/').pop();
        const basenameMatches = exactMatches.length ? exactMatches
            : sourceFiles.filter((item) => String(item.path).split('/').pop() === basename);
        const sourceFile = basenameMatches.length === 1 ? basenameMatches[0] : null;
        if (sourceFile && typeof sourceFile.content === 'string') {
            const lines = sourceFile.content.split('\n');
            const excerpt = lines[startLine - 1];
            if (typeof excerpt === 'string') {
                evidence.push({
                    type: 'source-line',
                    path: sourceFile.path,
                    startLine,
                    endLine: endLine ?? startLine,
                    excerpt: excerpt.slice(0, 500),
                });
            }
        }
    }

    const location = finding.location || (file ? { path: file, startLine, endLine } : null);
    const ruleId = finding.ruleId || `${slug(category)}.${slug(finding.title || finding.name || finding.type)}`;
    const identityInput = { ...finding, ruleId, location };
    return {
        ...finding,
        // Stable IDs survive ordering changes between runs; the fingerprint is
        // an identity aid only and is not used for security decisions.
        id: finding.id || createStableFindingId(identityInput),
        ruleId,
        category: finding.category || category,
        severity: ['critical', 'high', 'medium', 'low', 'info'].includes(String(finding.severity || '').toLowerCase())
            ? String(finding.severity).toLowerCase() : 'info',
        confidence,
        status: finding.status || 'detected',
        location,
        evidence,
        confidenceReason: finding.confidenceReason || null,
        evidenceAvailable: evidence.length > 0,
        sourceLocationAvailable: Boolean(location && location.path && startLine !== null),
    };
}

/** Explicitly describe the existing heuristic score formula rather than disguising it as a comprehensive quality measure. */
export function buildHealthScoreDetails({ stats = {}, issues = [], securityIssues = [], healthScore = null, coverage = null } = {}) {
    const functionCount = Number(stats.functions) || 0;
    const fileCount = Number(stats.files) || 0;
    const deadCount = Number(stats.dead) || 0;
    const deadPercent = functionCount > 0 ? deadCount / functionCount * 100 : 0;
    const circularCount = issues.filter((item) => String(item.title || '').includes('Circular')).length;
    const largeFileCount = issues.filter((item) => String(item.title || '').includes('Large')).length;
    const averageConnectionsPerFile = fileCount > 0 ? (Number(stats.connections) || 0) / fileCount : 0;
    const highSecurityFindingCount = securityIssues.filter((item) => ['critical', 'high'].includes(String(item.severity || '').toLowerCase())).length;
    const penalties = {
        estimatedDeadFunctions: Math.min(20, deadPercent),
        circularDependencies: Math.min(20, circularCount * 5),
        largeFiles: Math.min(15, largeFileCount * 3),
        coupling: Math.min(15, Math.max(0, averageConnectionsPerFile - 3) * 2),
        highSeveritySecurityFindings: Math.min(20, highSecurityFindingCount * 5),
    };
    const penaltyTotal = Object.values(penalties).reduce((sum, value) => sum + value, 0);
    const calculationUnavailable = healthScore?.status === 'unknown';
    return {
        score: calculationUnavailable ? null : (healthScore?.score ?? Math.max(0, Math.round(100 - penaltyTotal))),
        grade: calculationUnavailable ? null : (healthScore?.grade ?? null),
        kind: calculationUnavailable ? 'unavailable' : 'heuristic',
        status: calculationUnavailable ? 'unknown' : (healthScore?.status || 'available'),
        baseScore: 100,
        penalties: Object.fromEntries(Object.entries(penalties).map(([key, value]) => [key, Math.round(value * 10) / 10])),
        totalPenalty: Math.round(penaltyTotal * 10) / 10,
        coverageStatus: coverage?.status || 'unknown',
        interpretation: 'This is a heuristic codebase-health indicator calculated from a limited set of signals, not an objectively verified quality score.',
        calibration: { status: 'not-benchmarked', groundTruthRequired: true, semantics: 'Cross-repository score comparisons are provisional until the score is calibrated against manually reviewed repository labels.' },
        scoreReliability: coverage?.status === 'complete' ? 'coverage-reported-complete; semantic correctness still unverified' : 'limited-by-analysis-coverage; review skipped, heuristic, unresolved, and failed stages before comparing scores',
        limitations: [
            'This score reflects only the listed heuristics; it is not a probability that the repository is healthy.',
            'It does not directly measure test execution, runtime behavior, deployment reliability, type correctness, or vulnerability exploitability.',
            'Analysis coverage and unresolved references must be reviewed alongside the score.',
        ],
    };
}

/** Add a source line to a graph edge without pretending heuristic edges are fully resolved. */
export function makeEvidenceEdge({ source, target, type, line = null, resolution = 'inferred', evidence = null, importBindings = [], resolvedBy = null }) {
    return {
        source,
        target,
        type,
        resolution,
        confidence: resolution === 'resolved' ? 'high' : resolution === 'ambiguous' ? 'low' : 'medium',
        ...(Number.isInteger(line) ? { line } : {}),
        ...(evidence ? { evidence } : {}),
        ...(typeof resolvedBy === 'string' && resolvedBy ? { resolvedBy } : {}),
        ...(Array.isArray(importBindings) && importBindings.length ? {
            importBindings: importBindings.filter((binding) => binding && typeof binding.localName === 'string' && typeof binding.importedName === 'string').map((binding) => ({
                importedName: binding.importedName,
                localName: binding.localName,
                ...(typeof binding.exportedName === 'string' ? { exportedName: binding.exportedName } : {}),
            })),
        } : {}),
    };
}

/** Validate the public result DTO before export; this checks shape, not semantic truth. */
export function validateAnalysisResult(result = {}) {
    const errors = [];
    const warnings = [];
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return { schemaVersion: 1, status: 'invalid', errors: ['Analysis result must be an object.'], warnings: [], semantics: 'Shape validation only; it does not prove analysis accuracy.' };
    }
    if (typeof result.engineVersion !== 'string' || !result.engineVersion) errors.push('engineVersion must be a non-empty string.');
    if (!result.repository || typeof result.repository !== 'object') errors.push('repository metadata must be an object.');
    if (!result.analysisInput || typeof result.analysisInput !== 'object') errors.push('analysisInput must be an object.');
    for (const field of ['files', 'functions', 'classes', 'dependencies', 'findings']) {
        if (!Array.isArray(result[field])) errors.push(`${field} must be an array.`);
    }
    if (!result.analysisCoverage || typeof result.analysisCoverage !== 'object') errors.push('analysisCoverage must be an object.');
    if (Array.isArray(result.files) && Number.isInteger(result.analysisInput?.discoveredFiles) && result.files.length !== result.analysisInput.discoveredFiles) {
        errors.push(`analysisInput.discoveredFiles (${result.analysisInput.discoveredFiles}) does not match result.files.length (${result.files.length}).`);
    }
    const filePaths = new Set();
    for (const file of Array.isArray(result.files) ? result.files : []) {
        if (!file || typeof file.path !== 'string' || !file.path) { errors.push('Every file record must have a path.'); continue; }
        if (file.path.startsWith('/') || /^[A-Za-z]:\//.test(file.path) || file.path.replace(/\\/g, '/').split('/').includes('..')) errors.push(`File path is not repository-relative: ${file.path}`);
        if (filePaths.has(file.path)) errors.push(`Duplicate result file path: ${file.path}`);
        filePaths.add(file.path);
    }
    const findingIds = new Set();
    for (const finding of Array.isArray(result.findings) ? result.findings : []) {
        if (!finding || typeof finding !== 'object') { errors.push('Every finding record must be an object.'); continue; }
        if (!finding.id || typeof finding.id !== 'string') errors.push('Every finding must have a stable string id.');
        else if (findingIds.has(finding.id)) errors.push(`Duplicate finding id observed: ${finding.id}`);
        else findingIds.add(finding.id);
        if (finding.location?.startLine != null && (!Number.isInteger(finding.location.startLine) || finding.location.startLine < 1)) warnings.push(`Finding ${finding.id || '(no id)'} has a non-positive/non-integer start line.`);
    }
    if (result.analysisCoverage?.status !== 'complete') warnings.push(`Analysis coverage is ${result.analysisCoverage?.status || 'unknown'}; this is not a complete repository scan.`);
    if (result.analysisMetrics?.groundTruthValidation?.status !== 'passed') warnings.push('Finding precision/recall has not been established from manually labelled ground truth.');
    return {
        schemaVersion: 1,
        status: errors.length ? 'invalid' : 'valid',
        errors: [...new Set(errors)],
        warnings: [...new Set(warnings)],
        checked: { files: Array.isArray(result.files) ? result.files.length : 0, findings: Array.isArray(result.findings) ? result.findings.length : 0, dependencies: Array.isArray(result.dependencies) ? result.dependencies.length : 0 },
        semantics: 'This validates output structure and internal count/path invariants. It does not measure precision, recall, architecture correctness or runtime behavior.',
    };
}
