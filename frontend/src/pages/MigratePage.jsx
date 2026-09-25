import { useState, useMemo, useRef, useEffect } from 'react';
import {
    GitCompare, Sparkles, Send, Shield, AlertTriangle, Rocket, Palette,
    ChevronDown, ChevronUp, Copy, CheckCircle2, ShieldCheck, ShieldAlert,
    ArrowRight, ListOrdered,
} from 'lucide-react';
import TopNavBar from '../components/TopNavBar.jsx';
import ResizablePanel from '../components/ResizablePanel.jsx';
import { getFileTestLock } from '../session/testLock.js';
import { suggestMigrationAi, askAi } from '../api/backend.js';
import './MigratePage.css';
import FolderTree from '../components/FolderTree.jsx';

const CATEGORY_ORDER = ['Security', 'Deprecated APIs', 'Upgrades', 'Modernization'];
const CATEGORY_META = {
    'Security': { icon: Shield, cls: 'security', blurb: 'Fix critical vulnerabilities first' },
    'Deprecated APIs': { icon: AlertTriangle, cls: 'deprecated', blurb: 'Replace outdated libraries and APIs' },
    'Upgrades': { icon: Rocket, cls: 'upgrade', blurb: 'Update frameworks and runtime versions' },
    'Modernization': { icon: Palette, cls: 'modernization', blurb: 'Refactor and improve code quality' },
};

/**
 * Migrate workspace — a read-only "Migration Advisor". It never edits the
 * repository; it only surfaces findings (from a real LLM review when
 * available, a local heuristic otherwise) for the user to copy into their
 * own editor, and answers free-form migration questions via the AI service.
 *
 * Two ways to get findings:
 *  - "Generate Full Migration Plan" runs the local heuristic across every
 *    file. This deliberately does NOT call the real model once per file —
 *    llm_client.py paces real LLM calls ~4.5s apart with a per-minute token
 *    budget, so N real calls back-to-back for a whole repo would be slow
 *    and could exhaust the budget.
 *  - Selecting a file in the sidebar and clicking "Run AI review for this
 *    file" calls the real /api/code/suggest-migration endpoint for just
 *    that file, replacing its heuristic findings with the model's real
 *    ones (falls back silently to the heuristic result already on screen
 *    if the AI service is unreachable).
 *
 * "Mark as reviewed" is bookkeeping only (never touches disk) — same
 * non-destructive Accept/Reject-as-tracking philosophy the previous
 * version used, just reframed as a checklist instead of an editor.
 */
export default function MigratePage({ analysisResult, activeWorkspace, repositoryId, onNavigate, onExitRepository }) {
    const files = analysisResult?.files || [];
    const migrationRisk = analysisResult?.migrationRisk || {};
    const migrationOrder = analysisResult?.migrationOrder || { order: [], totalBatches: 0 };
    const safeToTouch = analysisResult?.safeToTouch || {};

    const [findings, setFindings] = useState([]);
    const [planStatus, setPlanStatus] = useState('idle'); // idle | scanning | done
    const [reviewed, setReviewed] = useState({}); // finding id -> true
    const [collapsed, setCollapsed] = useState({}); // finding id -> true
    const [copiedId, setCopiedId] = useState(null);
    const [activeCategory, setActiveCategory] = useState('All');
    const [sortDesc, setSortDesc] = useState(true);
    const [selectedFilePath, setSelectedFilePath] = useState(null);
    const [aiScanningFile, setAiScanningFile] = useState(null);
    const [aiError, setAiError] = useState(null);

    const [chatMessages, setChatMessages] = useState([]); // { role: 'user' | 'ai', text }
    const [chatInput, setChatInput] = useState('');
    const [chatLoading, setChatLoading] = useState(false);
    const chatEndRef = useRef(null);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, [chatMessages, chatLoading]);

    const generatePlan = () => {
        setPlanStatus('scanning');
        setTimeout(() => {
            const all = files.flatMap((f) => scanFile(f));
            setFindings(all);
            setPlanStatus('done');
        }, 500);
    };

    const runAiReviewForFile = async (file) => {
        if (!file) return;
        setAiScanningFile(file.path);
        setAiError(null);
        try {
            const result = await suggestMigrationAi(file.path, file.content);
            const aiFindings = (result.hunks || []).map((h, i) => ({
                id: `ai:${file.path}:${i}`,
                filePath: file.path,
                line: null,
                category: normalizeCategory(h.category),
                severity: normalizeSeverity(h.severity),
                title: h.category ? `${h.category} suggestion` : 'Suggested change',
                explanation: h.explanation || '',
                before: h.before,
                after: h.after,
                source: 'ai',
            }));
            setFindings((prev) => [...prev.filter((f2) => f2.filePath !== file.path), ...aiFindings]);
            if (planStatus === 'idle') setPlanStatus('done');
        } catch (err) {
            // AI service unreachable, no API key configured, or unparseable model
            // output — keep whatever heuristic findings are already on screen for
            // this file instead of clearing them.
            setAiError(err.message || 'AI service unavailable for this file — showing heuristic results instead.');
        } finally {
            setAiScanningFile(null);
        }
    };

    const toggleReviewed = (id) => setReviewed((r) => ({ ...r, [id]: !r[id] }));
    const toggleCollapsed = (id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

    const copyFindingCode = async (finding) => {
        try {
            await navigator.clipboard.writeText(finding.after);
            setCopiedId(finding.id);
            setTimeout(() => setCopiedId(null), 1500);
        } catch {
            // Clipboard API unavailable/blocked — not critical, fail silently.
        }
    };

    const sendChatMessage = async () => {
        const question = chatInput.trim();
        if (!question || chatLoading) return;
        setChatMessages((m) => [...m, { role: 'user', text: question }]);
        setChatInput('');
        setChatLoading(true);
        try {
            const scoped = `In the context of migrating/modernizing this repository (legacy patterns, deprecated APIs, security issues, framework upgrades): ${question}`;
            const result = await askAi(repositoryId, scoped);
            setChatMessages((m) => [...m, { role: 'ai', text: result.answer || 'No answer returned.' }]);
        } catch (err) {
            setChatMessages((m) => [...m, { role: 'ai', text: `Couldn't reach the AI service: ${err.message || 'unknown error'}` }]);
        } finally {
            setChatLoading(false);
        }
    };

    const categoryCounts = useMemo(() => {
        const counts = { Security: 0, 'Deprecated APIs': 0, Upgrades: 0, Modernization: 0 };
        findings.forEach((f) => { counts[f.category] = (counts[f.category] || 0) + 1; });
        return counts;
    }, [findings]);

    const totalFindings = findings.length;
    const reviewedCount = Object.keys(reviewed).filter((id) => reviewed[id] && findings.some((f) => f.id === id)).length;
    const reviewedPct = totalFindings ? Math.round((reviewedCount / totalFindings) * 100) : 0;

    const visibleFindings = useMemo(() => {
        let list = findings;
        if (selectedFilePath) list = list.filter((f) => f.filePath === selectedFilePath);
        if (activeCategory !== 'All') list = list.filter((f) => f.category === activeCategory);
        const sevRank = { High: 3, Medium: 2, Low: 1 };
        list = [...list].sort((a, b) => (sortDesc ? sevRank[b.severity] - sevRank[a.severity] : sevRank[a.severity] - sevRank[b.severity]));
        return list;
    }, [findings, selectedFilePath, activeCategory, sortDesc]);

    // Real: computed by analysis-engine/migrate.js from blast radius +
    // complexity + security findings (see migrationRisk[path].confidenceReason).
    const topRiskFiles = useMemo(() => {
        return Object.entries(migrationRisk)
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, 8);
    }, [migrationRisk]);

    return (
        <div className="migrate-page">
            <TopNavBar activeWorkspace={activeWorkspace} onNavigate={onNavigate} onExitRepository={onExitRepository} />

            <div className="migrate-layout">
                <ResizablePanel side="left" storageKey="migrate-file-panel" defaultWidth={280} minWidth={200} maxWidth={480}>
                    <div className="migrate-sidebar">
                        <div className="migrate-sidebar__header">
                            <GitCompare size={14} strokeWidth={1.8} />
                            Files
                        </div>
                        {files.length === 0 ? (
    <p className="migrate-empty">No files found in this repository's analysis.</p>
) : (
    <FolderTree
        files={files}
        selectedPath={selectedFilePath}
        onSelectFile={(path) => setSelectedFilePath(path === selectedFilePath ? null : path)}
    />
)}
                    </div>
                </ResizablePanel>

                <main className="migrate-content">
                    <div className="migrate-chatbar">
                        <Sparkles size={15} strokeWidth={2} className="migrate-chatbar__icon" />
                        <input
                            className="migrate-chatbar__input"
                            placeholder="Ask about migrating this repo…"
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') sendChatMessage(); }}
                        />
                        <button
                            className="migrate-chatbar__send"
                            onClick={sendChatMessage}
                            disabled={chatLoading || !chatInput.trim()}
                            aria-label="Send question"
                        >
                            <Send size={15} strokeWidth={2} />
                        </button>
                    </div>

                    {chatMessages.length > 0 && (
                        <div className="migrate-chat-thread">
                            {chatMessages.map((m, i) => (
                                <div key={i} className={`migrate-chat-msg migrate-chat-msg--${m.role}`}>
                                    <span className="migrate-chat-msg__role">{m.role === 'user' ? 'You' : 'AI'}</span>
                                    <p>{m.text}</p>
                                </div>
                            ))}
                            {chatLoading && (
                                <div className="migrate-chat-msg migrate-chat-msg--ai">
                                    <span className="migrate-chat-msg__role">AI</span>
                                    <p className="migrate-chat-msg__loading">Thinking…</p>
                                </div>
                            )}
                            <div ref={chatEndRef} />
                        </div>
                    )}

                    <button
                        className="migrate-generate-btn"
                        onClick={generatePlan}
                        disabled={planStatus === 'scanning' || files.length === 0}
                    >
                        <Sparkles size={15} strokeWidth={2} />
                        {planStatus === 'scanning' ? 'Scanning repository…' : 'Generate Full Migration Plan'}
                    </button>

                    {planStatus === 'idle' && (
                        <p className="migrate-page-subtitle">
                            Reviews the repository's real source for legacy/outdated patterns (hardcoded secrets, <code>eval()</code>, deprecated imports, outdated dependency pins, <code>var</code> declarations) and explains what to change and why — for you to copy into your own editor. This page never edits your files directly; you stay in control of every change.
                        </p>
                    )}

                    {planStatus === 'done' && (
                        <>
                            <div className="migrate-overview">
                                <div className="migrate-overview__header">
                                    <ListOrdered size={16} strokeWidth={2} />
                                    <div>
                                        <h3>Overview</h3>
                                        <p>Summary of migration issues found in this repository.</p>
                                    </div>
                                </div>
                                <div className="migrate-overview__stats">
                                    <div className="migrate-overview__total">
                                        <span className="migrate-overview__total-num">{totalFindings}</span>
                                        <span className="migrate-overview__total-label">items found</span>
                                    </div>
                                    {CATEGORY_ORDER.map((cat) => {
                                        const meta = CATEGORY_META[cat];
                                        const Icon = meta.icon;
                                        const count = categoryCounts[cat] || 0;
                                        const pct = totalFindings ? Math.round((count / totalFindings) * 100) : 0;
                                        return (
                                            <div className={`migrate-overview__cat migrate-cat--${meta.cls}`} key={cat}>
                                                <Icon size={16} strokeWidth={2} />
                                                <div>
                                                    <span className="migrate-overview__cat-name">{cat}</span>
                                                    <span className="migrate-overview__cat-count">{count}<small> ({pct}%)</small></span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                    <div className="migrate-overview__progress">
                                        <span>Review progress</span>
                                        <div className="migrate-review-status__bar">
                                            <div style={{ width: `${reviewedPct}%` }} />
                                        </div>
                                        <span className="migrate-overview__progress-fraction">{reviewedCount}/{totalFindings} reviewed</span>
                                    </div>
                                </div>
                            </div>

                            {topRiskFiles.length > 0 && (
                                <div className="migrate-order">
                                    <div className="migrate-order__header">
                                        <ShieldAlert size={16} strokeWidth={2} />
                                        <div>
                                            <h3>File Migration Risk (real)</h3>
                                            <p>Computed from blast radius, complexity, and known security findings — not part of the AI-generated findings above.</p>
                                        </div>
                                    </div>
                                    <div className="migrate-risk-list">
                                        {topRiskFiles.map(([path, r]) => (
                                            <div className={`migrate-risk-row migrate-risk-row--${r.level}`} key={path}>
                                                <span className="migrate-risk-row__file">{path}</span>
                                                <span className={`migrate-risk-badge migrate-risk-badge--${r.level}`}>{r.level} · {r.score}/100</span>
                                                <span className="migrate-risk-row__meta">
                                                    {r.factors.dependents} dependent(s){safeToTouch[path] ? ` · ${safeToTouch[path].badge}` : ''}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {migrationOrder.order.length > 0 && (
                                <div className="migrate-order">
                                    <div className="migrate-order__header">
                                        <ListOrdered size={16} strokeWidth={2} />
                                        <div>
                                            <h3>Dependency-Safe Migration Order (real)</h3>
                                            <p>
                                                Topological order over the dependency graph — batch 1 has nothing left depending on it.
                                                {migrationOrder.confidence === 'UNCERTAIN' && ' Some files are in a circular dependency and are grouped rather than strictly ordered.'}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="migrate-batch-list">
                                        {Array.from({ length: migrationOrder.totalBatches }, (_, i) => i + 1).map((batchNum) => {
                                            const filesInBatch = migrationOrder.order.filter((o) => o.batch === batchNum);
                                            if (!filesInBatch.length) return null;
                                            const hasCycle = filesInBatch.some((f) => f.inCycle);
                                            return (
                                                <div className={`migrate-batch${hasCycle ? ' migrate-batch--cycle' : ''}`} key={batchNum}>
                                                    <div className="migrate-batch__label">
                                                        Batch {batchNum}{hasCycle ? ' — circular, migrate together' : ''}
                                                    </div>
                                                    <div className="migrate-batch__files">
                                                        {filesInBatch.map((f) => (
                                                            <code key={f.file}>{f.file}</code>
                                                        ))}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                            {totalFindings > 0 && (
                                <div className="migrate-order">
                                    <div className="migrate-order__header">
                                        <ListOrdered size={16} strokeWidth={2} />
                                        <div>
                                            <h3>Suggested Order</h3>
                                            <p>Recommended migration sequence for minimal risk and maximum stability.</p>
                                        </div>
                                    </div>
                                    <div className="migrate-order__steps">
                                        {CATEGORY_ORDER.filter((cat) => categoryCounts[cat] > 0).map((cat, i, arr) => {
                                            const meta = CATEGORY_META[cat];
                                            return (
                                                <div className="migrate-order__step-wrap" key={cat}>
                                                    <div className="migrate-order__step">
                                                        <span className={`migrate-order__step-num migrate-cat--${meta.cls}`}>{i + 1}</span>
                                                        <div>
                                                            <strong>{cat}</strong>
                                                            <p>{meta.blurb}</p>
                                                        </div>
                                                    </div>
                                                    {i < arr.length - 1 && <ArrowRight size={16} strokeWidth={2} className="migrate-order__arrow" />}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            <div className="migrate-filterbar">
                                <div className="migrate-filterbar__pills">
                                    <button
                                        className={`migrate-pill${activeCategory === 'All' ? ' migrate-pill--active' : ''}`}
                                        onClick={() => setActiveCategory('All')}
                                    >
                                        All ({totalFindings})
                                    </button>
                                    {CATEGORY_ORDER.map((cat) => (
                                        <button
                                            key={cat}
                                            className={`migrate-pill${activeCategory === cat ? ' migrate-pill--active' : ''}`}
                                            onClick={() => setActiveCategory(cat)}
                                            disabled={!categoryCounts[cat]}
                                        >
                                            {cat} ({categoryCounts[cat] || 0})
                                        </button>
                                    ))}
                                </div>
                                <button className="migrate-sort-btn" onClick={() => setSortDesc((s) => !s)}>
                                    Sort: Severity ({sortDesc ? 'High → Low' : 'Low → High'})
                                </button>
                            </div>

                            {selectedFilePath && (
                                <div className="migrate-file-filter-note">
                                    Filtered to <code>{selectedFilePath}</code>
                                    <button className="migrate-inline-link" onClick={() => setSelectedFilePath(null)}>Clear</button>
                                    <span className="migrate-file-filter-note__sep">·</span>
                                    <button
                                        className="migrate-inline-link"
                                        onClick={() => runAiReviewForFile(files.find((f) => f.path === selectedFilePath))}
                                        disabled={aiScanningFile === selectedFilePath}
                                    >
                                        {aiScanningFile === selectedFilePath ? 'Running AI review…' : 'Run AI review for this file'}
                                    </button>
                                </div>
                            )}
                            {aiError && <p className="migrate-ai-error">{aiError}</p>}

                            {visibleFindings.length === 0 ? (
                                <p className="migrate-empty migrate-empty--block">No findings match this filter.</p>
                            ) : (
                                <div className="migrate-findings-list">
                                    {visibleFindings.map((finding) => {
                                        const meta = CATEGORY_META[finding.category];
                                        const isCollapsed = !!collapsed[finding.id];
                                        const isReviewed = !!reviewed[finding.id];
                                        const testLock = getFileTestLock(finding.filePath);
                                        const beforeLines = finding.before.split('\n');
                                        const afterLines = finding.after.split('\n');
                                        return (
                                            <div className="migrate-finding" key={finding.id}>
                                                <div className="migrate-finding__top">
                                                    <span className={`migrate-severity migrate-severity--${finding.severity.toLowerCase()}`}>
                                                        {finding.category.toUpperCase()} · {finding.severity.toUpperCase()}
                                                    </span>
                                                    <button
                                                        className="migrate-finding__collapse"
                                                        onClick={() => toggleCollapsed(finding.id)}
                                                        aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                                                    >
                                                        {isCollapsed ? <ChevronDown size={16} strokeWidth={2} /> : <ChevronUp size={16} strokeWidth={2} />}
                                                    </button>
                                                </div>

                                                <h4 className="migrate-finding__title">{finding.title}</h4>
                                                {finding.explanation && <p className="migrate-finding__explanation">{finding.explanation}</p>}

                                                <div className="migrate-finding__meta">
                                                    <span className="migrate-finding__path" title={finding.filePath}>{finding.filePath}</span>
                                                    {finding.line && <span className="migrate-finding__line">line {finding.line}</span>}
                                                    {finding.source === 'ai' ? (
                                                        <span className="migrate-mock-badge migrate-mock-badge--ai">AI-reviewed</span>
                                                    ) : (
                                                        <span className="migrate-mock-badge">Heuristic scan</span>
                                                    )}
                                                    {!testLock && (
                                                        <span className="migrate-test-status migrate-test-status--unlocked">
                                                            <ShieldAlert size={11} strokeWidth={2} />
                                                            No tests locked
                                                            <button className="migrate-inline-link" onClick={() => onNavigate('tests')}>Generate tests</button>
                                                        </span>
                                                    )}
                                                </div>

                                                {!isCollapsed && (
                                                    <div className="migrate-diff-code">
                                                        {beforeLines.map((l, i) => (
                                                            <div className="migrate-diff-code__line migrate-diff-code__line--del" key={`b${i}`}>
                                                                <span className="migrate-diff-code__gutter">{finding.line ? finding.line + i : ''}</span>
                                                                <span className="migrate-diff-code__marker">−</span>{l}
                                                            </div>
                                                        ))}
                                                        {afterLines.map((l, i) => (
                                                            <div className="migrate-diff-code__line migrate-diff-code__line--add" key={`a${i}`}>
                                                                <span className="migrate-diff-code__gutter">{finding.line ? finding.line + i : ''}</span>
                                                                <span className="migrate-diff-code__marker">+</span>{l}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}

                                                <div className="migrate-finding__actions">
                                                    <button className="migrate-btn" onClick={() => copyFindingCode(finding)}>
                                                        {copiedId === finding.id
                                                            ? <><CheckCircle2 size={13} strokeWidth={2} /> Copied</>
                                                            : <><Copy size={13} strokeWidth={2} /> Copy code</>}
                                                    </button>
                                                    <button
                                                        className={`migrate-btn${isReviewed ? ' migrate-btn--accept' : ' migrate-btn--primary'}`}
                                                        onClick={() => toggleReviewed(finding.id)}
                                                    >
                                                        <CheckCircle2 size={13} strokeWidth={2} />
                                                        {isReviewed ? 'Reviewed' : 'Mark as reviewed'}
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </>
                    )}
                </main>
            </div>
        </div>
    );
}

function normalizeCategory(cat) {
    if (!cat) return 'Modernization';
    const c = cat.toLowerCase();
    if (c.includes('secur')) return 'Security';
    if (c.includes('deprecat')) return 'Deprecated APIs';
    if (c.includes('upgrade') || c.includes('depend')) return 'Upgrades';
    return 'Modernization';
}

function normalizeSeverity(sev) {
    if (!sev) return 'Medium';
    const s = sev.toLowerCase();
    if (s.startsWith('high')) return 'High';
    if (s.startsWith('low')) return 'Low';
    return 'Medium';
}

let uidCounter = 0;
function nextId(prefix) {
    uidCounter += 1;
    return `${prefix}-${uidCounter}`;
}

/**
 * Deterministic local heuristic — same role as the old buildMockMigration(),
 * extended to tag a short title and one of the four categories shown in the
 * Overview card, and to keep the real source line number instead of
 * embedding it as a "// line N" comment. Used for the repo-wide "Generate
 * Full Migration Plan" sweep and as the fallback shown for a file until
 * "Run AI review" succeeds. Returns [] if nothing matches, rather than
 * inventing findings.
 */
function scanFile(file) {
    const content = file.content || '';
    const lines = content.split('\n');
    const findings = [];
    const MAX_PER_FILE = 6;
    const isPython = /\.py$/.test(file.path);

    lines.forEach((line, i) => {
        if (findings.length >= MAX_PER_FILE) return;
        const lineNo = i + 1;
        const trimmed = line.trim();
        if (!trimmed) return;

        if (/\b(password|secret|api[_-]?key|token)\s*=\s*["'][^"']+["']/i.test(line)) {
            const varName = trimmed.split('=')[0].trim();
            const after = isPython
                ? `import os\n${varName} = os.environ.get("${varName.toUpperCase()}")`
                : `const ${varName} = process.env.${varName.toUpperCase()};`;
            findings.push({
                id: nextId('h'), filePath: file.path, line: lineNo,
                category: 'Security', severity: 'High',
                title: 'Replace hardcoded secret with environment variable',
                explanation: 'Hardcoded secrets can be exposed in version control. Use environment variables instead for better security and flexibility.',
                before: trimmed, after, source: 'heuristic',
            });
        } else if (/\beval\s*\(/.test(line)) {
            findings.push({
                id: nextId('h'), filePath: file.path, line: lineNo,
                category: 'Security', severity: 'High',
                title: 'Avoid eval() for dynamic code execution',
                explanation: 'eval() can execute arbitrary code and is a common injection vector. Parse or validate the input explicitly instead.',
                before: trimmed,
                after: '// Suggested: replace eval() with explicit parsing/validation of the expected input',
                source: 'heuristic',
            });
        } else if (isPython && /^import\s+urllib\s*$/.test(trimmed)) {
            findings.push({
                id: nextId('h'), filePath: file.path, line: lineNo,
                category: 'Deprecated APIs', severity: 'High',
                title: 'Replace deprecated import with new module',
                explanation: "Bare 'import urllib' is deprecated in modern Python. Import the specific submodule you need instead, e.g. urllib.parse for URL handling.",
                before: trimmed,
                after: 'from urllib import parse  # Use urllib.parse for URL handling',
                source: 'heuristic',
            });
        } else if (/function\s*\(.*\)\s*{\s*$/.test(line) && /callback|cb\)/.test(line)) {
            findings.push({
                id: nextId('h'), filePath: file.path, line: lineNo,
                category: 'Deprecated APIs', severity: 'Medium',
                title: 'Convert callback to async/await',
                explanation: 'Callback-style functions are harder to read and compose than modern async/await. Consider converting this to an async function.',
                before: trimmed,
                after: '// Suggested: convert to an async function and use await instead of a callback parameter',
                source: 'heuristic',
            });
        } else if (/^(fastapi|django|flask|numpy|requests|spring-boot-starter)\s*==\s*[\d.]+/i.test(trimmed)
            || /"(react|express|axios|lodash)":\s*"[\^~]?[\d.]+"/i.test(trimmed)) {
            findings.push({
                id: nextId('h'), filePath: file.path, line: lineNo,
                category: 'Upgrades', severity: 'Medium',
                title: 'Update framework/dependency to a current release',
                explanation: "This dependency is pinned to a specific version. Check the package's changelog and consider upgrading to a current stable release for security fixes and performance improvements.",
                before: trimmed,
                after: '// Suggested: bump this pin after reviewing the changelog for breaking changes',
                source: 'heuristic',
            });
        } else if (/\bvar\s+\w+\s*=/.test(line)) {
            findings.push({
                id: nextId('h'), filePath: file.path, line: lineNo,
                category: 'Modernization', severity: 'Low',
                title: "Use 'const' or 'let' instead of 'var'",
                explanation: "'var' is function-scoped and can lead to subtle bugs. Prefer 'const' (or 'let' if reassigned) for block scoping.",
                before: trimmed,
                after: trimmed.replace(/\bvar\b/, 'const'),
                source: 'heuristic',
            });
        }
    });

    return findings;
}
