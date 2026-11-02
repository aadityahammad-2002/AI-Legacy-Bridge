/** Source-backed, DOM-free transformations shared by graph views and regression tests.
 * Display limits never modify the analysis snapshot. A dependency source/target
 * is directed: source references target; it does not imply execution order.
 */
export function fileDegree(edges = []) {
    const degree = new Map();
    for (const e of edges) {
        if (typeof e?.source !== 'string' || typeof e?.target !== 'string') continue;
        degree.set(e.source, (degree.get(e.source) || 0) + 1);
        degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    return degree;
}

/** Degree-aware subset, always including the selection and as many neighbors as fit. */
export function selectPriorityFiles(files = [], edges = [], selectedId = null, limit = 100) {
    const cap = Math.max(1, Math.floor(Number(limit) || 1));
    if (files.length <= cap) return files;
    const degree = fileDegree(edges);
    const neighbors = new Set();
    for (const edge of edges) {
        if (edge.source === selectedId) neighbors.add(edge.target);
        if (edge.target === selectedId) neighbors.add(edge.source);
    }
    const ranked = [...files].sort((a, b) => {
        const rank = (f) => (f.path === selectedId ? 2 : neighbors.has(f.path) ? 1 : 0);
        return rank(b) - rank(a) || (degree.get(b.path) || 0) - (degree.get(a.path) || 0)
            || a.path.localeCompare(b.path);
    });
    return ranked.slice(0, cap);
}

/** Matrix rows are dependency SOURCES; columns are referenced TARGETS. */
export function createMatrixModel(nodes = [], edges = [], selectedId = null, limit = Infinity) {
    const listed = nodes.filter((node) => typeof node?.id === 'string');
    const ranked = selectPriorityFiles(listed.map((n) => ({ ...n, path: n.id })), edges, selectedId, limit);
    const shown = ranked.map(({ path: _path, ...node }) => node);
    const idOf = new Map(shown.map((node, index) => [node.id, index]));
    const pairs = new Map();
    for (const edge of edges) {
        const row = idOf.get(edge.source), col = idOf.get(edge.target);
        if (row == null || col == null) continue;
        const key = JSON.stringify([edge.source, edge.target]);
        if (!pairs.has(key)) pairs.set(key, { row, col, source: edge.source, target: edge.target, count: 0 });
        pairs.get(key).count += 1;
    }
    return { shown, pairs: [...pairs.values()], visibleCount: shown.length, totalCount: listed.length };
}

/** Counts all resolved file-to-file edges by source and target architectural layer.
 * Same-layer edges are tracked, not silently discarded. No execution-flow claim.
 */
export function createLayerDependencySummary(files = [], edges = []) {
    const layerOf = new Map(files.filter((f) => typeof f?.path === 'string').map((f) => [f.path, f.layer || 'other']));
    const layers = [...new Set(layerOf.values())].sort();
    const counts = new Map();
    let external = 0;
    for (const e of edges) {
        const sourceLayer = layerOf.get(e.source), targetLayer = layerOf.get(e.target);
        if (!sourceLayer || !targetLayer) { external += 1; continue; }
        const key = JSON.stringify([sourceLayer, targetLayer]);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const pairs = [...counts.entries()].map(([key, count]) => {
        const [from, to] = JSON.parse(key);
        return { from, to, count, internal: from === to };
    });
    return { layers, pairs, external, countedEdges: pairs.reduce((sum, p) => sum + p.count, 0),
        internalEdges: pairs.filter((p) => p.internal).reduce((sum, p) => sum + p.count, 0) };
}

export function selectSubwayStations(files = [], edges = [], selectedId = null, limit = 9) {
    return selectPriorityFiles(files, edges, selectedId, limit);
}

/** True when a directed dependency is incident to a selected file.
 * Works for original string IDs and D3 forceLink's resolved node objects. */
export function incidentDependency(edge, selectedId) {
    if (!selectedId || !edge) return false;
    const id = (endpoint) => typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint;
    return id(edge.source) === selectedId || id(edge.target) === selectedId;
}
