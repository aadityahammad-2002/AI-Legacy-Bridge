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

    return {
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
    };
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
