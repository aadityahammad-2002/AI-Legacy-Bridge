/**
 * Deterministic, source-backed subway hierarchy layout.
 *
 * A folder owns one angular sector; descendants can only occupy that sector.
 * All displayed stations share a terminal ring, while omitted stations may
 * expand into dedicated OUTER rings within their marker's reserved sector.
 * These routes describe folder membership, never file dependencies.
 *
 * This module intentionally has no DOM/D3/React dependencies. Geometric
 * invariants are testable without a browser.
 */

import { selectSubwayStations } from './graphViewModels.js';
const subwayTopFolder = (path) => {
    const index = path.indexOf('/');
    return index === -1 ? '(root)' : path.slice(0, index);
};
const subwayBaseName = (path) => path.split('/').pop();
const subwayDegree = (edges) => {
    const degree = new Map();
    for (const { source, target } of edges) {
        degree.set(source, (degree.get(source) || 0) + 1);
        degree.set(target, (degree.get(target) || 0) + 1);
    }
    return degree;
};

const TWO_PI = Math.PI * 2;
const polar = (cx, cy, radius, angle) => ({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
const finite = (n, fallback) => Number.isFinite(n) ? n : fallback;

/** Arc going clockwise from start to end in SVG's downward-positive coordinates. */
export function subwayArcPath(cx, cy, radius, start, end) {
    if (end - start < 1e-6 || radius < 1) return '';
    const a = polar(cx, cy, radius, start), b = polar(cx, cy, radius, end);
    const large = end - start > Math.PI ? 1 : 0;
    return `M${a.x},${a.y} A${radius},${radius} 0 ${large} 1 ${b.x},${b.y}`;
}

function buildNode(data, parent, depth) {
    const node = { data, parent, depth, children: [], weight: 1 };
    node.children = (data.children || []).map((item) => buildNode(item, node, depth + 1));
    if (node.children.length) {
        node.weight = node.children.reduce((total, child) => total + child.weight, 0);
    } else if (data.type === 'more') {
        // Reserve some of this marker's angular corridor for future expansion.
        node.weight = 1 + Math.min(10, Math.sqrt(data.hidden?.length || 0));
    }
    return node;
}

function giveSectors(parent) {
    const children = parent.children;
    if (!children.length) return;
    // Gaps separate independent metro lines; gaps within a line are smaller.
    const requestedGap = parent.depth === 0 ? 0.085 : parent.depth === 1 ? 0.029 : 0.009;
    const gap = Math.min(requestedGap, (parent.thetaEnd - parent.thetaStart) / (children.length * 5));
    const free = Math.max(0, parent.thetaEnd - parent.thetaStart - gap * (children.length - 1));
    const total = children.reduce((sum, n) => sum + n.weight, 0) || 1;
    let cursor = parent.thetaStart;
    children.forEach((child) => {
        const width = free * child.weight / total;
        child.thetaStart = cursor;
        child.thetaEnd = cursor + width;
        child.theta = (child.thetaStart + child.thetaEnd) / 2;
        giveSectors(child);
        cursor = child.thetaEnd + gap;
    });
}

/** Build complete folder-based position graph without arbitrary file truncation. */
export function createSubwayLayout(root, {
    width = 900, height = 600, minRadius = 490, stationSpacing = 25,
} = {}) {
    const tree = buildNode(root, null, 0);
    tree.thetaStart = -Math.PI / 2;
    tree.thetaEnd = tree.thetaStart + TWO_PI;
    tree.theta = tree.thetaStart;
    giveSectors(tree);
    const nodes = [];
    const links = [];
    const visit = (node) => {
        nodes.push(node);
        node.children.forEach((child) => { links.push({ source: node, target: child }); visit(child); });
    };
    visit(tree);
    const stations = nodes.filter((node) => node.data.type === 'file' || node.data.type === 'more');
    // Guarantee minimum spacing globally for a crowded repository. The viewer
    // can zoom; we never silently drop real stations to make the diagram fit.
    const terminalRadius = Math.max(minRadius, stations.length * stationSpacing / TWO_PI);
    const cx = Math.max(1, width) / 2, cy = Math.max(1, height) / 2;
    for (const node of nodes) {
        if (node.depth === 0) node.r = 0;
        else if (!node.children.length) node.r = terminalRadius;
        else if (node.depth === 1) node.r = Math.min(155, terminalRadius * 0.25);
        else if (node.depth === 2) node.r = terminalRadius * 0.50;
        else if (node.depth === 3) node.r = terminalRadius * 0.73;
        else node.r = Math.min(terminalRadius - 65, terminalRadius * (0.73 + 0.05 * (node.depth - 3)));
        const pos = polar(cx, cy, node.r, node.theta);
        node.px = pos.x; node.py = pos.y;
    }
    return { root: tree, nodes, links, stations, terminalRadius, cx, cy };
}

/**
 * Routes drawn like a proper metro map: one trunk, one shared circular rail,
 * and individual radial spokes. No repeated diagonal elbow across neighbors.
 * Each separate folder's rails remain inside its angular corridor.
 */
export function createSubwayRoutes(layout) {
    const { nodes, cx, cy } = layout;
    const routes = [];
    for (const parent of nodes) {
        if (!parent.children.length) continue;
        for (const child of parent.children) {
            if (parent.depth === 0) {
                routes.push({ folder: child.data.folder, kind: 'trunk', d: `M${cx},${cy} L${child.px},${child.py}`, from: parent, to: child });
            }
        }
        if (parent.depth === 0) continue;
        const firstChildRadius = Math.min(...parent.children.map((node) => node.r));
        const busRadius = parent.r + (firstChildRadius - parent.r) * 0.53;
        const busSource = polar(cx, cy, busRadius, parent.theta);
        routes.push({ folder: parent.data.folder, kind: 'trunk',
            d: `M${parent.px},${parent.py} L${busSource.x},${busSource.y}` });
        const angles = parent.children.map((child) => child.theta);
        const first = Math.min(parent.theta, ...angles), last = Math.max(parent.theta, ...angles);
        const arc = subwayArcPath(cx, cy, busRadius, first, last);
        if (arc) routes.push({ folder: parent.data.folder, kind: 'rail', d: arc });
        for (const child of parent.children) {
            const from = polar(cx, cy, busRadius, child.theta);
            routes.push({ folder: parent.data.folder, kind: child.children.length ? 'spoke' : 'twig',
                d: `M${from.x},${from.y} L${child.px},${child.py}`, from: parent, to: child });
        }
    }
    return routes;
}

/**
 * Expands a +N marker into concentric circular rails OUTSIDE every base file.
 * The marker owns a disjoint angular interval, so independently expanded
 * neighboring groups cannot use the same lane, even when opened together.
 */
export function createSubwayExpansion(marker, { cx, cy, terminalRadius }, spacing = 31) {
    const files = marker.data.hidden || [];
    if (!files.length) return { stations: [], routes: [], maxRadius: terminalRadius, center: { x: marker.px, y: marker.py } };
    const fullSpan = marker.thetaEnd - marker.thetaStart;
    const margin = Math.min(0.018, fullSpan * 0.085);
    const a0 = marker.thetaStart + margin, a1 = marker.thetaEnd - margin;
    const span = Math.max(0.0001, a1 - a0);
    const routes = [], stations = [];
    const firstRadius = terminalRadius + 105;
    const ringStep = 75;
    let index = 0, ring = 0, maxRadius = firstRadius;
    while (index < files.length) {
        const r = firstRadius + ring * ringStep;
        maxRadius = r;
        const capacity = Math.max(1, Math.floor((r * span) / Math.max(10, finite(spacing, 31))));
        const count = Math.min(capacity, files.length - index);
        const angles = Array.from({ length: count }, (_, i) => {
            if (count === 1) return marker.theta;
            // Space stations across the corridor with a little angular margin.
            const padding = Math.min(span * 0.16, (spacing * 0.45) / r);
            return a0 + padding + i * (span - 2 * padding) / (count - 1);
        });
        const busRadius = r - 31;
        const terminal = polar(cx, cy, busRadius, marker.theta);
        routes.push({ ring, kind: 'trunk', d: `M${marker.px},${marker.py} L${terminal.x},${terminal.y}` });
        const arc = subwayArcPath(cx, cy, busRadius,
            Math.min(marker.theta, angles[0]), Math.max(marker.theta, angles[count - 1]));
        if (arc) routes.push({ ring, kind: 'rail', d: arc });
        for (let i = 0; i < count; i++) {
            const file = files[index++], theta = angles[i];
            const from = polar(cx, cy, busRadius, theta);
            const to = polar(cx, cy, r, theta);
            routes.push({ ring, kind: 'twig', d: `M${from.x},${from.y} L${to.x},${to.y}` });
            stations.push({ file, x: to.x, y: to.y, theta, r, ring });
        }
        ring++;
    }
    const focusRadius = (firstRadius + maxRadius) / 2;
    return { stations, routes, maxRadius,
        center: polar(cx, cy, focusRadius, marker.theta),
        sector: [marker.thetaStart, marker.thetaEnd] };
}

export function buildSubwayHierarchy(files, edges, maxVisiblePerStop = 4) {
    const folderColors = new Map([...new Set(files.map((f) => subwayTopFolder(f.path)))].sort().map((key) => [key, true]));
    const crossFolderPaths = new Set();
    edges.forEach((e) => {
        if (subwayTopFolder(e.source) !== subwayTopFolder(e.target)) {
            crossFolderPaths.add(e.source); crossFolderPaths.add(e.target);
        }
    });
    const isInterchange = (id) => crossFolderPaths.has(id) || (degree.get(id) || 0) >= 6;
    const degree = subwayDegree(edges);
    const root = { name: '(root)', type: 'root', children: [] };
    for (const folder of folderColors.keys()) {
        const list = files.filter((file) => subwayTopFolder(file.path) === folder);
        const level1 = new Map();
        for (const file of list) {
            const rest = folder === '(root)' ? file.path : file.path.slice(folder.length + 1);
            const parts = rest.split('/');
            const stop = parts.length > 1 ? parts[0] : '(files)';
            if (!level1.has(stop)) level1.set(stop, []);
            level1.get(stop).push({ file, parts });
        }
        const top = { name: folder, type: 'folder', folder, children: [] };
        for (const [stopName, entries] of [...level1.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            const level2 = new Map();
            for (const { file, parts } of entries) {
                const key = parts.length > 2 ? parts[1] : '(files)';
                if (!level2.has(key)) level2.set(key, []);
                level2.get(key).push(file);
            }
            const stop = stopName === '(files)' ? top : { name: stopName, type: 'folder', folder, children: [] };
            if (stop !== top) top.children.push(stop);
            for (const [subName, subFiles] of [...level2.entries()].sort(([a], [b]) => a.localeCompare(b))) {
                const bucket = subName === '(files)' ? stop : { name: subName, type: 'folder', folder, children: [] };
                if (bucket !== stop) stop.children.push(bucket);
                const ranked = [...subFiles].sort((a, b) => (degree.get(b.path) || 0) - (degree.get(a.path) || 0)
                    || a.path.localeCompare(b.path));
                // Smaller initial station groups make the railway diagram readable;
                // ALL omitted real files remain accessible through their +N stop.
                const shown = selectSubwayStations(ranked, edges, null, maxVisiblePerStop);
                const visible = new Set(shown.map((file) => file.path));
                for (const file of shown) {
                    bucket.children.push({ name: subwayBaseName(file.path), type: 'file', folder,
                        id: file.path, interchange: isInterchange(file.path) });
                }
                const hidden = ranked.filter((file) => !visible.has(file.path));
                if (hidden.length) {
                    bucket.children.push({ name: `+${hidden.length}`, type: 'more', folder,
                        key: `${folder}/${stopName}/${subName}`, hidden });
                }
            }
        }
        root.children.push(top);
    }
    return root;
}
