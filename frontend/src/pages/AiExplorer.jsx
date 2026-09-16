import { X, Send, Loader2, Sparkles, Target, Search, Plus, History } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState, useMemo, useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';

import TopNavBar from '../components/TopNavBar.jsx';
import FolderTree from '../components/FolderTree.jsx';
import GraphCanvas from '../components/GraphCanvas.jsx';
import AltVisualizations from '../components/AltVisualizations.jsx';
import ResizablePanel from '../components/ResizablePanel.jsx';
import { askAi } from '../api/backend.js';
import { AI_PERSONA_LIST, getPersona } from './aiExplorerPersonas.js';
import { DetectiveSidePanels, MissionControlSidePanels } from './AiExplorerSidePanels.jsx';
import CaseBoard from './CaseBoard.jsx';
import MissionBoard from './MissionBoard.jsx';
import './AiExplorer.css';

const EXTENSION_TO_MONACO_LANGUAGE = {
    java: 'java', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', go: 'go', rb: 'ruby', php: 'php', rs: 'rust', c: 'c', cpp: 'cpp',
    cs: 'csharp', kt: 'kotlin', swift: 'swift', scala: 'scala', json: 'json',
    md: 'markdown', yml: 'yaml', yaml: 'yaml', html: 'html', css: 'css', sql: 'sql',
};

function languageForPath(path) {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return EXTENSION_TO_MONACO_LANGUAGE[ext] || 'plaintext';
}

// --- Chat session persistence (localStorage, scoped per repository) ---

function sessionsStorageKey(repositoryId) {
    return `ai-explorer-sessions:${repositoryId}`;
}

function activeSessionStorageKey(repositoryId) {
    return `ai-explorer-active-session:${repositoryId}`;
}

function loadSessions(repositoryId) {
    if (!repositoryId) return [];
    try {
        const raw = localStorage.getItem(sessionsStorageKey(repositoryId));
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveSessions(repositoryId, sessions) {
    if (!repositoryId) return;
    try {
        localStorage.setItem(sessionsStorageKey(repositoryId), JSON.stringify(sessions));
    } catch {
        // storage full/unavailable — non-fatal
    }
}

function loadActiveSessionId(repositoryId) {
    if (!repositoryId) return null;
    try {
        return localStorage.getItem(activeSessionStorageKey(repositoryId));
    } catch {
        return null;
    }
}

function saveActiveSessionId(repositoryId, sessionId) {
    if (!repositoryId || !sessionId) return;
    try {
        localStorage.setItem(activeSessionStorageKey(repositoryId), sessionId);
    } catch {
        // non-fatal
    }
}

function newSessionId() {
    return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeSessionTitle(messages) {
    const firstUser = messages.find((m) => m.role === 'user');
    if (!firstUser) return 'New chat';
    const text = firstUser.content.trim();
    return text.length > 40 ? text.slice(0, 40) + '…' : text;
}

// --- Markdown helper ---

function normalizeMarkdown(text) {
    if (!text) return text;
    // Ensure a blank line precedes any line that starts a bullet/numbered
    // list — otherwise it gets swallowed into the preceding paragraph and
    // renders as literal "* " / "1. " text instead of an actual list.
    const lines = text.split('\n');
    const result = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isListLine = /^\s*([-*+]|\d+\.)\s/.test(line);
        const prevLine = result[result.length - 1];
        if (isListLine && prevLine !== undefined && prevLine.trim() !== '' && !/^\s*([-*+]|\d+\.)\s/.test(prevLine)) {
            result.push('');
        }
        result.push(line);
    }
    return result.join('\n');
}

/**
 * Page 4 — AI Explorer. IDE-style layout per PROJECT_DOCUMENTATION.md
 * section 8: folder tree | Monaco code editor with tabs | AI chat.
 *
 * The editor reads `analysisResult.fileContents` (full file source, kept in
 * the browser-local IndexedDB snapshot only; see UploadPage.jsx and
 * DEVELOPMENT_PROGRESS.md Entry 6 for why the backend never receives this).
 * The chat panel is wired to the real backend (`POST /api/ai/ask` — see
 * ContextRetrievalService/AgentOrchestrator/GroqClient).
 *
 * Chat history is multi-session (like a typical AI chat product): each
 * repository has its own list of sessions in localStorage, one of which is
 * "active" at a time. New Chat starts a fresh session; the history panel
 * lets you jump back to any previous one.
 */
export default function AiExplorer({ repositoryId, analysisResult, focusedContext, activeWorkspace, onNavigate, onExitRepository }) {
    const [openTabs, setOpenTabs] = useState(() => (focusedContext ? [focusedContext.selectedNode] : []));
    const [activeTab, setActiveTab] = useState(() => focusedContext?.selectedNode || null);

    const [sessions, setSessions] = useState(() => loadSessions(repositoryId));
    const [activeSessionId, setActiveSessionId] = useState(() => {
        const saved = loadActiveSessionId(repositoryId);
        const loaded = loadSessions(repositoryId);
        if (saved && loaded.some((s) => s.id === saved)) return saved;
        return loaded.length > 0 ? loaded[0].id : null;
    });
    const [historyOpen, setHistoryOpen] = useState(false);

    // Mirrors whichever map type was last picked in Visualization Explorer (Graph /
    // Treemap / Subway / Galaxy / etc — see the matching write there) so the mini-map
    // below shows the same view instead of always defaulting to the force graph.
    const [minimapVizType] = useState(() => localStorage.getItem('viz-explorer:vizType') || 'subway');

    // Presentation persona — Normal / Detective / Mission Control. Persisted per browser
    // (not per repository) since it's a personal preference, same as the mini-map choice
    // above. See aiExplorerPersonas.js for what actually changes between them.
    const [personaId, setPersonaId] = useState(() => localStorage.getItem('ai-explorer:persona') || 'normal');
    useEffect(() => { localStorage.setItem('ai-explorer:persona', personaId); }, [personaId]);
    const persona = getPersona(personaId);

    const messages = useMemo(() => {
        const active = sessions.find((s) => s.id === activeSessionId);
        return active ? active.messages : [];
    }, [sessions, activeSessionId]);

        function updateActiveMessages(updater) {
        setSessions((prev) => prev.map((s) => {
            if (s.id !== activeSessionId) return s;
            const nextMessages = updater(s.messages);
            return {
                ...s,
                messages: nextMessages,
                title: s.title === 'New chat' ? makeSessionTitle(nextMessages) : s.title,
                updatedAt: Date.now(),
            };
        }));
    }

    function startNewChat() {
        const sessionId = newSessionId();
        setSessions((prev) => [{ id: sessionId, title: 'New chat', messages: [], updatedAt: Date.now() }, ...prev]);
        setActiveSessionId(sessionId);
        setHistoryOpen(false);
    }

    function switchToSession(sessionId) {
        setActiveSessionId(sessionId);
        setHistoryOpen(false);
    }

    const [question, setQuestion] = useState('');
    const [asking, setAsking] = useState(false);
    const [treeSearch, setTreeSearch] = useState('');
    const chatEndRef = useRef(null);

    const filteredFiles = useMemo(() => {
        if (!treeSearch.trim()) return analysisResult.files;
        const q = treeSearch.trim().toLowerCase();
        return analysisResult.files.filter((f) => f.path.toLowerCase().includes(q));
    }, [analysisResult.files, treeSearch]);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
    }, [messages, asking]);

    useEffect(() => {
        if (!repositoryId) return;
        saveSessions(repositoryId, sessions);
    }, [sessions, repositoryId]);

    useEffect(() => {
        if (!repositoryId || !activeSessionId) return;
        saveActiveSessionId(repositoryId, activeSessionId);
    }, [activeSessionId, repositoryId]);

        useEffect(() => {
        let loaded = loadSessions(repositoryId);
        const saved = loadActiveSessionId(repositoryId);
        let activeId = saved && loaded.some((s) => s.id === saved) ? saved : (loaded.length > 0 ? loaded[0].id : null);

        // Guarantee there's always exactly one session to write into —
        // this removes the race where sending a message before a session
        // exists could create duplicate/fragmented sessions.
        if (!activeId) {
            const id = newSessionId();
            loaded = [{ id, title: 'New chat', messages: [], updatedAt: Date.now() }, ...loaded];
            activeId = id;
        }

        setSessions(loaded);
        setActiveSessionId(activeId);
    }, [repositoryId]);

    const fileContents = analysisResult.fileContents || {};
    const hasFileContents = Object.keys(fileContents).length > 0;

    function openFile(path) {
        if (!path) return; // GraphCanvas's background-click deselect passes null here — without this guard, null gets pushed into openTabs and crashes at path.split('/') in the tab bar below
        setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
        setActiveTab(path);
    }

    function closeTab(path, e) {
        e.stopPropagation();
        setOpenTabs((tabs) => {
            const next = tabs.filter((t) => t !== path);
            if (activeTab === path) setActiveTab(next.length > 0 ? next[next.length - 1] : null);
            return next;
        });
    }

    const activeContent = useMemo(
        () => (activeTab ? fileContents[activeTab] ?? '// File content not available for this file.' : ''),
        [activeTab, fileContents]
    );

    async function handleSend(overrideQuestion) {
        const q = (overrideQuestion ?? question).trim();
        if (!q || asking) return;
        setQuestion('');
        updateActiveMessages((m) => [...m, { role: 'user', content: q }]);
        setAsking(true);
        try {
            const response = await askAi(repositoryId, q, focusedContext?.selectedNode, activeTab, personaId);
            updateActiveMessages((m) => [...m, {
                role: 'assistant',
                content: response.answer,
                agentUsed: response.agentUsed,
                sourceFiles: response.sourceFiles,
            }]);
        } catch (err) {
            updateActiveMessages((m) => [...m, { role: 'error', content: err.message }]);
        } finally {
            setAsking(false);
        }
    }

    // Real suggested prompts — clicking one sends an actual question through
    // the same askAi() flow above, just pre-filled based on what's focused/open.
    // Wording comes from the active persona (see aiExplorerPersonas.js); the
    // question sent to the backend is identical regardless of persona.
    const suggestedPrompts = useMemo(() => {
        const target = focusedContext?.selectedNode || activeTab;
        const name = target ? target.split('/').pop().replace(/\.[^.]+$/, '') : null;
        if (!name) return persona.starterPrompts;
        return persona.contextPrompts(name);
    }, [focusedContext, activeTab, persona]);

    return (
        <div className={`ai-explorer ai-explorer--${personaId}`}>
            <TopNavBar activeWorkspace={activeWorkspace} onNavigate={onNavigate} onExitRepository={onExitRepository} />

            <div className="ai-explorer__body">
                <ResizablePanel side="left" storageKey="ai-explorer-tree" defaultWidth={260} minWidth={180} maxWidth={480}>
                    <div className="ai-explorer__tree-panel">
                        <h3 className="ai-explorer__panel-title">{persona.treeLabel}</h3>
                        <div className="ai-explorer__search">
                            <Search size={12} strokeWidth={2} />
                            <input
                                type="text"
                                value={treeSearch}
                                onChange={(e) => setTreeSearch(e.target.value)}
                                placeholder="Search files…"
                            />
                        </div>
                        <FolderTree files={filteredFiles} selectedPath={activeTab} onSelectFile={openFile} />
                    </div>

                    {analysisResult.graph && (
                        <div className="ai-explorer__minimap-panel">
                            <h3 className="ai-explorer__panel-title">
                                Mini Map {focusedContext ? '(Focused)' : '(Full Graph)'}
                            </h3>
                            <div className="ai-explorer__minimap-canvas">
                                {minimapVizType === 'graph' ? (
                                    <GraphCanvas
                                        nodes={analysisResult.graph.nodes}
                                        edges={analysisResult.graph.edges}
                                        selectedNodeId={focusedContext?.selectedNode || activeTab}
                                        onSelectNode={openFile}
                                        showLabels={false}
                                    />
                                ) : (
                                    <AltVisualizations
                                        vizType={minimapVizType}
                                        files={analysisResult.files}
                                        nodes={analysisResult.graph.nodes}
                                        edges={analysisResult.graph.edges}
                                        issues={analysisResult.issues}
                                        selectedNodeId={focusedContext?.selectedNode || activeTab}
                                        onSelectNode={openFile}
                                    />
                                )}
                            </div>
                        </div>
                    )}

                    {personaId === 'detective' && <DetectiveSidePanels analysisResult={analysisResult} />}
                    {personaId === 'missionControl' && <MissionControlSidePanels analysisResult={analysisResult} />}
                </ResizablePanel>

                <main className="ai-explorer__editor">
                    {openTabs.length > 0 && (
                        <div className="ai-explorer__tabs">
                            {openTabs.map((path) => (
                                <div
                                    key={path}
                                    className={`ai-explorer__tab${path === activeTab ? ' ai-explorer__tab--active' : ''}`}
                                    onClick={() => setActiveTab(path)}
                                >
                                    <span>{path.split('/').pop()}</span>
                                    <X size={12} strokeWidth={2} onClick={(e) => closeTab(path, e)} />
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="ai-explorer__editor-body">
                        {!activeTab ? (
                            !hasFileContents ? (
                                <div className="ai-explorer__empty">
                                    No file content available — this repository was analyzed before file content
                                    persistence was added; re-analyze to browse source here.
                                </div>
                            ) : personaId === 'detective' ? (
                                <CaseBoard analysisResult={analysisResult} onOpenFile={openFile} onAsk={handleSend} />
                            ) : personaId === 'missionControl' ? (
                                <MissionBoard analysisResult={analysisResult} onAsk={handleSend} />
                            ) : (
                                <div className="ai-explorer__empty">Select a file from the tree to open it.</div>
                            )
                        ) : (
                            <Editor
                                height="100%"
                                theme="vs-dark"
                                language={languageForPath(activeTab)}
                                value={activeContent}
                                options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
                            />
                        )}
                    </div>
                </main>

                <ResizablePanel side="right" storageKey="ai-explorer-chat" defaultWidth={300} minWidth={220} maxWidth={460}>
                    <div className="ai-explorer__chat">
                        <div className="ai-explorer__persona-switcher">
                            {AI_PERSONA_LIST.map((p) => {
                                const Icon = p.icon;
                                return (
                                    <button
                                        key={p.id}
                                        className={`ai-explorer__persona-btn${p.id === personaId ? ' ai-explorer__persona-btn--active' : ''}`}
                                        onClick={() => setPersonaId(p.id)}
                                        title={p.name}
                                    >
                                        <Icon size={13} strokeWidth={2} />
                                        {p.name}
                                    </button>
                                );
                            })}
                        </div>

                        <div className="ai-explorer__chat-header">
                            <h3 className="ai-explorer__panel-title">
                                {focusedContext ? `${persona.assistantLabel} (Focused)` : persona.assistantLabel}
                            </h3>
                            <div className="ai-explorer__chat-header-actions">
                                <button className="ai-explorer__icon-btn" onClick={startNewChat} title="New chat">
                                    <Plus size={13} strokeWidth={2} />
                                </button>
                                <button
                                    className="ai-explorer__icon-btn"
                                    onClick={() => setHistoryOpen((o) => !o)}
                                    title="Chat history"
                                >
                                    <History size={13} strokeWidth={2} />
                                </button>
                            </div>
                        </div>

                        {historyOpen && (
                            <div className="ai-explorer__history-panel">
                                {sessions.length === 0 && (
                                    <p className="ai-explorer__history-empty">No past chats yet.</p>
                                )}
                                {sessions
                                    .slice()
                                    .sort((a, b) => b.updatedAt - a.updatedAt)
                                    .map((s) => (
                                        <button
                                            key={s.id}
                                            className={`ai-explorer__history-item${s.id === activeSessionId ? ' ai-explorer__history-item--active' : ''}`}
                                            onClick={() => switchToSession(s.id)}
                                        >
                                            {s.title || 'New chat'}
                                        </button>
                                    ))}
                            </div>
                        )}

                        {focusedContext && (
                            <div className="ai-explorer__focused">
                                <Target size={12} strokeWidth={2} />
                                <span className="ai-explorer__focused-node">{persona.focusedLabel(focusedContext.selectedNode.split('/').pop())}</span>
                            </div>
                        )}

                        <div className="ai-explorer__suggested">
                            <span className="ai-explorer__suggested-label">{persona.suggestedLabel}</span>
                            {suggestedPrompts.map((p) => (
                                <button key={p} className="ai-explorer__suggested-chip" onClick={() => handleSend(p)} disabled={asking}>
                                    <Sparkles size={11} strokeWidth={2} />
                                    {p}
                                </button>
                            ))}
                        </div>

                        <div className="ai-explorer__messages">
                            {messages.length === 0 && (
                                <p className="ai-explorer__chat-empty">
                                    {persona.emptyState}
                                </p>
                            )}
                            {messages.map((m, i) => (
                                <div key={i} className={`ai-explorer__message ai-explorer__message--${m.role}`}>
                                    {m.role === 'assistant' && m.agentUsed && (
                                        <span className="ai-explorer__agent-badge">{m.agentUsed}</span>
                                    )}
                                    <div className="ai-explorer__message-content">
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(m.content)}</ReactMarkdown>
                                    </div>
                                    {m.sourceFiles?.length > 0 && (
                                        <div className="ai-explorer__sources">
                                            {m.sourceFiles.map((f) => (
                                                <span key={f} className="ai-explorer__source-chip">{f.split('/').pop()}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ))}
                            {asking && (
                                <div className="ai-explorer__message ai-explorer__message--assistant ai-explorer__message--loading">
                                    <Loader2 size={13} className="ai-explorer__spinner" /> {persona.thinkingLabel}
                                </div>
                            )}
                            <div ref={chatEndRef} />
                        </div>

                        <div className="ai-explorer__chat-input-row">
                            <input
                                value={question}
                                onChange={(e) => setQuestion(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
                                placeholder={persona.placeholder}
                                disabled={asking}
                            />
                            <button onClick={() => handleSend()} disabled={asking || !question.trim()}>
                                <Send size={14} strokeWidth={2} />
                            </button>
                        </div>
                    </div>
                </ResizablePanel>
            </div>
        </div>
    );
}