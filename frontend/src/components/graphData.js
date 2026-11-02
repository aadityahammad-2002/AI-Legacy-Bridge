/**
 * Pure display transformations for the repository graph.
 * Inputs must originate from the real analyzer snapshot; no inferred,
 * generated or fabricated nodes/edges are introduced here.
 */
export function buildFolderGraph(files = [], dependencies = []) {
    const folderOf = (path) => {
        const normalized = String(path || '');
        const i = normalized.lastIndexOf('/');
        return i < 0 ? '(root)' : normalized.slice(0, i);
    };
    const folders = new Set(files.filter((file) => typeof file.path === 'string').map((file) => folderOf(file.path)));
    const nodes = [...folders].map((id) => ({ id, label: id.split('/').pop() || id }));
    const edgeKeys = new Set();
    for (const dependency of dependencies) {
        if (!dependency?.source || !dependency?.target) continue;
        const from = folderOf(dependency.source);
        const to = folderOf(dependency.target);
        // Inferred/external targets must not create invisible synthetic folders.
        if (from !== to && folders.has(from) && folders.has(to)) {
            edgeKeys.add(JSON.stringify([from, to]));
        }
    }
    const edges = [...edgeKeys].map((key) => {
        const [source, target] = JSON.parse(key);
        return { source, target };
    });
    return { nodes, edges };
}

/**
 * Limit only the rendered view, not the source data. When the user selects
 * a file from the left panel, keep it visible even in a huge repository.
 */
export function selectVisibleGraphNodes(nodes = [], edges = [], selectedNodeId = null, limit = 400) {
    if (nodes.length <= limit) return nodes;
    const selected = nodes.find((node) => node.id === selectedNodeId);
    if (!selected) return nodes.slice(0, limit);
    const neighbors = new Set();
    for (const edge of edges) {
        if (edge.source === selectedNodeId) neighbors.add(edge.target);
        if (edge.target === selectedNodeId) neighbors.add(edge.source);
    }
    return [
        selected,
        ...nodes.filter((node) => node.id !== selectedNodeId && neighbors.has(node.id)),
        ...nodes.filter((node) => node.id !== selectedNodeId && !neighbors.has(node.id)),
    ].slice(0, limit);
}
