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
import { extractLocalJsExportAliases } from './moduleResolution.js';
import { extractParameterList } from './functionMetrics.js';
import { identifyCodeLanguage } from './languageIntelligence.js';

/**
 * Resolves which function definition a given call-site name refers to,
 * preferring same-file definitions and then explicit import bindings. It does
 * not guess a cross-file target from a globally unique function name alone;
 */
/**
 * Parser.findCalls supports both AST and heuristic modes. Imports are declarations,
 * not call sites, but some fallback and Python traversal paths can count imported
 * identifiers as references. Blank import declarations while preserving newlines
 * and character positions so source-location diagnostics remain stable.
 */
function maskNonCodePreservingPositions(content, filePath = '') {
    const source = String(content || '');
    const isPython = /\.(?:py|pyw|pyi)$/i.test(filePath);
    const isJava = /\.(?:java|kt|kts|cs|scala|groovy)$/i.test(filePath);
    const out = source.split('');
    let i = 0;
    let state = 'code';
    let quote = '';
    let triple = false;
    while (i < source.length) {
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
            if (c === '*' && next === '/') {
                out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'code';
            } else { if (c !== '\n') out[i] = ' '; i++; }
            continue;
        }
        if (state === 'string') {
            if (c === '\\') {
                if (c !== '\n') out[i] = ' ';
                if (i + 1 < source.length && source[i + 1] !== '\n') out[i + 1] = ' ';
                i += 2;
                continue;
            }
            if (triple && c === quote && next === quote && third === quote) {
                out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 3; state = 'code'; triple = false; continue;
            }
            if (!triple && c === quote) { out[i] = ' '; i++; state = 'code'; continue; }
            if (c !== '\n') out[i] = ' ';
            i++;
            continue;
        }
        if (isPython && c === '#') { out[i] = ' '; i++; state = 'line-comment'; continue; }
        if (!isPython && c === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'line-comment'; continue; }
        if (!isPython && c === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'block-comment'; continue; }
        if ((isPython && ((c === '"' && next === '"' && third === '"') || (c === "'" && next === "'" && third === "'"))) ||
            (isJava && c === '"' && next === '"' && third === '"')) {
            quote = c; triple = true; state = 'string'; out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 3; continue;
        }
        if (c === '"' || c === "'" || (!isPython && c === '`')) {
            quote = c; triple = false; state = 'string'; out[i] = ' '; i++; continue;
        }
        i++;
    }
    return out.join('');
}

/** Count arguments for member/receiver calls without counting commas inside nested expressions. */
function countCallArgumentCount(content, methodOffset, methodName, filePath = '') {
    const source = String(content || '');
    const masked = maskNonCodePreservingPositions(maskImportDeclarations(source, filePath), filePath);
    const open = masked.indexOf('(', methodOffset + String(methodName || '').length);
    if (open < 0 || open - (methodOffset + String(methodName || '').length) > 20) return null;
    let round = 1, square = 0, curly = 0, commas = 0, hasCodeToken = false, closeAt = -1;
    for (let index = open + 1; index < masked.length && index - open < 8000; index++) {
        const c = masked[index];
        if (c === '(') round++;
        else if (c === ')') { round--; if (round === 0) { closeAt = index; break; } }
        else if (c === '[') square++;
        else if (c === ']') square = Math.max(0, square - 1);
        else if (c === '{') curly++;
        else if (c === '}') curly = Math.max(0, curly - 1);
        else if (c === ',' && round === 1 && square === 0 && curly === 0) commas++;
        if (!/\s/.test(c)) hasCodeToken = true;
    }
    if (closeAt < 0) return null;
    const rawArgs = source.slice(open + 1, closeAt)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\r\n]*/g, ' ')
        .replace(/#[^\r\n]*/g, ' ');
    hasCodeToken = hasCodeToken || rawArgs.trim().length > 0;
    return hasCodeToken ? commas + 1 : 0;
}

/** Locate explicit instance/class receiver calls (`this.foo`, `self.foo`, `cls.foo`).
 * Deliberately does not resolve arbitrary object receivers or infer inheritance. */
function findReceiverCallSites(content, filePath = '', limit = 5000) {
    const masked = maskNonCodePreservingPositions(maskImportDeclarations(content, filePath), filePath);
    const rawLines = String(content || '').split('\n');
    const patterns = [
        { regex: /\b(this|self|cls|super)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g, receiverGroup: 1, methodGroup: 2 },
        // Python's conventional zero-argument super() syntax.
        { regex: /\bsuper\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g, receiverGroup: null, methodGroup: 1 },
    ];
    const sites = [];
    const seen = new Set();
    for (const descriptor of patterns) {
        for (const match of masked.matchAll(descriptor.regex)) {
            if (sites.length >= limit) break;
            const methodName = match[descriptor.methodGroup];
            const methodOffset = match.index + match[0].lastIndexOf(methodName);
            const line = masked.slice(0, methodOffset).split('\n').length;
            const lineStart = masked.lastIndexOf('\n', methodOffset - 1) + 1;
            const rawLine = rawLines[line - 1] || '';
            const receiver = descriptor.receiverGroup ? match[descriptor.receiverGroup] : 'super';
            const key = `${line}|${methodOffset}|${receiver}|${methodName}`;
            if (seen.has(key)) continue;
            seen.add(key);
            sites.push({
                receiver, methodName, line,
                column: methodOffset - lineStart + 1,
                argumentCount: countCallArgumentCount(content, methodOffset, methodName, filePath),
                excerpt: rawLine.trim().slice(0, 300),
            });
        }
    }
    return sites.sort((a, b) => a.line - b.line || a.column - b.column);
}

function findTypedObjectCallSites(content, filePath = '', limit = 5000) {
    const masked = maskNonCodePreservingPositions(maskImportDeclarations(content, filePath), filePath);
    const rawLines = String(content || '').split('\n');
    const pattern = /((?:(?:this|self|cls)\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
    const sites = [];
    for (const match of masked.matchAll(pattern)) {
        if (sites.length >= limit) break;
        const receiverExpression = match[1].replace(/\s+/g, '');
        if (['this', 'self', 'cls', 'super'].includes(receiverExpression)) continue;
        const methodOffset = match.index + match[0].lastIndexOf(match[2]);
        const line = masked.slice(0, methodOffset).split('\n').length;
        const lineStart = masked.lastIndexOf('\n', methodOffset - 1) + 1;
        sites.push({
            receiverExpression, methodName: match[2], line,
            column: methodOffset - lineStart + 1,
            argumentCount: countCallArgumentCount(content, methodOffset, match[2], filePath),
            excerpt: (rawLines[line - 1] || '').trim().slice(0, 300),
        });
    }
    return sites;
}

function inferReceiverTypes(file) {
    const content = String(file?.content || '');
    const path = String(file?.path || '');
    const masked = maskNonCodePreservingPositions(content, path);
    const types = new Map();
    const add = (name, type) => {
        if (!name || !type || !/^[A-Za-z_$][\w$.]*$/.test(type)) return;
        const cleanType = type.split('.').pop();
        if (!types.has(name)) types.set(name, new Set());
        types.get(name).add(cleanType);
    };
    const isPython = /\.(?:py|pyw|pyi)$/i.test(path);
    if (isPython) {
        for (const match of masked.matchAll(/\bself\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*([A-Z][\w$.]*)\s*\(/g)) add(`self.${match[1]}`, match[2]);
        for (const match of masked.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*([A-Z][\w$.]*)\s*\(/g)) add(match[1], match[2]);
        for (const match of masked.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*([A-Z][\w$.]*)\b/g)) add(match[1], match[2]);
        return types;
    }
    // Explicit construction and annotations in JS/TS.
    for (const match of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$.]*))?\s*=\s*new\s+([A-Za-z_$][\w$.]*)/g)) add(match[1], match[2] || match[3]);
    for (const match of masked.matchAll(/\bthis\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$.]*)/g)) add(`this.${match[1]}`, match[2]);
    for (const match of masked.matchAll(/\b(?:const|let|var|public|private|protected|readonly|static|final)\s+([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$.]*)\b/g)) add(match[1], match[2]);
    // Java fields/local variables: restrict candidate types to upper-case type names to
    // avoid interpreting ordinary assignments (`x = y`) as declared receiver types.
    if (/\.(?:java|kt|kts|cs|scala|groovy)$/i.test(path)) {
        for (const match of masked.matchAll(/\b([A-Z][A-Za-z0-9_$.]*)(?:\s*<[^;={}\n]+>)?\s+([a-z_$][\w$]*)\s*(?==|;|,)/g)) add(match[2], match[1]);
    }
    return types;
}

function resolveTypedReceiverMethod(file, receiverExpression, methodName, callerFn, fileImportInfo, allFunctions, receiverTypes, argumentCount = null, filesByPath = new Map()) {
    const directTypeSet = receiverTypes.get(receiverExpression) || receiverTypes.get(receiverExpression.split('.').pop()) || new Set();
    if (directTypeSet.size !== 1) return { status: directTypeSet.size > 1 ? 'ambiguous' : 'unresolved', candidates: [], reason: directTypeSet.size ? 'receiver-has-multiple-inferred-types' : 'receiver-type-not-inferred' };
    const localType = [...directTypeSet][0];
    let candidates = allFunctions.filter((fn) => fn.file === file.path && functionClassName(fn) === localType && simpleFunctionName(fn) === methodName);
    if (candidates.length) {
        const narrowed = narrowByArity(candidates, argumentCount, filesByPath);
        return { status: narrowed.length === 1 ? 'resolved' : 'ambiguous', candidates: narrowed, reason: narrowed.length === 1 && candidates.length > 1 ? `same-file receiver overload matched by ${argumentCount}-argument call-site evidence` : 'same-file-declared-receiver-type' };
    }

    const info = fileImportInfo[file.path] || {};
    const bindings = info.bindings?.[localType] || [];
    for (const binding of bindings) {
        const importedName = binding.importedName && binding.importedName !== 'default' ? binding.importedName : localType;
        candidates.push(...allFunctions.filter((fn) => fn.file === binding.file && functionClassName(fn) === importedName && simpleFunctionName(fn) === methodName));
    }
    // Java same-package/explicit dependency candidates: require that the source
    // file actually depends on the target file and a unique class/method is found.
    const targetFiles = info.targets && typeof info.targets.has === 'function'
        ? allFunctions.filter((fn) => info.targets.has(fn.file) && functionClassName(fn) === localType && simpleFunctionName(fn) === methodName)
        : [];
    candidates.push(...targetFiles);
    // Java's same-package classes are visible without explicit import lines.
    // Explicit imports also provide usable type evidence even if module
    // dependency extraction did not emit a file edge. Require a declared
    // class matching the receiver's observed type before linking any method.
    if (/\.java$/i.test(file.path || '')) {
        const pkgOf = (source) => (String(source || '').match(/^\s*package\s+([\w.]+)\s*;/m) || [,''])[1];
        const sourcePackage = pkgOf(file.content);
        const importNames = [...String(file.content || '').matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)]
            .map(match => match[1]);
        const candidatePaths = [...filesByPath.values()].filter(target => target.path !== file.path &&
            fileDeclaresClass(target, localType) &&
            ((sourcePackage && pkgOf(target.content) === sourcePackage) ||
                importNames.includes(`${pkgOf(target.content)}.${localType}`)))
            .map(target => target.path);
        if (candidatePaths.length === 1) {
            candidates.push(...allFunctions.filter(fn => fn.file === candidatePaths[0] &&
                functionClassName(fn) === localType && simpleFunctionName(fn) === methodName));
        }
    }
    candidates = [...new Map(candidates.map((fn) => [fn.key || Parser.functionKey(fn), fn])).values()];
    if (!candidates.length) return { status: 'unresolved', candidates: [], reason: 'receiver-type-method-not-found-in-resolved-dependencies' };
    const narrowed = narrowByArity(candidates, argumentCount, filesByPath);
    return { status: narrowed.length === 1 ? 'resolved' : 'ambiguous', candidates: narrowed, reason: narrowed.length === 1 && candidates.length > 1 ? `receiver overload matched by ${argumentCount}-argument call-site evidence` : (bindings.length ? 'explicit-imported-receiver-type' : 'resolved-module-receiver-type') };
}

/** Resolve only namespace/module-qualified calls backed by an explicit import
 * statement and an unambiguous repository file. This intentionally does not
 * resolve arbitrary `obj.method()` expressions by matching names globally. */
function moduleImportBindings(file, filesByPath, importInfo) {
    const source = String(file?.content || '');
    const path = String(file?.path || '');
    const masked = maskNonCodePreservingPositions(source, path);
    const bindings = new Map();
    const add = (alias, targets) => {
        if (!alias || !targets.length) return;
        if (!bindings.has(alias)) bindings.set(alias, new Set());
        for (const target of targets) bindings.get(alias).add(target);
    };
    const knownPaths = [...filesByPath.keys()];
    const dir = path.split('/').slice(0, -1).join('/');
    const resolveModule = (moduleName, fromImport = '') => {
        const namePart = String(moduleName || '').replace(/\./g, '/');
        const prefix = String(fromImport || '');
        if (!namePart) return [];
        const roots = [];
        if (prefix.startsWith('.')) {
            // A leading dot means the current Python package. Each additional
            // dot walks up one package; never match a different package merely
            // because it has a unique suffix elsewhere in the repository.
            const levels = (prefix.match(/^\.+/) || [''])[0].length;
            if (levels > dir.split('/').filter(Boolean).length + 1) return [];
            const parentParts = dir.split('/').filter(Boolean).slice(0, Math.max(0, dir.split('/').filter(Boolean).length - levels + 1));
            const base = [...parentParts, prefix.slice(levels).replace(/\./g, '/'), namePart].filter(Boolean).join('/');
            roots.push(base);
        } else {
            const base = [prefix.replace(/\./g, '/'), namePart].filter(Boolean).join('/');
            // Absolute Python imports first try their actual package-root path.
            // A uniquely matching package suffix is permitted only for absolute
            // imports (monorepos can embed independent package roots).
            roots.push(base);
            const local = dir ? `${dir}/${base}` : base;
            if (local !== base) roots.push(local);
        }
        const candidates = roots.flatMap(base => [`${base}.py`, `${base}/__init__.py`]);
        const exact = [...new Set(candidates.filter(candidate => filesByPath.has(candidate)))];
        if (exact.length) return exact.length === 1 ? exact : [];
        if (prefix.startsWith('.')) return [];
        const suffixes = roots.flatMap(base => [`/${base}.py`, `/${base}/__init__.py`]);
        const matches = knownPaths.filter(candidate => suffixes.some(suffix => `/${candidate}`.endsWith(suffix)));
        return matches.length === 1 ? matches : [];
    };;
    if (/\.(?:py|pyw|pyi)$/i.test(path)) {
        for (const match of source.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?[^\n]*/gm)) {
            if (!masked.slice(match.index, match.index + 15).includes('import')) continue;
            const name = match[1];
            const alias = match[2] || name.split('.')[0];
            if (name.includes('.') && !match[2]) continue; // dotted roots need attribute-chain handling
            add(alias, resolveModule(name));
        }
        for (const match of source.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([^\n#]+)/gm)) {
            if (!masked.slice(match.index, match.index + 15).includes('from')) continue;
            const prefix = match[1];
            for (const part of match[2].replace(/[()]/g, '').split(',')) {
                const parsed = part.trim().match(/^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/);
                if (parsed) add(parsed[2] || parsed[1], resolveModule(parsed[1], prefix));
            }
        }
    } else if (/\.(?:js|jsx|ts|tsx|mjs|cjs)$/i.test(path)) {
        for (const match of source.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+['"]/g)) {
            if (!masked.slice(match.index,match.index+7).includes('import')) continue;
            add(match[1], [...(importInfo?.locals?.[match[1]] || [])]);
        }
        for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"][^'"]+['"]\s*\)/g)) {
            if (!masked.slice(match.index, match.index + 9).match(/\b(?:const|let|var)\b/)) continue;
            add(match[1], [...(importInfo?.locals?.[match[1]] || [])]);
        }
    }
    return bindings;
}

function resolveNamespaceMethod(receiver, methodName, moduleBindings, allFunctions, argumentCount, filesByPath) {
    const modulePaths = moduleBindings.get(receiver);
    if (!modulePaths || !modulePaths.size) return null;
    if (modulePaths.size !== 1) return {status:'ambiguous', candidates:[], reason:'namespace-import-target-ambiguous'};
    const [modulePath] = [...modulePaths];
    const candidates = allFunctions.filter(fn => fn.file === modulePath &&
        simpleFunctionName(fn) === methodName && !functionClassName(fn) &&
        fn.isTopLevel !== false && fn.type !== 'class');
    const narrowed = narrowByArity(candidates, argumentCount, filesByPath);
    return {status: narrowed.length === 1 ? 'resolved' : narrowed.length ? 'ambiguous' : 'unresolved',
        candidates:narrowed, reason: narrowed.length === 1 ? 'exact-module-namespace-import' : 'namespace-import-method-not-unique-or-absent'};
}

const EXTERNAL_RECEIVER_ROOTS = new Set([
    'console', 'logger', 'log', 'toast', 'window', 'document', 'navigator', 'process', 'global',
    'math', 'json', 'object', 'array', 'promise', 'string', 'number', 'boolean', 'date', 'regexp',
    'buffer', 'url', 'urlsearchparams', 'intl', 'crypto', 'fs', 'path', 'os', 'util', 'assert',
    'expect', 'jest', 'vi', 'sinon', 'axios', 'fetch', 'localstorage', 'sessionstorage', 'performance',
    'request', 'response', 'res', 'req', 'next', 'err', 'error', 'exception', 'logger',
]);
const COMMON_LIBRARY_METHODS = new Set([
    'map', 'filter', 'reduce', 'forEach', 'some', 'every', 'find', 'findIndex', 'includes',
    'indexOf', 'lastIndexOf', 'slice', 'splice', 'push', 'pop', 'shift', 'unshift', 'join',
    'split', 'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'startsWith',
    'endsWith', 'replace', 'replaceAll', 'match', 'matchAll', 'toString', 'valueOf',
    'hasOwnProperty', 'isArray', 'from', 'of', 'assign', 'keys', 'values', 'entries',
]);

/** Fill missing Java method class ownership from an actual enclosing class body.
 * This improves receiver attribution without requiring a compiler/type checker. */
function annotateJavaMethodOwnership(files, functions) {
    const byFile = new Map();
    for (const fn of functions) {
        if (!/\.java$/i.test(fn.file || '') || fn.className || fn.type !== 'method') continue;
        if (!byFile.has(fn.file)) byFile.set(fn.file, []);
        byFile.get(fn.file).push(fn);
    }
    for (const file of files) {
        const pending = byFile.get(file.path);
        if (!pending?.length) continue;
        const masked = maskNonCodePreservingPositions(file.content, file.path);
        const classes = [];
        for (const match of masked.matchAll(/\b(?:class|interface|record|enum)\s+([A-Za-z_$][\w$]*)[^;{}]*\{/g)) {
            const open = match.index + match[0].lastIndexOf('{');
            let depth = 0, close = -1;
            for (let at = open; at < masked.length; at++) {
                if (masked[at] === '{') depth++;
                else if (masked[at] === '}' && --depth === 0) { close = at; break; }
            }
            if (close === -1) continue;
            classes.push({name:match[1], start:masked.slice(0,open).split('\n').length,
                end:masked.slice(0,close).split('\n').length});
        }
        for (const fn of pending) {
            const enclosing = classes.filter(c => c.start <= fn.line && c.end >= (fn.endLine || fn.line))
                .sort((a,b)=>(a.end-a.start)-(b.end-b.start));
            if (enclosing.length && (enclosing.length === 1 || (enclosing[0].end-enclosing[0].start) !== (enclosing[1].end-enclosing[1].start))) {
                fn.className = enclosing[0].name;
                fn.isClassMethod = true;
            }
        }
    }
}

/** Classify (do not suppress) unresolved object calls to avoid conflating common
 * standard-library/framework calls with likely missing project-to-project edges. */
function classifyUnresolvedReceiverCall(site) {
    const receiver = String(site?.receiverExpression || '').replace(/\s+/g, '');
    const root = (receiver.match(/^[A-Za-z_$][\w$]*/) || [''])[0];
    const methodName = String(site?.methodName || '');
    if (EXTERNAL_RECEIVER_ROOTS.has(root.toLowerCase())) {
        return { classification: 'external-likely', reason: `receiver-root-${root}-is-a-common-runtime-or-framework-boundary` };
    }
    if (COMMON_LIBRARY_METHODS.has(methodName)) {
        return { classification: 'external-likely', reason: `method-${methodName}-is-a-common-standard-library-method` };
    }
    return { classification: 'project-or-unknown', reason: 'receiver-type-or-project-target-not-resolved' };
}

function isReceiverCallCountIncludedByGenericParser(filePath) {
    const path = String(filePath || '');
    if (/\.(?:py|pyw|pyi|java|kt|kts|cs|scala|groovy)$/i.test(path)) return true;
    if (/\.(?:js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/i.test(path)) {
        // With Acorn, the current AST call counter only counts Identifier callees
        // (`foo()`), not MemberExpression callees (`this.foo()`). The fallback
        // token counter can count the member name, so subtract in that mode only.
        return typeof globalThis.acorn === 'undefined';
    }
    return true;
}

function extractDirectSuperclassDeclarations(file) {
    const path = String(file?.path || '');
    const masked = maskNonCodePreservingPositions(file?.content || '', path);
    const declarations = [];
    if (/\.(?:py|pyw|pyi)$/i.test(path)) {
        const pattern = /^\s*class\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*:/gm;
        for (const match of masked.matchAll(pattern)) {
            const bases = match[2].split(',').map((part) => part.trim().split(/[.(\s]/)[0]).filter(Boolean).filter((name) => name !== 'object');
            declarations.push({ className: match[1], bases, line: masked.slice(0, match.index).split('\n').length, source: 'python-class-base-list' });
        }
        return declarations;
    }
    if (/\.(?:js|jsx|mjs|cjs|ts|tsx)$/i.test(path)) {
        const pattern = /\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g;
        for (const match of masked.matchAll(pattern)) declarations.push({ className: match[1], bases: [match[2].replace(/\s/g, '').split('.').pop()], line: masked.slice(0, match.index).split('\n').length, source: 'javascript-extends-clause' });
        return declarations;
    }
    if (/\.(?:java|kt|kts|cs|scala|groovy)$/i.test(path)) {
        const pattern = /\bclass\s+([A-Za-z_$][\w$]*)(?:\s*<[^{}\n]*>)?[^{};\n]*?\bextends\s+([A-Za-z_$][\w$.]*)/g;
        for (const match of masked.matchAll(pattern)) declarations.push({ className: match[1], bases: [match[2].split('.').pop()], line: masked.slice(0, match.index).split('\n').length, source: 'jvm-extends-clause' });
        return declarations;
    }
    return declarations;
}

function fileDeclaresClass(file, className) {
    if (!file || typeof file.content !== 'string' || !className) return false;
    const masked = maskNonCodePreservingPositions(file.content, file.path || '');
    const escaped = String(className).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\bclass\\s+${escaped}\\b`).test(masked) ||
        ( /\.(?:java|kt|kts|cs|scala|groovy)$/i.test(file.path || '') && new RegExp(`\\binterface\\s+${escaped}\\b`).test(masked));
}

function resolveSuperclassClassCandidates(sourceFile, baseName, fileImportInfo, allFunctions, filesByPath) {
    const candidates = [];
    const add = (filePath, className, resolvedBy) => {
        const targetFile = filesByPath.get(filePath);
        if (!targetFile) return;
        const hasDeclaration = fileDeclaresClass(targetFile, className);
        const hasMethods = allFunctions.some((fn) => fn.file === filePath && functionClassName(fn) === className);
        if (!hasDeclaration && !hasMethods) return;
        candidates.push({ file: targetFile, filePath, className, resolvedBy });
    };
    if (fileDeclaresClass(sourceFile, baseName) || allFunctions.some((fn) => fn.file === sourceFile.path && functionClassName(fn) === baseName)) {
        add(sourceFile.path, baseName, 'same-file-class');
    }
    const info = fileImportInfo[sourceFile.path] || {};
    for (const binding of info.bindings?.[baseName] || []) {
        const importedName = binding.importedName && binding.importedName !== 'default' ? binding.importedName : baseName;
        add(binding.file, importedName, 'explicit-imported-class');
    }
    if (info.targets && typeof info.targets[Symbol.iterator] === 'function') {
        for (const targetPath of info.targets) add(targetPath, baseName, 'resolved-dependency-class');
    }
    return [...new Map(candidates.map((item) => [`${item.filePath}|${item.className}`, item])).values()];
}

function resolveDirectSuperclassMethods(file, callerClass, methodName, fileImportInfo, allFunctions, argumentCount = null, filesByPath = new Map()) {
    const visited = new Set();
    let currentFile = file;
    let currentClass = callerClass;
    let depth = 0;
    while (depth < 8) {
        const visitedKey = `${currentFile.path}|${currentClass}`;
        if (visited.has(visitedKey)) return { status: 'unresolved', candidates: [], reason: 'superclass-cycle-detected' };
        visited.add(visitedKey);
        const declarations = extractDirectSuperclassDeclarations(currentFile).filter((item) => item.className === currentClass);
        if (declarations.length !== 1) return { status: declarations.length > 1 ? 'ambiguous' : 'unresolved', candidates: [], reason: 'superclass-declaration-not-found-or-ambiguous' };
        const bases = declarations[0].bases || [];
        // Python multiple inheritance has MRO semantics; do not guess the target.
        if (bases.length !== 1) return { status: bases.length > 1 ? 'ambiguous' : 'unresolved', candidates: [], reason: 'superclass-resolution-requires-single-direct-base' };
        const baseName = bases[0];
        const baseClasses = resolveSuperclassClassCandidates(currentFile, baseName, fileImportInfo, allFunctions, filesByPath);
        if (baseClasses.length !== 1) return {
            status: baseClasses.length > 1 ? 'ambiguous' : 'unresolved', candidates: [],
            reason: baseClasses.length > 1 ? 'superclass-class-resolution-ambiguous' : 'direct-superclass-target-not-found-in-repository',
        };
        const base = baseClasses[0];
        const rawMethods = allFunctions.filter((fn) => fn.file === base.filePath && functionClassName(fn) === base.className && simpleFunctionName(fn) === methodName);
        const methods = narrowByArity(rawMethods, argumentCount, filesByPath);
        if (methods.length === 1) {
            const reason = depth === 0 && base.resolvedBy === 'same-file-class'
                ? 'same-file-direct-superclass'
                : depth === 0 ? 'explicit-imported-direct-superclass' : 'resolved-ancestor-superclass-chain';
            return { status: 'resolved', candidates: methods, reason };
        }
        if (methods.length > 1) return { status: 'ambiguous', candidates: methods, reason: 'superclass-method-overload-remains-ambiguous' };
        // The direct parent may inherit the method from its own parent. Continue
        // only across a unique, explicitly resolvable single-inheritance chain.
        currentFile = base.file;
        currentClass = base.className;
        depth++;
    }
    return { status: 'unresolved', candidates: [], reason: 'superclass-chain-depth-limit' };
}
function simpleFunctionName(fn) {
    return String(fn?.name || '').split('.').pop();
}

function functionClassName(fn) {
    if (fn?.className) return String(fn.className);
    const name = String(fn?.name || '');
    if (name.includes('.')) return name.slice(0, name.lastIndexOf('.'));
    return null;
}

function isDefinitionNameOccurrence({ maskedLine, identifierOffsetInLine, functionName, filePath, line, functionDefinitions }) {
    const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matchPattern = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
    const firstNameMatch = matchPattern.exec(maskedLine);
    // Do not confuse an ordinary call with a definition merely because it shares
    // a line with a function declaration. Only consider the first name(...) token.
    if (!firstNameMatch || firstNameMatch.index !== identifierOffsetInLine) return false;
    const matchingDefinition = (functionDefinitions || []).find((fn) => {
        if (fn?.file !== filePath || Number(fn?.line) !== line) return false;
        const fnName = String(fn?.name || '').split('.').pop();
        return fnName === functionName || String(fn?.name || '') === functionName;
    });
    if (!matchingDefinition) return false;

    const prefix = maskedLine.slice(0, identifierOffsetInLine);
    if (/\b(?:async\s+)?(?:function|def)\s*$/.test(prefix)) return true;
    // Class methods (including Java methods) may have no `function`/`def` token.
    // Require known extracted method metadata plus a declaration-shaped line tail.
    if (!['method', 'constructor'].includes(String(matchingDefinition.type || '').toLowerCase())) return false;
    if (/\b(?:return|throw|new|if|while|for|switch|catch|yield)\b/.test(prefix)) return false;
    if (/[=;.]\s*$/.test(prefix)) return false;
    const open = maskedLine.indexOf('(', identifierOffsetInLine + functionName.length);
    if (open < 0) return false;
    let depth = 0;
    let close = -1;
    for (let index = open; index < maskedLine.length; index++) {
        if (maskedLine[index] === '(') depth++;
        else if (maskedLine[index] === ')') {
            depth--;
            if (depth === 0) { close = index; break; }
        }
    }
    if (close < 0) return false;
    const after = maskedLine.slice(close + 1).trimStart();
    return after.startsWith('{') || after.startsWith(':') || after.startsWith(';');
}

function findCallSiteEvidence(content, functionName, filePath, limit = 20, functionDefinitions = []) {
    if (!functionName || typeof functionName !== 'string') return [];
    const masked = maskNonCodePreservingPositions(maskImportDeclarations(content, filePath), filePath);
    const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])(${escaped})\\s*\\(`, 'gm');
    const sourceLines = String(content || '').split('\n');
    const callSites = [];
    for (const match of masked.matchAll(pattern)) {
        const identifierOffset = match.index + match[1].length;
        const previous = masked[identifierOffset - 1] || '';
        if (previous === '.') continue; // `object.method()` is not a direct identifier call target here.
        const line = masked.slice(0, identifierOffset).split('\n').length;
        const rawLine = sourceLines[line - 1] || '';
        const lineStart = masked.lastIndexOf('\n', identifierOffset - 1) + 1;
        const lineEnd = masked.indexOf('\n', identifierOffset);
        const maskedLine = masked.slice(lineStart, lineEnd < 0 ? masked.length : lineEnd);
        if (isDefinitionNameOccurrence({
            maskedLine,
            identifierOffsetInLine: identifierOffset - lineStart,
            functionName,
            filePath,
            line,
            functionDefinitions,
        })) continue;
        const column = identifierOffset - lineStart + 1;
        const callOpen = masked.indexOf('(', identifierOffset + functionName.length);
        let argumentCount = null;
        if (callOpen >= 0 && callOpen - (identifierOffset + functionName.length) <= 20) {
            let round = 1, square = 0, curly = 0, commas = 0, hasToken = false, closeAt = -1;
            for (let index = callOpen + 1; index < masked.length && index - callOpen < 8000; index++) {
                const c = masked[index];
                if (c === '(') round++;
                else if (c === ')') { round--; if (round === 0) { closeAt = index; break; } }
                else if (c === '[') square++; else if (c === ']') square = Math.max(0, square - 1);
                else if (c === '{') curly++; else if (c === '}') curly = Math.max(0, curly - 1);
                else if (c === ',' && round === 1 && square === 0 && curly === 0) commas++;
                if (!/\s/.test(c)) hasToken = true;
            }
            if (closeAt >= 0) {
                // Strings are intentionally masked for code scanning, but a literal
                // argument still contributes to arity. Strip comments from the raw
                // slice separately so comment-only calls remain zero-argument.
                const rawArgs = String(content || '').slice(callOpen + 1, closeAt)
                    .replace(/\/\*[\s\S]*?\*\//g, ' ')
                    .replace(/\/\/[^\r\n]*/g, ' ')
                    .replace(/#[^\r\n]*/g, ' ');
                hasToken = hasToken || rawArgs.trim().length > 0;
                argumentCount = hasToken ? commas + 1 : 0;
            }
        }
        // Keep distinct same-line calls distinct; collapsing by line loses
        // direct-call evidence for minified code and inflates unattributed counts.
        if (!callSites.some((item) => item.line === line && item.column === column)) {
            callSites.push({ line, column, excerpt: rawLine.trim().slice(0, 300), argumentCount });
            if (callSites.length >= limit) break;
        }
    }
    return callSites;
}

function maskImportDeclarations(content, filePath = '') {
    const lines = String(content || '').split(/(?<=\n)/);
    const isPython = /\.(?:py|pyw|pyi)$/i.test(filePath);
    let inImport = false;
    let parenDepth = 0;
    let continued = false;
    const output = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const body = line.replace(/[\r\n]+$/, '');
        const trimmed = body.trimStart();
        const startsPythonImport = isPython && /^(?:from\s+[.\w]+\s+import\b|import\s+[A-Za-z_])/u.test(trimmed);
        const startsJsImport = !isPython && /^(?:import\s+(?!\s*\()|export\s+(?:\*|\{))/u.test(trimmed);
        if (!inImport && !startsPythonImport && !startsJsImport) {
            output.push(line);
            continue;
        }

        const shouldMask = inImport || startsPythonImport || startsJsImport;
        if (shouldMask) output.push(line.replace(/[^\r\n]/g, ' '));
        else output.push(line);

        if (isPython) {
            const withoutComment = body.replace(/#.*$/, '');
            parenDepth += (withoutComment.match(/\(/g) || []).length - (withoutComment.match(/\)/g) || []).length;
            continued = /\\\s*$/.test(withoutComment);
            inImport = parenDepth > 0 || continued;
            if (!inImport) parenDepth = 0;
        } else {
            // Module source specifiers terminate static imports/re-exports; a
            // semicolon is optional. Continue across lines until `from 'x'`.
            const hasModuleSpecifier = /\bfrom\s*(['"][^'"\r\n]+['"])\s*;?\s*(?:\/\/[^\r\n]*|\/\*.*?\*\/\s*)?$/.test(body) ||
                /^\s*import\s*(['"][^'"\r\n]+['"])\s*;?\s*(?:\/\/[^\r\n]*|\/\*.*?\*\/\s*)?$/.test(body) ||
                /\brequire\s*\(/.test(body) && /^\s*import\b/.test(body);
            inImport = startsJsImport && !hasModuleSpecifier;
            if (inImport && /^\s*export\s+(?:\*|\{)/.test(body) && /;\s*$/.test(body)) inImport = false;
        }
    }
    return output.join('');
}



/**
 * Resolve an imported symbol through explicit re-export edges. This supports
 * common barrel modules such as `export { run as execute } from './service.js'`
 * and `export * from './service.js'`. It deliberately does not infer symbols
 * across arbitrary module edges or handle namespace member calls.
 */
function resolveExportedSymbol(targetFile, symbolName, fnDefIndex, fileImportInfo, visited = new Set(), argumentCount = null, filesByPath = new Map()) {
    if (!targetFile || !symbolName || symbolName === '*') {
        return { definitions: [], status: 'unresolved', candidates: [], reExportDepth: 0, exportAliasDepth: 0 };
    }
    const visitKey = `${targetFile}::${symbolName}`;
    if (visited.has(visitKey)) return { definitions: [], status: 'unresolved', candidates: [], reExportDepth: 0, exportAliasDepth: 0 };
    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);

    const rawLocalDefinitions = (fnDefIndex.byName[symbolName] || []).filter((definition) => definition.file === targetFile);
    const localDefinitions = narrowByArity(rawLocalDefinitions, argumentCount, filesByPath);
    if (localDefinitions.length === 1) return { definitions: localDefinitions, status: 'resolved', candidates: localDefinitions, reExportDepth: 0, exportAliasDepth: 0 };
    if (localDefinitions.length > 1) return { definitions: [], status: 'ambiguous', candidates: localDefinitions, reExportDepth: 0, exportAliasDepth: 0 };

    const info = fileImportInfo[targetFile] || {};
    const localAliases = (info.localExports && info.localExports[symbolName]) || [];
    if (localAliases.length) {
        const aliasResults = localAliases.map((localName) => resolveExportedSymbol(targetFile, localName, fnDefIndex, fileImportInfo, nextVisited, argumentCount, filesByPath));
        const aliasDefinitions = [...new Map(aliasResults.flatMap((item) => item.definitions || []).map((definition) => [definition.key, definition])).values()];
        const hasAmbiguousAlias = aliasResults.some((item) => item.status === 'ambiguous');
        const aliasDepth = 1 + Math.max(0, ...aliasResults.map((item) => item.exportAliasDepth || 0));
        if (aliasDefinitions.length === 1 && !hasAmbiguousAlias) {
            return { definitions: aliasDefinitions, status: 'resolved', candidates: aliasDefinitions, reExportDepth: Math.max(0, ...aliasResults.map((item) => item.reExportDepth || 0)), exportAliasDepth: aliasDepth };
        }
        if (aliasDefinitions.length > 1 || hasAmbiguousAlias) {
            return { definitions: [], status: 'ambiguous', candidates: aliasDefinitions, reExportDepth: Math.max(0, ...aliasResults.map((item) => item.reExportDepth || 0)), exportAliasDepth: aliasDepth };
        }
    }

    const named = (info.reExports && info.reExports[symbolName]) || [];
    const wildcard = (info.starReExports || []).map((item) => ({ ...item, importedName: symbolName }));
    const links = [...named, ...wildcard];
    if (!links.length) return { definitions: [], status: 'unresolved', candidates: [], reExportDepth: 0, exportAliasDepth: 0 };

    const found = [];
    let sawAmbiguous = false;
    let maxDepth = 0;
    for (const link of links) {
        const resolved = resolveExportedSymbol(link.file, link.importedName || symbolName, fnDefIndex, fileImportInfo, nextVisited, argumentCount, filesByPath);
        maxDepth = Math.max(maxDepth, 1 + (resolved.reExportDepth || 0));
        if (resolved.status === 'ambiguous') sawAmbiguous = true;
        found.push(...(resolved.definitions || []));
    }
    const unique = [...new Map(found.map((definition) => [definition.key, definition])).values()];
    if (unique.length === 1) return { definitions: unique, status: 'resolved', candidates: unique, reExportDepth: maxDepth, exportAliasDepth: 0 };
    if (unique.length > 1 || sawAmbiguous) return { definitions: [], status: 'ambiguous', candidates: unique, reExportDepth: maxDepth, exportAliasDepth: 0 };
    return { definitions: [], status: 'unresolved', candidates: [], reExportDepth: maxDepth, exportAliasDepth: 0 };
}

function inferArityForDefinition(definition, filesByPath) {
    const file = filesByPath?.get(definition?.file);
    if (!file || typeof file.content !== 'string') return null;
    const lines = file.content.split('\n');
    const startLine = Math.max(1, Number(definition.line) || 1);
    const endLine = Math.max(startLine, Math.min(lines.length, Number(definition.endLine) || startLine));
    const sourceSpan = lines.slice(startLine - 1, Math.min(endLine, startLine + 120)).join('\n');
    const signature = extractParameterList(sourceSpan, definition, file.path);
    return Number.isInteger(signature?.count) ? signature.count : null;
}

/** Use argument count only as a conservative disambiguator. If any overload
 * has unknown arity, or nothing matches, keep the original candidate set. */
function narrowByArity(candidates, argumentCount, filesByPath) {
    if (!Number.isInteger(argumentCount) || candidates.length < 2) return candidates;
    const counted = candidates.map((candidate) => ({ candidate, arity: inferArityForDefinition(candidate, filesByPath) }));
    if (counted.some((item) => item.arity === null)) return candidates;
    const matches = counted.filter((item) => item.arity === argumentCount).map((item) => item.candidate);
    return matches.length ? matches : candidates;
}

function resolveCallDefinitions(fnName, file, fnDefIndex, fileImportInfo, argumentCount = null, filesByPath = new Map()) {
    const imports = fileImportInfo[file.path] || { locals: {}, targets: new Set(), bindings: {} };
    const uniqueCandidate = (candidates, reason) => {
        if (candidates.length === 1) return { definitions: candidates, status: 'resolved', reason, candidates };
        if (candidates.length > 1) return {
            definitions: [], status: 'ambiguous', reason: 'multiple candidate definitions remain',
            candidates: candidates.map((definition) => ({ file: definition.file, line: definition.line, key: definition.key, name: definition.name })),
        };
        return null;
    };

    // Resolve explicit aliases against the import's exported symbol. Follow
    // known re-export edges so common barrel files don't break call resolution.
    const explicitBindings = (imports.bindings && imports.bindings[fnName]) || [];
    if (explicitBindings.length) {
        const resolvedDefinitions = [];
        const unresolvedBindings = [];
        let sawAmbiguous = false;
        let followedReExport = false;
        let followedLocalAlias = false;
        for (const binding of explicitBindings) {
            const result = resolveExportedSymbol(binding.file, binding.importedName, fnDefIndex, fileImportInfo, new Set(), argumentCount, filesByPath);
            if (result.status === 'resolved') {
                resolvedDefinitions.push(...result.definitions);
                if (result.reExportDepth > 0) followedReExport = true;
                if (result.exportAliasDepth > 0) followedLocalAlias = true;
            } else {
                if (result.status === 'ambiguous') sawAmbiguous = true;
                unresolvedBindings.push({ file: binding.file, importedName: binding.importedName, localName: fnName, candidates: result.candidates || [] });
            }
        }
        const unique = [...new Map(resolvedDefinitions.map((definition) => [definition.key, definition])).values()];
        if (unique.length === 1 && !sawAmbiguous) {
            const reason = followedReExport
                ? 'explicit imported binding through re-export chain'
                : followedLocalAlias ? 'explicit imported binding through local export alias' : 'explicit imported alias';
            return { definitions: unique, status: 'resolved', reason, candidates: unique };
        }
        if (unique.length > 1 || sawAmbiguous) {
            return { definitions: [], status: 'ambiguous', reason: 'imported symbol resolves to multiple possible definitions', candidates: unique.length ? unique : unresolvedBindings };
        }
        return {
            definitions: [], status: explicitBindings.length > 1 ? 'ambiguous' : 'unresolved',
            reason: 'explicit imported alias did not resolve to a unique function definition',
            candidates: unresolvedBindings.length ? unresolvedBindings : explicitBindings.map((binding) => ({ file: binding.file, importedName: binding.importedName, localName: fnName })),
        };
    }

    const defs = fnDefIndex.byName[fnName] || [];
    const arityDefs = narrowByArity(defs, argumentCount, filesByPath);
    if (!defs.length) return { definitions: [], status: 'unresolved', reason: 'no repository definition or explicit alias target found', candidates: [] };

    const rawSameFile = defs.filter((definition) => definition.file === file.path);
    const sameFile = narrowByArity(rawSameFile, argumentCount, filesByPath);
    const sameFileReason = rawSameFile.length > 1 && sameFile.length === 1 && Number.isInteger(argumentCount)
        ? `same-file overload matched by ${argumentCount}-argument call-site evidence`
        : 'same-file definition';
    const sameFileResult = uniqueCandidate(sameFile, sameFileReason);
    if (sameFileResult) return sameFileResult;

    const directImports = (imports.locals && imports.locals[fnName]) || [];
    if (directImports.length) {
        const directMatches = narrowByArity(defs.filter((definition) => directImports.includes(definition.file)), argumentCount, filesByPath);
        const directResult = uniqueCandidate(directMatches, 'explicit imported binding');
        if (directResult) return directResult;
    }

    if (imports.targets && typeof imports.targets.has === 'function') {
        const targetMatches = narrowByArity(defs.filter((definition) => imports.targets.has(definition.file)), argumentCount, filesByPath);
        const targetResult = uniqueCandidate(targetMatches, 'imported module');
        if (targetResult) return targetResult;
    }

    return {
        definitions: [],
        status: arityDefs.length > 1 ? 'ambiguous' : 'unresolved',
        reason: arityDefs.length > 1 ? 'same-named definitions exist but import/type resolution did not select one' : 'cross-file call has no verified import relationship',
        candidates: arityDefs.map((definition) => ({ file: definition.file, line: definition.line, key: definition.key })),
    };
}


function inferredFunctionEndLine(fn) {
    if (Number.isInteger(fn?.endLine) && fn.endLine >= fn.line) return fn.endLine;
    const codeLineCount = typeof fn?.code === 'string' && fn.code.length ? fn.code.split('\n').length : 1;
    return Math.max(Number(fn?.line) || 1, (Number(fn?.line) || 1) + codeLineCount - 1);
}

/**
 * Recover a conservative body end from source when a language fallback only
 * returned the declaration line. This is particularly useful for regex-based
 * Java/JS/C-like extraction: previously every call inside such a body appeared
 * to be module-scope. It only scans brace-delimited bodies and never invents a
 * range for indentation/end-keyword languages.
 */
function inferSourceFunctionEndLine(fn, filesByPath) {
    const file = filesByPath?.get(fn?.file);
    if (!file || typeof file.content !== 'string' || !Number.isInteger(fn?.line)) return null;
    const path = String(fn.file || '');
    if (/\.(?:py|pyw|pyi|rb|ex|exs|vba|bas|cls)$/i.test(path)) return null;
    const source = file.content;
    const lines = source.split('\n');
    const startLine = Math.max(1, fn.line);
    const startOffset = lines.slice(0, startLine - 1).reduce((sum, item) => sum + item.length + 1, 0);
    const masked = maskNonCodePreservingPositions(source, path);
    const searchLimit = Math.min(masked.length, startOffset + 12000);
    let paren = 0, bracket = 0, opening = -1;
    for (let i = startOffset; i < searchLimit; i++) {
        const ch = masked[i];
        if (ch === '(') paren++;
        else if (ch === ')') paren = Math.max(0, paren - 1);
        else if (ch === '[') bracket++;
        else if (ch === ']') bracket = Math.max(0, bracket - 1);
        else if (ch === ';' && paren === 0 && bracket === 0) break;
        else if (ch === '{' && paren === 0 && bracket === 0) { opening = i; break; }
    }
    if (opening < 0) return null;
    let depth = 0;
    for (let i = opening; i < masked.length; i++) {
        if (masked[i] === '{') depth++;
        else if (masked[i] === '}' && --depth === 0) return masked.slice(0, i + 1).split('\n').length;
    }
    return null;
}

/**
 * Build a per-file range index once. Caller attribution can see thousands of
 * call sites in a larger file, so filtering/sorting every function for every
 * site is unnecessarily expensive. Prefix maximum end-lines lets point queries
 * reject files/regions with no possible enclosing function quickly.
 */
function buildFunctionRangeIndex(functions, rangeEnds) {
    const grouped = new Map();
    for (const fn of functions || []) {
        if (!fn?.file || !Number.isInteger(fn.line)) continue;
        const endLine = rangeEnds?.get(fn) ?? inferredFunctionEndLine(fn);
        if (!Number.isInteger(endLine) || endLine < fn.line) continue;
        if (!grouped.has(fn.file)) grouped.set(fn.file, []);
        grouped.get(fn.file).push({ fn, startLine: fn.line, endLine });
    }
    for (const [filePath, ranges] of grouped) {
        ranges.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
        let maxEnd = -1;
        for (const range of ranges) {
            maxEnd = Math.max(maxEnd, range.endLine);
            range.prefixMaxEndLine = maxEnd;
        }
        grouped.set(filePath, ranges);
    }
    return grouped;
}

/** Best-effort attribution of a line-based call-site to its innermost function. */
function findEnclosingFunction(rangeIndex, filePath, line) {
    if (!Number.isInteger(line)) return null;
    const ranges = rangeIndex?.get(filePath);
    if (!ranges?.length) return null;
    let low = 0;
    let high = ranges.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (ranges[middle].startLine <= line) low = middle + 1;
        else high = middle;
    }
    let index = low - 1;
    if (index < 0 || ranges[index].prefixMaxEndLine < line) return null;
    let best = null;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (; index >= 0; index--) {
        const range = ranges[index];
        if (best && line - range.startLine > bestSpan) break;
        if (range.endLine < line) continue;
        const span = range.endLine - range.startLine;
        // Sorted by start line, newest range comes first. Keeping the first of
        // equal spans gives the same tie-break as the prior sort-based version.
        if (!best || span < bestSpan) {
            best = range.fn;
            bestSpan = span;
        }
    }
    return best;
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
export function buildCallGraph(files, allFunctions, dependencyEdges = []) {
    annotateJavaMethodOwnership(files, allFunctions);
    const fnDefIndex = Parser.buildFunctionDefinitionIndex(allFunctions);
    const fnNames = Object.keys(fnDefIndex.byName);
    const fnNameIndex = Parser.buildFunctionNameIndex(fnNames);
    const fnDefLineIndex = Parser.buildFunctionDefLineIndex(allFunctions);
    const filesByPath = new Map((files || []).map((file) => [file.path, file]));
    const functionRangeEnds = new WeakMap();
    for (const fn of allFunctions || []) {
        const end = inferredFunctionEndLine(fn);
        const hasWeakEnd = fn?.endLineConfidence === 'declaration-line-only' || end <= (Number(fn?.line) || 1);
        const inferredEnd = hasWeakEnd ? inferSourceFunctionEndLine(fn, filesByPath) : null;
        if (Number.isInteger(inferredEnd) && inferredEnd >= fn.line) functionRangeEnds.set(fn, inferredEnd);
    }
    const functionRangeIndex = buildFunctionRangeIndex(allFunctions, functionRangeEnds);

    const fileImportInfo = {};
    files.forEach((file) => {
        fileImportInfo[file.path] = {
            ...Parser.extractCallGraphImportMap(file.content || '', file.path, files),
            bindings: Object.create(null),
            localExports: extractLocalJsExportAliases(file.content || ''),
            reExports: Object.create(null),
            starReExports: [],
        };
    });
    // Merge the canonical module resolver's edges. This supports TypeScript
    // tsconfig paths and Python package-relative imports that the older local
    // call-graph resolver may not understand. Symbol binding must be explicit;
    // a file dependency without a named binding only adds a module target.
    (dependencyEdges || []).forEach((edge) => {
        if (!edge || edge.resolution !== 'resolved' || !edge.source || !edge.target) return;
        if (!fileImportInfo[edge.source]) fileImportInfo[edge.source] = { locals: Object.create(null), targets: new Set() };
        const info = fileImportInfo[edge.source];
        info.targets.add(edge.target);
        if (edge.type === 're-export') {
            for (const binding of edge.importBindings || []) {
                if (binding?.importedName === '*' && binding?.exportedName === '*') {
                    if (!info.starReExports.some((item) => item.file === edge.target)) info.starReExports.push({ file: edge.target });
                    continue;
                }
                const exportedName = binding?.exportedName;
                if (typeof exportedName !== 'string' || !exportedName || exportedName === '*') continue;
                if (!info.reExports[exportedName]) info.reExports[exportedName] = [];
                if (!info.reExports[exportedName].some((item) => item.file === edge.target && item.importedName === binding.importedName)) {
                    info.reExports[exportedName].push({ file: edge.target, importedName: binding.importedName });
                }
            }
            return;
        }
        for (const binding of edge.importBindings || []) {
            if (!binding?.localName) continue;
            if (!info.locals[binding.localName]) info.locals[binding.localName] = [];
            if (!info.locals[binding.localName].includes(edge.target)) info.locals[binding.localName].push(edge.target);
            if (!info.bindings[binding.localName]) info.bindings[binding.localName] = [];
            const bindingKey = `${edge.target}|${binding.importedName}`;
            if (!info.bindings[binding.localName].some((item) => `${item.file}|${item.importedName}` === bindingKey)) {
                info.bindings[binding.localName].push({ file: edge.target, importedName: binding.importedName, localName: binding.localName });
            }
        }
    });

    const connections = [];
    const functionConnections = [];
    // Attribution metrics count resolved call-site units only. Keep unresolved
    // receiver calls in a separate diagnostic so they cannot depress attributionPct.
    let functionCallSiteCount = 0;
    let locatedFunctionCallSiteCount = 0;
    let callSiteEvidenceMissingCount = 0;
    let unattributedFunctionCallSiteCount = 0;
    let unresolvedUnattributedCallSiteCount = 0;
    let explicitReceiverCallSiteCount = 0;
    let resolvedExplicitReceiverCallSiteCount = 0;
    let typedReceiverCallSiteCount = 0;
    let resolvedTypedReceiverCallSiteCount = 0;
    let resolvedNamespaceCalls = 0;
    const fnStats = {};
    const unresolvedCalls = [];
    let totalCallNameReferences = 0;
    let resolvedCallNameReferences = 0;
    let unresolvedCallCount = 0;
    let ambiguousCallCount = 0;
    let externalLikelyReceiverCallCount = 0;
    let projectUnknownReceiverCallCount = 0;
    Object.keys(fnDefIndex.byKey).forEach((key) => {
        const fn = fnDefIndex.byKey[key];
        fnStats[key] = {
            key, name: fn.name, internal: 0, external: 0, callers: new Map(),
            file: fn.file, folder: fn.file.split('/').slice(0, -1).join('/'), line: fn.line, code: fn.code,
            unresolvedIncoming: 0,
            isTopLevel: fn.isTopLevel !== false, isExported: !!fn.isExported, isClassMethod: !!fn.isClassMethod,
            type: fn.type || 'function', decorators: fn.decorators || null, className: fn.className || null,
        };
    });

    files.forEach((file) => {
        // Markdown, YAML, SQL and other non-code documents may contain runnable
        // examples, but those are not executable call sites in this repository.
        if (!file.content || !identifyCodeLanguage(file.path)) return;
        let calls;
        try {
            const fileBindings = fileImportInfo[file.path]?.bindings || {};
            // A named import may represent a class, type, constant or module rather
            // than a function. Only add aliases to the call-name candidate set when
            // the imported/re-exported target actually has extracted function defs.
            // Typed receiver resolution still uses all bindings independently.
            const localAliases = Object.entries(fileBindings).filter(([, bindings]) => (bindings || []).some((binding) => {
                const resolved = resolveExportedSymbol(binding.file, binding.importedName, fnDefIndex, fileImportInfo);
                const candidates = [...(resolved.definitions || []), ...(resolved.candidates || [])];
                return candidates.some((candidate) => candidate?.key && fnDefIndex.byKey[candidate.key]);
            })).map(([alias]) => alias);
            const fileCandidateNames = [...new Set([...fnNames, ...localAliases])];
            const fileNameIndex = Parser.buildFunctionNameIndex(fileCandidateNames);
            const callSource = maskImportDeclarations(file.content, file.path);
            calls = Parser.findCalls(callSource, fileCandidateNames, file.path, fnDefLineIndex, fileNameIndex) || {};
        } catch {
            calls = {};
        }
        const receiverCallSites = findReceiverCallSites(file.content, file.path);
        const typedObjectCallSites = findTypedObjectCallSites(file.content, file.path);
        const genericParserReceiverSites = [...receiverCallSites, ...typedObjectCallSites];
        if (isReceiverCallCountIncludedByGenericParser(file.path) && genericParserReceiverSites.length) {
            const receiverCounts = new Map();
            for (const site of genericParserReceiverSites) receiverCounts.set(site.methodName, (receiverCounts.get(site.methodName) || 0) + 1);
            for (const [methodName, receiverCount] of receiverCounts) {
                if (Number.isFinite(calls[methodName])) calls[methodName] = Math.max(0, calls[methodName] - receiverCount);
            }
        }

        Object.entries(calls).forEach(([fnName, cnt]) => {
            if (cnt <= 0) return;
            const callSites = findCallSiteEvidence(file.content, fnName, file.path, 1000, allFunctions);
            const observedArities = [...new Set(callSites.map((site) => site.argumentCount).filter(Number.isInteger))];
            const argumentCount = observedArities.length === 1 && callSites.length > 0 ? observedArities[0] : null;
            totalCallNameReferences += cnt;
            const resolution = resolveCallDefinitions(fnName, file, fnDefIndex, fileImportInfo, argumentCount, filesByPath);
            if (resolution.status !== 'resolved' || resolution.definitions.length !== 1) {
                if (resolution.status === 'ambiguous') ambiguousCallCount += cnt;
                else unresolvedCallCount += cnt;
                (resolution.candidates || []).forEach((candidate) => {
                    const candidateKey = candidate.key || Object.keys(fnStats).find((candidateFnKey) => {
                        const stat = fnStats[candidateFnKey];
                        return stat.file === candidate.file && stat.line === candidate.line && stat.name === fnName;
                    });
                    if (candidateKey && fnStats[candidateKey]) fnStats[candidateKey].unresolvedIncoming += cnt;
                });
                unresolvedCalls.push({
                    file: file.path,
                    functionName: fnName,
                    count: cnt,
                    status: resolution.status,
                    reason: resolution.reason,
                    candidates: resolution.candidates,
                    callSiteEvidence: {
                        path: file.path,
                        kind: 'heuristic-line-locator',
                        sites: callSites.slice(0, 20),
                    },
                });
                return;
            }
            resolvedCallNameReferences += cnt;
            const def = resolution.definitions[0];
            const stat = fnStats[def.key];
            if (!stat) return;
            const callSiteEvidence = {
                path: file.path,
                kind: 'heuristic-line-locator',
                // Keep report payloads bounded, but calculate metrics from all
                // located call sites rather than the first 20 serialized edges.
                sites: callSites.slice(0, 20),
            };
            const metricSiteCount = Math.max(cnt, callSites.length);
            functionCallSiteCount += metricSiteCount;
            locatedFunctionCallSiteCount += callSites.length;
            const missingLocators = Math.max(0, cnt - callSites.length);
            if (missingLocators) {
                callSiteEvidenceMissingCount += missingLocators;
                unattributedFunctionCallSiteCount += missingLocators;
            }
            for (let siteIndex = 0; siteIndex < callSites.length; siteIndex++) {
                const site = callSites[siteIndex];
                const callerFn = findEnclosingFunction(functionRangeIndex, file.path, site.line);
                if (!callerFn) unattributedFunctionCallSiteCount += 1;
                // Only serialize a bounded sample of edges. Attribution statistics
                // above still account for every source-located site.
                if (siteIndex >= callSiteEvidence.sites.length) continue;
                functionConnections.push({
                    callerFunctionKey: callerFn?.key || (callerFn ? Parser.functionKey(callerFn) : null),
                    callerFunctionName: callerFn?.name || null,
                    callerFile: file.path,
                    callerStartLine: callerFn?.line ?? null,
                    calleeFunctionKey: def.key,
                    calleeFunctionName: def.name,
                    calleeFile: def.file,
                    calleeStartLine: def.line,
                    callSiteLine: site.line,
                    callSiteColumn: Number.isInteger(site.column) ? site.column : null,
                    callName: fnName,
                    argumentCount: site.argumentCount ?? null,
                    callSiteExcerpt: site.excerpt,
                    resolution: 'resolved',
                    confidence: 'medium',
                    attribution: callerFn ? 'heuristic-function-line-range' : 'module-scope-or-unattributed',
                    aggregateCallCountInCallerFile: cnt,
                    resolvedBy: resolution.reason,
                });
            }
            // Parser call counts can exceed available source locators (for example,
            // calls collapsed by the fallback counter). Those units remain in the
            // denominator and are explicitly counted as missing attribution evidence.
            if (def.file === file.path) {
                stat.internal += cnt;
            } else {
                connections.push({
                    source: def.file, target: file.path, fn: fnName, count: cnt,
                    functionKey: def.key, resolution: 'resolved', confidence: 'medium', resolvedBy: resolution.reason,
                    callSiteEvidence,
                });
                const existing = stat.callers.get(file.path);
                if (existing) existing.count += cnt;
                else stat.callers.set(file.path, { file: file.path, count: cnt });
                stat.external += cnt;
            }
        });

        // Resolve explicit receiver calls conservatively. `super.foo()` follows
        // only a unique single-inheritance chain; ambiguous/MRO-heavy cases remain unresolved.
        for (const site of receiverCallSites) {
            explicitReceiverCallSiteCount += 1;
            totalCallNameReferences += 1;
            const callerFn = findEnclosingFunction(functionRangeIndex, file.path, site.line);
            const callerClass = functionClassName(callerFn);
            let uniqueCandidates = [];
            let receiverResolutionReason = 'explicit-receiver-and-method-candidate';
            if (site.receiver === 'super') {
                const resolution = callerClass
                    ? resolveDirectSuperclassMethods(file, callerClass, site.methodName, fileImportInfo, allFunctions, site.argumentCount, filesByPath)
                    : { status: 'unresolved', candidates: [], reason: 'super-call-caller-class-unresolved' };
                uniqueCandidates = resolution.candidates || [];
                receiverResolutionReason = resolution.reason || 'super-call-needs-inheritance-resolution';
                if (resolution.status !== 'resolved' || uniqueCandidates.length !== 1) {
                    const status = resolution.status === 'ambiguous' ? 'ambiguous' : 'unresolved';
                    if (status === 'ambiguous') ambiguousCallCount += 1; else unresolvedCallCount += 1;
                    if (!callerFn) unresolvedUnattributedCallSiteCount += 1;
                    unresolvedCalls.push({
                        file: file.path, functionName: site.methodName, count: 1, status,
                        reason: receiverResolutionReason, receiver: site.receiver,
                        candidates: uniqueCandidates.map((fn) => ({ file: fn.file, line: fn.line, name: fn.name, className: functionClassName(fn) })),
                        callSiteEvidence: { path: file.path, kind: 'explicit-receiver-line-locator', sites: [{ line: site.line, column: site.column, excerpt: site.excerpt }] },
                    });
                    continue;
                }
            } else {
                let candidates = allFunctions.filter((fn) => fn.file === file.path && simpleFunctionName(fn) === site.methodName &&
                    (fn.isClassMethod || fn.className || String(fn.name || '').includes('.') || ['method', 'constructor', 'classmethod', 'staticmethod', 'property'].includes(String(fn.type || '').replace(/^async_/, ''))));
                // this/self/cls have meaning only with an evidenced owning
                // class. A globally unique method in the same file does NOT
                // prove that an unrelated top-level this.foo() invokes it.
                if (!callerClass) candidates = [];
                else candidates = candidates.filter((fn) => functionClassName(fn) === callerClass);
                uniqueCandidates = [...new Map(candidates.map((fn) => [fn.key || Parser.functionKey(fn), fn])).values()];
                const narrowed = narrowByArity(uniqueCandidates, site.argumentCount, filesByPath);
                if (narrowed.length === 1 && uniqueCandidates.length > 1) receiverResolutionReason = `same-class overload matched by ${site.argumentCount}-argument call-site evidence`;
                uniqueCandidates = narrowed;
            }
            if (uniqueCandidates.length !== 1) {
                const status = uniqueCandidates.length > 1 ? 'ambiguous' : 'unresolved';
                if (status === 'ambiguous') ambiguousCallCount += 1;
                else unresolvedCallCount += 1;
                if (!callerFn) unresolvedUnattributedCallSiteCount += 1;
                for (const candidate of uniqueCandidates) {
                    const candidateKey = candidate.key || Parser.functionKey(candidate);
                    if (fnStats[candidateKey]) fnStats[candidateKey].unresolvedIncoming += 1;
                }
                unresolvedCalls.push({
                    file: file.path, functionName: site.methodName, count: 1, status,
                    reason: !callerFn ? 'receiver-call-caller-function-unresolved' : status === 'ambiguous' ? 'multiple-same-class-method-candidates' : callerClass ? 'same-class-method-not-found' : 'receiver-call-class-context-unresolved',
                    receiver: site.receiver,
                    candidates: uniqueCandidates.map((fn) => ({ file: fn.file, line: fn.line, name: fn.name, className: functionClassName(fn) })),
                    callSiteEvidence: { path: file.path, kind: 'explicit-receiver-line-locator', sites: [{ line: site.line, column: site.column, excerpt: site.excerpt }] },
                });
                continue;
            }
            const target = uniqueCandidates[0];
            const targetKey = target.key || Parser.functionKey(target);
            const stat = fnStats[targetKey];
            if (!stat) {
                unresolvedCallCount += 1;
                if (!callerFn) unresolvedUnattributedCallSiteCount += 1;
                unresolvedCalls.push({ file: file.path, functionName: site.methodName, count: 1, status: 'unresolved', reason: 'resolved-target-missing-from-function-index', receiver: site.receiver,
                    callSiteEvidence: { path: file.path, kind: 'explicit-receiver-line-locator', sites: [{ line: site.line, column: site.column, excerpt: site.excerpt }] } });
                continue;
            }
            resolvedCallNameReferences += 1;
            functionCallSiteCount += 1;
            locatedFunctionCallSiteCount += 1;
            resolvedExplicitReceiverCallSiteCount += 1;
            if (!callerFn) unattributedFunctionCallSiteCount += 1;
            functionConnections.push({
                callerFunctionKey: callerFn?.key || (callerFn ? Parser.functionKey(callerFn) : null),
                callerFunctionName: callerFn?.name || null,
                callerFile: file.path,
                callerStartLine: callerFn?.line ?? null,
                calleeFunctionKey: targetKey,
                calleeFunctionName: target.name,
                calleeFile: target.file,
                calleeStartLine: target.line,
                callSiteLine: site.line,
                callSiteColumn: site.column,
                callName: site.methodName,
                argumentCount: site.argumentCount ?? null,
                callSiteExcerpt: site.excerpt,
                receiver: site.receiver,
                resolution: 'resolved',
                confidence: 'medium',
                attribution: callerFn ? (callerClass ? 'explicit-receiver-same-class' : 'explicit-receiver-unique-method') : 'module-scope-or-unattributed',
                aggregateCallCountInCallerFile: 1,
                resolvedBy: receiverResolutionReason,
            });
            stat.internal += 1;
        }

        const receiverTypes = inferReceiverTypes(file);
        const moduleBindings = moduleImportBindings(file, filesByPath, fileImportInfo[file.path]);
        for (const site of typedObjectCallSites) {
            typedReceiverCallSiteCount += 1;
            const callerFn = findEnclosingFunction(functionRangeIndex, file.path, site.line);
            totalCallNameReferences += 1;
            const namespaceResolution = resolveNamespaceMethod(site.receiverExpression, site.methodName, moduleBindings, allFunctions, site.argumentCount, filesByPath);
            const resolution = namespaceResolution || resolveTypedReceiverMethod(file, site.receiverExpression, site.methodName, callerFn, fileImportInfo, allFunctions, receiverTypes, site.argumentCount, filesByPath);
            if (resolution.status !== 'resolved' || (resolution.candidates || []).length !== 1) {
                // Report these known method-shaped sites as unresolved rather than
                // silently dropping them from call-reference coverage. Do not count
                // them in the resolved-call attribution denominator.
                if (resolution.status === 'ambiguous') ambiguousCallCount += 1;
                else unresolvedCallCount += 1;
                const unresolvedClass = classifyUnresolvedReceiverCall(site);
                if (resolution.status !== 'ambiguous') {
                    if (unresolvedClass.classification === 'external-likely') externalLikelyReceiverCallCount += 1;
                    else projectUnknownReceiverCallCount += 1;
                }
                if (!callerFn) unresolvedUnattributedCallSiteCount += 1;
                unresolvedCalls.push({
                    file: file.path,
                    functionName: site.methodName,
                    count: 1,
                    status: resolution.status === 'ambiguous' ? 'ambiguous' : 'unresolved',
                    reason: resolution.reason || 'typed-receiver-target-not-uniquely-resolved',
                    unresolvedClassification: unresolvedClass.classification,
                    unresolvedClassificationReason: unresolvedClass.reason,
                    receiver: site.receiverExpression,
                    candidates: (resolution.candidates || []).map((candidate) => ({ file: candidate.file, line: candidate.line, name: candidate.name, className: functionClassName(candidate) })),
                    callSiteEvidence: { path: file.path, kind: 'typed-receiver-line-locator', sites: [{ line: site.line, column: site.column, excerpt: site.excerpt }] },
                });
                continue;
            }
            const target = resolution.candidates[0];
            const targetKey = target.key || Parser.functionKey(target);
            const stat = fnStats[targetKey];
            if (!stat) {
                unresolvedCallCount += 1;
                if (!callerFn) unresolvedUnattributedCallSiteCount += 1;
                unresolvedCalls.push({ file: file.path, functionName: site.methodName, count: 1, status: 'unresolved', reason: 'resolved-target-missing-from-function-index', receiver: site.receiverExpression,
                    callSiteEvidence: { path: file.path, kind: 'typed-receiver-line-locator', sites: [{ line: site.line, column: site.column, excerpt: site.excerpt }] } });
                continue;
            }
            resolvedCallNameReferences += 1;
            functionCallSiteCount += 1;
            locatedFunctionCallSiteCount += 1;
            resolvedTypedReceiverCallSiteCount += 1;
            if (namespaceResolution?.status === 'resolved') resolvedNamespaceCalls += 1;
            if (!callerFn) unattributedFunctionCallSiteCount += 1;
            functionConnections.push({
                callerFunctionKey: callerFn?.key || (callerFn ? Parser.functionKey(callerFn) : null),
                callerFunctionName: callerFn?.name || null,
                callerFile: file.path,
                callerStartLine: callerFn?.line ?? null,
                calleeFunctionKey: targetKey,
                calleeFunctionName: target.name,
                calleeFile: target.file,
                calleeStartLine: target.line,
                callSiteLine: site.line,
                callSiteColumn: site.column,
                callName: site.methodName,
                callSiteExcerpt: site.excerpt,
                receiver: site.receiverExpression,
                argumentCount: site.argumentCount ?? null,
                resolution: 'resolved', confidence: 'medium-low',
                attribution: callerFn ? 'inferred-receiver-type' : 'module-scope-or-unattributed',
                aggregateCallCountInCallerFile: 1,
                resolvedBy: resolution.reason,
            });
            if (target.file === file.path) stat.internal += 1;
            else {
                connections.push({ source: target.file, target: file.path, fn: site.methodName, count: 1, functionKey: targetKey, resolution: 'resolved', confidence: 'medium-low', resolvedBy: resolution.reason,
                    callSiteEvidence: { path: file.path, kind: 'typed-receiver-line-locator', sites: [{ line: site.line, column: site.column, excerpt: site.excerpt }] } });
                const existing = stat.callers.get(file.path);
                if (existing) existing.count += 1; else stat.callers.set(file.path, { file: file.path, count: 1 });
                stat.external += 1;
            }
        }
    });

    Object.values(fnStats).forEach((s) => {
        s.callers = Array.from(s.callers.values());
        s.count = s.internal + s.external;
    });

    return {
        connections,
        functionConnections,
        fnStats,
        diagnostics: {
            schemaVersion: 1,
            totalCallNameReferences,
            resolvedCallNameReferences,
            unresolvedCallCount,
            ambiguousCallCount,
            externalLikelyReceiverCallCount,
            projectUnknownReceiverCallCount,
            unresolvedCalls,
            functionCallSiteCount,
            locatedFunctionCallSiteCount,
            callSiteEvidenceMissingCount,
            unattributedFunctionCallSiteCount,
            unresolvedUnattributedCallSiteCount,
            explicitReceiverCallSiteCount,
            resolvedExplicitReceiverCallSiteCount,
            typedReceiverCallCount: typedReceiverCallSiteCount,
            resolvedTypedReceiverCallSiteCount,
            resolvedNamespaceCalls,
            receiverCallCount: explicitReceiverCallSiteCount + typedReceiverCallSiteCount,
            resolvedReceiverCallCount: resolvedExplicitReceiverCallSiteCount + resolvedTypedReceiverCallSiteCount,
            unresolvedSuperCallCount: unresolvedCalls.filter((item) => item.reason === 'super-call-needs-inheritance-resolution').length,
            semantics: 'Bare calls resolve through same-file definitions or explicit import bindings. When every observed call site has the same known argument count, that count can conservatively narrow fully-known overload candidates; this is not full type/overload resolution. Explicit this/self/cls calls resolve only when a unique same-class method target is available. Other object calls resolve only when a simple declaration/constructor pattern yields one receiver type and one target method; these inferred edges have lower confidence. A direct super target is resolved only for a single parsed direct base with a unique same-file or explicitly imported method; Python multiple inheritance, indirect inheritance and dynamic dispatch remain unresolved. Caller attribution uses source-line containment and is heuristic. Attribution denominator counts resolved call-site units only; unresolved/unattributed calls are reported separately. Bare-call attribution metrics use all located sites (up to the locator cap), even when only a bounded sample of edge records is serialized. Unresolved receiver calls are classified as likely external/runtime/framework calls or project/unknown calls for review prioritization; this classification is heuristic and does not suppress either class. Unresolved names are excluded from confirmed edges.',
        },
    };
}

const DEAD_CODE_EXEMPT_NAMES = new Set([
    'main', 'create_app', 'make_app', 'get_app', 'setup', 'configure', 'register',
    'on_startup', 'on_shutdown', 'lifespan', 'setUp', 'tearDown', 'setUpClass', 'tearDownClass',
]);

/** Same exemption rules as dead-function filter — entry points, dunders, tests, exported JS/TS symbols, etc. never count as "dead". */
function isDeadCandidate(stats) {
    if (stats.internal > 0 || stats.external > 0 || stats.unresolvedIncoming > 0) return false;
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
export function buildIssues({ files, connections = [], dependencies, fnStats, duplicates, layerViolations }) {
    const issues = [];
    // File-level architecture metrics must use the module dependency graph,
    // not the narrower function-call graph. `connections` remains the legacy
    // call graph for the unused-function calculation and backwards compatibility.
    const structuralEdges = (Array.isArray(dependencies) ? dependencies : connections)
        .filter((edge) => !edge?.resolution || edge.resolution === 'resolved');

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

    const importersByDependency = new Map();
    structuralEdges.forEach((edge) => {
        if (!edge?.source || !edge?.target || edge.source === edge.target) return;
        if (!importersByDependency.has(edge.target)) importersByDependency.set(edge.target, new Set());
        importersByDependency.get(edge.target).add(edge.source);
    });
    const highCoupled = [...importersByDependency.entries()]
        .map(([path, importers]) => [path, importers.size])
        .filter(([, n]) => n > 8)
        .sort((a, b) => b[1] - a[1]);
    if (highCoupled.length) {
        issues.push({
            type: 'warning', title: `${highCoupled.length} Highly Coupled`,
            desc: 'Files imported by 9+ distinct files, based on the module dependency graph',
            items: highCoupled.map(([path, n]) => ({ name: `${path.split('/').pop()} (${n} importing files)`, file: path })),
        });
    }

    const connSet = new Set(structuralEdges.map((c) => `${c.source}|${c.target}`));
    const circularKeys = [];
    structuralEdges.forEach((c) => {
        if (connSet.has(`${c.target}|${c.source}`)) {
            const key = [c.source, c.target].sort().join('|');
            if (!circularKeys.includes(key)) circularKeys.push(key);
        }
    });
    if (circularKeys.length) {
        issues.push({
            type: 'critical', title: `${circularKeys.length} Circular Dependencies`,
            desc: 'Files with mutual edges in the module dependency graph',
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
