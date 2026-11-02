/** Extend the existing canonical model without changing legacy entity IDs.
 * Newly created cross-system edges remain explicitly INFERRED static evidence.
 */
import { stableAnalysisHash } from './unifiedAnalysisModel.js';
export function enrichSystemKnowledgeGraph(model, { crossSystemIntelligence = {}, executionIntelligence = {}, businessIntelligence = {} } = {}) {
    const entities = [...(model?.entities || [])], edges = [...(model?.edges || [])];
    const byId = new Set(entities.map(e => e.id));
    const paths = new Map(entities.filter(e => e.kind === 'file').map(e => [e.path, e.id]));
    const functions = new Map();
    for (const e of entities.filter(e => e.kind === 'function')) {
        const key = `${e.path}|${e.startLine}`;
        if (!functions.has(key)) functions.set(key, []);
        functions.get(key).push(e);
    }
    const edgeKeys = new Set(edges.map(e => `${e.source}|${e.target}|${e.type}|${e.line ?? ''}`));
    const counters = { suppressedAmbiguousLinks:0, addedSourceEdges:0 };
    let bounded = false;
    const addNode = e => { if (!byId.has(e.id)) { byId.add(e.id); entities.push(e); } return e.id; };
    const addEdge = (source, target, type, meta = {}) => {
        if (!byId.has(source) || !byId.has(target)) return;
        const key = `${source}|${target}|${type}|${meta.line ?? ''}`;
        if (edgeKeys.has(key)) return;
        if (edges.length >= 80000) { bounded = true; return; }
        edgeKeys.add(key);
        edges.push({ id:`edge:${stableAnalysisHash(key)}`, source, target, type, ...meta });
        counters.addedSourceEdges++;
    };
    const inferred = (file, line, extra = {}) => ({ sourcePath:file, line, resolution:'inferred', confidence:'low', ...extra });
    const channelId = item => `channel:${stableAnalysisHash(`${item.transport || 'application-event'}|${item.channel}`)}`;
    for (const item of crossSystemIntelligence.messages || []) {
        const source = paths.get(item.file);
        if (!source) continue;
        const id = addNode({ id:channelId(item), kind:'message-channel', name:item.channel, transport:item.transport || 'application-event', confidence:'low' });
        addEdge(source, id, item.side === 'publish' ? 'publishes-candidate' : 'subscribes-candidate',
            inferred(item.file, item.line, { evidenceKind:item.provenance }));
    }
    // Only produce a navigable publisher -> channel -> consumer chain when the
    // cross-system resolver found one unambiguous literal, transport-scoped pair.
    for (const link of crossSystemIntelligence.messageLinks || []) {
        const consumer = paths.get(link.target?.file);
        if (!consumer) continue;
        const node = channelId(link);
        if (!byId.has(node)) continue;
        addEdge(node, consumer, 'delivers-to-candidate', inferred(link.target.file, link.target.line,
            { evidenceKind:'unique-literal-subscriber', transport:link.transport }));
    }
    const tables = new Map();
    for (const entity of entities.filter(e => e.kind === 'database-table')) {
        const key = `${entity.name?.toLowerCase()}|${entity.path}`;
        if (!tables.has(key)) tables.set(key, []);
        tables.get(key).push(entity);
    }
    for (const item of crossSystemIntelligence.databaseLinks || []) {
        const source = paths.get(item.source?.file);
        const candidates = tables.get(`${item.target?.name?.toLowerCase()}|${item.target?.file}`) || [];
        if (source && candidates.length === 1) addEdge(source, candidates[0].id, 'queries-table-candidate',
            inferred(item.source.file, item.source.line, { operation:item.operation, confidence:item.confidence }));
        else counters.suppressedAmbiguousLinks++;
    }
    for (const item of businessIntelligence.rules || []) {
        const file = paths.get(item.file);
        if (!file) continue;
        const id = addNode({ id:`business:${stableAnalysisHash(item.id)}`, kind:'business-rule-candidate', name:item.condition,
            path:item.file, startLine:item.line, endLine:item.endLine, outcome:item.outcome,
            owner:item.owner || null, confidence:'low', provenance:item.provenance });
        addEdge(file, id, 'contains-rule-candidate', inferred(item.file, item.line));
        const owned = item.owner && (functions.get(`${item.owner.file}|${item.owner.line}`) || []).filter(e=>e.name===item.owner.name);
        if (owned?.length === 1) addEdge(owned[0].id, id, 'governs-rule-candidate', inferred(item.file, item.line, { evidenceKind:'function-source-span' }));
    }
    for (const transition of businessIntelligence.stateTransitions || []) {
        const file = paths.get(transition.file);
        if (!file) continue;
        const id = addNode({ id:`state:${stableAnalysisHash(`${transition.ruleId}|${transition.line}|${transition.entity}|${transition.to}`)}`,
            kind:'state-transition-candidate', name:`${transition.entity}.${transition.property} -> ${transition.to}`,
            path:transition.file, startLine:transition.line, entity:transition.entity, property:transition.property,
            to:transition.to, ruleId:transition.ruleId, confidence:'low' });
        const rule = `business:${stableAnalysisHash(transition.ruleId)}`;
        addEdge(rule, id, 'produces-state-transition-candidate', inferred(transition.file, transition.line));
    }
    const endpoints = new Map();
    for (const entity of entities.filter(e => e.kind === 'endpoint')) {
        const key = `${entity.path}|${entity.startLine}|${entity.method}`;
        if (!endpoints.has(key)) endpoints.set(key, []);
        endpoints.get(key).push(entity);
    }
    for (const flow of executionIntelligence.flows || []) {
        const ep = flow.endpoint;
        const matches = endpoints.get(`${ep?.file}|${ep?.line}|${String(ep?.method).toUpperCase()}`) || [];
        if (matches.length !== 1 || !flow.handler?.file) { if (matches.length > 1) counters.suppressedAmbiguousLinks++; continue; }
        const handler = (functions.get(`${flow.handler.file}|${flow.handler.line}`) || []);
        if (handler.length === 1) addEdge(matches[0].id, handler[0].id, 'handler-function-candidate',
            inferred(flow.handler.file, flow.handler.line, { evidenceKind:flow.handler.basis, confidence:flow.handler.confidence || 'low' }));
        else {
            const target = paths.get(flow.handler.file);
            if (target) addEdge(matches[0].id, target, 'handler-file-candidate',
                inferred(flow.handler.file, flow.handler.line, { evidenceKind:flow.handler.basis }));
        }
    }
    for (const link of executionIntelligence.clientLinks || []) {
        const source = paths.get(link.source?.file);
        const matches = endpoints.get(`${link.target?.file}|${link.target?.line}|${String(link.target?.method).toUpperCase()}`) || [];
        if (source && matches.length === 1) addEdge(source, matches[0].id, 'http-request-candidate',
            inferred(link.source.file, link.source.line, { evidenceKind:link.relation, confidence:link.confidence }));
        else counters.suppressedAmbiguousLinks++;
    }
    const kinds = {}, relations = {};
    for (const e of entities) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    for (const e of edges) relations[e.type] = (relations[e.type] || 0) + 1;
    return { ...model, status:bounded?'partial':model.status, entities, edges,
        summary:{ entityCount:entities.length, edgeCount:edges.length, entityKinds:kinds, relationKinds:relations },
        diagnostics:{ ...model.diagnostics, intelligenceGraphTruncated:bounded, ...counters },
        semantics:'Unified source-derived graph. New business, message and HTTP links remain candidate relationships, never observed runtime paths.' };
}
