import { useState, useMemo } from 'react';
import { FlaskConical, ClipboardList, Plug, Check, Sparkles, Play, AlertTriangle, Download, Search } from 'lucide-react';
import TopNavBar from '../components/TopNavBar.jsx';
import ResizablePanel from '../components/ResizablePanel.jsx';
import { generateTestsAi, listRepositories } from '../api/backend.js';
import './TestsPage.css';

const TABS = [
    { id: 'unit', label: 'Unit Tests', icon: FlaskConical },
    { id: 'feature', label: 'Test Linkage', icon: ClipboardList },
    { id: 'api', label: 'API Endpoints', icon: Plug },
];

const safeArray = (value) => Array.isArray(value) ? value : [];
const functionKey = (fn) => `${fn.file}:${fn.name}:${fn.line ?? ''}`;

/** Only repository-derived evidence is displayed. No synthetic pass rate, coverage or runner output. */
export default function TestsPage({ analysisResult, activeWorkspace, onNavigate, onExitRepository }) {
    const functions = safeArray(analysisResult?.functions);
    const links = safeArray(analysisResult?.testLinkage?.links);
    const endpoints = safeArray(analysisResult?.apiEndpoints);
    const [tab, setTab] = useState('unit');
    const [query, setQuery] = useState('');
    const [selectedKey, setSelectedKey] = useState('');
    const [generatedByKey, setGeneratedByKey] = useState({});
    const [generating, setGenerating] = useState(false);
    const [generationError, setGenerationError] = useState('');

    const selectedFn = functions.find((fn) => functionKey(fn) === selectedKey) || functions[0] || null;
    const selectedId = selectedFn ? functionKey(selectedFn) : '';
    const generatedCode = generatedByKey[selectedId] || '';
    const filteredFunctions = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return needle ? functions.filter((fn) => `${fn.name} ${fn.file}`.toLowerCase().includes(needle)) : functions;
    }, [functions, query]);
    const uniqueTestFiles = new Set(links.map((link) => link.testFile));

    const generate = async () => {
        if (!selectedFn || !selectedFn.code?.trim() || generating) return;
        setGenerating(true);
        setGenerationError('');
        try {
            const response = await generateTestsAi(selectedFn.name, selectedFn.file, selectedFn.code);
            if (!response?.testCode?.trim()) throw new Error('AI service returned no test code.');
            setGeneratedByKey((prev) => ({ ...prev, [selectedId]: response.testCode }));
        } catch (error) {
            setGenerationError(error?.message || 'Could not generate tests. Check the AI service connection.');
        } finally {
            setGenerating(false);
        }
    };

    const saveGenerated = () => {
        if (!generatedCode.trim() || !selectedFn) return;
        const extension = selectedFn.file.endsWith('.py') ? 'py' : selectedFn.file.endsWith('.java') ? 'java' : 'js';
        const filename = `${selectedFn.name.replace(/[^a-z0-9_-]/gi, '_')}.generated.test.${extension}`;
        const blob = new Blob([generatedCode], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className="tests-page">
            <TopNavBar activeWorkspace={activeWorkspace} onNavigate={onNavigate} onExitRepository={onExitRepository} />
            <div className="tests-dashboard-wrap">
                <section className="tests-dashboard" aria-label="Discovered test evidence">
                    <div className="tests-dashboard__main">
                        <div className="tests-dashboard__headline"><strong>Repository test evidence</strong></div>
                        <div className="tests-dashboard__pills">
                            <span className="tests-dashboard__pill">{functions.length} extracted functions</span>
                            <span className="tests-dashboard__pill">{analysisResult?.testLinkage?.testFileCount ?? uniqueTestFiles.size} test files detected</span>
                            <span className="tests-dashboard__pill">{links.length} source/test links</span>
                            <span className="tests-dashboard__pill">{endpoints.length} API routes discovered</span>
                        </div>
                        <p className="tests-page-subtitle">Pass/fail, flaky status and runtime coverage are unavailable until a real test runner reports them. No test execution is simulated.</p>
                    </div>
                </section>
            </div>
            <div className="tests-tabbar">
                {TABS.map(({ id, label, icon: Icon }) => (
                    <button key={id} className={`tests-tab${tab === id ? ' tests-tab--active' : ''}`} onClick={() => setTab(id)}>
                        <Icon size={14} strokeWidth={1.8} />{label}
                    </button>
                ))}
            </div>
            {tab === 'unit' && (
                <div className="tests-layout">
                    <ResizablePanel side="left" storageKey="tests-fn-panel" defaultWidth={270} minWidth={200} maxWidth={420}>
                        <div className="tests-sidebar">
                            <div className="tests-sidebar__header"><FlaskConical size={14} /> Functions ({functions.length})</div>
                            <label className="tests-real-search"><Search size={13} /><input aria-label="Search functions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search functions and files" /></label>
                            {filteredFunctions.length === 0 && <p className="tests-empty">No matching functions in this repository.</p>}
                            <ul className="tests-fn-list">
                                {filteredFunctions.map((fn) => (
                                    <li key={functionKey(fn)}>
                                        <button className={`tests-fn-item${functionKey(fn) === selectedId ? ' tests-fn-item--active' : ''}`} onClick={() => { setSelectedKey(functionKey(fn)); setGenerationError(''); }} title={fn.file}>
                                            <span className="tests-fn-item__name">{fn.name}</span>
                                            <span className="tests-fn-item__file">{fn.file}:{fn.line || '—'}</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </ResizablePanel>
                    <main className="tests-content">
                        {!selectedFn ? <p className="tests-page-subtitle">No functions extracted for this repository.</p> : (
                            <div className="tests-columns">
                                <section className="tests-card">
                                    <div className="tests-card__header"><h2>Source evidence</h2><p>{selectedFn.file}:{selectedFn.line || '—'}{selectedFn.endLine ? `–${selectedFn.endLine}` : ''}</p></div>
                                    <pre className="tests-code">{selectedFn.code || 'Source snippet unavailable.'}</pre>
                                </section>
                                <section className="tests-card">
                                    <div className="tests-card__header"><h2>Generate unit tests with AI service</h2><p>AI-generated code is a proposal, not executed or verified.</p></div>
                                    <div className="tests-actions">
                                        <button className="tests-btn tests-btn--primary" disabled={generating || !selectedFn.code?.trim()} onClick={generate}><Sparkles size={14} /> {generating ? 'Generating…' : 'Generate from real source'}</button>
                                        {generatedCode && <button className="tests-btn" onClick={saveGenerated}><Download size={14} /> Download generated test</button>}
                                    </div>
                                    {generationError && <p className="tests-real-error" role="alert"><AlertTriangle size={14} /> {generationError}</p>}
                                    {generatedCode ? <textarea aria-label="Generated test code" className="tests-real-editor" spellCheck={false} value={generatedCode} onChange={(event) => setGeneratedByKey((prev) => ({ ...prev, [selectedId]: event.target.value }))} />
                                        : <p className="tests-results__empty">No generated tests. Configure the AI service to generate tests. There is no fake fallback.</p>}
                                    <p className="tests-page-subtitle">To obtain real PASS/FAIL and coverage, run the downloaded test in the repository's configured test runner. This frontend does not execute untrusted repository code.</p>
                                </section>
                            </div>
                        )}
                    </main>
                </div>
            )}
            {tab === 'feature' && <TestLinkageTab linkage={analysisResult?.testLinkage} />}
            {tab === 'api' && <ApiEvidenceTab endpoints={endpoints} postmanCollection={analysisResult?.postmanCollection} authCoverage={analysisResult?.authCoverage} />}
        </div>
    );
}

function TestLinkageTab({ linkage }) {
    const links = safeArray(linkage?.links);
    return (
        <main className="tests-content tests-content--feature">
            <h3>Tests linked to source files ({links.length})</h3>
            <p className="tests-page-subtitle">Links below are extracted from repository imports and naming evidence. They do not imply a test passed, ran recently or covers a function at runtime.</p>
            {!links.length && <p className="tests-results__empty">No source-to-test links found in this repository. No representative test results are invented.</p>}
            <div className="tests-real-link-list">
                {links.map((link, index) => (
                    <article className="feature-case" key={`${link.sourceFile}:${link.testFile}:${index}`}>
                        <div className="feature-case__top"><span className="feature-case__id">{link.relationship || 'inferred association'}</span><span className="feature-case__status feature-case__status--not_run">NOT EXECUTED</span></div>
                        <h4 className="feature-case__title">{link.testFile}</h4>
                        <p className="feature-case__steps"><strong>Source:</strong> {link.sourceFile}</p>
                        <p className="feature-case__expected"><strong>Evidence:</strong> {link.evidence?.path ? `${link.evidence.path}:${link.evidence.line ?? '—'}` : 'Naming / inferred link'}{link.confidence ? ` · ${link.confidence}` : ''}</p>
                        {link.evidence?.excerpt && <pre className="tests-real-excerpt">{link.evidence.excerpt}</pre>}
                    </article>
                ))}
            </div>
        </main>
    );
}

function ApiEvidenceTab({ endpoints, postmanCollection, authCoverage }) {
    const [check, setCheck] = useState(null);
    const [checking, setChecking] = useState(false);
    const checkBackend = async () => {
        setChecking(true);
        setCheck(null);
        const start = performance.now();
        try {
            const data = await listRepositories();
            setCheck({ ok: true, time: Math.round(performance.now() - start), count: Array.isArray(data) ? data.length : null });
        } catch (error) {
            setCheck({ ok: false, time: Math.round(performance.now() - start), message: error?.message || 'Connection failed' });
        } finally { setChecking(false); }
    };
    const exportPostman = () => {
        if (!postmanCollection) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(postmanCollection, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'discovered-api.postman_collection.json'; anchor.click(); URL.revokeObjectURL(url);
    };
    return (
        <main className="tests-content tests-content--api">
            <h3>Routes discovered in uploaded repository ({endpoints.length})</h3>
            <p className="tests-page-subtitle">These are static route declarations, not proof of a running API. We never send fabricated POST requests to the analyzed application.</p>
            {authCoverage?.totalEndpoints > 0 && <p className="tests-page-subtitle">Nearby-code auth signals: {authCoverage.protectedCount}/{authCoverage.totalEndpoints} routes marked protected (heuristic; global middleware may be missed).</p>}
            {postmanCollection && endpoints.length > 0 && <button className="tests-btn" onClick={exportPostman}><Download size={14} /> Export route collection</button>}
            {endpoints.length === 0 && <p className="tests-results__empty">No recognized route declarations detected for this repository.</p>}
            <div className="api-list">
                {endpoints.map((ep, index) => <div className="api-row" key={`${ep.method}:${ep.path}:${ep.file}:${ep.line}:${index}`}>
                    <div className="api-row__top"><span className={`api-method api-method--${String(ep.method).toLowerCase()}`}>{ep.method}</span><span className="api-path">{ep.path}</span></div>
                    <p className="api-desc">{ep.framework || 'Source'} · {ep.file}:{ep.line || '—'} · {ep.authProtected ? 'Nearby auth signal' : 'No local auth signal (not proof of public access)'}</p>
                </div>)}
            </div>
            <hr className="tests-section-divider" />
            <h3>Live connection check — AI Legacy Bridge backend</h3>
            <p className="tests-page-subtitle">Only a safe GET request to the configured app backend's repository list is supported here. This is not a test of the uploaded repository.</p>
            <button className="tests-btn tests-btn--primary" disabled={checking} onClick={checkBackend}><Play size={14} /> {checking ? 'Checking…' : 'Check backend connection'}</button>
            {check && <p role="status" className={check.ok ? 'tests-real-success' : 'tests-real-error'}>{check.ok ? <Check size={14} /> : <AlertTriangle size={14} />}{check.ok ? ` Backend responded in ${check.time} ms${check.count == null ? '' : ` · ${check.count} repository records`}` : ` ${check.message} (${check.time} ms)`}</p>}
        </main>
    );
}
