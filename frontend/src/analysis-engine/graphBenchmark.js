/** Manually labeled edge evaluation. Uses positive and negative source-backed
 * labels, never invents correctness from coverage or cache hit percentages. */
export function evaluateGraphEdges(expected = [], observed = [], options = {}) {
    const kind = options.kind || 'dependency';
    const key = (edge) => kind === 'call'
        ? `${edge.callerFile}|${edge.callerFunctionName || edge.callerName}|${edge.calleeFile}|${edge.calleeFunctionName || edge.calleeName}`
        : `${edge.source}|${edge.target}`;
    const ground = new Map();
    for (const item of expected) {
        const fingerprint = key(item);
        if (fingerprint && !fingerprint.includes('undefined') && typeof item.present === 'boolean') ground.set(fingerprint, item.present);
    }
    if (!ground.size) return { status: 'not-labelled', precision: null, recall: null, f1: null, truePositives: 0, falsePositives: 0, falseNegatives: 0,
        semantics: 'No evaluated source relationships have valid manual labels.' };
    const predicted = new Set(observed.filter((item) => item.resolution === 'resolved').map(key));
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const [edge, present] of ground) {
        if (present && predicted.has(edge)) tp++;
        else if (present && !predicted.has(edge)) fn++;
        else if (!present && predicted.has(edge)) fp++;
        else tn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const f1 = precision !== null && recall !== null && precision + recall > 0 ? 2 * precision * recall / (precision + recall) : null;
    return { status: 'labelled-sample', kind, labelledEdges: ground.size, truePositives: tp, falsePositives: fp, falseNegatives: fn, trueNegatives: tn,
        precision, recall, f1,
        semantics: 'Metrics apply only to manually labelled edge pairs. Unlabelled predicted edges are outside the denominator; these are NOT full-repository precision/recall guarantees.' };
}
