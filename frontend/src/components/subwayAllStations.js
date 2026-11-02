/**
 * Compose a COMPLETE subway station model without inventing paths or edges.
 *
 * A small group of files stays in the classic D3 hierarchy (the recognizable
 * center metro network); every remaining real file receives an immutable
 * coordinate on its own parent's colored curved track. The two groups render
 * identically as file stations and are visible on the FIRST draw.
 *
 * This module is intentionally DOM-free, so its source/path integrity can be
 * verified against 500+ file fixtures without requiring a browser.
 */
export function buildCompleteSubwayStations({
    baseNodes = [], markers = [], files = [], cx = 0, cy = 0,
    outerRadius = 300, planner, protectedStations = [], isInterchange = () => false,
}) {
    if (typeof planner !== 'function') throw new Error('Subway layout planner unavailable');
    const base = baseNodes.map((d) => ({
        id: d.data.id, name: d.data.name, folder: d.data.folder,
        px: d.px, py: d.py, interchange: !!d.data.interchange,
    }));
    const revealAll = new Map(markers.map((m) => [m.id, m.hidden.length]));
    const plan = planner(markers, revealAll, { cx, cy, outerRadius, protectedStations });
    const branches = [];
    const additional = [];
    for (const marker of markers) {
        const entry = plan.get(marker.id);
        if (!entry || entry.allStations.length !== marker.hidden.length) {
            throw new Error(`Incomplete Subway station plan for folder ${marker.folder}`);
        }
        branches.push({ marker, stations: entry.allStations });
        for (const station of entry.allStations) {
            const path = station.file.path;
            additional.push({
                id: path, name: path.split('/').pop() || path, folder: marker.folder,
                px: station.x, py: station.y, interchange: !!isInterchange(path),
            });
        }
    }
    const stations = [...base, ...additional];
    const expected = new Set(files.map((f) => f.path));
    const actual = new Set(stations.map((d) => d.id));
    if (expected.size !== actual.size || stations.length !== expected.size
        || [...expected].some((path) => !actual.has(path))
        || stations.some((d) => !Number.isFinite(d.px) || !Number.isFinite(d.py))) {
        throw new Error(`Subway file station mismatch (${actual.size}/${expected.size} source paths)`);
    }
    return { stations, branches };
}
