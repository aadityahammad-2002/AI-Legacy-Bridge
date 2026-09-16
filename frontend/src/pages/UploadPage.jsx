import { useState, useRef, useCallback, useEffect } from 'react';
import { GitBranch, FileArchive, FolderOpen, Loader2, KeyRound, History, Boxes, Rocket, RefreshCw, Trash2 } from 'lucide-react';
import * as acorn from 'acorn';
import * as Babel from '@babel/standalone';

import { fetchGitHubRepository } from '../repo-sources/github.js';
import { readZipRepository } from '../repo-sources/zip.js';
import { readLocalFolderFromInput, pickAndReadLocalFolder, isFileSystemAccessSupported } from '../repo-sources/localFolder.js';
import { configureAnalysisEngine, analyzeRepository } from '../analysis-engine/orchestrator.js';
import { saveAnalysisSnapshot, setActiveSession, loadAnalysisSnapshot } from '../session/session.js';
import { ingestAnalysis, listRepositories, getRepositoryDetail, deleteRepository } from '../api/backend.js';

import './UploadPage.css';

configureAnalysisEngine({ acorn, Babel });

const PHASE_LABELS = {
    listing: 'Listing repository files…',
    downloading: 'Downloading source…',
    unzipping: 'Unpacking archive…',
    reading: 'Reading files…',
    extracting: 'Extracting functions & classes…',
    dependencies: 'Resolving dependencies…',
    patterns: 'Detecting patterns…',
    security: 'Scanning for security issues…',
    duplicates: 'Checking for duplicate code…',
    done: 'Analysis complete',
};

/** Normalizes a GitHub URL/slug for duplicate comparison (case, trailing slash, .git suffix). */
function normalizeRepoUrl(input) {
    return input.trim().toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
}

function formatRelativeDate(isoString) {
    const date = new Date(isoString);
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    return date.toLocaleDateString();
}

/**
 * Page 1 — Repository Upload Page.
 *
 * Deliberately minimal: repo selection + Analyze button only. No graph, no
 * metrics 
 * Visualization Explorer, shown only after this page hands off to the Workspace Selection
 * page (see PROJECT_DOCUMENTATION.md, sections 3 & 6).
 *
 * @param {(args: { repositoryId: string, repoMeta: object, analysisResult: object }) => void} onAnalysisComplete
 */
export default function UploadPage({ onAnalysisComplete }) {
    const [activeTab, setActiveTab] = useState('github');
    const [githubUrl, setGithubUrl] = useState('');
    const [githubToken, setGithubToken] = useState('');
    const [showTokenField, setShowTokenField] = useState(false);
    const [zipFile, setZipFile] = useState(null);
    const [localFileList, setLocalFileList] = useState(null);
    const [localFolderName, setLocalFolderName] = useState('');
    const [localPreloaded, setLocalPreloaded] = useState(null); // { repoMeta, files } once Browse succeeds (FSA browsers)
    const [browsingFolder, setBrowsingFolder] = useState(false);

    const [status, setStatus] = useState('idle'); // idle | working | error
    const [progress, setProgress] = useState(null); // { phase, current, total }
    const [errorMessage, setErrorMessage] = useState('');

    const [recentRepos, setRecentRepos] = useState([]);
    const [recentReposError, setRecentReposError] = useState(null);
    const [reopeningId, setReopeningId] = useState(null);
    const [deletingId, setDeletingId] = useState(null);
    const [duplicateMatch, setDuplicateMatch] = useState(null); // RepositorySummaryDto | null

    const folderInputRef = useRef(null);

    useEffect(() => {
        listRepositories()
            .then(setRecentRepos)
            .catch((err) => {
                // Backend being unreachable shouldn't block using the app —
                // Visualization Explorer works entirely off the local
                // Analysis Engine regardless. Just hide the list.
                console.warn('[UploadPage] could not load recent repositories:', err.message);
                setRecentReposError(err.message);
            });
    }, []);

    const canAnalyze =
        status !== 'working' &&
        !browsingFolder &&
        ((activeTab === 'github' && githubUrl.trim().length > 0) ||
            (activeTab === 'zip' && zipFile) ||
            (activeTab === 'local' && (localPreloaded !== null || localFileList?.length > 0)));

    const handleProgress = useCallback((p) => setProgress(p), []);

    function handleAnalyzeClick() {
        if (activeTab === 'github') {
            const normalized = normalizeRepoUrl(githubUrl);
            const match = recentRepos.find(
                (r) => r.source === 'github' && r.url && normalizeRepoUrl(r.url) === normalized
            );
            if (match) {
                setDuplicateMatch(match);
                return;
            }
        }
        runAnalysis();
    }

    async function handleReopenRepository(summary) {
        setDuplicateMatch(null);
        setReopeningId(summary.id);
        setErrorMessage('');
        try {
            // Fast path: this browser already has the full local snapshot
            // (including fileContents) — just reuse it, no network needed.
            let snapshot = await loadAnalysisSnapshot(summary.id).catch(() => null);

            if (!snapshot) {
                // Slow path: reconstruct from the backend. Since Task 6, the
                // backend also stores full file content, so the editor works
                // here too — build the same fileContents shape the fast path
                // produces, from files[].content in the reconstructed response.
                const detail = await getRepositoryDetail(summary.id);
                if (!detail) {
                    throw new Error('This repository is no longer available on the server.');
                }
                const fileContents = Object.fromEntries(
                    detail.files.filter((f) => f.content != null).map((f) => [f.path, f.content])
                );
                snapshot = { ...detail, fileContents };
                await saveAnalysisSnapshot(summary.id, snapshot);
            }

            setActiveSession(summary.id, 'visualization');
            onAnalysisComplete?.({ repositoryId: summary.id, repoMeta: snapshot.repository, analysisResult: snapshot, ingestError: null });
        } catch (err) {
            console.error('[UploadPage] failed to reopen repository:', err);
            setStatus('error');
            setErrorMessage(err.message || 'Could not reopen this repository.');
        } finally {
            setReopeningId(null);
        }
    }

    async function handleDeleteRepository(repo, e) {
        e.stopPropagation();
        if (!window.confirm(`Delete "${repo.name}"? This removes it from the server permanently.`)) {
            return;
        }
        setDeletingId(repo.id);
        try {
            await deleteRepository(repo.id);
            setRecentRepos((list) => list.filter((r) => r.id !== repo.id));
        } catch (err) {
            console.error('[UploadPage] failed to delete repository:', err);
            setErrorMessage(err.message || 'Could not delete this repository.');
        } finally {
            setDeletingId(null);
        }
    }

    /**
     * Reanalyze only makes sense for GitHub-sourced repos — that's the only
     * source we still have a stable reference to (repo.url). ZIP/local
     * folder sources have no persisted original file content to re-read
     * from, so those don't get a Reanalyze action (see recent-repo-item
     * rendering below).
     */
    function handleReanalyzeRepository(repo, e) {
        e.stopPropagation();
        setActiveTab('github');
        setGithubUrl(repo.url || '');
        setDuplicateMatch(null);
        runAnalysis(repo.url || '');
    }

    async function runAnalysis(overrideGithubUrl) {
        setDuplicateMatch(null);
        setStatus('working');
        setErrorMessage('');
        setProgress(null);
        try {
            let repoMeta, files, truncated;

            if (activeTab === 'github') {
                ({ repoMeta, files, truncated } = await fetchGitHubRepository(
                    (overrideGithubUrl ?? githubUrl).trim(),
                    githubToken.trim() || undefined,
                    handleProgress
                ));
            } else if (activeTab === 'zip') {
                ({ repoMeta, files } = await readZipRepository(zipFile, handleProgress));
            } else {
                if (localPreloaded) {
                    ({ repoMeta, files } = localPreloaded);
                } else if (localFileList?.length > 0) {
                    ({ repoMeta, files } = await readLocalFolderFromInput(localFileList, handleProgress));
                } else {
                    // Safety net only — Browse now pre-loads the folder immediately
                    // (see handleBrowseClick), so this path shouldn't normally run.
                    ({ repoMeta, files } = await pickAndReadLocalFolder(handleProgress));
                }
            }

            if (!files || files.length === 0) {
                throw new Error('No analyzable source files were found in this repository.');
            }
            if (truncated) {
                console.warn('[UploadPage] GitHub tree response was truncated — very large repo, some files may be missing.');
            }

            const analysisResult = await analyzeRepository(repoMeta, files, handleProgress);

            const repositoryId = crypto.randomUUID();

            // The backend ingest contract intentionally only needs file
            // metadata (path/language/loc) — RAG chunking is function-level
            // (see orchestrator.js's `functions[].code`), so it never needs
            // whole-file source. The AI Explorer's code editor does, though,
            // so we keep full file content in the LOCAL snapshot only —
            // never sent to the backend — keyed by path.
            const fileContents = Object.fromEntries(files.map((f) => [f.path, f.content]));
            const localSnapshot = { ...analysisResult, fileContents };

            // Persist as the Live Analysis Model (IndexedDB) for refresh survival,
            // and point the session at it.
            await saveAnalysisSnapshot(repositoryId, localSnapshot);
            setActiveSession(repositoryId, 'visualization');

            let ingestError = null;
            try {
                await ingestAnalysis(repositoryId, analysisResult);
            } catch (err) {
                // Visualization Explorer runs off the local IndexedDB snapshot and
                // doesn't need the backend, so a failed ingest shouldn't block the
                // user from proceeding — but AI Explorer will have no data until
                // this succeeds, so the caller needs to know to surface a warning
                // once the Workspace Selection / Visualization page is showing.
                console.error('[UploadPage] backend ingest failed:', err);
                ingestError = err.message;
            }

            onAnalysisComplete?.({ repositoryId, repoMeta, analysisResult: localSnapshot, ingestError });
        } catch (err) {
            console.error('[UploadPage] analysis failed:', err);
            setStatus('error');
            setErrorMessage(err.message || 'Something went wrong while analyzing this repository.');
            return;
        }
    }

    function handleZipInput(e) {
        const file = e.target.files?.[0];
        if (file) setZipFile(file);
    }

    function handleFolderInput(e) {
        const list = e.target.files;
        if (list && list.length > 0) {
            setLocalFileList(list);
            const root = (list[0].webkitRelativePath || list[0].name).split('/')[0];
            setLocalFolderName(root);
        }
    }

    /**
     * Task 3 fix: Browse must open the native folder picker immediately,
     * not merely mark "local" as the active source and defer picking until
     * Analyze is clicked. If the user cancels the picker, Analyze stays
     * disabled (no folder was set) rather than silently activating.
     */
    async function handleBrowseClick() {
        setErrorMessage('');
        setBrowsingFolder(true);
        try {
            const result = await pickAndReadLocalFolder(handleProgress);
            if (!result.files || result.files.length === 0) {
                throw new Error('No analyzable source files were found in that folder.');
            }
            setLocalPreloaded(result);
            setLocalFolderName(result.repoMeta.name);
            setActiveTab('local');
        } catch (err) {
            if (err.name === 'AbortError') {
                // User cancelled the native picker — do nothing, Analyze stays disabled.
            } else {
                console.error('[UploadPage] folder selection failed:', err);
                setErrorMessage(err.message || 'Could not read that folder.');
            }
        } finally {
            setBrowsingFolder(false);
        }
    }

    const progressPct =
        progress && progress.total ? Math.round((progress.current / progress.total) * 100) : null;

    return (
        <div className="upload-page">
            <div className="upload-page__ambient" aria-hidden="true">
                <AmbientGraph />
            </div>

            <div className="upload-page__content">
                <div className="upload-page__brand-mark">
                    <Boxes size={26} strokeWidth={1.8} />
                </div>
                <h1 className="upload-page__brand-name">AI Legacy Bridge</h1>
                <p className="upload-page__subhead">
                    Understand, visualize, and get AI help on your codebases.
                </p>

                <div className="upload-columns">
                    <div className="upload-column upload-column--main">
                        <div className="upload-card lb-glass">
                            <div className="upload-card__body">
                                {duplicateMatch && (
                                    <div className="upload-duplicate">
                                        <p>
                                            <strong>{duplicateMatch.name}</strong> was already analyzed{' '}
                                            {formatRelativeDate(duplicateMatch.createdAt)}.
                                        </p>
                                        <div className="upload-duplicate__actions">
                                            <button
                                                className="upload-duplicate__open-btn"
                                                onClick={() => handleReopenRepository(duplicateMatch)}
                                            >
                                                Open existing
                                            </button>
                                            <button
                                                className="upload-duplicate__reanalyze-btn"
                                                onClick={() => runAnalysis()}
                                            >
                                                Re-analyze anyway
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {/* GitHub URL row */}
                                <div className="upload-row">
                                    <label htmlFor="github-url" className="upload-row__label">
                                        <GitBranch size={15} strokeWidth={1.8} />
                                        GitHub Repository URL
                                    </label>
                                    <div className="upload-row__controls">
                                        <input
                                            id="github-url"
                                            type="text"
                                            className="upload-row__input"
                                            placeholder="https://github.com/owner/repository"
                                            value={githubUrl}
                                            onChange={(e) => {
                                                setGithubUrl(e.target.value);
                                                setActiveTab('github');
                                            }}
                                            onFocus={() => setActiveTab('github')}
                                            disabled={status === 'working'}
                                        />
                                        <button
                                            type="button"
                                            className="upload-row__action-btn"
                                            onClick={() => setActiveTab('github')}
                                            disabled={status === 'working'}
                                        >
                                            Fetch
                                        </button>
                                    </div>
                                    {!showTokenField ? (
                                        <button
                                            type="button"
                                            className="upload-field__ghost-action"
                                            onClick={() => setShowTokenField(true)}
                                        >
                                            <KeyRound size={13} strokeWidth={1.8} />
                                            Add a token for private repos / higher rate limits
                                        </button>
                                    ) : (
                                        <input
                                            type="password"
                                            className="upload-row__input upload-row__input--secondary"
                                            placeholder="Personal access token (kept in this browser tab only)"
                                            value={githubToken}
                                            onChange={(e) => setGithubToken(e.target.value)}
                                            disabled={status === 'working'}
                                        />
                                    )}
                                </div>

                                <div className="upload-divider"><span>OR</span></div>

                                {/* ZIP upload row */}
                                <div className="upload-row">
                                    <label htmlFor="zip-input" className="upload-row__label">
                                        <FileArchive size={15} strokeWidth={1.8} />
                                        Upload ZIP File
                                    </label>
                                    <div className="upload-row__controls">
                                        <div className="upload-row__filename">
                                            {zipFile ? zipFile.name : 'No file selected'}
                                        </div>
                                        <label htmlFor="zip-input" className="upload-row__action-btn upload-row__action-btn--label">
                                            Choose File
                                        </label>
                                        <input
                                            id="zip-input"
                                            type="file"
                                            accept=".zip"
                                            className="upload-field__hidden-input"
                                            onChange={(e) => { handleZipInput(e); setActiveTab('zip'); }}
                                            disabled={status === 'working'}
                                        />
                                    </div>
                                </div>

                                <div className="upload-divider"><span>OR</span></div>

                                {/* Local folder row */}
                                <div className="upload-row">
                                    <label className="upload-row__label">
                                        <FolderOpen size={15} strokeWidth={1.8} />
                                        Select Local Folder
                                    </label>
                                    <div className="upload-row__controls">
                                        <div className="upload-row__filename">
                                            {localFolderName || 'No folder selected'}
                                        </div>
                                        {isFileSystemAccessSupported() ? (
                                            <button
                                                type="button"
                                                className="upload-row__action-btn"
                                                onClick={handleBrowseClick}
                                                disabled={status === 'working' || browsingFolder}
                                            >
                                                {browsingFolder ? <Loader2 size={14} className="upload-card__spinner" /> : 'Browse'}
                                            </button>
                                        ) : (
                                            <>
                                                <label htmlFor="folder-input" className="upload-row__action-btn upload-row__action-btn--label">
                                                    Browse
                                                </label>
                                                <input
                                                    ref={folderInputRef}
                                                    id="folder-input"
                                                    type="file"
                                                    webkitdirectory=""
                                                    directory=""
                                                    multiple
                                                    className="upload-field__hidden-input"
                                                    onChange={(e) => { handleFolderInput(e); setActiveTab('local'); }}
                                                    disabled={status === 'working'}
                                                />
                                            </>
                                        )}
                                    </div>
                                </div>

                                <button
                                    className="upload-card__analyze-btn"
                                    disabled={!canAnalyze}
                                    onClick={handleAnalyzeClick}
                                >
                                    {status === 'working' ? (
                                        <>
                                            <Loader2 size={17} className="upload-card__spinner" />
                                            Analyzing…
                                        </>
                                    ) : (
                                        <>
                                            <Rocket size={16} strokeWidth={2} />
                                            Analyze Repository
                                        </>
                                    )}
                                </button>

                                {status === 'working' && progress && (
                                    <div className="upload-progress">
                                        <div className="upload-progress__track">
                                            <div
                                                className="upload-progress__fill"
                                                style={{ width: progressPct !== null ? `${progressPct}%` : '30%' }}
                                            />
                                        </div>
                                        <span className="upload-progress__label">
                                            {PHASE_LABELS[progress.phase] || progress.phase}
                                            {progress.total ? ` (${progress.current}/${progress.total})` : ''}
                                        </span>
                                    </div>
                                )}

                                {status === 'error' && <div className="upload-error">{errorMessage}</div>}
                            </div>
                        </div>
                    </div>

                    {recentRepos.length > 0 && (
                        <div className="upload-column upload-column--recent">
                            <div className="recent-repos lb-glass">
                                <h3 className="recent-repos__title">
                                    <History size={13} strokeWidth={1.8} />
                                    Recent Repositories
                                    <span className="recent-repos__count">{recentRepos.length}</span>
                                </h3>
                                <div className="recent-repos__list">
                                    {recentRepos.map((repo) => (
                                        <div key={repo.id} className="recent-repo-item">
                                            <button
                                                className="recent-repo-item__open"
                                                onClick={() => handleReopenRepository(repo)}
                                                disabled={reopeningId !== null || deletingId !== null || status === 'working'}
                                            >
                                                <span className={`recent-repo-item__icon recent-repo-item__icon--${repo.source}`}>
                                                    {repo.source === 'github' ? <GitBranch size={14} /> : repo.source === 'zip' ? <FileArchive size={14} /> : <FolderOpen size={14} />}
                                                </span>
                                                <div className="recent-repo-item__main">
                                                    <span className="recent-repo-item__name">{repo.name}</span>
                                                    <span className="recent-repo-item__meta">
                                                        Analyzed {formatRelativeDate(repo.createdAt)}
                                                    </span>
                                                </div>
                                                {repo.healthGrade && (
                                                    <span className={`recent-repo-item__grade recent-repo-item__grade--${repo.healthGrade.toLowerCase()}`}>
                                                        {repo.healthGrade}
                                                    </span>
                                                )}
                                            </button>
                                            <div className="recent-repo-item__actions">
                                                {reopeningId === repo.id ? (
                                                    <Loader2 size={13} className="upload-card__spinner" />
                                                ) : (
                                                    <>
                                                        {repo.source === 'github' && (
                                                            <button
                                                                className="recent-repo-item__icon-btn"
                                                                title="Re-analyze"
                                                                onClick={(e) => handleReanalyzeRepository(repo, e)}
                                                                disabled={deletingId !== null || status === 'working'}
                                                            >
                                                                <RefreshCw size={13} />
                                                            </button>
                                                        )}
                                                        <button
                                                            className="recent-repo-item__icon-btn recent-repo-item__icon-btn--danger"
                                                            title="Delete"
                                                            onClick={(e) => handleDeleteRepository(repo, e)}
                                                            disabled={deletingId !== null || status === 'working'}
                                                        >
                                                            {deletingId === repo.id ? (
                                                                <Loader2 size={13} className="upload-card__spinner" />
                                                            ) : (
                                                                <Trash2 size={13} />
                                                            )}
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/** Faint ambient constellation in the background — hints at the dependency graph to come, without showing it. */
function AmbientGraph() {
    const nodes = [
        [8, 15], [22, 40], [15, 70], [40, 20], [45, 55], [38, 85],
        [62, 30], [70, 65], [58, 88], [85, 18], [90, 50], [80, 78],
    ];
    const edges = [
        [0, 1], [1, 2], [1, 4], [3, 4], [4, 5], [4, 6],
        [6, 7], [6, 9], [7, 8], [7, 10], [9, 10], [10, 11],
    ];
    return (
        <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
            {edges.map(([a, b], i) => (
                <line
                    key={i}
                    x1={nodes[a][0]} y1={nodes[a][1]}
                    x2={nodes[b][0]} y2={nodes[b][1]}
                    className="ambient-graph__edge"
                />
            ))}
            {nodes.map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r={0.6} className="ambient-graph__node" />
            ))}
        </svg>
    );
}
