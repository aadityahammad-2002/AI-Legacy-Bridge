import { classifyAnalysisSource } from './sourceClassification.js';
/** Stable identities, de-duplication, and concise action plans for findings. */

function slug(value) {
    return String(value || 'finding').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'finding';
}

/** Deterministic non-cryptographic fingerprint; suitable for IDs, not security decisions. */
export function stableFingerprint(value) {
    const text = String(value ?? '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function locationOf(finding = {}) {
    const location = finding.location || {};
    return {
        path: String(location.path || finding.file || finding.path || finding.filePath || finding.filename || ''),
        line: location.startLine ?? finding.startLine ?? finding.line ?? finding.lineNumber ?? null,
        endLine: location.endLine ?? finding.endLine ?? null,
    };
}

function normalizedTitle(finding = {}) {
    return String(finding.title || finding.name || finding.ruleId || finding.type || 'Finding')
        .toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizedMessage(finding = {}) {
    return String(finding.message || finding.description || finding.details || '')
        .toLowerCase().replace(/\s+/g, ' ').trim();
}

export function createStableFindingId(finding = {}) {
    const location = locationOf(finding);
    const rule = String(finding.ruleId || `${finding.category || 'finding'}.${slug(normalizedTitle(finding))}`);
    const identity = [rule, location.path.replace(/\\/g, '/'), location.line ?? '', location.endLine ?? '', normalizedTitle(finding), normalizedMessage(finding)].join('|');
    return `finding:${slug(rule)}:${stableFingerprint(identity)}`;
}

function confidenceRank(value) {
    const confidence = String(value || '').toLowerCase();
    if (['fact', 'high', 'confirmed'].includes(confidence)) return 3;
    if (['inference', 'medium', 'probable'].includes(confidence)) return 2;
    return 1;
}
function severityRank(value) {
    return ({ critical: 5, high: 4, medium: 3, low: 2, info: 1 })[String(value || '').toLowerCase()] || 0;
}

/**
 * Collapse exact duplicate reports without merging different messages/rules.
 * The retained item records duplicateCount so the report remains auditable.
 */
export function deduplicateFindings(findings = []) {
    const groups = new Map();
    for (const finding of findings) {
        if (!finding || typeof finding !== 'object') continue;
        const location = locationOf(finding);
        const key = [finding.ruleId || '', location.path.replace(/\\/g, '/'), location.line ?? '', location.endLine ?? '', normalizedTitle(finding), normalizedMessage(finding), finding.severity || ''].join('|');
        if (!groups.has(key)) {
            groups.set(key, { ...finding, id: finding.id || createStableFindingId(finding), duplicateCount: 1, duplicateSources: [] });
            continue;
        }
        const current = groups.get(key);
        current.duplicateCount += 1;
        const source = finding.analyzer || finding.sourceAnalyzer || finding.source || finding.category;
        if (source && !current.duplicateSources.includes(source)) current.duplicateSources.push(source);
        if (confidenceRank(finding.confidence) > confidenceRank(current.confidence)) {
            current.confidence = finding.confidence;
            current.confidenceReason = finding.confidenceReason || current.confidenceReason;
        }
        const currentEvidence = Array.isArray(current.evidence) ? current.evidence : (current.evidence ? [current.evidence] : []);
        const incomingEvidence = Array.isArray(finding.evidence) ? finding.evidence : (finding.evidence ? [finding.evidence] : []);
        const seenEvidence = new Set(currentEvidence.map((item) => JSON.stringify(item)));
        current.evidence = [...currentEvidence, ...incomingEvidence.filter((item) => !seenEvidence.has(JSON.stringify(item)))].slice(0, 20);
        current.evidenceAvailable = current.evidence.length > 0;
    }
    const result = [...groups.values()];
    for (const item of result) {
        const location = locationOf(item);
        const role = classifyAnalysisSource(location.path);
        if (role !== 'application') item.sourceRole = role;
    }
    // Two different messages at the same rule+path+line must never share an
    // identifier. Preserve legacy IDs when unique for compatibility. For
    // collisions, use the full message-bearing stable identity, with an
    // explicit deterministic fallback for even fingerprint collisions.
    const ids = new Map();
    const canonical = (item) => {
        const l = locationOf(item);
        return [item.ruleId || '', l.path.replace(/\\/g, '/'), l.line ?? '', l.endLine ?? '', normalizedTitle(item), normalizedMessage(item), item.severity || ''].join('|');
    };
    for (const item of result.slice().sort((a,b) => canonical(a).localeCompare(canonical(b)))) {
        const identity = canonical(item);
        let id = item.id || createStableFindingId(item);
        if (ids.has(id) && ids.get(id) !== identity) id = createStableFindingId(item);
        let suffix = 1;
        const base = id;
        while (ids.has(id) && ids.get(id) !== identity) id = `${base}:${suffix++}`;
        ids.set(id, identity);
        if (id !== item.id) {
            item.originalId = item.id;
            item.id = id;
        }
    }
    return {
        findings: result,
        inputCount: findings.length,
        outputCount: result.length,
        duplicateCount: Math.max(0, findings.length - result.length),
        duplicateGroups: result.filter((item) => item.duplicateCount > 1).map((item) => ({ id: item.id, ruleId: item.ruleId, path: locationOf(item).path || null, line: locationOf(item).line, count: item.duplicateCount })),
        semantics: 'Only exact same-rule, same-location, same-title/message/severity findings are merged. Semantic duplicates with different messages may remain; this is not proof that remaining findings are unique.',
    };
}

/** Convert a finding into a conservative next-step recommendation. */
export function recommendFindingAction(finding = {}) {
    const title = normalizedTitle(finding);
    const category = String(finding.category || '').toLowerCase();
    if (/complex|large file|cognitive/.test(title)) return { action: 'Review the function or file, separate responsibilities where it improves cohesion, and add or update tests before refactoring.', benefit: 'Makes changes easier to understand and verify.', confidence: 'review-guidance' };
    if (/duplicate|clone|repeated/.test(title) || category === 'duplication') return { action: 'Compare the reported code regions first; extract shared logic only if behavior and ownership are genuinely the same.', benefit: 'Can reduce duplicated maintenance without forcing unrelated code into a shared abstraction.', confidence: 'review-guidance' };
    if (/unused|dead code|unreachable/.test(title)) return { action: 'Check exports, framework entry points, reflection, callbacks, generated registration, and dynamic references before deleting the code.', benefit: 'Reduces unused code while avoiding deletion of dynamically reached code.', confidence: 'review-guidance' };
    if (/dependency|import|module boundary|layer violation|circular/.test(title) || category === 'architecture') return { action: 'Inspect the dependency path and resolution evidence, then consider moving the shared contract or reversing the dependency direction.', benefit: 'Can reduce coupling and make component boundaries clearer.', confidence: 'review-guidance' };
    if (/endpoint|api|route/.test(title) || category === 'api') return { action: 'Verify the route, HTTP method, handler, middleware, and tests against the framework configuration before changing the API contract.', benefit: 'Improves confidence that route documentation and implementation agree.', confidence: 'review-guidance' };
    if (/database|schema|table|query|migration/.test(title) || category === 'database') return { action: 'Trace the model/schema, query sites, migrations, and callers; add a migration or integration test if the relationship is intended to change.', benefit: 'Keeps data access and schema assumptions aligned.', confidence: 'review-guidance' };
    if (/test|coverage/.test(title) || category === 'testing') return { action: 'Confirm the related behavior is exercised by an executable test and inspect assertions; static linkage alone does not prove coverage.', benefit: 'Makes behavior changes easier to validate.', confidence: 'review-guidance' };
    return { action: 'Review the evidence and surrounding code, verify whether the behavior is intentional, and add a focused regression test before making a change.', benefit: 'Turns a static-analysis lead into a reproducible engineering decision.', confidence: 'generic-review-guidance' };
}

export function buildFindingActionPlan(findings = [], limit = 100) {
    const bounded = findings.slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)));
    return {
        schemaVersion: 1,
        items: bounded.map((finding) => ({
            findingId: finding.id || createStableFindingId(finding),
            title: finding.title || finding.name || finding.ruleId || 'Finding',
            severity: finding.severity || 'info',
            category: finding.category || 'unknown',
            location: finding.location || null,
            ...recommendFindingAction(finding),
        })),
        omittedCount: Math.max(0, findings.length - bounded.length),
        semantics: 'Recommendations are conservative review steps inferred from finding labels/categories. They are not automated fixes and should be checked against source evidence.',
    };
}
