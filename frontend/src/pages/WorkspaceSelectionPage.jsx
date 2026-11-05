import ExportWorker from '../workers/export.worker.js?worker';
import { toWorkspaceAnalysisSourceJson } from '../export/workspaceAnalysisSourceExport.js';
import { runWorker } from '../workers/workerClient.js';
import { Boxes, MessageSquareCode, LogOut, CheckCircle2, FileCode2, Download } from 'lucide-react';
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

    async function handleExportAnalysisJson() {
        // Export analysis + verbatim source from the locally retained repository
        // snapshot. The frozen Analysis Engine's 82 sections are not modified.
        // All sizes use the Worker to avoid blocking the browser UI.
        let exportJson;
        try {
            exportJson = typeof Worker !== 'undefined'
                ? await runWorker(ExportWorker, { analysisResult: analysisResult || {}, repoMeta })
                : toWorkspaceAnalysisSourceJson(analysisResult || {}, repoMeta);
        } catch (error) {
            console.error('[WorkspaceSelectionPage] JSON export failed:', error);
            window.alert(`Could not export repository analysis + source: ${error.message}`);
            return;
        }
        const blob = new Blob([exportJson], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        const safeName = String(repoMeta?.name || analysisResult?.repository?.name || 'repository')
            .replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'repository';
        anchor.href = url;
        anchor.download = `${safeName}-analysis-with-source.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

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

                <button className="workspace-select__export" onClick={handleExportAnalysisJson}>
                    <Download size={15} strokeWidth={1.8} />
                    Download Analysis + Source JSON
                </button>
                <p className="workspace-select__meta" style={{ maxWidth: 560, textAlign: 'center' }}>
                    Includes raw repository text files and may contain credentials or other sensitive code. Keep the downloaded JSON private.
                </p>

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
