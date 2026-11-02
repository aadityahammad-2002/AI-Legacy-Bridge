/** Small, auditable custom rule engine for repository-local analysis policies. */
import { stableAnalysisHash } from './unifiedAnalysisModel.js';

const MAX_RULES = 200;
const MAX_PATTERN_LENGTH = 240;
const MAX_LINE_LENGTH = 4000;

// Heuristic ReDoS guard for untrusted repository rule files. It rejects some
// advanced-but-risky regex constructs; this is not a formal regex complexity proof.
function looksPathologicalRegex(pattern) {
    return /\\[1-9]/.test(pattern) || /\(\?[=!<]/.test(pattern) || /\([^)]*[+*{][^)]*\)[+*{]/.test(pattern) || /(?:\.\*|\.\+).*(?:\.\*|\.\+)/.test(pattern);
}

const RULE_FILE_NAMES = new Set(['.analysis-engine-rules.json', 'analysis-rules.json']);

export function loadCustomRules(files = []) {
    const candidates = (Array.isArray(files) ? files : []).filter((file) => RULE_FILE_NAMES.has(String(file.path || '').split('/').pop()));
    if (candidates.length === 0) return { status: 'not-configured', rules: [], diagnostics: [] };
    const rules = [];
    const diagnostics = [];
    for (const file of candidates) {
        try {
            const parsed = JSON.parse(String(file.content || ''));
            const values = Array.isArray(parsed) ? parsed : parsed.rules;
            if (!Array.isArray(values)) throw new Error('Expected an array or an object with a rules array.');
            for (const rule of values.slice(0, MAX_RULES)) {
                if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' || typeof rule.message !== 'string') {
                    diagnostics.push({ file: file.path, reason: 'Rule must include string id and message.' });
                    continue;
                }
                if (!['error', 'warning', 'info'].includes(rule.severity || 'warning')) {
                    diagnostics.push({ file: file.path, ruleId: rule.id, reason: 'Unsupported severity; expected error, warning, or info.' });
                    continue;
                }
                const pattern = typeof rule.pattern === 'string' ? rule.pattern : '';
                if (!pattern || pattern.length > MAX_PATTERN_LENGTH) {
                    diagnostics.push({ file: file.path, ruleId: rule.id, reason: `Pattern must be 1–${MAX_PATTERN_LENGTH} characters.` });
                    continue;
                }
                if (looksPathologicalRegex(pattern)) {
                    diagnostics.push({ file: file.path, ruleId: rule.id, reason: 'Pattern uses constructs rejected by the basic ReDoS guard (backreferences, lookaround, nested quantifiers, or repeated dot-wildcards). Use a simpler line pattern.' });
                    continue;
                }
                const normalized = { id: rule.id.slice(0, 120), message: rule.message.slice(0, 500), severity: rule.severity || 'warning', category: rule.category || 'custom', pattern, flags: (typeof rule.flags === 'string' ? rule.flags : '').replace(/[^im]/g, ''), include: Array.isArray(rule.include) ? rule.include.slice(0, 40).map(String) : null, exclude: Array.isArray(rule.exclude) ? rule.exclude.slice(0, 40).map(String) : [] };
                try { new RegExp(normalized.pattern, normalized.flags); } catch (err) { diagnostics.push({ file: file.path, ruleId: normalized.id, reason: `Invalid regular expression: ${err.message}` }); continue; }
                rules.push(normalized);
            }
            if (values.length > MAX_RULES) diagnostics.push({ file: file.path, reason: `Only the first ${MAX_RULES} rules are considered.` });
        } catch (err) {
            diagnostics.push({ file: file.path, reason: `Could not parse rule config: ${String(err.message || err).slice(0, 200)}` });
        }
    }
    return { status: diagnostics.length ? (rules.length ? 'partial' : 'failed') : 'configured', rules, diagnostics };
}

export function runCustomRules(files = [], ruleConfig = loadCustomRules(files)) {
    const findings = [];
    const diagnostics = [...(ruleConfig?.diagnostics || [])];
    const rules = (Array.isArray(ruleConfig?.rules) ? ruleConfig.rules : []).slice(0, MAX_RULES);
    for (const rule of rules) {
        let regex;
        if (typeof rule.pattern !== 'string' || rule.pattern.length === 0 || rule.pattern.length > MAX_PATTERN_LENGTH || looksPathologicalRegex(rule.pattern)) {
            diagnostics.push({ ruleId: rule.id || null, reason: 'Rule pattern violates the basic length/complexity guard and was skipped.' });
            continue;
        }
        try { regex = new RegExp(rule.pattern, rule.flags || ''); }
        catch (err) { diagnostics.push({ ruleId: rule.id, reason: `Invalid regular expression: ${err.message}` }); continue; }
        for (const file of files || []) {
            const path = String(file.path || '').replace(/\\/g, '/');
            if (rule.include?.length && !rule.include.some((pattern) => path.includes(pattern))) continue;
            if ((rule.exclude || []).some((pattern) => path.includes(pattern))) continue;
            const lines = String(file.content || '').split('\n');
            for (let index = 0; index < lines.length; index++) {
                const line = lines[index].slice(0, MAX_LINE_LENGTH);
                regex.lastIndex = 0;
                const match = regex.exec(line);
                if (!match) continue;
                findings.push({
                    id: `custom:${stableAnalysisHash(`${rule.id}|${path}|${index + 1}|${match[0]}`)}`,
                    ruleId: `custom.${rule.id}`, category: rule.category || 'custom', title: rule.message,
                    name: rule.message, message: rule.message, severity: rule.severity === 'error' ? 'high' : rule.severity === 'warning' ? 'medium' : 'info',
                    confidence: 'INFERENCE', confidenceReason: 'Custom line-pattern rule; matching text is a candidate requiring review.',
                    status: 'detected', file: path, line: index + 1,
                    evidence: [{ type: 'custom-rule-match', path, startLine: index + 1, endLine: index + 1, excerpt: line.slice(0, 500), ruleId: rule.id }],
                });
                if (findings.length >= 5000) {
                    diagnostics.push({ ruleId: rule.id, reason: 'Finding cap of 5000 reached; remaining scan results omitted.' });
                    break;
                }
            }
            if (findings.length >= 5000) break;
        }
    }
    return { schemaVersion: 1, status: diagnostics.length ? (rules.length ? 'partial' : 'failed') : (rules.length ? 'complete' : 'not-configured'), ruleCount: rules.length, findings, diagnostics, semantics: 'Rules match individual source lines using configured regular expressions. Matches are candidate findings, not proofs; choose trusted rule patterns and keep patterns bounded.' };
}

/** Load optional finding suppressions. Suppressions are explicit and auditable. */
export function loadFindingSuppressions(files = []) {
    const candidates = (Array.isArray(files) ? files : []).filter((file) => String(file.path || '').split('/').pop() === 'analysis-suppressions.json');
    if (!candidates.length) return { status: 'not-configured', suppressions: [], diagnostics: [] };
    const suppressions = [];
    const diagnostics = [];
    for (const file of candidates) {
        try {
            const parsed = JSON.parse(String(file.content || ''));
            const entries = Array.isArray(parsed) ? parsed : parsed.suppressions;
            if (!Array.isArray(entries)) throw new Error('Expected a suppressions array.');
            for (const item of entries.slice(0, 1000)) {
                if (!item || typeof item !== 'object' || typeof item.ruleId !== 'string') {
                    diagnostics.push({ file: file.path, reason: 'Suppression requires a ruleId.' });
                    continue;
                }
                suppressions.push({ ruleId: item.ruleId.slice(0, 200), path: typeof item.path === 'string' ? item.path.replace(/\\/g, '/').replace(/^\.\//, '') : null, line: Number.isInteger(item.line) && item.line > 0 ? item.line : null, reason: typeof item.reason === 'string' ? item.reason.slice(0, 500) : 'Explicit repository suppression.' });
            }
        } catch (err) { diagnostics.push({ file: file.path, reason: `Could not parse suppression config: ${String(err.message || err).slice(0, 200)}` }); }
    }
    return { status: diagnostics.length ? (suppressions.length ? 'partial' : 'failed') : 'configured', suppressions, diagnostics };
}

export function applyFindingSuppressions(findings = [], suppressionConfig = { suppressions: [] }) {
    const suppressions = Array.isArray(suppressionConfig?.suppressions) ? suppressionConfig.suppressions : [];
    let suppressedCount = 0;
    const output = (Array.isArray(findings) ? findings : []).map((finding) => {
        const path = String(finding.location?.path || finding.file || finding.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
        const line = finding.location?.startLine ?? finding.line ?? null;
        const ruleId = String(finding.ruleId || '');
        const matched = suppressions.find((item) =>
            (item.ruleId === '*' || item.ruleId === ruleId || (item.ruleId.endsWith('.*') && ruleId.startsWith(item.ruleId.slice(0, -1)))) &&
            (!item.path || item.path === path) && (!item.line || item.line === line)
        );
        if (!matched) return finding;
        suppressedCount++;
        return { ...finding, status: 'suppressed', suppression: { reason: matched.reason, ruleId: matched.ruleId, path: matched.path, line: matched.line || null } };
    });
    return { findings: output, summary: { configuredSuppressions: suppressions.length, suppressedFindings: suppressedCount }, status: suppressionConfig?.status || 'not-configured', diagnostics: suppressionConfig?.diagnostics || [], semantics: 'A suppression hides/labels matching findings for review; it does not prove that the underlying pattern is safe.' };
}
