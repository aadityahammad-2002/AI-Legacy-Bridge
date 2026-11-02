/**
 * Compare source-reviewed labels to analyzer claims; unknown relationships are
 * not silently counted correct. Numbers are valid for the labeled sample only.
 */
const TYPES = new Set(['rule','state-transition','message-link','http-link','graph-edge']);
const safe = x => String(x ?? '');
const fingerprint = (type, x) => {
    if (type === 'rule') return [x.file,x.line].map(safe).join('|');
    if (type === 'state-transition') return [x.file,x.line,x.to].map(safe).join('|');
    if (type === 'message-link') return [x.channel,x.transport,x.source?.file,x.target?.file].map(safe).join('|');
    if (type === 'http-link') return [x.source?.file,x.source?.line,x.target?.file,x.target?.line].map(safe).join('|');
    if (type === 'graph-edge') return [x.source,x.target,x.type].map(safe).join('|');
    return '';
};
const predictedItems = (type, result) => ({
    rule:result.businessIntelligence?.rules,
    'state-transition':result.businessIntelligence?.stateTransitions,
    'message-link':result.crossSystemIntelligence?.messageLinks,
    'http-link':result.executionIntelligence?.clientLinks,
    'graph-edge':result.analysisModel?.edges,
})[type] || [];

export function evaluateIntelligenceLabels(result = {}, labels = []) {
    const groups = {}, diagnostics = [], seen = new Set();
    for (const label of labels) {
        if (!TYPES.has(label?.kind) || typeof label.present !== 'boolean') {
            diagnostics.push({reason:'invalid-label',kind:label?.kind}); continue;
        }
        const key = fingerprint(label.kind,label);
        if (!key || key.split('|').some(x=>!x || x==='undefined') || seen.has(`${label.kind}|${key}`)) {
            diagnostics.push({reason:'incomplete-or-duplicate-label',kind:label.kind}); continue;
        }
        seen.add(`${label.kind}|${key}`);
        (groups[label.kind] ||= []).push({key,expected:label.present});
    }
    const byKind = {}, total = {tp:0,fp:0,fn:0,tn:0,labels:0};
    for (const [kind, expected] of Object.entries(groups)) {
        const predicted = new Set(predictedItems(kind,result).map(item=>fingerprint(kind,item)));
        const counts = { tp:0,fp:0,fn:0,tn:0,labels:expected.length };
        for (const label of expected) {
            const found = predicted.has(label.key);
            if (label.expected && found) counts.tp++;
            else if (label.expected) counts.fn++;
            else if (found) counts.fp++;
            else counts.tn++;
        }
        for (const field of Object.keys(total)) total[field] += counts[field];
        byKind[kind] = { ...counts, precision:counts.tp+counts.fp ? counts.tp/(counts.tp+counts.fp) : null,
            recall:counts.tp+counts.fn ? counts.tp/(counts.tp+counts.fn) : null };
    }
    const precision = total.tp+total.fp ? total.tp/(total.tp+total.fp):null;
    const recall = total.tp+total.fn ? total.tp/(total.tp+total.fn):null;
    return { schemaVersion:1, status:total.labels ? 'labelled-sample':'not-labelled', byKind,
        total:{...total,precision,recall,f1:precision!==null&&recall!==null&&(precision+recall)>0 ? 2*precision*recall/(precision+recall):null},
        diagnostics, semantics:'Accuracy on manually labeled relationships ONLY. Unlabeled predictions, model recall outside the labeled sample and runtime correctness are not evaluated.' };
}
