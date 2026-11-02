/**
 * orchestrator.js
 *
 * Ties together ported Parser (parser.js) into a single entry
 * point: `analyzeRepository(repoMeta, files)`.
 *
 * Input:  repoMeta = { name, source: 'github'|'zip'|'local', url? }
 *         files    = [{ path, content }]   (path is repo-relative, e.g. "backend/UserService.java")
 *
 * Output: a plain JSON object matching the backend's POST /api/repository/ingest
 *         contract (see PROJECT_DOCUMENTATION.md, section 5). This is the ONLY
 *         thing that leaves the browser and gets sent to the backend — the
 *         backend never re-parses source, it only stores this structure and
 *         indexes it for RAG.
 *
 * This file contains logic we wrote ourselves (not ported from CodeFlow):
 * the class/annotation extraction pass and the JSON shaping. Function
 * extraction, dependency/call-graph resolution, security scanning, pattern
 * detection, and health scoring all delegate to `Parser` from parser.js.
 */

import { Parser, calcHealth } from './parser.js';
import { extractLanguageTypes, summarizeLanguageDepth, SUPPORTED_CODE_LANGUAGES } from './languageIntelligence.js';
import { buildCallGraph, buildIssues, buildLanguageStats } from './callGraph.js';
import { computeEntryPoints, computeImportantFiles, tagFindings, computeSafeToTouch } from './insights.js';
import { computeRoleClassification, computeFlowTraces } from './roles.js';
import { computeMigrationRisk, computeMigrationOrder } from './migrate.js';
import { discoverEndpoints, analyzeApiContracts, generateCurl, generatePostmanCollection, extractClientApiCalls } from './api.js';
import {
    computeModuleBoundaries, computeDomainClusters, computeArchitectureDrift,
    computeConfigToCodeLinkage, computeExternalBoundaries, computeErrorHandlingCoverage,
    computeDataOwnership, computeDependencyLayerViolations,
} from './architecture.js';
import { extractDatabaseSchema, detectOrphanTables } from './db.js';
import { computeAuthCoverageMap, detectAdvancedSecrets } from './security.js';
import { extractDependencyInventory, checkLicenseCompliance } from './dependencies.js';
import {
    mineTodoComments, computeDocumentationCoverage, scanConfigMisconfig,
    checkNamingConventions, generateOpenApiSpec, scanBasicA11y,
} from './quality.js';
import { generateArchitectureReport } from './report.js';
import { buildAnalysisCoverage, buildHealthScoreDetails, normalizeFinding, validateAnalysisResult } from './analysisContracts.js';
import { extractFileDependencies } from './moduleResolution.js';
import { analyzeTestLinkage } from './testLinkage.js';
import { analyzeHeuristicDataFlows, analyzeInterproceduralDataFlows } from './dataFlow.js';
import { buildMaintainabilityMetrics } from './functionMetrics.js';
import { analyzeFrameworkSignals } from './frameworkAnalysis.js';
import { getModuleResolutionCacheStats } from './moduleResolution.js';
import { runAdvancedAnalysis } from './advancedAnalysis.js';
import { loadCustomRules, runCustomRules, loadFindingSuppressions, applyFindingSuppressions } from './ruleEngine.js';
import { toSarifLog, toAnalysisJson } from './reportFormats.js';
import { buildUnifiedAnalysisModel, queryAnalysisModel, sliceAnalysisModel, compareAnalysisResults, createAnalysisSnapshot } from './unifiedAnalysisModel.js';
export { buildUnifiedAnalysisModel, queryAnalysisModel, sliceAnalysisModel, compareAnalysisResults, createAnalysisSnapshot } from './unifiedAnalysisModel.js';
export { loadCustomRules, runCustomRules, loadFindingSuppressions, applyFindingSuppressions } from './ruleEngine.js';
export { toSarifLog, toAnalysisJson } from './reportFormats.js';
export { runAdvancedAnalysis } from './advancedAnalysis.js';
import { evaluateHealthScoreCalibration } from './benchmarkMetrics.js';
import { createFileAnalysisCacheKey, getCachedExtraction, setCachedExtraction, getCachedComplexity, setCachedComplexity, getAnalysisCacheStats } from './analysisCache.js';
import { prepareRepositoryFiles } from './repositoryInput.js';
import { ENGINE_VERSION } from './engineVersion.js';
import { analyzeDependencyUsage } from './dependencyUsage.js';
import { deduplicateFindings } from './findingQuality.js';
import { buildIncrementalAnalysisPlan } from './incrementalAnalysis.js';
import { analyzeArchitectureIntelligence, recommendTestsForChanges } from './architectureIntelligence.js';
import { buildAnalysisMetrics } from './analysisMetrics.js';
import { analyzeExecutionIntelligence } from './executionIntelligence.js';
import { analyzeSyntaxDiagnostics } from './syntaxDiagnostics.js';
import { indexPreviousExtraction, lookupPreviousExtraction, createExtractionSnapshot } from './extractionSnapshot.js';
import { correlateRuntimeEvidence } from './runtimeEvidence.js';
import { resolveIncrementalDependencies } from './incrementalDependencies.js';
import { analyzeSemanticIntelligence, computeSymbolImpact } from './semanticIntelligence.js';
import { analyzeCrossSystemIntelligence } from './crossSystemIntelligence.js';
import { analyzeBusinessIntelligence } from './businessIntelligence.js';
import { enrichSystemKnowledgeGraph } from './systemKnowledge.js';
import { auditEngineeringGraph } from './graphQuality.js';
export { evaluateIntelligenceLabels } from './intelligenceBenchmark.js';
export { auditEngineeringGraph } from './graphQuality.js';
export { analyzeBusinessIntelligence } from './businessIntelligence.js';
export { enrichSystemKnowledgeGraph } from './systemKnowledge.js';
export { locateIntelligenceEntities, traceEngineeringFlows, computeEngineeringImpact, buildEngineeringQuestionContext } from './engineeringIntelligence.js';
import { auditSourceEvidence } from './evidenceAudit.js';
import { summarizeAnalysisExport, compareRepositoryRuns } from './reportComparison.js';
export { extractFileDependencies } from './moduleResolution.js';
export { resolveIncrementalDependencies } from './incrementalDependencies.js';
export { analyzeSemanticIntelligence, computeSymbolImpact } from './semanticIntelligence.js';
export { analyzeCrossSystemIntelligence } from './crossSystemIntelligence.js';
export { computeChangeImpact, computeFunctionImpact } from './changeImpact.js';
export { analyzeArchitectureIntelligence, recommendTestsForChanges } from './architectureIntelligence.js';
export { prepareRepositoryFiles, REPOSITORY_INPUT_LIMITS } from './repositoryInput.js';
export { compareFileSnapshots, buildIncrementalAnalysisPlan } from './incrementalAnalysis.js';
export { analyzeDependencyUsage } from './dependencyUsage.js';
export { deduplicateFindings, createStableFindingId, buildFindingActionPlan } from './findingQuality.js';
export { buildAnalysisMetrics } from './analysisMetrics.js';
export { summarizeAnalysisExport, compareRepositoryRuns } from './reportComparison.js';
export { validateAnalysisResult } from './analysisContracts.js';
export { evaluateFindingBenchmark, evaluateHealthScoreCalibration } from './benchmarkMetrics.js';
export { ENGINE_VERSION } from './engineVersion.js';
export { analyzeExecutionIntelligence } from './executionIntelligence.js';
export { analyzeSyntaxDiagnostics } from './syntaxDiagnostics.js';
export { createExtractionSnapshot, indexPreviousExtraction } from './extractionSnapshot.js';
export { correlateRuntimeEvidence } from './runtimeEvidence.js';
export { auditSourceEvidence } from './evidenceAudit.js';
export { evaluateGraphEdges } from './graphBenchmark.js';
export { identifyCodeLanguage, extractLanguageFunctions, extractLanguageTypes, SUPPORTED_CODE_LANGUAGES } from './languageIntelligence.js';

/** Ensures acorn/Babel globals are present (call once at app startup, before analyzing). */
export function configureAnalysisEngine({ acorn, Babel, TreeSitter } = {}) {
    if (acorn) globalThis.acorn = acorn;
    if (Babel) globalThis.Babel = Babel;
    if (TreeSitter) globalThis.TreeSitter = TreeSitter;
}

/**
 * Very lightweight class + annotation extraction for JVM-family languages.
 * function-centric (it doesn't model "classes" as a
 * first-class concept), so this pass is ours — it sits on top of Parser's
 * function extraction to additionally capture class-level metadata that our
 * Visualization Explorer and DB schema need (classes table, annotations).
 */
function maskJvmNonCode(content) {
    const source = String(content || '');
    const out = source.split('');
    let state = 'code';
    let quote = '';
    let textBlock = false;
    for (let i = 0; i < source.length;) {
        const c = source[i];
        const next = source[i + 1];
        const third = source[i + 2];
        if (state === 'line-comment') {
            if (c === '\n') state = 'code';
            else out[i] = ' ';
            i++;
            continue;
        }
        if (state === 'block-comment') {
            if (c === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'code'; }
            else { if (c !== '\n') out[i] = ' '; i++; }
            continue;
        }
        if (state === 'string') {
            if (!textBlock && c === '\\') {
                if (c !== '\n') out[i] = ' ';
                if (i + 1 < source.length && source[i + 1] !== '\n') out[i + 1] = ' ';
                i += 2;
                continue;
            }
            if (textBlock && c === quote && next === quote && third === quote) {
                out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 3; state = 'code'; textBlock = false; continue;
            }
            if (!textBlock && c === quote) { out[i] = ' '; i++; state = 'code'; continue; }
            if (c !== '\n') out[i] = ' ';
            i++;
            continue;
        }
        if (c === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'line-comment'; continue; }
        if (c === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'block-comment'; continue; }
        if (c === '"' && next === '"' && third === '"') { quote = '"'; textBlock = true; out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 3; state = 'string'; continue; }
        if (c === '"' || c === "'") { quote = c; textBlock = false; out[i] = ' '; i++; state = 'string'; continue; }
        i++;
    }
    return out.join('');
}

/**
 * Lightweight JVM-family type discovery. This is token-aware enough to avoid
 * class-like text in comments/strings and to find declarations after inline
 * annotations/modifiers, but it is still not a compiler-grade AST parser.
 */
export function extractClasses(content, filename) {
    const isJvmFamily = /\.(java|kt|kts|cs|scala|groovy)$/i.test(filename);
    if (!isJvmFamily) return [];

    const source = String(content || '');
    const masked = maskJvmNonCode(source);
    const packageMatch = masked.match(/^\s*package\s+([\w.]+)\s*;?/m);
    const pkg = packageMatch ? packageMatch[1] : null;
    const classes = [];
    const classRegex = /\b(?:class|interface|enum|record|object|trait|struct)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
    for (const match of masked.matchAll(classRegex)) {
        const offset = match.index + match[0].search(/(?:class|interface|enum|record|object|trait|struct)\s+/);
        const line = masked.slice(0, offset).split('\n').length;
        const lineStart = masked.lastIndexOf('\n', offset - 1) + 1;
        const currentLinePrefix = source.slice(lineStart, offset);
        const annotations = [...currentLinePrefix.matchAll(/@([A-Za-z_$][A-Za-z0-9_$.]*)/g)].map((item) => item[1]);
        const precedingLines = source.slice(0, lineStart).split('\n');
        for (let i = precedingLines.length - 1, scanned = 0; i >= 0 && scanned < 5; i--, scanned++) {
            const prior = precedingLines[i].trim();
            if (!prior) continue;
            const annotation = prior.match(/^@([A-Za-z_$][A-Za-z0-9_$.]*)(?:\s*\(.*\))?\s*$/);
            if (annotation) annotations.unshift(annotation[1]);
            else break;
        }
        classes.push({ name: match[1], file: filename, package: pkg, line, annotations: [...new Set(annotations)] });
    }
    return classes;
}

/** Attach JVM source methods to the innermost class span when the language parser only
 * has line-based method extraction. This is a source-span heuristic, not inheritance
 * or compiler symbol resolution. Existing AST-derived className values are preserved. */
function attachJvmClassContext(content, filename, functions = []) {
    if (!/\.(?:java|kt|kts|cs|scala|groovy)$/i.test(filename)) return functions;
    const masked = maskJvmNonCode(String(content || ''));
    const classPattern = /\b(?:class|interface|enum|record|object|trait|struct)\s+([A-Za-z_$][A-Za-z0-9_$]*)[^{};]*\{/g;
    const spans = [];
    for (const match of masked.matchAll(classPattern)) {
        const open = match.index + match[0].lastIndexOf('{');
        let depth = 0;
        let close = -1;
        for (let index = open; index < masked.length; index++) {
            if (masked[index] === '{') depth++;
            else if (masked[index] === '}') {
                depth--;
                if (depth === 0) { close = index; break; }
            }
        }
        if (close < 0) continue;
        spans.push({
            name: match[1],
            startLine: masked.slice(0, match.index).split('\n').length,
            endLine: masked.slice(0, close).split('\n').length,
            spanSize: close - open,
        });
    }
    for (const fn of functions) {
        if (!fn || fn.className || !(fn.isClassMethod || ['method', 'constructor', 'classmethod', 'staticmethod', 'property'].includes(String(fn.type || '').replace(/^async_/, '')))) continue;
        const line = Number(fn.line);
        if (!Number.isInteger(line)) continue;
        const candidates = spans.filter((span) => span.startLine <= line && line <= span.endLine)
            .sort((a, b) => a.spanSize - b.spanSize);
        if (candidates.length) {
            fn.className = candidates[0].name;
            fn.isClassMethod = true;
        }
    }
    return functions;
}

function summarizeDependencyResolution(dependencies, diagnostics) {
    const resolvedEdges = dependencies.filter((edge) => edge.resolution === 'resolved').length;
    const ambiguousEdges = dependencies.filter((edge) => edge.resolution === 'ambiguous').length;
    const inferredEdges = dependencies.filter((edge) => edge.resolution === 'inferred').length;
    const unresolvedLocalImports = diagnostics.unresolvedLocalImports || [];
    const unresolvedPackageMembers = diagnostics.unresolvedPackageMembers || [];
    const ambiguousImports = diagnostics.ambiguousImports || [];
    return {
        edges: dependencies.length,
        resolvedEdges,
        ambiguousEdges,
        inferredEdges,
        edgeResolutionPct: dependencies.length ? Math.round(resolvedEdges / dependencies.length * 1000) / 10 : null,
        unresolvedLocalImportCount: unresolvedLocalImports.length,
        unresolvedPackageMemberCount: unresolvedPackageMembers.length,
        ambiguousImportCount: ambiguousImports.length,
        unresolvedLocalImports,
        unresolvedPackageMembers,
        ambiguousImports,
        pathMappings: diagnostics.pathMappings || [],
        semantics: 'Edge resolution percentage applies only to emitted edges; unresolved local imports are listed separately and are not silently counted as resolved.',
    };
}

const MAX_ANALYSIS_FILES = 10000;
const MAX_ANALYSIS_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_ANALYSIS_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Compute bounded, function-span complexity estimates from full source ranges.
 * This deliberately does not reuse `fn.code`, because display snippets are
 * truncated to keep ingestion payloads small and would under-count long methods.
 */
function buildFunctionComplexitySummary(files, functions) {
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    const totals = { discoveredFunctions: functions.length, analyzedFunctions: 0, skippedFunctions: 0, failedFunctions: 0 };
    const byFile = new Map();
    const candidates = [];
    const supportedSource = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyw|pyi|java|kt|kts|go|c|h|cc|cpp|hpp|html?|vue|svelte)$/i;

    for (const fn of functions) {
        const sourceFile = filesByPath.get(fn.file);
        if (!sourceFile || !supportedSource.test(fn.file) || fn.endLineConfidence === 'declaration-line-only') {
            totals.skippedFunctions += 1;
            continue;
        }
        const lines = sourceFile.content.split('\n');
        const startLine = Number(fn.line);
        const endLine = Number(fn.endLine ?? fn.line);
        if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || startLine > lines.length) {
            totals.skippedFunctions += 1;
            continue;
        }
        const source = lines.slice(startLine - 1, Math.min(endLine, lines.length)).join('\n');
        if (!source.trim()) { totals.skippedFunctions += 1; continue; }
        try {
            // Script-container functions were extracted from embedded script
            // blocks; their span now contains only the function, not its tag.
            const complexityPath = /\.(?:html?|vue|svelte)$/i.test(fn.file) ? `${fn.file}.js` : fn.file;
            const estimate = Parser.calcComplexity(source, complexityPath);
            if (!Number.isFinite(estimate?.score)) { totals.skippedFunctions += 1; continue; }
            const record = {
                key: `${fn.file}|${startLine}|${fn.name}`,
                name: fn.name,
                file: fn.file,
                startLine,
                endLine: Math.min(endLine, lines.length),
                score: estimate.score,
                decisionPoints: estimate.decisionPoints ?? Math.max(0, estimate.score - 1),
                level: estimate.level || 'unknown',
                method: estimate.method || 'heuristic-branch-count',
                confidence: 'heuristic',
                endLineConfidence: fn.endLineConfidence || (fn.endLine ? 'estimated-or-parser-located' : 'line-only'),
                limitations: [
                    'Approximate source-span branch count, not compiler-reported cyclomatic complexity.',
                    'Nested callbacks/closures may be counted within the enclosing function span.',
                    'Regex-fallback function boundaries may be approximate for complex syntax.',
                ],
            };
            totals.analyzedFunctions += 1;
            candidates.push(record);
            const current = byFile.get(fn.file) || { file: fn.file, analyzedFunctions: 0, estimatedComplexityTotal: 0, maxEstimatedComplexity: 0 };
            current.analyzedFunctions += 1;
            current.estimatedComplexityTotal += estimate.score;
            current.maxEstimatedComplexity = Math.max(current.maxEstimatedComplexity, estimate.score);
            byFile.set(fn.file, current);
        } catch {
            totals.failedFunctions += 1;
        }
    }
    const fileSummary = [...byFile.values()].map((item) => ({
        ...item,
        averageEstimatedComplexity: Math.round((item.estimatedComplexityTotal / Math.max(1, item.analyzedFunctions)) * 100) / 100,
    }));
    const totalComplexity = candidates.reduce((sum, item) => sum + item.score, 0);
    const highComplexityCount = candidates.filter((item) => item.score >= 11).length;
    return {
        schemaVersion: 1,
        status: totals.failedFunctions ? 'partial' : totals.skippedFunctions ? 'partial' : 'complete',
        semantics: 'Function-level complexity estimates are heuristic branch counts over full extracted source spans. They are not compiler-grade cyclomatic complexity and may include nested closure branches.',
        method: 'heuristic-branch-count',
        ...totals,
        coveragePct: totals.discoveredFunctions ? Math.round(totals.analyzedFunctions / totals.discoveredFunctions * 1000) / 10 : 100,
        averageEstimatedComplexity: candidates.length ? Math.round(totalComplexity / candidates.length * 100) / 100 : null,
        highComplexityCount,
        files: fileSummary.sort((a, b) => b.maxEstimatedComplexity - a.maxEstimatedComplexity).slice(0, 100),
        topComplexFunctions: candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.startLine - b.startLine).slice(0, 100),
        limitations: [
            'A high estimate is a review signal, not proof that a function is difficult or unsafe to change.',
            'A low estimate does not establish correctness, test coverage or maintainability.',
            'Functions with line-only declaration ranges or unsupported language syntax are excluded from estimates and counted as skipped.',
        ],
    };
}

function normalizeAnalysisInputs(rawFiles, options = {}) {
    return prepareRepositoryFiles(rawFiles, {
        maxFiles: options.maxFiles ?? MAX_ANALYSIS_FILES,
        maxTotalBytes: options.maxTotalBytes ?? MAX_ANALYSIS_TOTAL_BYTES,
        maxFileBytes: options.maxFileBytes ?? MAX_ANALYSIS_FILE_BYTES,
        maxPathDepth: options.maxPathDepth ?? 80,
        excludeDefaultDirectories: options.excludeDefaultDirectories,
        excludeGenerated: options.excludeGenerated,
        excludePaths: options.excludePaths,
        includeExtensions: options.includeExtensions,
        skipBinary: options.skipBinary,
    });
}

function applyInputPreparationCoverage(coverage, diagnostics) {
    coverage.inputPreparation = {
        status: diagnostics?.status || 'unknown',
        suppliedFiles: diagnostics?.inputFiles ?? null,
        includedFiles: diagnostics?.includedFiles ?? null,
        excludedFiles: diagnostics?.excludedFiles ?? 0,
        excludedByReason: diagnostics?.excludedByReason || {},
        skippedFiles: (diagnostics?.skippedFiles || []).slice(0, 200),
        semantics: diagnostics?.semantics || 'Input preparation diagnostics unavailable.',
    };
    if ((diagnostics?.excludedFiles || 0) > 0) {
        coverage.status = 'partial';
        coverage.statusReasons ||= [];
        const reason = `${diagnostics.excludedFiles} supplied file(s) were excluded by ingestion policy or safety bounds; review analysisCoverage.inputPreparation.skippedFiles.`;
        if (!coverage.statusReasons.includes(reason)) coverage.statusReasons.push(reason);
    }
    return coverage;
}

function getExtractionStrategy(file) {
    return Parser.isCode(file.name) ? 'unknown' : 'not-code';
}

function applyCallGraphCoverage(coverage, diagnostics) {
    const summary = diagnostics || {};
    const totalCallNameReferences = summary.totalCallNameReferences || 0;
    const resolvedCallNameReferences = summary.resolvedCallNameReferences || 0;
    const functionCallSiteCount = summary.functionCallSiteCount || 0;
    const locatedFunctionCallSiteCount = summary.locatedFunctionCallSiteCount || 0;
    const callSiteEvidenceMissingCount = summary.callSiteEvidenceMissingCount || 0;
    const unattributedFunctionCallSiteCount = summary.unattributedFunctionCallSiteCount || 0;
    // Keep two clearly defined rates: location-quality only counts calls for
    // which source lines exist; overall attribution additionally penalizes
    // parser call-count units that could not be located in source.
    const locatedUnattributedCallSiteCount = Math.max(0, unattributedFunctionCallSiteCount - callSiteEvidenceMissingCount);
    const attributedLocatedFunctionCallSiteCount = Math.max(0, locatedFunctionCallSiteCount - locatedUnattributedCallSiteCount);
    const attributedFunctionCallSiteCount = Math.max(0, functionCallSiteCount - unattributedFunctionCallSiteCount);
    const externalLikelyReceiverCallCount = summary.externalLikelyReceiverCallCount || 0;
    const projectUnknownReceiverCallCount = summary.projectUnknownReceiverCallCount || 0;
    coverage.callGraph = {
        totalCallNameReferences,
        resolvedCallNameReferences,
        resolutionPct: totalCallNameReferences ? Math.round(resolvedCallNameReferences / totalCallNameReferences * 1000) / 10 : null,
        unresolvedCallCount: summary.unresolvedCallCount || 0,
        projectUnresolvedCallCount: Math.max(0, (summary.unresolvedCallCount || 0) - externalLikelyReceiverCallCount),
        externalLikelyReceiverCallCount,
        projectUnknownReceiverCallCount,
        ambiguousCallCount: summary.ambiguousCallCount || 0,
        functionCallSiteCount,
        locatedFunctionCallSiteCount,
        callSiteEvidenceMissingCount,
        locatedUnattributedCallSiteCount,
        attributedLocatedFunctionCallSiteCount,
        attributedFunctionCallSiteCount,
        unattributedFunctionCallSiteCount,
        unresolvedUnattributedCallSiteCount: summary.unresolvedUnattributedCallSiteCount || 0,
        // attributionPct is now the rate on source-located resolved calls only.
        // overallAttributionPct preserves the stricter rate including no-locator units.
        attributionPct: locatedFunctionCallSiteCount ? Math.round(attributedLocatedFunctionCallSiteCount / locatedFunctionCallSiteCount * 1000) / 10 : null,
        overallAttributionPct: functionCallSiteCount ? Math.round(attributedFunctionCallSiteCount / functionCallSiteCount * 1000) / 10 : null,
        unresolvedCalls: Array.isArray(summary.unresolvedCalls) ? summary.unresolvedCalls.slice(0, 500) : [],
        semantics: 'Resolution rate uses observed call-name references, including unresolved receiver-shaped calls. attributionPct uses source-located resolved call-site units only; overallAttributionPct additionally penalizes call-count units without source locators. Likely external/runtime/framework receiver calls are classified separately and still visible in unresolvedCallCount; projectUnresolvedCallCount removes those heuristic external-likely cases. These rates are heuristic diagnostics, not compiler-grade recall or precision.',
    };
    if (coverage.callGraph.projectUnresolvedCallCount || coverage.callGraph.ambiguousCallCount) {
        coverage.status = 'partial';
        coverage.statusReasons ||= [];
        const reason = `${coverage.callGraph.projectUnresolvedCallCount} project/unknown unresolved and ${coverage.callGraph.ambiguousCallCount} ambiguous call reference(s) were excluded from confirmed call-graph edges; ${coverage.callGraph.externalLikelyReceiverCallCount} unresolved receiver call(s) were classified as likely external/runtime/framework boundaries.`;
        if (!coverage.statusReasons.includes(reason)) coverage.statusReasons.push(reason);
    }
    return coverage;
}

function applyDependencyResolutionCoverage(coverage) {
    const dependencyResolution = coverage?.dependencyResolution || {};
    const unresolved = dependencyResolution.unresolvedLocalImports || [];
    const unresolvedPackageMembers = dependencyResolution.unresolvedPackageMembers || [];
    const ambiguous = dependencyResolution.ambiguousImports || [];
    if (unresolved.length || unresolvedPackageMembers.length || ambiguous.length) {
        coverage.status = 'partial';
        coverage.statusReasons ||= [];
        const reason = `${unresolved.length} unresolved local import(s), ${unresolvedPackageMembers.length} unresolved package member(s), and ${ambiguous.length} ambiguous import(s) require review.`;
        if (!coverage.statusReasons.includes(reason)) coverage.statusReasons.push(reason);
    }
    return coverage;
}

function applyFunctionComplexityCoverage(coverage, summary) {
    coverage.functionComplexity = {
        status: summary?.status || 'unknown',
        discoveredFunctions: summary?.discoveredFunctions || 0,
        analyzedFunctions: summary?.analyzedFunctions || 0,
        skippedFunctions: summary?.skippedFunctions || 0,
        failedFunctions: summary?.failedFunctions || 0,
        coveragePct: Number.isFinite(summary?.coveragePct) ? summary.coveragePct : null,
        semantics: 'Coverage refers to functions with usable source spans for heuristic complexity estimates, not semantic understanding or code correctness.',
    };
    if ((coverage.functionComplexity.skippedFunctions || coverage.functionComplexity.failedFunctions) > 0) {
        coverage.status = 'partial';
        coverage.statusReasons ||= [];
        const reason = `${coverage.functionComplexity.skippedFunctions} function(s) were skipped and ${coverage.functionComplexity.failedFunctions} function complexity estimate(s) failed.`;
        if (!coverage.statusReasons.includes(reason)) coverage.statusReasons.push(reason);
    }
    return coverage;
}

/**
 * Runs the full analysis over a set of in-memory files and
 * returns the JSON payload our backend's ingest API expects.
 *
 * @param {{ name: string, source: 'github'|'zip'|'local', url?: string }} repoMeta
 * @param {Array<{ path: string, content: string }>} files
 * @param {(progress: { phase: string, current: number, total: number }) => void} [onProgress]
 */
export async function analyzeRepository(repoMeta, rawFiles, onProgress, options = {}) {
    // Backwards-compatible overload: the third argument may be either a progress
    // callback (historic signature) or an analysis-options object.
    if (onProgress && typeof onProgress !== 'function') {
        options = onProgress;
        onProgress = null;
    }
    const effectiveOptions = { ...(repoMeta?.analysisOptions || {}), ...(options || {}) };
    const report = (phase, current, total) => {
        if (onProgress) onProgress({ phase, current, total });
    };

    // Canonicalize paths, apply configurable file/byte/depth bounds, and retain
    // an audit trail of files excluded by policy. Unsafe paths and duplicates
    // still fail closed before any analyzer consumes the input.
    const normalizedInput = normalizeAnalysisInputs(rawFiles, effectiveOptions);
    const files = normalizedInput.files;
    // Remote WASM grammars are never fetched implicitly. Consumers must opt in
    // and inject a TreeSitter provider. Failure does not claim AST coverage.
    if (effectiveOptions.enableTreeSitter && globalThis.TreeSitter) {
        try { await Parser.prepareTreeSitter(files); }
        catch { /* per-file provenance will still report lexical fallback */ }
    }

    const previousExtractionIndex = indexPreviousExtraction(effectiveOptions.previousResult?.extractionSnapshot);
    const extractionByFile = new Map();
    const allFunctions = [];
    const allClasses = [];
    const functionCountByFile = new Map();
    const fileCacheKeys = new Map();
    const analysisCacheStats = { eligibleFiles: 0, extractionHits: 0, complexityHits: 0, extractionMisses: 0, complexityMisses: 0, portableExtractionHits: 0, portableComplexityHits: 0 };
    const fileStatuses = files.map((file) => ({
        path: file.path,
        language: guessLanguage(file.path),
        parserStrategy: getExtractionStrategy(file),
        extraction: { status: Parser.isCode(file.name) ? 'unknown' : 'skipped', ...(Parser.isCode(file.name) ? {} : { reason: 'not a code file' }) },
        complexity: { status: Parser.isCode(file.name) ? 'unknown' : 'skipped' },
        errors: [],
    }));
    const fileStatusByPath = new Map(fileStatuses.map((item) => [item.path, item]));
    const stageNames = [
        'extraction', 'complexity', 'dependencies', 'patterns', 'security', 'duplicates',
        'callGraph', 'layerViolations', 'issues', 'insights', 'roles', 'migration', 'api', 'testLinkage', 'dataFlow',
        'architecture', 'database', 'securityDeepening', 'dependencyInventory', 'quality',
        'inputPreparation', 'architectureIntelligence', 'executionIntelligence', 'syntaxValidation', 'evidenceAudit', 'maintainabilityMetrics', 'frameworkAnalysis', 'healthScore', 'customRules', 'findingDeduplication', 'findingSuppressions', 'advancedAnalysis', 'dependencyUsage', 'unifiedModel',
        'incrementalDependencyResolution', 'semanticIntelligence', 'crossSystemIntelligence',
    ];
    const stageStatuses = Object.fromEntries(stageNames.map((name) => [name, { status: 'unknown' }]));
    const markStage = (name, status, error) => {
        stageStatuses[name] = { status, ...(error ? { error: String(error.message || error).slice(0, 240) } : {}) };
    };
    markStage('inputPreparation', normalizedInput.diagnostics?.excludedFiles ? 'partial' : 'complete');

    report('extracting', 0, files.length);
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!Parser.isCode(file.name)) {
            fileStatusByPath.get(file.path).extraction = { status: 'skipped', reason: 'not a code file' };
        } else {
            try {
                const cacheKey = await createFileAnalysisCacheKey(file.path, file.content, {
                    acorn: typeof globalThis.acorn !== 'undefined',
                    Babel: typeof globalThis.Babel !== 'undefined',
                    treeSitter: Parser.getLoadedTreeSitterParser(file.path) ? Parser.getTreeSitterConfig(file.path)?.grammar : 'disabled',
                });
                if (cacheKey) {
                    fileCacheKeys.set(file.path, cacheKey);
                    analysisCacheStats.eligibleFiles += 1;
                }
                const cachedExtraction = getCachedExtraction(cacheKey);
                const portableExtraction = !cachedExtraction ? lookupPreviousExtraction(previousExtractionIndex, file.path, cacheKey) : null;
                let extractionDiagnostics = {};
                let fns;
                if (cachedExtraction && Array.isArray(cachedExtraction.functions)) {
                    fns = cachedExtraction.functions;
                    extractionDiagnostics = cachedExtraction.diagnostics || {};
                    analysisCacheStats.extractionHits += 1;
                } else if (portableExtraction && Array.isArray(portableExtraction.functions)) {
                    fns = portableExtraction.functions;
                    extractionDiagnostics = portableExtraction.diagnostics || {};
                    analysisCacheStats.portableExtractionHits += 1;
                } else {
                    analysisCacheStats.extractionMisses += 1;
                    fns = Parser.extract(file.content, file.path, extractionDiagnostics) || [];
                }
                // Cache a canonicalized extraction. Java fallback methods need
                // containing-class context for conservative `this.foo()` resolution.
                attachJvmClassContext(file.content, file.path, fns);
                extractionByFile.set(file.path, { functions: fns.map((fn) => ({ ...fn })), diagnostics: extractionDiagnostics });
                if (!cachedExtraction && cacheKey) setCachedExtraction(cacheKey, { functions: fns, diagnostics: extractionDiagnostics });
                fns.forEach((fn) => allFunctions.push({ ...fn, file: file.path }));
                functionCountByFile.set(file.path, fns.length);
                fileStatusByPath.get(file.path).parserStrategy = extractionDiagnostics.mode || 'unknown';
                fileStatusByPath.get(file.path).extraction = { status: 'complete', parserMode: extractionDiagnostics.mode || 'unknown' };
            } catch (err) {
                // A single unparsable file must never abort the whole analysis run.
                console.warn(`[analysis-engine] extraction failed for ${file.path}:`, err.message);
                fileStatusByPath.get(file.path).parserStrategy = 'unknown';
                fileStatusByPath.get(file.path).extraction = { status: 'failed', error: String(err.message || err).slice(0, 240) };
                fileStatusByPath.get(file.path).errors.push(`extraction: ${String(err.message || err).slice(0, 240)}`);
            }
            const discoveredTypes = extractClasses(file.content, file.path);
            const existingTypeKeys = new Set(discoveredTypes.map((entry) => `${entry.line}|${entry.name}`));
            for (const entry of extractLanguageTypes(file.content, file.path)) {
                if (!existingTypeKeys.has(`${entry.line}|${entry.name}`)) discoveredTypes.push(entry);
            }
            allClasses.push(...discoveredTypes);
        }
        if (i % 10 === 0) {
            report('extracting', i + 1, files.length);
            await new Promise((r) => setTimeout(r, 0)); // yield to keep the UI responsive
        }
    }
    report('extracting', files.length, files.length);
    markStage('extraction', fileStatuses.some((item) => item.extraction.status === 'failed' ||
        (item.parserStrategy !== 'ast' && item.parserStrategy !== 'not-code')) ? 'partial' : 'complete');

    // Layer (Parser.detectLayer — a path-based heuristic,
    // e.g. "controller"/"service"/"repository" segments) and complexity per
    // file, both needed for Color-By-Layer and the Issues/High-Complexity check.
    files.forEach((file) => {
        file.layer = Parser.detectLayer(file.path);
        try {
            if (Parser.isCode(file.name)) {
                const cacheKey = fileCacheKeys.get(file.path);
                const cachedComplexity = getCachedComplexity(cacheKey);
                const portableComplexity = !cachedComplexity ? lookupPreviousExtraction(previousExtractionIndex, file.path, cacheKey)?.complexity : null;
                if (cachedComplexity) {
                    file.complexity = cachedComplexity;
                    analysisCacheStats.complexityHits += 1;
                } else if (portableComplexity) {
                    file.complexity = portableComplexity;
                    analysisCacheStats.portableComplexityHits += 1;
                } else {
                    analysisCacheStats.complexityMisses += 1;
                    file.complexity = Parser.calcComplexity(file.content, file.path);
                    if (cacheKey) setCachedComplexity(cacheKey, file.complexity);
                }
                fileStatusByPath.get(file.path).complexity = file.complexity?.status === 'skipped'
                    ? { status: 'skipped', reason: 'not applicable to this file' }
                    : { status: 'complete' };
            } else {
                // Not applicable is deliberately not reported as a low-complexity result.
                file.complexity = { score: null, level: 'not-applicable', status: 'skipped' };
                fileStatusByPath.get(file.path).complexity = { status: 'skipped' };
            }
        } catch (err) {
            // Unknown is safer than silently converting analyzer failure into a healthy score.
            file.complexity = { score: null, level: 'unknown', status: 'failed' };
            fileStatusByPath.get(file.path).complexity = { status: 'failed', error: String(err.message || err).slice(0, 240) };
            fileStatusByPath.get(file.path).errors.push(`complexity: ${String(err.message || err).slice(0, 240)}`);
        }
        file.functionCount = functionCountByFile.get(file.path) || 0;
    });
    markStage('complexity', fileStatuses.some((item) => item.complexity.status === 'failed') ? 'partial' : 'complete');

    // Portable checkpoint: reusable only with a cryptographic source key and
    // matching analyzer version/capabilities. Global graph passes never reuse it.
    const extractionSnapshot = createExtractionSnapshot(files, fileCacheKeys, extractionByFile);
    let syntaxDiagnostics = { schemaVersion: 1, status: 'unavailable', summary: {}, checks: [] };
    try {
        syntaxDiagnostics = analyzeSyntaxDiagnostics(files);
        markStage('syntaxValidation', syntaxDiagnostics.status === 'partial' ? 'partial' : 'complete');
    } catch (error) {
        markStage('syntaxValidation', 'failed', error);
    }

    report('dependencies', 0, 1);
    let dependencies = [];
    let dependencyResolutionCheckpoint = null;
    let dependencyExecution = { mode: 'unavailable', reusedSourceFiles: 0, recalculatedSourceFiles: 0 };
    const dependencyDiagnostics = { unresolvedLocalImports: [], ambiguousImports: [], pathMappings: [] };
    try {
        const computed = await resolveIncrementalDependencies(files, allClasses, fileCacheKeys, effectiveOptions.previousResult || null);
        dependencies = computed.edges;
        Object.assign(dependencyDiagnostics, computed.diagnostics);
        dependencyExecution = computed.execution;
        dependencyResolutionCheckpoint = computed.checkpoint;
        markStage('incrementalDependencyResolution', 'complete');
        markStage('dependencies', 'complete');
    } catch (err) {
        markStage('dependencies', 'failed', err);
        markStage('incrementalDependencyResolution', 'failed', err);
        console.warn('[analysis-engine] dependency extraction failed:', err.message);
    }
    report('dependencies', 1, 1);

    report('testLinkage', 0, 1);
    let testLinkage = { schemaVersion: 1, testFileCount: 0, linkedTestFileCount: 0, linkedSourceFileCount: 0, links: [], bySource: {}, unlinkedTestFiles: [], semantics: 'Test linkage is not test coverage or execution.' };
    try {
        testLinkage = analyzeTestLinkage(files, dependencies);
        markStage('testLinkage', 'complete');
    } catch (err) {
        markStage('testLinkage', 'failed', err);
        console.warn('[analysis-engine] test linkage analysis failed:', err.message);
    }
    report('testLinkage', 1, 1);

    report('dataFlow', 0, 1);
    let dataFlow = { schemaVersion: 1, status: 'unavailable', summary: { supportedFiles: 0, filesWithSourceOrSink: 0, sourceEvents: 0, sinkEvents: 0, potentialFlows: 0, resultLimitReached: false }, flows: [], unsupportedFiles: [], semantics: 'Heuristic data-flow scanner did not run.' };
    try {
        dataFlow = analyzeHeuristicDataFlows(files);
        markStage('dataFlow', dataFlow.status === 'partial' ? 'partial' : 'complete', dataFlow.status === 'partial' ? 'One or more source languages are not supported by the heuristic data-flow pass.' : null);
    } catch (err) {
        markStage('dataFlow', 'failed', err);
        console.warn('[analysis-engine] heuristic data-flow scan failed:', err.message);
    }
    report('dataFlow', 1, 1);

    report('patterns', 0, 1);
    let patterns = [];
    try {
        patterns = Parser.detectPatterns(files) || [];
        markStage('patterns', 'complete');
    } catch (err) {
        markStage('patterns', 'failed', err);
        console.warn('[analysis-engine] pattern detection failed:', err.message);
    }

    report('security', 0, 1);
    let securityIssues = [];
    try {
        securityIssues = Parser.detectSecurity(files) || [];
        markStage('security', 'complete');
    } catch (err) {
        markStage('security', 'failed', err);
        console.warn('[analysis-engine] security scan failed:', err.message);
    }

    report('duplicates', 0, 1);
    let duplicates = [];
    try {
        duplicates = Parser.detectDuplicates(files, allFunctions) || [];
        markStage('duplicates', 'complete');
    } catch (err) {
        markStage('duplicates', 'failed', err);
        console.warn('[analysis-engine] duplicate detection failed:', err.message);
    }

    report('callgraph', 0, 1);
    let callConnections = [];
    let functionCallConnections = [];
    let fnStats = {};
    let callGraphDiagnostics = { totalCallNameReferences: 0, resolvedCallNameReferences: 0, unresolvedCallCount: 0, ambiguousCallCount: 0, unresolvedCalls: [] };
    try {
        ({ connections: callConnections, functionConnections: functionCallConnections, fnStats, diagnostics: callGraphDiagnostics } = buildCallGraph(files, allFunctions, dependencies));
        markStage('callGraph', (callGraphDiagnostics.unresolvedCallCount || callGraphDiagnostics.ambiguousCallCount) ? 'partial' : 'complete');
    } catch (err) {
        markStage('callGraph', 'failed', err);
        console.warn('[analysis-engine] call graph resolution failed:', err.message);
    }

    // Enrich file-level test links with resolved function calls. Static linkage
    // is not execution coverage and does not prove that assertions are useful.
    try {
        testLinkage = analyzeTestLinkage(files, dependencies, functionCallConnections);
        markStage('testLinkage', 'complete');
    } catch (err) {
        markStage('testLinkage', 'partial', err);
        console.warn('[analysis-engine] function-level test linkage failed:', err.message);
    }

    // Bounded source-to-sink tracing across resolved caller/callee edges.
    try {
        const interprocedural = analyzeInterproceduralDataFlows(files, allFunctions, functionCallConnections);
        dataFlow.interprocedural = interprocedural;
        dataFlow.summary = {
            ...(dataFlow.summary || {}),
            interproceduralPotentialFlows: interprocedural.summary?.potentialFlows || 0,
            interproceduralStatesProcessed: interprocedural.summary?.statesProcessed || 0,
        };
        dataFlow.flows = [...(dataFlow.flows || []), ...(interprocedural.flows || [])].slice(0, 500);
        dataFlow.status = interprocedural.status === 'partial' ? 'partial' : (dataFlow.status || 'heuristic-limited');
        markStage('dataFlow', interprocedural.status === 'partial' ? 'partial' : 'complete');
    } catch (err) {
        dataFlow.interprocedural = { schemaVersion: 1, status: 'failed', flows: [], error: String(err.message || err).slice(0, 240), semantics: 'Interprocedural analysis failed; no result is not proof of safety.' };
        markStage('dataFlow', 'partial', err);
        console.warn('[analysis-engine] interprocedural data-flow failed:', err.message);
    }

    let executionIntelligence = { schemaVersion: 1, status: 'unavailable', flows: [], clientLinks: [], summary: {}, semantics: 'Static execution intelligence did not run.' };
    // Endpoint discovery is run later alongside API contract generation; this
    // pass is run there as well, once routes and client HTTP calls are known.
    let frameworkAnalysis = { schemaVersion: 1, status: 'unavailable', signalCount: 0, signals: [], semantics: 'Framework evidence analysis did not run.' };
    try {
        frameworkAnalysis = analyzeFrameworkSignals(files, { functions: allFunctions });
        markStage('frameworkAnalysis', frameworkAnalysis.status === 'partial' ? 'partial' : 'complete');
    } catch (err) {
        markStage('frameworkAnalysis', 'failed', err);
        console.warn('[analysis-engine] framework signal analysis failed:', err.message);
    }

    let layerViolations = [];
    try {
        const callLayerViolations = Parser.detectLayerViolations(files, callConnections) || [];
        const importLayerViolations = computeDependencyLayerViolations(files, dependencies);
        const seenLayerPairs = new Set();
        layerViolations = [...importLayerViolations, ...callLayerViolations].filter((violation) => {
            const key = `${violation.from}|${violation.to}`;
            if (seenLayerPairs.has(key)) return false;
            seenLayerPairs.add(key);
            return true;
        });
        markStage('layerViolations', 'complete');
    } catch (err) {
        markStage('layerViolations', 'failed', err);
        console.warn('[analysis-engine] layer violation detection failed:', err.message);
    }

    let issues = [];
    try {
        issues = buildIssues({ files, connections: callConnections, dependencies, fnStats, duplicates, layerViolations });
        markStage('issues', 'complete');
    } catch (err) {
        markStage('issues', 'failed', err);
        console.warn('[analysis-engine] issue derivation failed:', err.message);
    }

    const languageStats = buildLanguageStats(
        files.map((f) => ({ path: f.path, loc: f.content.split('\n').length }))
    );

    // --- Phase 1: entry-point ranking, confidence tagging, safe-to-touch ---
    report('insights', 0, 1);
    let entryPoints = [];
    let importantFiles = [];
    let safeToTouch = {};
    try {
        entryPoints = computeEntryPoints({ files, dependencies, fnStats });
        importantFiles = computeImportantFiles({ files, dependencies });
        const impactConnections = [
            ...callConnections,
            ...dependencies.map((edge) => ({ source: edge.target, target: edge.source, type: 'dependency', count: 0 })),
        ];
        safeToTouch = computeSafeToTouch({ files, connections: impactConnections });
        ({ issues, securityIssues, duplicates } = tagFindings({ issues, securityIssues, duplicates }));
        markStage('insights', 'complete');
    } catch (err) {
        markStage('insights', 'failed', err);
        console.warn('[analysis-engine] insights (entry-points/confidence/safe-to-touch) failed:', err.message);
    }
    report('insights', 1, 1);

    // --- Phase 2: role classification, execution/flow tracing ---
    report('roles', 0, 1);
    let roles = {};
    let flowTraces = [];
    try {
        roles = computeRoleClassification(files);
        flowTraces = computeFlowTraces(entryPoints, callConnections, roles);
        markStage('roles', 'complete');
    } catch (err) {
        markStage('roles', 'failed', err);
        console.warn('[analysis-engine] role classification / flow tracing failed:', err.message);
    }
    report('roles', 1, 1);

    // --- Phase 3, batch 1: migration risk score + dependency-safe order ---
    report('migrate', 0, 1);
    let migrationRisk = {};
    let migrationOrder = { order: [], totalBatches: 0 };
    try {
        migrationRisk = computeMigrationRisk({ files, safeToTouch, securityIssues });
        migrationOrder = computeMigrationOrder({ files, dependencies });
        markStage('migration', 'complete');
    } catch (err) {
        markStage('migration', 'failed', err);
        console.warn('[analysis-engine] migration risk/order failed:', err.message);
    }
    report('migrate', 1, 1);

    // --- Phase 3, batch 2: API endpoint discovery + cURL/Postman gen ---
    report('api', 0, 1);
    let apiEndpoints = [];
    let postmanCollection = null;
    let apiContractAnalysis = { schemaVersion: 1, status: 'unknown', clientCalls: 0, matchedCalls: 0, mismatchCount: 0, unknownCalls: 0, findings: [], semantics: 'API contract analysis did not run.' };
    try {
        apiEndpoints = discoverEndpoints(files);
        apiEndpoints = apiEndpoints.map((ep) => ({ ...ep, curl: generateCurl(ep) }));
        apiContractAnalysis = analyzeApiContracts(files, apiEndpoints);
        executionIntelligence = analyzeExecutionIntelligence({
            endpoints: apiEndpoints, clientCalls: extractClientApiCalls(files),
            functions: allFunctions, functionConnections: functionCallConnections, files,
        });
        markStage('executionIntelligence', executionIntelligence.status === 'partial' ? 'partial' : 'complete');
        postmanCollection = generatePostmanCollection(apiEndpoints, repoMeta.name || 'Discovered API');
        markStage('api', 'complete');
    } catch (err) {
        markStage('api', 'failed', err);
        console.warn('[analysis-engine] API endpoint discovery failed:', err.message);
    }
    report('api', 1, 1);
    // Note: API breaking-change risk (detectApiBreakingChanges in api.js) needs
    // TWO snapshots to diff — the caller re-invokes it across re-analyses,
    // passing the previously stored `apiEndpoints` in; a single analysis run
    // has nothing to compare against yet.

    let semanticIntelligence = { schemaVersion: 1, status: 'unavailable', symbols: [], calls: [], inheritance: [] };
    try {
        semanticIntelligence = analyzeSemanticIntelligence({ files, functions: allFunctions,
            classes: allClasses, dependencies, functionConnections: functionCallConnections });
        markStage('semanticIntelligence', semanticIntelligence.status === 'bounded' ? 'partial' : 'complete');
    } catch (error) { markStage('semanticIntelligence', 'failed', error); }

    const runtimeEvidence = correlateRuntimeEvidence(effectiveOptions.runtimeSpans || [], apiEndpoints);
    // --- Phase 3, batch 3: architecture insights ---
    report('architecture', 0, 1);
    let moduleBoundaries = { modules: [], edges: [], weakBoundaries: [] };
    let domainClusters = [];
    let architectureDrift = { violationCount: 0, driftPct: 0, level: 'low', worstOffenders: [] };
    let configLinkage = { links: [], referencedButNotDefined: [] };
    let externalBoundaries = [];
    let errorHandlingCoverage = [];
    let dataOwnership = [];
    try {
        moduleBoundaries = computeModuleBoundaries({ files, dependencies });
        domainClusters = computeDomainClusters(files);
        const driftEdges = [...dependencies, ...callConnections.map((edge) => ({
            source: edge.target, target: edge.source, type: 'call', resolution: edge.resolution || 'resolved',
        }))];
        const uniqueDriftEdges = [...new Map(driftEdges.map((edge) => [`${edge.source}|${edge.target}|${edge.type}`, edge])).values()];
        architectureDrift = computeArchitectureDrift({ layerViolations, connections: uniqueDriftEdges });
        configLinkage = computeConfigToCodeLinkage(files);
        externalBoundaries = computeExternalBoundaries(files);
        const filesByPath = new Map(files.map((f) => [f.path, f]));
        errorHandlingCoverage = computeErrorHandlingCoverage(flowTraces, filesByPath);
        dataOwnership = computeDataOwnership({ connections: callConnections, roles });
        markStage('architecture', 'complete');
    } catch (err) {
        markStage('architecture', 'failed', err);
        console.warn('[analysis-engine] architecture insights failed:', err.message);
    }
    report('architecture', 1, 1);

    // Structural graph intelligence uses only known in-snapshot dependency edges.
    let architectureIntelligence = { schemaVersion: 1, status: 'unavailable', cycles: [], hotspots: [], summary: {}, semantics: 'Analysis did not run.' };
    try {
        architectureIntelligence = analyzeArchitectureIntelligence(files, dependencies);
        markStage('architectureIntelligence', architectureIntelligence.status);
    } catch (err) {
        markStage('architectureIntelligence', 'failed', err);
        console.warn('[analysis-engine] structural graph analysis failed:', err.message);
    }


    // --- Phase 3, batch 4: DB/data layer ---
    report('db', 0, 1);
    let databaseSchema = { tables: [], mermaidErDiagram: null };
    let orphanTables = [];
    try {
        databaseSchema = extractDatabaseSchema(files);
        orphanTables = detectOrphanTables(databaseSchema.tables, files);
        markStage('database', 'complete');
    } catch (err) {
        markStage('database', 'failed', err);
        console.warn('[analysis-engine] DB schema extraction failed:', err.message);
    }
    report('db', 1, 1);

    // --- Phase 3, batch 5: security deepening ---
    report('security', 0, 1);
    let crossSystemIntelligence = { schemaVersion: 1, status: 'unavailable', messages: [], messageLinks: [], sqlOperations: [], databaseLinks: [] };
    try {
        crossSystemIntelligence = analyzeCrossSystemIntelligence(files, databaseSchema);
        markStage('crossSystemIntelligence', crossSystemIntelligence.status === 'bounded' ? 'partial' : 'complete');
    } catch (error) { markStage('crossSystemIntelligence', 'failed', error); }

    const businessIntelligence = analyzeBusinessIntelligence(files, { functions:allFunctions });

    // Evidence integrity covers the newly introduced semantic and system links
    // as well as previously supported dependency/call/API relationships.
    let evidenceAudit = { schemaVersion: 1, status: 'unavailable', summary: {}, problems: [] };
    try {
        evidenceAudit = auditSourceEvidence(files, {
            dependencies, functionConnections: functionCallConnections, endpoints: apiEndpoints,
            semanticIntelligence, crossSystemIntelligence, businessIntelligence,
        });
        markStage('evidenceAudit', evidenceAudit.status === 'failed' ? 'partial' : evidenceAudit.status);
    } catch (error) { markStage('evidenceAudit', 'failed', error); }

    let authCoverage = { totalEndpoints: 0, protectedCount: 0, unprotectedCount: 0, coveragePct: 0, files: [] };
    try {
        authCoverage = computeAuthCoverageMap(apiEndpoints);
        const advancedSecrets = detectAdvancedSecrets(files);
        securityIssues = securityIssues.concat(advancedSecrets);
        markStage('securityDeepening', 'complete');
    } catch (err) {
        markStage('securityDeepening', 'failed', err);
        console.warn('[analysis-engine] security deepening failed:', err.message);
    }
    report('security', 1, 1);

    // --- Phase 3, batch 7: dependency/supply-chain ---
    report('dependencies', 0, 1);
    let dependencyInventory = { dependencies: [], totalCount: 0, byEcosystem: {} };
    let licenseCompliance = { results: [], copyleftFlags: [], unknownCount: 0, totalChecked: 0 };
    let dependencyUsage = { schemaVersion: 1, status: 'unknown', dependencies: [], candidates: [], semantics: 'Dependency usage analysis did not run.' };
    try {
        dependencyInventory = extractDependencyInventory(files);
        licenseCompliance = checkLicenseCompliance(dependencyInventory);
        markStage('dependencyInventory', 'complete');
    } catch (err) {
        markStage('dependencyInventory', 'failed', err);
        console.warn('[analysis-engine] dependency inventory/license check failed:', err.message);
    }
    try {
        dependencyUsage = analyzeDependencyUsage(files, dependencyInventory);
        markStage('dependencyUsage', 'complete'); // execution completed; matching caveats are exposed in dependencyUsage.status
    } catch (err) {
        markStage('dependencyUsage', 'failed', err);
        console.warn('[analysis-engine] dependency usage analysis failed:', err.message);
    }
    report('dependencies', 1, 1);

    // --- Phase 3, batch 9: comments/naming/similarity ---
    report('quality', 0, 1);
    let todoComments = [];
    let documentationCoverage = { totalFunctions: 0, documented: 0, coveragePct: 0, undocumentedSample: [] };
    let configMisconfig = [];
    let namingViolations = [];
    let openApiSpec = { spec: null };
    let a11yFindings = [];
    try {
        todoComments = mineTodoComments(files);
        documentationCoverage = computeDocumentationCoverage(files, allFunctions);
        configMisconfig = scanConfigMisconfig(files);
        namingViolations = checkNamingConventions(allFunctions);
        openApiSpec = generateOpenApiSpec(apiEndpoints, repoMeta.name || 'Discovered API');
        a11yFindings = scanBasicA11y(files);
        markStage('quality', 'complete');
    } catch (err) {
        markStage('quality', 'failed', err);
        console.warn('[analysis-engine] quality checks (TODOs/docs/naming/OpenAPI/a11y) failed:', err.message);
    }
    report('quality', 1, 1);

    const unusedIssue = issues.find((item) => String(item.title || '').includes('Unused Functions'));
    const deadFunctionCount = unusedIssue?.items?.length || 0;

    const graphNodes = files.map((f) => ({ id: f.path, label: f.path.split('/').pop() }));
    const graphEdges = dependencies.map((d) => ({ source: d.source, target: d.target, type: d.type, resolution: d.resolution, confidence: d.confidence, line: d.line, evidence: d.evidence }));

    const stats = {
        files: files.length,
        functions: allFunctions.length,
        classes: allClasses.length,
        connections: dependencies.length,
        dead: deadFunctionCount,
    };

    let healthScore = { score: null, grade: null, status: 'unknown' };
    try {
        healthScore = { ...calcHealth({ stats, issues, securityIssues }), status: 'complete' };
        markStage('healthScore', 'complete');
    } catch (err) {
        markStage('healthScore', 'failed', err);
        console.warn('[analysis-engine] health score calculation failed:', err.message);
    }

    report('done', 1, 1);

    const functionComplexity = buildFunctionComplexitySummary(files, allFunctions);
    let maintainabilityMetrics = { schemaVersion: 1, status: 'unavailable', totalFunctions: allFunctions.length, analyzedFunctions: 0, skippedFunctions: allFunctions.length, findings: [], semantics: 'Maintainability metric pass did not run.' };
    try {
        maintainabilityMetrics = buildMaintainabilityMetrics(files, allFunctions);
        markStage('maintainabilityMetrics', maintainabilityMetrics.status === 'partial' ? 'partial' : 'complete');
    } catch (err) {
        markStage('maintainabilityMetrics', 'failed', err);
        console.warn('[analysis-engine] maintainability metrics failed:', err.message);
    }
    let findings = [
        ...issues.map((item, index) => normalizeFinding(item, 'architecture', index, files)),
        ...securityIssues.map((item, index) => normalizeFinding(item, 'security', index, files)),
        ...duplicates.map((item, index) => normalizeFinding(item, 'duplication', index, files)),
        ...configMisconfig.map((item, index) => normalizeFinding(item, 'configuration', index, files)),
        ...namingViolations.map((item, index) => normalizeFinding(item, 'naming', index, files)),
        ...(apiContractAnalysis.findings || []).map((item, index) => normalizeFinding(item, 'api-contract', index, files)),
        ...a11yFindings.map((item, index) => normalizeFinding(item, 'accessibility', index, files)),
        ...(maintainabilityMetrics.findings || []).map((item, index) => normalizeFinding(item, 'maintainability', index, files)),
    ];

    // V5: rule-config loading is isolated from the core parser and the extra
    // analyzers consume the same file/symbol/graph facts as other passes.
    const customRuleConfig = loadCustomRules(files);
    const customRules = runCustomRules(files, customRuleConfig);
    markStage('customRules', customRules.status === 'partial' ? 'partial' : customRules.status === 'failed' ? 'failed' : 'complete');
    const advancedAnalysis = runAdvancedAnalysis({
        files, functions: allFunctions, classes: allClasses, dependencies,
        callGraph: { connections: callConnections, functionConnections: functionCallConnections, diagnostics: callGraphDiagnostics },
        apiEndpoints, databaseSchema, testLinkage, dataFlow, findings,
        architectureDrift, frameworkAnalysis, configLinkage,
    }, customRules);
    findings = [
        ...findings,
        ...(advancedAnalysis.findings || []).map((item, index) => normalizeFinding(item, item.category || 'advanced-analysis', index, files)),
    ];
    markStage('advancedAnalysis', advancedAnalysis.status === 'partial' ? 'partial' : 'complete');
    const findingDeduplication = deduplicateFindings(findings);
    findings = findingDeduplication.findings;
    markStage('findingDeduplication', 'complete');
    const suppressionConfig = loadFindingSuppressions(files);
    const suppressionResult = applyFindingSuppressions(findings, suppressionConfig);
    findings = suppressionResult.findings;
    markStage('findingSuppressions', suppressionResult.status === 'partial' ? 'partial' : suppressionResult.status === 'failed' ? 'failed' : 'complete');
    if (stageStatuses.executionIntelligence.status === 'unknown') markStage('executionIntelligence', 'partial', 'Endpoint discovery unavailable');
    const analysisCoverage = buildAnalysisCoverage({ files, fileStatuses, stageStatuses });
    applyInputPreparationCoverage(analysisCoverage, normalizedInput.diagnostics);
    analysisCoverage.languageDepth = summarizeLanguageDepth(fileStatuses);
    analysisCoverage.dependencyResolution = summarizeDependencyResolution(dependencies, dependencyDiagnostics);
    analysisCoverage.dependencyUsage = { status: dependencyUsage.status || 'unknown', totalDependencies: dependencyUsage.totalDependencies || 0, unusedCandidates: dependencyUsage.unusedCandidates || 0, semantics: dependencyUsage.semantics || null };
    applyDependencyResolutionCoverage(analysisCoverage);
    applyCallGraphCoverage(analysisCoverage, callGraphDiagnostics);
    applyFunctionComplexityCoverage(analysisCoverage, functionComplexity);
    analysisCoverage.maintainabilityMetrics = {
        status: maintainabilityMetrics.status || 'unknown',
        totalFunctions: maintainabilityMetrics.totalFunctions || 0,
        analyzedFunctions: maintainabilityMetrics.analyzedFunctions || 0,
        skippedFunctions: maintainabilityMetrics.skippedFunctions || 0,
        coveragePct: maintainabilityMetrics.coveragePct ?? null,
    };
    analysisCoverage.frameworkAnalysis = {
        status: frameworkAnalysis.status || 'unknown',
        signalCount: frameworkAnalysis.signalCount || 0,
        routeCount: frameworkAnalysis.routeSummary?.total || 0,
        resolvedRouteHandlers: frameworkAnalysis.routeSummary?.resolvedHandlers || 0,
        unresolvedRouteHandlers: frameworkAnalysis.routeSummary?.unresolvedHandlers || 0,
        detectedFrameworks: frameworkAnalysis.detectedFrameworks || [],
    };
    const healthScoreDetails = buildHealthScoreDetails({ stats, issues, securityIssues, healthScore, coverage: analysisCoverage });
    const analysisSnapshot = await createAnalysisSnapshot(files, {
        engineVersion: ENGINE_VERSION,
        parserMode: `acorn:${typeof globalThis.acorn !== 'undefined'};babel:${typeof globalThis.Babel !== 'undefined'}`,
    });

    const result = {
        engineVersion: ENGINE_VERSION,
        analysisSnapshot,
        extractionSnapshot,
        dependencyResolutionCheckpoint,
        dependencyExecution,
        semanticIntelligence,
        crossSystemIntelligence,
        businessIntelligence,
        syntaxDiagnostics,
        executionIntelligence,
        runtimeEvidence,
        evidenceAudit,
        repository: (() => { const safeMeta = { ...(repoMeta || {}) }; delete safeMeta.analysisOptions; return safeMeta; })(),
        analysisInput: {
            suppliedFiles: normalizedInput.diagnostics?.inputFiles ?? rawFiles.length,
            discoveredFiles: files.length,
            excludedFiles: normalizedInput.diagnostics?.excludedFiles || 0,
            excludedByReason: normalizedInput.diagnostics?.excludedByReason || {},
            skippedFiles: (normalizedInput.diagnostics?.skippedFiles || []).slice(0, 200),
            sourceBytes: normalizedInput.totalBytes,
            totalInputBytes: normalizedInput.diagnostics?.totalInputBytes ?? normalizedInput.totalBytes,
            codeFiles: files.filter((file) => Parser.isCode(file.name)).length,
            nonCodeFiles: files.filter((file) => !Parser.isCode(file.name)).length,
            limits: normalizedInput.diagnostics?.limits || { maxFiles: MAX_ANALYSIS_FILES, maxTotalBytes: MAX_ANALYSIS_TOTAL_BYTES, maxFileBytes: MAX_ANALYSIS_FILE_BYTES },
            semantics: 'discoveredFiles counts included files; suppliedFiles counts input records; excluded files are listed separately and can make analysis coverage partial.',
        },
        analysisCoverage,
        functionComplexity,
        analysisCache: { ...analysisCacheStats, ...getAnalysisCacheStats(), moduleResolution: getModuleResolutionCacheStats(), enabled: analysisCacheStats.eligibleFiles > 0, scope: 'bounded per-file extraction/complexity cache, portable dependency-resolution checkpoint when the entire resolution context is unchanged; downstream graphs recompute' },
        healthScoreDetails,
        findings,
        advancedAnalysis,
        customRules,
        findingSuppression: { status: suppressionResult.status, summary: suppressionResult.summary, diagnostics: suppressionResult.diagnostics, semantics: suppressionResult.semantics },
        analysisExports: { schemaVersion: 1, formats: ['analysis-json', 'SARIF 2.1.0', 'Markdown architecture report'], sarifEntryPoint: 'toSarifLog(result)', jsonEntryPoint: 'toAnalysisJson(result)', markdownEntryPoint: 'result.architectureReport' },
        findingDeduplication,
        dependencyUsage,
        incrementalAnalysis: { ...buildIncrementalAnalysisPlan(effectiveOptions.previousResult || null, files, dependencies, dependencyDiagnostics),
            dependencyExecution, incrementalDependencyExecutionImplemented: dependencyExecution.mode === 'partial-dependency-resolution' },
        architectureIntelligence,
        analysisMetrics: null,
        files: files.map((f) => ({
            path: f.path,
            language: guessLanguage(f.path),
            loc: f.content.split('\n').length,
            content: f.content,
            layer: f.layer,
            complexity: f.complexity,
            functionCount: f.functionCount,
        })),
        functions: allFunctions.map((fn) => ({
            name: fn.name,
            file: fn.file,
            line: fn.line,
            endLine: fn.endLine ?? fn.line,
            type: fn.type,
            isTopLevel: !!fn.isTopLevel,
            isExported: !!fn.isExported,
            code: fn.code,
        })),
        classes: allClasses,
        // Import bindings are internal resolver metadata. Keep the published
        // graph evidence, but avoid leaking adapter-only fields into the Java
        // ingestion DTO. The call graph above has already consumed bindings.
        imports: dependencies.filter((d) => d.type === 'import').map(({ importBindings, ...edge }) => edge),
        dependencies: dependencies.map(({ importBindings, ...edge }) => edge),
        testLinkage,
        dataFlow,
        maintainabilityMetrics,
        frameworkAnalysis,
        changeImpactModel: {
            schemaVersion: 1,
            entryPoint: 'computeChangeImpact(changedPath, dependencies, analysisCoverage.dependencyResolution)',
            semantics: 'Conservative reverse-dependency estimate; unresolved or ambiguous imports may hide impact paths.',
        },
        functionImpactModel: {
            schemaVersion: 1,
            entryPoint: 'computeFunctionImpact(changedFunctionKey, callGraph.functionConnections, callGraph.diagnostics)',
            functionKeyFormat: 'file|line|name',
            semantics: 'Reverse caller impact over uniquely resolved call-name edges; caller-function attribution is heuristic and can be incomplete.',
        },
        graph: { nodes: graphNodes, edges: graphEdges },
        patterns,
        securityIssues,
        duplicates,
        healthScore,
        // Frontend-only fields (Visualization Explorer reads these directly from
        // the Live Analysis Model) — not part of the backend ingest contract's
        // "known" fields, but AnalysisIngestRequest tolerates extra fields
        // (see its @JsonIgnoreProperties note) so this can still be POSTed as-is.
        issues,
        languageStats,
        callGraph: { connections: callConnections, functionConnections: functionCallConnections, fnStats, diagnostics: callGraphDiagnostics },
        // Phase 1 additions — "where to start reading", most-important-files
        // ranking, and a repo-wide safe-to-touch/blast-radius map. Every
        // entry in these three carries a confidence/provenance tag
        // (FACT/INFERENCE/UNCERTAIN + reason), per the mandatory tagging
        // rule applied to issues/securityIssues/duplicates above.
        entryPoints,
        importantFiles,
        safeToTouch,
        // Phase 2 additions — per-file architectural role (Controller/
        // Service/Repository/etc., folder-independent) and a handful of
        // "typical request path" traces from the top entry points.
        roles,
        flowTraces,
        // Phase 3 batch 1 — Migrate page: per-file risk score and a
        // dependency-safe migration batch order (topological sort, cycles
        // flagged rather than silently broken).
        migrationRisk,
        migrationOrder,
        // Phase 3 batch 2 — API Analysis: discovered endpoints (with a
        // ready-to-run cURL command each) and a Postman collection built
        // from the same list.
        apiEndpoints,
        apiContractAnalysis,
        postmanCollection,
        // Phase 3 batch 3 — Architecture: module boundaries, naming-token
        // domain clusters, layering drift, config<->code linkage, external
        // system boundaries, error-handling coverage per traced flow, and
        // Service->Entity write ownership.
        moduleBoundaries,
        domainClusters,
        architectureDrift,
        configLinkage,
        externalBoundaries,
        errorHandlingCoverage,
        dataOwnership,
        // Phase 3 batch 4 — DB/Data layer: extracted schema (+ Mermaid ER
        // diagram) and tables/entities with no FK relationship or code
        // reference found.
        databaseSchema,
        orphanTables,
        // Phase 3 batch 5 — Security deepening: endpoint auth coverage
        // (repo-wide + per-file) and additional hardcoded-secret shapes
        // (cloud keys, PEM blocks, credentials in connection strings)
        // merged into securityIssues alongside the existing checks.
        authCoverage,
        // Phase 3 batch 7 — Dependency/supply-chain: manifest-parsed
        // third-party inventory, and a best-effort (offline, small known-
        // license table) compliance check — see dependencies.js for why
        // this can't be a full registry-backed audit.
        dependencyInventory,
        dependencyUsage,
        licenseCompliance,
        // Phase 3 batch 9 — Comments/Naming/Similarity: TODO/FIXME/HACK
        // mining, doc-comment coverage %, non-secret config misconfig
        // scanning, function naming-convention checker, a best-effort
        // OpenAPI spec generated from discovered endpoints, and a
        // narrow-scope (alt-text + ARIA-role) accessibility scan.
        todoComments,
        documentationCoverage,
        configMisconfig,
        namingViolations,
        openApiSpec,
        a11yFindings,
    };

    // Test candidates are only relevant with a baseline snapshot; never imply
    // that tests were actually executed or that they prove change safety.
    const changedPaths = result.incrementalAnalysis?.available ? result.incrementalAnalysis.changedFiles : [];
    const previousTestLinks = Array.isArray(effectiveOptions.previousResult?.testLinkage?.links) ? effectiveOptions.previousResult.testLinkage.links : [];
    const liveFilePaths = new Set(files.map((file) => file.path));
    const combinedTestLinks = [...(testLinkage.links || []), ...previousTestLinks].filter((link) => liveFilePaths.has(link?.testFile));
    const combinedTestBySource = Object.create(null);
    for (const link of combinedTestLinks) {
        if (!link?.sourceFile || !link?.testFile) continue;
        (combinedTestBySource[link.sourceFile] ||= []).push(link);
    }
    const previousDependencyEdges = Array.isArray(effectiveOptions.previousResult?.dependencies) ? effectiveOptions.previousResult.dependencies : [];
    result.changeReview = result.incrementalAnalysis?.available
        ? recommendTestsForChanges(changedPaths, [...previousDependencyEdges, ...dependencies], { bySource: combinedTestBySource }, dependencyDiagnostics, { existingPaths: [...liveFilePaths] })
        : { schemaVersion: 1, available: false, recommendedTests: [], semantics: 'Provide a previous analysis snapshot to get change-specific test recommendations.' };
    if (result.incrementalAnalysis?.available) result.changeReview.available = true;

    // V5 unified model is generated from the same deterministic output facts.
    // Keep a diagnostics contract so downstream consumers can query/slice this model.
    try {
        result.analysisModel = enrichSystemKnowledgeGraph(buildUnifiedAnalysisModel(result), { crossSystemIntelligence, executionIntelligence, businessIntelligence });
        markStage('unifiedModel', result.analysisModel.diagnostics?.danglingEdgeCount ? 'partial' : 'complete');
    } catch (err) {
        result.analysisModel = { schemaVersion: 1, status: 'failed', entities: [], edges: [], summary: { entityCount: 0, edgeCount: 0 }, diagnostics: { error: String(err.message || err).slice(0, 240) } };
        markStage('unifiedModel', 'failed', err);
    }
    result.graphQuality = auditEngineeringGraph(result.analysisModel, files);
    result.analysisQuery = {
        schemaVersion: 1,
        queryEntryPoint: 'queryAnalysisModel(result.analysisModel, query)',
        sliceEntryPoint: 'sliceAnalysisModel(result.analysisModel, options)',
        flowEntryPoint: 'traceEngineeringFlows(result.analysisModel, startEntityId, options)',
        impactEntryPoint: 'computeEngineeringImpact(result.analysisModel, changedEntityIds, options)',
        evidenceContextEntryPoint: 'buildEngineeringQuestionContext(result.analysisModel, question, options)',
        diffEntryPoint: 'compareAnalysisResults(previousResult, currentResult)',
        semantics: 'Query/slice/diff operate on represented model facts; omitted or unresolved behavior cannot be queried as if it were known.',
    };
    result.analysisCoverage.advancedAnalysis = { status: advancedAnalysis.status, summary: advancedAnalysis.summary, coverage: advancedAnalysis.coverage };
    result.analysisCoverage.customRules = { status: customRules.status, ruleCount: customRules.ruleCount, diagnosticCount: customRules.diagnostics?.length || 0 };
    result.analysisCoverage.findingSuppressions = { status: suppressionResult.status, summary: suppressionResult.summary, diagnosticCount: suppressionResult.diagnostics?.length || 0 };
    result.analysisCoverage.graphQuality = { status:result.graphQuality.status, summary:result.graphQuality.summary };
    result.analysisCoverage.unifiedModel = { status: result.analysisModel.status || 'complete', summary: result.analysisModel.summary, diagnostics: result.analysisModel.diagnostics };
    result.analysisMetrics = buildAnalysisMetrics({
        files: result.files, functions: result.functions, classes: result.classes, dependencies: result.dependencies,
        callGraph: result.callGraph, findings: result.findings, analysisCoverage: result.analysisCoverage,
        healthScoreDetails: result.healthScoreDetails, apiEndpoints: result.apiEndpoints,
        databaseSchema: result.databaseSchema, testLinkage: result.testLinkage,
        findingDeduplication: result.findingDeduplication,
    });

    // Phase 3 batch 8 — Documentation: one Markdown architecture report
    // aggregating everything above, generated last so it can summarize
    // the full result object.
    let architectureReport = null;
    let architectureReportStatus = 'complete';
    try {
        architectureReport = generateArchitectureReport(repoMeta, result);
    } catch (err) {
        architectureReportStatus = 'failed';
        console.warn('[analysis-engine] architecture report generation failed:', err.message);
    }
    result.architectureReport = architectureReport;
    result.architectureReportStatus = architectureReportStatus;
    // Refresh after report generation so the final coverage includes its actual result.
    result.analysisCoverage = buildAnalysisCoverage({ files, fileStatuses, stageStatuses });
    applyInputPreparationCoverage(result.analysisCoverage, normalizedInput.diagnostics);
    result.analysisCoverage.languageDepth = summarizeLanguageDepth(fileStatuses);
    result.analysisCoverage.dependencyResolution = summarizeDependencyResolution(dependencies, dependencyDiagnostics);
    result.analysisCoverage.dependencyUsage = { status: dependencyUsage.status || 'unknown', totalDependencies: dependencyUsage.totalDependencies || 0, unusedCandidates: dependencyUsage.unusedCandidates || 0, semantics: dependencyUsage.semantics || null };
    applyDependencyResolutionCoverage(result.analysisCoverage);
    applyCallGraphCoverage(result.analysisCoverage, callGraphDiagnostics);
    applyFunctionComplexityCoverage(result.analysisCoverage, functionComplexity);
    result.analysisCoverage.maintainabilityMetrics = {
        status: maintainabilityMetrics.status || 'unknown', totalFunctions: maintainabilityMetrics.totalFunctions || 0,
        analyzedFunctions: maintainabilityMetrics.analyzedFunctions || 0, skippedFunctions: maintainabilityMetrics.skippedFunctions || 0,
        coveragePct: maintainabilityMetrics.coveragePct ?? null,
    };
    result.analysisCoverage.frameworkAnalysis = {
        status: frameworkAnalysis.status || 'unknown', signalCount: frameworkAnalysis.signalCount || 0,
        routeCount: frameworkAnalysis.routeSummary?.total || 0, resolvedRouteHandlers: frameworkAnalysis.routeSummary?.resolvedHandlers || 0,
        unresolvedRouteHandlers: frameworkAnalysis.routeSummary?.unresolvedHandlers || 0, detectedFrameworks: frameworkAnalysis.detectedFrameworks || [],
    };
    result.analysisCoverage.advancedAnalysis = { status: advancedAnalysis.status, summary: advancedAnalysis.summary, coverage: advancedAnalysis.coverage };
    result.analysisCoverage.customRules = { status: customRules.status, ruleCount: customRules.ruleCount, diagnosticCount: customRules.diagnostics?.length || 0 };
    result.analysisCoverage.findingSuppressions = { status: suppressionResult.status, summary: suppressionResult.summary, diagnosticCount: suppressionResult.diagnostics?.length || 0 };
    result.analysisCoverage.graphQuality = { status:result.graphQuality.status, summary:result.graphQuality.summary };
    result.analysisCoverage.unifiedModel = { status: result.analysisModel?.status || 'complete', summary: result.analysisModel?.summary || null, diagnostics: result.analysisModel?.diagnostics || null };
    result.healthScoreDetails = buildHealthScoreDetails({ stats, issues, securityIssues, healthScore, coverage: result.analysisCoverage });
    result.analysisMetrics = buildAnalysisMetrics({
        files: result.files, functions: result.functions, classes: result.classes, dependencies: result.dependencies,
        callGraph: result.callGraph, findings: result.findings, analysisCoverage: result.analysisCoverage,
        healthScoreDetails: result.healthScoreDetails, apiEndpoints: result.apiEndpoints,
        databaseSchema: result.databaseSchema, testLinkage: result.testLinkage,
        findingDeduplication: result.findingDeduplication,
    });
    result.outputContractValidation = validateAnalysisResult(result);

    return result;
}

function guessLanguage(path) {
    const ext = String(path || '').slice(String(path || '').lastIndexOf('.')).toLowerCase();
    const map = {
        '.java': 'java', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
        '.ts': 'typescript', '.tsx': 'typescript', '.vue': 'vue', '.svelte': 'svelte',
        '.py': 'python', '.pyw': 'python', '.pyi': 'python', '.go': 'go', '.rb': 'ruby', '.php': 'php',
        '.rs': 'rust', '.c': 'c', '.h': 'c-header', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp-header',
        '.cs': 'csharp', '.kt': 'kotlin', '.kts': 'kotlin', '.swift': 'swift', '.scala': 'scala',
        '.clj': 'clojure', '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hs': 'haskell',
        '.lua': 'lua', '.r': 'r', '.jl': 'julia', '.dart': 'dart', '.elm': 'elm', '.fs': 'fsharp',
        '.fsx': 'fsharp', '.ml': 'ocaml', '.pl': 'perl', '.pm': 'perl', '.sh': 'shell', '.bash': 'shell',
        '.zsh': 'shell', '.fish': 'shell', '.ps1': 'powershell', '.psm1': 'powershell', '.gradle': 'gradle',
        '.groovy': 'groovy', '.vba': 'vba', '.bas': 'vba', '.cls': 'vba', '.sql': 'sql', '.graphql': 'graphql',
        '.gql': 'graphql', '.prisma': 'prisma', '.tf': 'terraform', '.tfvars': 'terraform', '.html': 'html',
        '.htm': 'html', '.xhtml': 'html', '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css',
        '.md': 'markdown', '.markdown': 'markdown', '.json': 'json', '.jsonl': 'jsonl', '.yaml': 'yaml',
        '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml', '.properties': 'properties', '.ini': 'ini',
    };
    return map[ext] || 'other';
}
