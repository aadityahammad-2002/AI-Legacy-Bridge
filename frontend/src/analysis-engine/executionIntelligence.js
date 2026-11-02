/**
 * Source-backed *possible* execution paths, not runtime traces.
 * Only function calls that the existing resolver already linked to a unique
 * target AND attributed to a caller are traversed. Never join by name alone.
 */
const DEFAULT_LIMITS = Object.freeze({ maxEndpoints: 100, maxDepth: 6, maxEdgesPerEndpoint: 120, maxClientLinks: 400 });
const isNumber = (n) => Number.isInteger(n) && n >= 1;
const keyFor = (fn) => `${fn.file}|${fn.line}|${fn.name}`;


// Parse a bounded JavaScript route-registration expression without evaluating
// JavaScript. A literal method/path and a *named* final handler are required.
// Works with multiline registrations and middleware, but never invents a
// handler for inline lambdas or arbitrary member expressions.
function explicitJsRouteHandler(sourceLines, routeLine, routeMethod, routePath) {
    const snippet = sourceLines.slice(routeLine - 1, routeLine + 24).join('\n').slice(0, 2200);
    const method = String(routeMethod || '').toLowerCase();
    if (!/^(get|post|put|patch|delete|all|head|options)$/.test(method)) return null;
    const methodRe = new RegExp(`\\.\\s*${method}\\s*\\(`, 'g');
    for (const match of snippet.matchAll(methodRe)) {
        // A later registration in the scan window cannot stand in for the
        // endpoint located at the supplied source line.
        if (snippet.slice(0, match.index).includes('\n')) continue;
        let i = match.index + match[0].length;
        while (/\s/.test(snippet[i] || '')) i++;
        const quote = snippet[i];
        if (quote !== '\'' && quote !== '"' && quote !== '`') continue;
        i++;
        let path = '';
        while (i < snippet.length && snippet[i] !== quote && snippet[i] !== '\n') {
            if (snippet[i] === '\\') { path += snippet[i+1] || ''; i+=2; }
            else path += snippet[i++];
        }
        if (snippet[i] !== quote || path !== routePath) continue;
        i++;
        while (/\s/.test(snippet[i] || '')) i++;
        if (snippet[i++] !== ',') continue;
        const args = [];
        let depth = 0, square = 0, curly = 0, string = null, start = i;
        for (; i < snippet.length; i++) {
            const c = snippet[i];
            if (string) {
                if (c === '\\') { i++; continue; }
                if (c === string) string = null;
                continue;
            }
            if (c === '\'' || c === '"' || c === '`') { string = c; continue; }
            if (c === '(') depth++;
            if (c === '[') square++;
            if (c === '{') curly++;
            if (c === '}' && curly) curly--;
            if (c === ']' && square) square--;
            if (c === ')' && depth) depth--;
            else if (c === ')' && !depth && !square && !curly) {
                args.push(snippet.slice(start,i).trim());
                const handler = args.at(-1);
                return /^[A-Za-z_$][\w$]*$/.test(handler || '') ? handler : null;
            }
            if (c === ',' && !depth && !square && !curly) {
                args.push(snippet.slice(start,i).trim());
                start = i+1;
            }
        }
    }
    return null;
}

export function analyzeExecutionIntelligence({ endpoints = [], clientCalls = [], functions = [], functionConnections = [], files = [] } = {}, options = {}) {
    const maxEndpoints = Math.max(1, Math.min(500, Number(options.maxEndpoints) || DEFAULT_LIMITS.maxEndpoints));
    const maxDepth = Math.max(1, Math.min(12, Number(options.maxDepth) || DEFAULT_LIMITS.maxDepth));
    const maxEdgesPerEndpoint = Math.max(1, Math.min(2000, Number(options.maxEdgesPerEndpoint) || DEFAULT_LIMITS.maxEdgesPerEndpoint));
    const maxClientLinks = Math.max(1, Math.min(2000, Number(options.maxClientLinks) || DEFAULT_LIMITS.maxClientLinks));
    const filePaths = new Set(files.map((f) => f.path));
    const sourceByPath = new Map(files.map(f => [f.path, String(f.content || '')]));
    const sourceLineCounts = new Map(files.map(f => [f.path, typeof f.content === 'string' && f.content.length ? f.content.split(/\r?\n/).length : null]));
    const byFile = new Map();
    const definitions = new Map();
    for (const fn of functions) {
        if (!fn || !filePaths.has(fn.file) || !isNumber(fn.line) || !fn.name) continue;
        const enriched = { ...fn, key: fn.key || keyFor(fn) };
        if (!byFile.has(fn.file)) byFile.set(fn.file, []);
        byFile.get(fn.file).push(enriched);
        definitions.set(enriched.key, enriched);
    }
    for (const values of byFile.values()) values.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    const adjacency = new Map();
    let excludedUnattributed = 0;
    let excludedUnresolved = 0;
    for (const edge of functionConnections) {
        if (!edge?.callerFunctionKey || !edge.calleeFunctionKey || edge.resolution !== 'resolved') {
            if (!edge?.callerFunctionKey) excludedUnattributed++; else excludedUnresolved++;
            continue;
        }
        if (!definitions.has(edge.callerFunctionKey) || !definitions.has(edge.calleeFunctionKey)) {
            excludedUnresolved++;
            continue;
        }
        const callerLineCount = sourceLineCounts.get(edge.callerFile);
        if (!isNumber(edge.callSiteLine) || !filePaths.has(edge.callerFile) ||
            (callerLineCount != null && edge.callSiteLine > callerLineCount)) {
            excludedUnresolved++;
            continue;
        }
        const item = {
            caller: edge.callerFunctionKey, callee: edge.calleeFunctionKey,
            evidence: { file: edge.callerFile, line: edge.callSiteLine, column: edge.callSiteColumn ?? null, excerpt: String(edge.callSiteExcerpt || '').slice(0, 240) },
            confidence: edge.confidence === 'high' ? 'high' : 'medium',
            attribution: edge.attribution || 'heuristic-function-line-range',
        };
        if (!adjacency.has(item.caller)) adjacency.set(item.caller, []);
        adjacency.get(item.caller).push(item);
    }
    for (const edges of adjacency.values()) edges.sort((a, b) => a.callee.localeCompare(b.callee) || a.evidence.line - b.evidence.line);

    // A decorator/annotation route normally precedes a function definition;
    // a route expression can also occur inside the containing function.
    // Never infer arbitrary handlers from same-file co-location.
    function locateHandler(endpoint) {
        const candidates = byFile.get(endpoint.file) || [];
        const line = endpoint.line;
        if (!isNumber(line)) return { status: 'unresolved', reason: 'route-without-source-line' };
        const sourceLines = (sourceByPath.get(endpoint.file) || '').split(/\r?\n/);
        const jsRoute = /^(Express|Fastify|Koa)/i.test(endpoint.framework || '');
        if (jsRoute) {
            // Route registration is not the handler. Require a literal route
            // and uniquely declared named handler, including multiline syntax.
            const handlerName = explicitJsRouteHandler(sourceLines, line, endpoint.method, endpoint.path);
            if (handlerName) {
                const matches = candidates.filter(fn => fn.name === handlerName &&
                    fn.type !== 'class' && fn.isClassMethod !== true);
                if (matches.length === 1) return { status:'located', handler:matches[0], basis:'explicit-named-handler-argument', confidence:'medium' };
            }
            return { status:'unresolved', reason:'no-unambiguous-named-handler' };
        }
        const containing = candidates.filter((fn) => fn.line <= line && isNumber(fn.endLine) && fn.endLine >= line && fn.endLine > fn.line)
            .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line));
        if (containing.length && (containing.length === 1 || (containing[0].endLine - containing[0].line) < (containing[1].endLine - containing[1].line))) {
            return { status: 'located', handler: containing[0], basis: 'route-within-function-source-span' };
        }
        // Decorator and annotation syntax: adjacent declaration in supported frameworks.
        const decoratorRoute = /^(FastAPI|Flask|Django|Spring|NestJS|JAX-RS)/i.test(endpoint.framework || '');
        if (decoratorRoute) {
            const following = candidates.filter((fn) => fn.line > line && fn.line - line <= 10 &&
                sourceLines.slice(line, fn.line - 1).every(text => !text.trim() || /^\s*#/.test(text) || /^\s*@/.test(text)))
                .sort((a, b) => a.line - b.line);
            if (following.length && (following.length === 1 || following[0].line < following[1].line)) {
                return { status: 'located', handler: following[0], basis: 'nearest-following-route-declaration', confidence: 'low' };
            }
        }
        return { status: 'unresolved', reason: 'no-unambiguous-handler-source-span' };
    }

    const selectedEndpoints = endpoints.slice(0, maxEndpoints);
    const flows = [];
    let unresolvedHandlers = 0;
    let boundedFlows = 0;
    for (const endpoint of selectedEndpoints) {
        const handler = locateHandler(endpoint);
        const route = { method: endpoint.method, path: endpoint.path, file: endpoint.file, line: endpoint.line, framework: endpoint.framework };
        if (handler.status !== 'located') {
            unresolvedHandlers++;
            flows.push({ endpoint: route, status: 'unresolved-handler', reason: handler.reason, steps: [], edges: [] });
            continue;
        }
        const seen = new Set([handler.handler.key]);
        const queue = [{ key: handler.handler.key, depth: 0 }];
        const steps = [{ functionKey: handler.handler.key, file: handler.handler.file, name: handler.handler.name, line: handler.handler.line, depth: 0 }];
        const pathEdges = [];
        let truncated = false;
        for (let i = 0; i < queue.length; i++) {
            const current = queue[i];
            if (current.depth >= maxDepth) {
                if ((adjacency.get(current.key) || []).length) truncated = true;
                continue;
            }
            for (const edge of adjacency.get(current.key) || []) {
                if (pathEdges.length >= maxEdgesPerEndpoint) { truncated = true; break; }
                if (seen.has(edge.callee)) continue;
                seen.add(edge.callee);
                const target = definitions.get(edge.callee);
                pathEdges.push(edge);
                steps.push({ functionKey: edge.callee, file: target.file, name: target.name, line: target.line, depth: current.depth + 1 });
                queue.push({ key: edge.callee, depth: current.depth + 1 });
            }
            if (truncated && pathEdges.length >= maxEdgesPerEndpoint) break;
        }
        if (truncated) boundedFlows++;
        flows.push({ endpoint: route, status: truncated ? 'bounded-static-path' : 'static-path', handler: {
            functionKey: handler.handler.key, file: handler.handler.file, line: handler.handler.line,
            basis: handler.basis, confidence: handler.confidence || 'medium',
        }, steps, edges: pathEdges, truncated });
    }

    // Match only exact HTTP method/path strings. Runtime proxy base paths,
    // dynamic route parameters and environment-specific URLs are not assumed.
    const byRoute = new Map();
    for (const endpoint of endpoints) {
        const key = `${String(endpoint.method || '').toUpperCase()}|${endpoint.path}`;
        if (!byRoute.has(key)) byRoute.set(key, []);
        byRoute.get(key).push(endpoint);
    }
    const clientLinks = [];
    let ambiguousClientCalls = 0;
    let unmatchedClientCalls = 0;
    for (const call of clientCalls) {
        const candidates = byRoute.get(`${String(call.method || '').toUpperCase()}|${call.path}`) || [];
        if (!candidates.length) { unmatchedClientCalls++; continue; }
        if (candidates.length !== 1) { ambiguousClientCalls++; continue; }
        if (clientLinks.length >= maxClientLinks) continue;
        const target = candidates[0];
        clientLinks.push({
            source: { file: call.file, line: call.line, method: call.method, path: call.path },
            target: { file: target.file, line: target.line, method: target.method, path: target.path },
            relation: 'static-exact-http-method-and-path', confidence: 'medium',
            caveat: 'A matching static route is not proof that this request reaches this service at runtime.',
        });
    }
    clientLinks.sort((a, b) => a.source.file.localeCompare(b.source.file) || a.source.line - b.source.line);
    const partial = endpoints.length > maxEndpoints || boundedFlows > 0 || unresolvedHandlers > 0 || excludedUnattributed > 0 || excludedUnresolved > 0;
    return {
        schemaVersion: 1, status: partial ? 'partial' : 'complete',
        summary: { discoveredEndpoints: endpoints.length, tracedEndpoints: flows.length - unresolvedHandlers, unresolvedHandlers, boundedFlows,
            visitedEndpoints: flows.length, staticClientLinks: clientLinks.length, ambiguousClientCalls, unmatchedClientCalls,
            excludedUnattributedCallEdges: excludedUnattributed, excludedUnresolvedCallEdges: excludedUnresolved },
        flows, clientLinks, limits: { maxEndpoints, maxDepth, maxEdgesPerEndpoint, maxClientLinks },
        semantics: 'Static candidate execution paths over uniquely resolved and caller-attributed calls. Handler location may be heuristic. These are NOT observed runtime traces, complete branch coverage, complete service routing, or database execution evidence.',
    };
}
