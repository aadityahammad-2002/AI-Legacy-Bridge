import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import * as d3 from 'd3';

import './AltVisualizations.css';

/**
 * Alternate visualization modes — Treemap / Tree / Cluster / Matrix / Bundle / Flow.
 * Companion to GraphCanvas.jsx (which stays the force-directed 'graph' mode).
 * Not built as a single generic component because each layout needs a
 * genuinely different D3 module — trying to unify them behind one
 * abstraction would hide more than it'd share. `vizType` selects which one
 * renders.
 *
 * Tree/Cluster are two genuinely different layouts (matching CodeFlow's own
 * naming, not just visual variants of each other): Tree is a flat
 * root -> folder -> file dendrogram (d3.cluster on a 2-level hierarchy).
 * Cluster is a disjoint force simulation — one grid cell per folder, nodes
 * pulled toward their folder's cell center but still repelling/connecting
 * within it. Treemap is also folder-hierarchy based. Matrix/Bundle/Flow are
 * dependency-edge layouts (built from `nodes`/`edges`).
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
    const [size, setSize] = useState({ width: 900, height: 600 });

    // Read via ref inside the structural effect below so a selection change
    // (clicking a node) never re-runs the effect that (re)builds the SVG and
    // attaches d3.zoom() — doing that mid-drag was stacking a second zoom/pan
    // listener on top of the first every click, and if a gesture was in
    // flight when the DOM got wiped out from under it, it threw with no
    // error boundary anywhere in the app to catch it — blanking the whole page.
    const selectedNodeIdRef = useRef(selectedNodeId);
    useEffect(() => { selectedNodeIdRef.current = selectedNodeId; }, [selectedNodeId]);

    useImperativeHandle(ref, () => ({
        getSvgElement: () => svgRef.current,
    }), []);

    useEffect(() => {
        if (!containerRef.current) return;
        const el = containerRef.current;
        const measure = () => setSize({ width: el.clientWidth || 900, height: el.clientHeight || 600 });
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        if (!svgRef.current || size.width < 10 || size.height < 10) return;
        const svgEl = d3.select(svgRef.current);
        svgEl.on('.zoom', null); // remove any previously-attached zoom/drag listeners before rebuilding — see selectedNodeIdRef comment above
        svgEl.selectAll('*').remove();
        svgEl.attr('height', size.height); // reset — Tree no longer grows the SVG itself, pan/zoom handles overflow

        const defs = svgEl.append('defs');
        const glow = defs.append('filter').attr('id', 'sg-glow').attr('x', '-100%').attr('y', '-100%').attr('width', '300%').attr('height', '300%');
        glow.append('feGaussianBlur').attr('stdDeviation', 3.2).attr('result', 'blur');
        glow.append('feMerge').call((m) => { m.append('feMergeNode').attr('in', 'blur'); m.append('feMergeNode').attr('in', 'SourceGraphic'); });

        // Shared pan/zoom for every mode — a single zoomed <g> layer that each
        // render*() function draws into instead of the raw <svg>, so none of
        // them need their own zoom logic.
        const zoomLayer = svgEl.append('g').attr('class', 'alt-viz__zoom-layer');
        let galaxyHandles = null; // populated by renderGalaxy; drives the semantic-zoom "explode" effect below
        const zoomBehavior = d3.zoom()
            .scaleExtent([0.1, 6])
            .on('zoom', (event) => {
                zoomLayer.attr('transform', event.transform);
                if (!galaxyHandles) return;
                // Semantic zoom: past a scale threshold, stars drift outward from their
                // own cluster center like planets spreading apart. Purely a visual
                // re-projection — the underlying simulated positions never change, and
                // zooming back out eases everything home.
                const k = event.transform.k;
                const expansion = k > 1.7 ? Math.min(2.6, 1 + (k - 1.7) * 1.1) : 1;
                const { starNode, clusterCenter } = galaxyHandles;
                starNode.style('transform', (d) => {
                    const c = clusterCenter.get(d.folder);
                    const ex = c.x + (d.x - c.x) * expansion;
                    const ey = c.y + (d.y - c.y) * expansion;
                    return `translate(${ex}px, ${ey}px)`;
                });
            });
        svgEl.call(zoomBehavior);

        const sel = selectedNodeIdRef.current;
        if (vizType === 'treemap') renderTreemap(zoomLayer, files, size, sel, onSelectNode);
        else if (vizType === 'tree') renderTree(zoomLayer, files, size, sel, onSelectNode);
        else if (vizType === 'cluster') renderCluster(zoomLayer, files, edges, size, sel, onSelectNode);
        else if (vizType === 'matrix') renderMatrix(zoomLayer, nodes, edges, size, sel, onSelectNode);
        else if (vizType === 'bundle') renderBundle(zoomLayer, nodes, edges, size, sel, onSelectNode);
        else if (vizType === 'flow') renderFlow(zoomLayer, files, edges, size);
        else if (vizType === 'subway') renderSubway(zoomLayer, files, edges, issues, size, sel, onSelectNode);
        else if (vizType === 'galaxy') { galaxyHandles = renderGalaxy(zoomLayer, defs, files, nodes, edges, issues, size, sel, onSelectNode); }

        // gentle initial fit for the two new radial/proportional layouts, which read
        // best a touch zoomed out compared to the other modes' default 1:1 view
        if (vizType === 'subway' || vizType === 'galaxy') {
            svgEl.call(zoomBehavior.transform, d3.zoomIdentity.translate(size.width * 0.02, size.height * 0.02).scale(0.94));
        }

        return () => svgEl.on('.zoom', null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vizType, files, nodes, edges, issues, size]); // selectedNodeId intentionally excluded — see selectedNodeIdRef above

        useEffect(() => {
        if (!svgRef.current) return;
        const svgEl = d3.select(svgRef.current);

        if (vizType === 'treemap') {
            svgEl.selectAll('rect.alt-viz__treemap-rect')
                .attr('opacity', (d) => (d.data.path === selectedNodeId ? 1 : 0.72))
                .attr('stroke', (d) => (d.data.path === selectedNodeId ? '#fff' : 'rgba(0,0,0,0.35)'))
                .attr('stroke-width', (d) => (d.data.path === selectedNodeId ? 2 : 1));
        } else if (vizType === 'tree') {
            svgEl.selectAll('circle.alt-viz__tree-circle')
                .attr('r', (d) => (d.data.path === selectedNodeId ? 6 : d.children ? 5 : 4))
                .attr('stroke', (d) => (d.data.path === selectedNodeId ? '#fff' : 'none'));
        } else if (vizType === 'cluster') {
    svgEl.selectAll('circle.alt-viz__cluster-circle')
        .attr('stroke', (d) => (d.id === selectedNodeId ? '#fff' : 'var(--lb-bg)'));
    svgEl.selectAll('line.alt-viz__cluster-link')
        .attr('stroke', (d) => (d.source.id === selectedNodeId || d.target.id === selectedNodeId ? '#fff' : 'var(--lb-accent)'))
        .attr('stroke-opacity', (d) => (d.source.id === selectedNodeId || d.target.id === selectedNodeId ? 0.9 : 0.25))
        .attr('stroke-width', (d) => (d.source.id === selectedNodeId || d.target.id === selectedNodeId ? 2 : 1));
} else if (vizType === 'matrix') {
            svgEl.selectAll('rect.alt-viz__matrix-cell')
                .attr('fill', (d) => (d.source === selectedNodeId || d.target === selectedNodeId ? '#fff' : 'var(--lb-accent)'));
        } else if (vizType === 'bundle') {
            svgEl.selectAll('path.alt-viz__bundle-link')
                .attr('opacity', (d) => (d.source === selectedNodeId || d.target === selectedNodeId ? 0.9 : 0.25))
                .attr('stroke', (d) => (d.source === selectedNodeId || d.target === selectedNodeId ? '#fff' : 'var(--lb-accent)'));
            svgEl.selectAll('circle.alt-viz__bundle-circle')
                .attr('r', (d) => (d.data.path === selectedNodeId ? 4.5 : 3));
        } else if (vizType === 'subway' || vizType === 'galaxy') {
            svgEl.selectAll('.sg-node').classed('sg-node--selected', (d) => (d?.data ? d.data.id : d?.id) === selectedNodeId);
        }
    }, [vizType, selectedNodeId]);
    return (
        <div className="alt-viz" ref={containerRef}>
            <svg ref={svgRef} width={size.width} height={size.height} className="alt-viz__svg" />
        </div>
    );
});

export default AltVisualizations;

function renderTreemap(g, files, size, selectedNodeId, onSelectNode) {
    const root = buildFileHierarchy(files);
    d3.treemap().size([size.width, size.height]).paddingInner(2).paddingOuter(3).round(true)(root);

    const leaves = root.leaves();
    const cell = g.selectAll('g').data(leaves).join('g')
        .attr('transform', (d) => `translate(${d.x0},${d.y0})`)
        .attr('class', 'alt-viz__cell')
        .style('cursor', 'pointer')
        .on('click', (_e, d) => onSelectNode?.(d.data.path));

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
        .text((d) => ((d.x1 - d.x0 > 40 && d.y1 - d.y0 > 18) ? d.data.name : ''));

        
}

/**
 * Tree — flat root -> folder -> file dendrogram (files don't nest further
 * within their folder), matching CodeFlow's actual "Tree" mode: every leaf
 * lands at the same depth, so labels line up cleanly in a right-hand column
 * instead of drifting to different depths like a real nested-path tree.
 */
function renderTree(g, files, size, selectedNodeId, onSelectNode) {
    const hier = { name: 'root', children: [] };
    const folderMap = new Map();
    files.forEach((f) => {
        const folder = folderOf(f.path);
        if (!folderMap.has(folder)) {
            const node = { name: folder.split('/').pop() || 'root', children: [] };
            folderMap.set(folder, node);
            hier.children.push(node);
        }
        folderMap.get(folder).children.push({ name: f.path.split('/').pop(), path: f.path, leaf: true });
    });

    const root = d3.hierarchy(hier);
    const margin = { top: 10, right: 160, bottom: 10, left: 90 };
    const leafCount = root.leaves().length;
    const layoutHeight = Math.max(size.height - margin.top - margin.bottom, leafCount * 16);
    d3.cluster().size([layoutHeight, size.width - margin.left - margin.right])(root);

    const gg = g.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    gg.selectAll('path.alt-viz__link').data(root.links()).join('path')
        .attr('class', 'alt-viz__link')
        .attr('d', (d) => {
            const my = (d.source.y + d.target.y) / 2;
            return `M${d.source.y},${d.source.x}C${my},${d.source.x} ${my},${d.target.x} ${d.target.y},${d.target.x}`;
        });

    const node = gg.selectAll('g.alt-viz__node').data(root.descendants()).join('g')
        .attr('class', 'alt-viz__node')
        .attr('transform', (d) => `translate(${d.y},${d.x})`)
        .style('cursor', (d) => (d.data.leaf ? 'pointer' : 'default'))
        .on('click', (_e, d) => d.data.leaf && onSelectNode?.(d.data.path));

    node.append('circle')
        .attr('class', 'alt-viz__tree-circle')
        .attr('r', (d) => (d.data.path === selectedNodeId ? 6 : d.children ? 5 : 4))
        .attr('fill', (d) => (d.data.leaf ? hashColor(folderOf(d.data.path)) : 'var(--lb-text-faint)'))
        .attr('stroke', (d) => (d.data.path === selectedNodeId ? '#fff' : 'none'))
        .attr('stroke-width', 2);

    node.filter((d) => d.data.leaf).append('text')
        .attr('x', 10).attr('dy', 3).attr('class', 'alt-viz__label').text((d) => d.data.name);

    node.filter((d) => !d.data.leaf && d.depth > 0).append('text')
        .attr('x', -10).attr('dy', 3).attr('text-anchor', 'end')
        .attr('class', 'alt-viz__label').style('font-weight', 700).text((d) => d.data.name);
}

/**
 * Cluster — disjoint force-directed layout: one grid cell per folder, nodes
 * pulled toward their folder's cell center (forceX/forceY) while still
 * repelling each other and linking on real dependency edges — matches
 * CodeFlow's actual "Cluster" mode, a completely different layout from Tree
 * despite the similar-sounding name.
 */
const CLUSTER_MAX_NODES = 100;

function renderCluster(g, files, edges, size, selectedNodeId, onSelectNode) {
    const shown = files.slice(0, CLUSTER_MAX_NODES);
    const folders = [...new Set(shown.map((f) => folderOf(f.path)))];
    const cols = Math.ceil(Math.sqrt(folders.length));
    const cellW = size.width / cols;
    const cellH = size.height / Math.ceil(folders.length / cols);
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

    const link = g.selectAll('line.alt-viz__cluster-link').data(simLinks).join('line').attr('class', 'alt-viz__cluster-link');
    const node = g.selectAll('g.alt-viz__node').data(simNodes).join('g')
        .attr('class', 'alt-viz__node')
        .style('cursor', 'pointer')
        .on('click', (_e, d) => onSelectNode?.(d.id));

    node.append('circle').attr('class', 'alt-viz__cluster-circle').attr('r', 5).attr('fill', (d) => hashColor(d.folder))
        .attr('stroke', (d) => (d.id === selectedNodeId ? '#fff' : 'var(--lb-bg)')).attr('stroke-width', 2);

    const sim = d3.forceSimulation(simNodes)
        .force('link', d3.forceLink(simLinks).id((d) => d.id).distance(30).strength(0.3))
        .force('charge', d3.forceManyBody().strength(-60))
        .force('x', d3.forceX((d) => d.cx).strength(0.15))
        .force('y', d3.forceY((d) => d.cy).strength(0.15))
        .force('collide', d3.forceCollide(12))
        .on('tick', () => {
            link.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y).attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
            node.attr('transform', (d) => `translate(${d.x},${d.y})`);
        });

    node.call(d3.drag()
        .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
}

const MATRIX_MAX_NODES = 60; // beyond this the grid becomes unreadable/too slow — see GraphCanvas's own MAX_RENDERED_NODES note

function renderMatrix(g, nodes, edges, size, selectedNodeId, onSelectNode) {
    // Show the most-connected files first — a dependency matrix is only useful
    // when you can actually see individual cells.
    const degree = new Map(nodes.map((n) => [n.id, 0]));
    edges.forEach((e) => {
        degree.set(e.source, (degree.get(e.source) || 0) + 1);
        degree.set(e.target, (degree.get(e.target) || 0) + 1);
    });
    const shown = [...nodes].sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0)).slice(0, MATRIX_MAX_NODES);
    const idOf = new Map(shown.map((n, i) => [n.id, i]));

    const margin = { top: 120, right: 10, bottom: 10, left: 120 };
    const n = shown.length;
    const cellSize = Math.max(6, Math.min(24, (Math.min(size.width - margin.left, size.height - margin.top)) / Math.max(1, n)));

    const gg = g.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    gg.selectAll('text.alt-viz__row-label').data(shown).join('text')
        .attr('class', 'alt-viz__label alt-viz__row-label')
        .attr('x', -4).attr('y', (_d, i) => i * cellSize + cellSize * 0.7)
        .attr('text-anchor', 'end')
        .text((d) => d.label || d.id.split('/').pop());

    gg.selectAll('text.alt-viz__col-label').data(shown).join('text')
        .attr('class', 'alt-viz__label alt-viz__col-label')
        .attr('transform', (_d, i) => `translate(${i * cellSize + cellSize * 0.7},-4) rotate(-60)`)
        .attr('text-anchor', 'start')
        .text((d) => d.label || d.id.split('/').pop());

    const cellPairs = [];
    edges.forEach((e) => {
        const si = idOf.get(e.source), ti = idOf.get(e.target);
        if (si == null || ti == null) return;
        cellPairs.push({ row: si, col: ti, source: e.source, target: e.target });
    });

    gg.selectAll('rect.alt-viz__bg').data(d3.cross(d3.range(n), d3.range(n))).join('rect')
        .attr('class', 'alt-viz__matrix-bg')
        .attr('x', (d) => d[1] * cellSize).attr('y', (d) => d[0] * cellSize)
        .attr('width', cellSize - 1).attr('height', cellSize - 1);

    gg.selectAll('rect.alt-viz__cell').data(cellPairs).join('rect')
        .attr('class', 'alt-viz__matrix-cell')
        .attr('x', (d) => d.col * cellSize).attr('y', (d) => d.row * cellSize)
        .attr('width', cellSize - 1).attr('height', cellSize - 1)
        .attr('fill', (d) => (d.source === selectedNodeId || d.target === selectedNodeId ? '#fff' : 'var(--lb-accent)'))
        .style('cursor', 'pointer')
        .on('click', (_e, d) => onSelectNode?.(d.source))
        .append('title').text((d) => `${d.source} → ${d.target}`);
}

/**
 * Flow diagram — Sankey-style bands showing how many dependencies cross
 * between architectural layers (f.layer, already computed by the analysis
 * engine — see orchestrator.js). Hand-rolled rather than the `d3-sankey`
 * package (not part of the bundled `d3` module already in package.json).
 */
function renderFlow(g, files, edges, size) {
    const layerOf = new Map(files.map((f) => [f.path, f.layer || 'other']));
    const layers = [...new Set(files.map((f) => f.layer || 'other'))].sort();
    if (layers.length === 0) return;

    const flowCounts = new Map(); // "from|to" -> count
    edges.forEach((e) => {
        const from = layerOf.get(e.source), to = layerOf.get(e.target);
        if (!from || !to || from === to) return;
        const key = `${from}|${to}`;
        flowCounts.set(key, (flowCounts.get(key) || 0) + 1);
    });

    const margin = { top: 30, right: 160, bottom: 30, left: 160 };
    const bandHeight = (size.height - margin.top - margin.bottom) / layers.length;
    const yOf = new Map(layers.map((l, i) => [l, margin.top + i * bandHeight + bandHeight / 2]));
    const nodeX = { left: margin.left, right: size.width - margin.right };
    const nodeW = 14;

    const gg = g.append('g');
    const maxCount = Math.max(1, ...[...flowCounts.values()]);
    const widthScale = d3.scaleLinear().domain([0, maxCount]).range([1.5, 22]);

    layers.forEach((l) => {
        const y = yOf.get(l);
        [nodeX.left, nodeX.right].forEach((x) => {
            gg.append('rect')
                .attr('x', x).attr('y', y - bandHeight * 0.3)
                .attr('width', nodeW).attr('height', bandHeight * 0.6)
                .attr('fill', hashColor(l)).attr('rx', 3);
        });
        gg.append('text').attr('x', nodeX.left - 8).attr('y', y).attr('dy', 4)
            .attr('text-anchor', 'end').attr('class', 'alt-viz__label').text(l);
        gg.append('text').attr('x', nodeX.right + nodeW + 8).attr('y', y).attr('dy', 4)
            .attr('text-anchor', 'start').attr('class', 'alt-viz__label').text(l);
    });

    const linkGen = d3.linkHorizontal();
    [...flowCounts.entries()].forEach(([key, count]) => {
        const [from, to] = key.split('|');
        const y0 = yOf.get(from), y1 = yOf.get(to);
        const w = widthScale(count);
        gg.append('path')
            .attr('class', 'alt-viz__flow-link')
            .attr('d', linkGen({ source: [nodeX.left + nodeW, y0], target: [nodeX.right, y1] }))
            .attr('fill', 'none')
            .attr('stroke', hashColor(from))
            .attr('stroke-width', w)
            .attr('opacity', 0.45)
            .append('title').text(`${from} → ${to}: ${count} dependencies`);
    });
}

function renderBundle(g, nodes, edges, size, selectedNodeId, onSelectNode) {
    const root = { name: 'root', children: [] };
    const dirIndex = new Map([['', root]]);
    nodes.forEach((n) => {
        const parts = n.id.split('/');
        let currentPath = '';
        let parent = root;
        for (let i = 0; i < parts.length - 1; i++) {
            currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
            let dir = dirIndex.get(currentPath);
            if (!dir) { dir = { name: parts[i], path: currentPath, children: [] }; dirIndex.set(currentPath, dir); parent.children.push(dir); }
            parent = dir;
        }
        parent.children.push({ name: parts[parts.length - 1], path: n.id, leaf: true });
    });

    const hRoot = d3.hierarchy(root);
    const leafByPath = new Map(hRoot.leaves().map((l) => [l.data.path, l]));

    const radius = Math.min(size.width, size.height) / 2 - 80;
    const cluster = d3.cluster().size([2 * Math.PI, radius]);
    cluster(hRoot);

    const gg = g.append('g').attr('transform', `translate(${size.width / 2},${size.height / 2})`);

    const line = d3.lineRadial().curve(d3.curveBundle.beta(0.85)).radius((d) => d.y).angle((d) => d.x);

    const bundleLinks = edges
        .map((e) => {
            const s = leafByPath.get(e.source), t = leafByPath.get(e.target);
            if (!s || !t) return null;
            return { source: e.source, target: e.target, path: s.path(t) };
        })
        .filter(Boolean);

    gg.selectAll('path.alt-viz__bundle-link').data(bundleLinks).join('path')
        .attr('class', 'alt-viz__bundle-link')
        .attr('d', (d) => line(d.path))
        .attr('opacity', (d) => (d.source === selectedNodeId || d.target === selectedNodeId ? 0.9 : 0.25))
        .attr('stroke', (d) => (d.source === selectedNodeId || d.target === selectedNodeId ? '#fff' : 'var(--lb-accent)'));

    const node = gg.selectAll('g.alt-viz__bundle-node').data(hRoot.leaves()).join('g')
        .attr('transform', (d) => `rotate(${(d.x * 180) / Math.PI - 90}) translate(${d.y},0)`)
        .style('cursor', 'pointer')
        .on('click', (_e, d) => onSelectNode?.(d.data.path));

    node.append('circle')
        .attr('class', 'alt-viz__bundle-circle')
        .attr('r', (d) => (d.data.path === selectedNodeId ? 4.5 : 3))
        .attr('fill', (d) => hashColor(folderOf(d.data.path || '')));

    node.append('text')
        .attr('dy', '0.31em')
        .attr('x', (d) => (d.x < Math.PI ? 6 : -6))
        .attr('text-anchor', (d) => (d.x < Math.PI ? 'start' : 'end'))
        .attr('transform', (d) => (d.x >= Math.PI ? 'rotate(180)' : null))
        .attr('class', 'alt-viz__label')
        .text((d) => d.data.name);
}
// ===========================================================================
// SUBWAY MAP / GALAXY MAP — two more `vizType` options alongside everything
// above. Same shared zoomLayer/pan-zoom, same left Explorer / right Issues
// panels in VisualizationExplorer, same onSelectNode wiring — they're just
// two more layouts, not a special mode.
// ===========================================================================

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
    return issue.items.filter((it) => it.files?.length === 2).map((it) => it.files);
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

// ---------------------------------------------------------------------------
// GALAXY — folders as glowing nebula clusters of "star" files; cluster size
// and angular slice are proportional to how many files that folder holds
// (not an equal pie split). Cross-folder edges are bundled into one soft
// curved arc per folder-pair instead of a per-file hairball. Circular
// dependencies pulse as a red binary pair.
// ---------------------------------------------------------------------------
function renderGalaxy(g, defs, files, nodes, edges, issues, size, selectedNodeId, onSelectNode) {
    const folderColors = sgFolderColors(files);
    const degree = sgDegree(edges);
    const circularPairs = sgCircularPairs(issues);
    const folders = [...folderColors.keys()];
    const cx = size.width / 2, cy = size.height / 2;

    const weightOf = (f) => files.filter((file) => sgTopFolder(file.path) === f).length || 1;
    const weights = new Map(folders.map((f) => [f, weightOf(f)]));
    const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0) || 1;
    const baseR = Math.min(size.width, size.height) * 0.145;
    const nebulaRadius = new Map(folders.map((f) => [f, baseR * Math.sqrt(weights.get(f) / (totalWeight / folders.length))]));
    const maxNebula = Math.max(...nebulaRadius.values());
    const ringR = Math.max(Math.min(size.width, size.height) * 0.28, maxNebula * 1.7);

    let cursor = -Math.PI / 2;
    const clusterCenter = new Map();
    folders.forEach((f) => {
        const slice = (weights.get(f) / totalWeight) * 2 * Math.PI;
        const mid = cursor + slice / 2;
        clusterCenter.set(f, { x: cx + Math.cos(mid) * ringR, y: cy + Math.sin(mid) * ringR });
        cursor += slice;
    });

    const starCount = Math.round((size.width * size.height) / 7000);
    const bgStars = Array.from({ length: starCount }, () => ({
        x: Math.random() * size.width, y: Math.random() * size.height, r: Math.random() * 1.1 + 0.2,
    }));
    g.append('g').selectAll('circle').data(bgStars).join('circle')
        .attr('cx', (d) => d.x).attr('cy', (d) => d.y).attr('r', (d) => d.r)
        .attr('fill', '#fff').attr('opacity', () => Math.random() * 0.5 + 0.15);

    folders.forEach((f) => {
        const color = folderColors.get(f);
        const gradId = `sg-nebula-${f.replace(/[^a-z0-9]/gi, '_')}`;
        const grad = defs.append('radialGradient').attr('id', gradId);
        grad.append('stop').attr('offset', '0%').attr('stop-color', color).attr('stop-opacity', 0.22);
        grad.append('stop').attr('offset', '60%').attr('stop-color', color).attr('stop-opacity', 0.08);
        grad.append('stop').attr('offset', '100%').attr('stop-color', color).attr('stop-opacity', 0);
        const c = clusterCenter.get(f);
        g.append('circle').attr('class', 'sg-galaxy__nebula')
            .attr('cx', c.x).attr('cy', c.y).attr('r', nebulaRadius.get(f))
            .attr('fill', `url(#${gradId})`);
    });

    const simNodes = nodes.map((n) => ({
        id: n.id, folder: sgTopFolder(n.id), label: n.label || sgBaseName(n.id),
        degree: degree.get(n.id) || 0,
    }));
    const idSet = new Set(simNodes.map((n) => n.id));
    const allLinks = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target);
    const intraLinks = allLinks.filter((e) => sgTopFolder(e.source) === sgTopFolder(e.target))
        .map((e) => ({ source: e.source, target: e.target }));

    const link = g.append('g').selectAll('line').data(intraLinks).join('line').attr('class', 'sg-galaxy__link');

    const crossCounts = new Map();
    allLinks.forEach((e) => {
        const fa = sgTopFolder(e.source), fb = sgTopFolder(e.target);
        if (fa === fb) return;
        const key = [fa, fb].sort().join('|');
        crossCounts.set(key, (crossCounts.get(key) || 0) + 1);
    });
    const bundleLayer = g.append('g');
    [...crossCounts.entries()].forEach(([key, count]) => {
        const [fa, fb] = key.split('|');
        const ca = clusterCenter.get(fa), cb = clusterCenter.get(fb);
        if (!ca || !cb) return;
        const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
        const cpx = mx + (cx - mx) * 0.35, cpy = my + (cy - my) * 0.35;
        bundleLayer.append('path').attr('class', 'sg-galaxy__bundle')
            .attr('stroke-width', Math.min(3.5, 0.6 + Math.log2(count + 1) * 0.5))
            .attr('d', `M${ca.x},${ca.y} Q${cpx},${cpy} ${cb.x},${cb.y}`);
    });

    const starNode = g.append('g').attr('class', 'sg-galaxy__stars').selectAll('g').data(simNodes).join('g')
        .attr('class', 'sg-node')
        .on('click', (_e, d) => onSelectNode?.(d.id));

    starNode.append('title').text((d) => d.label);

    starNode.append('circle')
        .attr('class', 'sg-galaxy__halo')
        .attr('r', (d) => 6 + Math.min(14, Math.sqrt(d.degree) * 2.6))
        .attr('fill', (d) => folderColors.get(d.folder));

    starNode.append('circle')
        .attr('class', 'sg-galaxy__star')
        .attr('r', (d) => 2.2 + Math.min(6, Math.sqrt(d.degree)))
        .attr('fill', (d) => folderColors.get(d.folder))
        .attr('filter', 'url(#sg-glow)');

    const clusterLabelItems = folders.map((f) => ({
        id: `__cluster__${f}`, label: f, centered: true,
        x: clusterCenter.get(f).x, y: clusterCenter.get(f).y - nebulaRadius.get(f) - 6,
    }));
    const nodeLabelCandidates = [...simNodes].sort((a, b) => b.degree - a.degree).slice(0, 60);
    const shownLabels = sgPickLabels([...clusterLabelItems, ...nodeLabelCandidates], { charWidth: 5.6, height: 13 });

    starNode.filter((d) => d.degree >= 3 && shownLabels.has(d.id)).append('text')
        .attr('class', 'sg__label').attr('x', 8).attr('dy', 3).text((d) => d.label);

    g.append('g').selectAll('text').data(clusterLabelItems.filter((c) => shownLabels.has(c.id))).join('text')
        .attr('class', 'sg-galaxy__cluster-label')
        .attr('x', (d) => d.x).attr('y', (d) => d.y).attr('text-anchor', 'middle')
        .attr('fill', (d) => folderColors.get(d.label))
        .text((d) => d.label);

    circularPairs.slice(0, 2).forEach(([a, b], i) => {
        const na = simNodes.find((n) => n.id === a), nb = simNodes.find((n) => n.id === b);
        const ca = na ? clusterCenter.get(na.folder) : { x: cx, y: cy };
        const cb = nb ? clusterCenter.get(nb.folder) : { x: cx, y: cy };
        const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2 + i * 34;
        const grp = g.append('g');
        grp.append('circle').attr('cx', mx - 10).attr('cy', my).attr('r', 4).attr('class', 'sg-galaxy__circular-dot');
        grp.append('circle').attr('cx', mx + 10).attr('cy', my).attr('r', 4).attr('class', 'sg-galaxy__circular-dot');
        grp.append('path')
            .attr('d', `M${mx - 10},${my} A14,10 0 1,1 ${mx + 10},${my} A14,10 0 1,1 ${mx - 10},${my}`)
            .attr('class', 'sg-galaxy__circular-loop');
        grp.append('text').attr('x', mx).attr('y', my - 20).attr('text-anchor', 'middle')
            .attr('class', 'sg-galaxy__circular-label')
            .text(`Circular: ${sgBaseName(a)} \u2194 ${sgBaseName(b)}`);
    });

    const sim = d3.forceSimulation(simNodes)
        .force('link', d3.forceLink(intraLinks).id((d) => d.id).distance(28).strength(0.5))
        .force('charge', d3.forceManyBody().strength(-16))
        .force('x', d3.forceX((d) => clusterCenter.get(d.folder).x).strength(0.14))
        .force('y', d3.forceY((d) => clusterCenter.get(d.folder).y).strength(0.14))
        .force('collide', d3.forceCollide(8))
        .stop();
    for (let i = 0; i < 180; i++) sim.tick();

    link.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y)
        .style('opacity', 0).transition().delay(300).duration(500).style('opacity', null);

    bundleLayer.selectAll('path').style('opacity', 0).transition().delay(500).duration(600).style('opacity', null);

    starNode.style('transform', (d) => `translate(${d.x}px, ${d.y}px)`)
        .style('opacity', 0)
        .transition().delay((d, i) => Math.min(600, i * 3)).duration(420).ease(d3.easeCubicOut)
        .style('opacity', 1);

    return { starNode, clusterCenter };
}

// ---------------------------------------------------------------------------
// SUBWAY — a proper radial tree (d3.hierarchy + d3.tree): each top-level
// folder's branch gets angular width proportional to how many files it
// contains, so the layout stays balanced whether the repo has 3 folders or
// 10, and no two branches can mathematically cross. Overflowing folders
// collapse into a "+N more" stub instead of spamming unlabeled dots.
// ---------------------------------------------------------------------------
function renderSubway(g, files, edges, issues, size, selectedNodeId, onSelectNode) {
    const folderColors = sgFolderColors(files);
    const degree = sgDegree(edges);
    const circularPairs = sgCircularPairs(issues);
    const unusedPaths = sgUnusedPaths(issues);
    const folders = [...folderColors.keys()];
    const cx = size.width / 2, cy = size.height / 2;
    const outerR = Math.min(size.width, size.height) * 0.44;
    const maxFilesPerStop = 9;

    const crossFolderPaths = new Set();
    edges.forEach((e) => { if (sgTopFolder(e.source) !== sgTopFolder(e.target)) { crossFolderPaths.add(e.source); crossFolderPaths.add(e.target); } });
    const isInterchange = (path) => crossFolderPaths.has(path) || (degree.get(path) || 0) >= 6;

    const root = { name: '(root)', type: 'root', children: [] };
    folders.forEach((folder) => {
        const flist = files.filter((f) => sgTopFolder(f.path) === folder && !unusedPaths.has(f.path));
        const level1 = new Map();
        flist.forEach((f) => {
            const rest = f.path.slice(folder.length + 1);
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
                const shown = prioritized.slice(0, maxFilesPerStop);
                shown.forEach((f) => bucket.push({
                    name: sgBaseName(f.path), type: 'file', id: f.path, folder,
                    interchange: isInterchange(f.path),
                }));
                const rest = prioritized.length - shown.length;
                if (rest > 0) bucket.push({ name: `+${rest} more`, type: 'more', folder });
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
        g.append('text').attr('class', 'sg-subway__unused-title').attr('x', ux0).attr('y', uy0 - 10).text('Unused Files');
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
        .attr('transform', (d) => `translate(${d.px},${d.py})`)
        .on('click', (_e, d) => onSelectNode?.(d.data.id));

    node.append('title').text((d) => d.data.name);

    node.append('circle')
        .attr('class', (d) => `sg-subway__station${d.data.interchange ? ' sg-subway__station--interchange' : ''}`)
        .attr('r', (d) => (d.data.interchange ? 7 : 3.2))
        .attr('fill', (d) => (d.data.interchange ? 'var(--lb-bg)' : folderColors.get(d.data.folder)))
        .attr('stroke', (d) => folderColors.get(d.data.folder))
        .style('opacity', 0)
        .transition().delay((d, i) => 520 + (i % 50) * 6).duration(260)
        .style('opacity', 1);

    g.append('g').selectAll('circle').data(moreNodes).join('circle')
        .attr('class', 'sg-subway__unused-dot')
        .attr('cx', (d) => d.px).attr('cy', (d) => d.py).attr('r', 2.4);

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
    const moreLabelItems = moreNodes.map((d, i) => ({
        id: `__more${i}__`, label: d.data.name, x: d.px, y: d.py - 8, centered: true, anchorDx: 6, anchorDy: 0,
    }));
    const interchangeItems = fileNodes.filter((d) => d.data.interchange)
        .sort((a, b) => (degree.get(b.data.id) || 0) - (degree.get(a.data.id) || 0))
        .map((d) => ({ id: d.data.id, label: d.data.name, x: d.px, y: d.py }));
    const hubItem = { id: '__hub__', label: 'root', x: cx, y: cy - 16, centered: true };

    const shown = sgPickLabels(
        [...branchLabelItems, ...stopLabelItems, ...interchangeItems, ...moreLabelItems, hubItem],
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
    g.selectAll('.sg-subway__more-label').data(moreLabelItems.filter((m) => shown.has(m.id))).join('text')
        .attr('class', 'sg-subway__unused-label')
        .attr('x', (d) => d.x + 7).attr('y', (d) => d.y + 3)
        .text((d) => d.label);
    node.filter((d) => d.data.interchange && shown.has(d.data.id)).append('text')
        .attr('class', 'sg__label').attr('x', 11).attr('dy', 3).text((d) => d.data.name);
}
