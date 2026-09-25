import { useMemo } from 'react';
import { CheckCircle2, Circle, MapPin } from 'lucide-react';

/** Shared: pull the same headline numbers Visualization Explorer shows, from the
 * same analysisResult shape — no separate calculation, no fake numbers. */
function useRepoStats(analysisResult) {
    return useMemo(() => {
        const { files = [], functions = [], dependencies = [], issues = [], healthScore } = analysisResult;
        const findCount = (titleMatch) => issues.find((i) => i.title?.includes(titleMatch))?.items?.length || 0;
        return {
            files: files.length,
            functions: functions.length,
            links: dependencies.length,
            unused: findCount('Unused'),
            circular: findCount('Circular Dependenc'),
            coupled: findCount('Highly Coupled'),
            large: findCount('Large Files'),
            score: healthScore?.score ?? 0,
            grade: healthScore?.grade || '—',
        };
    }, [analysisResult]);
}

function MiniHealthRing({ score, grade }) {
    const radius = 20, size = 50, center = size / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (Math.max(0, Math.min(100, score)) / 100) * circumference;
    return (
        <div className="ai-explorer__mini-ring">
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <circle cx={center} cy={center} r={radius} className="ai-explorer__mini-ring-track" />
                <circle cx={center} cy={center} r={radius} className="ai-explorer__mini-ring-progress"
                    strokeDasharray={circumference} strokeDashoffset={offset}
                    transform={`rotate(-90 ${center} ${center})`} />
            </svg>
            <div className="ai-explorer__mini-ring-label">
                <strong>{score}</strong>
                <span>{grade}</span>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// "Where to start reading" — real entry-point ranking from
// analysis-engine/insights.js (computeEntryPoints), shared by both personas.
// Clicking a file opens it as a tab; clicking "Explain" asks the AI about it
// with the real detection reason already in the prompt for grounding.
// ---------------------------------------------------------------------------
function EntryPointsPanel({ analysisResult, onAsk, onOpenFile }) {
    const entryPoints = analysisResult?.entryPoints || [];
    if (!entryPoints.length) return null;

    return (
        <div className="ai-explorer__entry-points">
            <h4><MapPin size={12} strokeWidth={2} style={{ verticalAlign: '-1px', marginRight: 4 }} />Where to Start Reading</h4>
            <ul className="ai-explorer__entry-list">
                {entryPoints.slice(0, 5).map((ep) => (
                    <li key={ep.file} className="ai-explorer__entry-row">
                        <button className="ai-explorer__entry-file" onClick={() => onOpenFile?.(ep.file)} title={ep.reasons.join('; ')}>
                            {ep.file.split('/').pop()}
                        </button>
                        <button
                            className="ai-explorer__entry-ask"
                            onClick={() => onAsk?.(`Explain what "${ep.file}" does and why it's a good place to start reading this codebase. (Detected because: ${ep.reasons.join('; ')})`)}
                        >
                            Explain
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

// ---------------------------------------------------------------------------
// DETECTIVE — a color legend (what the pins on a case board would mean) plus
// an "Investigation Log" checklist. The counts in the legend are real; the
// checklist itself is flavor text, same as a paper notebook would be.
// ---------------------------------------------------------------------------
export function DetectiveSidePanels({ analysisResult, onAsk, onOpenFile }) {
    const stats = useRepoStats(analysisResult);
    return (
        <div className="ai-explorer__persona-panel ai-explorer__persona-panel--detective">
            <EntryPointsPanel analysisResult={analysisResult} onAsk={onAsk} onOpenFile={onOpenFile} />
            <h4>Key Clues</h4>
            <div className="ai-explorer__legend">
                <div className="ai-explorer__legend-row"><span className="ai-explorer__legend-dot ai-explorer__legend-dot--normal" />Normal files<em>{stats.files}</em></div>
                <div className="ai-explorer__legend-row"><span className="ai-explorer__legend-dot ai-explorer__legend-dot--coupled" />Highly coupled<em>{stats.coupled}</em></div>
                <div className="ai-explorer__legend-row"><span className="ai-explorer__legend-dot ai-explorer__legend-dot--risk" />Large / risky<em>{stats.large}</em></div>
                <div className="ai-explorer__legend-row"><span className="ai-explorer__legend-dot ai-explorer__legend-dot--circular" />Circular dependency<em>{stats.circular}</em></div>
                <div className="ai-explorer__legend-row"><span className="ai-explorer__legend-dot ai-explorer__legend-dot--unused" />Unused<em>{stats.unused}</em></div>
            </div>
            <h4>Investigation Log</h4>
            <ul className="ai-explorer__log">
                <li><CheckCircle2 size={12} strokeWidth={2} className="ai-explorer__log-done" /> Explore the case files</li>
                <li><CheckCircle2 size={12} strokeWidth={2} className="ai-explorer__log-done" /> Analyze the connections</li>
                <li><Circle size={12} strokeWidth={2} /> Connect the clues</li>
                <li><Circle size={12} strokeWidth={2} /> Solve the case</li>
            </ul>
        </div>
    );
}

// ---------------------------------------------------------------------------
// MISSION CONTROL — key metrics readout + health ring + a mission checklist.
// Same real numbers as Detective's legend, framed as telemetry instead.
// ---------------------------------------------------------------------------
export function MissionControlSidePanels({ analysisResult, onAsk, onOpenFile }) {
    const stats = useRepoStats(analysisResult);
    return (
        <div className="ai-explorer__persona-panel ai-explorer__persona-panel--missionControl">
            <EntryPointsPanel analysisResult={analysisResult} onAsk={onAsk} onOpenFile={onOpenFile} />
            <h4>Key Metrics</h4>
            <div className="ai-explorer__metrics-row">
                <MiniHealthRing score={stats.score} grade={stats.grade} />
                <div className="ai-explorer__metrics-grid">
                    <div><strong>{stats.files}</strong><span>Files</span></div>
                    <div><strong>{stats.functions}</strong><span>Functions</span></div>
                    <div><strong>{stats.links}</strong><span>Links</span></div>
                    <div className="ai-explorer__metrics-alert"><strong>{stats.circular}</strong><span>Circular Dep</span></div>
                </div>
            </div>
            <h4>Mission Timeline</h4>
            <ul className="ai-explorer__log">
                <li><CheckCircle2 size={12} strokeWidth={2} className="ai-explorer__log-done" /> Repository scanned</li>
                <li><CheckCircle2 size={12} strokeWidth={2} className="ai-explorer__log-done" /> Graph built</li>
                <li><CheckCircle2 size={12} strokeWidth={2} className="ai-explorer__log-done" /> Risk analysis complete</li>
                <li><Circle size={12} strokeWidth={2} /> Awaiting your query</li>
            </ul>
        </div>
    );
}
