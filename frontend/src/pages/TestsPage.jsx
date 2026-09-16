import { useState, useMemo } from 'react';
import {
    FlaskConical, ClipboardList, Plug, Check, X, Pencil, Sparkles, Info, Play,
    RefreshCw, AlertTriangle, ShieldCheck,
} from 'lucide-react';
import TopNavBar from '../components/TopNavBar.jsx';
import ResizablePanel from '../components/ResizablePanel.jsx';
import { markFileTestLocked, getFileTestLock } from '../session/testLock.js';
import { generateTestsAi, listRepositories } from '../api/backend.js';
import './TestsPage.css';

const TABS = [
    { id: 'unit', label: 'Unit Tests', icon: FlaskConical },
    { id: 'feature', label: 'Feature Tests', icon: ClipboardList },
    { id: 'api', label: 'API Tests', icon: Plug },
];

/**
 * Tests workspace — a QA Test Suite with three levels, matching how a
 * manual tester actually works: Unit Tests (code-level), Feature Tests
 * (does the actual product behavior work end to end), and API Tests
 * (does each backend endpoint respond correctly).
 *
 * Unit Tests keeps the previous version's real logic: a real LLM call
 * (generateTestsAi) with a deterministic local-template fallback if the AI
 * service is unreachable, and the same test-lock bridge to Migrate. It
 * adds a "Run tests" step whose pass/fail/coverage numbers are clearly
 * labelled SIMULATED — there's no real pytest/JUnit/Vitest execution
 * wired up yet (that's backend work: TestRunnerAdapter + real subprocess
 * execution, tracked separately). The QA Dashboard at the top aggregates
 * the same simulated per-function numbers so the page matches the
 * approved mockup today without overclaiming real coverage.
 *
 * Feature Tests and API Tests are new tabs with representative sample
 * data (also simulated) showing the intended UI/workflow — wiring them to
 * a real Playwright/Cypress runner and to the actual backend endpoints is
 * later-phase work.
 */
export default function TestsPage({ analysisResult, activeWorkspace, repositoryId, onNavigate, onExitRepository }) {
    const functions = analysisResult?.functions || [];
    const [activeTab, setActiveTab] = useState('unit');

    // ---- Unit Tests state (largely the previous version's logic) ----
    const [selectedIndex, setSelectedIndex] = useState(functions.length ? 0 : -1);
    const [generated, setGenerated] = useState(null);
    const [status, setStatus] = useState('idle'); // idle | generating | ready | accepted
    const [source, setSource] = useState(null); // 'ai' | 'mock'
    const [aiError, setAiError] = useState(null);
    const [runResultsMap, setRunResultsMap] = useState({}); // `${file}:${name}` -> { rows, coverage }
    const [runningKey, setRunningKey] = useState(null);

    const selectedFn = selectedIndex >= 0 ? functions[selectedIndex] : null;
    const selectedKey = selectedFn ? `${selectedFn.file}:${selectedFn.name}` : null;
    const runResult = selectedKey ? runResultsMap[selectedKey] : null;

    // Deterministic simulated pass/fail/coverage/flaky per function — same
    // function always produces the same numbers so the dashboard and
    // sidebar dots don't jitter on every re-render. Replace with real
    // aggregated results once a backend test runner exists.
    const functionStats = useMemo(() => functions.map((fn) => {
        const key = `${fn.file}:${fn.name}`;
        const h = Math.abs(hashCode(key));
        return {
            fn, key,
            group: groupOf(fn.file),
            passed: (h % 100) < 88,
            coverage: 55 + (h % 41),
            flaky: (h % 37) === 0,
        };
    }), [functions]);

    const dashboard = useMemo(() => {
        const total = functionStats.length;
        const passedCount = functionStats.filter((s) => s.passed).length;
        const flakyCount = functionStats.filter((s) => s.flaky).length;
        const avgCoverage = total ? Math.round(functionStats.reduce((s, x) => s + x.coverage, 0) / total) : 0;
        const groups = {};
        functionStats.forEach((s) => {
            if (!groups[s.group]) groups[s.group] = { total: 0, passed: 0 };
            groups[s.group].total += 1;
            if (s.passed) groups[s.group].passed += 1;
        });
        return {
            total, passedCount, flakyCount,
            failingCount: total - passedCount,
            avgCoverage,
            groups,
            passRate: total ? Math.round((passedCount / total) * 100) : 0,
        };
    }, [functionStats]);

    const handleGenerate = async () => {
        if (!selectedFn) return;
        setStatus('generating');
        setGenerated(null);
        setAiError(null);
        try {
            const result = await generateTestsAi(selectedFn.name, selectedFn.file, selectedFn.code);
            setGenerated({ code: result.testCode, coverage: result.coverageEstimate, notes: result.notes });
            setSource('ai');
            setStatus('ready');
        } catch (err) {
            // AI service unreachable, no API key configured, or the model output
            // didn't parse — degrade to the local template rather than a dead end.
            setAiError(err.message || 'AI service unavailable');
            setTimeout(() => {
                setGenerated(buildMockTests(selectedFn));
                setSource('mock');
                setStatus('ready');
            }, 300);
        }
    };

    const handleRunTests = () => {
        if (!selectedFn || !generated || !selectedKey) return;
        setRunningKey(selectedKey);
        setTimeout(() => {
            const stat = functionStats.find((s) => s.key === selectedKey);
            const names = parseTestNames(generated.code);
            const rows = (names.length ? names : ['runs without throwing']).map((name, i) => {
                const h = Math.abs(hashCode(`${selectedKey}:${i}`));
                const passed = stat ? (i === 0 ? stat.passed : (h % 100) < 90) : (h % 100) < 85;
                return {
                    name, passed,
                    coverage: 50 + (h % 46),
                    time: (0.1 + (h % 90) / 100).toFixed(2),
                };
            });
            setRunResultsMap((m) => ({ ...m, [selectedKey]: { rows, coverage: stat ? stat.coverage : generated.coverage } }));
            setRunningKey(null);
        }, 650);
    };

    const handleAccept = () => {
        setStatus('accepted');
        if (selectedFn) markFileTestLocked(selectedFn.file, selectedFn.name);
    };

    const selectFunction = (i) => {
        setSelectedIndex(i);
        setGenerated(null);
        setStatus('idle');
        setAiError(null);
    };

    return (
        <div className="tests-page">
            <TopNavBar activeWorkspace={activeWorkspace} onNavigate={onNavigate} onExitRepository={onExitRepository} />

            <div className="tests-dashboard-wrap">
                <QaDashboard dashboard={dashboard} />
            </div>

            <div className="tests-tabbar">
                {TABS.map((t) => {
                    const Icon = t.icon;
                    return (
                        <button
                            key={t.id}
                            className={`tests-tab${activeTab === t.id ? ' tests-tab--active' : ''}`}
                            onClick={() => setActiveTab(t.id)}
                        >
                            <Icon size={14} strokeWidth={1.8} />
                            {t.label}
                        </button>
                    );
                })}
            </div>

            {activeTab === 'unit' && (
                <div className="tests-layout">
                    <ResizablePanel side="left" storageKey="tests-fn-panel" defaultWidth={260} minWidth={200} maxWidth={420}>
                        <div className="tests-sidebar">
                            <div className="tests-sidebar__header">
                                <FlaskConical size={14} strokeWidth={1.8} />
                                Functions
                            </div>
                            {functions.length === 0 ? (
                                <p className="tests-empty">No functions found in this repository's analysis.</p>
                            ) : (
                                <ul className="tests-fn-list">
                                    {functions.map((fn, i) => {
                                        const stat = functionStats[i];
                                        return (
                                            <li key={`${fn.file}:${fn.name}:${fn.line}`}>
                                                <button
                                                    className={`tests-fn-item${i === selectedIndex ? ' tests-fn-item--active' : ''}`}
                                                    onClick={() => selectFunction(i)}
                                                    title={fn.file}
                                                >
                                                    <span className="tests-fn-item__name">
                                                        <span className={`tests-status-dot tests-status-dot--${stat.passed ? 'pass' : 'fail'}`} />
                                                        {fn.name}
                                                        {stat.flaky && <AlertTriangle size={11} strokeWidth={2} className="tests-fn-item__flaky" />}
                                                    </span>
                                                    <span className="tests-fn-item__file">
                                                        {fn.file}
                                                        {getFileTestLock(fn.file) && <Check className="tests-fn-item__lock-icon" size={11} strokeWidth={2.5} />}
                                                    </span>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </ResizablePanel>

                    <main className="tests-content">
                        {!selectedFn ? (
                            <div className="tests-placeholder">Select a function to preview generated tests.</div>
                        ) : (
                            <div className="tests-columns">
                                <div className="tests-card">
                                    <div className="tests-card__header">
                                        <h2>Original function</h2>
                                        <p>{selectedFn.file}</p>
                                    </div>
                                    <pre className="tests-code">{selectedFn.code || '// source not captured for this function'}</pre>
                                </div>

                                <div className="tests-card">
                                    <div className="tests-card__header">
                                        <h2>AI-generated unit tests</h2>
                                        <p>
                                            Tests for <code>{selectedFn.name}</code>
                                            <span className="tests-card__target-file">{selectedFn.file}</span>
                                            {status === 'ready' || status === 'accepted' ? (
                                                source === 'ai' ? (
                                                    <span className="tests-mock-badge tests-mock-badge--ai">Generated by AI model</span>
                                                ) : (
                                                    <span className="tests-mock-badge">
                                                        Local preview — AI service unavailable
                                                        <span className="tests-info-tip" tabIndex={0}>
                                                            <Info size={12} strokeWidth={2} />
                                                            <span className="tests-info-tip__bubble">
                                                                {aiError || 'Could not reach the AI service.'} Showing a local template instead — not a real model call.
                                                            </span>
                                                        </span>
                                                    </span>
                                                )
                                            ) : (
                                                <span className="tests-mock-badge">
                                                    AI-generated
                                                    <span className="tests-info-tip" tabIndex={0}>
                                                        <Info size={12} strokeWidth={2} />
                                                        <span className="tests-info-tip__bubble">
                                                            Calls the AI service for real test generation. If it's unreachable or no LLM key is configured, this falls back to a local template automatically.
                                                        </span>
                                                    </span>
                                                </span>
                                            )}
                                        </p>
                                    </div>

                                    {status === 'idle' && (
                                        <button className="tests-btn tests-btn--primary" onClick={handleGenerate}>
                                            <Sparkles size={14} strokeWidth={2} />
                                            Generate tests
                                        </button>
                                    )}

                                    {status === 'generating' && <p className="tests-generating">Generating…</p>}

                                    {(status === 'ready' || status === 'accepted') && generated && (
                                        <>
                                            <pre className="tests-code">{generated.code}</pre>
                                            {generated.notes && <p className="tests-notes">{generated.notes}</p>}

                                            <div className="tests-results">
                                                <div className="tests-results__header">
                                                    <h3>Test Results</h3>
                                                    <span className="tests-mock-badge">
                                                        Simulated run
                                                        <span className="tests-info-tip" tabIndex={0}>
                                                            <Info size={12} strokeWidth={2} />
                                                            <span className="tests-info-tip__bubble">
                                                                No real pytest/JUnit/Vitest execution is wired up yet — these pass/fail results and coverage numbers are simulated, not measured.
                                                            </span>
                                                        </span>
                                                    </span>
                                                    {!runResult && (
                                                        <button
                                                            className="tests-btn tests-btn--small tests-btn--primary"
                                                            onClick={handleRunTests}
                                                            disabled={runningKey === selectedKey}
                                                        >
                                                            <Play size={12} strokeWidth={2} />
                                                            {runningKey === selectedKey ? 'Running…' : 'Run tests'}
                                                        </button>
                                                    )}
                                                    {runResult && (
                                                        <button className="tests-btn tests-btn--small" onClick={handleRunTests} disabled={runningKey === selectedKey}>
                                                            <RefreshCw size={12} strokeWidth={2} />
                                                            {runningKey === selectedKey ? 'Running…' : 'Re-run'}
                                                        </button>
                                                    )}
                                                </div>

                                                {runResult ? (
                                                    <>
                                                        <ul className="tests-results__list">
                                                            {runResult.rows.map((row, i) => (
                                                                <li key={i} className={`tests-result-row tests-result-row--${row.passed ? 'pass' : 'fail'}`}>
                                                                    {row.passed ? <Check size={13} strokeWidth={2.5} /> : <X size={13} strokeWidth={2.5} />}
                                                                    <span className="tests-result-row__name">{row.name}</span>
                                                                    <span className="tests-result-row__status">{row.passed ? 'PASSED' : 'FAILED'}</span>
                                                                    <span className="tests-result-row__time">{row.time}s</span>
                                                                    <span className="tests-result-row__cov">{row.coverage}%</span>
                                                                </li>
                                                            ))}
                                                        </ul>
                                                        <div className="tests-coverage">
                                                            <span>Coverage</span>
                                                            <div className="tests-coverage__bar">
                                                                <div style={{ width: `${runResult.coverage}%` }} />
                                                            </div>
                                                            <span className="tests-coverage__pct">{runResult.coverage}%</span>
                                                        </div>
                                                    </>
                                                ) : (
                                                    <p className="tests-results__empty">Not run yet — click "Run tests" to see pass/fail and coverage.</p>
                                                )}
                                            </div>

                                            <div className="tests-actions">
                                                {status === 'accepted' ? (
                                                    <span className="tests-accepted"><Check size={14} strokeWidth={2.5} /> Accepted</span>
                                                ) : (
                                                    <>
                                                        <button className="tests-btn tests-btn--primary" onClick={handleAccept}>
                                                            <Check size={14} strokeWidth={2} />
                                                            Accept & save
                                                        </button>
                                                        <button className="tests-btn">
                                                            <Pencil size={14} strokeWidth={2} />
                                                            Edit
                                                        </button>
                                                        <button className="tests-btn" onClick={handleGenerate}>
                                                            <RefreshCw size={14} strokeWidth={2} />
                                                            Regenerate
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                    </main>
                </div>
            )}

            {activeTab === 'feature' && <FeatureTestsTab onNavigate={onNavigate} />}
            {activeTab === 'api' && <ApiTestsTab repositoryId={repositoryId} />}
        </div>
    );
}

/** Circular pass-rate ring + aggregate stats, matching the approved mockup's dashboard card. */
function QaDashboard({ dashboard }) {
    const { total, passRate, avgCoverage, flakyCount, failingCount, groups } = dashboard;
    const r = 30;
    const c = 2 * Math.PI * r;
    const offset = c - (passRate / 100) * c;

    return (
        <div className="tests-dashboard">
            <div className="tests-dashboard__ring">
                <svg width="76" height="76" viewBox="0 0 76 76">
                    <circle cx="38" cy="38" r={r} fill="none" stroke="var(--lb-surface-raised)" strokeWidth="7" />
                    <circle
                        cx="38" cy="38" r={r} fill="none" stroke="var(--lb-success)" strokeWidth="7"
                        strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
                        transform="rotate(-90 38 38)"
                    />
                </svg>
                <span className="tests-dashboard__ring-pct">{passRate}%</span>
            </div>

            <div className="tests-dashboard__main">
                <div className="tests-dashboard__headline">
                    <strong>Overall Pass Rate: {passRate}%</strong>
                    <span>({dashboard.passedCount}/{total} tests)</span>
                </div>
                <div className="tests-dashboard__pills">
                    {Object.entries(groups).map(([name, g]) => (
                        <span className="tests-dashboard__pill" key={name}>
                            {name}: {g.total ? Math.round((g.passed / g.total) * 100) : 0}%
                        </span>
                    ))}
                    {total === 0 && <span className="tests-dashboard__pill">No functions found yet</span>}
                </div>
            </div>

            <div className="tests-dashboard__coverage">
                <span>Coverage: {avgCoverage}%</span>
                <div className="tests-coverage__bar tests-dashboard__coverage-bar">
                    <div style={{ width: `${avgCoverage}%` }} />
                </div>
            </div>

            <div className="tests-dashboard__flags">
                {flakyCount > 0 && <span className="tests-dashboard__flag tests-dashboard__flag--warn"><AlertTriangle size={12} strokeWidth={2} /> {flakyCount} flaky</span>}
                {failingCount > 0 && <span className="tests-dashboard__flag tests-dashboard__flag--error"><X size={12} strokeWidth={2} /> {failingCount} failing</span>}
            </div>

            <span className="tests-mock-badge tests-dashboard__badge">
                Simulated
                <span className="tests-info-tip" tabIndex={0}>
                    <Info size={12} strokeWidth={2} />
                    <span className="tests-info-tip__bubble">
                        These numbers are deterministic simulated results, not a real pytest/JUnit/Vitest run. Wiring a real backend test runner is planned separately.
                    </span>
                </span>
            </span>
        </div>
    );
}

// ---- Feature Tests tab (manual-QA style, simulated) ----
const INITIAL_FEATURE_GROUPS = [
    {
        name: 'Repository Upload & Indexing',
        cases: [
            { id: 'TC-001', title: 'Upload a valid GitHub repo', steps: ['Enter repo URL', 'Click Import', 'Wait for indexing to finish'], expected: 'Repo appears in workspace, files list populated', severity: 'High', status: 'passed', lastRun: '2 min ago' },
            { id: 'TC-002', title: 'Upload an unsupported file type', steps: ['Select a .exe file', 'Click Import'], expected: 'Clear error message shown, no crash', severity: 'Medium', status: 'passed', lastRun: '5 min ago' },
        ],
    },
    {
        name: 'AI Explorer',
        cases: [
            { id: 'TC-003', title: 'Ask a question about a known class', steps: ['Open AI Explorer', 'Ask about a class that exists in the repo'], expected: 'Answer references the correct file, no crash', severity: 'High', status: 'failed', lastRun: '1 hour ago', bug: 'GraphRecursionError on a follow-up question' },
        ],
    },
    {
        name: 'Migrate Page',
        cases: [
            { id: 'TC-004', title: 'Ask a migration question in the chat box', steps: ['Open Migrate page', 'Type a question', 'Send'], expected: 'Relevant answer returned, referencing real files', severity: 'Medium', status: 'not_run', lastRun: null },
            { id: 'TC-005', title: 'Generate a full migration plan', steps: ['Click "Generate Full Migration Plan"'], expected: 'Overview card + findings list populate, correctly categorized', severity: 'Medium', status: 'not_run', lastRun: null },
        ],
    },
];

function FeatureTestsTab({ onNavigate }) {
    const [groups, setGroups] = useState(INITIAL_FEATURE_GROUPS);
    const [runningId, setRunningId] = useState(null);

    const updateCase = (caseId, patch) => {
        setGroups((gs) => gs.map((g) => ({
            ...g,
            cases: g.cases.map((c) => (c.id === caseId ? { ...c, ...patch } : c)),
        })));
    };

    const runCase = (c) => {
        setRunningId(c.id);
        setTimeout(() => {
            updateCase(c.id, {
                status: c.bug ? 'failed' : 'passed',
                lastRun: 'just now',
            });
            setRunningId(null);
        }, 700);
    };

    const reportBug = (c) => {
        updateCase(c.id, { bugReported: true });
    };

    return (
        <main className="tests-content tests-content--feature">
            <p className="tests-page-subtitle">
                End-to-end feature checks, grouped by the part of the product they cover — the kind of scenarios a manual tester walks through by hand. Results below are illustrative sample data; wiring these to a real Playwright/Cypress runner is later-phase work.
            </p>
            {groups.map((g) => (
                <div className="feature-group" key={g.name}>
                    <h3 className="feature-group__title">{g.name}</h3>
                    {g.cases.map((c) => (
                        <div className="feature-case" key={c.id}>
                            <div className="feature-case__top">
                                <span className="feature-case__id">{c.id}</span>
                                <span className={`feature-case__status feature-case__status--${c.status}`}>
                                    {c.status === 'passed' && <><Check size={12} strokeWidth={2.5} /> PASSED</>}
                                    {c.status === 'failed' && <><X size={12} strokeWidth={2.5} /> FAILED</>}
                                    {c.status === 'not_run' && 'NOT RUN YET'}
                                </span>
                            </div>
                            <h4 className="feature-case__title">{c.title}</h4>
                            <p className="feature-case__steps"><strong>Steps:</strong> {c.steps.join('  →  ')}</p>
                            <p className="feature-case__expected"><strong>Expected:</strong> {c.expected}</p>
                            {c.bug && (
                                <p className="feature-case__bug">
                                    <AlertTriangle size={12} strokeWidth={2} /> {c.bug}
                                </p>
                            )}
                            <div className="feature-case__meta">
                                <span>Severity: {c.severity}</span>
                                {c.lastRun && <span>Last run: {c.lastRun}</span>}
                            </div>
                            <div className="feature-case__actions">
                                <button className="tests-btn tests-btn--small tests-btn--primary" onClick={() => runCase(c)} disabled={runningId === c.id}>
                                    <Play size={12} strokeWidth={2} />
                                    {runningId === c.id ? 'Running…' : 'Run'}
                                </button>
                                {c.status === 'failed' && (
                                    <button className="tests-btn tests-btn--small" onClick={() => reportBug(c)} disabled={c.bugReported}>
                                        {c.bugReported ? 'Bug reported ✓' : 'Report bug'}
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            ))}
            <p className="tests-page-subtitle">
                Want to check migration findings against these features? <button className="tests-inline-link" onClick={() => onNavigate('migrate')}>Open Migrate</button>
            </p>
        </main>
    );
}

// ---- API Tests tab ----
const API_ENDPOINTS = [
    { id: 'ep1', method: 'GET', path: '/api/repository/list', description: 'Lists recent repositories', real: true },
    { id: 'ep2', method: 'POST', path: '/api/repository/ingest', description: 'Stores an analysis result and triggers AI indexing', real: false },
    { id: 'ep3', method: 'POST', path: '/api/ai/ask', description: 'Asks the AI Explorer a question about the repository', real: false },
    { id: 'ep4', method: 'POST', path: '/api/code/generate-tests', description: 'Generates unit tests for a function', real: false },
    { id: 'ep5', method: 'POST', path: '/api/code/suggest-migration', description: 'Reviews a file for legacy patterns', real: false },
];

function ApiTestsTab() {
    const [results, setResults] = useState({}); // id -> { status, code, time }

    const send = async (ep) => {
        setResults((r) => ({ ...r, [ep.id]: { status: 'sending' } }));
        if (ep.real) {
            const started = performance.now();
            try {
                await listRepositories();
                const time = Math.round(performance.now() - started);
                setResults((r) => ({ ...r, [ep.id]: { status: 'ok', code: 200, time } }));
            } catch (err) {
                const time = Math.round(performance.now() - started);
                setResults((r) => ({ ...r, [ep.id]: { status: 'error', code: 0, time, note: err.message } }));
            }
            return;
        }
        // Simulated — sending real POST bodies here could write fake data into
        // the backend, so non-idempotent endpoints get a clearly-labelled
        // simulated response instead of a live call.
        setTimeout(() => {
            const h = Math.abs(hashCode(ep.id));
            const time = 80 + (h % 400);
            setResults((r) => ({ ...r, [ep.id]: { status: 'ok', code: 200, time, simulated: true } }));
        }, 500);
    };

    return (
        <main className="tests-content tests-content--api">
            <p className="tests-page-subtitle">
                Checks each backend endpoint's response. <code>{API_ENDPOINTS[0].path}</code> sends a real request; the others show a simulated response (sending fake POST bodies here could write test data into the real backend) — wiring a full request/response validator is later-phase work.
            </p>
            <div className="api-list">
                {API_ENDPOINTS.map((ep) => {
                    const r = results[ep.id];
                    return (
                        <div className="api-row" key={ep.id}>
                            <div className="api-row__top">
                                <span className={`api-method api-method--${ep.method.toLowerCase()}`}>{ep.method}</span>
                                <span className="api-path">{ep.path}</span>
                                {!ep.real && <span className="tests-mock-badge">Simulated</span>}
                            </div>
                            <p className="api-desc">{ep.description}</p>
                            <div className="api-row__bottom">
                                <button
                                    className="tests-btn tests-btn--small tests-btn--primary"
                                    onClick={() => send(ep)}
                                    disabled={r?.status === 'sending'}
                                >
                                    <Play size={12} strokeWidth={2} />
                                    {r?.status === 'sending' ? 'Sending…' : 'Send request'}
                                </button>
                                {r && r.status !== 'sending' && (
                                    <span className={`api-result api-result--${r.status}`}>
                                        {r.status === 'ok' ? <ShieldCheck size={13} strokeWidth={2} /> : <X size={13} strokeWidth={2} />}
                                        {r.status === 'ok' ? `${r.code} OK` : 'Failed'} · {r.time}ms
                                        {r.note ? ` · ${r.note}` : ''}
                                    </span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </main>
    );
}

/** Deterministic fallback used when the AI service is unavailable — same function always produces the same template, so it doesn't feel random on repeat clicks. */
function buildMockTests(fn) {
    const safeName = fn.name.replace(/[^a-zA-Z0-9_]/g, '_');
    const coverage = 60 + (Math.abs(hashCode(fn.name)) % 31); // 60-90%, stable per function
    const code = `import { describe, it, expect } from 'vitest';
import { ${fn.name} } from '${toImportPath(fn.file)}';

describe('${fn.name}', () => {
    it('handles the typical case', () => {
        // TODO: replace with real arguments for ${safeName}
        const result = ${fn.name}(/* ... */);
        expect(result).toBeDefined();
    });

    it('handles an edge case', () => {
        // TODO: describe the edge case this legacy function needs to cover
    });
});`;
    return { code, coverage };
}

function toImportPath(filePath) {
    if (!filePath) return './module';
    return './' + filePath.replace(/\.[jt]sx?$/, '');
}

function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i);
    return h;
}

/** Top-level path segment used to group functions into ai-service / backend / frontend / other for the dashboard's per-component pills. */
function groupOf(filePath) {
    if (!filePath) return 'other';
    const first = filePath.split('/')[0];
    return first || 'other';
}

/** Pulls plausible test names out of generated test code so the simulated "Test Results" list shows real-looking names instead of generic placeholders. Supports both the Vitest-style output of buildMockTests() and the pytest-style output real AI generation tends to produce. */
function parseTestNames(code) {
    if (!code) return [];
    const names = [];
    const jsRe = /it\(\s*['"`]([^'"`]+)['"`]/g;
    const pyRe = /def\s+(test_\w+)/g;
    let m;
    while ((m = jsRe.exec(code))) names.push(m[1]);
    while ((m = pyRe.exec(code))) names.push(m[1]);
    return names;
}
