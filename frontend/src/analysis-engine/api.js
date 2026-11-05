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
    { framework: 'Flask', re: /@([A-Za-z_]\w*)\.route\s*\(\s*["']([^"']*)["'](?:[^)]*methods\s*=\s*\[([^\]]*)\])?/g,
      method: (m) => (m[3] ? m[3].replace(/['"]/g, '').split(',')[0].trim().toUpperCase() : 'GET'), path: (m) => m[2], owner: (m) => m[1] },
    // FastAPI: @app.get("/path"), @router.post("/path"), @users_router.get(...)
    { framework: 'FastAPI', re: /@([A-Za-z_]\w*)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']*)["']/g,
      method: (m) => m[2].toUpperCase(), path: (m) => m[3], owner: (m) => m[1] },
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
function getBasePath(content, framework, routeOffset = 0, owner = '') {
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
    if (framework === 'FastAPI' || framework === 'Flask') {
        if (!owner) return '';
        // Inspect only the binding for this decorator's receiver. A file can
        // define multiple routers with different prefixes; first-match was wrong.
        const constructorName = framework === 'FastAPI' ? 'APIRouter' : 'Blueprint';
        const prefixName = framework === 'FastAPI' ? 'prefix' : 'url_prefix';
        const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const declare = new RegExp('\\b'+escape(owner)+'\\s*=\\s*'+constructorName+'\\s*\\(', 'g');
        let binding, latest = null;
        while ((binding = declare.exec(content)) !== null && binding.index < routeOffset) latest = binding;
        if (!latest) return '';
        // Only balanced constructor arguments belong to this owner. In
        // particular an unprefixed APIRouter() must not borrow the prefix from
        // a second router declaration that appears later in the same file.
        const start = latest.index + latest[0].length;
        let depth=1, quote='', escaped=false, end=start;
        for (; end < Math.min(routeOffset, start+2500); end++) {
            const c=content[end];
            if (quote) {
                if (escaped) escaped=false;
                else if (c==='\\') escaped=true;
                else if (c===quote) quote='';
            } else if (c==='"'||c==="'") quote=c;
            else if (c==='(') depth++;
            else if (c===')' && --depth===0) break;
        }
        if (depth!==0) return '';
        const args=content.slice(start,end);
        const re = new RegExp('\\b'+prefixName+'\\s*=\\s*["\']([^"\']*)["\']');
        const match = args.match(re);
        return match ? match[1] : '';
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
        ROUTE_PATTERNS.forEach(({ framework, re, method, path, owner }) => {
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
                const basePath = getBasePath(scanContent, framework, m.index, owner?.(m));
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
    // A browser client commonly uses `${API_BASE}/api/resource` rather
    // than a root-relative URL. Strip ONLY an initial base expression when
    // a static API path follows it; keep dynamic path segments as :param.
    const baseExpression = path.match(/^\$\{([A-Za-z_$][\w$.]*)\}(?=\/)/);
    if (baseExpression && /(?:base|url|host|origin|endpoint|service|api)/i.test(baseExpression[1])) {
        path = path.slice(baseExpression[0].length);
    }
    path = path.replace(/\$\{[^}]+\}/g, ':param').replace(/\{[^}]+\}/g, ':param');
    path = path.replace(/:[A-Za-z_$][\w$]*/g, ':param').replace(/\/+/g, '/');
    if (!path.startsWith('/')) return null;
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return path || '/';
}

/** Resolve only statically visible, exported HTTP wrappers. A function merely
 * named `api` is not assumed to perform network requests. The importing file
 * must bind the wrapper from its actual source module. */
function exportedHttpWrappers(files) {
    const definitions = [];
    const ext = /\.(?:js|jsx|mjs|cjs|ts|tsx)$/i;
    for (const file of files) {
        const path = String(file.path || '').replace(/\\/g, '/');
        if (!ext.test(path) || isTestOrFixturePath(path)) continue;
        const text = maskCommentsPreservingPositions(file.content || '', path);
        const decl = /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^\n;]{0,180}>)?\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::[^,)=\n]+)?(?:,|\))/g;
        for (const match of text.matchAll(decl)) {
            // A bounded source slice is intentionally conservative. Do not infer
            // wrapper behavior from an unrelated function far away in the file.
            const fnSource = text.slice(match.index, match.index + 3500);
            const fetchMatch = fnSource.match(/\bfetch\s*\(\s*([A-Za-z_$][\w$]*)\s*\+\s*([A-Za-z_$][\w$]*)/);
            if (!fetchMatch || fetchMatch[2] !== match[2]) continue;
            const subsequentFunction = /\b(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*(?:<|\()/g;
            const intervening = subsequentFunction.exec(fnSource.slice(match[0].length, fetchMatch.index));
            if (intervening) continue; // do not borrow a later function's fetch call
            // The base must resolve to a static URL/path fallback, not an
            // arbitrary runtime variable or an invented conventional prefix.
            const baseName = fetchMatch[1];
            const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const baseAssign = new RegExp('\\b(?:const|let|var)\\s+' + escapedBase + '\\s*=([^;\\n]{0,350})');
            const assignment = text.match(baseAssign);
            if (!assignment) continue;
            const staticBases = [...assignment[1].matchAll(/['"](https?:\/\/[^'"\s]+|\/[^'"\s]+)['"]/g)];
            if (staticBases.length !== 1) continue;
            const base = normalizeContractPath(staticBases[0][1]);
            if (!base) continue;
            definitions.push({ file: path, exportedName: match[1], base, defaultMethod: /\b(?:method|httpMethod)\s*=\s*['"]GET['"]/.test(fnSource.slice(0, 250)) ? 'GET' : null });
        }
    }
    return definitions;
}

function resolveHttpWrapperImports(file, definitions) {
    const path = String(file.path || '').replace(/\\/g, '/');
    const imports = [];
    const text = maskCommentsPreservingPositions(file.content || '', path);
    const pattern = /\bimport\s*\{([^}]{1,500})\}\s*from\s*['"]([^'"]+)['"]/g;
    for (const match of text.matchAll(pattern)) {
        const specifier = match[2];
        if (!(specifier.startsWith('.') || specifier.startsWith('@/'))) continue;
        const roots = path.split('/');
        let target;
        if (specifier.startsWith('@/')) {
            const srcIndex = roots.lastIndexOf('src');
            if (srcIndex < 0) continue;
            target = [...roots.slice(0, srcIndex + 1), ...specifier.slice(2).split('/')].join('/');
        } else {
            const parts = roots.slice(0, -1);
            for (const part of specifier.split('/')) {
                if (part === '..') parts.pop();
                else if (part !== '.') parts.push(part);
            }
            target = parts.join('/');
        }
        const candidates = definitions.filter(d => d.file === target || d.file.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/i, '') === target || d.file.replace(/\/index\.(?:ts|tsx|js|jsx|mjs|cjs)$/i, '') === target);
        if (candidates.length !== 1) continue;
        for (const part of match[1].split(',')) {
            const binding = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
            if (!binding || binding[1] !== candidates[0].exportedName) continue;
            imports.push({ ...candidates[0], localName: binding[2] || binding[1] });
        }
    }
    return imports;
}

export function extractClientApiCalls(files = [], backendEndpoints = null) {
    const calls = [];
    const wrappers = exportedHttpWrappers(files || []);
    // When server routes are available, use discovered evidence rather than
    // guessing API namespaces from /api, /v1, etc. Retain strong mismatch
    // candidates so the existing API-contract warning feature still works.
    const knownRoutes = Array.isArray(backendEndpoints) ? backendEndpoints.map(route => ({
        path: normalizeContractPath(route.path), method: String(route.method || 'GET').toUpperCase(),
    })).filter(route => route.path) : null;
    const routeMatches = (left, right) => {
        const a = left.split('/').filter(Boolean), b = right.split('/').filter(Boolean);
        return a.length === b.length && a.every((part,i) => part === b[i] || part === ':param' || b[i] === ':param');
    };
    const supportedByRoutes = (path, method) => {
        if (!knownRoutes?.length) return false;
        if (knownRoutes.some(route => routeMatches(path, route.path))) return true; // method mismatch is possible
        // Only a uniquely strong suffix candidate may be retained as a
        // potential route mismatch, not an arbitrary navigation URL.
        const firstSegment = path.split('/').filter(Boolean)[0];
        const candidates = knownRoutes.filter(route => route.method === method && route.path.split('/').filter(Boolean)[0] === firstSegment)
            .map(route => commonSuffixSegments(path, route.path)).filter(score => score >= 2)
            .sort((a,b) => b - a);
        return candidates.length > 0 && (candidates.length === 1 || candidates[0] > candidates[1]);
    };
    const clientExt = /\.(?:js|jsx|mjs|cjs|ts|tsx|vue|svelte)$/i;
    for (const file of files || []) {
        if (!clientExt.test(String(file.path || '')) || !String(file.content || '') || isTestOrFixturePath(file.path)) continue;
        const source = maskCommentsPreservingPositions(String(file.content), file.path);
        const executable = maskLanguageNonCode(String(file.content), identifyCodeLanguage(file.path));
        const add = (method, rawPath, index, kind, allowWrappedPath = false) => {
            if (!executable.slice(index, index + 3).trim()) return;
            const path = normalizeContractPath(rawPath);
            if (!path || path === '/' || path.startsWith('/static/')) return;
            if (knownRoutes?.length) {
                if (!supportedByRoutes(path, String(method || 'GET').toUpperCase())) return;
            } else if (knownRoutes) {
                // Server list supplied but empty: there is no evidence that
                // a client navigation path targets a discovered API route.
                return;
            } else if (!allowWrappedPath && !/^\/(?:api|v\d+|graphql|rpc)(?:\/|$)/i.test(path)) {
                // Compatibility for standalone callers without route context.
                return;
            }
            calls.push({ method: String(method || 'GET').toUpperCase(), path, rawPath, file: file.path, line: lineOf(source, index), kind });
        };

        // Read one fetch expression at a time so subsequent requests do not
        // donate their method option to earlier requests. When `method` is
        // dynamic, do not silently claim it is GET.
        const inferredFetchMethod = (at) => {
            const start = source.indexOf('(', at);
            if (start < 0) return 'GET';
            let depth = 0, close = Math.min(source.length, start + 4000);
            for (let pos = start; pos < close; pos++) {
                if (executable[pos] === '(') depth++;
                if (executable[pos] === ')' && --depth === 0) { close = pos + 1; break; }
            }
            const tail = source.slice(at, close);
            const methodMatch = tail.match(/\bmethod\s*:\s*['"](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)['"]/i);
            if (methodMatch) return methodMatch[1];
            return /\bmethod\s*:/.test(tail) ? null : 'GET';
        };
        const isStaticBaseIdentifier = (value) => /(?:^|[_.])(?:API|BACKEND|SERVICE|SERVER|HTTP)?_?(?:BASE|URL|HOST|ORIGIN|ENDPOINT)(?:_URL)?$/i.test(value);
        const fetchRe = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1/g;
        let match;
        while ((match = fetchRe.exec(source)) !== null) {
            const method = inferredFetchMethod(match.index);
            if (method) add(method, match[2], match.index, 'fetch');
        }
        // Static concatenation: fetch(API_BASE + '/api/users'). The static
        // suffix is trustworthy only when its leading variable denotes a base.
        const fetchConcatRe = /\bfetch\s*\(\s*([A-Za-z_$][\w$.]*)\s*\+\s*(['"`])([^'"`]+)\2/g;
        while ((match = fetchConcatRe.exec(source)) !== null) {
            if (!isStaticBaseIdentifier(match[1])) continue;
            const method = inferredFetchMethod(match.index);
            if (method) add(method, match[3], match.index, 'fetch-concat');
        }
        const clientRe = /\b(?:axios|apiClient|httpClient|api|http|client)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(['"`])([^'"`]+)\2/gi;
        while ((match = clientRe.exec(source)) !== null) add(match[1], match[3], match.index, 'http-client');
        const clientConcatRe = /\b(?:axios|apiClient|httpClient|api|http|client)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*([A-Za-z_$][\w$.]*)\s*\+\s*(['"`])([^'"`]+)\3/gi;
        while ((match = clientConcatRe.exec(source)) !== null) {
            if (isStaticBaseIdentifier(match[2])) add(match[1], match[4], match.index, 'http-client-concat');
        }

        // Resolve imported HTTP wrapper calls with statically known API base.
        // The method must be a literal or the exported wrapper's default; a
        // dynamic method is not silently classified as GET.
        for (const wrapper of resolveHttpWrapperImports(file, wrappers)) {
            // An imported name shadowed by a local binding is ambiguous without
            // scope resolution. Prefer missing a candidate to inventing a call.
            const escapedName = wrapper.localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp('\\b(?:const|let|var|function)\\s+' + escapedName + '\\b').test(executable)) continue;
            const escaped = wrapper.localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const callPattern = new RegExp("\\b" + escaped + "\\s*(?:<[^\\n;]{0,180}>)?\\s*\\(\\s*(['\"\\x60])([^'\"\\x60]+)\\1\\s*(?:,\\s*(['\"])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\3)?", "gi");
            let bound;
            while ((bound = callPattern.exec(source)) !== null) {
                // Reject a non-literal second argument (or generic dynamic
                // method); allow a lone path argument only when default GET is
                // explicit in the exported wrapper signature.
                const tail = source.slice(bound.index + bound[0].length).trimStart();
                const method = bound[4] || (tail.startsWith(')') ? wrapper.defaultMethod : null);
                if (!method) continue;
                const rawPath = joinPath(wrapper.base, bound[2]);
                add(method, rawPath, bound.index, 'imported-http-wrapper', true);
            }
        }

        // axios({ url: '/api/...', method: 'POST' }) and similar request configs.
        const configRe = /\baxios\s*\(\s*\{([^}]{0,1200})\}/gi;
        while ((match = configRe.exec(source)) !== null) {
            const pathMatch = match[1].match(/\b(?:url|uri)\s*:\s*(['"`])([^'"`]+)\1/);
            if (!pathMatch) continue;
            const methodMatch = match[1].match(/\bmethod\s*:\s*(['"])(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\1/i);
            if (/\bmethod\s*:/.test(match[1]) && !methodMatch) continue;
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
    const clientCalls = extractClientApiCalls(files, backendEndpoints);
    const routes = (backendEndpoints || []).map((endpoint) => ({
        ...endpoint,
        normalizedPath: normalizeContractPath(endpoint.path),
        method: String(endpoint.method || 'GET').toUpperCase(),
    })).filter((endpoint) => endpoint.normalizedPath);
    const findings = [];
    let matchedCalls = 0;
    let unknownCalls = 0;

    for (const call of clientCalls) {
        const exactPath = routes.filter((route) => {
            const left = route.normalizedPath.split('/').filter(Boolean);
            const right = call.path.split('/').filter(Boolean);
            return left.length === right.length && left.every((part,index) => part === right[index] || part === ':param' || right[index] === ':param');
        });
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
