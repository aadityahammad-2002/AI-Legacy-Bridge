import ClusterWorker from '../workers/cluster.worker.js?worker';
import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import * as d3 from 'd3';
import { createMatrixModel, createLayerDependencySummary, selectSubwayStations, incidentDependency } from './graphViewModels.js';

import './AltVisualizations.css';

/**
 * Supported alternate views (besides Graph): Treemap, Cluster, Matrix, Flow,
 * Subway Map. Every view uses source-backed files/edges and the same pan/zoom.
 */
const PALETTE = ['#8b5cf6', '#60a5fa', '#2dd4bf', '#4ade80', '#fb923c', '#f472b6', '#facc15', '#f87171'];

function hashColor(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h << 5) - h + key.charCodeAt(i), h |= 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
}

function folderOf(path) {
    const i = path.lastIndexOf('/');
    return i === -1 ? 'root' : path.slice(0, i);
}

/** Builds a full nested-path d3.hierarchy() root — used by Treemap. */
function buildFileHierarchy(files) {
    const root = { name: '', children: [], path: '' };
    const dirIndex = new Map([['', root]]);

    files.forEach((f) => {
        const parts = f.path.split('/');
        let currentPath = '';
        let parent = root;
        for (let i = 0; i < parts.length - 1; i++) {
            currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
            let dir = dirIndex.get(currentPath);
            if (!dir) {
                dir = { name: parts[i], path: currentPath, children: [] };
                dirIndex.set(currentPath, dir);
                parent.children.push(dir);
            }
            parent = dir;
        }
        parent.children.push({ name: parts[parts.length - 1], path: f.path, value: Math.max(1, f.loc || f.lines || 1), leaf: true });
    });

    return d3.hierarchy(root).sum((d) => (d.leaf ? d.value : 0));
}

const AltVisualizations = forwardRef(function AltVisualizations({ vizType, files, nodes, edges, issues, selectedNodeId, onSelectNode }, ref) {
    const containerRef = useRef(null);
    const svgRef = useRef(null);
    const captionRef = useRef(null);
    const [showViewDetails, setShowViewDetails] = useState(false);
    const [size, setSize] = useState({ width: 900, height: 600 });
    const [treemapFolder, setTreemapFolder] = useState('');
    const flowSummary = vizType === 'flow' ? createLayerDependencySummary(files, edges) : null;
    const matrixSummary = vizType === 'matrix' ? createMatrixModel(nodes, edges) : null;
    const treemapFiles = treemapFolder ? files.filter((f) => f.path.startsWith(`${treemapFolder}/`)) : files;
    const viewDescription = vizType === 'treemap'
        ? `${treemapFiles.length} of ${files.length} source files · rectangle area proportional to LOC (minimum 1)`
        : vizType === 'cluster'
            ? `${files.length} files · grouped by folder · select a file to isolate its edges`
            : vizType === 'matrix'
                ? `${matrixSummary.visibleCount} of ${matrixSummary.totalCount} files · row = referencing source, column = target`
                : vizType === 'flow'
                    ? `${flowSummary.countedEdges} mapped dependencies · ${flowSummary.internalEdges} within layers · ${flowSummary.external} unresolved/external excluded`
                    : `Folder hierarchy is solid · dotted overlays are observed cross-folder dependencies (subset)`;
    const switchTreemapFolder = (path) => setTreemapFolder(path || '');
    // Selection updates *styles only*. Never rebuild a D3 graph on a file click:
    // that resets the zoom transform, animations, and the active gesture.
    // Read via ref inside the structural effect below so a selection change
    // (clicking a node) never re-runs the effect that (re)builds the SVG and
    // attaches d3.zoom() — doing that mid-drag was stacking a second zoom/pan
    // listener on top of the first every click, and if a gesture was in
    // flight when the DOM got wiped out from under it, it threw with no
    // error boundary anywhere in the app to catch it — blanking the whole page.
    const selectedNodeIdRef = useRef(selectedNodeId);
    const onSelectNodeRef = useRef(onSelectNode);
    // D3 event handlers must not retain callbacks from an obsolete render.
    selectedNodeIdRef.current = selectedNodeId;
    onSelectNodeRef.current = onSelectNode;

    useImperativeHandle(ref, () => ({
        getSvgElement: () => svgRef.current,
    }), []);

    useEffect(() => {
        if (!containerRef.current) return;
        const el = containerRef.current;
        const measure = () => setSize({
            width: Math.max(1, el.clientWidth || 900),
            height: Math.max(1, (el.clientHeight || 600) - (captionRef.current?.offsetHeight || 0)),
        });
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        if (captionRef.current) ro.observe(captionRef.current);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        if (!svgRef.current || size.width < 10 || size.height < 10) return;
        const svgEl = d3.select(svgRef.current);
        svgEl.on('.zoom', null); // remove any previously-attached zoom/drag listeners before rebuilding — see selectedNodeIdRef comment above
        svgEl.selectAll('*').remove();
        svgEl.attr('height', size.height); // reset viewport when switching views

        // Keep D3 zoom on the canvas; only the supported renderer is mounted.
        const defs = svgEl.append('defs');
        defs.append('marker').attr('id', 'alt-viz-dependency-arrow')
            .attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5)
            .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto-start-reverse')
            .append('path').attr('d', 'M0,0 L10,5 L0,10 Z').attr('fill', '#9bb8cd');
        const zoomLayer = svgEl.append('g').attr('class', 'alt-viz__zoom-layer');
        let clusterCleanup = null;
        let subwayCleanup = null;
        const zoomBehavior = d3.zoom()
            .scaleExtent([0.01, 8])
            .on('zoom', (event) => { zoomLayer.attr('transform', event.transform); });
        svgEl.call(zoomBehavior);

        const sel = selectedNodeIdRef.current;
        const selectFile = (id) => onSelectNodeRef.current?.(
            vizType === 'cluster' && selectedNodeIdRef.current === id ? null : id
        );
        const fitSubwayOuterRing = (extraRing = 0) => {
            const outerRadius = Math.min(size.width, size.height) * 0.44 + 80 + extraRing * 58;
            const fit = Math.min(0.94, (Math.min(size.width, size.height) / 2 - 22) / outerRadius);
            const scale = Math.max(0.01, fit);
            const cx = size.width / 2, cy = size.height / 2;
            svgEl.transition().duration(240).call(zoomBehavior.transform,
                d3.zoomIdentity.translate(cx * (1 - scale), cy * (1 - scale)).scale(scale));
        };
        if (vizType === 'treemap') renderTreemap(zoomLayer, treemapFiles, size, sel, selectFile, switchTreemapFolder, treemapFolder);
        else if (vizType === 'cluster') clusterCleanup = renderCluster(zoomLayer, files, edges, size, sel, selectFile);
        else if (vizType === 'matrix') renderMatrix(zoomLayer, nodes, edges, size, sel, selectFile);
        else if (vizType === 'flow') renderFlow(zoomLayer, files, edges, size);
        else if (vizType === 'subway') subwayCleanup = renderSubway(zoomLayer, files, edges, issues, size, sel, selectFile, fitSubwayOuterRing);

        // Subway's radial map reads best with a little margin.
        if (vizType === 'subway') {
            svgEl.call(zoomBehavior.transform, d3.zoomIdentity.translate(size.width * 0.02, size.height * 0.02).scale(0.94));
        } else if (vizType === 'matrix') {
            // Fit the complete (uncapped) matrix on first display. Users can
            // zoom into its individual cells instead of silently losing files.
            const matrixExtent = 136 + Math.max(1, nodes.length) * 13 + 24;
            const scale = Math.min(1, (size.width - 18) / matrixExtent, (size.height - 18) / matrixExtent);
            svgEl.call(zoomBehavior.transform, d3.zoomIdentity.translate(8, 8).scale(Math.max(0.01, scale)));
        } else if (vizType === 'cluster') {
            const world = clusterWorldSize(files, size);
            const scale = Math.min(1, size.width / world.width, size.height / world.height);
            svgEl.call(zoomBehavior.transform, d3.zoomIdentity.scale(scale));
        }

        return () => { clusterCleanup?.(); subwayCleanup?.(); svgEl.on('.zoom', null); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vizType, files, nodes, edges, issues, size, treemapFolder]); // other selection changes only update styles

    useEffect(() => {
        if (!svgRef.current) return;
        const svgEl = d3.select(svgRef.current);

        if (vizType === 'treemap') {
            svgEl.selectAll('rect.alt-viz__treemap-rect')
                .attr('opacity', (d) => (d.data.path === selectedNodeId ? 1 : 0.72))
                .attr('stroke', (d) => (d.data.path === selectedNodeId ? '#fff' : 'rgba(0,0,0,0.35)'))
                .attr('stroke-width', (d) => (d.data.path === selectedNodeId ? 2 : 1));
        } else if (vizType === 'cluster') {
            svgEl.selectAll('circle.alt-viz__cluster-circle')
                .attr('stroke', (d) => (d.id === selectedNodeId ? '#fff' : 'var(--lb-bg)'));
            // A selected file shows ONLY its directly incident dependencies.
            // No selection means the full observed network is visible.
            svgEl.selectAll('line.alt-viz__cluster-link')
                .attr('display', (d) => !selectedNodeId || incidentDependency(d, selectedNodeId) ? null : 'none')
                .attr('stroke', (d) => selectedNodeId && incidentDependency(d, selectedNodeId) ? '#fff' : 'var(--lb-accent)')
                .attr('stroke-opacity', (d) => selectedNodeId ? 0.96 : 0.25)
                .attr('stroke-width', (d) => selectedNodeId ? 2 : 1);
            const neighbors = new Set();
            svgEl.selectAll('line.alt-viz__cluster-link').each((d) => {
                if (selectedNodeId && incidentDependency(d, selectedNodeId)) {
                    neighbors.add(typeof d.source === 'object' ? d.source.id : d.source);
                    neighbors.add(typeof d.target === 'object' ? d.target.id : d.target);
                }
            });
            svgEl.selectAll('g.alt-viz__node').attr('opacity', (d) => !selectedNodeId || neighbors.has(d.id) || d.id === selectedNodeId ? 1 : 0.26);
        } else if (vizType === 'matrix') {
            svgEl.selectAll('rect.alt-viz__matrix-cell')
                .attr('fill', (d) => (d.source === selectedNodeId || d.target === selectedNodeId ? '#fff' : 'var(--lb-accent)'));
        } else if (vizType === 'subway') {
            svgEl.selectAll('.sg-node').classed('sg-node--selected', (d) => (d?.data ? d.data.id : d?.id) === selectedNodeId);
            svgEl.selectAll('.sg-subway__dependency')
                .attr('opacity', (d) => !selectedNodeId || incidentDependency(d, selectedNodeId) ? 0.65 : 0.13);
        }
    }, [vizType, selectedNodeId]);
    return (
        <div className="alt-viz" ref={containerRef}>
            <div className="alt-viz__caption" ref={captionRef}>
                <div className="alt-viz__caption-main">
                    <strong>{vizType === 'flow' ? 'Layer dependencies' : vizType === 'subway' ? 'Subway · folders' : vizType === 'cluster' ? 'Folder clusters' : vizType === 'matrix' ? 'Dependency matrix' : vizType === 'treemap' ? 'Repository treemap' : 'Repository graph'}</strong>
                    <span className="alt-viz__caption-summary" title={viewDescription}>{viewDescription}</span>
                    {vizType === 'treemap' && treemapFolder && (
                        <button type="button" className="alt-viz__back" onClick={() => setTreemapFolder(treemapFolder.includes('/') ? treemapFolder.slice(0, treemapFolder.lastIndexOf('/')) : '')}>
                            ← Back
                        </button>
                    )}
                    <button type="button" className="alt-viz__info-toggle" aria-expanded={showViewDetails}
                        aria-label={showViewDetails ? 'Hide graph information' : 'Show graph information'}
                        onClick={() => setShowViewDetails((v) => !v)}>
                        {showViewDetails ? 'Less −' : 'Info +'}
                    </button>
                </div>
                {showViewDetails && <div className="alt-viz__caption-detail" role="status">{viewDescription}</div>}
            </div>
            <svg ref={svgRef} width={size.width} height={size.height} className="alt-viz__svg" />
        </div>
    );
});

export default AltVisualizations;

function renderTreemap(g, files, size, selectedNodeId, onSelectNode, onDrill, currentFolder = '') {
    const root = buildFileHierarchy(files);
    d3.treemap().size([size.width, size.height]).paddingInner(2).paddingOuter(3).round(true)(root);

    const leaves = root.leaves();
    const cell = g.selectAll('g').data(leaves).join('g')
        .attr('transform', (d) => `translate(${d.x0},${d.y0})`)
        .attr('class', 'alt-viz__cell')
        .style('cursor', 'pointer')
        .attr('tabindex', 0).attr('role', 'button')
        .attr('aria-label', (d) => `Select file ${d.data.path}`)
        .on('keydown', (e, d) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectNode?.(d.data.path); } })
        .on('click', (_e, d) => onSelectNode?.(d.data.path))
        .on('dblclick', (event, d) => {
            event.stopPropagation();
            const folder = folderOf(d.data.path);
            if (folder && folder !== 'root' && folder !== currentFolder) onDrill(folder);
        });

    cell.append('title').text((d) => `${d.data.path} · ${d.data.value} LOC (minimum 1) · double click to drill into folder`);

    cell.append('rect')
        .attr('class', 'alt-viz__treemap-rect')
        .attr('width', (d) => Math.max(0, d.x1 - d.x0))
        .attr('height', (d) => Math.max(0, d.y1 - d.y0))
        .attr('fill', (d) => hashColor(folderOf(d.data.path)))
        .attr('opacity', (d) => (d.data.path === selectedNodeId ? 1 : 0.72))
        .attr('stroke', (d) => (d.data.path === selectedNodeId ? '#fff' : 'rgba(0,0,0,0.35)'))
        .attr('stroke-width', (d) => (d.data.path === selectedNodeId ? 2 : 1));

    cell.append('text')
        .attr('x', 5).attr('y', 14)
        .attr('class', 'alt-viz__label')
        .text((d) => {
            const width = d.x1 - d.x0;
            if (width < 43 || d.y1 - d.y0 < 20) return '';
            const chars = Math.max(1, Math.floor((width - 10) / 6));
            return d.data.name.length > chars ? `${d.data.name.slice(0, Math.max(1, chars - 1))}…` : d.data.name;
        });


}

/**
 * Cluster — disjoint force-directed layout: one grid cell per folder, nodes
 * pulled toward their folder's cell center (forceX/forceY) while still
 * repelling each other and linking on real dependency edges — matches
 * the existing Cluster layout without introducing synthetic dependency edges.
 */
/** Keep every file visible. Grow the virtual canvas for dense folder sets;
 * the initial zoom fits this virtual canvas within the physical viewport. */
function clusterWorldSize(files, size) {
    const folders = new Set(files.map((f) => folderOf(f.path)));
    const count = Math.max(1, folders.size);
    const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / cols));
    const perFolder = Math.ceil(files.length / count);
    const cell = Math.max(190, Math.min(400, 120 + Math.sqrt(perFolder) * 32));
    return { width: Math.max(size.width, cols * cell), height: Math.max(size.height, rows * cell) };
}

function renderCluster(g, files, edges, size, selectedNodeId, onSelectNode) {
    const shown = files; // All actual files, never the first 100.
    const world = clusterWorldSize(files, size);
    const folders = [...new Set(shown.map((f) => folderOf(f.path)))];
    const cols = Math.ceil(Math.sqrt(folders.length));
    const cellW = world.width / cols;
    const cellH = world.height / Math.ceil(folders.length / cols);
    const centerOf = new Map(folders.map((f, i) => [f, { x: (i % cols + 0.5) * cellW, y: (Math.floor(i / cols) + 0.5) * cellH }]));

    const pathSet = new Set(shown.map((f) => f.path));
    const simNodes = shown.map((f) => {
        const c = centerOf.get(folderOf(f.path));
        return { id: f.path, folder: folderOf(f.path), cx: c.x, cy: c.y };
    });
    const simLinks = edges
        .filter((e) => pathSet.has(e.source) && pathSet.has(e.target) && e.source !== e.target)
        .map((e) => ({ source: e.source, target: e.target }));

    g.selectAll('rect.alt-viz__cluster-bg').data(folders).join('rect')
        .attr('class', 'alt-viz__cluster-bg')
        .attr('x', (_d, i) => (i % cols) * cellW + 8).attr('y', (_d, i) => Math.floor(i / cols) * cellH + 8)
        .attr('width', cellW - 16).attr('height', cellH - 16).attr('rx', 10)
        .attr('fill', (d) => hashColor(d)).attr('opacity', 0.08)
        .attr('stroke', (d) => hashColor(d)).attr('stroke-opacity', 0.4);

    g.selectAll('text.alt-viz__cluster-label').data(folders).join('text')
        .attr('class', 'alt-viz__label alt-viz__cluster-label')
        .attr('x', (_d, i) => (i % cols) * cellW + 18).attr('y', (_d, i) => Math.floor(i / cols) * cellH + 26)
        .style('font-weight', 700).text((d) => d.split('/').pop() || 'root');

    const selectedNeighbors = new Set([selectedNodeId]);
    if (selectedNodeId) simLinks.forEach((edge) => {
        if (incidentDependency(edge, selectedNodeId)) { selectedNeighbors.add(edge.source); selectedNeighbors.add(edge.target); }
    });
    const link = g.selectAll('line.alt-viz__cluster-link').data(simLinks).join('line')
        .attr('class', 'alt-viz__cluster-link')
        .attr('display', (d) => !selectedNodeId || incidentDependency(d, selectedNodeId) ? null : 'none');
    const node = g.selectAll('g.alt-viz__node').data(simNodes).join('g')
        .attr('class', 'alt-viz__node')
        .attr('opacity', (d) => !selectedNodeId || selectedNeighbors.has(d.id) ? 1 : 0.26)
        .attr('tabindex', 0).attr('role', 'button')
        .attr('aria-label', (d) => `Select file ${d.id}`)
        .style('cursor', 'pointer')
        .on('keydown', (e, d) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectNode?.(d.id); } })
        .on('click', (_e, d) => onSelectNode?.(d.id));

    node.append('circle').attr('class', 'alt-viz__cluster-circle').attr('r', 5).attr('fill', (d) => hashColor(d.folder))
        .attr('stroke', (d) => (d.id === selectedNodeId ? '#fff' : 'var(--lb-bg)')).attr('stroke-width', 2);

    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const update = () => {
        link.attr('x1', (d) => byId.get(typeof d.source === 'object' ? d.source.id : d.source)?.x ?? 0)
            .attr('y1', (d) => byId.get(typeof d.source === 'object' ? d.source.id : d.source)?.y ?? 0)
            .attr('x2', (d) => byId.get(typeof d.target === 'object' ? d.target.id : d.target)?.x ?? 0)
            .attr('y2', (d) => byId.get(typeof d.target === 'object' ? d.target.id : d.target)?.y ?? 0);
        node.attr('transform', (d) => `translate(${d.x ?? d.cx},${d.y ?? d.cy})`);
    };
    update(); // render real folder centers before the first worker tick arrives
    let worker = null;
    let sim = null;
    let active = true;
    const runLegacy = () => {
        sim = d3.forceSimulation(simNodes)
            .force('link', d3.forceLink(simLinks).id((d) => d.id).distance(30).strength(0.3))
            .force('charge', d3.forceManyBody().strength(-60))
            .force('x', d3.forceX((d) => d.cx).strength(0.15))
            .force('y', d3.forceY((d) => d.cy).strength(0.15))
            .force('collide', d3.forceCollide(12))
            .on('tick', update);
    };
    if (typeof Worker !== 'undefined') {
        try {
            worker = new ClusterWorker();
            worker.onmessage = ({ data }) => {
                if (!active) return;
                if (data.type === 'positions') {
                    data.positions.forEach(([id, x, y]) => {
                        const n = byId.get(id);
                        if (n) { n.x = x; n.y = y; }
                    });
                    update();
                } else if (data.type === 'error') {
                    console.error('[AltVisualizations] Cluster Worker failed:', data.message);
                    worker?.terminate(); worker = null; runLegacy();
                }
            };
            worker.onerror = (event) => {
                if (!active) return;
                console.error('[AltVisualizations] Cluster Worker failed:', event.message);
                worker?.terminate(); worker = null; runLegacy();
            };
            worker.postMessage({ action: 'start', nodes: simNodes.map((n) => ({ ...n })),
                links: simLinks.map((e) => ({ ...e })) });
        } catch (error) {
            console.error('[AltVisualizations] Cluster Worker unavailable:', error);
            worker?.terminate(); worker = null; runLegacy();
        }
    } else runLegacy();
    node.call(d3.drag()
        .on('start', (e, d) => {
            if (worker) worker.postMessage({ action: 'drag', phase: 'start', id: d.id, x: d.x ?? d.cx, y: d.y ?? d.cy });
            else if (sim) { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
        })
        .on('drag', (e, d) => {
            d.x = e.x; d.y = e.y;
            update();
            if (worker) worker.postMessage({ action: 'drag', phase: 'move', id: d.id, x: e.x, y: e.y });
            else { d.fx = e.x; d.fy = e.y; }
        })
        .on('end', (e, d) => {
            if (worker) worker.postMessage({ action: 'drag', phase: 'end', id: d.id });
            else if (sim) { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }
        }));
    return () => { active = false; worker?.terminate(); sim?.stop(); };
}

const MATRIX_CELL_SIZE = 13; // pan/zoom for large matrices; never cap source files

function renderMatrix(g, nodes, edges, size, selectedNodeId, onSelectNode) {
    // Every real file is represented. Sparse SVG grid: do not create N²
    // background rects (266 files would otherwise allocate 70,756 elements).
    const { shown, pairs: cellPairs } = createMatrixModel(nodes, edges, null, Infinity);

    const margin = { top: 136, right: 16, bottom: 16, left: 136 };
    const n = shown.length;
    const cellSize = MATRIX_CELL_SIZE;

    const gg = g.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    gg.selectAll('text.alt-viz__row-label').data(shown).join('text')
        .attr('class', 'alt-viz__label alt-viz__row-label')
        .attr('x', -4).attr('y', (_d, i) => i * cellSize + cellSize * 0.7)
        .attr('text-anchor', 'end')
        .text((d) => d.label || d.id.split('/').pop())
        .attr('fill', (d) => d.id === selectedNodeId ? '#fff' : null);

    gg.selectAll('text.alt-viz__col-label').data(shown).join('text')
        .attr('class', 'alt-viz__label alt-viz__col-label')
        .attr('transform', (_d, i) => `translate(${i * cellSize + cellSize * 0.7},-4) rotate(-60)`)
        .attr('text-anchor', 'start')
        .text((d) => d.label || d.id.split('/').pop())
        .attr('fill', (d) => d.id === selectedNodeId ? '#fff' : null);

    gg.append('rect').attr('class', 'alt-viz__matrix-bg')
        .attr('width', n * cellSize).attr('height', n * cellSize);
    gg.selectAll('line.alt-viz__matrix-grid-h').data(d3.range(n + 1)).join('line')
        .attr('class', 'alt-viz__matrix-grid')
        .attr('x1', 0).attr('x2', n * cellSize)
        .attr('y1', (i) => i * cellSize).attr('y2', (i) => i * cellSize);
    gg.selectAll('line.alt-viz__matrix-grid-v').data(d3.range(n + 1)).join('line')
        .attr('class', 'alt-viz__matrix-grid')
        .attr('y1', 0).attr('y2', n * cellSize)
        .attr('x1', (i) => i * cellSize).attr('x2', (i) => i * cellSize);

    gg.selectAll('rect.alt-viz__cell').data(cellPairs).join('rect')
        .attr('class', 'alt-viz__matrix-cell')
        .attr('x', (d) => d.col * cellSize).attr('y', (d) => d.row * cellSize)
        .attr('width', cellSize - 1).attr('height', cellSize - 1)
        .attr('fill', (d) => (d.source === selectedNodeId || d.target === selectedNodeId ? '#fff' : 'var(--lb-accent)'))
        .style('cursor', 'pointer')
        .attr('tabindex', 0).attr('role', 'button')
        .attr('aria-label', (d) => `${d.source} references ${d.target}`)
        .on('keydown', (e, d) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectNode?.(d.source); } })
        .on('click', (_e, d) => onSelectNode?.(d.source))
        .append('title').text((d) => `${d.source} references ${d.target}${d.count > 1 ? ` · ${d.count} evidence edges` : ''}`);
}

/**
 * Flow diagram — Sankey-style bands showing how many dependencies cross
 * between architectural layers (f.layer, already computed by the analysis
 * engine — see orchestrator.js). Hand-rolled rather than the `d3-sankey`
 * package (not part of the bundled `d3` module already in package.json).
 */
function renderFlow(g, files, edges, size) {
    const { layers, pairs, external } = createLayerDependencySummary(files, edges);
    if (!layers.length) return;
    const margin = { top: 146, right: 180, bottom: 38, left: 180 };
    const usableHeight = Math.max(150, size.height - margin.top - margin.bottom);
    const bandHeight = usableHeight / layers.length;
    const yOf = new Map(layers.map((layer, i) => [layer, margin.top + (i + 0.5) * bandHeight]));
    const left = margin.left, right = Math.max(margin.left + 160, size.width - margin.right);
    const nodeW = 15;
    const gg = g.append('g');
    gg.append('text').attr('x', left).attr('y', 92).attr('class', 'alt-viz__label').text('SOURCE LAYER (REFERENCING)');
    gg.append('text').attr('x', right).attr('y', 92).attr('class', 'alt-viz__label').text('TARGET LAYER (REFERENCED)');
    gg.append('text').attr('x', left).attr('y', 111).attr('class', 'alt-viz__label')
        .text(`Only mapped file dependencies · ${external} missing/external targets excluded`);
    layers.forEach((layer) => {
        const y = yOf.get(layer);
        for (const x of [left, right]) {
            gg.append('rect').attr('x', x).attr('y', y - Math.min(26, bandHeight * 0.3))
                .attr('width', nodeW).attr('height', Math.min(52, bandHeight * 0.6))
                .attr('fill', hashColor(layer)).attr('rx', 3);
        }
        gg.append('text').attr('x', left - 9).attr('y', y + 4)
            .attr('text-anchor', 'end').attr('class', 'alt-viz__label').text(layer);
        gg.append('text').attr('x', right + nodeW + 9).attr('y', y + 4)
            .attr('text-anchor', 'start').attr('class', 'alt-viz__label').text(layer);
    });
    const max = Math.max(1, ...pairs.map((p) => p.count));
    const widthScale = d3.scaleSqrt().domain([1, max]).range([1.5, 15]);
    const path = d3.linkHorizontal();
    for (const pair of pairs) {
        const width = widthScale(pair.count);
        const rowStart = yOf.get(pair.from), rowEnd = yOf.get(pair.to);
        // The row-equal band is a legitimate same-layer dependency aggregate,
        // NOT a self-call or runtime execution trace.
        const line = gg.append('path').attr('class', 'alt-viz__flow-link')
            .attr('d', path({ source: [left + nodeW, rowStart], target: [right - 5, rowEnd] }))
            .attr('stroke', hashColor(pair.from)).attr('stroke-width', width)
            .attr('stroke-dasharray', pair.internal ? '5 4' : null)
            .attr('marker-end', 'url(#alt-viz-dependency-arrow)')
            .attr('opacity', pair.internal ? 0.64 : 0.44).attr('fill', 'none');
        line.append('title').text(`${pair.from} → ${pair.to}: ${pair.count} observed file dependencies${pair.internal ? ' (same-layer)' : ''}`);
    }
}

// Subway retains its own path routing and real dependency metadata.
const SG_LINE_PALETTE = ['#60a5fa', '#facc15', '#a78bfa', '#4ade80', '#f472b6', '#fb923c', '#2dd4bf', '#f87171'];

function sgTopFolder(path) {
    const i = path.indexOf('/');
    return i === -1 ? '(root)' : path.slice(0, i);
}
function sgBaseName(path) {
    return path.split('/').pop();
}
function sgFolderColors(files) {
    const folders = [...new Set(files.map((f) => sgTopFolder(f.path)))].sort();
    return new Map(folders.map((f, i) => [f, SG_LINE_PALETTE[i % SG_LINE_PALETTE.length]]));
}
function sgDegree(edges) {
    const map = new Map();
    edges.forEach((e) => {
        map.set(e.source, (map.get(e.source) || 0) + 1);
        map.set(e.target, (map.get(e.target) || 0) + 1);
    });
    return map;
}
function sgCircularPairs(issues) {
    const issue = (issues || []).find((i) => i.title?.includes('Circular Dependenc'));
    if (!issue) return [];
    return (issue.items || []).filter((it) => it.files?.length === 2).map((it) => it.files);
}
function sgUnusedPaths(issues) {
    const issue = (issues || []).find((i) => i.title?.includes('Unused Function'));
    return new Set((issue?.items || []).map((it) => it.file).filter(Boolean));
}

/** Greedy label-declutter: keeps a label only if its approx bounding box doesn't
 * overlap one already placed (higher-priority items should come first in `items`). */
function sgPickLabels(items, opts = {}) {
    const { charWidth = 5.6, height = 13, anchorDx = 6, anchorDy = -4, pad = 3 } = opts;
    const placed = [];
    const keep = new Set();
    items.forEach((d) => {
        const text = d.label || '';
        const w = text.length * charWidth + pad * 2;
        const dx = d.centered ? -w / 2 + pad : (d.anchorDx ?? anchorDx);
        const dy = d.anchorDy ?? anchorDy;
        const x0 = d.x + dx - pad, y0 = d.y + dy - height / 2 - pad;
        const x1 = x0 + w, y1 = y0 + height + pad * 2;
        const overlaps = placed.some((p) => !(x1 < p.x0 || x0 > p.x1 || y1 < p.y0 || y0 > p.y1));
        if (!overlaps) { placed.push({ x0, y0, x1, y1 }); keep.add(d.id); }
    });
    return keep;
}

/** Right-angle "elbow" between two points, corners chamfered at 45° — the classic metro-map look. */
function sgChamferPath(points, r = 12) {
    if (points.length < 2) return '';
    let d = `M${points[0].x},${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
        const p0 = points[i - 1], p1 = points[i], p2 = points[i + 1];
        const len1 = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
        const len2 = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
        const cr = Math.min(r, len1 / 2, len2 / 2);
        const inX = p1.x - ((p1.x - p0.x) / len1) * cr, inY = p1.y - ((p1.y - p0.y) / len1) * cr;
        const outX = p1.x + ((p2.x - p1.x) / len2) * cr, outY = p1.y + ((p2.y - p1.y) / len2) * cr;
        d += ` L${inX},${inY} L${outX},${outY}`;
    }
    const last = points[points.length - 1];
    d += ` L${last.x},${last.y}`;
    return d;
}
function sgElbowPath(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 1 || Math.abs(dy) < 1) return `M${a.x},${a.y} L${b.x},${b.y}`;
    const points = Math.abs(dx) > Math.abs(dy)
        ? [a, { x: a.x + dx * 0.6, y: a.y }, { x: a.x + dx * 0.6, y: b.y }, b]
        : [a, { x: a.x, y: a.y + dy * 0.6 }, { x: b.x, y: a.y + dy * 0.6 }, b];
    return sgChamferPath(points, 12);
}
function sgDrawIn(pathSelection, delay = 0, duration = 520) {
    pathSelection.each(function () {
        const el = d3.select(this);
        const len = this.getTotalLength ? this.getTotalLength() : 0;
        if (!len) return;
        el.attr('stroke-dasharray', len).attr('stroke-dashoffset', len)
            .transition().delay(delay).duration(duration).ease(d3.easeCubicOut)
            .attr('stroke-dashoffset', 0)
            .on('end', function () { d3.select(this).attr('stroke-dasharray', null).attr('stroke-dashoffset', null); });
    });
}

// Radial subway map: hierarchy, source-backed stations and dependency indicators.
function renderSubway(g, files, edges, issues, size, selectedNodeId, onSelectNode, fitExpandedRing) {
    const folderColors = sgFolderColors(files);
    const degree = sgDegree(edges);
    const circularPairs = sgCircularPairs(issues);
    const unusedPaths = sgUnusedPaths(issues); // files containing unused-function findings, NOT unused files
    const folders = [...folderColors.keys()];
    const cx = size.width / 2, cy = size.height / 2;
    const outerR = Math.min(size.width, size.height) * 0.44;
    const maxFilesPerStop = 9;

    const crossFolderPaths = new Set();
    edges.forEach((e) => { if (sgTopFolder(e.source) !== sgTopFolder(e.target)) { crossFolderPaths.add(e.source); crossFolderPaths.add(e.target); } });
    const isInterchange = (path) => crossFolderPaths.has(path) || (degree.get(path) || 0) >= 6;

    const root = { name: '(root)', type: 'root', children: [] };
    folders.forEach((folder) => {
        const flist = files.filter((f) => sgTopFolder(f.path) === folder);
        const level1 = new Map();
        flist.forEach((f) => {
            const rest = folder === '(root)' ? f.path : f.path.slice(folder.length + 1);
            const parts = rest.split('/');
            const key = parts.length > 1 ? parts[0] : '(files)';
            if (!level1.has(key)) level1.set(key, []);
            level1.get(key).push({ file: f, parts });
        });

        const topNode = { name: folder, type: 'folder', folder, children: [] };
        level1.forEach((entries, stopName) => {
            const level2 = new Map();
            entries.forEach(({ file, parts }) => {
                const key = parts.length > 2 ? parts[1] : '(files)';
                if (!level2.has(key)) level2.set(key, []);
                level2.get(key).push(file);
            });
            const attachTo = (parentChildren, subName, flistHere) => {
                const bucket = subName === '(files)' ? parentChildren : (() => {
                    const subNode = { name: subName, type: 'folder', folder, children: [] };
                    parentChildren.push(subNode);
                    return subNode.children;
                })();
                const prioritized = [...flistHere].sort((a, b) => (degree.get(b.path) || 0) - (degree.get(a.path) || 0));
                const shown = selectSubwayStations(prioritized, edges, null, maxFilesPerStop);
                const visiblePaths = new Set(shown.map((f) => f.path));
                shown.forEach((f) => bucket.push({
                    name: sgBaseName(f.path), type: 'file', id: f.path, folder,
                    interchange: isInterchange(f.path),
                }));
                const rest = prioritized.length - shown.length;
                if (rest > 0) bucket.push({
                    name: `+${rest} more`, type: 'more', folder,
                    hidden: prioritized.filter((f) => !visiblePaths.has(f.path)),
                });
            };
            if (stopName === '(files)') {
                level2.forEach((flistHere, subName) => attachTo(topNode.children, subName, flistHere));
            } else {
                const stopNode = { name: stopName, type: 'folder', folder, children: [] };
                topNode.children.push(stopNode);
                level2.forEach((flistHere, subName) => attachTo(stopNode.children, subName, flistHere));
            }
        });
        root.children.push(topNode);
    });

    const hierarchyRoot = d3.hierarchy(root, (d) => d.children);
    d3.tree().size([2 * Math.PI, outerR]).separation((a, b) => (a.parent === b.parent ? 1 : 1.6) / Math.max(1, a.depth))(hierarchyRoot);

    hierarchyRoot.each((d) => {
        const angle = d.x - Math.PI / 2;
        const r = d.data.type === 'file' || d.data.type === 'more' ? d.y + 14 : d.y;
        d.px = cx + Math.cos(angle) * r;
        d.py = cy + Math.sin(angle) * r;
    });

    const stationById = new Map();
    hierarchyRoot.each((d) => { if (d.data.type === 'file') stationById.set(d.data.id, d); });

    g.append('circle').attr('class', 'sg-subway__hub').attr('cx', cx).attr('cy', cy).attr('r', 9);

    const links = hierarchyRoot.links();
    links.forEach((link, i) => {
        const isTwig = link.target.data.type === 'file' || link.target.data.type === 'more';
        const cls = isTwig ? 'sg-subway__twig' : 'sg-subway__line';
        const path = g.append('path').attr('class', cls)
            .attr('stroke', folderColors.get(link.target.data.folder))
            .attr('d', sgElbowPath({ x: link.source.px, y: link.source.py }, { x: link.target.px, y: link.target.py }));
        sgDrawIn(path, isTwig ? 480 + (i % 50) * 6 : i * 50, isTwig ? 260 : 460);
    });

    // Hierarchy routes (solid) are NOT file dependencies. Show only a small,
    // explicitly distinguished subset of observed cross-folder references.
    const crossFolderEdges = edges.filter((e) => stationById.has(e.source) && stationById.has(e.target)
        && sgTopFolder(e.source) !== sgTopFolder(e.target));
    // Stable cross-folder subset. Selection changes styling, not geometry.
    const topEdges = [...crossFolderEdges].sort((a, b) => {
        const priority = (e) => (degree.get(e.source) || 0) + (degree.get(e.target) || 0);
        return priority(b) - priority(a);
    }).slice(0, 24);
    const drawn = new Set();
    topEdges.forEach((e) => {
        const key = JSON.stringify([e.source, e.target]);
        if (drawn.has(key)) return;
        drawn.add(key);
        const from = stationById.get(e.source), to = stationById.get(e.target);
        g.append('path').datum(e).attr('class', 'sg-subway__dependency')
            .attr('d', `M${from.px},${from.py} Q${cx},${cy} ${to.px},${to.py}`)
            .attr('marker-end', 'url(#alt-viz-dependency-arrow)')
            .append('title').text(`Observed dependency: ${e.source} → ${e.target}`);
    });
    g.append('text').attr('x', cx).attr('y', size.height - 14).attr('text-anchor', 'middle').attr('class', 'sg-subway__legend')
        .text(`Solid routes: folders · Dashed arrows: ${drawn.size} of ${crossFolderEdges.length} visible cross-folder dependencies`);

    circularPairs.slice(0, 3).forEach(([a, b]) => {
        const sa = stationById.get(a), sb = stationById.get(b);
        if (!sa || !sb) return;
        const dx = sb.px - sa.px, dy = sb.py - sa.py;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const bow = 44;
        const mx = (sa.px + sb.px) / 2 + nx * bow, my = (sa.py + sb.py) / 2 + ny * bow;
        g.append('path').attr('class', 'sg-subway__circular-loop')
            .attr('d', `M${sa.px},${sa.py} Q${mx},${my} ${sb.px},${sb.py}`);
    });

    const unusedList = files.filter((f) => unusedPaths.has(f.path)).slice(0, 10);
    if (unusedList.length) {
        const ux0 = 24, uy0 = size.height - 24 - unusedList.length * 16;
        g.append('text').attr('class', 'sg-subway__unused-title').attr('x', ux0).attr('y', uy0 - 10).text('Files with unused-function findings (not unused files)');
        unusedList.forEach((f, i) => {
            const yy = uy0 + i * 16;
            g.append('circle').attr('class', 'sg-subway__unused-dot').attr('cx', ux0).attr('cy', yy).attr('r', 3);
            g.append('text').attr('class', 'sg-subway__unused-label').attr('x', ux0 + 10).attr('y', yy + 3).text(sgBaseName(f.path));
        });
    }

    const fileNodes = hierarchyRoot.descendants().filter((d) => d.data.type === 'file');
    const moreNodes = hierarchyRoot.descendants().filter((d) => d.data.type === 'more');
    const folderNodes = hierarchyRoot.descendants().filter((d) => d.data.type === 'folder');

    const node = g.append('g').selectAll('g').data(fileNodes).join('g')
        .attr('class', 'sg-node')
        .attr('tabindex', 0).attr('role', 'button')
        .attr('aria-label', (d) => `Select file ${d.data.id}`)
        .attr('transform', (d) => `translate(${d.px},${d.py})`)
        .on('keydown', (e, d) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectNode?.(d.data.id); } })
        .on('click', (_e, d) => onSelectNode?.(d.data.id));

    node.append('title').text((d) => d.data.id);

    node.append('circle')
        .attr('class', (d) => `sg-subway__station${d.data.interchange ? ' sg-subway__station--interchange' : ''}`)
        .attr('r', (d) => (d.data.interchange ? 7 : 3.2))
        .attr('fill', (d) => (d.data.interchange ? 'var(--lb-bg)' : folderColors.get(d.data.folder)))
        .attr('stroke', (d) => folderColors.get(d.data.folder))
        .style('opacity', 0)
        .transition().delay((d, i) => 520 + (i % 50) * 6).duration(260)
        .style('opacity', 1);

    // Original subway layout stays intact. Overflow files appear in a card.
    const cardLayer = g.append('g').attr('class', 'sg-subway__card-layer');
    const moreGroups = g.append('g').selectAll('g.sg-subway__more').data(moreNodes).join('g')
        .attr('class', 'sg-subway__more')
        .attr('transform', (d) => `translate(${d.px},${d.py})`)
        .attr('role', 'button').attr('tabindex', 0)
        .attr('aria-label', (d) => `Show ${d.data.hidden.length} additional files in ${d.data.folder}`)
        .attr('aria-expanded', 'false').style('cursor', 'pointer');
    moreGroups.append('circle').attr('r', 7).attr('class', 'sg-subway__more-dot');
    moreGroups.append('text').attr('class', 'sg-subway__more-text')
        .attr('x', 11).attr('y', 3.5).text((d) => `+${d.data.hidden.length} more`);
    let activeMore = null;
    const closeCard = () => {
        activeMore = null;
        cardLayer.selectAll('*').remove();
        moreGroups.attr('aria-expanded', 'false');
    };
    const openCard = (event, d) => {
        event.stopPropagation();
        if (activeMore === d) { closeCard(); return; }
        closeCard();
        activeMore = d;
        // SVG paint order follows DOM order. Labels/stations were appended after
        // this layer, so always lift the popup layer above them when opening.
        cardLayer.raise();
        d3.select(event.currentTarget).attr('aria-expanded', 'true');
        const cardWidth = 430;
        const cardHeight = 460;
        const atX = Math.max(10, Math.min(d.px + 18, size.width - cardWidth - 10));
        const atY = Math.max(10, Math.min(d.py - 18, size.height - cardHeight - 10));
        const card = cardLayer.append('foreignObject')
            .attr('x', atX).attr('y', atY)
            .attr('width', cardWidth).attr('height', cardHeight)
            .attr('class', 'sg-subway__card-object');
        const wrapper = card.append('xhtml:div').attr('class', 'sg-subway__card')
            .on('pointerdown', (e) => e.stopPropagation())
            .on('click', (e) => e.stopPropagation())
            .on('dblclick', (e) => e.stopPropagation())
            .on('wheel', (e) => e.stopPropagation());
        const header = wrapper.append('xhtml:div').attr('class', 'sg-subway__card-header');
        const heading = header.append('xhtml:div');
        const folderPath = d.data.folder || '(root)';
        const hiddenFiles = d.data.hidden;
        heading.append('xhtml:strong').text(folderPath.endsWith('/') ? folderPath : `${folderPath}/`);
        heading.append('xhtml:span').text(`${hiddenFiles.length} additional files`);
        header.append('xhtml:button').attr('type', 'button')
            .attr('aria-label', 'Close folder card').text('×')
            .on('click', (e) => { e.stopPropagation(); closeCard(); });
        const searchBox = wrapper.append('xhtml:div').attr('class', 'sg-subway__card-search');
        searchBox.append('xhtml:span').attr('aria-hidden', 'true').text('⌕');
        const input = searchBox.append('xhtml:input')
            .attr('type', 'search').attr('placeholder', 'Search files...')
            .attr('aria-label', 'Search files in folder');
        const list = wrapper.append('xhtml:div').attr('class', 'sg-subway__card-list');
        const renderRows = (query = '') => {
            const filtered = hiddenFiles.filter((file) =>
                file.path.toLowerCase().includes(query.trim().toLowerCase()));
            const rows = list.selectAll('button.sg-subway__card-file')
                .data(filtered, (file) => file.path)
                .join('button').attr('type', 'button').attr('class', 'sg-subway__card-file')
                .attr('title', (file) => file.path)
                .on('click', (e, file) => {
                    e.stopPropagation();
                    onSelectNode?.(file.path);
                    closeCard();
                });
            rows.selectAll('*').remove();
            rows.append('xhtml:span').attr('class', 'sg-subway__card-file-oval')
                .attr('aria-hidden', 'true');
            const details = rows.append('xhtml:span').attr('class', 'sg-subway__card-file-info');
            details.append('xhtml:span').attr('class', 'sg-subway__card-file-name')
                .text((file) => sgBaseName(file.path));
            details.append('xhtml:span').attr('class', 'sg-subway__card-file-path')
                .text((file) => file.path.includes('/') ? `${file.path.slice(0, file.path.lastIndexOf('/') + 1)}` : '(root)/');
            list.selectAll('.sg-subway__card-empty').remove();
            if (!filtered.length) list.append('xhtml:div')
                .attr('class', 'sg-subway__card-empty').text('No matching files');
        };
        input.on('input', (event) => { renderRows(event.currentTarget.value); list.node().scrollTop = 0; });
        // Prevent wheel events from triggering D3's zoom while allowing native
        // browser/touchpad scrolling on the list (no preventDefault).
        list.on('wheel', (e) => e.stopPropagation());
        renderRows();

    };
    moreGroups.on('click', openCard).on('keydown', (event, d) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openCard(event, d);
        }
    });
    const onOutsidePointer = (event) => {
        if (!activeMore) return;
        if (event.target?.closest?.('.sg-subway__card, .sg-subway__more')) return;
        closeCard();
    };
    document.addEventListener('pointerdown', onOutsidePointer);
    g.selectAll('.sg-subway__stop').data(folderNodes.filter((d) => d.depth > 1)).join('circle')
        .attr('class', 'sg-subway__stop')
        .attr('cx', (d) => d.px).attr('cy', (d) => d.py).attr('r', 5)
        .attr('fill', (d) => folderColors.get(d.data.folder));

    const topFolderNodes = folderNodes.filter((d) => d.depth === 1);
    const branchLabelItems = topFolderNodes.map((d) => ({
        id: `__branch__${d.data.folder}`, label: d.data.folder, centered: true,
        x: d.px + (d.px - cx) * 0.14, y: d.py + (d.py - cy) * 0.14,
    }));
    const stopLabelItems = folderNodes.filter((d) => d.depth > 1).map((d, i) => ({
        id: `__stop${i}__`, label: d.data.name, x: d.px, y: d.py - 10, centered: true,
    }));
    const interchangeItems = fileNodes.filter((d) => d.data.interchange)
        .sort((a, b) => (degree.get(b.data.id) || 0) - (degree.get(a.data.id) || 0))
        .map((d) => ({ id: d.data.id, label: d.data.name, x: d.px, y: d.py }));
    const hubItem = { id: '__hub__', label: 'root', x: cx, y: cy - 16, centered: true };

    const shown = sgPickLabels(
        [...branchLabelItems, ...stopLabelItems, ...interchangeItems, hubItem],
        { charWidth: 5.6, height: 13 }
    );

    if (shown.has('__hub__')) {
        g.append('text').attr('class', 'sg-subway__hub-label').attr('x', cx).attr('y', cy - 16).attr('text-anchor', 'middle').text('root');
    }
    g.selectAll('.sg-subway__branch-label').data(branchLabelItems.filter((b) => shown.has(b.id))).join('text')
        .attr('class', 'sg-subway__branch-label')
        .attr('fill', (d) => folderColors.get(d.label))
        .attr('x', (d) => d.x).attr('y', (d) => d.y).attr('text-anchor', 'middle')
        .text((d) => d.label);
    g.selectAll('.sg-subway__stop-label').data(stopLabelItems.filter((s) => shown.has(s.id))).join('text')
        .attr('class', 'sg-subway__stop-label')
        .attr('x', (d) => d.x).attr('y', (d) => d.y).attr('text-anchor', 'middle')
        .text((d) => d.label);
    node.filter((d) => d.data.interchange && shown.has(d.data.id)).append('text')
        .attr('class', 'sg__label').attr('x', 11).attr('dy', 3).text((d) => d.data.name);
    cardLayer.raise(); // Keep popup above branch labels, stations and node labels.
    return () => document.removeEventListener('pointerdown', onOutsidePointer);
}
