/** Validate source references for represented relationships without claiming
 * semantic truth or runtime coverage. */
export function auditSourceEvidence(files = [], {
    dependencies = [], functionConnections = [], endpoints = [],
    semanticIntelligence = {}, crossSystemIntelligence = {}, businessIntelligence = {},
} = {}, options = {}) {
    const fileLines = new Map(files.map((file) => [file.path, String(file.content || '').split(/\r?\n/).length]));
    const maxIssues = Math.max(1, Math.min(1000, Number(options.maxIssues) || 100));
    const problems = [];
    const counts = { checked: 0, valid: 0, invalid: 0, unavailableLine: 0 };
    const inspect = (type, file, line, target) => {
        counts.checked++;
        const max = fileLines.get(file);
        if (max == null) { counts.invalid++; if (problems.length < maxIssues) problems.push({ type, file, line, target: target || null, reason: 'referenced-file-not-in-snapshot' }); return; }
        if (line == null) { counts.unavailableLine++; return; }
        if (!Number.isInteger(line) || line < 1 || line > max) {
            counts.invalid++; if (problems.length < maxIssues) problems.push({ type, file, line, target: target || null, reason: 'source-line-out-of-range' });
            return;
        }
        counts.valid++;
    };
    for (const edge of dependencies) {
        if (edge?.resolution !== 'resolved') continue;
        inspect('dependency-source', edge.source, edge.line, edge.target);
        if (!fileLines.has(edge.target)) inspect('dependency-target', edge.target, null, edge.source);
    }
    for (const edge of functionConnections) {
        if (edge?.resolution !== 'resolved') continue;
        inspect('function-caller', edge.callerFile, edge.callSiteLine, edge.calleeFile);
        inspect('function-callee', edge.calleeFile, edge.calleeStartLine, edge.callerFile);
    }
    for (const endpoint of endpoints) inspect('endpoint', endpoint.file, endpoint.line, endpoint.path);
    for (const symbol of semanticIntelligence.symbols || []) inspect('semantic-symbol', symbol.file, symbol.line, symbol.name);
    for (const base of semanticIntelligence.inheritance || []) {
        inspect('inheritance-source', base.file, base.line, base.baseName);
        if (base.target) inspect('inheritance-target', base.target.file, base.target.line, base.childName);
    }
    for (const message of crossSystemIntelligence.messages || []) inspect('message-operation', message.file, message.line, message.channel);
    for (const operation of crossSystemIntelligence.sqlOperations || []) inspect('sql-operation', operation.file, operation.line, operation.table);
    for (const link of crossSystemIntelligence.messageLinks || []) {
        inspect('message-source', link.source.file, link.source.line, link.channel);
        inspect('message-target', link.target.file, link.target.line, link.channel);
    }
    for (const link of crossSystemIntelligence.databaseLinks || []) {
        inspect('sql-schema-source', link.source.file, link.source.line, link.target.name);
        inspect('sql-schema-table', link.target.file, null, link.target.name);
    }
    for (const rule of businessIntelligence.rules || []) {
        inspect('business-rule-guard', rule.file, rule.line, rule.id);
        inspect('business-rule-outcome', rule.file, rule.outcome?.line, rule.id);
        if (rule.endLine != null) inspect('business-rule-boundary', rule.file, rule.endLine, rule.id);
    }
    for (const transition of businessIntelligence.stateTransitions || []) inspect('state-transition', transition.file, transition.line, transition.to);
    return { schemaVersion: 1, status: counts.invalid ? 'failed' : counts.unavailableLine ? 'partial' : 'complete',
        summary: counts, problems, truncated: counts.invalid > problems.length,
        semantics: 'Checks referenced file and line positions against the supplied source snapshot only. A valid reference does not prove that the dependency, call, or API endpoint is semantically correct.' };
}
