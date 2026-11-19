/**
 * Source-evidence-only graph window. Preserve original node/edge object identities.
 * A selected node outside the first page brings its actual neighbors into view;
 * source-backed selected edges have priority within the visible edge budget.
 * Neither selection nor filtering inserts synthetic relationships.
 */
export function visibleEvidenceGraph(nodes = [], edges = [], {
    selected = null, neighborsOnly = false, nodeLimit = 80, edgeLimit = 1200
} = {}) {
    const cap = Math.max(1, Math.min(5000, Math.floor(Number(nodeLimit) || 80)));
    const edgeCap = Math.max(1, Math.min(20000, Math.floor(Number(edgeLimit) || 1200)));
    const byId = new Map();
    for (const node of nodes) {
        if (node?.id != null && !byId.has(node.id)) byId.set(node.id, node);
    }
    const candidates = [...byId.values()];
    const selectedExists = selected != null && byId.has(selected);
    const focusApplied = Boolean(neighborsOnly && selectedExists);
    const incidentIds = new Set(selectedExists ? [selected] : []);
    if (selectedExists) {
        for (const edge of edges) {
            if (edge?.source === selected && byId.has(edge.target)) incidentIds.add(edge.target);
            if (edge?.target === selected && byId.has(edge.source)) incidentIds.add(edge.source);
        }
    }
    // Always reserve the first part of the bounded view for the selected node
    // and its real neighbors, even when the selected node was already in the
    // first page. Otherwise a valid selected node could appear disconnected
    // merely because its linked nodes were beyond the 80-node initial budget.
    // Keep original node identities and source order; fabricate no edges.
    const base = focusApplied ? candidates.filter(node => incidentIds.has(node.id)) : candidates;
    const prioritized = selectedExists
        ? [byId.get(selected), ...base.filter(node => node.id !== selected && incidentIds.has(node.id))]
        : [];
    const prioritizedIds = new Set(prioritized.map(node => node.id));
    const initialNodes = base.slice(0, cap);
    const initialIds = new Set(initialNodes.map(node => node.id));
    const needsNeighborhood = selectedExists && [...incidentIds].some(id => !initialIds.has(id));
    // Preserve an already-complete displayed neighborhood to avoid a visual
    // jump every time the user clicks a node. Re-page only when real connected
    // nodes would otherwise be invisible due to the rendering cap.
    const visibleNodes = needsNeighborhood
        ? [...prioritized, ...base.filter(node => !prioritizedIds.has(node.id))].slice(0, cap)
        : initialNodes;
    const subset = new Set(visibleNodes.map(node => node.id));
    const selectedEdges = [], otherEdges = [];
    for (const edge of edges) {
        if (!subset.has(edge?.source) || !subset.has(edge?.target)) continue;
        if (selectedExists && (edge.source === selected || edge.target === selected)) selectedEdges.push(edge);
        else otherEdges.push(edge);
    }
    const visibleEdges = [...selectedEdges.slice(0,edgeCap), ...otherEdges.slice(0,Math.max(0,edgeCap-selectedEdges.length))];
    const eligibleEdges = selectedEdges.length + otherEdges.length;
    return {
        nodes: visibleNodes, edges: visibleEdges,
        totalNodes: candidates.length, totalInputNodes: nodes.length, totalEdges: edges.length,
        eligibleEdges, omittedNodes: base.length - visibleNodes.length,
        omittedEdges: eligibleEdges - visibleEdges.length,
        selectedIncidentEligible: selectedEdges.length,
        selectedIncidentRendered: Math.min(selectedEdges.length,edgeCap),
        duplicateNodeIds: nodes.length-candidates.length,
        focusApplied
    };
}

/** Search ranks exact id/label, then prefixes, then substring, without inventing matches. */
export function findGraphNode(nodes = [], query = '') {
    const q = String(query).trim().toLowerCase();
    if (!q) return null;
    let prefix = null, substring = null;
    for (const node of nodes) {
        const label = String(node?.label ?? '').toLowerCase();
        const id = String(node?.id ?? '').toLowerCase();
        const file = String(node?.file ?? '').toLowerCase();
        if (id === q || label === q || file === q) return node;
        if (!prefix && (label.startsWith(q) || id.startsWith(q))) prefix = node;
        if (!substring && (label.includes(q) || id.includes(q) || file.includes(q))) substring = node;
    }
    return prefix || substring || null;
}

/** Edge inspector provenance: only explicit file/line fields may become source links. */
export function edgeEvidenceLocation(edge) {
    if (!edge || typeof edge !== 'object') return null;
    const first = Array.isArray(edge.evidence) ? edge.evidence.find(x => x && typeof x === 'object') : null;
    const file = first?.file || first?.source || edge.caller || edge.file || null;
    const rawLine = first?.line ?? edge.site ?? edge.line ?? null;
    const value = rawLine == null ? null : Number(rawLine);
    const line = Number.isSafeInteger(value) && value > 0 ? value : null;
    return typeof file === 'string' && file ? {file,line} : null;
}
