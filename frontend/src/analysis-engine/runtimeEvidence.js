/** Correlate explicitly supplied OpenTelemetry-like spans with static routes.
 * This does NOT execute untrusted repository source or verify trace provenance. */
export function correlateRuntimeEvidence(spans = [], endpoints = [], options = {}) {
    if (!Array.isArray(spans) || spans.length === 0) {
        return { schemaVersion: 1, status: 'not-provided', summary: { suppliedSpans: 0, acceptedSpans: 0, observedParentChildLinks: 0, matchedEndpoints: 0 },
            traces: [], observedEndpointRoutes: [],
            semantics: 'No runtime instrumentation provided. Static analysis cannot prove runtime behavior.' };
    }
    const maxSpans = Math.max(1, Math.min(20000, Number(options.maxSpans) || 5000));
    const input = spans.slice(0, maxSpans);
    const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;
    const grouped = new Map();
    let malformed = 0, duplicates = 0;
    for (const span of input) {
        if (!id(span?.traceId) || !id(span?.spanId)) { malformed++; continue; }
        const key = `${span.traceId}|${span.spanId}`;
        if (grouped.has(key)) { duplicates++; continue; }
        grouped.set(key, span);
    }
    let orphanParents = 0, edges = 0;
    const observed = [];
    const routes = new Map(endpoints.map((e) => [`${e.method}|${e.path}`, e]));
    const matches = new Set();
    const traces = new Map();
    for (const span of grouped.values()) {
        const attrs = span.attributes && typeof span.attributes === 'object' ? span.attributes : {};
        const method = String(attrs['http.request.method'] || attrs['http.method'] || '').toUpperCase();
        const route = String(attrs['http.route'] || '');
        const routeKey = `${method}|${route}`;
        if (routes.has(routeKey)) matches.add(routeKey);
        if (method && route) observed.push({ traceId: span.traceId, spanId: span.spanId, method, path: route, matchesStaticEndpoint: routes.has(routeKey) });
        if (!traces.has(span.traceId)) traces.set(span.traceId, { traceId: span.traceId, spanCount: 0, parentChildLinks: 0, unmatchedParents: 0 });
        const trace = traces.get(span.traceId); trace.spanCount++;
        if (!id(span.parentSpanId)) continue;
        if (span.parentSpanId === span.spanId) { malformed++; continue; }
        const parent = grouped.get(`${span.traceId}|${span.parentSpanId}`);
        if (!parent) { orphanParents++; trace.unmatchedParents++; continue; }
        edges++; trace.parentChildLinks++;
    }
    return {
        schemaVersion: 1, status: input.length < spans.length || malformed || duplicates || orphanParents ? 'partial' : 'supplied',
        summary: { suppliedSpans: spans.length, acceptedSpans: grouped.size, observedParentChildLinks: edges,
            matchedEndpoints: matches.size, malformed, duplicateIds: duplicates, orphanParents, truncated: spans.length > maxSpans },
        observedEndpointRoutes: observed.slice(0, 100), traces: [...traces.values()].slice(0, 100),
        semantics: 'Only validates relationships inside user-supplied OpenTelemetry-like spans and matches HTTP method/route to static routes. Runtime observations are not collected by this engine and can be incomplete, simulated, or stale. No dynamic call edge or source-line location is inferred from spans.',
    };
}
