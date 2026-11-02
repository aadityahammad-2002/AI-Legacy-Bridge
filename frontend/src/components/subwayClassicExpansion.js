/**
 * Source-backed station planning for the CLASSIC repository Subway Map.
 *
 * Classic D3 folder roads never move. Every top-level folder owns its original
 * angular sector and every overflow stop gets a non-overlapping child sector.
 * All hidden files receive stable positions before ANY expansion takes place;
 * clicking "+N more" merely reveals the next five pre-positioned stations.
 *
 * This module is DOM-free so it can run in a Vite module Web Worker. No fake
 * files, dependency edges, or inferred runtime call paths are created.
 */
const TAU = Math.PI * 2;
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const coordinates = (cx, cy, r, angle) => ({
    x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle),
});

export function nextSubwayRevealCount(previous, total, pageSize = 5) {
    if (!Number.isFinite(total) || total <= 0 || previous >= total) return 0;
    return Math.min(total, Math.max(0, previous) + Math.max(1, pageSize));
}

/** Preserve D3's original TOP-LEVEL folder angles and route order. */
export function subwayFolderSectors(hierarchyRoot) {
    const branches = hierarchyRoot?.children || [];
    const extents = branches.map((branch) => {
        const angles = branch.leaves().map((leaf) => leaf.x).filter(Number.isFinite);
        const values = angles.length ? angles : [branch.x];
        return { folder: branch.data.folder, min: Math.min(...values), max: Math.max(...values) };
    });
    const sectors = new Map();
    extents.forEach((item, i) => {
        const start = i ? (extents[i - 1].max + item.min) / 2 : 0;
        const end = i + 1 < extents.length ? (item.max + extents[i + 1].min) / 2 : TAU;
        sectors.set(item.folder, { start: start - Math.PI / 2, end: end - Math.PI / 2 });
    });
    return sectors;
}

const markerAngleOrder = (a, b) => finite(a.angle) - finite(b.angle)
    || String(a.scope || a.id).localeCompare(String(b.scope || b.id));
const markerSizeOrder = (a, b) => a.hidden.length - b.hidden.length || markerAngleOrder(a, b);

/**
 * Split a parent's angular sector into disjoint sub-sectors. Space is
 * proportional to sqrt(file count), rather than its original visible six-file
 * D3-tree width. A 140-file branch gets more arc than a 20-file branch without
 * monopolizing the rest of the parent. Sorting by the *original* angle keeps
 * the new tracks near their classic junctions.
 *
 * Scope/subfolder identity is preserved in every marker; the resulting
 * intervals are strictly disjoint, regardless of click/selection order.
 */
export function subwaySubsectors(entries, { start, end }) {
    const sorted = [...entries].sort(markerAngleOrder);
    const low = Math.min(start, end), high = Math.max(start, end);
    const width = Math.max(0.001, high - low);
    const weights = sorted.map((m) => Math.max(1, Math.sqrt(m.hidden?.length || 1)));
    const sum = weights.reduce((total, weight) => total + weight, 0) || 1;
    const minimumWidth = width / Math.max(1, sorted.length) * 0.72;
    const flexibleWidth = Math.max(0, width - minimumWidth * sorted.length);
    const result = new Map();
    let cursor = low;
    sorted.forEach((entry, i) => {
        const next = i === sorted.length - 1 ? high : cursor + minimumWidth + flexibleWidth * weights[i] / sum;
        result.set(entry.id, { start: cursor, end: next });
        cursor = next;
    });
    return result;
}

/**
 * Full capacity-based plan. Always include *all* markers in the planning
 * stage: hidden/collapsed siblings still reserve room. A Map of reveal counts
 * decides only which of those immutable positions should be displayed.
 *
 * @param {Array<{id,folder,scope?,angle,x,y,hidden:Array<{path:string}>,sectorStart,sectorEnd}>} markers
 * @param {Map<any,number>} revealed
 * @returns {Map<any,{stations:Array, firstRadius, endRadius,reservedEndRadius,remaining,rings,sectorStart,sectorEnd}>}
 */
export function planSubwayClassicExpansions(markers, revealed = new Map(), {
    cx = 0, cy = 0, outerRadius = 300,
    stationGap = 19, startGap = 15, ringGap = 25,
    groupGap = 11, pageSize = 5, sectorMargin = 0.015,
    protectedStations = [],
} = {}) {
    // Fixed-size spatial hash keeps collision checks close to O(file count)
    // rather than comparing all N² pairs for 500+ stations.
    const grid = new Map();
    const cellSize = stationGap;
    const key = (x, y) => `${x},${y}`;
    const cell = (p) => ({ x: Math.floor(p.x / cellSize), y: Math.floor(p.y / cellSize) });
    const insert = (p) => {
        const { x, y } = cell(p);
        const id = key(x, y);
        if (!grid.has(id)) grid.set(id, []);
        grid.get(id).push(p);
    };
    const collides = (p) => {
        const { x, y } = cell(p);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const points = grid.get(key(x + dx, y + dy)) || [];
            for (const other of points) {
                if (Math.hypot(p.x - other.x, p.y - other.y) < stationGap - 0.01) return true;
            }
        }
        return false;
    };
    for (const point of protectedStations) if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) insert(point);
    const results = new Map();
    const byFolder = new Map();
    for (const m of markers || []) {
        if (!m?.hidden?.length) continue;
        const key = m.folder || '__root__';
        if (!byFolder.has(key)) byFolder.set(key, []);
        byFolder.get(key).push(m);
    }

    for (const entries of byFolder.values()) {
        // Folder boundaries come from the existing D3 hierarchy; sibling stops
        // receive separate nested angular lanes within that boundary.
        const first = entries[0];
        const folderSector = {
            start: finite(first.sectorStart, Math.min(...entries.map(m => finite(m.angle) - 0.45))),
            end: finite(first.sectorEnd, Math.max(...entries.map(m => finite(m.angle) + 0.45))),
        };
        const subsectors = subwaySubsectors(entries, folderSector);
        const countOrdered = [...entries].sort(markerSizeOrder);
        const parentReservations = new Map();
        let previousFirst = 0;
        for (const m of countOrdered) {
            const total = m.hidden.length;
            const sector = subsectors.get(m.id);
            const width = Math.max(0.001, sector.end - sector.start);
            const markerRadius = Math.hypot(finite(m.x, cx) - cx, finite(m.y, cy) - cy);
            // A collapsed group still reserves its full geometry. The first
            // small group stays near its original marker, not outerR + 40.
            let radius = Math.max(outerRadius * 0.6, markerRadius + startGap);
            // Independent subfolders have separate angular territory, so they
            // can share radial *bands*; only their start order is count-ranked.
            radius = Math.max(radius, previousFirst ? previousFirst + stationGap + 3 : 0);
            // Groups sharing one immediate parent also reserve non-overlapping
            // radial ranges (small inner, large outer).
            const scope = m.scope || m.folder || '__root__';
            const priorInScope = parentReservations.get(scope);
            if (priorInScope != null && !m.scope) radius = Math.max(radius, priorInScope + groupGap);
            // For very narrow intervals, use an adequate radius to make two
            // adjacent sub-sectors' nearest stations at least stationGap apart.
            const minimumRadius = stationGap * 1.9 / width;
            radius = Math.max(radius, minimumRadius);
            const anchor = clamp(finite(m.angle, (sector.start + sector.end) / 2), sector.start, sector.end);
            // Generate once per radius candidate. If neighboring sub-sector
            // stations conflict at their boundary, shift this *whole* group
            // outward by 5px; no click-time position changes are required.
            const createLanes = (startRadius) => {
                let capacityUsed = 0;
                let radius = startRadius;
                const lanes = [];
                while (capacityUsed < total) {
                    const margin = Math.min(width * 0.23, Math.max(sectorMargin, stationGap * 0.82 / radius));
                    const lo = sector.start + margin;
                    const hi = sector.end - margin;
                    const available = Math.max(0.0001, hi - lo);
                    const step = 2 * Math.asin(Math.min(0.999, stationGap / (2 * radius)));
                    const laneCapacity = Math.max(1, Math.floor(available / step) + 1);
                    const take = Math.min(total - capacityUsed, laneCapacity);
                    const sweep = lanes.length % 2 === 0
                        ? (anchor - lo <= hi - anchor ? 1 : -1)
                        : (anchor - lo <= hi - anchor ? -1 : 1);
                    const lowStart = lo;
                    const highStart = hi;
                    const span = step * (take - 1);
                    const initial = take === 1 ? (lo + hi) / 2 : sweep > 0
                        ? clamp(anchor, lowStart, Math.max(lowStart, highStart - span))
                        : clamp(anchor, Math.min(highStart, lowStart + span), highStart);
                    lanes.push({ radius, take, step, initial, sweep, from: capacityUsed });
                    capacityUsed += take;
                    radius += ringGap;
                }
                const allStations = [];
                let laneIndex = 0;
                for (let i = 0; i < total; i++) {
                    while (i >= lanes[laneIndex].from + lanes[laneIndex].take) laneIndex++;
                    const lane = lanes[laneIndex];
                    const angle = lane.initial + lane.sweep * lane.step * (i - lane.from);
                    allStations.push({
                        file: m.hidden[i], index: i,
                        page: Math.floor(i / Math.max(1, pageSize)),
                        ring: laneIndex, angle, radius: lane.radius,
                        sweep: lane.sweep, ...coordinates(cx, cy, lane.radius, angle),
                    });
                }
                return { lanes, allStations };
            };
            let generated = createLanes(radius);
            for (let attempt = 0; attempt < 120 && generated.allStations.some(collides); attempt++) {
                radius += 5;
                generated = createLanes(radius);
            }
            // If geometry is exceptionally narrow, use the safest candidate
            // found rather than inventing or deleting stations.
            const { lanes, allStations } = generated;
            const firstRadius = radius;
            allStations.forEach(insert);
            const count = Math.min(total, Math.max(0, revealed.get(m.id) || 0));
            const reservedEndRadius = lanes[lanes.length - 1].radius;
            results.set(m.id, {
                stations: allStations.slice(0, count),
                // The worker/renderer can read these immutable full slots
                // once and simply reveal additional prefix stations.
                allStations,
                firstRadius,
                endRadius: count ? allStations[count - 1].radius : firstRadius,
                reservedEndRadius,
                remaining: total - count,
                pages: Math.ceil(count / Math.max(1, pageSize)),
                rings: lanes.length,
                sectorStart: sector.start,
                sectorEnd: sector.end,
                folder: m.folder,
                scope,
            });
            previousFirst = firstRadius;
            parentReservations.set(scope, reservedEndRadius + ringGap);
        }
    }
    return results;
}

/**
 * One radial turnout at the original marker, followed by actual SVG arcs.
 * The classic center's 45-degree metro roads remain 100% unchanged.
 */
export function subwayCircularTrackSegments(marker, stations, { cx = 0, cy = 0 } = {}) {
    if (!stations?.length) return [];
    const segments = [];
    let prev = null;
    for (const station of stations) {
        let path, kind;
        if (!prev) {
            const entrance = coordinates(cx, cy, station.radius, marker.angle);
            const delta = station.angle - marker.angle;
            path = `M${marker.x},${marker.y} L${entrance.x},${entrance.y}`;
            if (Math.abs(delta) > 1e-5) {
                path += ` A${station.radius},${station.radius} 0 ${Math.abs(delta) > Math.PI ? 1 : 0} ${delta >= 0 ? 1 : 0} ${station.x},${station.y}`;
            }
            kind = 'connector';
        } else if (station.ring !== prev.ring) {
            const switchAt = coordinates(cx, cy, station.radius, prev.angle);
            const delta = station.angle - prev.angle;
            path = `M${prev.x},${prev.y} L${switchAt.x},${switchAt.y}`;
            if (Math.abs(delta) > 1e-5) {
                path += ` A${station.radius},${station.radius} 0 ${Math.abs(delta) > Math.PI ? 1 : 0} ${delta >= 0 ? 1 : 0} ${station.x},${station.y}`;
            }
            kind = 'ring-change';
        } else {
            const delta = station.angle - prev.angle;
            path = `M${prev.x},${prev.y} A${station.radius},${station.radius} 0 ${Math.abs(delta) > Math.PI ? 1 : 0} ${delta >= 0 ? 1 : 0} ${station.x},${station.y}`;
            kind = 'circular-arc';
        }
        segments.push({ path, kind, station });
        prev = station;
    }
    return segments;
}
