/** Audits evidence availability and relation trust without implying semantic correctness. */
export function auditEngineeringGraph(model = {}, files = [], options = {}) {
    const maxIssues = Math.max(1, Math.min(500, Number(options.maxIssues) || 100));
    const locations = new Map(files.map(f => [f.path, typeof f.content === 'string' ? f.content.split(/\r?\n/).length : 0]));
    const nodes = new Map((model.entities || []).map(e => [e.id,e]));
    const summary = { graphEdges:0, evidenceChecked:0, evidenceValid:0, missingSource:0, invalidLine:0,
        missingLine:0, danglingEdges:0, duplicateEdgeIds:0, duplicateRelations:0, resolved:0, inferred:0, ambiguousOrUnresolved:0, unknownResolution:0 };
    const issues = [];
    const issue = (edge, code) => { if (issues.length < maxIssues) issues.push({ edgeId:edge.id, relation:edge.type, code, sourcePath:edge.sourcePath || null, line:edge.line ?? null }); };
    const seenIds = new Set(), seenRelations = new Set();
    for (const edge of model.edges || []) {
        const relationKey = [edge.source, edge.target, edge.type, edge.line ?? '', edge.resolution || ''].join('|');
        if (edge.id && seenIds.has(edge.id)) { summary.duplicateEdgeIds++; issue(edge,'duplicate-edge-id'); }
        if (seenRelations.has(relationKey)) { summary.duplicateRelations++; issue(edge,'duplicate-relation'); }
        if (edge.id) seenIds.add(edge.id);
        seenRelations.add(relationKey);
        summary.graphEdges++;
        if (!nodes.has(edge.source) || !nodes.has(edge.target)) { summary.danglingEdges++; issue(edge,'dangling-entity'); }
        if (edge.resolution === 'resolved' || edge.resolution === 'observed') summary.resolved++;
        else if (edge.resolution === 'inferred') summary.inferred++;
        else if (edge.resolution === 'unresolved' || edge.resolution === 'ambiguous') summary.ambiguousOrUnresolved++;
        else summary.unknownResolution++;
        const src = edge.sourcePath || nodes.get(edge.source)?.path;
        if (!src) continue;
        summary.evidenceChecked++;
        const count = locations.get(src);
        if (count == null) { summary.missingSource++; issue(edge,'missing-evidence-file'); continue; }
        if (edge.line == null) { summary.missingLine++; continue; }
        if (!Number.isInteger(edge.line) || edge.line < 1 || edge.line > count) { summary.invalidLine++; issue(edge,'invalid-evidence-line'); continue; }
        summary.evidenceValid++;
    }
    return { schemaVersion:1, status:summary.danglingEdges || summary.invalidLine || summary.missingSource || summary.duplicateEdgeIds || summary.duplicateRelations ? 'partial':'complete',
        summary, issues, issuesTruncated:issues.length >= maxIssues,
        semantics:'Checks only graph referential and source-location integrity. Evidence validity is NOT proof of semantic truth or runtime coverage.' };
}
