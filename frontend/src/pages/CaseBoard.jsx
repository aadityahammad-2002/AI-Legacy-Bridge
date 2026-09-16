import { AlertTriangle, Link2, FileWarning, Ghost, Pin } from 'lucide-react';

function findIssue(issues, match) {
    return (issues || []).find((i) => i.title?.includes(match));
}

/**
 * A corkboard of real findings from analysisResult.issues, framed as case
 * evidence. Clicking a card either opens the file it's about (if there's
 * exactly one clear file) or asks the AI about it — both go through the
 * same openFile()/onAsk() the rest of AI Explorer already uses.
 */
export default function CaseBoard({ analysisResult, onOpenFile, onAsk }) {
    const issues = analysisResult.issues || [];
    const largeFiles = findIssue(issues, 'Large Files');
    const circular = findIssue(issues, 'Circular Dependenc');
    const coupled = findIssue(issues, 'Highly Coupled');
    const unused = findIssue(issues, 'Unused');

    const topLarge = largeFiles?.items?.[0];
    const topCircular = circular?.items?.find((it) => it.files?.length === 2);
    const topCoupled = coupled?.items?.slice(0, 3) || [];
    const unusedList = unused?.items?.slice(0, 5) || [];

    const hasAnyEvidence = topLarge || topCircular || topCoupled.length > 0 || unusedList.length > 0;

    return (
        <div className="case-board">
            <div className="case-board__note case-board__note--intro">
                <div className="case-board__pin" />
                <strong>THE CASE</strong>
                <p>Understand this legacy codebase.<br />Find the risks.<br />Plan the migration.</p>
            </div>

            {!hasAnyEvidence && (
                <div className="case-board__note">
                    <div className="case-board__pin" />
                    <p>No major red flags found — this codebase is looking clean. Ask a question below to dig deeper anyway.</p>
                </div>
            )}

            {topLarge && (
                <button className="case-board__card case-board__card--risk" onClick={() => onOpenFile(topLarge.file)}>
                    <Pin size={12} strokeWidth={2} className="case-board__pin-icon" />
                    <div className="case-board__card-head">
                        <FileWarning size={14} strokeWidth={2} />
                        <span>{topLarge.file?.split('/').pop()}</span>
                    </div>
                    <span className="case-board__badge case-board__badge--risk">High Risk</span>
                    <p>{topLarge.desc || `Large file — ${largeFiles.items.length} file(s) flagged as oversized.`}</p>
                </button>
            )}

            {topCircular && (
                <button
                    className="case-board__card case-board__card--circular"
                    onClick={() => onAsk(`Why is there a circular dependency between ${topCircular.files[0].split('/').pop()} and ${topCircular.files[1].split('/').pop()}? Is it necessary?`)}
                >
                    <Pin size={12} strokeWidth={2} className="case-board__pin-icon" />
                    <div className="case-board__card-head">
                        <AlertTriangle size={14} strokeWidth={2} />
                        <span>Circular Dependency!</span>
                    </div>
                    <p>
                        {topCircular.files[0].split('/').pop()} <span className="case-board__loop">&#8644;</span> {topCircular.files[1].split('/').pop()}
                    </p>
                    {circular.items.length > 1 && <span className="case-board__more">+{circular.items.length - 1} more</span>}
                </button>
            )}

            {topCoupled.length > 0 && (
                <button
                    className="case-board__card case-board__card--coupled"
                    onClick={() => onAsk(`Which files are most highly coupled in this codebase, and why does that matter?`)}
                >
                    <Pin size={12} strokeWidth={2} className="case-board__pin-icon" />
                    <div className="case-board__card-head">
                        <Link2 size={14} strokeWidth={2} />
                        <span>Highly Coupled</span>
                    </div>
                    <ul>
                        {topCoupled.map((it) => <li key={it.file}>{it.file?.split('/').pop()}</li>)}
                    </ul>
                    {coupled.items.length > topCoupled.length && <span className="case-board__more">+{coupled.items.length - topCoupled.length} more</span>}
                </button>
            )}

            {unusedList.length > 0 && (
                <button
                    className="case-board__card case-board__card--unused"
                    onClick={() => onAsk('Which files or functions are unused and likely safe to remove?')}
                >
                    <Pin size={12} strokeWidth={2} className="case-board__pin-icon" />
                    <div className="case-board__card-head">
                        <Ghost size={14} strokeWidth={2} />
                        <span>Unused Files</span>
                    </div>
                    <ul>
                        {unusedList.map((it) => <li key={it.file}>{it.file?.split('/').pop() || it.name}</li>)}
                    </ul>
                    <span className="case-board__hint">Not referenced anywhere — probably safe to remove.</span>
                </button>
            )}
        </div>
    );
}
