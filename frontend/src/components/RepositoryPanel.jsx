import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    Search, X, Eye, ChevronDown, ChevronRight,
    ShieldAlert, Split, Copy, Layers as LayersIcon, Link2, FlaskConical, Copy as Copy2Icon,
    FileCode2, Link as ConnLink, Zap, AlertTriangle, MessageSquareCode,
} from 'lucide-react';

import { calcBlast } from '../analysis-engine/parser.js';
import { buildSuggestions } from '../analysis-engine/suggestions.js';
import { highlightSyntax } from './highlightSyntax.js';
import './RepositoryPanel.css';

const ACTION_ICONS = {
    shield: ShieldAlert, split: Split, copy: Copy, layers: LayersIcon,
    link: Link2, copy2: Copy2Icon, flask: FlaskConical,
};

/**
 *Issues / Patterns / Security / Actions tabs,
 * plus a File tab (shown in place of Issues once a graph node is selected)
 * with Impact Analysis (calcBlast), Connections, and Functions. Reads
 * directly off `analysisResult` — no new analysis.
 */
export default function RepositoryPanel({ analysisResult, selectedPath, onSelectPath, onOpenAiExplorerFocused }) {
    const [tab, setTab] = useState('issues'); // 'issues' | 'file' | 'patterns' | 'security' | 'actions'
    const [issueQuery, setIssueQuery] = useState('');
    const [modal, setModal] = useState(null); // { kind: 'issue'|'pattern'|'duplicate', data }
    const [sourceView, setSourceView] = useState(null); // { path, line }
    const [connectionsOpen, setConnectionsOpen] = useState(true);
    const [functionsOpen, setFunctionsOpen] = useState(true);
    const [expandedFn, setExpandedFn] = useState(null);
     const [expandedPatterns, setExpandedPatterns] = useState(new Set()); // multiple patterns can stay open at once
    const { files, functions, issues = [], patterns = [], securityIssues = [], duplicates = [] } = analysisResult;
    const connections = analysisResult.callGraph?.connections || [];
    const fnStats = analysisResult.callGraph?.fnStats || {};

    const suggestions = useMemo(
        () => buildSuggestions({ issues, securityIssues, duplicates, files }),
        [issues, securityIssues, duplicates, files]
    );

    const activeTab = selectedPath && tab !== 'patterns' && tab !== 'security' && tab !== 'actions' ? 'file' : tab;

    function selectFile(path) {
        onSelectPath(path);
        setTab('issues'); // reset so leaving the file view later lands back on Issues, not a stale tab
    }
    function backToIssues() {
        onSelectPath(null);
        setTab('issues');
    }

    const filteredIssues = useMemo(() => {
        if (!issueQuery.trim()) return issues;
        const q = issueQuery.trim().toLowerCase();
        return issues.filter((i) => i.title.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q));
    }, [issues, issueQuery]);

    const fileDetail = useMemo(() => {
        if (!selectedPath) return null;
        const file = files.find((f) => f.path === selectedPath);
        if (!file) return null;
        const blast = calcBlast(selectedPath, connections, files);
        const fileFunctions = functions.filter((fn) => fn.file === selectedPath);
        // "Connections > Uses" — files that call functions defined in this file, with a
        // per-file count of *distinct* functions of this file they use (matches CodeFlow's
        // "N fn" badge). Same underlying data as blast.affected, grouped for the fn count.
        const usesByFile = new Map();
        connections
            .filter((c) => c.source === selectedPath)
            .forEach((c) => {
                if (!usesByFile.has(c.target)) usesByFile.set(c.target, new Set());
                usesByFile.get(c.target).add(c.fn);
            });
        return { file, blast, fileFunctions, uses: [...usesByFile.entries()].map(([path, fns]) => ({ path, fnCount: fns.size })) };
    }, [selectedPath, files, functions, connections]);

    return (
        <div className="repo-panel">
            <div className="repo-panel__tabs">
                {selectedPath ? (
                    <button className={`repo-panel__tab${activeTab === 'file' ? ' repo-panel__tab--active' : ''}`} onClick={() => setTab('issues')}>
                        <FileCode2 size={13} strokeWidth={1.8} /> File
                    </button>
                ) : (
                    <button className={`repo-panel__tab${activeTab === 'issues' ? ' repo-panel__tab--active' : ''}`} onClick={() => setTab('issues')}>
                        <Search size={13} strokeWidth={1.8} /> Issues
                        {issues.length > 0 && <span className="repo-panel__tab-count">{issues.length}</span>}
                    </button>
                )}
                <button className={`repo-panel__tab${activeTab === 'patterns' ? ' repo-panel__tab--active' : ''}`} onClick={() => setTab('patterns')}>
                    Patterns
                    {patterns.length > 0 && <span className="repo-panel__tab-count">{patterns.length}</span>}
                </button>
                <button className={`repo-panel__tab${activeTab === 'security' ? ' repo-panel__tab--active' : ''}`} onClick={() => setTab('security')}>
                    Security
                    {securityIssues.length > 0 && <span className="repo-panel__tab-count">{securityIssues.length}</span>}
                </button>
                <button className={`repo-panel__tab${activeTab === 'actions' ? ' repo-panel__tab--active' : ''}`} onClick={() => setTab('actions')}>
                    Actions
                    {suggestions.length > 0 && <span className="repo-panel__tab-count repo-panel__tab-count--accent">{suggestions.length}</span>}
                </button>
            </div>

            <div className="repo-panel__body">
                {activeTab === 'issues' && (
                    <>
                        <div className="repo-panel__search">
                            <Search size={12} strokeWidth={2} />
                            <input value={issueQuery} onChange={(e) => setIssueQuery(e.target.value)} placeholder="Search issues…" />
                        </div>
                        <h4 className="repo-panel__section-title">Architecture Issues ({issues.length})</h4>
                        {filteredIssues.length === 0 && <div className="repo-panel__empty">No issues found.</div>}
                        {filteredIssues.map((issue) => (
                            <button key={issue.title} className={`repo-panel__card repo-panel__card--${issue.type}`} onClick={() => setModal({ kind: 'issue', data: issue })}>
                                <span className="repo-panel__card-dot" />
                                <div>
                                    <div className="repo-panel__card-title">{issue.title}</div>
                                    <div className="repo-panel__card-desc">{issue.desc}</div>
                                    <div className="repo-panel__card-link">Click for details ({issue.items.length} items) →</div>
                                </div>
                            </button>
                        ))}
                    </>
                )}

                {activeTab === 'patterns' && (
                    <>
                        {patterns.length === 0 && <div className="repo-panel__empty">No patterns detected.</div>}
                        {patterns.map((p) => {
                            const isOpen = expandedPatterns.has(p.name);
                            const toggle = () => {
                                setExpandedPatterns((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(p.name)) next.delete(p.name);
                                    else next.add(p.name);
                                    return next;
                                });
                            };
                            return (
                                <div key={p.name} className="repo-panel__collapsible">
                                    <button className="repo-panel__collapsible-head" onClick={toggle}>
                                        {isOpen ? <ChevronDown size={14} strokeWidth={1.8} /> : <ChevronRight size={14} strokeWidth={1.8} />}
                                        {p.name}
                                        <span className="repo-panel__count-pill">{p.files.length}</span>
                                    </button>
                                    {isOpen && (
                                        <div className="repo-panel__collapsible-body">
                                            <p className="repo-panel__modal-desc">{p.desc}</p>
                                            {p.files.map((f, i) => (
                                                <div key={i} className="repo-panel__modal-item">
                                                    <div>
                                                        <div className="repo-panel__modal-item-name">{f.name}</div>
                                                        <div className="repo-panel__modal-item-file">{f.path}</div>
                                                    </div>
                                                    <button className="repo-panel__view-btn" onClick={() => setSourceView({ path: f.path })}>
                                                        <Eye size={13} strokeWidth={1.8} /> View
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </>
                )}

                {activeTab === 'security' && (
                    <>
                        {securityIssues.length === 0 && <div className="repo-panel__empty">No security issues found.</div>}
                        {securityIssues.map((s, i) => (
                            <button key={i} className="repo-panel__sec-row" onClick={() => setModal({ kind: 'security', data: s })}>
                                <div className="repo-panel__sec-title">{s.title}</div>
                                <div className="repo-panel__sec-file">{s.file}</div>
                                {s.line != null && <div className="repo-panel__sec-line">Line {s.line}</div>}
                            </button>
                        ))}
                    </>
                )}

                {activeTab === 'actions' && (
                    <>
                        <h4 className="repo-panel__section-title">Actionable Suggestions</h4>
                        <p className="repo-panel__section-sub">Prioritized recommendations based on your codebase analysis</p>
                        {suggestions.map((s) => {
                            const Icon = ACTION_ICONS[s.icon] || Zap;
                            return (
                                <div key={s.title} className={`repo-panel__action repo-panel__action--${s.priority.toLowerCase()}`}>
                                    <div className="repo-panel__action-head">
                                        <Icon size={15} strokeWidth={1.8} />
                                        <span className="repo-panel__action-title">{s.title}</span>
                                        <span className={`repo-panel__badge repo-panel__badge--${s.priority.toLowerCase()}`}>{s.priority}</span>
                                    </div>
                                    <p className="repo-panel__action-desc">{s.desc}</p>
                                    <div className="repo-panel__action-box">Action: {s.action}</div>
                                    <p className="repo-panel__action-benefit"><Zap size={11} strokeWidth={2} /> {s.benefit}</p>
                                </div>
                            );
                        })}

                        {duplicates.length > 0 && (
                            <>
                                <h4 className="repo-panel__section-title repo-panel__section-title--spaced">
                                    Duplicate Functions ({duplicates.length})
                                </h4>
                                {duplicates.map((d, i) => (
                                    <button key={i} className="repo-panel__dup-row" onClick={() => setModal({ kind: 'duplicate', data: d })}>
                                        <span className={`repo-panel__dup-label repo-panel__dup-label--${d.type}`}>
                                            {d.type === 'name' ? 'Same Name:' : 'Similar Code:'}
                                        </span>{' '}
                                        {d.name}
                                        <div className="repo-panel__card-link">Click for details ({d.files.length} locations) →</div>
                                    </button>
                                ))}
                            </>
                        )}
                    </>
                )}

                {activeTab === 'file' && fileDetail && (
                    <FileDetailView
                        detail={fileDetail}
                        fnStats={fnStats}
                        onBack={backToIssues}
                        onSelectFile={selectFile}
                        onViewSource={(path, line) => setSourceView({ path, line })}
                        onOpenAiExplorerFocused={onOpenAiExplorerFocused}
                        connectionsOpen={connectionsOpen}
                        setConnectionsOpen={setConnectionsOpen}
                        functionsOpen={functionsOpen}
                        setFunctionsOpen={setFunctionsOpen}
                        expandedFn={expandedFn}
                        setExpandedFn={setExpandedFn}
                    />
                )}
            </div>

            {/* Portal to document.body: .viz-explorer__details (this panel's ancestor) has
                backdrop-filter, which creates a CSS containing block for position:fixed
                descendants — without the portal, these overlays render "fixed" relative to
                that narrow panel instead of the actual viewport, which is why the source
                card was appearing docked to the right instead of centered on screen. */}
            {modal && createPortal(
                <DetailModal modal={modal} onClose={() => setModal(null)} onViewSource={(path, line) => setSourceView({ path, line })} />,
                document.body
            )}
            {sourceView && createPortal(
                <SourceViewModal
                    path={sourceView.path}
                    line={sourceView.line}
                    files={files}
                    onClose={() => setSourceView(null)}
                />,
                document.body
            )}
        </div>
    );
}

function FileDetailView({ detail, fnStats, onBack, onSelectFile, onViewSource, onOpenAiExplorerFocused, connectionsOpen, setConnectionsOpen, functionsOpen, setFunctionsOpen, expandedFn, setExpandedFn }) {
    const { file, blast, fileFunctions, uses } = detail;
    const levelLabel = blast.level.toUpperCase();

    function openAiExplorer() {
        onOpenAiExplorerFocused?.({
            selectedNode: file.path,
            directDependencies: [...blast.affected, ...blast.dependencies],
        });
    }

    return (
        <>
            <button className="repo-panel__back" onClick={onBack}>← Back to Issues</button>

            <div className="repo-panel__file-header">
                <div>
                    <div className="repo-panel__file-name">
                        <FileCode2 size={14} strokeWidth={1.8} /> {file.path.split('/').pop()}
                    </div>
                    <div className="repo-panel__file-meta">
                        {file.path.split('/').slice(0, -1).join('/') || '(root)'} · {file.loc} lines
                        {file.complexity ? ` · Complexity: ${file.complexity.score}` : ''}
                    </div>
                </div>
                <button className="repo-panel__view-source-btn" onClick={() => onViewSource(file.path)}>
                    <Eye size={13} strokeWidth={1.8} /> View Source
                </button>
            </div>

            <div className="repo-panel__impact">
                <div className="repo-panel__impact-head">
                    <Zap size={13} strokeWidth={1.8} /> Impact Analysis
                    <span className={`repo-panel__badge repo-panel__badge--${blast.level}`}>{levelLabel}</span>
                </div>
                <div className="repo-panel__impact-grid">
                    <div className="stat-box stat-box--sm"><span className="stat-box__value">{blast.count}</span><span className="stat-box__label">Direct Dependents</span></div>
                    <div className="stat-box stat-box--sm"><span className="stat-box__value">{blast.transitiveCount}</span><span className="stat-box__label">Transitive</span></div>
                    <div className="stat-box stat-box--sm"><span className="stat-box__value">{blast.fnsUsed}</span><span className="stat-box__label">Fns Exported</span></div>
                    <div className="stat-box stat-box--sm"><span className="stat-box__value">{blast.dependencies.length}</span><span className="stat-box__label">Dependencies</span></div>
                </div>
                <p className="repo-panel__impact-summary">
                    {blast.count} file{blast.count === 1 ? '' : 's'} directly depend on this file · {blast.fnsUsed} function{blast.fnsUsed === 1 ? '' : 's'} used {blast.totalCalls} times
                </p>
                {blast.affected.length > 0 && (
                    <>
                        <div className="repo-panel__impact-label">Files that import from this:</div>
                        <ul className="repo-panel__file-list">
                            {blast.affected.slice(0, 8).map((path) => (
                                <li key={path} onClick={() => onSelectFile(path)}>{path.split('/').pop()}</li>
                            ))}
                        </ul>
                        {blast.affected.length > 8 && <div className="repo-panel__more">+{blast.affected.length - 8} more</div>}
                    </>
                )}
            </div>

            <div className="repo-panel__collapsible">
                <button className="repo-panel__collapsible-head" onClick={() => setConnectionsOpen((v) => !v)}>
                    {connectionsOpen ? <ChevronDown size={14} strokeWidth={1.8} /> : <ChevronRight size={14} strokeWidth={1.8} />}
                    <ConnLink size={13} strokeWidth={1.8} /> Connections
                    <span className="repo-panel__count-pill">{uses.length}</span>
                </button>
                {connectionsOpen && (
                    <div className="repo-panel__collapsible-body">
                        <div className="repo-panel__uses-label">Uses ({uses.length} files)</div>
                        {uses.map((u) => (
                            <div key={u.path} className="repo-panel__conn-row" onClick={() => onSelectFile(u.path)}>
                                <FileCode2 size={13} strokeWidth={1.8} /> {u.path.split('/').pop()}
                                <span className="repo-panel__fn-pill">{u.fnCount} fn</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="repo-panel__collapsible">
                <button className="repo-panel__collapsible-head" onClick={() => setFunctionsOpen((v) => !v)}>
                    {functionsOpen ? <ChevronDown size={14} strokeWidth={1.8} /> : <ChevronRight size={14} strokeWidth={1.8} />}
                    <Zap size={13} strokeWidth={1.8} /> Functions
                    <span className="repo-panel__count-pill">{fileFunctions.length}</span>
                </button>
                {functionsOpen && (
                    <div className="repo-panel__collapsible-body">
                        {fileFunctions.map((fn) => {
                            const key = `${fn.file}|${fn.line}|${fn.name}`;
                            const stat = fnStats[key];
                            const isOpen = expandedFn === key;
                            const neverCalled = stat && stat.internal === 0 && stat.external === 0;
                            return (
                                <div key={key} className="repo-panel__fn">
                                    <div className="repo-panel__fn-row" onClick={() => setExpandedFn(isOpen ? null : key)} role="button" tabIndex={0}>
                                        <span className="repo-panel__fn-name">{fn.name}()</span>
                                        <button className="repo-panel__eye-btn" onClick={(e) => { e.stopPropagation(); onViewSource(fn.file, fn.line); }} title="View source">
                                            <Eye size={13} strokeWidth={1.8} />
                                        </button>
                                        <span className="repo-panel__fn-line">L{fn.line}</span>
                                        <span className="repo-panel__fn-badge">{stat?.internal ?? 0} int</span>
                                        <span className={`repo-panel__fn-badge${stat?.external ? ' repo-panel__fn-badge--ext' : ''}`}>{stat?.external ?? 0} ext</span>
                                    </div>
                                    {isOpen && fn.code && <pre className="repo-panel__fn-code">{fn.code}</pre>}
                                    {neverCalled && <div className="repo-panel__fn-warning"><AlertTriangle size={12} strokeWidth={2} /> This function is never called</div>}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {onOpenAiExplorerFocused && (
                <div className="repo-panel__file-actions">
                    <button className="repo-panel__ai-btn" onClick={openAiExplorer}>
                        <MessageSquareCode size={15} strokeWidth={1.8} />
                        Open AI Explorer (Focused)
                    </button>
                </div>
            )}
        </>
    );
}

function DetailModal({ modal, onClose, onViewSource }) {
    const { kind, data } = modal;
    return (
        <div className="repo-panel__modal-overlay" onClick={onClose}>
            <div className="repo-panel__modal" onClick={(e) => e.stopPropagation()}>
                <div className="repo-panel__modal-head">
                    <h3>{kind === 'duplicate' ? (data.type === 'name' ? `Duplicate Name: ${data.name}` : `Similar Code: ${data.name}`) : data.title || data.name}</h3>
                    <button onClick={onClose}><X size={16} strokeWidth={2} /></button>
                </div>

                {kind === 'issue' && (
                    <>
                        <p className="repo-panel__modal-desc">{data.desc}</p>
                        <div className="repo-panel__modal-label">All Locations ({data.items.length})</div>
                        {data.items.map((item, i) => (
                            <div key={i} className="repo-panel__modal-item">
                                <div>
                                    <div className="repo-panel__modal-item-name">{item.name}</div>
                                    {item.file && <div className="repo-panel__modal-item-file">{item.file}</div>}
                                    {item.line != null && <div className="repo-panel__modal-item-line">Line {item.line}</div>}
                                </div>
                                {item.file && (
                                    <button className="repo-panel__view-btn" onClick={() => onViewSource(item.file, item.line)}>
                                        <Eye size={13} strokeWidth={1.8} /> View
                                    </button>
                                )}
                            </div>
                        ))}
                    </>
                )}

                {kind === 'pattern' && (
                    <>
                        <p className="repo-panel__modal-desc">{data.desc}</p>
                        <div className="repo-panel__modal-label">Files ({data.files.length})</div>
                        {data.files.map((f, i) => (
                            <div key={i} className="repo-panel__modal-item">
                                <div>
                                    <div className="repo-panel__modal-item-name">{f.name}</div>
                                    <div className="repo-panel__modal-item-file">{f.path}</div>
                                </div>
                                <button className="repo-panel__view-btn" onClick={() => onViewSource(f.path)}>
                                    <Eye size={13} strokeWidth={1.8} /> View
                                </button>
                            </div>
                        ))}
                    </>
                )}

                {kind === 'security' && (
                    <>
                        <p className="repo-panel__modal-desc">{data.desc}</p>
                        <div className="repo-panel__modal-item">
                            <div>
                                <div className="repo-panel__modal-item-name">{data.file}</div>
                                {data.line != null && <div className="repo-panel__modal-item-line">Line {data.line}</div>}
                            </div>
                            <button className="repo-panel__view-btn" onClick={() => onViewSource(data.path, data.line)}>
                                <Eye size={13} strokeWidth={1.8} /> View
                            </button>
                        </div>
                        {data.code && <pre className="repo-panel__fn-code">{data.code}</pre>}
                    </>
                )}

                {kind === 'duplicate' && (
                    <>
                        <p className="repo-panel__modal-desc">
                            {data.type === 'name'
                                ? `Function "${data.name}" appears in ${data.files.length} files — consider consolidating`
                                : `Similar code blocks detected — consider extracting to a shared utility`}
                        </p>
                        <div className="repo-panel__modal-label">All Locations ({data.files.length})</div>
                        {data.files.map((f, i) => (
                            <div key={i} className="repo-panel__modal-item">
                                <div>
                                    <div className="repo-panel__modal-item-name">{f.name || data.name}</div>
                                    <div className="repo-panel__modal-item-file">{f.file}</div>
                                </div>
                                <button className="repo-panel__view-btn" onClick={() => onViewSource(f.file, f.line)}>
                                    <Eye size={13} strokeWidth={1.8} /> View
                                </button>
                            </div>
                        ))}
                        <div className="repo-panel__suggested-action">
                            <div className="repo-panel__modal-label">Suggested Action</div>
                            {data.type === 'name'
                                ? 'Consider renaming these functions to be more specific, or consolidating them into a single shared function if they serve the same purpose.'
                                : 'Extract the similar code into a shared utility function. This reduces maintenance burden and ensures consistent behavior.'}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

/** Lightweight inline source viewer — reads straight off the already-loaded file content, no editor dependency. */
function SourceViewModal({ path, line, files, onClose }) {
    const file = files.find((f) => f.path === path);
    const lines = file ? highlightSyntax(file.content, path) : [];
    const filename = path.split('/').pop();
    return (
        <div className="repo-panel__modal-overlay" onClick={onClose}>
            <div className="repo-panel__modal repo-panel__modal--source" onClick={(e) => e.stopPropagation()}>
                <div className="repo-panel__source-head">
                    <div className="repo-panel__source-head-title">
                        <FileCode2 size={16} strokeWidth={1.8} />
                        <div>
                            <div className="repo-panel__source-filename">{filename}</div>
                            <div className="repo-panel__source-path">{path}</div>
                        </div>
                    </div>
                    <div className="repo-panel__source-head-actions">
                        {line != null && <span className="repo-panel__line-badge">Line {line}</span>}
                        <button onClick={onClose}><X size={18} strokeWidth={2} /></button>
                    </div>
                </div>
                {!file && <div className="repo-panel__empty">Source not available.</div>}
                <div className="repo-panel__source-scroll">
                    <pre className="repo-panel__source-code">
                        {lines.map((html, i) => (
                            <div
                                key={i}
                                className={`repo-panel__source-line${line != null && i + 1 === line ? ' repo-panel__source-line--highlight' : ''}`}
                            >
                                <span className="repo-panel__source-lineno">{i + 1}</span>
                                <span dangerouslySetInnerHTML={{ __html: html }} />
                            </div>
                        ))}
                    </pre>
                </div>
            </div>
        </div>
    );
}
