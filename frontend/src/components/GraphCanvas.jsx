import { useEffect, useRef, useState, useMemo, forwardRef, useImperativeHandle, useCallback } from 'react';
import * as d3 from 'd3';

import './GraphCanvas.css';

const DEFAULT_WIDTH = 900;  // only used as containerSize's initial value before the first real measurement
const DEFAULT_HEIGHT = 640;
const MAX_RENDERED_NODES = 400; // beyond this, force layout gets slow/unreadable — see README note
const PALETTE_SIZE = 8; // matches the 8 `.graph-canvas__node--group-N` colors defined in GraphCanvas.css
const HULL_PALETTE = ['#8b5cf6', '#60a5fa', '#2dd4bf', '#4ade80', '#fb923c', '#f472b6', '#facc15', '#f87171'];
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 5;

/** Cheap, stable string hash — used only to pick a display color group, never for identity/logic. */
function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h << 5) - h + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}

/** Parent folder of a file path — "" for root-level files (no hull drawn for those). */
function folderOf(path) {
    const i = path.lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i);
}

/**
 * SVG path `d` string for a smooth "blob" boundary around a folder's node
 * positions — a single point becomes a circle, two points a capsule, three+
 * points a padded convex hull smoothed with Catmull-Rom curves.
 */
function buildHullPath(points, padding = 30) {
    if (!points || points.length === 0) return null;
    if (points.length === 1) {
        const [x, y] = points[0];
        return `M ${x - padding} ${y} A ${padding} ${padding} 0 1 0 ${x + padding} ${y} A ${padding} ${padding} 0 1 0 ${x - padding} ${y} Z`;
    }
    let hullPoints;
    if (points.length === 2) {
        const [[x1, y1], [x2, y2]] = points;
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * padding, ny = (dx / len) * padding;
        hullPoints = [
            [x1 + nx, y1 + ny], [x2 + nx, y2 + ny],
            [x2 - nx, y2 - ny], [x1 - nx, y1 - ny],
        ];
    } else {
        const hull = d3.polygonHull(points);
        if (!hull) return null;
        const centroid = d3.polygonCentroid(hull);
        hullPoints = hull.map(([x, y]) => {
            const dx = x - centroid[0], dy = y - centroid[1];
            const dist = Math.hypot(dx, dy) || 1;
            return [x + (dx / dist) * padding, y + (dy / dist) * padding];
        });
    }
    const line = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5));
    return line(hullPoints);
}

/**
 * Layout algorithms — each returns a Map<nodeId, {x,y}> in world space.
 * `spacingSpread`/`spacingLinks` are the Settings gear's 0..1 sliders; each
 * layout interprets them in whatever way makes sense for its geometry.
 */
function layoutForce(nodes, edges, width, height, spread = 0.5, linksParam = 0.5) {
    const simNodes = nodes.map((n) => ({ ...n }));
    const simLinks = edges.map((e) => ({ source: e.source, target: e.target }));
    const chargeStrength = -60 - spread * 320; // 0 -> tight (-60), 1 -> loose (-380)
    const linkDistance = 30 + linksParam * 120; // 0 -> tight (30), 1 -> loose (150)
    const collideR = 14 + spread * 20;

    const simulation = d3
        .forceSimulation(simNodes)
        .force('link', d3.forceLink(simLinks).id((d) => d.id).distance(linkDistance).strength(0.5))
        .force('charge', d3.forceManyBody().strength(chargeStrength))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collide', d3.forceCollide(collideR))
        // See the coordinate-model note on the component below for why this weak
        // per-node centering force exists — without it, disconnected/isolated
        // nodes drift arbitrarily far and blow up fitView()'s bounding box.
        .force('x', d3.forceX(width / 2).strength(0.05))
        .force('y', d3.forceY(height / 2).strength(0.05))
        .stop();

    const iterations = Math.min(400, Math.max(120, simNodes.length * 3));
    for (let i = 0; i < iterations; i++) simulation.tick();
    return new Map(simNodes.map((n) => [n.id, { x: n.x, y: n.y }]));
}

/** Concentric rings by BFS distance from the most-connected node; disconnected nodes land in one outer ring. */
function layoutRadial(nodes, edges, width, height, spread = 0.5) {
    const adjacency = new Map();
    nodes.forEach((n) => adjacency.set(n.id, new Set()));
    edges.forEach((e) => {
        adjacency.get(e.source)?.add(e.target);
        adjacency.get(e.target)?.add(e.source);
    });

    let center = nodes[0]?.id;
    let maxDeg = -1;
    nodes.forEach((n) => {
        const deg = adjacency.get(n.id)?.size || 0;
        if (deg > maxDeg) { maxDeg = deg; center = n.id; }
    });

    const depth = new Map(center != null ? [[center, 0]] : []);
    const queue = center != null ? [center] : [];
    while (queue.length) {
        const cur = queue.shift();
        const d = depth.get(cur);
        (adjacency.get(cur) || new Set()).forEach((nb) => {
            if (!depth.has(nb)) { depth.set(nb, d + 1); queue.push(nb); }
        });
    }
    const maxDepth = Math.max(0, ...[...depth.values()]);
    const unreachedDepth = maxDepth + 2;
    nodes.forEach((n) => { if (!depth.has(n.id)) depth.set(n.id, unreachedDepth); });

    const byDepth = new Map();
    nodes.forEach((n) => {
        const d = depth.get(n.id);
        if (!byDepth.has(d)) byDepth.set(d, []);
        byDepth.get(d).push(n.id);
    });

    const cx = width / 2, cy = height / 2;
    // Minimum arc-length between neighboring nodes on a ring, and minimum
    // gap between successive rings — both scale with the Spread slider.
    // Unlike the old version, radius is no longer capped by the viewport:
    // rings with many nodes push outward as far as they need to avoid
    // overlap, and fitView() zooms out to frame whatever that produces.
    const minArcSpacing = 70 + spread * 60;
    const baseRingGap = 90 + spread * 80;

    const positions = new Map();
    let prevRadius = 0;
    const depths = [...byDepth.keys()].sort((a, b) => a - b);
    depths.forEach((d) => {
        const ids = byDepth.get(d);
        let r;
        if (d === 0) {
            r = 0;
        } else {
            const requiredByCount = (ids.length * minArcSpacing) / (2 * Math.PI);
            r = Math.max(prevRadius + baseRingGap, requiredByCount);
        }
        prevRadius = r;
        ids.forEach((id, i) => {
            const angle = (2 * Math.PI * i) / Math.max(1, ids.length);
            positions.set(id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
        });
    });
    return positions;
}

/** Horizontal bands, one per distinct `colorKeyFn` value (folder/layer/language — whatever Color By is active). */
function layoutLayers(nodes, colorKeyFn, width, height, spread = 0.5) {
    const keyOf = (n) => (colorKeyFn ? colorKeyFn(n) : (n.id.includes('/') ? n.id.split('/')[0] : n.id));
    const byKey = new Map();
    nodes.forEach((n) => {
        const k = keyOf(n);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(n.id);
    });
    const keys = [...byKey.keys()].sort();
    const rowHeight = 60 + spread * 40;
    const bandHeight = Math.max(height / Math.max(1, keys.length), rowHeight);
    const minCellWidth = 90 + spread * 70; // room for a label, scales with Spread slider
    const jitter = 10 + spread * 20;
    const positions = new Map();
    keys.forEach((k, rowIdx) => {
        const ids = byKey.get(k);
        const cellWidth = Math.max(width / Math.max(1, ids.length + 1), minCellWidth);
        ids.forEach((id, i) => {
            positions.set(id, {
                x: cellWidth * (i + 1),
                y: bandHeight * (rowIdx + 0.5) + ((hashString(id) % 100) / 100 - 0.5) * jitter,
            });
        });
    });
    return positions;
}

/** Plain sorted grid — simplest, most predictable layout, useful for large/noisy repos. */
function layoutGrid(nodes, width, height, spread = 0.5) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    const rows = Math.max(1, Math.ceil(nodes.length / cols));
    const cellSize = 90 + spread * 70; // minimum room per node, scales with Spread slider
    const cellW = Math.max(width / (cols + 1), cellSize);
    const cellH = Math.max(height / (rows + 1), cellSize * 0.6);
    const positions = new Map();
    const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
    sorted.forEach((n, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        positions.set(n.id, { x: cellW * (col + 1), y: cellH * (row + 1) });
    });
    return positions;
}

/** "Metro map" display toggle — snaps whatever layout produced onto a grid for a blocky, orthogonal look. */
function snapToGrid(positions, cell = 40) {
    const snapped = new Map();
    positions.forEach((p, id) => snapped.set(id, { x: Math.round(p.x / cell) * cell, y: Math.round(p.y / cell) * cell }));
    return snapped;
}

/**
 * CodeFlow-style graph canvas — infinite pan/zoom, node dragging, hover
 * highlight/fade, double-click focus. Exposes fitView() /
 * centerGraph() / resetView() / zoomIn() / zoomOut() via ref so a parent
 * toolbar (see VisualizationExplorer) can drive them.
 *
 * Coordinate model — matches CodeFlow's own approach exactly (see its
 * `svgRef.current.clientWidth/clientHeight`-based layout): node `positions`
 * (from d3-force, or dragged by the user) live directly in the container's
 * real on-screen pixel size (tracked via ResizeObserver, see `containerSize`),
 * not a fixed abstract box. The <svg> itself is given explicit `width`/
 * `height` attributes equal to that same size — no `viewBox` — so there is
 * no separate "world -> screen" scale factor for anything to get out of sync
 * with. A single `transform` (d3.zoomIdentity-shaped {x,y,k}) then maps that
 * space to what's visible via `translate(x,y) scale(k)` on the root <g>. An
 * earlier version used a fixed 900x640 "world" space reconciled with the
 * real size via `viewBox` — that indirection was the root cause of the
 * "graph renders off-screen for some repos" bug; removing it entirely
 * (rather than patching the reconciliation) is what actually fixed it.
 *
 * Pan (background click-drag) and wheel/trackpad-pinch zoom are implemented
 * with plain pointer/wheel event handlers rather than d3-zoom's own built-in
 * drag/wheel handling — see the comment above `panRef` below for why.
 */
const GraphCanvas = forwardRef(function GraphCanvas(
    {
        nodes, edges, selectedNodeId, onSelectNode, onNodeDoubleClick, showLabels = true, colorKeyFn, severityFn,
        layoutMode = 'force', metroSnap = false, curvedLinks = false, spacingSpread = 0.5, spacingLinks = 0.5,
    },
    ref
) {
    const svgRef = useRef(null);
    const gRef = useRef(null); // the panned/zoomed content <g> — d3 sets its transform directly (see below)
    const transformRef = useRef(d3.zoomIdentity); // always-current transform, read imperatively (no stale closures)
    const positionsRef = useRef(new Map()); // id -> {x, y} — mutable, source of truth during drag
    const [, forceRerender] = useState(0);
    const [hoveredNodeId, setHoveredNodeId] = useState(null);
const [layoutVersion, setLayoutVersion] = useState(0);
const layoutReady = layoutVersion > 0;    const [containerSize, setContainerSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
    const containerSizeRef = useRef(containerSize); // mirrored so the layout effect can read current size without re-running on every resize tick
    containerSizeRef.current = containerSize;
    const draggingRef = useRef(false);
    const manualViewRef = useRef(false);

    const truncated = nodes.length > MAX_RENDERED_NODES;
    const renderedNodes = useMemo(
        () => (truncated ? nodes.slice(0, MAX_RENDERED_NODES) : nodes),
        [nodes, truncated]
    );
    const renderedNodeIds = useMemo(() => new Set(renderedNodes.map((n) => n.id)), [renderedNodes]);
    const renderedEdges = useMemo(
        () => edges.filter((e) => renderedNodeIds.has(e.source) && renderedNodeIds.has(e.target)),
        [edges, renderedNodeIds]
    );

    /** Cosmetic grouping for node color — by folder (default) or by whatever `colorKeyFn` returns (e.g. language). */
    const groupOf = useMemo(() => {
        const map = new Map();
        renderedNodes.forEach((n) => {
            const key = colorKeyFn ? colorKeyFn(n) : (n.id.includes('/') ? n.id.split('/')[0] : n.id);
            map.set(n.id, hashString(key) % PALETTE_SIZE);
        });
        return map;
    }, [renderedNodes, colorKeyFn]);

        /** Folder -> node-id list, used only to draw the folder "hull" blobs in Force mode. */
    const folderGroups = useMemo(() => {
        const map = new Map();
        renderedNodes.forEach((n) => {
            const key = folderOf(n.id);
            if (!key) return; // root-level files get no hull
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(n.id);
        });
        return map;
    }, [renderedNodes]);

    /** Adjacency, for hover highlight/fade — which nodes are directly connected to a given one. */
    const adjacency = useMemo(() => {
        const map = new Map();
        renderedNodes.forEach((n) => map.set(n.id, new Set()));
        renderedEdges.forEach((e) => {
            map.get(e.source)?.add(e.target);
            map.get(e.target)?.add(e.source);
        });
        return map;
    }, [renderedNodes, renderedEdges]);

    // --- Initial layout: branches by `layoutMode`. Force uses d3-force (unchanged
    //     behavior, now with spacing sliders wired in); Radial/Layers/Grid are
    //     deterministic geometric placements — see the helpers below the component.
    //     `metroSnap`, applied last regardless of mode, rounds every position to the
    //     nearest grid cell for a blocky "metro map" look. ---
    useEffect(() => {
    manualViewRef.current = false;
    if (renderedNodes.length === 0) {
        positionsRef.current = new Map();
        setLayoutVersion((v) => v + 1);
        return;
    }

    const { width, height } = containerSizeRef.current;

    let positions;
if (layoutMode === 'radial') {
    positions = layoutRadial(renderedNodes, renderedEdges, width, height, spacingSpread);
} else if (layoutMode === 'layers') {
    positions = layoutLayers(renderedNodes, colorKeyFn, width, height, spacingSpread);
} else if (layoutMode === 'grid') {
    positions = layoutGrid(renderedNodes, width, height, spacingSpread);
} else {
    positions = layoutForce(renderedNodes, renderedEdges, width, height, spacingSpread, spacingLinks);
}

    if (metroSnap) positions = snapToGrid(positions);

    positionsRef.current = positions;
    setLayoutVersion((v) => v + 1);
}, [renderedNodes, renderedEdges, layoutMode, metroSnap, colorKeyFn, spacingSpread, spacingLinks]);

    /** Bounding box of current node positions, in screen-pixel space. */
    const computeBBox = useCallback(() => {
        const pts = [...positionsRef.current.values()];
        if (pts.length === 0) {
            const { width, height } = containerSizeRef.current;
            return { minX: 0, minY: 0, maxX: width, maxY: height };
        }
        return {
            minX: Math.min(...pts.map((p) => p.x)),
            maxX: Math.max(...pts.map((p) => p.x)),
            minY: Math.min(...pts.map((p) => p.y)),
            maxY: Math.max(...pts.map((p) => p.y)),
        };
    }, []);

    /** Directly applies a transform to the DOM + our own tracked state — see the
     *  background-pan/wheel-zoom handlers below for why this no longer routes through
     *  d3-zoom's own dispatch mechanism at all (not even for internal state sync —
     *  d3.zoom() isn't attached to anything anymore). */
    const setTransformNow = useCallback((next) => {
        transformRef.current = next;
        if (gRef.current) {
            gRef.current.setAttribute('transform', `translate(${next.x}, ${next.y}) scale(${next.k})`);
        }
    }, []);

    const applyTransform = useCallback((next, animate = true) => {
        if (!animate) {
            setTransformNow(next);
            return;
        }
        // Animated path: interpolate x/y/k by hand with d3.interpolateZoom over a short
        // window using requestAnimationFrame directly (falling back to setTimeout —
        // same strategy d3-timer itself uses — so this still animates smoothly in every
        // real browser without depending on d3-zoom's own transition/dispatch plumbing
        // for the actual per-frame DOM update).
        const start = transformRef.current;
        const startTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const duration = 350;
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
        function tick(now) {
            const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
            const t = Math.min(1, elapsed / duration);
            // Ease-out cubic — matches the feel of d3's default transition easing closely enough.
            const eased = 1 - Math.pow(1 - t, 3);
            const k = start.k + (next.k - start.k) * eased;
            const x = start.x + (next.x - start.x) * eased;
            const y = start.y + (next.y - start.y) * eased;
            setTransformNow(d3.zoomIdentity.translate(x, y).scale(k));
            if (t < 1) raf(tick);
        }
        raf(tick);
    }, [setTransformNow]);

    const fitView = useCallback((animate = true) => {
        const { minX, maxX, minY, maxY } = computeBBox();
        const bboxW = Math.max(1, maxX - minX);
        const bboxH = Math.max(1, maxY - minY);
        const padding = 0.78; // leave ~22% breathing room — node labels extend past their
        // circle, so a smaller margin (previously 0.85) let labels near the bbox edge get
        // clipped by the canvas boundary even though the nodes themselves were in view.
        const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(containerSize.width / bboxW, containerSize.height / bboxH) * padding));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const next = d3.zoomIdentity
            .translate(containerSize.width / 2, containerSize.height / 2)
            .scale(scale)
            .translate(-cx, -cy);
        applyTransform(next, animate);
    }, [computeBBox, applyTransform, containerSize]);

    const centerGraph = useCallback((animate = true) => {
        const { minX, maxX, minY, maxY } = computeBBox();
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const k = transformRef.current.k || 1;
        const next = d3.zoomIdentity.translate(containerSize.width / 2, containerSize.height / 2).scale(k).translate(-cx, -cy);
        applyTransform(next, animate);
    }, [computeBBox, applyTransform, containerSize]);

    const resetView = useCallback(() => {
        applyTransform(d3.zoomIdentity, true);
    }, [applyTransform]);

    const zoomBy = useCallback((factor) => {
        // Zooms toward the current viewport center, keeping whatever world-point is
        // there fixed, then hands the result to the same `.transform`-based
        // applyTransform/setTransformNow every other transform change in this
        // component goes through — one single, simple, well-tested code path.
        const current = transformRef.current;
        const newK = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.k * factor));
        const { width, height } = containerSizeRef.current;
        const cx = width / 2, cy = height / 2;
        const worldX = (cx - current.x) / current.k;
        const worldY = (cy - current.y) / current.k;
        const next = d3.zoomIdentity.translate(cx, cy).scale(newK).translate(-worldX, -worldY);
        applyTransform(next, false); // instant — no transition/RAF timing to depend on
    }, [applyTransform]);

    const focusNode = useCallback((nodeId, animate = true) => {
        const pos = positionsRef.current.get(nodeId);
        if (!pos) return;
        const k = Math.max(transformRef.current.k || 1, 1.4);
        const next = d3.zoomIdentity.translate(containerSize.width / 2, containerSize.height / 2).scale(k).translate(-pos.x, -pos.y);
        applyTransform(next, animate);
    }, [applyTransform, containerSize]);

    useImperativeHandle(ref, () => ({
        fitView: () => fitView(true),
        centerGraph: () => centerGraph(true),
        resetView,
        zoomIn: () => zoomBy(1.4),
        zoomOut: () => zoomBy(1 / 1.4),
        focusNode,
        getSvgElement: () => svgRef.current, // used by ExportModal for SVG/PDF export
    }), [fitView, centerGraph, resetView, zoomBy, focusNode]);

    // --- Background pan (click/touch-drag on empty canvas) + wheel/trackpad-pinch zoom ---
    // Deliberately NOT using d3-zoom's built-in drag/wheel handling here (the way we did
    // before this fix) — the same class of bug we found with `.scaleBy` (silently
    // depending on internal, environment-sensitive details rather than just doing the
    // transform math ourselves) turned out to also affect panning: d3-zoom's own
    // mousedown/wheel listeners were attached, but background drag never visibly moved
    // the graph. Rather than keep chasing d3-zoom internals one interaction at a time,
    // pan and wheel-zoom are now both implemented directly with plain pointer/wheel
    // events, writing straight through the same `setTransformNow` that already runs the
    // (verified-working, see render.smoke.test.jsx) zoom buttons — one single, simple,
    // well-understood code path for every way the transform can change.
    const panRef = useRef(null); // { startClientX, startClientY, startTransform } while a background drag is active

    const handleBackgroundPointerDown = useCallback((e) => {
        // A node's own onPointerDown calls stopPropagation, so this only fires for
        // clicks that land on genuinely empty canvas (or an edge line) — draggingRef
        // is an extra belt-and-braces check in case a node drag is somehow still active.
        if (draggingRef.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
        panRef.current = { startClientX: e.clientX, startClientY: e.clientY, startTransform: transformRef.current };
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* Pointer Capture unsupported — pan still works via document-level move/up */ }
    }, []);

    const handleBackgroundPointerMove = useCallback((e) => {
        const pan = panRef.current;
        if (!pan) return;
        const dx = e.clientX - pan.startClientX;
        const dy = e.clientY - pan.startClientY;
        manualViewRef.current = true;
        setTransformNow(d3.zoomIdentity.translate(pan.startTransform.x + dx, pan.startTransform.y + dy).scale(pan.startTransform.k));
    }, [setTransformNow]);

    const handleBackgroundPointerUp = useCallback((e) => {
        if (!panRef.current) return;
        panRef.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    }, []);

    const handleWheel = useCallback((e) => {
        e.preventDefault();
        const svgEl = svgRef.current;
        if (!svgEl) return;
        const rect = svgEl.getBoundingClientRect();
        // Zoom toward the cursor (or, for a trackpad pinch, the gesture's center point —
        // browsers report two-finger pinch as a wheel event with ctrlKey set, which is
        // exactly what this handler treats as zoom, satisfying "pinch to zoom" for free).
        const pointerX = e.clientX - rect.left;
        const pointerY = e.clientY - rect.top;
        const current = transformRef.current;
        const zoomFactor = Math.exp(-e.deltaY * 0.012);
        const newK = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.k * zoomFactor));
        const worldX = (pointerX - current.x) / current.k;
        const worldY = (pointerY - current.y) / current.k;
        manualViewRef.current = true;
        setTransformNow(d3.zoomIdentity.translate(pointerX, pointerY).scale(newK).translate(-worldX, -worldY));
    }, [setTransformNow]);

     // Attached manually (not via JSX onWheel) because React's synthetic onWheel
    // listener is registered as passive, which silently ignores preventDefault() —
    // the browser's own pinch/ctrl-scroll page zoom would still fire alongside ours.
    // A native listener with { passive: false } is the only way preventDefault() works.
    useEffect(() => {
        const svgEl = svgRef.current;
        if (!svgEl) return;
        svgEl.addEventListener('wheel', handleWheel, { passive: false });
        return () => svgEl.removeEventListener('wheel', handleWheel);
    }, [handleWheel, layoutReady]);


    // --- Auto fit-view: whenever a fresh layout finishes (new repo, mode switch), frame it automatically. ---
    useEffect(() => {
        if (layoutReady && renderedNodes.length > 0 && !manualViewRef.current) {
            fitView(false); // no animation on first frame — it should just appear correctly placed
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layoutVersion, containerSize.width, containerSize.height]);

    // --- Track the container's real on-screen size, and re-fit whenever it changes
    //     (window resize, panel resize) — see the coordinate-model note above for why
    //     this size (not a fixed constant) is what viewBox and all zoom math must use. ---
    useEffect(() => {
        if (!svgRef.current) return;
        const container = svgRef.current.parentElement;
        if (!container) return;

        // Measure immediately on mount so the first render/fit isn't wrong
        // before any ResizeObserver callback has fired yet.
        const rect = container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            setContainerSize({ width: rect.width, height: rect.height });
        }

        if (typeof ResizeObserver === 'undefined') return;
        let timeout;
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            const { width, height } = entry.contentRect;
            if (width <= 0 || height <= 0) return;
            setContainerSize({ width, height });
            clearTimeout(timeout);
timeout = setTimeout(() => { if (!manualViewRef.current) fitView(false); }, 150);        });
        observer.observe(container);
        return () => {
            clearTimeout(timeout);
            observer.disconnect();
        };
    }, [fitView]);

    // --- Node dragging: screen-pixel deltas are divided by the current zoom scale to get world-space deltas. ---
    function makeDragHandlers(nodeId) {
        return {
            onPointerDown: (e) => {
                e.stopPropagation();
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* Pointer Capture unsupported */ }
                draggingRef.current = true;
            },
            onPointerMove: (e) => {
                if (!draggingRef.current || e.buttons !== 1) return;
                const pos = positionsRef.current.get(nodeId);
                if (!pos) return;
                const k = transformRef.current.k || 1;
                pos.x += e.movementX / k;
                pos.y += e.movementY / k;
                forceRerender((x) => x + 1);
            },
            onPointerUp: (e) => {
                draggingRef.current = false;
                try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released / unsupported */ }
            },
        };
    }

    if (!layoutReady) {
        return <div className="graph-canvas__loading">Laying out graph…</div>;
    }

    const hoveredConnections = hoveredNodeId ? adjacency.get(hoveredNodeId) : null;

    return (
        <div className="graph-canvas">
            {truncated && (
                <div className="graph-canvas__truncation-notice">
                    Showing {MAX_RENDERED_NODES} of {nodes.length} files — this repository is large enough
                    that the full graph would be unreadable. Use the folder tree to reach files not shown here.
                </div>
            )}
            <svg
                ref={svgRef}
                width={containerSize.width}
                height={containerSize.height}
                className="graph-canvas__svg"
                onClick={() => onSelectNode(null)}
                onPointerDown={handleBackgroundPointerDown}
                onPointerMove={handleBackgroundPointerMove}
                onPointerUp={handleBackgroundPointerUp}
                onPointerCancel={handleBackgroundPointerUp}
                
            >
                <defs>
                    <pattern id="graph-canvas-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                        <circle cx="1" cy="1" r="1" className="graph-canvas__grid-dot" />
                    </pattern>
                </defs>
                <g ref={gRef} transform="translate(0, 0) scale(1)">
                    {/* ^ Initial value only — d3's zoom handler above sets this attribute
                        directly from here on, so React never touches it again after mount
                        (it's not read from state/props in this JSX), which is what lets the
                        zoom handler's imperative DOM write actually stick. */}
                    {/* Grid pans/zooms with the content for a genuine infinite-canvas feel. */}
                                        <rect
                        x={-4000} y={-4000} width={8000} height={8000}
                        fill="url(#graph-canvas-grid)"
                    />

                    {
    <g className="graph-canvas__hulls">
                            {[...folderGroups.entries()].map(([folder, ids]) => {
                                const points = ids
                                    .map((id) => positionsRef.current.get(id))
                                    .filter(Boolean)
                                    .map((p) => [p.x, p.y]);
                                const path = buildHullPath(points, 30);
                                if (!path) return null;
                                const color = HULL_PALETTE[hashString(folder) % HULL_PALETTE.length];
                                const labelY = Math.min(...points.map((p) => p[1])) - 38;
                                const labelX = points.reduce((sum, p) => sum + p[0], 0) / points.length;
                                return (
                                    <g key={folder}>
                                        <path
                                            d={path}
                                            fill={color}
                                            stroke={color}
                                            style={{ fillOpacity: 0.07, strokeOpacity: 0.35, strokeWidth: 1.5, pointerEvents: 'none' }}
                                        />
                                        <text
                                            x={labelX}
                                            y={labelY}
                                            textAnchor="middle"
                                            style={{ fontSize: 11, fill: color, opacity: 0.85, pointerEvents: 'none' }}
                                        >
                                            {folder}
                                        </text>
                                    </g>
                                );
                            })}
                                                </g>
                    }


                    <g className="graph-canvas__edges">
                        {renderedEdges.map((e, i) => {
                            const s = positionsRef.current.get(e.source);
                            const t = positionsRef.current.get(e.target);
                            if (!s || !t) return null;
                            const touchesSelected = selectedNodeId && (e.source === selectedNodeId || e.target === selectedNodeId);
                            const touchesHovered = hoveredNodeId && (e.source === hoveredNodeId || e.target === hoveredNodeId);
                            const faded = hoveredNodeId && !touchesHovered;
                            if (curvedLinks) {
                                // Quadratic curve through a midpoint offset perpendicular to the
                                // s->t line — a fixed, deterministic bow (no randomness) so the
                                // same graph always renders identically between refreshes.
                                const mx = (s.x + t.x) / 2;
                                const my = (s.y + t.y) / 2;
                                const dx = t.x - s.x, dy = t.y - s.y;
                                const dist = Math.hypot(dx, dy) || 1;
                                const bow = Math.min(40, dist * 0.18);
                                const cx = mx - (dy / dist) * bow;
                                const cy = my + (dx / dist) * bow;
                                return (
                                    <path
                                        key={i}
                                        d={`M ${s.x} ${s.y} Q ${cx} ${cy} ${t.x} ${t.y}`}
                                        fill="none"
                                        className={
                                            'graph-canvas__edge' +
                                            (touchesSelected || touchesHovered ? ' graph-canvas__edge--active' : '') +
                                            (faded ? ' graph-canvas__edge--faded' : '')
                                        }
                                    />
                                );
                            }
                            return (
                                <line
                                    key={i}
                                    x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                                    className={
                                        'graph-canvas__edge' +
                                        (touchesSelected || touchesHovered ? ' graph-canvas__edge--active' : '') +
                                        (faded ? ' graph-canvas__edge--faded' : '')
                                    }
                                />
                            );
                        })}
                    </g>
                    <g className="graph-canvas__nodes">
                        {renderedNodes.map((n) => {
                            const pos = positionsRef.current.get(n.id);
                            if (!pos) return null;
                            const isSelected = n.id === selectedNodeId;
                            const isHovered = n.id === hoveredNodeId;
                            const isConnectedToHover = hoveredConnections?.has(n.id);
                            const faded = hoveredNodeId && !isHovered && !isConnectedToHover;
                            const group = groupOf.get(n.id) ?? 0;
                            const severity = severityFn ? severityFn(n) : null;
                            const severityColor = severity == null ? null
                                : severity > 0.7 ? '#ff5f5f' : severity > 0.4 ? '#ff9f43' : '#22c55e';
                            return (
                                <g
                                    key={n.id}
                                    transform={`translate(${pos.x}, ${pos.y})`}
                                    className={`graph-canvas__node-group${faded ? ' graph-canvas__node-group--faded' : ''}`}
                                    onClick={(e) => { e.stopPropagation(); onSelectNode(n.id); }}
                                    onDoubleClick={(e) => {
                                        e.stopPropagation();
                                        focusNode(n.id);
                                        onNodeDoubleClick?.(n.id);
                                    }}
                                    onMouseEnter={() => setHoveredNodeId(n.id)}
                                    onMouseLeave={() => setHoveredNodeId(null)}
                                    {...makeDragHandlers(n.id)}
                                >
                                    <circle
                                        r={isSelected || isHovered ? 9 : 6}
                                        className={`graph-canvas__node${severityColor ? '' : ` graph-canvas__node--group-${group}`}${isSelected ? ' graph-canvas__node--selected' : ''}`}
                                        style={severityColor ? { fill: severityColor, stroke: severityColor, filter: `drop-shadow(0 0 4px ${severityColor}99)` } : undefined}
                                    />
                                    {showLabels && (
                                        <text x={10} y={4} className="graph-canvas__node-label">
                                            {n.label || n.id}
                                        </text>
                                    )}
                                </g>
                            );
                        })}
                    </g>
                </g>
            </svg>
        </div>
    );
});

export default GraphCanvas;
