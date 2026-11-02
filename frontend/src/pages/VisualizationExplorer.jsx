import { useState, useMemo, useRef, useEffect } from 'react';
import {
    Activity,
    Maximize2, LocateFixed, RotateCcw, ZoomIn, ZoomOut, Network, Folder as FolderIcon,
    Search, Layers, Upload, Component, ChevronDown,
} from 'lucide-react';

import TopNavBar from '../components/TopNavBar.jsx';
import FolderTree from '../components/FolderTree.jsx';
import GraphCanvas from '../components/GraphCanvas.jsx';
import VisualizationErrorBoundary from '../components/VisualizationErrorBoundary.jsx';
import AltVisualizations from '../components/AltVisualizations.jsx';
import GraphSettingsPanel from '../components/GraphSettingsPanel.jsx';
import ResizablePanel from '../components/ResizablePanel.jsx';
import RepositoryPanel from '../components/RepositoryPanel.jsx';
import './VisualizationExplorer.css';
import ExportModal from '../components/ExportModal.jsx';
import { buildFolderGraph } from '../components/graphData.js';
import { GRAPH_VIEW_OPTIONS, normalizeGraphView } from '../components/graphViews.js';
import { computeChangeImpact } from '../analysis-engine/changeImpact.js';
import { computeGraphOperation } from '../workers/graphOpsClient.js';

const EMPTY_DIAGNOSTICS = Object.freeze({});

const LANG_COLORS = ['#60a5fa', '#a78bfa', '#2dd4bf', '#4ade80', '#fb923c', '#f472b6', '#facc15', '#f87171'];

/**
 * Dependency graph and a pure folder-level projection of its real files
 * and dependency edges. Alternate layouts never imply additional analysis.
 */
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
    // Keep the same selection across Visualization and AI Explorer. Older
    // browser sessions can still contain removed modes; normalize those first.
    const [vizType, setVizType] = useState(() => normalizeGraphView(localStorage.getItem('viz-explorer:vizType')));
    useEffect(() => { localStorage.setItem('viz-explorer:vizType', vizType); }, [vizType]);
    const [selectedFolder, setSelectedFolder] = useState(null);
    const [sidebarSearch, setSidebarSearch] = useState('');
    const [colorBy, setColorBy] = useState('folder'); // 'folder' | 'layer' | 'churn' | 'role' — only meaningful in dependency mode
    const graphCanvasRef = useRef(null);

    const { files, classes, functions, dependencies, graph, healthScore, securityIssues } = analysisResult;

    // Small repositories stay synchronous; large path searches run off-thread.
    const [workerSearch, setWorkerSearch] = useState({ key: '', paths: null });
    const largeSearch = files.length >= 1500 && typeof Worker !== 'undefined';
    const searchKey = `${files.length}:${sidebarSearch.trim().toLowerCase()}`;
    useEffect(() => {
        if (!largeSearch || !sidebarSearch.trim()) return;
        const controller = new AbortController();
        // Short debounce avoids wasting work while the user is still typing.
        const timeout = setTimeout(() => {
            computeGraphOperation({ mode: 'filter', paths: files.map((f) => f.path), needle: sidebarSearch },
                { signal: controller.signal })
                .then((paths) => setWorkerSearch({ key: searchKey, paths }))
                .catch((error) => { if (error.name !== 'AbortError') console.error('[Explorer] search Worker failed:', error); });
        }, 120);
        return () => { clearTimeout(timeout); controller.abort(); };
    }, [files, largeSearch, sidebarSearch, searchKey]);
    const filteredSidebarFiles = useMemo(() => {
        if (!sidebarSearch.trim()) return files;
        if (largeSearch && workerSearch.key === searchKey && workerSearch.paths) {
            const paths = new Set(workerSearch.paths);
            return files.filter((f) => paths.has(f.path));
        }
        if (largeSearch) return []; // pending worker result; never show stale matches
        const q = sidebarSearch.trim().toLowerCase();
        return files.filter((f) => f.path.toLowerCase().includes(q));
    }, [files, sidebarSearch, largeSearch, workerSearch, searchKey]);

    const layerByPath = useMemo(() => {
        const map = new Map();
        files.forEach((f) => map.set(f.path, f.layer || 'other'));
        return map;
    }, [files]);

    // Real: analysis-engine/roles.js classifies each file's architectural
    // role (Controller/Service/Repository/etc.) from framework annotations
    // or naming convention — folder-independent, unlike "Folder" colorBy.
    const roleByPath = useMemo(() => {
        const map = new Map();
        const roles = analysisResult.roles || {};
        Object.entries(roles).forEach(([path, r]) => map.set(path, r.role || 'Other'));
        return map;
    }, [analysisResult.roles]);

    const churnAvailable = useMemo(() => files.some((f) => (f.churn || 0) > 0), [files]);

    const impactDiagnostics = analysisResult.analysisCoverage?.dependencyResolution || EMPTY_DIAGNOSTICS;
    const impactCoverageStatus = analysisResult.analysisCoverage?.status || 'unknown';
    const [backgroundImpact, setBackgroundImpact] = useState({ path: null, result: null });
    const useBackgroundImpact = dependencies.length >= 1500 && typeof Worker !== 'undefined';
    useEffect(() => {
        if (!useBackgroundImpact || !selectedPath || graphMode !== 'dependency') return;
        const controller = new AbortController();
        computeGraphOperation({ mode: 'impact', path: selectedPath, dependencies,
            diagnostics: { ...impactDiagnostics, coverageStatus: impactCoverageStatus } },
            { signal: controller.signal })
            .then((result) => setBackgroundImpact({ path: selectedPath, result }))
            .catch((error) => { if (error.name !== 'AbortError') console.error('[Explorer] impact Worker failed:', error); });
        return () => controller.abort();
    }, [useBackgroundImpact, selectedPath, graphMode, dependencies, impactDiagnostics, impactCoverageStatus]);
    const selectedChangeImpact = useMemo(() => {
        if (!selectedPath || graphMode !== 'dependency') return null;
        if (useBackgroundImpact) return backgroundImpact.path === selectedPath ? backgroundImpact.result : null;
        return computeChangeImpact(selectedPath, dependencies, {
            ...impactDiagnostics, coverageStatus: impactCoverageStatus,
        });
    }, [selectedPath, graphMode, dependencies, impactDiagnostics, impactCoverageStatus, useBackgroundImpact, backgroundImpact]);

    const colorKeyFn = useMemo(() => {
        if (graphMode !== 'dependency') return undefined; // undefined = GraphCanvas's default (by folder)
        if (colorBy === 'layer') return (node) => layerByPath.get(node.id) || 'other';
        if (colorBy === 'role') return (node) => roleByPath.get(node.id) || 'Other';
        if (colorBy === 'churn') return undefined; // churn uses a severity ramp, not a hashed palette — see churnKeyFn below
        return undefined; // 'folder' — GraphCanvas's built-in default
    }, [graphMode, colorBy, layerByPath, roleByPath]);

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

    const [offthreadFolderGraph, setOffthreadFolderGraph] = useState(null);
    const needsFolderWorker = dependencies.length >= 1500 && typeof Worker !== 'undefined';
    useEffect(() => {
        if (!needsFolderWorker) return;
        const controller = new AbortController();
        computeGraphOperation({ mode: 'folders', files: files.map((f) => ({ path: f.path })),
            dependencies: dependencies.map((d) => ({ source: d.source, target: d.target })) },
            { signal: controller.signal })
            .then(setOffthreadFolderGraph)
            .catch((error) => { if (error.name !== 'AbortError') console.error('[Explorer] folder Worker failed:', error); });
        return () => controller.abort();
    }, [needsFolderWorker, files, dependencies]);
    const folderGraph = useMemo(() => needsFolderWorker
        ? (offthreadFolderGraph || { nodes: [], edges: [] })
        : buildFolderGraph(files, dependencies), [files, dependencies, needsFolderWorker, offthreadFolderGraph]);
    const activeGraph = graphMode === 'folder' ? folderGraph : (graph || { nodes: [], edges: [] });

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
        if (mode === 'folder') setVizType('graph'); // folder nodes must not be mistaken for source-file nodes in alternate views
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
                        <HealthRing score={healthScore?.score ?? null} grade={healthScore?.grade || '—'} compact />
                    </section>

                    <AnalysisCoveragePanel coverage={analysisResult.analysisCoverage} healthScoreDetails={analysisResult.healthScoreDetails} analysisCache={analysisResult.analysisCache} dataFlow={analysisResult.dataFlow} testLinkage={analysisResult.testLinkage} />
                    {useBackgroundImpact && selectedPath && graphMode === 'dependency' && !selectedChangeImpact && (
                        <div role="status" className="viz-panel">Computing change impact from repository dependencies…</div>
                    )}
                    {largeSearch && sidebarSearch.trim() && workerSearch.key !== searchKey && (
                        <div role="status" className="viz-panel">Searching repository paths…</div>
                    )}
                    {selectedChangeImpact && (
                        <ChangeImpactPanel impact={selectedChangeImpact} selectedPath={selectedPath} onSelectFile={setSelectedPath} />
                    )}
                    {selectedPath && (analysisResult.testLinkage?.bySource?.[selectedPath] || []).length > 0 && (
                        <TestLinkagePanel links={analysisResult.testLinkage.bySource[selectedPath]} selectedPath={selectedPath} onSelectFile={setSelectedPath} />
                    )}
                    {selectedPath && (analysisResult.dataFlow?.flows || []).some((flow) => flow.source.path === selectedPath || flow.sink.path === selectedPath) && (
                        <DataFlowPanel flows={(analysisResult.dataFlow.flows || []).filter((flow) => flow.source.path === selectedPath || flow.sink.path === selectedPath)} selectedPath={selectedPath} />
                    )}

                    {graphMode === 'dependency' && (
                        <section className="viz-panel viz-panel--compact">
                            <h3 className="viz-panel__title">Color By</h3>
                            {vizType !== 'graph' && (
                                <p className="viz-colorby-hint">Only affects the <strong>Dependency Graph</strong> view — picking one switches you there.</p>
                            )}
                            <div className="viz-colorby-list">
                                <button
                                    className={`viz-colorby-row${colorBy === 'folder' ? ' viz-colorby-row--active' : ''}`}
                                    onClick={() => { setColorBy('folder'); setVizType('graph'); }}
                                >
                                    <FolderIcon size={13} strokeWidth={1.8} />
                                    Folder
                                </button>
                                <button
                                    className={`viz-colorby-row${colorBy === 'layer' ? ' viz-colorby-row--active' : ''}`}
                                    onClick={() => { setColorBy('layer'); setVizType('graph'); }}
                                >
                                    <Layers size={13} strokeWidth={1.8} />
                                    Layer
                                </button>
                                <button
                                    className={`viz-colorby-row${colorBy === 'role' ? ' viz-colorby-row--active' : ''}`}
                                    onClick={() => { setColorBy('role'); setVizType('graph'); }}
                                    disabled={!analysisResult.roles || Object.keys(analysisResult.roles).length === 0}
                                    title="Controller/Service/Repository/etc. — detected from framework annotations or naming convention, folder-independent"
                                >
                                    <Component size={13} strokeWidth={1.8} />
                                    Role
                                </button>
                                <button
                                    className={`viz-colorby-row${colorBy === 'churn' ? ' viz-colorby-row--active' : ''}`}
                                    onClick={() => { setColorBy('churn'); setVizType('graph'); }}
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

                    <details className="viz-panel viz-panel--grow viz-accordion viz-accordion--explorer" open>
                        <summary className="viz-accordion__summary">
                            <h3 className="viz-panel__title">Explorer</h3>
                            <ChevronDown size={16} className="viz-accordion__chevron" aria-hidden="true" />
                        </summary>
                        <div className="viz-accordion__body viz-accordion__body--explorer">
                        <div className="viz-search">
                            <Search size={12} strokeWidth={2} />
                            <input
                                type="text"
                                value={sidebarSearch}
                                onChange={(e) => setSidebarSearch(e.target.value)}
                                placeholder="Search files…"
                            />
                        </div>
                        <FolderTree files={filteredSidebarFiles} selectedPath={selectedPath} onSelectFile={setSelectedPath} expandAll={Boolean(sidebarSearch.trim())} />
                        </div>
                    </details>
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
                            value={graphMode === 'folder' ? 'graph' : vizType}
                            disabled={graphMode === 'folder'}
                            onChange={(e) => setVizType(normalizeGraphView(e.target.value))}
                            title={graphMode === 'folder' ? 'Folder graph uses the file-folder renderer' : 'Visualization type'}
                        >
                            {GRAPH_VIEW_OPTIONS.map(({ value, label }) => (
                                <option key={value} value={value}>{label}</option>
                            ))}
                        </select>

                        <span className="graph-toolbar__title">
                            {activeGraph.nodes.length} nodes · {activeGraph.edges.length} connections
                        </span>

                        <div className="graph-toolbar__actions">
                            <button title={vizType === 'graph' ? 'Zoom out' : 'Zoom available in Graph mode'} disabled={vizType !== 'graph'} onClick={() => graphCanvasRef.current?.zoomOut()}>
                                <ZoomOut size={14} strokeWidth={1.8} />
                            </button>
                            <button title={vizType === 'graph' ? 'Zoom in' : 'Zoom available in Graph mode'} disabled={vizType !== 'graph'} onClick={() => graphCanvasRef.current?.zoomIn()}>
                                <ZoomIn size={14} strokeWidth={1.8} />
                            </button>
                            <button title="Center graph" disabled={vizType !== 'graph'} onClick={() => graphCanvasRef.current?.centerGraph()}>
                                <LocateFixed size={14} strokeWidth={1.8} />
                            </button>
                            <button title="Fit view" disabled={vizType !== 'graph'} onClick={() => graphCanvasRef.current?.fitView()}>
                                <Maximize2 size={14} strokeWidth={1.8} />
                            </button>
                            <button title="Reset view" disabled={vizType !== 'graph'} onClick={() => graphCanvasRef.current?.resetView()}>
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
                        <VisualizationErrorBoundary key={`${graphMode}:${vizType}`} onReset={() => { setGraphMode('dependency'); setVizType('graph'); }}>
                        {activeGraph.nodes.length === 0 ? (
                            <div className="viz-graph-empty" role="status">No graph nodes were produced for this repository. Check analysis coverage or upload a repository containing supported source files.</div>
                        ) : vizType === 'graph' ? (
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
                        </VisualizationErrorBoundary>
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
                                <details className="viz-details__section viz-accordion viz-accordion--folder-files" open>
                                    <summary className="viz-accordion__summary">
                                        <h4>Files ({(filesByFolder.get(selectedFolder) || []).length})</h4>
                                        <ChevronDown size={16} className="viz-accordion__chevron" aria-hidden="true" />
                                    </summary>
                                    <div className="viz-accordion__body">
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
                                </details>
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

function AnalysisCoveragePanel({ coverage, healthScoreDetails, analysisCache, dataFlow, testLinkage }) {
    if (!coverage) return null;
    const fileStats = coverage.files || {};
    const dependencyStats = coverage.dependencyResolution || {};
    const failedStages = Object.entries(coverage.stages || {})
        .filter(([, stage]) => stage.status === 'failed' || stage.status === 'partial')
        .map(([name]) => name);
    const isPartial = coverage.status !== 'complete';

    return (
        <details className="viz-panel viz-panel--compact viz-coverage viz-coverage--collapsible" aria-label="Analysis coverage">
            <summary className="viz-coverage__heading" title="Expand or collapse analysis coverage">
                <h3 className="viz-panel__title">Analysis coverage</h3>
                <span className="viz-coverage__heading-actions">
                    <span className={`viz-coverage__badge${isPartial ? ' viz-coverage__badge--partial' : ''}`}>
                        {isPartial ? 'Partial' : 'Completed'}
                    </span>
                    <ChevronDown className="viz-coverage__chevron" size={16} aria-hidden="true" />
                </span>
            </summary>
            <div className="viz-coverage__content">
            <div className="viz-coverage__stats">
                <div><strong>{fileStats.discovered ?? 0}</strong><span>Files found</span></div>
                <div><strong>{fileStats.extractionCompleted ?? 0}/{fileStats.codeFiles ?? fileStats.discovered ?? 0}</strong><span>Code files extracted</span></div>
                <div><strong>{fileStats.complexityFailed ?? 0}</strong><span>Complexity failures</span></div>
            </div>
            {coverage.parserCoverage && (
                <div className="viz-coverage__issues">
                    <span>Parser strategy</span>
                    <p>
                        {coverage.parserCoverage.astPreferredFiles ?? 0} AST-parsed, {coverage.parserCoverage.heuristicParserFiles ?? 0} heuristic, {coverage.parserCoverage.nonCodeFilesSkipped ?? 0} non-code skipped.
                    </p>
                </div>
            )}
            {analysisCache?.enabled && (
                <div className="viz-coverage__issues">
                    <span>Repeated-analysis cache</span>
                    <p>{analysisCache.extractionHits ?? 0} extraction and {analysisCache.complexityHits ?? 0} complexity result(s) reused; {analysisCache.entries ?? 0} cached file record(s) in this browser session.</p>
                </div>
            )}
            {dataFlow?.summary && (
                <div className="viz-coverage__issues">
                    <span>Heuristic data-flow scan</span>
                    <p>{dataFlow.summary.potentialFlows ?? 0} potential source-to-sink signal(s) across {dataFlow.summary.filesWithSourceOrSink ?? 0} file(s). These are review leads, not confirmed vulnerabilities.</p>
                </div>
            )}
            {testLinkage && (
                <div className="viz-coverage__issues">
                    <span>Test file linkage</span>
                    <p>{testLinkage.linkedTestFileCount ?? 0}/{testLinkage.testFileCount ?? 0} test file(s) linked to source by import/reference or naming signals; this is not test coverage or pass status.</p>
                </div>
            )}
            {(coverage.statusReasons || []).length > 0 && (
                <div className="viz-coverage__issues">
                    <span>Why analysis is partial</span>
                    <ul>{coverage.statusReasons.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}</ul>
                </div>
            )}
            {((dependencyStats.unresolvedLocalImports || []).length > 0 || (dependencyStats.ambiguousImports || []).length > 0) && (
                <div className="viz-coverage__issues">
                    <span>Dependency resolution</span>
                    <p>{(dependencyStats.unresolvedLocalImports || []).length} unresolved local import(s), {(dependencyStats.ambiguousImports || []).length} ambiguous import(s)</p>
                </div>
            )}
            {coverage.callGraph && (coverage.callGraph.totalCallNameReferences > 0 || coverage.callGraph.unresolvedCallCount > 0 || coverage.callGraph.ambiguousCallCount > 0) && (
                <div className="viz-coverage__issues">
                    <span>Call graph resolution</span>
                    <p>{coverage.callGraph.resolvedCallNameReferences}/{coverage.callGraph.totalCallNameReferences} call references resolved; {coverage.callGraph.unresolvedCallCount} unresolved and {coverage.callGraph.ambiguousCallCount} ambiguous.</p>
                </div>
            )}
            {failedStages.length > 0 && (
                <div className="viz-coverage__issues">
                    <span>Incomplete stages</span>
                    <p>{failedStages.join(', ')}</p>
                </div>
            )}
            <p className="viz-coverage__note">
                Pass completion does not guarantee full semantic understanding. Check unresolved or unsupported constructs before relying on findings.
            </p>
            {healthScoreDetails && (
                <details className="viz-coverage__methodology">
                    <summary>How the health score is calculated</summary>
                    <p>{healthScoreDetails.kind === 'unavailable' ? 'The score is unavailable because its calculation failed.' : 'The current score is heuristic, not a probability of repository health.'}</p>
                    <ul>
                        {Object.entries(healthScoreDetails.penalties || {}).map(([name, value]) => (
                            <li key={name}>{name.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase())}: −{value}</li>
                        ))}
                    </ul>
                    <p>It does not directly measure test execution, runtime behavior, deployment reliability, type correctness or vulnerability exploitability.</p>
                </details>
            )}
            </div>
        </details>
    );
}

function ChangeImpactPanel({ impact, selectedPath, onSelectFile }) {
    const preview = impact.affectedFiles.slice(0, 6);
    return (
        <details className="viz-panel viz-panel--compact viz-coverage viz-coverage--collapsible" aria-label="Change impact estimate">
            <summary className="viz-coverage__heading" title="Expand or collapse potential change impact">
                <h3 className="viz-panel__title">Potential change impact</h3>
                <span className="viz-coverage__heading-actions">
                    <span className={`viz-coverage__badge${impact.completeness === 'partial' ? ' viz-coverage__badge--partial' : ''}`}>
                        {impact.completeness === 'partial' ? 'Incomplete' : 'Known edges'}
                    </span>
                    <ChevronDown className="viz-coverage__chevron" size={16} aria-hidden="true" />
                </span>
            </summary>
            <div className="viz-coverage__content">
            <p className="viz-coverage__note">For changes to <strong>{selectedPath}</strong></p>
            <div className="viz-coverage__stats">
                <div><strong>{impact.directDependents.length}</strong><span>Direct dependents</span></div>
                <div><strong>{impact.transitiveDependents.length}</strong><span>Transitive</span></div>
                <div><strong>{impact.affectedFiles.length}</strong><span>Total affected</span></div>
            </div>
            {preview.length > 0 ? (
                <div className="viz-coverage__issues">
                    <span>Potentially affected files</span>
                    <ul>
                        {preview.map((item) => (
                            <li key={item.path}>
                                <button type="button" className="viz-impact__file" onClick={() => onSelectFile(item.path)} title="Focus this file in the explorer">
                                    {item.path}
                                </button>
                                <small> · {item.relationship}, {item.confidence} confidence</small>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : (
                <p className="viz-coverage__note">No dependents were found in the currently known graph. This does not prove there are none.</p>
            )}
            {impact.uncertainty.notes.length > 0 && (
                <div className="viz-coverage__issues"><span>Limitations</span><ul>{impact.uncertainty.notes.map((note) => <li key={note}>{note}</li>)}</ul></div>
            )}
            <p className="viz-coverage__note">Impact is an estimate from known dependency edges, not a guarantee of breakage.</p>
            </div>
        </details>
    );
}

function TestLinkagePanel({ links, selectedPath, onSelectFile }) {
    const preview = links.slice(0, 8);
    return (
        <details className="viz-panel viz-panel--compact viz-coverage viz-coverage--collapsible" aria-label="Related test files">
            <summary className="viz-coverage__heading" title="Expand or collapse related tests">
                <h3 className="viz-panel__title">Related tests</h3>
                <span className="viz-coverage__heading-actions">
                    <span className="viz-coverage__badge">{links.length}</span>
                    <ChevronDown className="viz-coverage__chevron" size={16} aria-hidden="true" />
                </span>
            </summary>
            <div className="viz-coverage__content">
            <p className="viz-coverage__note">Potential test links for <strong>{selectedPath}</strong></p>
            <div className="viz-coverage__issues">
                <ul>
                    {preview.map((link) => (
                        <li key={link.testFile}>
                            <button type="button" className="viz-impact__file" onClick={() => onSelectFile(link.testFile)} title="Select linked test file">
                                {link.testFile}
                            </button>
                            <small> · {link.relationship}, {link.confidence} confidence</small>
                        </li>
                    ))}
                </ul>
            </div>
            {links.length > preview.length && <p className="viz-coverage__note">Showing {preview.length} of {links.length} linked test files.</p>}
            <p className="viz-coverage__note">A link means an import/reference or filename convention was found. It does not prove test coverage, assertions, or that the test passes.</p>
            </div>
        </details>
    );
}

function DataFlowPanel({ flows, selectedPath }) {
    return (
        <details className="viz-panel viz-panel--compact viz-coverage viz-coverage--collapsible" aria-label="Potential source-to-sink flows">
            <summary className="viz-coverage__heading" title="Expand or collapse potential data flows">
                <h3 className="viz-panel__title">Potential data flows</h3>
                <span className="viz-coverage__heading-actions">
                    <span className="viz-coverage__badge viz-coverage__badge--partial">Heuristic</span>
                    <ChevronDown className="viz-coverage__chevron" size={16} aria-hidden="true" />
                </span>
            </summary>
            <div className="viz-coverage__content">
            <p className="viz-coverage__note">Same-file source-to-sink signals in <strong>{selectedPath}</strong></p>
            <div className="viz-coverage__issues">
                <ul>
                    {flows.slice(0, 6).map((flow) => (
                        <li key={flow.id}>
                            {flow.source.kind} · line {flow.source.line} → {flow.sink.kind} · line {flow.sink.line}
                        </li>
                    ))}
                </ul>
            </div>
            <p className="viz-coverage__note">Low-confidence leads only. This scan does not model sanitizers, scopes, control flow, or interprocedural paths and does not confirm a vulnerability.</p>
            </div>
        </details>
    );
}

/** Circular health-score ring — pure presentation over the existing healthScore data, no new logic. */
function HealthRing({ score, grade, compact }) {
    const radius = compact ? 22 : 30;
    const size = compact ? 56 : 76;
    const center = size / 2;
    const circumference = 2 * Math.PI * radius;
    const scoreAvailable = typeof score === 'number' && Number.isFinite(score);
    const numericScore = scoreAvailable ? score : 0;
    const offset = circumference - (Math.max(0, Math.min(100, numericScore)) / 100) * circumference;
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
                <span className="health-ring__score">{scoreAvailable ? score : '—'}/100</span>
                <span className="health-ring__caption">Health Score</span>
            </div>
        </div>
    );
}