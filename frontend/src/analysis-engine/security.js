/**
 * security.js — Phase 3, batch 5 (Security deepening).
 *
 *   1. Auth coverage map — summarizes discovered API endpoints (from
 *      api.js) into protected vs unprotected, repo-wide and per-file.
 *   2. Hardcoded-secrets enhancement — parser.js already scans every code
 *      file (not just config) for `key = "value"`-shaped secrets; this
 *      adds patterns that shape doesn't catch: cloud provider key formats,
 *      PEM private-key blocks, and credentials embedded in connection-
 *      string URLs (`postgres://user:pass@host`).
 */

// ---------------------------------------------------------------------
// 1. Auth coverage map
// ---------------------------------------------------------------------

/**
 * Summarizes endpoint-level auth protection (computed per-endpoint in
 * api.js's discoverEndpoints) into a repo-wide and per-file coverage map.
 */
export function computeAuthCoverageMap(apiEndpoints) {
    const byFile = new Map();
    apiEndpoints.forEach((ep) => {
        if (!byFile.has(ep.file)) byFile.set(ep.file, { file: ep.file, total: 0, protected: 0, unprotected: [] });
        const entry = byFile.get(ep.file);
        entry.total += 1;
        if (ep.authProtected) entry.protected += 1;
        else entry.unprotected.push({ method: ep.method, path: ep.path, line: ep.line });
    });

    const files = [...byFile.values()].map((e) => ({
        ...e,
        coveragePct: e.total ? Math.round((e.protected / e.total) * 100) : 0,
    }));

    const total = apiEndpoints.length;
    const protectedCount = apiEndpoints.filter((e) => e.authProtected).length;

    return {
        totalEndpoints: total,
        protectedCount,
        unprotectedCount: total - protectedCount,
        coveragePct: total ? Math.round((protectedCount / total) * 100) : 0,
        files,
        confidence: 'INFERENCE',
        confidenceReason: 'Built directly from each endpoint\'s auth-protected flag, which is itself a nearby-code heuristic (see api.js) — repo-wide/global auth middleware this check can\'t see would understate real coverage.',
    };
}

// ---------------------------------------------------------------------
// 2. Hardcoded-secrets enhancement
// ---------------------------------------------------------------------

const EXTRA_SECRET_PATTERNS = [
    { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'AWS Secret Key (assigned)', re: /aws_secret_access_key\s*[=:]\s*['"][A-Za-z0-9/+=]{40}['"]/i },
    { name: 'Google API Key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
    { name: 'Slack Token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
    { name: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
    { name: 'PEM Private Key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
    { name: 'JWT-shaped Literal', re: /['"]eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+['"]/ },
    { name: 'Credentials in Connection String', re: /\b(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^:\s'"]+:[^@\s'"]+@/ },
];

const EXEMPT_PATH = /\.(md|markdown|lock|min\.js)$|node_modules\/|\/(test|tests|__tests__|fixtures|mock)\//i;

/**
 * Scans every file (mirrors parser.js's existing hardcoded-secret check,
 * which is likewise already repo-wide rather than config-only) for secret
 * *shapes* the generic `key=value` regex in parser.js doesn't match:
 * provider-specific key formats, PEM blocks, and credentials embedded in
 * connection-string URLs.
 */
export function detectAdvancedSecrets(files) {
    const findings = [];
    files.forEach((f) => {
        if (EXEMPT_PATH.test(f.path)) return;
        const content = f.content || '';
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
            EXTRA_SECRET_PATTERNS.forEach(({ name, re }) => {
                if (re.test(line)) {
                    findings.push({
                        severity: 'high', title: `Hardcoded Secret: ${name}`,
                        file: f.path, line: idx + 1,
                        desc: `Matched the shape of a ${name}. Rotate this credential and move it to an environment variable or secrets manager.`,
                        code: line.trim().substring(0, 80),
                        confidence: 'INFERENCE',
                        confidenceReason: `Matched by provider-specific format for ${name} — format matches are strong signals but can still false-positive on test fixtures or revoked/rotated keys still present in history.`,
                    });
                }
            });
        });
    });
    return findings;
}
