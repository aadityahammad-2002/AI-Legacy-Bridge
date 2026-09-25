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
    { framework: 'Spring', re: /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["']/g,
      method: (m) => m[1].toUpperCase(), path: (m) => m[2] },
    { framework: 'Spring', re: /@RequestMapping\s*\([^)]*value\s*=\s*["']([^"']*)["'][^)]*method\s*=\s*RequestMethod\.(\w+)/g,
      method: (m) => m[2].toUpperCase(), path: (m) => m[1] },
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

function lineOf(content, index) {
    return content.slice(0, index).split('\n').length;
}

function joinPath(base, path) {
    if (!base) return path || '/';
    const b = base.endsWith('/') ? base.slice(0, -1) : base;
    const p = path && path.startsWith('/') ? path : `/${path || ''}`;
    return `${b}${p}` || '/';
}

/**
 * Class/module-level route prefix, combined with each method-level path
 * below so e.g. Spring's `@RequestMapping("/api/assets")` on the class +
 * `@GetMapping("/{id}")` on the method resolves to `/api/assets/{id}`
 * instead of just `/{id}`.
 */
function getBasePath(content, framework) {
    if (framework === 'Spring') {
        const classIdx = content.search(/\bclass\s+\w+/);
        const head = classIdx === -1 ? content : content.slice(0, classIdx);
        // Last @RequestMapping before the class declaration (skip method= variants,
        // those are endpoint-level, not a bare class-level base path).
        const re = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["']\s*\)/g;
        let m, last = null;
        while ((m = re.exec(head)) !== null) last = m;
        return last ? last[1] : '';
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
        if (!content) return;
        ROUTE_PATTERNS.forEach(({ framework, re, method, path }) => {
            const basePath = getBasePath(content, framework);
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(content)) !== null) {
                const line = lineOf(content, m.index);
                const windowStart = Math.max(0, m.index - 300);
                const windowEnd = Math.min(content.length, m.index + 300);
                const nearby = content.slice(windowStart, windowEnd);
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