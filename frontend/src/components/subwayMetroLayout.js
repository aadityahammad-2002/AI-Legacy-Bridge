/**
 * Repository Subway Map: deterministic metro-style folder hierarchy.
 *
 * The goal is NOT to draw a dependency graph. It renders repository folders as
 * coloured metro lines, subfolders as filled junctions, and file endpoints as
 * hollow oval stations. Dense folders still keep ALL source-backed files in the
 * accessible folderCards map, while the overview shows only a small preview and
 * an optional ellipsis station for progressive disclosure.
 */
export const SUBWAY_PREVIEW_FILES = 3;
export const SUBWAY_METRO_COLORS = [
    '#d86bff', '#ffe04d', '#54a8ff', '#63ea88', '#33e7df',
    '#ff627e', '#ff9f3a', '#6e8dff', '#ff63cb', '#9adb59',
];

const normalizedPath = (path) => String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const labelOf = (path) => path.split('/').pop() || '(root)';
const compareName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const deg = (n) => n * Math.PI / 180;

function makeFolder(path, parent) {
    return {
        type: 'folder', id: path || '__root__', path, name: labelOf(path), parent,
        folders: [], directFiles: [], allFiles: [], topFolder: path.split('/')[0] || '(root)',
    };
}

export function buildSubwayFolderIndex(inputFiles = []) {
    const root = makeFolder('', null);
    root.name = 'root';
    const folders = new Map([['', root]]);
    const seen = new Set();
    for (const entry of inputFiles) {
        const path = normalizedPath(entry?.path);
        if (!path || seen.has(path)) continue;
        seen.add(path);
        const parts = path.split('/');
        let parent = root;
        let folderPath = '';
        for (const part of parts.slice(0, -1)) {
            if (!part) continue;
            folderPath = folderPath ? `${folderPath}/${part}` : part;
            if (!folders.has(folderPath)) {
                const folder = makeFolder(folderPath, parent);
                folders.set(folderPath, folder);
                parent.folders.push(folder);
            }
            parent = folders.get(folderPath);
        }
        const file = {
            type: 'file', id: path, path, name: parts.at(-1), folder: parent.path,
            topFolder: parts[0] || '(root)',
        };
        parent.directFiles.push(file);
    }
    const visit = (folder) => {
        folder.folders.sort((a, b) => compareName(a.name, b.name));
        folder.directFiles.sort((a, b) => compareName(a.name, b.name));
        folder.allFiles = [
            ...folder.directFiles,
            ...folder.folders.flatMap(visit),
        ];
        return folder.allFiles;
    };
    visit(root);
    return { root, folders, fileCount: seen.size };
}

/**
 * Draw an octilinear metro road between two points.
 */
export function subwayMetroRoad(parent, child) {
    const round = (n) => (Math.abs(n) < 0.005 ? 0 : Number(n.toFixed(2)));
    const p = (x, y) => `${round(x)},${round(y)}`;
    const sign = child.x >= parent.x ? 1 : -1;
    const deltaX = Math.abs(child.x - parent.x);
    const deltaY = child.y - parent.y;
    const starter = Math.min(54, deltaX * 0.26);
    const diagonal = Math.min(Math.abs(deltaY), Math.max(0, deltaX - starter - 36), 54);
    const x1 = parent.x + sign * starter;
    const x2 = x1 + sign * diagonal;
    const y2 = parent.y + Math.sign(deltaY) * diagonal;
    if (Math.abs(y2 - child.y) < 0.01) {
        return `M${p(parent.x, parent.y)} L${p(x1, parent.y)} L${p(x2, y2)} L${p(child.x, child.y)}`;
    }
    return `M${p(parent.x, parent.y)} L${p(x1, parent.y)} L${p(x2, y2)} L${p(x2, child.y)} L${p(child.x, child.y)}`;
}

function unit(angle) {
    return { x: Math.cos(angle), y: Math.sin(angle) };
}

function tangent(angle) {
    return { x: -Math.sin(angle), y: Math.cos(angle) };
}

function positionFrom(parent, angle, outward, tangentOffset = 0) {
    const u = unit(angle);
    const t = tangent(angle);
    return {
        x: Number((parent.x + u.x * outward + t.x * tangentOffset).toFixed(2)),
        y: Number((parent.y + u.y * outward + t.y * tangentOffset).toFixed(2)),
    };
}

function shortHash(text) {
    let hash = 2166136261;
    for (const ch of String(text || '')) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
    return hash >>> 0;
}

function collapseFolderChain(folder) {
    const chain = [folder];
    let current = folder;
    while (current.folders.length === 1 && current.directFiles.length === 0 && current.folders[0].directFiles.length === 0) {
        current = current.folders[0];
        chain.push(current);
    }
    return chain;
}

function previewChildren(folder, previewCount) {
    const items = [];
    const shownFiles = folder.directFiles.slice(0, previewCount);
    for (const file of shownFiles) items.push({ ...file, type: 'file' });
    if (folder.directFiles.length > previewCount) {
        items.push({
            type: 'more',
            id: `__more__${folder.path || 'root'}`,
            name: '...',
            folder: folder.path,
            topFolder: folder.topFolder,
            hiddenCount: folder.directFiles.length - previewCount,
        });
    }
    return items;
}

function canonicalColorFor(name) {
    const canonical = new Map([
        ['frontend', '#d86bff'],
        ['backend', '#ffe04d'],
        ['ai-service', '#54a8ff'],
        ['shared', '#6e8dff'],
        ['docs', '#ff63cb'],
        ['config', '#ff9f3a'],
        ['integrations', '#33e7df'],
        ['scripts', '#ff627e'],
        ['analysis-engine', '#63ea88'],
        ['tests', '#f7cb36'],
    ]);
    return canonical.get(String(name || '').toLowerCase()) || null;
}

function chooseTopLevelSlots(folders) {
    const referenceAngles = [
        deg(225), deg(185), deg(150), deg(120), deg(75),
        deg(35), deg(5), deg(345), deg(320), deg(285),
    ];
    const preferred = [
        { key: 'frontend', angle: deg(225) },
        { key: 'shared', angle: deg(185) },
        { key: 'docs', angle: deg(150) },
        { key: 'config', angle: deg(120) },
        { key: 'integrations', angle: deg(75) },
        { key: 'scripts', angle: deg(35) },
        { key: 'tests', angle: deg(5) },
        { key: 'analysis-engine', angle: deg(345) },
        { key: 'backend', angle: deg(320) },
        { key: 'ai-service', angle: deg(285) },
    ];
    const byName = new Map(folders.map((folder) => [folder.name.toLowerCase(), folder]));
    const assigned = new Map();
    const used = new Set();

    preferred.forEach(({ key, angle }) => {
        const folder = byName.get(key);
        if (folder) {
            assigned.set(folder.id, angle);
            used.add(folder.id);
        }
    });

    const remainingAngles = referenceAngles.filter((angle) => ![...assigned.values()].some((usedAngle) => Math.abs(usedAngle - angle) < 0.001));
    const remainingFolders = folders.filter((folder) => !used.has(folder.id)).sort((a, b) =>
        (b.allFiles.length - a.allFiles.length) || compareName(a.name, b.name));
    remainingFolders.forEach((folder, index) => {
        assigned.set(folder.id, remainingAngles[index % remainingAngles.length]
            ?? (-Math.PI + (index + 1) * ((2 * Math.PI) / Math.max(1, remainingFolders.length + 1))));
    });
    return assigned;
}

export function layoutRepositorySubway(files = [], { previewCount = SUBWAY_PREVIEW_FILES } = {}) {
    const { root, folders, fileCount } = buildSubwayFolderIndex(files);
    const count = Math.max(1, Math.min(4, Math.floor(previewCount) || SUBWAY_PREVIEW_FILES));
    const junctions = [];
    const stations = [];
    const lines = [];
    const folderCards = new Map();
    const previewIds = new Set();
    const colors = new Map();

    folderCards.set('', root.allFiles);
    junctions.push({
        id: '__root__', type: 'folder', folder: '', name: 'root', x: 0, y: 0,
        color: '#7db4ff', radius: 18, count: root.allFiles.length, depth: 0,
    });

    const rootFolders = [...root.folders].sort((a, b) =>
        (b.allFiles.length - a.allFiles.length) || compareName(a.name, b.name));
    const topAngles = chooseTopLevelSlots(rootFolders);
    const usedColors = new Set();
    let paletteIndex = 0;

    const nextColor = (name) => {
        const canonical = canonicalColorFor(name);
        if (canonical && !usedColors.has(canonical)) {
            usedColors.add(canonical);
            return canonical;
        }
        while (usedColors.has(SUBWAY_METRO_COLORS[paletteIndex % SUBWAY_METRO_COLORS.length])) paletteIndex++;
        const color = SUBWAY_METRO_COLORS[paletteIndex++ % SUBWAY_METRO_COLORS.length];
        usedColors.add(color);
        return color;
    };

    const addLine = (parent, child, color, depth, childType, descendants = 0) => {
        lines.push({
            id: `${parent.id}->${child.id}`,
            parent: parent.id,
            target: child.id,
            color,
            depth,
            childType,
            descendants,
            path: subwayMetroRoad(parent, child),
        });
    };

    const addFolderJunction = (folder, point, color, depth) => {
        const entry = {
            id: folder.id,
            type: 'folder',
            folder: folder.path,
            name: folder.name,
            x: point.x,
            y: point.y,
            angle: point.angle ?? 0,
            color,
            radius: depth === 1 ? 14 : depth === 2 ? 11.5 : depth === 3 ? 9.75 : 8.25,
            count: folder.allFiles.length,
            depth,
            topFolder: folder.topFolder,
        };
        junctions.push(entry);
        folderCards.set(folder.path, folder.allFiles);
        return entry;
    };

    const addFileStation = (item, point, color, depth) => {
        const entry = {
            id: item.id,
            type: item.type,
            name: item.name,
            x: point.x,
            y: point.y,
            angle: point.angle ?? 0,
            color,
            depth,
            angle: point.angle ?? 0,
            radius: Math.hypot(point.x, point.y),
            folder: item.folder,
            topFolder: item.topFolder,
            hiddenCount: item.hiddenCount || 0,
        };
        stations.push(entry);
        if (item.type === 'file') previewIds.add(item.id);
        return entry;
    };

    const branchSeedNudge = (folder, magnitude) => (((shortHash(folder.id) % 200) / 199) - 0.5) * magnitude;

    const layoutFolder = (folder, parentPoint, branchAngle, color, depth = 1) => {
        const chain = collapseFolderChain(folder);
        let currentParent = parentPoint;
        let currentDepth = depth;
        let localAngle = branchAngle;
        let finalEntry = null;

        chain.forEach((stepFolder, index) => {
            const outward = currentDepth === 1 ? 150 : currentDepth === 2 ? 90 : 70;
            const point = { ...positionFrom(currentParent, localAngle, outward, index === 0 ? 0 : branchSeedNudge(stepFolder, 10)), angle: localAngle };
            finalEntry = addFolderJunction(stepFolder, point, color, currentDepth);
            addLine(currentParent, finalEntry, color, currentDepth, 'folder', stepFolder.allFiles.length);
            currentParent = finalEntry;
            currentDepth += 1;
        });

        const targetFolder = chain.at(-1);
        const childFolders = [...targetFolder.folders].sort((a, b) =>
            (b.allFiles.length - a.allFiles.length) || compareName(a.name, b.name));
        const fileItems = previewChildren(targetFolder, count);

        if (childFolders.length) {
            const spread = childFolders.length === 1 ? 0
                : childFolders.length === 2 ? deg(16)
                    : childFolders.length <= 4 ? deg(24)
                        : deg(30);
            const tangentGap = childFolders.length <= 2 ? 52 : childFolders.length <= 4 ? 62 : 66;
            childFolders.forEach((childFolder, index) => {
                const centred = index - (childFolders.length - 1) / 2;
                const childAngle = localAngle + centred * spread * 0.55 + branchSeedNudge(childFolder, 0.08);
                const point = positionFrom(currentParent, localAngle, currentDepth <= 3 ? 92 : 82, centred * tangentGap);
                const pseudoParent = { ...currentParent, x: point.x - Math.cos(childAngle) * 0.001, y: point.y - Math.sin(childAngle) * 0.001 };
                // A real parent is still currentParent; the pseudoParent only keeps deterministic downstream angle separation.
                void pseudoParent;
                layoutFolder(childFolder, currentParent, childAngle, color, currentDepth);
            });
        }

        if (fileItems.length) {
            const baseOutward = childFolders.length ? 82 : 94;
            const start = -(fileItems.length - 1) / 2;
            const gap = 24;
            fileItems.forEach((item, index) => {
                const tangentOffset = (start + index) * gap;
                const point = { ...positionFrom(currentParent, localAngle, baseOutward, tangentOffset), angle: localAngle };
                const station = addFileStation(item, point, color, currentDepth);
                addLine(currentParent, station, color, currentDepth, item.type, 0);
            });
        }
    };

    rootFolders.forEach((folder) => {
        const angle = topAngles.get(folder.id) ?? 0;
        const color = nextColor(folder.name);
        colors.set(folder.name, color);
        layoutFolder(folder, { id: '__root__', x: 0, y: 0, radius: 0 }, angle, color, 1);
    });

    // Root-level files: keep them close to the root, as direct termini.
    const rootFileItems = previewChildren(root, count);
    rootFileItems.forEach((item, index) => {
        const angle = deg(260) + (index - (rootFileItems.length - 1) / 2) * 0.22;
        const point = { ...positionFrom({ x: 0, y: 0 }, angle, 88, 0), angle };
        const station = addFileStation({ ...item, folder: '' }, point, '#7db4ff', 1);
        addLine({ id: '__root__', x: 0, y: 0 }, station, '#7db4ff', 1, item.type, 0);
    });

    // Collision-aware label visibility. All data remains accessible via titles
    // and the file card even when overview labels are hidden.
    const occupiedLabels = [];
    const folderTextBox = (point, label) => {
        const width = Math.min(34, label.length) * 8.4;
        const sideRight = point.x >= 0;
        const x = sideRight ? point.x + 17 : point.x - 17 - width;
        return { x, y: point.y - 24, width, height: 22 };
    };
    const fileTextBox = (point, label) => {
        const width = Math.min(34, label.length) * 8.1;
        const sideRight = point.x >= 0;
        const x = sideRight ? point.x + 14 : point.x - 14 - width;
        return { x, y: point.y - 11, width, height: 18 };
    };
    const collision = (a, b) => a.x < b.x + b.width + 8 && a.x + a.width + 8 > b.x
        && a.y < b.y + b.height + 6 && a.y + a.height + 6 > b.y;

    [...junctions.filter((d) => d.id !== '__root__')]
        .sort((a, b) => (a.depth - b.depth) || (b.count - a.count) || compareName(a.name, b.name))
        .forEach((folder) => {
            const box = folderTextBox(folder, folder.name);
            folder.showLabel = !occupiedLabels.some((existing) => collision(box, existing));
            if (folder.showLabel) occupiedLabels.push(box);
        });

    [...stations]
        .sort((a, b) => (a.type === 'more' ? -1 : 1) - (b.type === 'more' ? -1 : 1)
            || (a.depth - b.depth) || compareName(a.name, b.name))
        .forEach((station) => {
            const label = station.type === 'more' ? '...' : station.name.length > 26 ? `${station.name.slice(0, 23)}…` : station.name;
            const box = fileTextBox(station, label);
            station.showLabel = !occupiedLabels.some((existing) => collision(box, existing));
            if (station.showLabel) occupiedLabels.push(box);
        });

    const allIds = new Set(root.allFiles.map((f) => f.id));
    if (allIds.size !== fileCount || [...previewIds].some((p) => !allIds.has(p))) {
        throw new Error('Subway overview lost repository paths');
    }

    return {
        fileCount,
        folderCount: folders.size - 1,
        root,
        junctions,
        stations,
        lines,
        folderCards,
        colors,
        previewCount: previewIds.size,
    };
}
