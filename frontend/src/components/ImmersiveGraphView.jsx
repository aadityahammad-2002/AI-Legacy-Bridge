import { useEffect, useRef, useState, useMemo } from 'react';
import * as d3 from 'd3';
import {
    X, ZoomIn, ZoomOut, Maximize2, RotateCcw, MessageSquareCode,
    AlertTriangle, Link2, FileWarning, Ghost,
} from 'lucide-react';

import './ImmersiveGraphView.css';

/**
 * Full-takeover visualization for the two "storytelling" graph modes —
 * Subway Map and Galaxy Map. Selected from the same viz-type dropdown as
 * Graph/Treemap/Tree/etc. (see VisualizationExplorer.jsx), but unlike those
 * (which just swap the center canvas), these two replace the *entire*
 * content area below TopNavBar — their own left health/stats panel, own
 * center canvas, own right "Key Insights" panel — while TopNavBar itself
 * stays mounted so the rest of the app (AI Explorer / Tests / Migrate /
 * Exit Repository) is always one click away. `onExit` additionally flips
 * the secondary dropdown back to plain 'graph' as a same-page shortcut.
 *
 * Both modes are pure re-layouts of data the app already computed (files,
 * dependency edges, issues, health score) — no new analysis.
 */
const LINE_PALETTE = ['#60a5fa', '#facc15', '#a78bfa', '#4ade80', '#f472b6', '#fb923c', '#2dd4bf', '#f87171'];

function topFolder(path) {
    const i = path.indexOf('/');
    return i === -1 ? '(root)' : path.slice(0, i);
}
function folderOf(path) {
    const i = path.lastIndexOf('/');
    return i === -1 ? '(root)' : path.slice(0, i);
}
function baseName(path) {
    return path.split('/').pop();
}

/** Greedy label-declutter: keeps a label only if its approx bounding box doesn't
 * overlap one already placed (higher-priority items should come first in `items`).
 * Returns a Set of ids whose labels should render — the rest stay label-less
 * (node itself is still visible/clickable, it just doesn't fight for text space). */
function pickNonOverlappingLabels(items, opts = {}) {
    const { charWidth = 5.4, height = 13, anchorDx = 6, anchorDy = -4, pad = 3 } = opts;
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

/** Stable folder -> color assignment, shared by both layouts so switching modes doesn't reshuffle colors. */
function useFolderColors(files) {
    return useMemo(() => {
        const folders = [...new Set(files.map((f) => topFolder(f.path)))].sort();
        return new Map(folders.map((f, i) => [f, LINE_PALETTE[i % LINE_PALETTE.length]]));
    }, [files]);
}

/** Degree (in+out) per file path, from dependency edges — reused by both layouts to size/rank nodes. */
function useDegree(edges) {
    return useMemo(() => {
        const map = new Map();
        edges.forEach((e) => {
            map.set(e.source, (map.get(e.source) || 0) + 1);
            map.set(e.target, (map.get(e.target) || 0) + 1);
        });
        return map;
    }, [edges]);
}

/** First "Circular Dependencies" issue's file pairs, if any — both layouts draw these as a red loop. */
function useCircularPairs(issues) {
    return useMemo(() => {
        const issue = (issues || []).find((i) => i.title?.includes('Circular Dependenc'));
        if (!issue) return [];
        return issue.items.filter((it) => it.files?.length === 2).map((it) => it.files);
    }, [issues]);
}

export default function ImmersiveGraphView({
    mode, // 'subway' | 'galaxy'
    files, nodes, edges,
    healthScore, issues, languageStats, stats,
    selectedNodeId, onSelectNode, onOpenAiExplorerFocused,
    onExit,
}) {
    const containerRef = useRef(null);
    const svgRef = useRef(null);
    const zoomBehaviorRef = useRef(null);
    const [size, setSize] = useState({ width: 900, height: 600 });
    const [hoverNode, setHoverNode] = useState(null);

    const folderColors = useFolderColors(files);
    const degree = useDegree(edges);
    const circularPairs = useCircularPairs(issues);

    const unusedPaths = useMemo(() => {
        const issue = (issues || []).find((i) => i.title?.includes('Unused Function'));
        return new Set((issue?.items || []).map((it) => it.file).filter(Boolean));
    }, [issues]);

    const insights = useMemo(() => {
        const pick = (match, icon) => {
            const it = (issues || []).find((i) => i.title?.includes(match));
            return it ? { ...it, icon } : null;
        };
        return [
            pick('Circular Dependenc', AlertTriangle),
            pick('Highly Coupled', Link2),
            pick('Large Files', FileWarning),
            pick('Unused Function', Ghost),
        ].filter(Boolean).slice(0, 4);
    }, [issues]);

    // measure container
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

    // build + draw — rebuilds on data/mode/size change, never on hover/selection (see selection effect below)
    useEffect(() => {
        if (!svgRef.current || size.width < 10 || size.height < 10) return;
        const svgEl = d3.select(svgRef.current);
        svgEl.on('.zoom', null);
        svgEl.selectAll('*').remove();

        const defs = svgEl.append('defs');
        const glow = defs.append('filter').attr('id', 'igv-glow').attr('x', '-100%').attr('y', '-100%').attr('width', '300%').attr('height', '300%');
        glow.append('feGaussianBlur').attr('stdDeviation', 3.2).attr('result', 'blur');
        glow.append('feMerge').call((m) => { m.append('feMergeNode').attr('in', 'blur'); m.append('feMergeNode').attr('in', 'SourceGraphic'); });

        const zoomLayer = svgEl.append('g').attr('class', 'igv__zoom-layer');

        let galaxyHandles = null; // populated below for mode === 'galaxy'; drives the semantic-zoom "explode" effect
        const zoomBehavior = d3.zoom().scaleExtent([0.15, 6]).on('zoom', (e) => {
            zoomLayer.attr('transform', e.transform);
            if (!galaxyHandles) return;
            // Semantic zoom: past a scale threshold, nodes drift outward from their own
            // cluster center like planets spreading apart — a purely visual re-projection,
            // the underlying force-simulated positions never change. Zooming back out
            // relaxes the factor back to 1 and everything eases home.
            const k = e.transform.k;
            const expansion = k > 1.7 ? Math.min(2.6, 1 + (k - 1.7) * 1.1) : 1;
            const { node, link, clusterCenter } = galaxyHandles;
            node.style('transform', (d) => {
                const c = clusterCenter.get(d.folder);
                const ex = c.x + (d.x - c.x) * expansion;
                const ey = c.y + (d.y - c.y) * expansion;
                return `translate(${ex}px, ${ey}px)`;
            });
            link.style('opacity', expansion > 1.15 ? 0 : null);
        });
        svgEl.call(zoomBehavior);
        zoomBehaviorRef.current = zoomBehavior;

        if (mode === 'galaxy') {
            galaxyHandles = renderGalaxy(zoomLayer, files, nodes, edges, folderColors, degree, circularPairs, size, selectedNodeId, onSelectNode, setHoverNode);
        } else {
            renderSubway(zoomLayer, files, edges, folderColors, degree, circularPairs, unusedPaths, size, selectedNodeId, onSelectNode, setHoverNode);
        }

        // gentle auto-fit on first render of this mode/size
        svgEl.call(zoomBehavior.transform, d3.zoomIdentity.translate(size.width * 0.02, size.height * 0.02).scale(0.94));

        return () => svgEl.on('.zoom', null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, files, nodes, edges, size, folderColors, degree, circularPairs, unusedPaths]);

    // selection restyle only — avoids rebuilding (and re-fitting) the whole layout on every click
    useEffect(() => {
        if (!svgRef.current) return;
        const svgEl = d3.select(svgRef.current);
        svgEl.selectAll('.igv-node')
            .classed('igv-node--selected', (d) => d?.id === selectedNodeId);
    }, [selectedNodeId]);

    function zoomBy(factor) {
        const svgEl = d3.select(svgRef.current);
        zoomBehaviorRef.current && svgEl.transition().duration(200).call(zoomBehaviorRef.current.scaleBy, factor);
    }
    function fitView() {
        const svgEl = d3.select(svgRef.current);
        zoomBehaviorRef.current && svgEl.transition().duration(250).call(
            zoomBehaviorRef.current.transform,
            d3.zoomIdentity.translate(size.width * 0.02, size.height * 0.02).scale(0.94)
        );
    }

    const selectedFile = useMemo(() => files.find((f) => f.path === selectedNodeId) || null, [files, selectedNodeId]);

    function openInAiExplorer() {
        if (!selectedNodeId) return;
        const direct = edges.filter((e) => e.source === selectedNodeId || e.target === selectedNodeId)
            .map((e) => (e.source === selectedNodeId ? e.target : e.source));
        onOpenAiExplorerFocused?.({ selectedNode: selectedNodeId, directDependencies: direct });
    }

    return (
        <div className={`igv igv--${mode}`}>
            <aside className="igv__panel igv__panel--left">
                <HealthRing score={healthScore?.score ?? 0} grade={healthScore?.grade || '—'} />
                <div className="igv__stat-grid">
                    <div className="igv__stat"><span>{stats.files}</span><label>Files</label></div>
                    <div className="igv__stat"><span>{stats.methods}</span><label>Functions</label></div>
                    <div className="igv__stat"><span>{stats.links}</span><label>Links</label></div>
                    <div className="igv__stat"><span>{stats.unused}</span><label>Unused</label></div>
                </div>
                <div className="igv__legend">
                    <h4>{mode === 'galaxy' ? 'Folders / Languages' : 'Lines'}</h4>
                    {[...folderColors.entries()].map(([f, c]) => (
                        <div key={f} className="igv__legend-row">
                            <span className="igv__legend-dot" style={{ background: c }} />
                            {f}
                        </div>
                    ))}
                </div>
                {languageStats?.length > 0 && (
                    <div className="igv__loc">
                        <span className="igv__loc-value">{stats.loc.toLocaleString()}</span>
                        <span className="igv__loc-label">Lines of Code</span>
                    </div>
                )}
            </aside>

            <div className="igv__canvas-wrap" ref={containerRef}>
                <svg ref={svgRef} width={size.width} height={size.height} className="igv__svg" />

                <div className="igv__overlay igv__overlay--top-left">
                    <button className="igv__exit-btn" onClick={onExit} title="Back to Graph">
                        <X size={14} strokeWidth={2} /> Exit {mode === 'galaxy' ? 'Galaxy' : 'Subway'} View
                    </button>
                </div>

                <div className="igv__overlay igv__overlay--top-right">
                    <button title="Zoom out" onClick={() => zoomBy(0.7)}><ZoomOut size={14} strokeWidth={1.8} /></button>
                    <button title="Zoom in" onClick={() => zoomBy(1.4)}><ZoomIn size={14} strokeWidth={1.8} /></button>
                    <button title="Fit view" onClick={fitView}><Maximize2 size={14} strokeWidth={1.8} /></button>
                    <button title="Reset" onClick={fitView}><RotateCcw size={14} strokeWidth={1.8} /></button>
                </div>

                {hoverNode && (
                    <div className="igv__tooltip" style={{ left: hoverNode.x, top: hoverNode.y }}>
                        {hoverNode.label}
                    </div>
                )}

                {selectedFile && (
                    <div className="igv__selection-card">
                        <div className="igv__selection-name">{baseName(selectedFile.path)}</div>
                        <div className="igv__selection-path">{selectedFile.path}</div>
                        {onOpenAiExplorerFocused && (
                            <button className="igv__selection-btn" onClick={openInAiExplorer}>
                                <MessageSquareCode size={13} strokeWidth={1.8} /> Open in AI Explorer
                            </button>
                        )}
                    </div>
                )}
            </div>

            <aside className="igv__panel igv__panel--right">
                <h3>Key Insights</h3>
                {insights.length === 0 && <p className="igv__empty">No notable issues found.</p>}
                {insights.map((ins) => {
                    const Icon = ins.icon;
                    return (
                        <div key={ins.title} className={`igv__insight igv__insight--${ins.type}`}>
                            <Icon size={14} strokeWidth={1.8} />
                            <div>
                                <div className="igv__insight-title">{ins.title}</div>
                                <div className="igv__insight-desc">{ins.desc}</div>
                            </div>
                        </div>
                    );
                })}
            </aside>
        </div>
    );
}

function HealthRing({ score, grade }) {
    const radius = 30, size = 76, center = size / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (Math.max(0, Math.min(100, score)) / 100) * circumference;
    return (
        <div className="igv__health">
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <circle cx={center} cy={center} r={radius} className="igv__health-track" />
                <circle cx={center} cy={center} r={radius} className="igv__health-progress"
                    strokeDasharray={circumference} strokeDashoffset={offset}
                    transform={`rotate(-90 ${center} ${center})`} />
            </svg>
            <div className="igv__health-label"><span>{grade}</span></div>
            <div className="igv__health-meta">
                <strong>{score}/100</strong>
                <small>Codebase Health</small>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// GALAXY — folders as glowing nebula clusters of "star" nodes; cross-folder
// edges as faint long-range arcs; circular deps as a pulsing red binary pair.
// ---------------------------------------------------------------------------
function renderGalaxy(g, files, nodes, edges, folderColors, degree, circularPairs, size, selectedNodeId, onSelectNode, setHoverNode) {
    const folders = [...folderColors.keys()];
    const cx = size.width / 2, cy = size.height / 2;

    // Proportional layout — folders get angular slices sized by how many files they
    // hold (a folder with 80 files gets more room than one with 6), instead of a
    // fixed equal-slice pie. Nebula radius also scales with folder size (sqrt, so a
    // 4x bigger folder isn't literally 4x wider — that would overwhelm the canvas).
    const weightOf = (f) => files.filter((file) => topFolder(file.path) === f).length || 1;
    const weights = new Map(folders.map((f) => [f, weightOf(f)]));
    const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0) || 1;
    const baseR = Math.min(size.width, size.height) * 0.145;
    const nebulaRadius = new Map(folders.map((f) => [f, baseR * Math.sqrt(weights.get(f) / (totalWeight / folders.length))]));

    // ring distance needs to be big enough that the two largest neighbouring
    // nebulas don't overlap — approximate with the largest nebula radius plus margin
    const maxNebula = Math.max(...nebulaRadius.values());
    const ringR = Math.max(Math.min(size.width, size.height) * 0.28, maxNebula * 1.7);

    let cursor = -Math.PI / 2; // start slice allocation at 12 o'clock
    const clusterCenter = new Map();
    folders.forEach((f) => {
        const slice = (weights.get(f) / totalWeight) * 2 * Math.PI;
        const mid = cursor + slice / 2;
        clusterCenter.set(f, { x: cx + Math.cos(mid) * ringR, y: cy + Math.sin(mid) * ringR });
        cursor += slice;
    });

    // background stars — purely decorative, fixed count relative to canvas area
    const starCount = Math.round((size.width * size.height) / 7000);
    const bgStars = Array.from({ length: starCount }, () => ({
        x: Math.random() * size.width, y: Math.random() * size.height, r: Math.random() * 1.1 + 0.2,
    }));
    g.append('g').attr('class', 'igv-galaxy__bg').selectAll('circle').data(bgStars).join('circle')
        .attr('cx', (d) => d.x).attr('cy', (d) => d.y).attr('r', (d) => d.r)
        .attr('fill', '#fff').attr('opacity', () => Math.random() * 0.5 + 0.15);

    // nebula clouds — soft radial-gradient blobs behind each cluster, sized per folder weight
    const defs = g.node().ownerSVGElement ? d3.select(g.node().ownerSVGElement).select('defs') : null;
    folders.forEach((f) => {
        const color = folderColors.get(f);
        const gradId = `igv-nebula-${f.replace(/[^a-z0-9]/gi, '_')}`;
        if (defs) {
            const grad = defs.append('radialGradient').attr('id', gradId);
            grad.append('stop').attr('offset', '0%').attr('stop-color', color).attr('stop-opacity', 0.22);
            grad.append('stop').attr('offset', '60%').attr('stop-color', color).attr('stop-opacity', 0.08);
            grad.append('stop').attr('offset', '100%').attr('stop-color', color).attr('stop-opacity', 0);
        }
        const c = clusterCenter.get(f);
        g.append('circle').attr('class', 'igv-galaxy__nebula')
            .attr('cx', c.x).attr('cy', c.y).attr('r', nebulaRadius.get(f))
            .attr('fill', defs ? `url(#${gradId})` : color)
            .attr('opacity', defs ? 1 : 0.06);
    });

    const simNodes = nodes.map((n) => ({
        id: n.id, folder: topFolder(n.id), label: n.label || baseName(n.id),
        degree: degree.get(n.id) || 0,
    }));
    const idSet = new Set(simNodes.map((n) => n.id));
    const allLinks = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target);
    const intraLinks = allLinks.filter((e) => topFolder(e.source) === topFolder(e.target))
        .map((e) => ({ source: e.source, target: e.target, intra: true }));

    const link = g.append('g').attr('class', 'igv-galaxy__links').selectAll('line').data(intraLinks).join('line')
        .attr('class', 'igv-galaxy__link');

    // Cross-folder edges are the real "constellation lines between galaxies" in the
    // reference art. Drawing every single file-to-file cross edge fans into an
    // unreadable hairball, so instead we *bundle* them: one soft curved arc per
    // folder-pair (like real edge-bundling), thickness ~ how many edges it represents.
    const crossCounts = new Map(); // "folderA|folderB" -> count
    allLinks.forEach((e) => {
        const fa = topFolder(e.source), fb = topFolder(e.target);
        if (fa === fb) return;
        const key = [fa, fb].sort().join('|');
        crossCounts.set(key, (crossCounts.get(key) || 0) + 1);
    });
    const bundleLayer = g.append('g').attr('class', 'igv-galaxy__bundles');
    [...crossCounts.entries()].forEach(([key, count]) => {
        const [fa, fb] = key.split('|');
        const ca = clusterCenter.get(fa), cb = clusterCenter.get(fb);
        if (!ca || !cb) return;
        const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
        // pull the control point toward the canvas center so the arc bows inward
        // (matches the reference art's gentle curves) rather than a straight chord
        const cpx = mx + (cx - mx) * 0.35, cpy = my + (cy - my) * 0.35;
        bundleLayer.append('path')
            .attr('class', 'igv-galaxy__bundle')
            .attr('stroke-width', Math.min(3.5, 0.6 + Math.log2(count + 1) * 0.5))
            .attr('d', `M${ca.x},${ca.y} Q${cpx},${cpy} ${cb.x},${cb.y}`);
    });

    const node = g.append('g').attr('class', 'igv-galaxy__stars').selectAll('g').data(simNodes).join('g')
        .attr('class', 'igv-node')
        .style('cursor', 'pointer')
        .on('click', (_e, d) => onSelectNode?.(d.id))
        .on('mousemove', (e, d) => setHoverNode({ x: e.offsetX + 12, y: e.offsetY, label: d.label }))
        .on('mouseleave', () => setHoverNode(null));

    // soft halo behind each star for a glow that reads at a glance, not just a filter blur on the dot itself
    node.append('circle')
        .attr('class', 'igv-galaxy__halo')
        .attr('r', (d) => 6 + Math.min(14, Math.sqrt(d.degree) * 2.6))
        .attr('fill', (d) => folderColors.get(d.folder));

    node.append('circle')
        .attr('class', 'igv-galaxy__star')
        .attr('r', (d) => 2.2 + Math.min(6, Math.sqrt(d.degree)))
        .attr('fill', (d) => folderColors.get(d.folder))
        .attr('filter', 'url(#igv-glow)');

    // cluster labels drawn first so they win priority in the declutter pass
    const clusterLabelItems = folders.map((f) => ({
        id: `__cluster__${f}`, label: f, centered: true,
        x: clusterCenter.get(f).x, y: clusterCenter.get(f).y - nebulaRadius.get(f) - 6,
    }));
    const nodeLabelCandidates = [...simNodes].sort((a, b) => b.degree - a.degree).slice(0, 60);
    const shownLabels = pickNonOverlappingLabels(
        [...clusterLabelItems, ...nodeLabelCandidates],
        { charWidth: 5.6, height: 13 }
    );

    node.filter((d) => d.degree >= 3 && shownLabels.has(d.id)).append('text')
        .attr('class', 'igv__label').attr('x', 8).attr('dy', 3)
        .text((d) => d.label);

    g.append('g').attr('class', 'igv-galaxy__labels').selectAll('text').data(clusterLabelItems.filter((c) => shownLabels.has(c.id))).join('text')
        .attr('class', 'igv-galaxy__cluster-label')
        .attr('x', (d) => d.x).attr('y', (d) => d.y)
        .attr('text-anchor', 'middle')
        .attr('fill', (d) => folderColors.get(d.label))
        .text((d) => d.label);

    // circular-dependency pulse pair, placed between the two involved clusters (or near center if unknown)
    circularPairs.slice(0, 2).forEach(([a, b], i) => {
        const na = simNodes.find((n) => n.id === a), nb = simNodes.find((n) => n.id === b);
        const ca = na ? clusterCenter.get(na.folder) : { x: cx, y: cy };
        const cb = nb ? clusterCenter.get(nb.folder) : { x: cx, y: cy };
        const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2 + i * 34;
        const grp = g.append('g').attr('class', 'igv-galaxy__circular');
        grp.append('circle').attr('cx', mx - 10).attr('cy', my).attr('r', 4).attr('class', 'igv-galaxy__circular-dot');
        grp.append('circle').attr('cx', mx + 10).attr('cy', my).attr('r', 4).attr('class', 'igv-galaxy__circular-dot');
        grp.append('path')
            .attr('d', `M${mx - 10},${my} A14,10 0 1,1 ${mx + 10},${my} A14,10 0 1,1 ${mx - 10},${my}`)
            .attr('class', 'igv-galaxy__circular-loop');
        grp.append('text').attr('x', mx).attr('y', my - 20).attr('text-anchor', 'middle')
            .attr('class', 'igv-galaxy__circular-label')
            .text(`Circular: ${baseName(a)} \u2194 ${baseName(b)}`);
    });

    const sim = d3.forceSimulation(simNodes)
        .force('link', d3.forceLink(intraLinks).id((d) => d.id).distance(28).strength(0.5))
        .force('charge', d3.forceManyBody().strength(-16))
        .force('x', d3.forceX((d) => clusterCenter.get(d.folder).x).strength(0.14))
        .force('y', d3.forceY((d) => clusterCenter.get(d.folder).y).strength(0.14))
        .force('collide', d3.forceCollide(8))
        .stop();
    for (let i = 0; i < 180; i++) sim.tick();

    link
        .attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y)
        .style('opacity', 0)
        .transition().delay(300).duration(500).style('opacity', null);

    bundleLayer.selectAll('path').style('opacity', 0).transition().delay(500).duration(600).style('opacity', null);

    // base position uses a CSS-transitionable inline style (not the SVG `transform`
    // attribute) so the semantic-zoom "explode" effect in the parent's zoom handler
    // can retarget it smoothly frame-to-frame instead of snapping.
    node.style('transform', (d) => `translate(${d.x}px, ${d.y}px)`)
        .style('opacity', 0)
        .transition().delay((d, i) => Math.min(600, i * 3)).duration(420).ease(d3.easeCubicOut)
        .style('opacity', 1);

    return { node, link, clusterCenter };
}

// ---------------------------------------------------------------------------
// SUBWAY — a proper radial tree (d3.hierarchy + d3.tree), not hand-placed
// angles: each top-level folder's branch gets angular width proportional to
// how many files it contains, so layout stays balanced whether the repo has
// 3 folders or 10, and no two branches can mathematically cross. Overflowing
// folders (many files) collapse into a "+N more" stub instead of spamming
// unlabeled dots. Visual language matches the reference: thick colored line
// per top folder, thin twigs to file stations, white-ring "interchange"
// stations for highly-coupled files, bold colored branch labels, dark hub.
// ---------------------------------------------------------------------------
function renderSubway(g, files, edges, folderColors, degree, circularPairs, unusedPaths, size, selectedNodeId, onSelectNode, setHoverNode) {
    const folders = [...folderColors.keys()];
    const cx = size.width / 2, cy = size.height / 2;
    const outerR = Math.min(size.width, size.height) * 0.44;
    const maxFilesPerStop = 9;

    const crossFolderPaths = new Set();
    edges.forEach((e) => { if (topFolder(e.source) !== topFolder(e.target)) { crossFolderPaths.add(e.source); crossFolderPaths.add(e.target); } });
    const isInterchange = (path) => crossFolderPaths.has(path) || (degree.get(path) || 0) >= 6;

    // --- build a bounded-depth hierarchy: root -> topFolder -> subFolder? -> files/"+N more" ---
    const root = { name: '(root)', type: 'root', children: [] };
    folders.forEach((folder) => {
        const flist = files.filter((f) => topFolder(f.path) === folder && !unusedPaths.has(f.path));
        const level1 = new Map(); // stopName -> [file...]
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
                    name: baseName(f.path), type: 'file', id: f.path, folder,
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

    // --- radial tree layout: angle allocated proportional to leaf count automatically ---
    const hierarchyRoot = d3.hierarchy(root, (d) => d.children);
    const maxDepth = hierarchyRoot.height || 1;
    d3.tree().size([2 * Math.PI, outerR]).separation((a, b) => (a.parent === b.parent ? 1 : 1.6) / Math.max(1, a.depth))(hierarchyRoot);

    hierarchyRoot.each((d) => {
        const angle = d.x - Math.PI / 2;
        // push file/more leaves a bit further than their folder radius alone would give
        // them, so twigs are legible instead of stacked right on the branch line
        const r = d.data.type === 'file' || d.data.type === 'more' ? d.y + 14 : d.y;
        d.px = cx + Math.cos(angle) * r;
        d.py = cy + Math.sin(angle) * r;
    });

    const stationById = new Map();
    hierarchyRoot.each((d) => { if (d.data.type === 'file') stationById.set(d.data.id, d); });

    g.append('circle').attr('class', 'igv-subway__hub').attr('cx', cx).attr('cy', cy).attr('r', 9);

    const links = hierarchyRoot.links();
    links.forEach((link, i) => {
        const isTwig = link.target.data.type === 'file' || link.target.data.type === 'more';
        const cls = isTwig ? 'igv-subway__twig' : 'igv-subway__line';
        const path = g.append('path').attr('class', cls)
            .attr('stroke', folderColors.get(link.target.data.folder))
            .attr('d', elbowPath({ x: link.source.px, y: link.source.py }, { x: link.target.px, y: link.target.py }));
        drawIn(path, isTwig ? 480 + (i % 50) * 6 : i * 50, isTwig ? 260 : 460);
    });

    // circular-dependency loop — offset well clear of the stations themselves so it
    // never visually sits on top of another node (the earlier version's bug)
    circularPairs.slice(0, 3).forEach(([a, b]) => {
        const sa = stationById.get(a), sb = stationById.get(b);
        if (!sa || !sb) return;
        const dx = sb.px - sa.px, dy = sb.py - sa.py;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const bow = 44;
        const mx = (sa.px + sb.px) / 2 + nx * bow, my = (sa.py + sb.py) / 2 + ny * bow;
        g.append('path').attr('class', 'igv-subway__circular-loop')
            .attr('d', `M${sa.px},${sa.py} Q${mx},${my} ${sb.px},${sb.py}`);
    });

    const unusedList = files.filter((f) => unusedPaths.has(f.path)).slice(0, 10);
    if (unusedList.length) {
        const ux0 = 24, uy0 = size.height - 24 - unusedList.length * 16;
        g.append('text').attr('class', 'igv-subway__unused-title').attr('x', ux0).attr('y', uy0 - 10).text('Unused Files');
        unusedList.forEach((f, i) => {
            const yy = uy0 + i * 16;
            g.append('circle').attr('class', 'igv-subway__unused-dot').attr('cx', ux0).attr('cy', yy).attr('r', 3);
            g.append('text').attr('class', 'igv-subway__unused-label').attr('x', ux0 + 10).attr('y', yy + 3).text(baseName(f.path));
        });
    }

    const fileNodes = hierarchyRoot.descendants().filter((d) => d.data.type === 'file');
    const moreNodes = hierarchyRoot.descendants().filter((d) => d.data.type === 'more');
    const folderNodes = hierarchyRoot.descendants().filter((d) => d.data.type === 'folder');

    // stations (files) — drawn after lines so they sit on top
    const node = g.append('g').selectAll('g').data(fileNodes).join('g')
        .attr('class', 'igv-node')
        .attr('transform', (d) => `translate(${d.px},${d.py})`)
        .style('cursor', 'pointer')
        .on('click', (_e, d) => onSelectNode?.(d.data.id))
        .on('mousemove', (e, d) => setHoverNode({ x: e.offsetX + 12, y: e.offsetY, label: d.data.name }))
        .on('mouseleave', () => setHoverNode(null));

    node.append('circle')
        .attr('class', (d) => `igv-subway__station${d.data.interchange ? ' igv-subway__station--interchange' : ''}`)
        .attr('r', (d) => (d.data.interchange ? 7 : 3.2))
        .attr('fill', (d) => (d.data.interchange ? 'var(--lb-bg)' : folderColors.get(d.data.folder)))
        .attr('stroke', (d) => folderColors.get(d.data.folder))
        .style('opacity', 0)
        .transition().delay((d, i) => 520 + (i % 50) * 6).duration(260)
        .style('opacity', 1);

    // "+N more" stubs — small dim marker, not clickable
    g.append('g').selectAll('circle').data(moreNodes).join('circle')
        .attr('class', 'igv-subway__unused-dot')
        .attr('cx', (d) => d.px).attr('cy', (d) => d.py).attr('r', 2.4);

    // folder / sub-folder "stop" hubs
    g.selectAll('.igv-subway__stop').data(folderNodes.filter((d) => d.depth > 1)).join('circle')
        .attr('class', 'igv-subway__stop')
        .attr('cx', (d) => d.px).attr('cy', (d) => d.py).attr('r', 5)
        .attr('fill', (d) => folderColors.get(d.data.folder));

    // one combined declutter pass across every label in the scene, highest-priority first:
    // top-level branch names > sub-folder stops > interchange stations > "+N more" > hub.
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

    const shown = pickNonOverlappingLabels(
        [...branchLabelItems, ...stopLabelItems, ...interchangeItems, ...moreLabelItems, hubItem],
        { charWidth: 5.6, height: 13 }
    );

    if (shown.has('__hub__')) {
        g.append('text').attr('class', 'igv-subway__hub-label').attr('x', cx).attr('y', cy - 16).attr('text-anchor', 'middle').text('root');
    }
    g.selectAll('.igv-subway__branch-label').data(branchLabelItems.filter((b) => shown.has(b.id))).join('text')
        .attr('class', 'igv-subway__branch-label')
        .attr('fill', (d) => folderColors.get(d.label))
        .attr('x', (d) => d.x).attr('y', (d) => d.y).attr('text-anchor', 'middle')
        .text((d) => d.label);
    g.selectAll('.igv-subway__stop-label').data(stopLabelItems.filter((s) => shown.has(s.id))).join('text')
        .attr('class', 'igv-subway__stop-label')
        .attr('x', (d) => d.x).attr('y', (d) => d.y).attr('text-anchor', 'middle')
        .text((d) => d.label);
    g.selectAll('.igv-subway__more-label').data(moreLabelItems.filter((m) => shown.has(m.id))).join('text')
        .attr('class', 'igv-subway__unused-label')
        .attr('x', (d) => d.x + 7).attr('y', (d) => d.y + 3)
        .text((d) => d.label);
    node.filter((d) => d.data.interchange && shown.has(d.data.id)).append('text')
        .attr('class', 'igv__label').attr('x', 11).attr('dy', 3).text((d) => d.data.name);
}


/** Right-angle "elbow" between two points, with each corner cut at 45° (chamfered)
 * for the classic metro-map look — real subway diagrams rarely use sharp square
 * turns, they cut corners diagonally. */
function chamferPath(points, r = 12) {
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

function elbowPath(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 1 || Math.abs(dy) < 1) return `M${a.x},${a.y} L${b.x},${b.y}`;
    const points = Math.abs(dx) > Math.abs(dy)
        ? [a, { x: a.x + dx * 0.6, y: a.y }, { x: a.x + dx * 0.6, y: b.y }, b]
        : [a, { x: a.x, y: a.y + dy * 0.6 }, { x: b.x, y: a.y + dy * 0.6 }, b];
    return chamferPath(points, 12);
}

/** Animates a just-appended path "drawing itself in" — classic stroke-dasharray trick. */
function drawIn(pathSelection, delay = 0, duration = 520) {
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
