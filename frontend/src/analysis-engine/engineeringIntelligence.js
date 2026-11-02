/** Evidence-aware graph reasoning over existing v8 analysis facts.
 * Traversal shows candidate connectivity, never asserts runtime execution.
 */
const cap = (n, fallback, ceiling) => Math.min(ceiling, Math.max(1, Number.isFinite(Number(n)) ? Math.floor(Number(n)) : fallback));
const normalize = value => String(value ?? '').replace(/\\/g, '/').toLowerCase();
const evidence = (edge, nodes) => ({ sourcePath: edge.sourcePath || nodes.get(edge.source)?.path || null, line: Number.isInteger(Number(edge.line)) && Number(edge.line) > 0 ? Number(edge.line) : null, relation: edge.type, confidence: edge.confidence || 'unknown', resolution: edge.resolution || 'unknown', observed: edge.resolution === 'observed', inferred: edge.resolution !== 'observed' && edge.resolution !== 'resolved' });
function prepare(model) {
    const nodes = new Map((model?.entities || []).filter(x => x?.id).map(x => [x.id, x]));
    const outgoing = new Map(), incoming = new Map();
    for (const edge of model?.edges || []) {
        if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
        if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
        if (!incoming.has(edge.target)) incoming.set(edge.target, []);
        outgoing.get(edge.source).push(edge);
        incoming.get(edge.target).push(edge);
    }
    for (const adjacency of [outgoing, incoming]) for (const list of adjacency.values()) list.sort((a,b) => String(a.type + a.target + a.source).localeCompare(String(b.type + b.target + b.source)));
    return { nodes, outgoing, incoming };
}
export function locateIntelligenceEntities(model, query, { limit = 15 } = {}) {
    const term = normalize(query).trim();
    if (!term) return [];
    return (model?.entities || []).filter(node => node.id === query || normalize(node.path) === term || normalize(node.name) === term || normalize(node.name).includes(term)).slice(0, cap(limit,15,100));
}
// Do not treat file containment or generic imports as execution. Candidate
// flow edges are only navigated when their source relationship is specific.
const FLOW_RELATIONS = new Set(['calls', 'handler-function-candidate', 'handler-file-candidate', 'http-request-candidate', 'publishes-candidate', 'delivers-to-candidate', 'queries-table-candidate']);
const isFlowEdge = edge => FLOW_RELATIONS.has(edge.type) &&
    edge.resolution !== 'unresolved' && edge.resolution !== 'ambiguous' &&
    (edge.type !== 'calls' || (edge.resolution === 'resolved' && edge.symbolResolution !== 'file-level-fallback'));
/** Follow directed graph edges, with cycle protection and strict work limits. */
export function traceEngineeringFlows(model, startId, opts = {}) {
    const depthLimit = cap(opts.maxDepth, 6, 12), pathLimit = cap(opts.maxPaths, 30, 200), visitLimit = cap(opts.maxVisits, 12000, 50000);
    const { nodes, outgoing } = prepare(model);
    if (!nodes.has(startId)) return { status: 'not-found', paths: [], truncated: false, semantics: 'No matching graph entity.' };
    const queue = [{ id: startId, ids: [startId], edges: [] }], paths = [];
    let cursor = 0, truncated = false;
    while (cursor < queue.length && cursor < visitLimit && paths.length < pathLimit) {
        const state = queue[cursor++];
        const next = (outgoing.get(state.id) || []).filter(e => isFlowEdge(e) && !state.ids.includes(e.target));
        if (!next.length || state.edges.length >= depthLimit) {
            if (state.edges.length) paths.push({ entities: state.ids.map(id => nodes.get(id)), steps: state.edges.map(edge => ({ from: edge.source, to: edge.target, ...evidence(edge,nodes) })), confidence: state.edges.some(e => e.resolution === 'inferred' || String(e.type).includes('candidate')) ? 'candidate' : 'static', runtimeVerified: state.edges.every(e => e.resolution === 'observed') });
            if (next.length) truncated = true;
            continue;
        }
        for (const edge of next) {
            if (queue.length >= visitLimit) { truncated = true; break; }
            queue.push({ id: edge.target, ids: [...state.ids, edge.target], edges: [...state.edges, edge] });
        }
    }
    if (cursor < queue.length) truncated = true;
    return { schemaVersion: 1, status: truncated ? 'partial' : 'complete', startId, paths, visitedStates: cursor, truncated, semantics: 'Static graph paths are candidates; no runtime behavior is proved without observed traces.' };
}
/** Reverse traversal finds likely affected callers/owners and associated rules. */
export function computeEngineeringImpact(model, changedIds = [], opts = {}) {
    const maxDepth = cap(opts.maxDepth, 5, 12), maxNodes = cap(opts.maxNodes, 1000, 10000);
    const { nodes, incoming, outgoing } = prepare(model);
    const roots = [...new Set(changedIds)].filter(id => nodes.has(id));
    const seen = new Set(roots), queue = roots.map(id => ({id, depth:0}));
    const relationships = [];
    let cursor = 0, truncated = false;
    while (cursor < queue.length) {
        const { id, depth } = queue[cursor++];
        if (depth >= maxDepth) continue;
        const reverses = (incoming.get(id) || []).filter(edge => edge.resolution !== 'unresolved' && edge.resolution !== 'ambiguous' && (edge.type !== 'calls' || (edge.resolution === 'resolved' && edge.symbolResolution !== 'file-level-fallback')));
        for (const edge of reverses) {
            if (seen.has(edge.source)) continue;
            if (seen.size >= maxNodes) { truncated = true; break; }
            seen.add(edge.source);
            queue.push({ id: edge.source, depth: depth+1 });
            relationships.push({ affectedId: edge.source, via: id, depth: depth+1, ...evidence(edge,nodes) });
        }
        if (truncated) break;
    }
    const relatedRules = [];
    for (const id of seen) for (const edge of outgoing.get(id) || []) {
        if (nodes.get(edge.target)?.kind === 'business-rule-candidate') relatedRules.push({ rule: nodes.get(edge.target), evidence: evidence(edge,nodes) });
    }
    return { schemaVersion:1, roots, affectedEntities: [...seen].filter(id => !roots.includes(id)).map(id => nodes.get(id)), relationships, relatedRules, truncated, status: truncated ? 'partial':'complete', semantics: 'Potential impact based on reverse static graph connectivity; not proof of actual breakage.' };
}
/** Build bounded, source-linked structured retrieval context; no source text is invented. */
export function buildEngineeringQuestionContext(model, question, opts = {}) {
    const maxSeeds = cap(opts.maxSeeds, 5, 15), maxEdges = cap(opts.maxEdges, 40, 150);
    const tokens = [...new Set(normalize(question).match(/[a-z_][a-z_0-9.]{2,}/g) || [])].filter(w => !['what','which','does','from','with','that','this','where','when','how','the','and','are'].includes(w));
    const ranked = (model?.entities || []).map(entity => {
        const label = normalize([entity.name,entity.path].filter(Boolean).join(' '));
        return { entity, score: tokens.reduce((n,t) => n + (label.includes(t) ? (normalize(entity.name) === t ? 5 : 1) : 0), 0) };
    }).filter(item => item.score > 0).sort((a,b) => b.score-a.score || String(a.entity.id).localeCompare(String(b.entity.id))).slice(0,maxSeeds);
    const { outgoing,incoming,nodes } = prepare(model);
    const selected = [], used = new Set();
    for (const {entity} of ranked) {
        for (const edge of [...(outgoing.get(entity.id)||[]),...(incoming.get(entity.id)||[])]) {
            if (selected.length >= maxEdges) break;
            if (used.has(edge.id)) continue;
            used.add(edge.id);
            selected.push({ from: nodes.get(edge.source), to: nodes.get(edge.target), evidence: evidence(edge,nodes) });
        }
    }
    return { schemaVersion:1, question, matchedEntities:ranked.map(x => x.entity), relationships:selected, limitations: ['Graph relationships may be inferred.', 'No unobserved runtime behavior is confirmed.', 'Source paths and line numbers require validation against the analyzed snapshot.'], semantics: 'Structured retrieval context, not an AI-generated answer.' };
}
