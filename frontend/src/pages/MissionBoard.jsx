import { Target, AlertTriangle, Link2, FileWarning, Ghost, Rocket } from 'lucide-react';

function findIssue(issues, match) {
    return (issues || []).find((i) => i.title?.includes(match));
}

const DIFFICULTY = {
    circular: { label: 'HARD', className: 'mission-board__diff--hard' },
    large: { label: 'HARD', className: 'mission-board__diff--hard' },
    coupled: { label: 'MEDIUM', className: 'mission-board__diff--medium' },
    unused: { label: 'EASY', className: 'mission-board__diff--easy' },
};

/**
 * Turns the same issues array Detective/Key Metrics use into a quest list —
 * one "mission" per issue category found, each with a target and a "Start
 * Mission" button that asks the AI about it (same askAi() flow as everywhere
 * else in AI Explorer).
 */
export default function MissionBoard({ analysisResult, onAsk }) {
    const issues = analysisResult.issues || [];
    const healthScore = analysisResult.healthScore;
    const circular = findIssue(issues, 'Circular Dependenc');
    const large = findIssue(issues, 'Large Files');
    const coupled = findIssue(issues, 'Highly Coupled');
    const unused = findIssue(issues, 'Unused');

    const missions = [
        circular?.items?.length > 0 && {
            id: 'circular', icon: AlertTriangle, difficulty: DIFFICULTY.circular,
            title: 'Eliminate Circular Dependency',
            target: circular.items.slice(0, 2).map((it) => it.files?.map((f) => f.split('/').pop()).join(' ↔ ')).join(', '),
            count: circular.items.length,
            ask: `Help me eliminate the circular dependencies in this codebase. Where should I start?`,
        },
        large?.items?.length > 0 && {
            id: 'large', icon: FileWarning, difficulty: DIFFICULTY.large,
            title: 'Refactor Oversized Files',
            target: large.items[0]?.file?.split('/').pop(),
            count: large.items.length,
            ask: `Which files are too large and should be refactored? Suggest how to split them.`,
        },
        coupled?.items?.length > 0 && {
            id: 'coupled', icon: Link2, difficulty: DIFFICULTY.coupled,
            title: 'Reduce Coupling',
            target: coupled.items[0]?.file?.split('/').pop(),
            count: coupled.items.length,
            ask: `Which files are most highly coupled, and how can I reduce that coupling?`,
        },
        unused?.items?.length > 0 && {
            id: 'unused', icon: Ghost, difficulty: DIFFICULTY.unused,
            title: 'Clean Up Unused Code',
            target: unused.items[0]?.file?.split('/').pop() || unused.items[0]?.name,
            count: unused.items.length,
            ask: `List everything that's unused and safe to delete.`,
        },
    ].filter(Boolean);

    return (
        <div className="mission-board">
            <div className="mission-board__hud">
                <div className="mission-board__hud-item">
                    <span>CODEBASE LEVEL</span>
                    <strong>{healthScore?.grade || '—'} · {healthScore?.score ?? 0}/100</strong>
                </div>
                <div className="mission-board__hud-item">
                    <span>ACTIVE MISSIONS</span>
                    <strong>{missions.length}</strong>
                </div>
                <div className="mission-board__hud-item mission-board__hud-item--status">
                    <span className="mission-board__live-dot" /> STATUS: READY
                </div>
            </div>

            {missions.length === 0 && (
                <div className="mission-board__empty">
                    <Rocket size={20} strokeWidth={1.6} />
                    <p>No active missions — this codebase is in good shape. Ask a question below to run a deeper scan.</p>
                </div>
            )}

            <div className="mission-board__grid">
                {missions.map((m) => {
                    const Icon = m.icon;
                    return (
                        <div key={m.id} className="mission-board__card">
                            <div className="mission-board__card-head">
                                <Icon size={16} strokeWidth={2} />
                                <span className={`mission-board__diff ${m.difficulty.className}`}>{m.difficulty.label}</span>
                            </div>
                            <h4>{m.title}</h4>
                            <p className="mission-board__target">
                                <Target size={11} strokeWidth={2} /> {m.target}
                                {m.count > 1 && <em> (+{m.count - 1} more)</em>}
                            </p>
                            <button onClick={() => onAsk(m.ask)}>Start Mission</button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
