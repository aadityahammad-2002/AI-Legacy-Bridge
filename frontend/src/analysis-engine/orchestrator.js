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
import { buildCallGraph, buildIssues, buildLanguageStats } from './callGraph.js';
import { computeEntryPoints, computeImportantFiles, tagFindings, computeSafeToTouch } from './insights.js';
import { computeRoleClassification, computeFlowTraces } from './roles.js';
import { computeMigrationRisk, computeMigrationOrder } from './migrate.js';
import { discoverEndpoints, generateCurl, generatePostmanCollection } from './api.js';
import {
    computeModuleBoundaries, computeDomainClusters, computeArchitectureDrift,
    computeConfigToCodeLinkage, computeExternalBoundaries, computeErrorHandlingCoverage,
    computeDataOwnership,
} from './architecture.js';
import { extractDatabaseSchema, detectOrphanTables } from './db.js';
import { computeAuthCoverageMap, detectAdvancedSecrets } from './security.js';
import { extractDependencyInventory, checkLicenseCompliance } from './dependencies.js';
import {
    mineTodoComments, computeDocumentationCoverage, scanConfigMisconfig,
    checkNamingConventions, generateOpenApiSpec, scanBasicA11y,
} from './quality.js';
import { generateArchitectureReport } from './report.js';

/** Ensures acorn/Babel globals are present (call once at app startup, before analyzing). */
export function configureAnalysisEngine({ acorn, Babel } = {}) {
    if (acorn) globalThis.acorn = acorn;
    if (Babel) globalThis.Babel = Babel;
}

/**
 * Very lightweight class + annotation extraction for JVM-family languages.
 * function-centric (it doesn't model "classes" as a
 * first-class concept), so this pass is ours — it sits on top of Parser's
 * function extraction to additionally capture class-level metadata that our
 * Visualization Explorer and DB schema need (classes table, annotations).
 */
function extractClasses(content, filename) {
    const isJavaFamily = /\.(java|kt|kts|cs|scala)$/i.test(filename);
    if (!isJavaFamily) return [];

    const classes = [];
    const lines = content.split('\n');
    const classRegex = /^\s*(?:public|private|protected)?\s*(?:abstract\s+|final\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
    const annotationRegex = /^\s*@([A-Za-z_][A-Za-z0-9_]*)/;
    const packageRegex = /^\s*package\s+([\w.]+)\s*;/;

    let pkg = null;
    let pendingAnnotations = [];

    lines.forEach((line, idx) => {
        const pkgMatch = line.match(packageRegex);
        if (pkgMatch) pkg = pkgMatch[1];

        const annMatch = line.match(annotationRegex);
        if (annMatch) {
            pendingAnnotations.push(annMatch[1]);
            return; // annotations sit on the line(s) directly above the class/method
        }

        const classMatch = line.match(classRegex);
        if (classMatch) {
            classes.push({
                name: classMatch[1],
                file: filename,
                package: pkg,
                line: idx + 1,
                annotations: pendingAnnotations,
            });
            pendingAnnotations = [];
        } else if (line.trim() !== '') {
            // Non-blank, non-annotation line resets the "pending annotations" buffer
            // once we've moved past consecutive annotation lines.
            if (!annMatch) pendingAnnotations = [];
        }
    });

    return classes;
}

/**
 * Builds simple import-graph edges (file -> file) from raw `import` statements.
 * This is deliberately conservative (string containment on the imported symbol's
 * originating file name) rather than full module resolution — good enough for
 * the dependency graph and blast-radius view, consistent with
 * "heuristic, not 100% accurate" approach documented in its README.
 */
function extractFileDependencies(files, classes = []) {
    const deps = [];
    const byBaseName = new Map();
    files.forEach((f) => {
        const base = f.path.split('/').pop().replace(/\.[^.]+$/, '');
        if (!byBaseName.has(base)) byBaseName.set(base, []);
        byBaseName.get(base).push(f.path);
    });

    const importLineRegex = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;?/;
    const explicitlyImported = new Map();

    files.forEach((file) => {
        const lines = file.content.split('\n');
        const imported = new Set();
        lines.forEach((line) => {
            const m = line.match(importLineRegex);
            if (!m) return;
            const importedSymbol = m[1].split('.').pop();
            imported.add(importedSymbol);
            const targets = byBaseName.get(importedSymbol);
            if (targets) {
                targets.forEach((targetPath) => {
                    if (targetPath !== file.path) {
                        deps.push({ source: file.path, target: targetPath, type: 'import' });
                    }
                });
            }
        });
        explicitlyImported.set(file.path, imported);
    });

    const classesByFile = new Map();
    const filesByPackage = new Map();
    classes.forEach((c) => {
        if (!classesByFile.has(c.file)) classesByFile.set(c.file, []);
        classesByFile.get(c.file).push(c);
        if (!c.package) return;
        if (!filesByPackage.has(c.package)) filesByPackage.set(c.package, []);
        filesByPackage.get(c.package).push({ file: c.file, className: c.name });
    });

    files.forEach((file) => {
        const fileClasses = classesByFile.get(file.path) || [];
        const pkg = fileClasses[0]?.package;
        if (!pkg) return;
        const imported = explicitlyImported.get(file.path) || new Set();
        (filesByPackage.get(pkg) || []).forEach(({ file: otherFile, className }) => {
            if (otherFile === file.path || imported.has(className)) return;
            if (new RegExp(`\\b${className}\\b`).test(file.content)) {
                deps.push({ source: file.path, target: otherFile, type: 'same-package' });
            }
        });
    });

    return deps;
}

/**
 * Runs the full analysis over a set of in-memory files and
 * returns the JSON payload our backend's ingest API expects.
 *
 * @param {{ name: string, source: 'github'|'zip'|'local', url?: string }} repoMeta
 * @param {Array<{ path: string, content: string }>} files
 * @param {(progress: { phase: string, current: number, total: number }) => void} [onProgress]
 */
export async function analyzeRepository(repoMeta, rawFiles, onProgress) {
    const report = (phase, current, total) => {
        if (onProgress) onProgress({ phase, current, total });
    };

    // Parser expects { path, name, content } — callers of this
    // orchestrator only need to supply { path, content }.
    const files = rawFiles.map((f) => ({
        ...f,
        name: f.name || f.path.split('/').pop(),
    }));

    const allFunctions = [];
    const allClasses = [];
    const functionCountByFile = new Map();

    report('extracting', 0, files.length);
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
            const fns = Parser.extract(file.content, file.path) || [];
            fns.forEach((fn) => allFunctions.push({ ...fn, file: file.path }));
            functionCountByFile.set(file.path, fns.length);
        } catch (err) {
            // A single unparsable file must never abort the whole analysis run.
            console.warn(`[analysis-engine] extraction failed for ${file.path}:`, err.message);
        }
        allClasses.push(...extractClasses(file.content, file.path));
        if (i % 10 === 0) {
            report('extracting', i + 1, files.length);
            await new Promise((r) => setTimeout(r, 0)); // yield to keep the UI responsive
        }
    }
    report('extracting', files.length, files.length);

    // Layer (Parser.detectLayer — a path-based heuristic,
    // e.g. "controller"/"service"/"repository" segments) and complexity per
    // file, both needed for Color-By-Layer and the Issues/High-Complexity check.
    files.forEach((file) => {
        file.layer = Parser.detectLayer(file.path);
        try {
            file.complexity = Parser.isCode(file.name) ? Parser.calcComplexity(file.content, file.path) : { score: 0, level: 'low' };
        } catch {
            file.complexity = { score: 0, level: 'low' };
        }
        file.functionCount = functionCountByFile.get(file.path) || 0;
    });

    report('dependencies', 0, 1);
const dependencies = extractFileDependencies(files, allClasses);    report('dependencies', 1, 1);

    report('patterns', 0, 1);
    let patterns = [];
    try {
        patterns = Parser.detectPatterns(files) || [];
    } catch (err) {
        console.warn('[analysis-engine] pattern detection failed:', err.message);
    }

    report('security', 0, 1);
    let securityIssues = [];
    try {
        securityIssues = Parser.detectSecurity(files) || [];
    } catch (err) {
        console.warn('[analysis-engine] security scan failed:', err.message);
    }

    report('duplicates', 0, 1);
    let duplicates = [];
    try {
        duplicates = Parser.detectDuplicates(files, allFunctions) || [];
    } catch (err) {
        console.warn('[analysis-engine] duplicate detection failed:', err.message);
    }

    report('callgraph', 0, 1);
    let callConnections = [];
    let fnStats = {};
    try {
        ({ connections: callConnections, fnStats } = buildCallGraph(files, allFunctions));
    } catch (err) {
        console.warn('[analysis-engine] call graph resolution failed:', err.message);
    }

    let layerViolations = [];
    try {
        layerViolations = Parser.detectLayerViolations(files, callConnections) || [];
    } catch (err) {
        console.warn('[analysis-engine] layer violation detection failed:', err.message);
    }

    let issues = [];
    try {
        issues = buildIssues({ files, connections: callConnections, fnStats, duplicates, layerViolations });
    } catch (err) {
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
        safeToTouch = computeSafeToTouch({ files, connections: callConnections });
        ({ issues, securityIssues, duplicates } = tagFindings({ issues, securityIssues, duplicates }));
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
        console.warn('[analysis-engine] migration risk/order failed:', err.message);
    }
    report('migrate', 1, 1);

    // --- Phase 3, batch 2: API endpoint discovery + cURL/Postman gen ---
    report('api', 0, 1);
    let apiEndpoints = [];
    let postmanCollection = null;
    try {
        apiEndpoints = discoverEndpoints(files);
        apiEndpoints = apiEndpoints.map((ep) => ({ ...ep, curl: generateCurl(ep) }));
        postmanCollection = generatePostmanCollection(apiEndpoints, repoMeta.name || 'Discovered API');
    } catch (err) {
        console.warn('[analysis-engine] API endpoint discovery failed:', err.message);
    }
    report('api', 1, 1);
    // Note: API breaking-change risk (detectApiBreakingChanges in api.js) needs
    // TWO snapshots to diff — the caller re-invokes it across re-analyses,
    // passing the previously stored `apiEndpoints` in; a single analysis run
    // has nothing to compare against yet.

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
        architectureDrift = computeArchitectureDrift({ layerViolations, connections: callConnections });
        configLinkage = computeConfigToCodeLinkage(files);
        externalBoundaries = computeExternalBoundaries(files);
        const filesByPath = new Map(files.map((f) => [f.path, f]));
        errorHandlingCoverage = computeErrorHandlingCoverage(flowTraces, filesByPath);
        dataOwnership = computeDataOwnership({ connections: callConnections, roles });
    } catch (err) {
        console.warn('[analysis-engine] architecture insights failed:', err.message);
    }
    report('architecture', 1, 1);

    // --- Phase 3, batch 4: DB/data layer ---
    report('db', 0, 1);
    let databaseSchema = { tables: [], mermaidErDiagram: null };
    let orphanTables = [];
    try {
        databaseSchema = extractDatabaseSchema(files);
        orphanTables = detectOrphanTables(databaseSchema.tables, files);
    } catch (err) {
        console.warn('[analysis-engine] DB schema extraction failed:', err.message);
    }
    report('db', 1, 1);

    // --- Phase 3, batch 5: security deepening ---
    report('security', 0, 1);
    let authCoverage = { totalEndpoints: 0, protectedCount: 0, unprotectedCount: 0, coveragePct: 0, files: [] };
    try {
        authCoverage = computeAuthCoverageMap(apiEndpoints);
        const advancedSecrets = detectAdvancedSecrets(files);
        securityIssues = securityIssues.concat(advancedSecrets);
    } catch (err) {
        console.warn('[analysis-engine] security deepening failed:', err.message);
    }
    report('security', 1, 1);

    // --- Phase 3, batch 7: dependency/supply-chain ---
    report('dependencies', 0, 1);
    let dependencyInventory = { dependencies: [], totalCount: 0, byEcosystem: {} };
    let licenseCompliance = { results: [], copyleftFlags: [], unknownCount: 0, totalChecked: 0 };
    try {
        dependencyInventory = extractDependencyInventory(files);
        licenseCompliance = checkLicenseCompliance(dependencyInventory);
    } catch (err) {
        console.warn('[analysis-engine] dependency inventory/license check failed:', err.message);
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
    } catch (err) {
        console.warn('[analysis-engine] quality checks (TODOs/docs/naming/OpenAPI/a11y) failed:', err.message);
    }
    report('quality', 1, 1);

    const deadFunctionCount = Object.values(fnStats).filter(
        (s) => s.internal === 0 && s.external === 0 && s.isTopLevel && !s.isClassMethod
    ).length;

    const graphNodes = files.map((f) => ({ id: f.path, label: f.path.split('/').pop() }));
    const graphEdges = dependencies.map((d) => ({ source: d.source, target: d.target }));

    const stats = {
        files: files.length,
        functions: allFunctions.length,
        classes: allClasses.length,
        connections: dependencies.length,
        dead: deadFunctionCount,
    };

    let healthScore = { score: 0, grade: 'F' };
    try {
        healthScore = calcHealth({ stats, issues, securityIssues });
    } catch (err) {
        console.warn('[analysis-engine] health score calculation failed:', err.message);
    }

    report('done', 1, 1);

    const result = {
        repository: repoMeta,
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
        imports: dependencies.filter((d) => d.type === 'import'),
        dependencies,
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
        callGraph: { connections: callConnections, fnStats },
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

    // Phase 3 batch 8 — Documentation: one Markdown architecture report
    // aggregating everything above, generated last so it can summarize
    // the full result object.
    let architectureReport = null;
    try {
        architectureReport = generateArchitectureReport(repoMeta, result);
    } catch (err) {
        console.warn('[analysis-engine] architecture report generation failed:', err.message);
    }
    result.architectureReport = architectureReport;

    return result;
}

function guessLanguage(path) {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    const map = {
        '.java': 'java', '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript',
        '.tsx': 'typescript', '.py': 'python', '.go': 'go', '.rb': 'ruby', '.php': 'php',
        '.rs': 'rust', '.c': 'c', '.cpp': 'cpp', '.cs': 'csharp', '.kt': 'kotlin',
        '.swift': 'swift', '.scala': 'scala',
    };
    return map[ext] || 'other';
}
