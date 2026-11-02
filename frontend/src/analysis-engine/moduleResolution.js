/**
 * Best-effort repository-local module resolution.
 *
 * This module intentionally distinguishes resolved edges from inferred edges.
 * It is not a compiler or language server: dynamic imports, runtime module
 * loaders, Java reflection, Python import hooks and TypeScript project refs are
 * not fully modeled.
 */
import { makeEvidenceEdge } from './analysisContracts.js';

const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue', '.svelte'];

// Bounded parsed-import cache. We cache only syntax extraction, never resolved
// edges: every run still resolves imports against the current file set and
// current tsconfig/package manifests so additions/removals cannot go stale.
const IMPORT_PARSE_CACHE_MAX_ENTRIES = 350;
const IMPORT_PARSE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const parsedImportCache = new Map();
let parsedImportCacheBytes = 0;
let parsedImportCacheHits = 0;
let parsedImportCacheMisses = 0;

function cloneImportRecords(records) { return JSON.parse(JSON.stringify(records || [])); }
function cacheImportRecords(kind, filePath, content, producer) {
    const source = String(content || '');
    // Two independent rolling hashes and exact length make the key cheap; a
    // stored content comparison protects against accidental hash collisions.
    let first = 2166136261, second = 0x9e3779b9;
    for (let i = 0; i < source.length; i++) {
        const code = source.charCodeAt(i);
        first = Math.imul(first ^ code, 16777619) >>> 0;
        second = Math.imul(second ^ (code + i), 2246822519) >>> 0;
    }
    const key = `${kind}|${String(filePath || '').replace(/\\/g, '/') }|${source.length}|${first.toString(16)}|${second.toString(16)}`;
    const previous = parsedImportCache.get(key);
    if (previous && previous.content === source) {
        parsedImportCache.delete(key); parsedImportCache.set(key, previous); parsedImportCacheHits += 1;
        return cloneImportRecords(previous.records);
    }
    parsedImportCacheMisses += 1;
    // Same hashed key with different content is an extraordinarily unlikely
    // collision, but still remove the stale record and its byte accounting.
    if (previous) { parsedImportCacheBytes -= previous.size; parsedImportCache.delete(key); }
    const records = producer(source);
    const serializedSize = source.length * 2 + JSON.stringify(records).length * 2;
    if (serializedSize <= IMPORT_PARSE_CACHE_MAX_BYTES / 2) {
        parsedImportCache.set(key, { content: source, records: cloneImportRecords(records), size: serializedSize });
        parsedImportCacheBytes += serializedSize;
        while (parsedImportCache.size > IMPORT_PARSE_CACHE_MAX_ENTRIES || parsedImportCacheBytes > IMPORT_PARSE_CACHE_MAX_BYTES) {
            const oldestKey = parsedImportCache.keys().next().value;
            if (oldestKey === undefined) break;
            const oldest = parsedImportCache.get(oldestKey);
            parsedImportCacheBytes -= oldest?.size || 0; parsedImportCache.delete(oldestKey);
        }
    }
    return records;
}

export function getModuleResolutionCacheStats() {
    return { entries: parsedImportCache.size, approximateBytes: parsedImportCacheBytes, maxEntries: IMPORT_PARSE_CACHE_MAX_ENTRIES, maxApproximateBytes: IMPORT_PARSE_CACHE_MAX_BYTES, parseHits: parsedImportCacheHits, parseMisses: parsedImportCacheMisses };
}

export function clearModuleResolutionCache() {
    parsedImportCache.clear(); parsedImportCacheBytes = 0; parsedImportCacheHits = 0; parsedImportCacheMisses = 0;
}

function normalizeRepoPath(path) {
    const normalized = String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = [];
    for (const segment of normalized.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (!parts.length) return null;
            parts.pop();
        } else {
            parts.push(segment);
        }
    }
    return parts.join('/');
}

function dirname(path) {
    const index = path.lastIndexOf('/');
    return index < 0 ? '' : path.slice(0, index);
}

function lineAt(content, offset) {
    return content.slice(0, Math.max(0, offset)).split('\n').length;
}

function parseJsonc(text) {
    // Remove comments while preserving quoted strings and newlines, then allow
    // trailing commas commonly found in tsconfig/jsconfig files.
    let out = '';
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];
        if (lineComment) {
            if (c === '\n') { lineComment = false; out += c; } else out += ' ';
            continue;
        }
        if (blockComment) {
            if (c === '*' && next === '/') { out += '  '; i++; blockComment = false; }
            else out += c === '\n' ? '\n' : ' ';
            continue;
        }
        if (quote) {
            out += c;
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === quote) quote = '';
            continue;
        }
        if (c === '"' || c === "'") { quote = c; out += c; continue; }
        if (c === '/' && next === '/') { out += '  '; i++; lineComment = true; continue; }
        if (c === '/' && next === '*') { out += '  '; i++; blockComment = true; continue; }
        out += c;
    }
    // JSONC string values are normally double quoted; single-quoted JSONC
    // values aren't valid JSON and are intentionally ignored rather than guessed.
    return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

function configCandidates(extendsValue, configDir) {
    if (typeof extendsValue !== 'string' || !extendsValue.trim()) return [];
    const value = extendsValue.trim().replace(/\\/g, '/');
    const base = value.startsWith('.') || value.startsWith('/') || /^[A-Za-z]:\//.test(value)
        ? normalizeRepoPath(`${configDir}/${value}`)
        : normalizeRepoPath(`node_modules/${value}`);
    if (!base) return [];
    const candidates = [];
    if (/\.json$/i.test(base)) candidates.push(base);
    else candidates.push(base, `${base}.json`, `${base}/tsconfig.json`);
    return [...new Set(candidates)];
}

function getTsPathMappings(files) {
    const configs = new Map();
    for (const file of files) {
        if (!/(?:^|\/)(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i.test(file.path)) continue;
        try {
            const parsed = parseJsonc(file.content);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) configs.set(normalizeRepoPath(file.path), parsed);
        } catch {
            // Malformed JSONC is reported as missing mapping coverage rather than aborting analysis.
        }
    }

    const resolvedConfigs = new Map();
    function resolveConfig(configPath, stack = new Set()) {
        if (resolvedConfigs.has(configPath)) return resolvedConfigs.get(configPath);
        const config = configs.get(configPath);
        if (!config || stack.has(configPath)) return { options: {}, pathsMap: new Map(), baseUrlAbs: null, extendsCycle: stack.has(configPath) };
        const nextStack = new Set(stack); nextStack.add(configPath);
        const configDir = dirname(configPath);
        const extendedValues = Array.isArray(config.extends) ? config.extends : config.extends ? [config.extends] : [];
        let options = {};
        let pathsMap = new Map();
        let baseUrlAbs = null;
        let extendsCycle = false;
        for (const extendedValue of extendedValues) {
            const parentPath = configCandidates(extendedValue, configDir).find((candidate) => configs.has(candidate));
            if (!parentPath) continue; // package configs outside the checked-in repository cannot be resolved here
            const parent = resolveConfig(parentPath, nextStack);
            options = { ...options, ...(parent.options || {}) };
            pathsMap = new Map([ ...pathsMap, ...(parent.pathsMap || new Map()) ]);
            if (parent.baseUrlAbs !== null) baseUrlAbs = parent.baseUrlAbs;
            extendsCycle ||= !!parent.extendsCycle;
        }
        const own = config.compilerOptions && typeof config.compilerOptions === 'object' ? config.compilerOptions : {};
        if (typeof own.baseUrl === 'string') {
            baseUrlAbs = normalizeRepoPath(`${configDir}/${own.baseUrl}`);
        }
        if (own.paths && typeof own.paths === 'object' && !Array.isArray(own.paths)) {
            const anchor = baseUrlAbs || configDir;
            for (const [pattern, values] of Object.entries(own.paths)) {
                if (!Array.isArray(values)) continue;
                pathsMap.set(pattern, { values: values.filter((value) => typeof value === 'string'), baseUrl: anchor });
            }
        }
        options = { ...options, ...own };
        const result = { options, pathsMap, baseUrlAbs, extendsCycle };
        resolvedConfigs.set(configPath, result);
        return result;
    }

    const mappings = [];
    for (const configPath of configs.keys()) {
        const effective = resolveConfig(configPath);
        const configDir = dirname(configPath);
        for (const [pattern, entry] of effective.pathsMap.entries()) {
            const starIndex = pattern.indexOf('*');
            mappings.push({
                pattern,
                prefix: starIndex < 0 ? pattern : pattern.slice(0, starIndex),
                suffix: starIndex < 0 ? '' : pattern.slice(starIndex + 1),
                hasStar: starIndex >= 0,
                baseUrl: entry.baseUrl ?? configDir ?? '',
                values: entry.values,
                configPath,
                configDir: configDir || '',
                extendsCycle: effective.extendsCycle,
            });
        }
        if (effective.baseUrlAbs !== null) {
            mappings.push({ pattern: '*', prefix: '', suffix: '', hasStar: true, baseUrl: effective.baseUrlAbs, values: ['*'], configPath, configDir: configDir || '', extendsCycle: effective.extendsCycle, isBaseUrlFallback: true });
        }
    }
    return mappings.sort((a, b) => b.prefix.length - a.prefix.length || b.suffix.length - a.suffix.length || b.configDir.length - a.configDir.length);
}

function moduleCandidates(basePath, extensions = JS_EXTENSIONS) {
    const normalized = normalizeRepoPath(basePath);
    if (!normalized) return [];
    const hasExtension = /\.[A-Za-z0-9]+$/.test(normalized);
    if (hasExtension) return [normalized];
    return [normalized, ...extensions.map((ext) => `${normalized}${ext}`), ...extensions.map((ext) => `${normalized}/index${ext}`)];
}

/**
 * TypeScript projects commonly write runtime extensions in source imports
 * (e.g. `import { x } from './service.js'`) while the repository contains
 * only `service.ts`. Apply TypeScript-style extension substitution for TS
 * importers, preserving exact JS resolution for ordinary JavaScript files.
 */
function moduleCandidatesForSpecifier(basePath, sourcePath) {
    const normalized = normalizeRepoPath(basePath);
    if (!normalized) return [];
    const sourceIsTypeScript = /\.(?:ts|tsx|mts|cts)$/i.test(sourcePath);
    if (!sourceIsTypeScript) return moduleCandidates(normalized);

    const match = normalized.match(/\.(js|jsx|mjs|cjs)$/i);
    if (!match) return moduleCandidates(normalized);
    const ext = match[1].toLowerCase();
    const stem = normalized.slice(0, -(ext.length + 1));
    const substitutions = ext === 'js'
        ? ['.ts', '.tsx', '.d.ts', '.js']
        : ext === 'jsx'
            ? ['.tsx', '.d.ts', '.jsx']
            : ext === 'mjs'
                ? ['.mts', '.d.mts', '.mjs']
                : ['.cts', '.d.cts', '.cjs'];
    return [...new Set(substitutions.map((suffix) => `${stem}${suffix}`))];
}


function packageManifestRecords(files) {
    const records = [];
    for (const file of files) {
        if (!/(?:^|\/)package\.json$/i.test(file.path)) continue;
        try {
            const manifest = JSON.parse(file.content);
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
            records.push({
                path: normalizeRepoPath(file.path),
                root: dirname(normalizeRepoPath(file.path)),
                name: typeof manifest.name === 'string' ? manifest.name : null,
                exports: manifest.exports,
                imports: manifest.imports,
                entry: manifest.types || manifest.typings || manifest.module || manifest.main || null,
            });
        } catch {
            // A malformed manifest cannot be a resolution authority.
        }
    }
    return records.sort((a, b) => b.root.length - a.root.length);
}

function packageScopeForSource(sourcePath, manifests) {
    return manifests
        .filter((item) => !item.root || sourcePath === item.root || sourcePath.startsWith(`${item.root}/`))
        .sort((a, b) => b.root.length - a.root.length)[0] || null;
}

function chooseConditionalTarget(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        for (const item of value) {
            const selected = chooseConditionalTarget(item);
            if (selected) return selected;
        }
        return null;
    }
    if (!value || typeof value !== 'object') return null;
    // Prefer runtime source targets, then type declarations as a fallback.
    for (const condition of ['import', 'browser', 'node', 'default', 'require', 'types', 'typings']) {
        if (Object.prototype.hasOwnProperty.call(value, condition)) {
            const selected = chooseConditionalTarget(value[condition]);
            if (selected) return selected;
        }
    }
    for (const item of Object.values(value)) {
        const selected = chooseConditionalTarget(item);
        if (selected) return selected;
    }
    return null;
}

function selectSubpathTarget(map, subpath) {
    if (typeof map === 'string' || Array.isArray(map)) return subpath === '.' ? chooseConditionalTarget(map) : null;
    if (!map || typeof map !== 'object') return null;
    const keys = Object.keys(map);
    const isSubpathMap = keys.some((key) => key.startsWith('.') || key.startsWith('#'));
    if (!isSubpathMap) return subpath === '.' ? chooseConditionalTarget(map) : null;
    if (Object.prototype.hasOwnProperty.call(map, subpath)) return chooseConditionalTarget(map[subpath]);
    const matches = keys.map((key) => {
        const star = key.indexOf('*');
        if (star < 0) return null;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return null;
        if (subpath.length < prefix.length + suffix.length) return null;
        return { key, prefix, suffix, matched: subpath.slice(prefix.length, subpath.length - suffix.length) };
    }).filter(Boolean).sort((a, b) => b.prefix.length - a.prefix.length || b.suffix.length - a.suffix.length);
    if (!matches.length) return null;
    const match = matches[0];
    const target = chooseConditionalTarget(map[match.key]);
    return target ? target.replace('*', match.matched) : null;
}

function resolveManifestTarget(manifest, target, sourcePath, filePaths) {
    if (typeof target !== 'string' || !target || target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)) return [];
    // `exports` targets require `./`; legacy `main`/`module` fields often omit it.
    const relativeTarget = target.startsWith('./') ? target.slice(2) : target;
    if (relativeTarget.split('/').includes('..')) return [];
    const packageRoot = manifest.root || '';
    const base = normalizeRepoPath(`${packageRoot}/${relativeTarget}`);
    if (!base || (packageRoot && base !== packageRoot && !base.startsWith(`${packageRoot}/`))) return [];
    return moduleCandidatesForSpecifier(base, sourcePath).filter((candidate) => filePaths.has(candidate));
}

function resolvePackageSpecifier(specifier, sourcePath, filePaths, manifests) {
    // Node-style package `imports` entries (`#internal/*`) are scoped to the
    // nearest package manifest. Unknown # imports remain explicitly local but unresolved.
    if (specifier.startsWith('#')) {
        const scope = packageScopeForSource(sourcePath, manifests);
        if (!scope || !scope.imports) return { targets: [], isLocal: true, resolvedBy: 'package-import-map' };
        const target = selectSubpathTarget(scope.imports, specifier);
        return {
            targets: target ? resolveManifestTarget(scope, target, sourcePath, filePaths) : [],
            isLocal: true,
            resolvedBy: 'package-import-map',
        };
    }

    // Only resolve packages that are actually present in this repository.
    // External npm dependencies are not reported as unresolved local imports.
    const matching = manifests.filter((item) => item.name && (specifier === item.name || specifier.startsWith(`${item.name}/`)))
        .sort((a, b) => b.name.length - a.name.length || b.root.length - a.root.length);
    if (!matching.length) return { targets: [], isLocal: false, resolvedBy: null };
    const manifest = matching[0];
    const subpath = specifier === manifest.name ? '.' : `.${specifier.slice(manifest.name.length)}`;
    let target = null;
    if (manifest.exports !== undefined) {
        target = selectSubpathTarget(manifest.exports, subpath);
    } else if (subpath === '.') {
        target = manifest.entry || './index.js';
    } else {
        target = subpath;
    }
    return {
        targets: target ? resolveManifestTarget(manifest, target, sourcePath, filePaths) : [],
        isLocal: true,
        resolvedBy: 'workspace-package-manifest',
    };
}

function resolveJsSpecifier(specifier, sourcePath, filePaths, mappings, manifests = []) {
    const localCandidates = [];
    const isRelative = specifier.startsWith('.');
    let isLocal = isRelative;
    let explicitPathMappingMatched = false;
    let baseUrlFallbackMatched = false;
    if (isRelative) {
        const base = normalizeRepoPath(`${dirname(sourcePath)}/${specifier}`);
        if (base) localCandidates.push(...moduleCandidatesForSpecifier(base, sourcePath));
    } else {
        // In monorepos, mappings belong to the closest configuration that contains the importer.
        const applicable = mappings.filter((mapping) => !mapping.configDir || sourcePath === mapping.configDir || sourcePath.startsWith(`${mapping.configDir}/`));
        const nearestConfigLength = applicable.reduce((length, mapping) => Math.max(length, mapping.configDir?.length || 0), -1);
        const scopedMappings = nearestConfigLength < 0 ? [] : applicable.filter((mapping) => (mapping.configDir?.length || 0) === nearestConfigLength);
        const matches = scopedMappings.filter((mapping) => {
            if (!specifier.startsWith(mapping.prefix) || !specifier.endsWith(mapping.suffix)) return false;
            if (!mapping.hasStar && specifier !== mapping.pattern) return false;
            return true;
        });
        explicitPathMappingMatched = matches.some((mapping) => !mapping.isBaseUrlFallback);
        baseUrlFallbackMatched = matches.some((mapping) => mapping.isBaseUrlFallback);
        if (explicitPathMappingMatched || baseUrlFallbackMatched) {
            // Explicit `paths` mappings are local by contract. `baseUrl` is a
            // resolution attempt only: if it doesn't match a tracked file, the
            // specifier may still be an external workspace/dependency package.
            isLocal = explicitPathMappingMatched;
            for (const mapping of matches) {
                const wildcardValue = mapping.hasStar
                    ? specifier.slice(mapping.prefix.length, specifier.length - mapping.suffix.length)
                    : '';
                for (const target of mapping.values) {
                    const substituted = target.replace('*', wildcardValue);
                    const base = normalizeRepoPath(`${mapping.baseUrl}/${substituted}`);
                    if (base) localCandidates.push(...moduleCandidatesForSpecifier(base, sourcePath));
                }
            }
        }
    }
    const found = [...new Set(localCandidates.filter((candidate) => filePaths.has(candidate)))];
    // File resolution order matters (e.g. foo.ts before foo.js). Preserve first
    // occurrence and choose the earliest matching candidate for simple imports.
    if (found.length) {
        const target = localCandidates.find((candidate) => filePaths.has(candidate));
        return {
            targets: target ? [target] : found,
            isLocal,
            ambiguous: false,
            resolvedBy: explicitPathMappingMatched ? 'tsconfig-path-mapping' : (isRelative ? 'relative-module-resolution' : (baseUrlFallbackMatched ? 'base-url-resolution' : 'relative-module-resolution')),
        };
    }
    const packageResult = resolvePackageSpecifier(specifier, sourcePath, filePaths, manifests);
    if (packageResult.targets.length) {
        const first = packageResult.targets[0];
        return { ...packageResult, targets: [first], ambiguous: false };
    }
    if (packageResult.isLocal) return { ...packageResult, targets: [], ambiguous: false };
    return { targets: [], isLocal: isRelative || explicitPathMappingMatched, ambiguous: false, resolvedBy: null };
}

/** Mark positions outside JS comments and string literals. Import statement
 * string values are masked too, but the consumer only uses this mask to check
 * whether the `import` / `export` / `require` token itself is real code. */
function buildJsCodePositionMask(content) {
    const mask = new Uint8Array(content.length);
    mask.fill(1);
    let state = 'code';
    let quote = '';
    for (let i = 0; i < content.length; i++) {
        const c = content[i];
        const next = content[i + 1];
        if (state === 'line-comment') {
            mask[i] = 0;
            if (c === '\n') state = 'code';
            continue;
        }
        if (state === 'block-comment') {
            mask[i] = 0;
            if (c === '*' && next === '/') { if (i + 1 < mask.length) mask[i + 1] = 0; i++; state = 'code'; }
            continue;
        }
        if (state === 'string') {
            mask[i] = 0;
            if (c === '\\') { if (i + 1 < mask.length) mask[i + 1] = 0; i++; continue; }
            if (c === quote) state = 'code';
            // JavaScript single/double-quoted strings cannot contain raw newlines.
            else if (c === '\n' && quote !== '`') state = 'code';
            continue;
        }
        if (c === '/' && next === '/') { mask[i] = 0; if (i + 1 < mask.length) mask[i + 1] = 0; i++; state = 'line-comment'; continue; }
        if (c === '/' && next === '*') { mask[i] = 0; if (i + 1 < mask.length) mask[i + 1] = 0; i++; state = 'block-comment'; continue; }
        if (c === '\'' || c === '"' || c === '`') { mask[i] = 0; state = 'string'; quote = c; continue; }
    }
    return mask;
}

/** Python imports embedded in comments or triple-quoted docstrings must not
 * be treated as real repository dependencies. Import names themselves are
 * identifiers, so blanking all strings is safe for this line-based parser. */
function maskPythonNonCode(content) {
    const out = content.split('');
    let state = 'code';
    let quote = '';
    let triple = false;
    for (let i = 0; i < content.length; i++) {
        const c = content[i];
        const next = content[i + 1];
        const third = content[i + 2];
        if (state === 'comment') {
            if (c === '\n') state = 'code'; else out[i] = ' ';
            continue;
        }
        if (state === 'triple-string') {
            if (c === quote && next === quote && third === quote) {
                out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 2; state = 'code'; triple = false;
            } else if (c !== '\n') out[i] = ' ';
            continue;
        }
        if (state === 'string') {
            if (c === '\\') {
                if (c !== '\n') out[i] = ' ';
                if (i + 1 < content.length) { if (content[i + 1] !== '\n') out[i + 1] = ' '; i++; }
                continue;
            }
            if (c === quote) { out[i] = ' '; state = 'code'; continue; }
            if (c === '\n') { state = 'code'; continue; }
            out[i] = ' ';
            continue;
        }
        if (c === '#') { out[i] = ' '; state = 'comment'; continue; }
        if ((c === '"' && next === '"' && third === '"') || (c === '\'' && next === '\'' && third === '\'')) {
            quote = c; state = 'triple-string'; triple = true; out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 2; continue;
        }
        if (c === '"' || c === '\'') { quote = c; state = 'string'; out[i] = ' '; }
    }
    return out.join('');
}

function collectJsImports(content) {
    const records = [];
    const codeMask = buildJsCodePositionMask(content);
    const matchStartsInCode = (match, keywordPattern = /\b(?:import|export)\b/) => {
        const keywordOffset = match[0].search(keywordPattern);
        return keywordOffset >= 0 && codeMask[match.index + keywordOffset] === 1;
    };
    // Static imports and re-exports, including multi-line `import { ... } from`.
    const fromPattern = /(?:^|(?<=[;\n]))[ \t]*(?:import|export)\b(?:(?!;|\n[ \t]*(?:import|export)\b)[\s\S])*?\bfrom\s*(['"])([^'"\r\n]+)\1/gm;
    for (const match of content.matchAll(fromPattern)) {
        if (!matchStartsInCode(match)) continue;
        const whole = match[0];
        const specifier = match[2];
        const offset = match.index + (whole.startsWith('\n') ? 1 : 0);
        const line = lineAt(content, offset);
        const isReExport = whole.trimStart().startsWith('export');
        const importBindings = [];
        const clause = whole
            .replace(/^\s*(?:import|export)\s+(?:type\s+)?/i, '')
            .replace(/\s+from\s*(['"])[^'"]+\1[\s;]*$/i, '')
            .trim();
        if (!isReExport) {
            const beforeNamed = clause.split('{')[0].split('*')[0].split(',')[0].trim();
            if (/^[A-Za-z_$][\w$]*$/.test(beforeNamed)) importBindings.push({ importedName: 'default', localName: beforeNamed });
            const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
            if (namespace) importBindings.push({ importedName: '*', localName: namespace[1] });
        } else if (isReExport && clause === '*') {
            // `export * from './module'`: the exported name is resolved
            // lazily against the target module by the call-graph resolver.
            importBindings.push({ importedName: '*', localName: '*', exportedName: '*' });
        }
        const named = clause.match(/\{([\s\S]*?)\}/);
        if (named) {
            for (const part of named[1].split(',')) {
                const value = part.trim().replace(/^type\s+/, '');
                if (!value) continue;
                const alias = value.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/i);
                const bare = value.match(/^([A-Za-z_$][\w$]*)$/);
                if (isReExport) {
                    if (alias) importBindings.push({ importedName: alias[1], localName: alias[2], exportedName: alias[2] });
                    else if (bare) importBindings.push({ importedName: bare[1], localName: bare[1], exportedName: bare[1] });
                } else {
                    if (alias) importBindings.push({ importedName: alias[1], localName: alias[2] });
                    else if (bare) importBindings.push({ importedName: bare[1], localName: bare[1] });
                }
            }
        }
        const importedNames = importBindings.map((binding) => binding.localName).filter((name) => name !== '*');
        records.push({ specifier, line, type: isReExport ? 're-export' : 'import', evidence: whole.trim().slice(0, 500), importedNames, importBindings });
    }
    // Side-effect imports (not also captured by `from`).
    const sideEffectPattern = /(?:^|(?<=[;\n]))[ \t]*import\s*(['"])([^'"\r\n]+)\1/gm;
    for (const match of content.matchAll(sideEffectPattern)) {
        if (!matchStartsInCode(match, /\bimport\b/)) continue;
        const specifier = match[2];
        const line = lineAt(content, match.index + (match[0].startsWith('\n') ? 1 : 0));
        if (!records.some((item) => item.line === line && item.specifier === specifier)) {
            records.push({ specifier, line, type: 'import', evidence: match[0].trim(), importedNames: [] });
        }
    }
    // CommonJS and statically-addressable dynamic imports.
    const requirePattern = /\brequire\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g;
    for (const match of content.matchAll(requirePattern)) {
        if (codeMask[match.index] !== 1) continue;
        const prefixStart = content.lastIndexOf('\n', match.index - 1) + 1;
        const prefix = content.slice(prefixStart, match.index);
        const bindings = [];
        const destructured = prefix.match(/\b(?:const|let|var)\s+\{([^}]+)\}\s*=\s*$/);
        if (destructured) {
            for (const part of destructured[1].split(',')) {
                const value = part.trim();
                const alias = value.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/);
                const bare = value.match(/^([A-Za-z_$][\w$]*)$/);
                if (alias) bindings.push({ importedName: alias[1], localName: alias[2] });
                else if (bare) bindings.push({ importedName: bare[1], localName: bare[1] });
            }
        }
        records.push({ specifier: match[2], line: lineAt(content, match.index), type: 'require', evidence: match[0], importedNames: bindings.map((binding) => binding.localName), importBindings: bindings });
    }
    const dynamicPattern = /\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g;
    for (const match of content.matchAll(dynamicPattern)) {
        if (codeMask[match.index] !== 1) continue;
        records.push({ specifier: match[2], line: lineAt(content, match.index), type: 'dynamic-import', evidence: match[0], importedNames: [] });
    }
    return records.sort((a, b) => a.line - b.line);
}


/**
 * Returns explicit local export aliases for call-graph resolution, e.g.
 * `export { internalName as publicName }` and named default function exports.
 * Comment/string-shaped declarations are ignored using the same lexical mask
 * as import extraction so fixture text cannot create fabricated bindings.
 */
export function extractLocalJsExportAliases(content = '') {
    const source = String(content || '');
    const mask = buildJsCodePositionMask(source);
    const aliases = Object.create(null);
    const add = (exportedName, localName) => {
        if (!exportedName || !localName || exportedName === '*' || localName === '*') return;
        if (!aliases[exportedName]) aliases[exportedName] = [];
        if (!aliases[exportedName].includes(localName)) aliases[exportedName].push(localName);
    };

    const namedExportPattern = /(?:^|\n)[ \t]*export\s*\{([\s\S]*?)\}\s*;?/g;
    for (const match of source.matchAll(namedExportPattern)) {
        const keywordOffset = match[0].search(/\bexport\b/);
        if (keywordOffset < 0 || mask[match.index + keywordOffset] !== 1) continue;
        const after = source.slice(match.index + match[0].length).match(/^\s*from\b/);
        if (after) continue; // Re-exports are represented by graph edges.
        for (const part of match[1].split(',')) {
            const value = part.trim().replace(/^type\s+/, '');
            const alias = value.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/i);
            const bare = value.match(/^([A-Za-z_$][\w$]*)$/);
            if (alias) add(alias[2], alias[1]);
            else if (bare) add(bare[1], bare[1]);
        }
    }

    const defaultDeclarationPattern = /\bexport\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g;
    for (const match of source.matchAll(defaultDeclarationPattern)) {
        const keywordOffset = match[0].search(/\bexport\b/);
        if (keywordOffset >= 0 && mask[match.index + keywordOffset] === 1) add('default', match[1]);
    }
    return aliases;
}

function collectPythonImports(content) {
    const records = [];
    const lines = content.split('\n');
    const scanLines = maskPythonNonCode(content).split('\n');
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const scanLine = scanLines[index] || '';
        const fromMatch = scanLine.match(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import\b(.*)$/);
        if (fromMatch) {
            let namesText = fromMatch[2];
            const startLine = index + 1;
            // Capture parenthesized or explicitly continued imports, not the
            // following indented function body after a normal one-line import.
            if (namesText.includes('(') && !namesText.includes(')')) {
                while (index + 1 < lines.length && !namesText.includes(')')) namesText += `\n${scanLines[++index] || ''}`;
            } else if (/\\\s*$/.test(namesText)) {
                while (index + 1 < lines.length && /\\\s*$/.test(namesText)) namesText += `\n${scanLines[++index] || ''}`;
            }
            namesText = namesText.replace(/[()]/g, '').replace(/\\\s*\n/g, ' ');
            const importBindings = namesText.split(',').map((part) => {
                const value = part.trim();
                const alias = value.match(/^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/i);
                const bare = value.match(/^([A-Za-z_]\w*)$/);
                if (alias) return { importedName: alias[1], localName: alias[2] };
                if (bare) return { importedName: bare[1], localName: bare[1] };
                return null;
            }).filter(Boolean);
            const importedNames = importBindings.map((binding) => binding.localName);
            records.push({ moduleName: fromMatch[1], line: startLine, type: 'from-import', evidence: lines.slice(startLine - 1, index + 1).join('\n').trim().slice(0, 500), importedNames, importBindings });
            continue;
        }
        const importMatch = scanLine.match(/^[ \t]*import[ \t]+([^\n#]+)/);
        if (!importMatch) continue;
        const modules = importMatch[1].split(',').map((part) => {
            const pieces = part.trim().split(/\s+as\s+/i);
            const moduleName = (pieces[0] || '').trim();
            const localName = (pieces[1] || moduleName.split('.').pop() || '').trim();
            return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(moduleName) && /^[A-Za-z_]\w*$/.test(localName)
                ? { moduleName, localName } : null;
        }).filter(Boolean);
        for (const item of modules) records.push({ moduleName: item.moduleName, line: index + 1, type: 'import', evidence: line.trim(), importedNames: [item.localName], importBindings: [{ importedName: item.moduleName, localName: item.localName }] });
    }
    return records.sort((a, b) => a.line - b.line);
}

function resolvePythonModule(moduleName, sourcePath, importedNames, filePaths) {
    const targets = [];
    let relative = moduleName.startsWith('.');
    let modulePath = moduleName;
    let baseDir = '';
    if (relative) {
        const dots = moduleName.match(/^\.+/)[0].length;
        const tail = moduleName.slice(dots);
        const sourceDir = dirname(sourcePath);
        const parts = sourceDir ? sourceDir.split('/') : [];
        for (let i = 1; i < dots; i++) {
            if (!parts.length) return { targets: [], isLocal: true };
            parts.pop();
        }
        baseDir = parts.join('/');
        modulePath = tail ? [baseDir, tail.replace(/\./g, '/')].filter(Boolean).join('/') : '';
    } else {
        modulePath = moduleName.replace(/\./g, '/');
    }
    const bases = [];
    if (modulePath) bases.push(modulePath);
    if (relative && !modulePath) {
        for (const name of importedNames) {
            bases.push([baseDir, name.replace(/\./g, '/')].filter(Boolean).join('/'));
        }
    }
    for (const base of bases) {
        for (const candidate of [`${base}.py`, `${base}/__init__.py`, `${base}.pyw`, `${base}/__init__.pyw`]) {
            if (filePaths.has(candidate)) targets.push(candidate);
        }
    }
    // Monorepos often place the Python import root below a service directory.
    // Suffix matching is a fallback and remains ambiguous when multiple roots match.
    if (!targets.length && !relative && modulePath) {
        for (const filePath of filePaths) {
            if (filePath.endsWith(`/${modulePath}.py`) || filePath.endsWith(`/${modulePath}/__init__.py`)) targets.push(filePath);
        }
    }
    const unique = [...new Set(targets)].filter((target) => target !== sourcePath);
    return { targets: unique, isLocal: relative || unique.length > 0, ambiguous: unique.length > 1 };
}

function maskCommentsAndStrings(content) {
    // Preserve offsets/newlines while blanking Java-family comments, ordinary
    // strings and Java text blocks before package/import heuristics.
    let out = '';
    let state = 'code';
    let quote = '';
    let textBlock = false;
    for (let i = 0; i < content.length; i++) {
        const c = content[i];
        const next = content[i + 1];
        const third = content[i + 2];
        if (state === 'line-comment') {
            if (c === '\n') { state = 'code'; out += '\n'; } else out += ' ';
            continue;
        }
        if (state === 'block-comment') {
            if (c === '*' && next === '/') { out += '  '; i++; state = 'code'; }
            else out += c === '\n' ? '\n' : ' ';
            continue;
        }
        if (state === 'string') {
            if (textBlock && c === '"' && next === '"' && third === '"') {
                out += '   '; i += 2; state = 'code'; textBlock = false; continue;
            }
            if (!textBlock && c === '\\') {
                out += ' ';
                if (i + 1 < content.length) { out += content[i + 1] === '\n' ? '\n' : ' '; i++; }
                continue;
            }
            if (!textBlock && c === quote) { state = 'code'; out += ' '; }
            else out += c === '\n' ? '\n' : ' ';
            continue;
        }
        if (c === '/' && next === '/') { out += '  '; i++; state = 'line-comment'; continue; }
        if (c === '/' && next === '*') { out += '  '; i++; state = 'block-comment'; continue; }
        if (c === '"' && next === '"' && third === '"') { state = 'string'; quote = '"'; textBlock = true; out += '   '; i += 2; continue; }
        if (c === '"' || c === "'") { state = 'string'; quote = c; textBlock = false; out += ' '; continue; }
        out += c;
    }
    return out;
}

/** Builds source-line-backed file dependencies plus explicit resolution diagnostics. */
export function extractFileDependencies(files = [], classes = [], diagnostics = null, options = {}) {
    // When supplied, only emit references whose source belongs to this subset.
    // The complete repository must still be supplied for target resolution,
    // package manifests, path mappings, and same-package type discovery.
    const sourcePaths = options.sourcePaths == null ? null : new Set(options.sourcePaths);

    const edges = [];
    const unresolvedLocalImports = [];
    const unresolvedPackageMembers = [];
    const ambiguousImports = [];
    const filePaths = new Set(files.map((file) => normalizeRepoPath(file.path)).filter(Boolean));
    const pathMappings = getTsPathMappings(files);
    const manifests = packageManifestRecords(files);
    const importedByFile = new Map();
    const classMap = new Map();
    const packageMap = new Map();

    const addResolvedEdges = ({ source, targets, type, line, evidence, specifier, isLocal = false, ambiguous = false, importBindings = [], resolvedBy = null, resolutionOverride = null }) => {
        const uniqueTargets = [...new Set(targets)].filter((target) => target !== source);
        if (uniqueTargets.length) {
            const resolution = resolutionOverride || (ambiguous || uniqueTargets.length > 1 ? 'ambiguous' : 'resolved');
            if (resolution === 'ambiguous') ambiguousImports.push({ path: source, line, specifier, targets: uniqueTargets });
            for (const target of uniqueTargets) edges.push(makeEvidenceEdge({ source, target, type, line, resolution, evidence, importBindings, resolvedBy }));
        } else if (isLocal) {
            unresolvedLocalImports.push({ path: source, line, specifier });
        }
    };

    for (const file of files) {
        const path = normalizeRepoPath(file.path);
        if (!path || typeof file.content !== 'string' || (sourcePaths && !sourcePaths.has(path))) continue;
        const ext = path.split('.').pop().toLowerCase();
        const imported = new Set();
        if (['js', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'mjs', 'cjs', 'vue', 'svelte'].includes(ext)) {
            for (const record of cacheImportRecords('js', path, file.content, collectJsImports)) {
                record.importedNames.forEach((name) => imported.add(name));
                const result = resolveJsSpecifier(record.specifier, path, filePaths, pathMappings, manifests);
                addResolvedEdges({ source: path, targets: result.targets, type: record.type, line: record.line, evidence: record.evidence, specifier: record.specifier, isLocal: result.isLocal, ambiguous: result.ambiguous, importBindings: record.importBindings || [], resolvedBy: result.resolvedBy });
            }
        } else if (['py', 'pyw', 'pyi'].includes(ext)) {
            for (const record of cacheImportRecords('python', path, file.content, collectPythonImports)) {
                record.importedNames.forEach((name) => imported.add(name));
                // `from . import db, embedding` is a set of package-member imports,
                // not one import of the entire package. Resolve each name independently
                // when it maps to a sibling module; otherwise report an unresolved
                // package member because it may be re-exported from __init__.py.
                if (record.type === 'from-import' && /^\.+$/.test(record.moduleName)) {
                    for (const binding of record.importBindings || []) {
                        const siblingSpecifier = `${record.moduleName}${binding.importedName}`;
                        const result = resolvePythonModule(siblingSpecifier, path, [binding.importedName], filePaths);
                        if (result.targets.length) {
                            addResolvedEdges({
                                source: path,
                                targets: result.targets,
                                type: 'from-import-module',
                                line: record.line,
                                evidence: record.evidence,
                                specifier: siblingSpecifier,
                                isLocal: true,
                                ambiguous: result.ambiguous,
                                importBindings: [binding],
                                resolvedBy: 'python-relative-package-member',
                            });
                        } else {
                            unresolvedPackageMembers.push({
                                path,
                                line: record.line,
                                specifier: record.moduleName,
                                importedName: binding.importedName,
                                localName: binding.localName,
                                semantics: 'May be a sibling module or a package attribute exported from __init__.py; target not proven.',
                            });
                        }
                    }
                    continue;
                }
                const result = resolvePythonModule(record.moduleName, path, record.importedNames, filePaths);
                addResolvedEdges({ source: path, targets: result.targets, type: record.type, line: record.line, evidence: record.evidence, specifier: record.moduleName, isLocal: result.isLocal, ambiguous: result.ambiguous, importBindings: record.importBindings || [] });
            }
        } else if (['java', 'kt', 'kts', 'cs', 'scala', 'groovy'].includes(ext)) {
            const javaImportRegex = /^[ \t]*import\s+(static\s+)?([\w.$*]+)\s*;/gm;
            const javaScan = maskCommentsAndStrings(file.content);
            for (const match of javaScan.matchAll(javaImportRegex)) {
                let qualified = match[2];
                const isStatic = Boolean(match[1]);
                if (isStatic) qualified = qualified.split('.').slice(0, -1).join('.');
                const wildcard = qualified.endsWith('.*');
                const packageName = wildcard ? qualified.slice(0, -2) : qualified.split('.').slice(0, -1).join('.');
                const importedName = wildcard ? null : qualified.split('.').pop();
                if (importedName) imported.add(importedName);
                const line = lineAt(javaScan, match.index);
                const evidence = (file.content.split('\n')[line - 1] || match[0]).trim().slice(0, 500);
                let targets = [];
                if (wildcard) {
                    targets = classes.filter((item) => item.package === packageName).map((item) => normalizeRepoPath(item.file));
                } else {
                    targets = classes.filter((item) => item.name === importedName && `${item.package ? `${item.package}.` : ''}${item.name}` === qualified).map((item) => normalizeRepoPath(item.file));
                }
                addResolvedEdges({
                    source: path, targets, type: wildcard ? 'wildcard-import' : 'import', line, evidence,
                    specifier: qualified, isLocal: false,
                    resolutionOverride: wildcard && targets.length ? 'inferred' : null,
                    resolvedBy: wildcard ? 'java-package-wildcard-candidates' : 'java-qualified-import',
                });
            }
        }
        importedByFile.set(path, imported);
    }

    for (const item of classes) {
        const file = normalizeRepoPath(item.file);
        if (!file) continue;
        if (!classMap.has(file)) classMap.set(file, []);
        classMap.get(file).push(item);
        if (item.package) {
            if (!packageMap.has(item.package)) packageMap.set(item.package, []);
            packageMap.get(item.package).push({ file, className: item.name });
        }
    }

    for (const file of files) {
        const path = normalizeRepoPath(file.path);
        if (sourcePaths && !sourcePaths.has(path)) continue;
        const fileClasses = classMap.get(path) || [];
        const pkg = fileClasses[0]?.package;
        if (!pkg || typeof file.content !== 'string') continue;
        const imported = importedByFile.get(path) || new Set();
        const masked = maskCommentsAndStrings(file.content);
        for (const { file: targetPath, className } of packageMap.get(pkg) || []) {
            if (targetPath === path || imported.has(className)) continue;
            const identifier = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const usage = new RegExp(`\\b${identifier}\\b`).exec(masked);
            if (!usage) continue;
            const line = lineAt(masked, usage.index);
            const ambiguous = (packageMap.get(pkg) || []).filter((item) => item.className === className).length > 1;
            edges.push(makeEvidenceEdge({ source: path, target: targetPath, type: 'same-package', resolution: ambiguous ? 'ambiguous' : 'inferred', line, evidence: usage[0] }));
        }
    }

    // Identical source/target/relation/line entries can arise from multiple
    // parsing passes. Remove exact duplicates without hiding distinct references.
    const uniqueEdges = [];
    const seen = new Set();
    for (const edge of edges) {
        const key = [edge.source, edge.target, edge.type, edge.line ?? '', edge.evidence ?? ''].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueEdges.push(edge);
    }
    if (diagnostics) {
        diagnostics.unresolvedLocalImports = unresolvedLocalImports;
        diagnostics.unresolvedPackageMembers = unresolvedPackageMembers;
        diagnostics.ambiguousImports = ambiguousImports;
        diagnostics.pathMappings = pathMappings.map(({ pattern, configPath }) => ({ pattern, configPath }));
    }
    return uniqueEdges;
}
