import { useState, useEffect, useCallback } from 'react';

import UploadPage from './pages/UploadPage.jsx';
import WorkspaceSelectionPage from './pages/WorkspaceSelectionPage.jsx';
import VisualizationExplorer from './pages/VisualizationExplorer.jsx';
import AiExplorer from './pages/AiExplorer.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import TestsPage from './pages/TestsPage.jsx';
import MigratePage from './pages/MigratePage.jsx';

import {
    getActiveRepositoryId,
    getCurrentWorkspace,
    setCurrentWorkspace,
    loadAnalysisSnapshot,
    exitRepository,
} from './session/session.js';

/**
 * Existing product state machine, with an optional fresh upload entry from
 * the marketing landing page. /app reloads still recover saved workspaces.
 */
export default function App({ startOnUpload = false }) {
    const [view, setView] = useState('loading'); // loading | upload | workspace-select | workspace
    const [repositoryId, setRepositoryId] = useState(null);
    const [repoMeta, setRepoMeta] = useState(null);
    const [analysisResult, setAnalysisResult] = useState(null);
    const [activeWorkspace, setActiveWorkspaceState] = useState('visualization');
    const [focusedContext, setFocusedContext] = useState(null);
    const [ingestWarning, setIngestWarning] = useState(null);
    const [showSettings, setShowSettings] = useState(false);

    // Preserve the original session-restore behavior for direct /app visits.
    // A CTA click starts at the upload UI without clearing saved data.
    useEffect(() => {
        if (startOnUpload) {
            setView('upload');
            return;
        }
        let cancelled = false;
        (async () => {
            const savedRepositoryId = getActiveRepositoryId();
            if (!savedRepositoryId) {
                if (!cancelled) setView('upload');
                return;
            }
            try {
                const snapshot = await loadAnalysisSnapshot(savedRepositoryId);
                if (cancelled) return;
                if (!snapshot) {
                    setView('upload');
                    return;
                }
                setRepositoryId(savedRepositoryId);
                setRepoMeta(snapshot.repository);
                setAnalysisResult(snapshot);
                setActiveWorkspaceState(getCurrentWorkspace());
                setView('workspace');
            } catch (err) {
                if (cancelled) return;
                console.error('[App] failed to restore session:', err);
                setView('upload');
            }
        })();
        return () => { cancelled = true; };
    }, [startOnUpload]);

    const handleAnalysisComplete = useCallback(({ repositoryId: newId, repoMeta: newMeta, analysisResult: newResult, ingestError }) => {
        setRepositoryId(newId);
        setRepoMeta(newMeta);
        setAnalysisResult(newResult);
        setIngestWarning(ingestError || null);
        setView('workspace-select');
    }, []);

    const handleEnterWorkspace = useCallback((workspace) => {
        setCurrentWorkspace(workspace);
        setActiveWorkspaceState(workspace);
        setView('workspace');
    }, []);

    const handleNavigate = useCallback((workspace) => {
        if (workspace === 'settings') {
            setShowSettings(true);
            return;
        }
        setShowSettings(false);
        setCurrentWorkspace(workspace);
        setActiveWorkspaceState(workspace);
        if (workspace !== 'ai-explorer') setFocusedContext(null);
    }, []);

    const handleBackFromSettings = useCallback(() => {
        setShowSettings(false);
    }, []);

    const handleOpenAiExplorerFocused = useCallback((context) => {
        setFocusedContext(context);
        setCurrentWorkspace('ai-explorer');
        setActiveWorkspaceState('ai-explorer');
    }, []);

    const handleExitRepository = useCallback(async () => {
        await exitRepository();
        setRepositoryId(null);
        setRepoMeta(null);
        setAnalysisResult(null);
        setFocusedContext(null);
        setIngestWarning(null);
        setShowSettings(false);
        setView('upload');
    }, []);

    if (view === 'loading') return null;

    if (view === 'upload') {
        return <UploadPage onAnalysisComplete={handleAnalysisComplete} />;
    }

    if (view === 'workspace-select') {
        return (
            <>
                {ingestWarning && (
                    <div style={{
                        background: '#3a1414', color: '#ef6a6a', padding: '10px 16px',
                        fontSize: 13, fontFamily: 'monospace', textAlign: 'center',
                    }}>
                        Backend ingest failed: {ingestWarning} — Visualization Explorer will still work; AI Explorer will not until this is resolved.
                    </div>
                )}
                <WorkspaceSelectionPage
                    repoMeta={repoMeta}
                    analysisResult={analysisResult}
                    onEnterWorkspace={handleEnterWorkspace}
                    onExitRepository={handleExitRepository}
                />
            </>
        );
    }

    if (showSettings) {
        return (
            <SettingsPage
                activeWorkspace="settings"
                onNavigate={handleNavigate}
                onExitRepository={handleExitRepository}
                onBack={handleBackFromSettings}
            />
        );
    }

    if (activeWorkspace === 'ai-explorer') {
        return (
            <AiExplorer
                repositoryId={repositoryId}
                analysisResult={analysisResult}
                focusedContext={focusedContext}
                activeWorkspace={activeWorkspace}
                onNavigate={handleNavigate}
                onExitRepository={handleExitRepository}
            />
        );
    }

    if (activeWorkspace === 'tests') {
        return (
            <TestsPage
                repositoryId={repositoryId}
                analysisResult={analysisResult}
                activeWorkspace={activeWorkspace}
                onNavigate={handleNavigate}
                onExitRepository={handleExitRepository}
            />
        );
    }

    if (activeWorkspace === 'migrate') {
        return (
            <MigratePage
                repositoryId={repositoryId}
                analysisResult={analysisResult}
                activeWorkspace={activeWorkspace}
                onNavigate={handleNavigate}
                onExitRepository={handleExitRepository}
            />
        );
    }

    return (
        <VisualizationExplorer
            analysisResult={analysisResult}
            activeWorkspace={activeWorkspace}
            onNavigate={handleNavigate}
            onExitRepository={handleExitRepository}
            onOpenAiExplorerFocused={handleOpenAiExplorerFocused}
        />
    );
}
