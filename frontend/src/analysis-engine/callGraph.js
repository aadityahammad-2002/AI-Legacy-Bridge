/**
 * callGraph.js
 *
 * `buildAnalysisData()` orchestration (the parts that
 * build the function-level call graph and derive architecture "Issues" from
 * it). All the underlying primitives (buildFunctionDefinitionIndex,
 * buildFunctionNameIndex, buildFunctionDefLineIndex, extractCallGraphImportMap,
 * findCalls, detectLayerViolations, calcComplexity, detectDuplicates) were
 * already ported into parser.js in an earlier pass — this file just wires, plus the issue-list building
 * UI reads to populate its Issues tab.
 */

import { Parser } from './parser.js';

/**
 * Resolves which function definition a given call-site name refers to,
 * preferring (1) a same-file definition, (2) the file's explicit imports,
 * (3) any file that's an import target of the caller, in that order —
 * exactly CodeFlow's `resolveCallDefinitions`.
 */
function resolveCallDefinitions(fnName, file, fnDefIndex, fileImportInfo) {
    const defs = fnDefIndex.byName[fnName] || [];
    if (!defs.length) return [];

    const firstFromOneFile = (list) => {
        if (!list.length) return null;
        const f = list[0].file;
        return list.every((d) => d.file === f) ? list[0] : null;
    };

    const sameFile = defs.filter((d) => d.file === file.path);
    const sameFileDef = firstFromOneFile(sameFile);
    if (sameFileDef) return [sameFileDef];
    if (defs.length === 1) return [defs[0]];

    const imports = fileImportInfo[file.path] || { locals: {}, targets: new Set() };
    const directImports = (imports.locals && imports.locals[fnName]) || [];
    if (directImports.length) {
        const matches = defs.filter((d) => directImports.indexOf(d.file) >= 0);
        const directDef = firstFromOneFile(matches);
        if (directDef) return [directDef];
    }
    if (imports.targets && typeof imports.targets.has === 'function') {
        const matches = defs.filter((d) => imports.targets.has(d.file));
        const importedDef = firstFromOneFile(matches);
        if (importedDef) return [importedDef];
    }
    return [];
}

/**
 * Builds the function-level call graph: `connections` (source = file
 * DEFINING the function, target = file CALLING it — same convention
 * `Parser.detectLayerViolations` expects) and `fnStats` (per-function
 * internal/external call counts + caller list, keyed by `functionKey`).
 *
 * @param {Array<{path:string, content:string}>} files
 * @param {Array} allFunctions - the orchestrator's flat function list (each needs .file, .name, .line, etc.)
 */
export function buildCallGraph(files, allFunctions) {
    const fnDefIndex = Parser.buildFunctionDefinitionIndex(allFunctions);
    const fnNames = Object.keys(fnDefIndex.byName);
    const fnNameIndex = Parser.buildFunctionNameIndex(fnNames);
    const fnDefLineIndex = Parser.buildFunctionDefLineIndex(allFunctions);

    const fileImportInfo = {};
    files.forEach((file) => {
        fileImportInfo[file.path] = Parser.extractCallGraphImportMap(file.content || '', file.path, files);
    });

    const connections = [];
    const fnStats = {};
    Object.keys(fnDefIndex.byKey).forEach((key) => {
        const fn = fnDefIndex.byKey[key];
        fnStats[key] = {
            key, name: fn.name, internal: 0, external: 0, callers: new Map(),
            file: fn.file, folder: fn.file.split('/').slice(0, -1).join('/'), line: fn.line, code: fn.code,
            isTopLevel: fn.isTopLevel !== false, isExported: !!fn.isExported, isClassMethod: !!fn.isClassMethod,
            type: fn.type || 'function', decorators: fn.decorators || null, className: fn.className || null,
        };
    });

    files.forEach((file) => {
        if (!file.content) return;
        let calls;
        try {
            calls = Parser.findCalls(file.content, fnNames, file.path, fnDefLineIndex, fnNameIndex) || {};
        } catch {
            calls = {};
        }
        Object.entries(calls).forEach(([fnName, cnt]) => {
            if (cnt <= 0) return;
            resolveCallDefinitions(fnName, file, fnDefIndex, fileImportInfo).forEach((def) => {
                const stat = fnStats[def.key];
                if (!stat) return;
                if (def.file === file.path) {
                    stat.internal += cnt;
                } else {
                    connections.push({ source: def.file, target: file.path, fn: fnName, count: cnt, functionKey: def.key });
                    const existing = stat.callers.get(file.path);
                    if (existing) existing.count += cnt;
                    else stat.callers.set(file.path, { file: file.path, count: cnt });
                    stat.external += cnt;
                }
            });
        });
    });

    Object.values(fnStats).forEach((s) => {
        s.callers = Array.from(s.callers.values());
        s.count = s.internal + s.external;
    });

    return { connections, fnStats };
}

const DEAD_CODE_EXEMPT_NAMES = new Set([
    'main', 'create_app', 'make_app', 'get_app', 'setup', 'configure', 'register',
    'on_startup', 'on_shutdown', 'lifespan', 'setUp', 'tearDown', 'setUpClass', 'tearDownClass',
]);

/** Same exemption rules as dead-function filter — entry points, dunders, tests, exported JS/TS symbols, etc. never count as "dead". */
function isDeadCandidate(stats) {
    if (stats.internal > 0 || stats.external > 0) return false;
    if (stats.isClassMethod) return false;
    if (!stats.isTopLevel) return false;
    if (stats.decorators && stats.decorators.length > 0) return false;
    if (stats.type === 'class' || stats.type === 'dataclass' || stats.type === 'abstract_class') return false;
    const baseName = stats.name.includes('.') ? stats.name.split('.').pop() : stats.name;
    if (baseName.startsWith('__') && baseName.endsWith('__')) return false;
    if (baseName.startsWith('test_') || DEAD_CODE_EXEMPT_NAMES.has(baseName)) return false;
    if (stats.file && (stats.file.includes('test_') || stats.file.includes('_test.') || stats.file.includes('/tests/'))) return false;
    if (stats.isExported && stats.file && /\.[jt]sx?$/.test(stats.file)) return false;
    if (stats.file && (/\.(?:spec|test)\.[jt]sx?$/.test(stats.file) || stats.file.includes('__tests__'))) return false;
    return true;
}

/**
 * Derives the "Issues" list Issues tab shows, from data we
 * already compute: dead functions, oversized files, highly-coupled files,
 * circular dependencies, duplicate names/code, layer violations, and
 * high-complexity files.
 */
export function buildIssues({ files, connections, fnStats, duplicates, layerViolations }) {
    const issues = [];

    const deadFns = Object.entries(fnStats).filter(([, stats]) => isDeadCandidate(stats));
    if (deadFns.length) {
        issues.push({
            type: 'warning', title: `${deadFns.length} Unused Functions`,
            desc: 'Functions not called from other files',
            items: deadFns.map(([, s]) => ({ name: s.name, file: s.file, line: s.line })),
        });
    }

    const largeFiles = files.filter((f) => (f.functionCount || 0) > 15);
    if (largeFiles.length) {
        issues.push({
            type: 'critical', title: `${largeFiles.length} Large Files`,
            desc: 'Files with 15+ functions',
            items: largeFiles.map((f) => ({ name: `${f.path.split('/').pop()} (${f.functionCount} fns)`, file: f.path })),
        });
    }

    const coupling = {};
    connections.forEach((c) => { coupling[c.target] = (coupling[c.target] || 0) + 1; });
    const highCoupled = Object.entries(coupling).filter(([, n]) => n > 8).sort((a, b) => b[1] - a[1]);
    if (highCoupled.length) {
        issues.push({
            type: 'warning', title: `${highCoupled.length} Highly Coupled`,
            desc: 'Files imported by 8+ others',
            items: highCoupled.map(([path, n]) => ({ name: `${path.split('/').pop()} (${n} imports)`, file: path })),
        });
    }

    const connSet = new Set(connections.map((c) => `${c.source}|${c.target}`));
    const circularKeys = [];
    connections.forEach((c) => {
        if (connSet.has(`${c.target}|${c.source}`)) {
            const key = [c.source, c.target].sort().join('|');
            if (!circularKeys.includes(key)) circularKeys.push(key);
        }
    });
    if (circularKeys.length) {
        issues.push({
            type: 'critical', title: `${circularKeys.length} Circular Dependencies`,
            desc: 'Files that import each other',
            items: circularKeys.map((k) => {
                const [a, b] = k.split('|');
                return { name: `${a.split('/').pop()} ↔ ${b.split('/').pop()}`, files: [a, b] };
            }),
        });
    }

    if (duplicates && duplicates.length) {
        const nameDups = duplicates.filter((d) => d.type === 'name');
        const codeDups = duplicates.filter((d) => d.type === 'code');
        if (nameDups.length) {
            issues.push({
                type: 'warning', title: `${nameDups.length} Duplicate Function Names`,
                desc: 'Same function name in multiple files',
                items: nameDups.map((d) => ({ name: `${d.name} (${d.count} files)`, files: d.files })),
            });
        }
        if (codeDups.length) {
            issues.push({
                type: 'warning', title: `${codeDups.length} Similar Code Blocks`,
                desc: 'Copy-paste code detected',
                items: codeDups.map((d) => ({ name: d.name, files: d.files })),
            });
        }
    }

    if (layerViolations && layerViolations.length) {
        issues.push({
            type: 'critical', title: `${layerViolations.length} Architecture Violations`,
            desc: 'Lower layers importing from higher layers',
            items: layerViolations.map((v) => ({ name: `${v.fromLayer} → ${v.toLayer}`, file: v.from, toFile: v.to })),
        });
    }

    const highComplexity = files
        .filter((f) => f.complexity && f.complexity.level === 'critical')
        .sort((a, b) => b.complexity.score - a.complexity.score);
    if (highComplexity.length) {
        issues.push({
            type: 'warning', title: `${highComplexity.length} High Complexity Files`,
            desc: 'Files with complexity score >30',
            items: highComplexity.map((f) => ({ name: `${f.path.split('/').pop()} (${f.complexity.score})`, file: f.path })),
        });
    }

    return issues;
}

/** Language breakdown by lines-of-code and percentage — for the sidebar's language bar. */
export function buildLanguageStats(files) {
    const byExt = {};
    let totalLoc = 0;
    files.forEach((f) => {
        const ext = (f.path.split('.').pop() || '').toLowerCase();
        const loc = f.loc || 0;
        byExt[ext] = (byExt[ext] || 0) + loc;
        totalLoc += loc;
    });
    return Object.entries(byExt)
        .sort((a, b) => b[1] - a[1])
        .map(([ext, loc]) => ({ ext, loc, pct: totalLoc ? Math.round((loc / totalLoc) * 100) : 0 }));
}
