import { useState, useMemo, useRef, useEffect } from 'react';
import {
    Activity,
    Maximize2, LocateFixed, RotateCcw, ZoomIn, ZoomOut, Network, Folder as FolderIcon,
    Search, Layers, Upload,
} from 'lucide-react';

import TopNavBar from '../components/TopNavBar.jsx';
import FolderTree from '../components/FolderTree.jsx';
import GraphCanvas from '../components/GraphCanvas.jsx';
import AltVisualizations from '../components/AltVisualizations.jsx';
import GraphSettingsPanel from '../components/GraphSettingsPanel.jsx';
import ResizablePanel from '../components/ResizablePanel.jsx';
import RepositoryPanel from '../components/RepositoryPanel.jsx';
import './VisualizationExplorer.css';
import ExportModal from '../components/ExportModal.jsx';

const LANG_COLORS = ['#60a5fa', '#a78bfa', '#2dd4bf', '#4ade80', '#fb923c', '#f472b6', '#facc15', '#f87171'];

/**
 * Derives a folder-level graph from the existing file-level graph — purely a
 * display transform over data we already have (no new analysis). Files in
 * the same top-level folder collapse into one node; edges between folders
 * are deduplicated (multiple file-to-file edges between two folders become
 * one folder-to-folder edge).
 *
 * NOTE ON GRAPH MODES (not Color By — that's separate, see colorBy state
 * below): only Dependency (file-level, existing) and Folder (this) are
 * offered. A true Call Graph needs call-edges that `parser.js`'s
 * `Parser.findCalls()` extracts (now wired into `callGraph.js` and used for
 * Issues/health-score — see DEVELOPMENT_PROGRESS.md Entry 15) but not yet
 * exposed as a selectable graph-node view; Layer/Architecture graphs would
 * need a hierarchical layout algorithm, not just different node grouping.
 */
function buildFolderGraph(files, dependencies) {
    const folderOf = (path) => {
        const idx = path.lastIndexOf('/');
        return idx === -1 ? '(root)' : path.slice(0, idx);
    };

    const folderIds = new Set(files.map((f) => folderOf(f.path)));
    const nodes = [...folderIds].map((id) => ({ id, label: id.split('/').pop() || id }));

    const edgeSet = new Map(); // "source|target" -> count
    dependencies.forEach((d) => {
        const s = folderOf(d.source);
        const t = folderOf(d.target);
        if (s === t) return; // skip self-loops (intra-folder dependencies)
        const key = `${s}|${t}`;
        edgeSet.set(key, (edgeSet.get(key) || 0) + 1);
    });
    const edges = [...edgeSet.keys()].map((key) => {
        const [source, target] = key.split('|');
        return { source, target };
    });

    return { nodes, edges };
}

/**
 * Page 3 (one of two workspaces) — graph/tree/panels, per
 * PROJECT_DOCUMENTATION.md section 7. Renders the browser's Live Analysis
 * Model directly (passed in as `analysisResult` — the same object saved to
 * IndexedDB by UploadPage/session.js), not backend-fetched data.
 */
export default function VisualizationExplorer({
    analysisResult,
    activeWorkspace,
    onNavigate,
    onExitRepository,
    onOpenAiExplorerFocused,
}) {
    const [exportOpen, setExportOpen] = useState(false);
    const [selectedPath, setSelectedPath] = useState(null);
    const [showLabels, setShowLabels] = useState(true);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [layoutMode, setLayoutMode] = useState('force'); // 'force' | 'radial' | 'layers' | 'grid'
    const [metroSnap, setMetroSnap] = useState(false);
    const [curvedLinks, setCurvedLinks] = useState(false);
    const [spacingSpread, setSpacingSpread] = useState(0.5);
    const [spacingLinks, setSpacingLinks] = useState(0.5);
    const [graphMode, setGraphMode] = useState('dependency'); // 'dependency' | 'folder'
    // 'graph' = existing force-directed GraphCanvas; the rest (including 'subway' and
    // 'galaxy') render via AltVisualizations, same as Treemap/Tree/Cluster/etc — they
    // just swap the center canvas, the normal left Explorer / right Issues panels and
    // TopNavBar stay exactly as they are for every other viz type.
    // Only meaningful when graphMode === 'dependency' — Folder Graph always stays as 'graph'.
    // Persisted (not just component state) so the AI Explorer mini-map — a separate
    // page/component, mounted independently — can pick up whichever map type was last
    // selected here and render the same one, instead of always defaulting to the plain
    // force graph. See the matching read in AiExplorer.jsx.
    const [vizType, setVizType] = useState(() => localStorage.getItem('viz-explorer:vizType') || 'subway'); // 'graph' | 'treemap' | 'tree' | 'cluster' | 'matrix' | 'bundle' | 'flow' | 'subway' | 'galaxy'
    useEffect(() => { localStorage.setItem('viz-explorer:vizType', vizType); }, [vizType]);
    const [selectedFolder, setSelectedFolder] = useState(null);
    const [sidebarSearch, setSidebarSearch] = useState('');
    const [colorBy, setColorBy] = useState('folder'); // 'folder' | 'layer' | 'churn' — only meaningful in dependency mode
    const graphCanvasRef = useRef(null);

    const { files, classes, functions, dependencies, graph, healthScore, securityIssues } = analysisResult;

    const filteredSidebarFiles = useMemo(() => {
        if (!sidebarSearch.trim()) return files;
        const q = sidebarSearch.trim().toLowerCase();
        return files.filter((f) => f.path.toLowerCase().includes(q));
    }, [files, sidebarSearch]);

    const layerByPath = useMemo(() => {
        const map = new Map();
        files.forEach((f) => map.set(f.path, f.layer || 'other'));
        return map;
    }, [files]);

    const churnAvailable = useMemo(() => files.some((f) => (f.churn || 0) > 0), [files]);

    const colorKeyFn = useMemo(() => {
        if (graphMode !== 'dependency') return undefined; // undefined = GraphCanvas's default (by folder)
        if (colorBy === 'layer') return (node) => layerByPath.get(node.id) || 'other';
        if (colorBy === 'churn') return undefined; // churn uses a severity ramp, not a hashed palette — see churnKeyFn below
        return undefined; // 'folder' — GraphCanvas's built-in default
    }, [graphMode, colorBy, layerByPath]);

    const churnByPath = useMemo(() => {
        const map = new Map();
        files.forEach((f) => map.set(f.path, f.churn || 0));
        return map;
    }, [files]);
    const maxChurn = useMemo(() => Math.max(1, ...files.map((f) => f.churn || 0)), [files]);

    const churnSeverityFn = useMemo(() => {
        if (graphMode !== 'dependency' || colorBy !== 'churn') return undefined;
        return (node) => (churnByPath.get(node.id) || 0) / maxChurn;
    }, [graphMode, colorBy, churnByPath, maxChurn]);

    const folderGraph = useMemo(() => buildFolderGraph(files, dependencies), [files, dependencies]);
    const activeGraph = graphMode === 'folder' ? folderGraph : graph;

    const filesByFolder = useMemo(() => {
        const map = new Map();
        files.forEach((f) => {
            const idx = f.path.lastIndexOf('/');
            const folder = idx === -1 ? '(root)' : f.path.slice(0, idx);
            if (!map.has(folder)) map.set(folder, []);
            map.get(folder).push(f.path);
        });
        return map;
    }, [files]);

    function handleSelectGraphNode(id) {
        if (graphMode === 'folder') {
            setSelectedFolder(id);
        } else {
            setSelectedPath(id);
        }
    }

    function handleModeChange(mode) {
        setGraphMode(mode);
        setSelectedPath(null);
        setSelectedFolder(null);
    }

    const stats = useMemo(
        () => ({
            files: files.length,
            classes: classes.length,
            methods: functions.length,
            dependencies: dependencies.length,
            links: analysisResult.callGraph?.connections?.length ?? dependencies.length,
            unused: analysisResult.issues?.find((i) => i.title.includes('Unused'))?.items.length || 0,
            loc: files.reduce((sum, f) => sum + (f.loc || 0), 0),
            issues: securityIssues?.length || 0,
        }),
        [files, classes, functions, dependencies, securityIssues, analysisResult.callGraph, analysisResult.issues]
    );

    return (
        <div className="viz-explorer">
            <TopNavBar
                activeWorkspace={activeWorkspace}
                onNavigate={onNavigate}
                onExitRepository={onExitRepository}
            />

            <div className="viz-explorer__body">
                <ResizablePanel side="left" storageKey="viz-explorer-sidebar" defaultWidth={246} minWidth={200} maxWidth={420}>
                    <section className="viz-panel viz-panel--compact">
                        <HealthRing score={healthScore?.score ?? 0} grade={healthScore?.grade || '—'} compact />
                    </section>

                    {graphMode === 'dependency' && (
                        <section className="viz-panel viz-panel--compact">
                            <h3 className="viz-panel__title">Color By</h3>
                            <div className="viz-colorby-list">
                                <button
                                    className={`viz-colorby-row${colorBy === 'folder' ? ' viz-colorby-row--active' : ''}`}
                                    onClick={() => setColorBy('folder')}
                                >
                                    <FolderIcon size={13} strokeWidth={1.8} />
                                    Folder
                                </button>
                                <button
                                    className={`viz-colorby-row${colorBy === 'layer' ? ' viz-colorby-row--active' : ''}`}
                                    onClick={() => setColorBy('layer')}
                                >
                                    <Layers size={13} strokeWidth={1.8} />
                                    Layer
                                </button>
                                <button
                                    className={`viz-colorby-row${colorBy === 'churn' ? ' viz-colorby-row--active' : ''}`}
                                    onClick={() => setColorBy('churn')}
                                    disabled={!churnAvailable}
                                    title={churnAvailable ? undefined : 'Churn needs commit history — only available for GitHub-sourced repositories'}
                                >
                                    <Activity size={13} strokeWidth={1.8} />
                                    Churn
                                </button>
                            </div>
                        </section>
                    )}

                    <section className="viz-panel viz-panel--compact">
                        <div className="stat-grid stat-grid--2col">
                            <div className="stat-box stat-box--sm">
                                <span className="stat-box__value">{stats.files}</span>
                                <span className="stat-box__label">Files</span>
                            </div>
                            <div className="stat-box stat-box--sm">
                                <span className="stat-box__value">{stats.methods}</span>
                                <span className="stat-box__label">Functions</span>
                            </div>
                            <div className="stat-box stat-box--sm">
                                <span className="stat-box__value">{stats.links}</span>
                                <span className="stat-box__label">Links</span>
                            </div>
                            <div className="stat-box stat-box--sm">
                                <span className="stat-box__value">{stats.unused}</span>
                                <span className="stat-box__label">Unused</span>
                            </div>
                        </div>
                    </section>

                    {analysisResult.languageStats?.length > 0 && (
                        <section className="viz-panel viz-panel--compact">
                            <div className="viz-loc">
                                <span className="viz-loc__value">{stats.loc.toLocaleString()}</span>
                                <span className="viz-loc__label">Lines of Code</span>
                            </div>
                            <div className="viz-lang-bar">
                                {analysisResult.languageStats.slice(0, 8).map((l, i) => (
                                    <div
                                        key={l.ext}
                                        className="viz-lang-bar__segment"
                                        style={{ width: `${l.pct}%`, background: LANG_COLORS[i % LANG_COLORS.length] }}
                                        title={`${l.ext} ${l.pct}%`}
                                    />
                                ))}
                            </div>
                            <div className="viz-lang-legend">
                                {analysisResult.languageStats.slice(0, 6).map((l, i) => (
                                    <span key={l.ext} className="viz-lang-legend__item">
                                        <span className="viz-lang-legend__dot" style={{ background: LANG_COLORS[i % LANG_COLORS.length] }} />
                                        {l.ext} {l.pct}%
                                    </span>
                                ))}
                            </div>
                        </section>
                    )}

                    <section className="viz-panel viz-panel--grow">
                        <h3 className="viz-panel__title">Explorer</h3>
                        <div className="viz-search">
                            <Search size={12} strokeWidth={2} />
                            <input
                                type="text"
                                value={sidebarSearch}
                                onChange={(e) => setSidebarSearch(e.target.value)}
                                placeholder="Search files…"
                            />
                        </div>
                        <FolderTree files={filteredSidebarFiles} selectedPath={selectedPath} onSelectFile={setSelectedPath} />
                    </section>
                </ResizablePanel>

                <main className="viz-explorer__graph">
                    <div className="graph-toolbar">
                        <div className="graph-toolbar__modes">
                            <button
                                className={`graph-toolbar__mode-btn${graphMode === 'dependency' ? ' graph-toolbar__mode-btn--active' : ''}`}
                                onClick={() => handleModeChange('dependency')}
                            >
                                <Network size={13} strokeWidth={1.8} />
                                Dependency Graph
                            </button>
                            <button
                                className={`graph-toolbar__mode-btn${graphMode === 'folder' ? ' graph-toolbar__mode-btn--active' : ''}`}
                                onClick={() => handleModeChange('folder')}
                            >
                                <FolderIcon size={13} strokeWidth={1.8} />
                                Folder Graph
                            </button>
                        </div>

                        <select
                            className="graph-toolbar__viz-select"
                            value={vizType}
                            onChange={(e) => setVizType(e.target.value)}
                            title="Visualization type"
                        >
                            <option value="graph">Graph</option>
                            <option value="treemap">Treemap</option>
                            <option value="tree">Tree</option>
                            <option value="cluster">Cluster</option>
                            <option value="matrix">Matrix</option>
                            <option value="bundle">Bundle</option>
                            <option value="flow">Flow</option>
                            <option value="subway">Subway Map</option>
                            <option value="galaxy">Galaxy Map</option>
                        </select>

                        <span className="graph-toolbar__title">
                            {activeGraph.nodes.length} nodes · {activeGraph.edges.length} connections
                        </span>

                        <div className="graph-toolbar__actions">
                            <button title="Zoom out" onClick={() => graphCanvasRef.current?.zoomOut()}>
                                <ZoomOut size={14} strokeWidth={1.8} />
                            </button>
                            <button title="Zoom in" onClick={() => graphCanvasRef.current?.zoomIn()}>
                                <ZoomIn size={14} strokeWidth={1.8} />
                            </button>
                            <button title="Center graph" onClick={() => graphCanvasRef.current?.centerGraph()}>
                                <LocateFixed size={14} strokeWidth={1.8} />
                            </button>
                            <button title="Fit view" onClick={() => graphCanvasRef.current?.fitView()}>
                                <Maximize2 size={14} strokeWidth={1.8} />
                            </button>
                            <button title="Reset view" onClick={() => graphCanvasRef.current?.resetView()}>
                                <RotateCcw size={14} strokeWidth={1.8} />
                            </button>
                            <button title="Export" onClick={() => setExportOpen(true)}>
    <Upload size={14} strokeWidth={1.8} />
</button>
                            <GraphSettingsPanel
                                open={settingsOpen}
                                onToggle={() => setSettingsOpen((v) => !v)}
                                layoutMode={layoutMode}
                                onLayoutModeChange={setLayoutMode}
                                metroSnap={metroSnap}
                                onMetroSnapChange={setMetroSnap}
                                spacingSpread={spacingSpread}
                                onSpacingSpreadChange={setSpacingSpread}
                                spacingLinks={spacingLinks}
                                onSpacingLinksChange={setSpacingLinks}
                                showLabels={showLabels}
                                onShowLabelsChange={setShowLabels}
                                curvedLinks={curvedLinks}
                                onCurvedLinksChange={setCurvedLinks}
                            />
                        </div>
                    </div>
                    <div className="viz-explorer__graph-canvas">
                        {vizType === 'graph' ? (
                            <GraphCanvas
                                ref={graphCanvasRef}
                                key={graphMode}
                                nodes={activeGraph.nodes}
                                edges={activeGraph.edges}
                                selectedNodeId={graphMode === 'folder' ? selectedFolder : selectedPath}
                                onSelectNode={handleSelectGraphNode}
                                showLabels={showLabels}
                                colorKeyFn={colorKeyFn}
                                severityFn={churnSeverityFn}
                                layoutMode={layoutMode}
                                metroSnap={metroSnap}
                                curvedLinks={curvedLinks}
                                spacingSpread={spacingSpread}
                                spacingLinks={spacingLinks}
                            />
                        ) : (
                            <AltVisualizations
                                ref={graphCanvasRef}
                                key={vizType + graphMode}
                                vizType={vizType}
                                files={files}
                                nodes={activeGraph.nodes}
                                edges={activeGraph.edges}
                                issues={analysisResult.issues}
                                selectedNodeId={graphMode === 'folder' ? selectedFolder : selectedPath}
                                onSelectNode={handleSelectGraphNode}
                            />
                        )}
                    </div>
                </main>

                 <ResizablePanel side="right" storageKey="viz-explorer-details" defaultWidth={360} minWidth={280} maxWidth={520}>
                <aside className="viz-explorer__details">
                    {graphMode === 'folder' ? (
                        !selectedFolder ? (
                            <div className="viz-details__empty">
                                Select a folder in the graph to see the files inside it.
                            </div>
                        ) : (
                            <>
                                <div className="viz-details__header">
                                    <div className="viz-details__icon-badge">
                                        <FolderIcon size={16} strokeWidth={1.8} />
                                    </div>
                                    <div>
                                        <h3 className="viz-details__path">{selectedFolder.split('/').pop() || selectedFolder}</h3>
                                        <p className="viz-details__fullpath">{selectedFolder}</p>
                                    </div>
                                </div>
                                <div className="viz-details__section">
                                    <h4>Files ({(filesByFolder.get(selectedFolder) || []).length})</h4>
                                    <ul>
                                        {(filesByFolder.get(selectedFolder) || []).map((path) => (
                                            <li
                                                key={path}
                                                className="viz-details__link"
                                                onClick={() => {
                                                    setGraphMode('dependency');
                                                    setSelectedFolder(null);
                                                    setSelectedPath(path);
                                                }}
                                            >
                                                {path.split('/').pop()}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </>
                        )
                    ) : (
                        <RepositoryPanel
                            analysisResult={analysisResult}
                            selectedPath={selectedPath}
                            onSelectPath={setSelectedPath}
                            onOpenAiExplorerFocused={onOpenAiExplorerFocused}
                        />
                    )}
                </aside>
                </ResizablePanel>
                <ExportModal
    open={exportOpen}
    onClose={() => setExportOpen(false)}
    analysisResult={analysisResult}
    repoMeta={analysisResult.repoMeta}
    graphCanvasRef={graphCanvasRef}
/>
            </div>
        </div>
    );
}

/** Circular health-score ring — pure presentation over the existing healthScore data, no new logic. */
function HealthRing({ score, grade, compact }) {
    const radius = compact ? 22 : 30;
    const size = compact ? 56 : 76;
    const center = size / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (Math.max(0, Math.min(100, score)) / 100) * circumference;
    const gradeClass = `health-ring--${(grade || 'f').charAt(0).toLowerCase()}`;

    return (
        <div className={`health-ring ${gradeClass}${compact ? ' health-ring--compact' : ''}`}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <circle cx={center} cy={center} r={radius} className="health-ring__track" />
                <circle
                    cx={center} cy={center} r={radius}
                    className="health-ring__progress"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    transform={`rotate(-90 ${center} ${center})`}
                />
            </svg>
            <div className="health-ring__label" style={{ width: size, height: size }}>
                <span className="health-ring__grade">{grade}</span>
            </div>
            <div className="health-ring__meta">
                <span className="health-ring__score">{score}/100</span>
                <span className="health-ring__caption">Health Score</span>
            </div>
        </div>
    );
}
