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

const EXEMPT_PATH = /\.(md|markdown|mdx|lock|min\.js)$|(?:^|\/)node_modules(?:\/|$)|(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__|mock|mocks|benchmarks?)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec|smoke)\.[^.]+$/i;

function stripCommentsPreservingStrings(content, path) {
    const source = String(content || '');
    const ext = String(path || '').toLowerCase().split('.').pop();
    const python = ['py', 'pyw', 'pyi'].includes(ext);
    const vba = ['vba', 'bas', 'cls', 'vb'].includes(ext);
    const out = source.split('');
    let state = 'code', quote = '', triple = false;
    const blank = (i) => { if (source[i] !== '\n' && source[i] !== '\r') out[i] = ' '; };
    for (let i = 0; i < source.length;) {
        const c = source[i], n = source[i + 1], t = source[i + 2];
        if (state === 'line') { if (c === '\n' || c === '\r') state = 'code'; else blank(i); i++; continue; }
        if (state === 'block') { if (c === '*' && n === '/') { blank(i); blank(i + 1); i += 2; state = 'code'; } else { blank(i); i++; } continue; }
        if (state === 'string') {
            if (c === '\\') { i += Math.min(2, source.length - i); continue; }
            if (triple && c === quote && n === quote && t === quote) { i += 3; state = 'code'; triple = false; continue; }
            if (!triple && c === quote) state = 'code';
            i++; continue;
        }
        if (python && c === '#') { blank(i); state = 'line'; i++; continue; }
        if (vba && c === "'") { blank(i); state = 'line'; i++; continue; }
        if (!python && !vba && c === '/' && n === '/') { blank(i); blank(i + 1); state = 'line'; i += 2; continue; }
        if (!python && !vba && c === '/' && n === '*') { blank(i); blank(i + 1); state = 'block'; i += 2; continue; }
        if (python && ((c === '"' && n === '"' && t === '"') || (c === "'" && n === "'" && t === "'"))) { quote = c; triple = true; state = 'string'; i += 3; continue; }
        if (c === '"' || c === "'" || (!python && !vba && c === '`')) { quote = c; triple = false; state = 'string'; i++; continue; }
        i++;
    }
    return out.join('');
}

function isPlaceholderSecret(line, name) {
    const text = String(line || '').toLowerCase();
    if (/\b(?:user|username):(?:pass|password|changeme|example|placeholder)@(?:host|localhost|example\.com)\b/i.test(text)) return true;
    if (/\b(?:your[_ -]?(?:api[_ -]?)?key|your[_ -]?token|replace[_ -]?me|changeme|change[_ -]?me|placeholder|sample[_ -]?(?:key|token|secret)|dummy[_ -]?(?:key|token|secret)|redacted)\b/i.test(text)) return true;
    if (/\b(?:host|dbname|database)\b/i.test(text) && /(?:postgres|mysql|mongodb|redis|amqp):\/\//i.test(text) && /:(?:pass|password)@/i.test(text)) return true;
    return false;
}

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
        const content = stripCommentsPreservingStrings(f.content || '', f.path || '');
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
            EXTRA_SECRET_PATTERNS.forEach(({ name, re }) => {
                re.lastIndex = 0;
                if (re.test(line) && !isPlaceholderSecret(line, name)) {
                    findings.push({
                        severity: 'high', title: `Hardcoded Secret: ${name}`,
                        file: f.path, line: idx + 1,
                        desc: `A value matching the shape of a ${name} appears in source. Verify whether it is live; rotate it if real and move it to an environment variable or secrets manager.`,
                        code: line.trim().substring(0, 120),
                        confidence: 'INFERENCE',
                        confidenceReason: `Format-based candidate only. This scanner cannot verify whether the value is live, revoked, reachable, or a sample.`,
                    });
                }
            });
        });
    });
    return findings;
}
