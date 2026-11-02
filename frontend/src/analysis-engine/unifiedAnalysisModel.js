import { classifyAnalysisSource } from './sourceClassification.js';
/**
 * Unified analysis model (V5).
 *
 * This is a normalized, serializable view over facts produced by existing analysis
 * passes. It does not upgrade heuristic facts into compiler-confirmed facts.
 */
const asArray = (value) => Array.isArray(value) ? value : [];
const text = (value) => value == null ? '' : String(value);
const normPath = (value) => text(value).replace(/\\/g, '/').replace(/^\.\//, '');

export function stableAnalysisHash(value) {
    let hash = 0x811c9dc5;
    const source = text(value);
    for (let i = 0; i < source.length; i++) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compute a stable per-snapshot identifier without buffering the entire repository
 * in one large string. Uses SHA-256 per file when Web Crypto is available and a
 * non-cryptographic fallback otherwise.
 */
export async function createAnalysisSnapshot(files = [], options = {}) {
    const ordered = asArray(files).map((file) => ({ path: normPath(file.path), content: text(file.content) })).sort((a, b) => a.path.localeCompare(b.path));
    const hasCrypto = Boolean(globalThis.crypto?.subtle && typeof TextEncoder !== 'undefined');
    const records = [];
    let totalBytes = 0;
    for (const file of ordered) {
        let contentDigest;
        let byteLength = file.content.length;
        if (hasCrypto) {
            const bytes = new TextEncoder().encode(file.content);
            byteLength = bytes.byteLength;
            const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
            contentDigest = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        } else {
            contentDigest = stableAnalysisHash(file.content);
        }
        totalBytes += byteLength;
        records.push({ path: file.path, bytes: byteLength, contentDigest });
    }
    const manifest = JSON.stringify({ schemaVersion: 1, engineVersion: options.engineVersion || '5.0.0', parserMode: options.parserMode || 'configured-runtime', files: records });
    let snapshotId;
    let algorithm;
    if (hasCrypto) {
        const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(manifest)));
        snapshotId = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        algorithm = 'SHA-256';
    } else {
        snapshotId = stableAnalysisHash(manifest);
        algorithm = 'FNV-1a-32-fallback';
    }
    return { schemaVersion: 1, id: snapshotId, algorithm, engineVersion: options.engineVersion || '5.0.0', parserMode: options.parserMode || 'configured-runtime', fileCount: ordered.length, totalBytes, semantics: 'Deterministic identity for this normalized file snapshot and declared analyzer mode; not a proof of result correctness.' };
}

export function stableFindingKey(finding = {}) {
    const loc = finding.location || {};
    const path = normPath(loc.path || finding.file || finding.path || '');
    const line = loc.startLine ?? finding.startLine ?? finding.line ?? '';
    const rule = finding.ruleId || finding.rule || finding.type || finding.title || finding.name || 'finding';
    const subject = finding.symbolId || finding.symbol || finding.functionKey || '';
    return `finding:${stableAnalysisHash([rule, path, line, subject].join('|'))}`;
}

function relationKey(edge) {
    return [edge.type || edge.relation || 'related', edge.source || edge.from, edge.target || edge.to, edge.line ?? '', edge.resolution || ''].join('|');
}

/** Convert analysis results to a compact entities-and-edges representation. */
export function buildUnifiedAnalysisModel(input = {}) {
    const result = input.result || input;
    const files = asArray(result.files);
    const functions = asArray(result.functions);
    const classes = asArray(result.classes);
    const dependencies = asArray(result.dependencies);
    const callEdges = asArray(result.callGraph?.functionConnections);
    const endpoints = asArray(result.apiEndpoints);
    const findings = asArray(result.findings);
    const entities = [];
    const edges = [];
    const ids = new Map();
    const symbolsByKey = new Map();
    const symbolsByPathName = new Map();
    const fileId = (path) => `file:${stableAnalysisHash(normPath(path))}`;
    const addEntity = (entity) => {
        if (!entity?.id || ids.has(entity.id)) return entity?.id;
        const clean = { ...entity };
        ids.set(clean.id, clean);
        entities.push(clean);
        return clean.id;
    };
    const addEdge = (source, target, type, details = {}) => {
        if (!source || !target) return;
        const edge = { source, target, type, ...details };
        edge.id = `edge:${stableAnalysisHash(relationKey(edge))}`;
        if (!edgeKeys.has(edge.id)) { edgeKeys.add(edge.id); edges.push(edge); }
    };
    const edgeKeys = new Set();

    for (const file of files) {
        const path = normPath(file.path);
        addEntity({ id: fileId(path), kind: 'file', name: path.split('/').pop(), path, sourceRole:classifyAnalysisSource(path), language: file.language || 'unknown', layer: file.layer || 'unknown', loc: Number(file.loc) || null, complexity: file.complexity || null });
    }
    for (const fn of functions) {
        const path = normPath(fn.file);
        const line = Number(fn.line) || 0;
        const name = text(fn.name || '<anonymous>');
        const id = `symbol:${stableAnalysisHash(`${path}|${line}|${name}|${fn.endLine ?? line}`)}`;
        const entity = { id, kind: 'function', name, path, sourceRole:classifyAnalysisSource(path), startLine: line || null, endLine: Number(fn.endLine) || line || null, exported: !!fn.isExported, topLevel: !!fn.isTopLevel, functionType: fn.type || 'unknown' };
        addEntity(entity);
        const key = `${path}|${line}|${name}`;
        symbolsByKey.set(key, id);
        symbolsByKey.set(text(fn.key), id);
        const pathNameKey = `${path}|${name}`;
        if (!symbolsByPathName.has(pathNameKey)) symbolsByPathName.set(pathNameKey, []);
        symbolsByPathName.get(pathNameKey).push(id);
        addEdge(fileId(path), id, 'contains', { resolution: 'resolved', confidence: 'high', evidenceKind: 'symbol-source-range', line: line || null });
    }
    for (const klass of classes) {
        const path = normPath(klass.file);
        const id = `class:${stableAnalysisHash(`${path}|${klass.line || 0}|${klass.name}`)}`;
        addEntity({ id, kind: 'class', name: text(klass.name), path, sourceRole:classifyAnalysisSource(path), startLine: Number(klass.line) || null, package: klass.package || null, annotations: asArray(klass.annotations) });
        addEdge(fileId(path), id, 'contains', { resolution: 'inferred', confidence: 'medium', evidenceKind: 'class-extraction', line: klass.line || null });
    }
    for (const dependency of dependencies) {
        const source = fileId(dependency.source);
        const targetPath = normPath(dependency.target);
        // External/unresolved references remain visible as external-reference entities.
        const targetExists = files.some((file) => normPath(file.path) === targetPath);
        const target = targetExists ? fileId(targetPath) : `external:${stableAnalysisHash(targetPath || dependency.specifier || dependency.target)}`;
        if (!targetExists) addEntity({ id: target, kind: 'external-reference', name: text(dependency.specifier || dependency.target || 'unresolved'), path: null, resolution: dependency.resolution || 'unknown' });
        addEdge(source, target, dependency.type || 'depends-on', { resolution: dependency.resolution || 'unknown', confidence: dependency.confidence || 'unknown', line: dependency.line ?? null, evidence: dependency.evidence || null, resolvedBy: dependency.resolvedBy || null });
    }
    const resolveFunction = (key, path, line, name) => {
        if (key && symbolsByKey.has(text(key))) return symbolsByKey.get(text(key));
        const exact = symbolsByKey.get(`${normPath(path)}|${Number(line) || 0}|${text(name)}`);
        if (exact) return exact;
        const candidates = symbolsByPathName.get(`${normPath(path)}|${text(name)}`) || [];
        return candidates.length === 1 ? candidates[0] : null;
    };
    for (const edge of callEdges) {
        const source = resolveFunction(edge.callerFunctionKey, edge.callerFile, edge.callerStartLine, edge.callerFunctionName);
        const target = resolveFunction(edge.calleeFunctionKey, edge.calleeFile, edge.calleeStartLine, edge.calleeFunctionName);
        const sourceFile = fileId(edge.callerFile);
        const targetFile = fileId(edge.calleeFile);
        addEdge(source || sourceFile, target || targetFile, 'calls', {
            resolution: source && target ? (edge.resolution || 'unknown') : 'inferred', confidence: source && target ? (edge.confidence || 'unknown') : 'low',
            line: edge.callSiteLine ?? null, callSiteExcerpt: edge.callSiteExcerpt || null,
            resolvedBy: edge.resolvedBy || null, attribution: edge.attribution || null,
            symbolResolution: source && target ? 'mapped' : 'file-level-fallback',
            evidenceKind: source && target ? 'caller-callee-symbol-link' : 'partial-symbol-mapping',
        });
    }
    for (const endpoint of endpoints) {
        const path = normPath(endpoint.file);
        const id = `endpoint:${stableAnalysisHash(`${path}|${endpoint.line || 0}|${endpoint.method}|${endpoint.path}`)}`;
        addEntity({ id, kind: 'endpoint', name: `${text(endpoint.method).toUpperCase()} ${text(endpoint.path)}`, path, sourceRole:classifyAnalysisSource(path), method: text(endpoint.method).toUpperCase(), route: text(endpoint.path), startLine: endpoint.line || null, framework: endpoint.framework || null, authProtectedHeuristic: endpoint.authProtected ?? null, confidence: endpoint.confidence || 'unknown' });
        addEdge(fileId(path), id, 'declares-endpoint', { resolution: endpoint.confidence === 'FACT' ? 'resolved' : 'inferred', confidence: endpoint.confidence || 'unknown', line: endpoint.line || null });
    }
    for (const table of asArray(result.databaseSchema?.tables)) {
        const path = normPath(table.file);
        const id = `table:${stableAnalysisHash(`${path}|${table.name}`)}`;
        addEntity({ id, kind: 'database-table', name: text(table.name), path: path || null, columns: asArray(table.columns).map((col) => ({ name: col.name, type: col.type || 'unknown' })), foreignKeys: asArray(table.foreignKeys).length, source: table.source || 'unknown' });
        if (path && files.some((file) => normPath(file.path) === path)) addEdge(fileId(path), id, 'declares-database-table', { resolution: table.source === 'sql' ? 'resolved' : 'inferred', confidence: table.source === 'sql' ? 'high' : 'medium' });
    }
    for (const link of asArray(result.testLinkage?.links)) {
        const source = fileId(link.testFile);
        const target = fileId(link.sourceFile);
        addEdge(source, target, 'test-links-source', { resolution: link.confidence === 'high' ? 'resolved' : 'inferred', confidence: link.confidence || 'unknown', relationship: link.relationship || null, evidence: link.evidence || null });
    }
    for (const finding of findings) {
        const path = normPath(finding.location?.path || finding.path || finding.file);
        const id = `finding:${stableFindingKey(finding).split(':').pop()}`;
        addEntity({ id, kind: 'finding', name: text(finding.title || finding.ruleId || finding.name || 'Finding'), path: path || null, startLine: finding.location?.startLine ?? finding.line ?? null, ruleId: finding.ruleId || null, severity: finding.severity || 'info', confidence: finding.confidence || 'unknown', status: finding.status || 'detected' });
        if (path && files.some((file) => normPath(file.path) === path)) addEdge(id, fileId(path), 'finding-affects-file', { resolution: 'inferred', confidence: finding.confidence || 'unknown', line: finding.location?.startLine ?? finding.line ?? null });
    }

    const validIds = new Set(entities.map((item) => item.id));
    const duplicateEntityIds = entities.length - validIds.size;
    const danglingEdges = edges.filter((edge) => !validIds.has(edge.source) || !validIds.has(edge.target)).map((edge) => edge.id);
    const kinds = {};
    for (const entity of entities) kinds[entity.kind] = (kinds[entity.kind] || 0) + 1;
    const relationCounts = {};
    for (const edge of edges) relationCounts[edge.type] = (relationCounts[edge.type] || 0) + 1;
    return {
        schemaVersion: 1,
        status: danglingEdges.length ? 'partial' : 'complete',
        semantics: 'Normalized repository facts from existing analysis passes. Heuristic or inferred relationships preserve their provenance and are not upgraded to compiler-confirmed facts.',
        entities, edges,
        summary: { entityCount: entities.length, edgeCount: edges.length, entityKinds: kinds, relationKinds: relationCounts },
        diagnostics: {
            duplicateEntityIds, danglingEdgeCount: danglingEdges.length, danglingEdgeIds: danglingEdges.slice(0, 100),
            // `inferred` is an intentionally source-backed candidate, not an unresolved error.
            inferredRelationCount: edges.filter(edge => edge.resolution === 'inferred').length,
            unresolvedRelationCount: edges.filter(edge => ['unresolved', 'unknown', 'ambiguous'].includes(edge.resolution)).length,
            externalReferenceCount: entities.filter(entity => entity.kind === 'external-reference').length,
            evidenceLocatedEdges: edges.filter(edge => Number.isInteger(edge.line) && edge.line > 0).length,
            semantics: 'Inferred relationships are distinguished from genuinely unresolved/ambiguous graph edges. Missing line numbers may be valid for schema or test-link relationships.',
        },
    };
}

/** Query the unified model without requiring callers to know source-specific payload shapes. */
export function queryAnalysisModel(model, query = {}) {
    const kind = query.kind || 'entities';
    const limit = Math.max(1, Math.min(Number(query.limit) || 200, 5000));
    const contains = (actual, wanted) => wanted == null || text(actual).toLowerCase().includes(text(wanted).toLowerCase());
    if (kind === 'edges' || kind === 'relations') {
        return asArray(model?.edges).filter((edge) =>
            contains(edge.type, query.relation || query.type) &&
            contains(edge.source, query.source) && contains(edge.target, query.target) &&
            contains(edge.resolution, query.resolution)
        ).slice(0, limit);
    }
    return asArray(model?.entities).filter((entity) =>
        contains(entity.kind, query.entityKind || query.entityType) &&
        contains(entity.id, query.id) && contains(entity.name, query.name) &&
        contains(entity.path, query.path) && contains(entity.severity, query.severity) &&
        contains(entity.ruleId, query.ruleId)
    ).slice(0, limit);
}

/** Build a bounded forward, reverse, or bidirectional program/repository slice. */
export function sliceAnalysisModel(model, { seedId, path, direction = 'both', maxDepth = 4, maxNodes = 200, relationTypes = null } = {}) {
    const entities = asArray(model?.entities);
    const edges = asArray(model?.edges);
    const seeds = entities.filter((entity) => (seedId && entity.id === seedId) || (path && normPath(entity.path) === normPath(path))).map((entity) => entity.id);
    if (!seeds.length) return { schemaVersion: 1, status: 'not-found', seedIds: [], entityIds: [], entities: [], edges: [], truncated: false, reason: 'No entity matched the requested seed.' };
    const allowed = relationTypes ? new Set(relationTypes) : null;
    const selected = new Set(seeds);
    let frontier = [...seeds];
    const maxD = Math.max(0, Math.min(Number(maxDepth) || 0, 20));
    const maxN = Math.max(seeds.length, Math.min(Number(maxNodes) || 200, 2000));
    let truncated = false;
    for (let depth = 0; depth < maxD && frontier.length; depth++) {
        const next = [];
        for (const edge of edges) {
            if (allowed && !allowed.has(edge.type)) continue;
            const candidates = [];
            if (direction !== 'reverse' && frontier.includes(edge.source)) candidates.push(edge.target);
            if (direction !== 'forward' && frontier.includes(edge.target)) candidates.push(edge.source);
            for (const id of candidates) {
                if (selected.has(id)) continue;
                if (selected.size >= maxN) { truncated = true; break; }
                selected.add(id); next.push(id);
            }
            if (truncated) break;
        }
        frontier = next;
        if (truncated) break;
    }
    const selectedEntities = entities.filter((entity) => selected.has(entity.id));
    const selectedEdges = edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target) && (!allowed || allowed.has(edge.type)));
    return { schemaVersion: 1, status: truncated ? 'partial' : 'complete', seedIds: seeds, entityIds: [...selected], entities: selectedEntities, edges: selectedEdges, depthLimit: maxD, nodeLimit: maxN, truncated, semantics: 'Graph slice over available modeled relations only; unresolved or unmodeled behavior may be absent.' };
}

/** Compare two completed analysis payloads and assign finding lifecycle states. */
export function compareAnalysisResults(previous, current) {
    const previousFindings = asArray(previous?.findings);
    const currentFindings = asArray(current?.findings);
    const previousMap = new Map(previousFindings.map((finding) => [stableFindingKey(finding), finding]));
    const currentMap = new Map(currentFindings.map((finding) => [stableFindingKey(finding), finding]));
    const findings = [];
    for (const [key, finding] of currentMap) findings.push({ key, lifecycle: previousMap.has(key) ? 'persisting' : 'new', finding });
    for (const [key, finding] of previousMap) if (!currentMap.has(key)) findings.push({ key, lifecycle: 'resolved-or-not-reproduced', finding });
    const getEdgeKeys = (result) => {
        const deps = asArray(result?.dependencies).map((edge) => `dep|${edge.source}|${edge.target}|${edge.type || ''}|${edge.resolution || ''}`);
        const calls = asArray(result?.callGraph?.functionConnections).map((edge) => `call|${edge.callerFunctionKey || `${edge.callerFile}|${edge.callerStartLine}|${edge.callerFunctionName}`}|${edge.calleeFunctionKey || `${edge.calleeFile}|${edge.calleeStartLine}|${edge.calleeFunctionName}`}`);
        return new Set([...deps, ...calls]);
    };
    const prevEdges = getEdgeKeys(previous); const nextEdges = getEdgeKeys(current);
    const routeKey = (endpoint) => `${text(endpoint.method).toUpperCase()} ${text(endpoint.path)}|${normPath(endpoint.file)}|${endpoint.line ?? ''}`;
    const previousRoutes = new Set(asArray(previous?.apiEndpoints).map(routeKey));
    const currentRoutes = new Set(asArray(current?.apiEndpoints).map(routeKey));
    const previousTables = new Set(asArray(previous?.databaseSchema?.tables).map((table) => `${normPath(table.file)}|${text(table.name).toLowerCase()}`));
    const currentTables = new Set(asArray(current?.databaseSchema?.tables).map((table) => `${normPath(table.file)}|${text(table.name).toLowerCase()}`));
    return {
        schemaVersion: 1,
        semantics: 'Finding absence in the current run means resolved-or-not-reproduced, not proof that the underlying issue is fixed. Route/table differences reflect only structures represented in both snapshots.',
        findings: findings.sort((a, b) => a.lifecycle.localeCompare(b.lifecycle) || a.key.localeCompare(b.key)),
        summary: {
            newFindings: findings.filter((item) => item.lifecycle === 'new').length,
            persistingFindings: findings.filter((item) => item.lifecycle === 'persisting').length,
            resolvedOrNotReproduced: findings.filter((item) => item.lifecycle === 'resolved-or-not-reproduced').length,
            addedEdges: [...nextEdges].filter((key) => !prevEdges.has(key)),
            removedEdges: [...prevEdges].filter((key) => !nextEdges.has(key)),
            addedRoutes: [...currentRoutes].filter((key) => !previousRoutes.has(key)),
            removedRoutes: [...previousRoutes].filter((key) => !currentRoutes.has(key)),
            addedTables: [...currentTables].filter((key) => !previousTables.has(key)),
            removedTables: [...previousTables].filter((key) => !currentTables.has(key)),
        },
    };
}
