/** Publicly supported repository visualization modes, shared by both explorers. */
export const GRAPH_VIEW_OPTIONS = Object.freeze([
    { value: 'graph', label: 'Graph' },
    { value: 'treemap', label: 'Treemap' },
    { value: 'cluster', label: 'Cluster' },
    { value: 'matrix', label: 'Matrix' },
    { value: 'flow', label: 'Flow' },
    { value: 'subway', label: 'Subway Map' },
]);

const supportedViews = new Set(GRAPH_VIEW_OPTIONS.map(({ value }) => value));

/** Legacy stored choices (Tree / Bundle / Galaxy) safely fall back to Graph. */
export function normalizeGraphView(value) {
    return supportedViews.has(value) ? value : 'graph';
}
