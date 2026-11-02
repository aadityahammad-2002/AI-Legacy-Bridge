import { ENGINE_VERSION } from './engineVersion.js';
/** Export normalized findings as SARIF 2.1.0 for editor/CI integrations. */
const arr = (value) => Array.isArray(value) ? value : [];
function severityToSarif(level) {
    const value = String(level || '').toLowerCase();
    if (value === 'critical' || value === 'high' || value === 'error') return 'error';
    if (value === 'medium' || value === 'warning') return 'warning';
    return 'note';
}
function ruleIdFor(finding) { return String(finding.ruleId || 'analysis.unknown').slice(0, 200); }

export function toSarifLog(result = {}) {
    const findings = arr(result.findings);
    const rules = new Map();
    for (const finding of findings) {
        const id = ruleIdFor(finding);
        if (!rules.has(id)) rules.set(id, { id, shortDescription: { text: String(finding.title || finding.name || id).slice(0, 200) }, defaultConfiguration: { level: severityToSarif(finding.severity) }, properties: { category: finding.category || 'unknown', confidence: finding.confidence || 'unknown' } });
    }
    const results = findings.map((finding) => {
        const path = finding.location?.path || finding.file || finding.path;
        const startLine = finding.location?.startLine ?? finding.line;
        const endLine = finding.location?.endLine ?? finding.endLine ?? startLine;
        const physicalLocation = path ? { artifactLocation: { uri: String(path).replace(/\\/g, '/') }, ...(Number.isInteger(startLine) && startLine > 0 ? { region: { startLine, ...(Number.isInteger(endLine) && endLine >= startLine ? { endLine } : {}) } } : {}) } : null;
        const message = String(finding.message || finding.description || finding.title || finding.name || 'Analysis finding').slice(0, 2000);
        const evidence = arr(finding.evidence).filter((item) => item && typeof item === 'object').slice(0, 10);
        return {
            ruleId: ruleIdFor(finding), level: severityToSarif(finding.severity), message: { text: message },
            ...(physicalLocation ? { locations: [{ physicalLocation }] } : {}),
            properties: { ...(evidence.length ? { evidenceCount: evidence.length, evidence: evidence.map((item) => ({ path: item.path || null, startLine: item.startLine || null, excerpt: String(item.excerpt || '').slice(0, 500) })) } : {}), category: finding.category || 'unknown', confidence: finding.confidence || 'unknown', status: finding.status || 'detected', ...(finding.id ? { findingId: String(finding.id) } : {}) },
        };
    });
    return {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0',
        runs: [{ tool: { driver: { name: 'AI Legacy Bridge Analysis Engine', semanticVersion: String(result.engineVersion || ENGINE_VERSION), informationUri: 'https://sarifweb.azurewebsites.net/', rules: [...rules.values()] } }, results,
            properties: { repository: result.repository?.name || null, analysisCoverageStatus: result.analysisCoverage?.status || 'unknown', engineScope: 'static-analysis; findings may include heuristic candidates' } }],
    };
}

export function toAnalysisJson(result = {}) {
    // Keep structured evidence and bounded function snippets, but never embed
    // the repository-wide raw fileContents store in the analysis JSON.
    return JSON.stringify(result, (key, value) => {
        if (key === 'fileContents') return undefined;
        // `result.files` is a full-content working snapshot. Keep file metadata
        // but do not export its raw source. Function snippets/evidence are retained.
        if (key === 'files' && Array.isArray(value) && value.some(item => item && typeof item === 'object' && 'content' in item && 'path' in item)) {
            return value.map(({ content: _rawContent, ...metadata }) => metadata);
        }
        return value;
    }, 2);
}


/** The download boundary is separate from the engine's in-memory file snapshot.
 * Consumers needing source for local analysis keep it; exported analysis JSON
 * contains metadata and bounded evidence, not whole raw repository files.
 */
export function toDownloadableAnalysisJson(result = {}, repository = null, exportedAt = new Date().toISOString()) {
    const analysis = JSON.parse(toAnalysisJson(result));
    const exportPayload = {
        exportFormat: 'ai-legacy-bridge-analysis-json',
        exportSchemaVersion: 1,
        exportedAt,
        sourceCodeIncluded: false,
        note: 'Contains the full computed analysis result. Raw fileContents and files[].content are excluded; bounded function-level evidence is retained.',
        repository: repository || analysis.repository || null,
        analysis,
    };
    return JSON.stringify(exportPayload, null, 2);
}
