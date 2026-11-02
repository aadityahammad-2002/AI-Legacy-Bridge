import { maskLanguageNonCode, identifyCodeLanguage } from './languageIntelligence.js';
import { isApplicationSource } from './sourceClassification.js';
/**
 * api.js — Phase 3, batch 2 (API Analysis).
 *
 *   1. API endpoint discovery — Spring MVC, Flask, FastAPI, Express route
 *      decorators/calls, each with method + path + file + line + an
 *      auth-protected guess.
 *   2. cURL / Postman command generation from the discovered endpoints.
 *   3. API breaking-change risk — compares two endpoint snapshots (this
 *      analysis vs a previous one) and flags removed/changed endpoints.
 *      Needs two snapshots, so it's a standalone comparator the caller
 *      invokes across re-analyses, not something a single analysis run
 *      can produce on its own (there's nothing to diff against yet).
 */

const ROUTE_PATTERNS = [
    // Spring: @GetMapping("/path"), @RequestMapping(value="/path", method=RequestMethod.POST)
    { framework: 'Spring', re: /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']*)["']/g,
      method: (m) => m[1].toUpperCase(), path: (m) => m[2] },
    { framework: 'Spring', re: /@RequestMapping\s*\([^)]*value\s*=\s*["']([^"']*)["'][^)]*method\s*=\s*RequestMethod\.(\w+)/g,
      method: (m) => m[2].toUpperCase(), path: (m) => m[1] },
    // Spring method mappings with an implicit empty path. Handle separately
    // from explicit path annotations; class-level RequestMapping is not a verb.
    { framework: 'Spring', re: /@(Get|Post|Put|Delete|Patch)Mapping\b(?:\s*\(\s*\)|(?!\s*\()(?=\s*(?:\r?\n|@|public\b|protected\b|private\b)))/g,
      method: (m) => m[1].toUpperCase(), path: () => '' },
    { framework: 'Spring', re: /@RequestMapping\s*\(\s*method\s*=\s*RequestMethod\.(GET|POST|PUT|DELETE|PATCH)\s*\)/g,
      method: (m) => m[1].toUpperCase(), path: () => '' },
    // Flask: @app.route('/path', methods=['GET','POST'])
    { framework: 'Flask', re: /@(?:app|blueprint|bp)\.route\s*\(\s*["']([^"']*)["'](?:[^)]*methods\s*=\s*\[([^\]]*)\])?/g,
      method: (m) => (m[2] ? m[2].replace(/['"]/g, '').split(',')[0].trim().toUpperCase() : 'GET'), path: (m) => m[1] },
    // FastAPI: @app.get("/path"), @router.post("/path")
    { framework: 'FastAPI', re: /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']*)["']/g,
      method: (m) => m[1].toUpperCase(), path: (m) => m[2] },
    // Express: router.get('/path', ...), app.post('/path', ...)
    { framework: 'Express', re: /(?:router|app)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']*)["']/g,
      method: (m) => m[1].toUpperCase(), path: (m) => m[2] },
];

const AUTH_SIGNALS = /@PreAuthorize|@Secured|@RolesAllowed|requires_auth|requireAuth|isAuthenticated|@login_required|passport\.authenticate|authMiddleware|verifyToken|@UseGuards/;

/** Preserve source offsets while blanking comments so route regexes do not
 * mistake commented-out annotations or client calls for live code. Strings are
 * deliberately preserved because framework route declarations use string literals. */
function maskCommentsPreservingPositions(source, filePath = '') {
    const text = String(source || '');
    const python = /\.(?:py|pyw|pyi)$/i.test(filePath);
    const javaLike = /\.(?:java|kt|kts|cs|scala|groovy)$/i.test(filePath);
    const chars = text.split('');
    let state = 'code';
    let quote = '';
    let triple = false;
    for (let i = 0; i < text.length;) {
        const c = text[i], next = text[i + 1], third = text[i + 2];
        if (state === 'line-comment') {
            if (c === '\n') state = 'code'; else chars[i] = ' ';
            i++; continue;
        }
        if (state === 'block-comment') {
            if (c === '*' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; i += 2; state = 'code'; }
            else { if (c !== '\n') chars[i] = ' '; i++; }
            continue;
        }
        if (state === 'string') {
            if (c === '\\') { i += Math.min(2, text.length - i); continue; }
            if (triple && c === quote && next === quote && third === quote) { i += 3; state = 'code'; triple = false; continue; }
            if (!triple && c === quote) { i++; state = 'code'; continue; }
            i++; continue;
        }
        if (python && c === '#') { chars[i] = ' '; state = 'line-comment'; i++; continue; }
        if (!python && c === '/' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; state = 'line-comment'; i += 2; continue; }
        if (!python && c === '/' && next === '*') { chars[i] = ' '; chars[i + 1] = ' '; state = 'block-comment'; i += 2; continue; }
        if ((python && ((c === '"' && next === '"' && third === '"') || (c === "'" && next === "'" && third === "'"))) ||
            (javaLike && c === '"' && next === '"' && third === '"')) {
            quote = c; triple = true; state = 'string'; i += 3; continue;
        }
        if (c === '"' || c === "'" || (!python && !javaLike && c === '`')) { quote = c; triple = false; state = 'string'; i++; continue; }
        i++;
    }
    return chars.join('');
}

function isTestOrFixturePath(filePath) { return !isApplicationSource(filePath); }

function lineOf(content, index) {
    return content.slice(0, index).split('\n').length;
}

function joinPath(base, path) {
    if (!base) return path || '/';
    const b = base.endsWith('/') ? base.slice(0, -1) : base;
    if (!path) return b || '/';
    const p = path && path.startsWith('/') ? path : `/${path || ''}`;
    return `${b}${p}` || '/';
}

/**
 * Class/module-level route prefix, combined with each method-level path
 * below so e.g. Spring's `@RequestMapping("/api/assets")` on the class +
 * `@GetMapping("/{id}")` on the method resolves to `/api/assets/{id}`
 * instead of just `/{id}`.
 */
function getBasePath(content, framework, routeOffset = 0) {
    if (framework === 'Spring') {
        // Associate the route with the nearest enclosing class, rather than
        // applying the first class's prefix to every controller in a file.
        const classes = [...content.matchAll(/\bclass\s+\w+/g)].filter(match => match.index <= routeOffset);
        const cls = classes.at(-1);
        if (!cls) return '';
        const beforeClass = content.slice(0, cls.index);
        const nearby = beforeClass.slice(Math.max(0, beforeClass.length - 1000));
        const annotations = [...nearby.matchAll(/@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']*)["']\s*\)/g)];
        const last = annotations.at(-1);
        if (!last) return '';
        // Annotation must directly precede the class (allowing controller,
        // other annotations, comments already masked, and whitespace).
        const tail = nearby.slice(last.index + last[0].length);
        if (/\b(?:class|interface|record|public\s+\w+\s*\()/.test(tail)) return '';
        return last[1];
    }
    if (framework === 'FastAPI') {
        const m = content.match(/APIRouter\s*\([^)]*prefix\s*=\s*["']([^"']*)["']/);
        return m ? m[1] : '';
    }
    if (framework === 'Flask') {
        const m = content.match(/Blueprint\s*\([^)]*url_prefix\s*=\s*["']([^"']*)["']/);
        return m ? m[1] : '';
    }
    // Express: routers are typically mounted in a separate file (app.use('/api/x', router)),
    // not visible from the router file itself — not resolved here, see README note.
    return '';
}

/**
 * Discovers HTTP endpoints across the repo. Auth-protected is a nearby-code
 * heuristic (checks a window around the match for known auth signals), so
 * it's always tagged INFERENCE, not FACT — a route can be protected by
 * global middleware this file-local check can't see.
 */
export function discoverEndpoints(files) {
    const endpoints = [];
    files.forEach((file) => {
        const content = file.content || '';
        if (!content || isTestOrFixturePath(file.path)) return;
        const scanContent = maskCommentsPreservingPositions(content, file.path);
        const executable = maskLanguageNonCode(content, identifyCodeLanguage(file.path));
        const extension = String(file.path || '').toLowerCase();
        ROUTE_PATTERNS.forEach(({ framework, re, method, path }) => {
            if (framework === 'Spring' && !/\.(?:java|kt|kts|groovy)$/i.test(extension)) return;
            if ((framework === 'FastAPI' || framework === 'Flask') && !/\.(?:py|pyw|pyi)$/i.test(extension)) return;
            if (framework === 'Express' && !/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i.test(extension)) return;
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(scanContent)) !== null) {
                // Check that the route keyword is executable source, not a JS
                // template/string literal with illustrative code examples.
                if (executable.slice(m.index, m.index + (framework === 'Spring' || framework === 'FastAPI' || framework === 'Flask' ? 1 : 3)).trim() === '') continue;
                const line = lineOf(scanContent, m.index);
                const basePath = getBasePath(scanContent, framework, m.index);
                const windowStart = Math.max(0, m.index - 300);
                const windowEnd = Math.min(content.length, m.index + 300);
                const nearby = scanContent.slice(windowStart, windowEnd);
                const authProtected = AUTH_SIGNALS.test(nearby);
                endpoints.push({
                    method: method(m),
                    path: joinPath(basePath, path(m)),
                    file: file.path,
                    line,
                    framework,
                    authProtected,
                    confidence: 'FACT',
                    confidenceReason: basePath
                        ? `Matched a ${framework} route decorator/call, combined with the class/module-level base path "${basePath}".`
                        : `Matched a ${framework} route decorator/call directly in source.`,
                    authConfidence: 'INFERENCE',
                    authConfidenceReason: authProtected
                        ? 'An auth-related decorator/call appears near this route — may be file-local or could be enforced globally elsewhere instead.'
                        : 'No auth signal found near this route — but repo-wide/global middleware wouldn\'t be visible to this check.',
                });
            }
        });
    });
    // De-dupe identical (method, path, file, line) matches from overlapping patterns.
    const seen = new Set();
    return endpoints.filter((e) => {
        const key = `${e.method}|${e.path}|${e.file}|${e.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Normalize static client/server paths for conservative contract comparison. */
function normalizeContractPath(value) {
    let path = String(value || '').trim();
    if (/^https?:\/\//i.test(path)) {
        try { path = new URL(path).pathname; } catch { return null; }
    }
    path = path.split(/[?#]/, 1)[0];
    path = path.replace(/\$\{[^}]+\}/g, ':param').replace(/\{[^}]+\}/g, ':param');
    path = path.replace(/:[A-Za-z_$][\w$]*/g, ':param').replace(/\/+/g, '/');
    if (!path.startsWith('/')) return null;
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return path || '/';
}

export function extractClientApiCalls(files = []) {
    const calls = [];
    const clientExt = /\.(?:js|jsx|mjs|cjs|ts|tsx|vue|svelte)$/i;
    for (const file of files || []) {
        if (!clientExt.test(String(file.path || '')) || !String(file.content || '') || isTestOrFixturePath(file.path)) continue;
        const source = maskCommentsPreservingPositions(String(file.content), file.path);
        const executable = maskLanguageNonCode(String(file.content), identifyCodeLanguage(file.path));
        const add = (method, rawPath, index, kind) => {
            if (!executable.slice(index, index + 3).trim()) return;
            const path = normalizeContractPath(rawPath);
            if (!path || path === '/' || path.startsWith('/static/')) return;
            // Contract matching is intentionally limited to API-shaped paths. This
            // avoids treating frontend navigation links as HTTP endpoint calls.
            if (!/^\/(?:api|v\d+|graphql|rpc)(?:\/|$)/i.test(path)) return;
            calls.push({ method: String(method || 'GET').toUpperCase(), path, rawPath, file: file.path, line: lineOf(source, index), kind });
        };

        const fetchRe = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1/g;
        let match;
        while ((match = fetchRe.exec(source)) !== null) {
            const tail = source.slice(match.index, Math.min(source.length, match.index + 700));
            const methodMatch = tail.match(/\bmethod\s*:\s*['"](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)['"]/i);
            add(methodMatch ? methodMatch[1] : 'GET', match[2], match.index, 'fetch');
        }

        const clientRe = /\b(?:axios|apiClient|httpClient|api|http|client)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(['"`])([^'"`]+)\2/gi;
        while ((match = clientRe.exec(source)) !== null) add(match[1], match[3], match.index, 'http-client');

        // axios({ url: '/api/...', method: 'POST' }) and similar request configs.
        const configRe = /\baxios\s*\(\s*\{([^}]{0,1200})\}/gi;
        while ((match = configRe.exec(source)) !== null) {
            const pathMatch = match[1].match(/\b(?:url|uri)\s*:\s*(['"`])([^'"`]+)\1/);
            if (!pathMatch) continue;
            const methodMatch = match[1].match(/\bmethod\s*:\s*(['"])(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\1/i);
            add(methodMatch ? methodMatch[2] : 'GET', pathMatch[2], match.index, 'axios-config');
        }
    }
    return [...new Map(calls.map((call) => [`${call.method}|${call.path}|${call.file}|${call.line}`, call])).values()];
}

function commonSuffixSegments(left, right) {
    const a = String(left || '').split('/').filter(Boolean);
    const b = String(right || '').split('/').filter(Boolean);
    let count = 0;
    while (count < a.length && count < b.length) {
        const x = a[a.length - 1 - count];
        const y = b[b.length - 1 - count];
        if (x !== y && x !== ':param' && y !== ':param') break;
        count++;
    }
    return count;
}

/**
 * Compare statically visible frontend HTTP calls against discovered backend
 * routes. Only high-similarity route pairs are called mismatches; an unrelated
 * or dynamically constructed URL is left unknown rather than reported broken.
 */
export function analyzeApiContracts(files = [], backendEndpoints = []) {
    const clientCalls = extractClientApiCalls(files);
    const routes = (backendEndpoints || []).map((endpoint) => ({
        ...endpoint,
        normalizedPath: normalizeContractPath(endpoint.path),
        method: String(endpoint.method || 'GET').toUpperCase(),
    })).filter((endpoint) => endpoint.normalizedPath);
    const findings = [];
    let matchedCalls = 0;
    let unknownCalls = 0;

    for (const call of clientCalls) {
        const exactPath = routes.filter((route) => route.normalizedPath === call.path);
        const exactMethod = exactPath.find((route) => route.method === call.method);
        if (exactMethod) { matchedCalls++; continue; }

        const sameMethodCandidates = routes
            .filter((route) => route.method === call.method)
            .map((route) => ({ route, suffix: commonSuffixSegments(call.path, route.normalizedPath) }))
            .filter((entry) => entry.suffix >= 2)
            .sort((a, b) => b.suffix - a.suffix || a.route.normalizedPath.length - b.route.normalizedPath.length);
        const wrongMethodCandidates = exactPath;
        let selected = null;
        let mismatchType = null;
        if (sameMethodCandidates.length && (sameMethodCandidates.length === 1 || sameMethodCandidates[0].suffix > sameMethodCandidates[1].suffix)) {
            selected = sameMethodCandidates[0].route;
            mismatchType = 'path';
        } else if (wrongMethodCandidates.length === 1) {
            selected = wrongMethodCandidates[0];
            mismatchType = 'method';
        }
        if (!selected) { unknownCalls++; continue; }

        const title = mismatchType === 'path' ? 'Frontend/backend API route mismatch' : 'Frontend/backend HTTP method mismatch';
        findings.push({
            ruleId: mismatchType === 'path' ? 'api-contract.route-mismatch' : 'api-contract.method-mismatch',
            category: 'api-contract',
            title,
            name: `${call.method} ${call.path}`,
            file: call.file,
            line: call.line,
            severity: mismatchType === 'path' ? 'high' : 'medium',
            confidence: 'INFERENCE',
            confidenceReason: 'Static frontend call and backend route have a strong path/method relationship, but framework base URLs, proxy rewrites, gateways and dynamic routes may exist outside the analyzed source.',
            message: mismatchType === 'path'
                ? `Frontend calls ${call.method} ${call.path}, but the closest discovered backend route is ${selected.method} ${selected.path}. Verify repeated class/method prefixes, proxy rewrites and route configuration.`
                : `Frontend calls ${call.method} ${call.path}, but the discovered backend route uses ${selected.method}. Verify the intended HTTP verb on both sides.`,
            evidence: {
                frontend: { method: call.method, path: call.path, file: call.file, line: call.line, source: call.kind },
                backend: { method: selected.method, path: selected.path, file: selected.file, line: selected.line, framework: selected.framework },
            },
            suggestedAction: mismatchType === 'path'
                ? 'Align the frontend URL with the effective backend route or remove the duplicated route prefix; add a contract regression test.'
                : 'Align the HTTP method on the client and controller, then add a contract regression test.',
        });
    }

    return {
        schemaVersion: 1,
        status: findings.length ? 'mismatches-found' : unknownCalls ? 'partial' : 'matched',
        clientCalls: clientCalls.length,
        matchedCalls,
        mismatchCount: findings.length,
        unknownCalls,
        findings,
        semantics: 'Best-effort static contract matching. A mismatch is a high-similarity candidate, not proof of a runtime failure; absence of a mismatch is not proof that all API contracts are correct.',
    };
}

/** Generates a ready-to-run cURL command for one endpoint. */
export function generateCurl(endpoint, baseUrl = 'http://localhost:8080') {
    const bodyMethods = new Set(['POST', 'PUT', 'PATCH']);
    let cmd = `curl -X ${endpoint.method} "${baseUrl}${endpoint.path}"`;
    cmd += ` \\\n  -H "Content-Type: application/json"`;
    if (endpoint.authProtected) cmd += ` \\\n  -H "Authorization: Bearer <token>"`;
    if (bodyMethods.has(endpoint.method)) cmd += ` \\\n  -d '{}'`;
    return cmd;
}

/** Generates a minimal Postman collection (v2.1 schema) from discovered endpoints. */
export function generatePostmanCollection(endpoints, collectionName = 'Discovered API', baseUrl = '{{baseUrl}}') {
    return {
        info: { name: collectionName, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: endpoints.map((ep) => ({
            name: `${ep.method} ${ep.path}`,
            request: {
                method: ep.method,
                header: [
                    { key: 'Content-Type', value: 'application/json' },
                    ...(ep.authProtected ? [{ key: 'Authorization', value: 'Bearer {{token}}' }] : []),
                ],
                url: { raw: `${baseUrl}${ep.path}`, path: ep.path.split('/').filter(Boolean) },
                ...(['POST', 'PUT', 'PATCH'].includes(ep.method) ? { body: { mode: 'raw', raw: '{}' } } : {}),
            },
        })),
    };
}

/**
 * Compares two endpoint snapshots (e.g. this analysis vs the last saved
 * one) and flags breaking changes: removed endpoints, and endpoints whose
 * method changed for the same path. Adding new endpoints or adding
 * optional auth is not breaking; removing an endpoint or changing its
 * method/path is.
 */
export function detectApiBreakingChanges(previousEndpoints = [], currentEndpoints = []) {
    const key = (e) => `${e.file}::${e.path}`;
    const prevByKey = new Map(previousEndpoints.map((e) => [key(e), e]));
    const currByKey = new Map(currentEndpoints.map((e) => [key(e), e]));

    const breaking = [];

    prevByKey.forEach((prevEp, k) => {
        const currEp = currByKey.get(k);
        if (!currEp) {
            breaking.push({
                type: 'removed', path: prevEp.path, file: prevEp.file, method: prevEp.method,
                confidence: 'FACT', confidenceReason: 'Endpoint present in the previous snapshot is absent in the current one.',
            });
            return;
        }
        if (currEp.method !== prevEp.method) {
            breaking.push({
                type: 'method-changed', path: prevEp.path, file: prevEp.file,
                from: prevEp.method, to: currEp.method,
                confidence: 'FACT', confidenceReason: 'Same route path now handles a different HTTP method.',
            });
        }
        if (!prevEp.authProtected && currEp.authProtected) {
            breaking.push({
                type: 'auth-added', path: currEp.path, file: currEp.file, method: currEp.method,
                confidence: 'INFERENCE', confidenceReason: 'Route appears to have gained an auth requirement — existing unauthenticated clients would break.',
            });
        }
    });

    return {
        breaking,
        confidence: breaking.length ? 'INFERENCE' : 'FACT',
        confidenceReason: 'Diffed by (file, path) key across two endpoint-discovery snapshots — requires the caller to persist and pass in the previous snapshot.',
    };
}