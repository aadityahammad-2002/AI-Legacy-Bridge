import { Boxes, MessageSquareCode, LogOut, CheckCircle2, FileCode2 } from 'lucide-react';
import './WorkspaceSelectionPage.css';

const LANGUAGE_LABELS = {
    java: 'Java', javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python',
    go: 'Go', ruby: 'Ruby', php: 'PHP', rust: 'Rust', c: 'C', cpp: 'C++',
    csharp: 'C#', kotlin: 'Kotlin', swift: 'Swift', scala: 'Scala',
};

/** Most common language among analyzed files — purely derived from existing data, nothing new fetched. */
function dominantLanguage(files) {
    if (!files || files.length === 0) return null;
    const counts = {};
    files.forEach((f) => {
        if (!f.language || f.language === 'other') return;
        counts[f.language] = (counts[f.language] || 0) + 1;
    });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top ? (LANGUAGE_LABELS[top[0]] || top[0]) : null;
}

/**
 * Page 2 — shown right after analysis completes. Just two choices + Exit
 * Repository (see PROJECT_DOCUMENTATION.md section 6). No graph or IDE
 * content lives here — that's the two workspaces this hands off to.
 */
export default function WorkspaceSelectionPage({ repoMeta, analysisResult, onEnterWorkspace, onExitRepository }) {
    const fileCount = analysisResult?.files?.length ?? 0;
    const classCount = analysisResult?.classes?.length ?? 0;
    const language = dominantLanguage(analysisResult?.files);

    return (
        <div className="workspace-select">
            <button className="workspace-select__exit" onClick={onExitRepository}>
                <LogOut size={14} strokeWidth={1.8} />
                Exit Repository
            </button>

            <div className="workspace-select__content">
                <div className="workspace-select__check-ring">
                    <CheckCircle2 size={32} strokeWidth={1.8} />
                </div>
                <h1 className="workspace-select__title">Analysis Complete</h1>

                <div className="workspace-select__repo-badge">
                    <span className="workspace-select__repo-name">{repoMeta?.name}</span>
                    {repoMeta?.source && <span className="workspace-select__repo-source">{repoMeta.source}</span>}
                </div>

                {(fileCount > 0 || language) && (
                    <p className="workspace-select__meta">
                        Analyzed just now
                        {language && <> · {language}</>}
                        {fileCount > 0 && <> · {fileCount} files</>}
                        {classCount > 0 && <> · {classCount} classes</>}
                    </p>
                )}

                <div className="workspace-select__cards">
                    <button
                        className="workspace-card workspace-card--viz"
                        onClick={() => onEnterWorkspace('visualization')}
                    >
                        <div className="workspace-card__icon-badge workspace-card__icon-badge--viz">
                            <Boxes size={22} strokeWidth={1.6} />
                        </div>
                        <span className="workspace-card__title">Visualization Explorer</span>
                        <span className="workspace-card__desc">
                            Explore architecture, dependencies, metrics, and relationships visually.
                        </span>
                        <span className="workspace-card__cta workspace-card__cta--viz">
                            Open Visualization Explorer
                        </span>
                    </button>

                    <button
                        className="workspace-card workspace-card--ai"
                        onClick={() => onEnterWorkspace('ai-explorer')}
                    >
                        <div className="workspace-card__icon-badge workspace-card__icon-badge--ai">
                            <MessageSquareCode size={22} strokeWidth={1.6} />
                        </div>
                        <span className="workspace-card__title">AI Explorer</span>
                        <span className="workspace-card__desc">
                            Ask repository-aware questions and get AI-powered insights.
                        </span>
                        <span className="workspace-card__cta workspace-card__cta--ai">
                            Open AI Explorer
                        </span>
                    </button>
                </div>

                {fileCount > 0 && (
                    <div className="workspace-select__footnote">
                        <FileCode2 size={12} strokeWidth={1.8} />
                        Ready to explore — nothing left to configure.
                    </div>
                )}
            </div>
        </div>
    );
}
