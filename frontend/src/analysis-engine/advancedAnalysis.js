/**
 * Additional conservative analyses for Analysis Engine V5.
 *
 * Most passes are language-agnostic textual heuristics over source ranges. They
 * explicitly report their scope and do not claim symbolic execution, formal
 * verification, or runtime-proven behavior.
 */
import { stableAnalysisHash } from './unifiedAnalysisModel.js';

const arr = (value) => Array.isArray(value) ? value : [];
const normPath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
const basename = (value) => normPath(value).split('/').pop() || '';
const codeExtension = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyw|pyi|java|kt|kts|go|rb|php|rs|c|h|cc|cpp|hpp|cs|scala|swift|vue|svelte)$/i;
const supportedHeuristicExtension = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyw|pyi|java|kt|kts|go|rb|php|rs|c|h|cc|cpp|hpp|cs|scala|swift|vue|svelte)$/i;
const recognizedButUnsupportedExtension = /\.(?:dart|ex|exs|erl|hrl|elm|lua|r|rmd|m|mm|pl|sh|bash|zsh|graphql|gql)$/i;

function finding(ruleId, title, file, line, message, severity = 'low', confidence = 'LOW') {
    const path = normPath(file);
    return {
        id: `v5:${stableAnalysisHash(`${ruleId}|${path}|${line || ''}|${title}`)}`,
        ruleId, category: ruleId.split('.')[0], title, name: title, message, severity,
        confidence, confidenceReason: 'Static source-pattern analysis; validate context and framework-level behavior manually.',
        status: 'detected', file: path, ...(Number.isInteger(line) ? { line } : {}),
    };
}

function functionText(fn, filesByPath) {
    const file = filesByPath.get(normPath(fn.file));
    if (!file || typeof file.content !== 'string') return String(fn.code || '');
    const lines = file.content.split('\n');
    const start = Number(fn.line);
    const end = Number(fn.endLine ?? fn.line);
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start || start > lines.length) return String(fn.code || '');
    // Avoid scanning unbounded ranges in one function; it is still possible to
    // inspect full source later when a dedicated language parser is available.
    return lines.slice(start - 1, Math.min(end, start + 1999, lines.length)).join('\n');
}

function functionLocation(fn, code) {
    const beforeLine = Math.max(1, Number(fn.line) || 1);
    return { file: normPath(fn.file), line: beforeLine + Math.max(0, String(code).slice(0, 0).split('\n').length - 1) };
}

function normalizedTokens(source) {
    return String(source || '')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
        .replace(/#[^\n]*$/gm, ' ')
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, ' STR ')
        .match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\*\*|\.\.\.|[^\s]/g) || [];
}

function tokenShingles(tokens, width = 5) {
    const out = new Set();
    if (tokens.length <= width) { if (tokens.length) out.add(tokens.join(' ')); return out; }
    for (let i = 0; i <= tokens.length - width; i++) out.add(tokens.slice(i, i + width).join(' '));
    return out;
}
function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const item of a) if (b.has(item)) intersection++;
    return intersection / (a.size + b.size - intersection);
}

function analyzeSemanticClones(functions, filesByPath, limits) {
    const records = [];
    for (const fn of functions.slice(0, limits.maxFunctions)) {
        const source = functionText(fn, filesByPath);
        const tokens = normalizedTokens(source);
        if (tokens.length < 12) continue;
        records.push({ fn, tokens, shingles: tokenShingles(tokens), tokenCount: tokens.length, signature: `${Math.floor(tokens.length / 8)}:${tokens.slice(0, 4).join(' ')}` });
    }
    const candidates = [];
    let comparisons = 0;
    let capped = false;
    for (let i = 0; i < records.length; i++) {
        for (let j = i + 1; j < records.length; j++) {
            if (records[i].fn.file === records[j].fn.file && records[i].fn.name === records[j].fn.name) continue;
            const left = records[i], right = records[j];
            if (Math.abs(left.tokenCount - right.tokenCount) > Math.max(8, Math.round(Math.max(left.tokenCount, right.tokenCount) * 0.3))) continue;
            comparisons++;
            if (comparisons > limits.maxCloneComparisons) { capped = true; break; }
            const similarity = jaccard(left.shingles, right.shingles);
            if (similarity < 0.82) continue;
            candidates.push({
                id: `clone:${stableAnalysisHash(`${left.fn.file}|${left.fn.line}|${right.fn.file}|${right.fn.line}`)}`,
                left: { name: left.fn.name, file: normPath(left.fn.file), line: left.fn.line || null, endLine: left.fn.endLine || left.fn.line || null },
                right: { name: right.fn.name, file: normPath(right.fn.file), line: right.fn.line || null, endLine: right.fn.endLine || right.fn.line || null },
                similarity: Math.round(similarity * 1000) / 1000,
                kind: similarity >= 0.97 ? 'near-identical-normalized-token-sequence' : 'high-token-shingle-overlap',
                confidence: 'LOW', semantics: 'Similarity candidate only; token overlap is not proof of equivalent program behavior.',
            });
            if (candidates.length >= limits.maxCloneResults) { capped = true; break; }
        }
        if (capped) break;
    }
    return { status: capped ? 'partial' : 'complete', functionsConsidered: records.length, comparisons, candidates, limits: { maxFunctions: limits.maxFunctions, maxCloneComparisons: limits.maxCloneComparisons, maxCloneResults: limits.maxCloneResults }, semantics: 'A bounded token-shingle similarity heuristic; not AST-semantic equivalence or full clone detection.' };
}

function analyzeEventFlows(files, limits) {
    const publishers = [];
    const subscribers = [];
    const patterns = [
        { kind: 'publish', re: /\b(?:emit|publish|dispatch|send|dispatchEvent|postMessage)\s*\(\s*(["'`])([^"'`\n]{1,160})\1/g },
        { kind: 'subscribe', re: /\b(?:on|once|subscribe|addEventListener|addListener)\s*\(\s*(["'`])([^"'`\n]{1,160})\1/g },
    ];
    for (const file of files) {
        if (!codeExtension.test(file.path || '')) continue;
        const source = String(file.content || '').slice(0, limits.maxFileChars);
        for (const pattern of patterns) {
            pattern.re.lastIndex = 0;
            let match;
            while ((match = pattern.re.exec(source)) && publishers.length + subscribers.length < limits.maxEventRefs) {
                const event = match[2].trim();
                if (!event) continue;
                const item = { event, file: normPath(file.path), line: source.slice(0, match.index).split('\n').length, api: match[0].split('(')[0].trim(), evidence: match[0].slice(0, 180), confidence: 'LOW' };
                (pattern.kind === 'publish' ? publishers : subscribers).push(item);
                if (match[0].length === 0) pattern.re.lastIndex++;
            }
        }
    }
    const publishesByName = new Map();
    for (const item of publishers) { if (!publishesByName.has(item.event)) publishesByName.set(item.event, []); publishesByName.get(item.event).push(item); }
    const flows = [];
    for (const subscriber of subscribers) {
        for (const publisher of publishesByName.get(subscriber.event) || []) {
            if (publisher.file === subscriber.file && publisher.line === subscriber.line) continue;
            flows.push({ id: `event:${stableAnalysisHash(`${publisher.file}|${publisher.line}|${subscriber.file}|${subscriber.line}|${subscriber.event}`)}`, event: subscriber.event, publisher, subscriber, relationship: 'name-matched-event' });
            if (flows.length >= limits.maxEventFlows) break;
        }
        if (flows.length >= limits.maxEventFlows) break;
    }
    return { status: publishers.length + subscribers.length >= limits.maxEventRefs ? 'partial' : 'complete', publishers, subscribers, flows, summary: { publisherCount: publishers.length, subscriberCount: subscribers.length, matchedFlows: flows.length, unmatchedPublishers: publishers.filter((p) => !subscribers.some((s) => s.event === p.event)).length, unmatchedSubscribers: subscribers.filter((s) => !publishers.some((p) => p.event === s.event)).length }, semantics: 'Matches explicit string event names and common emitter/listener APIs only; indirect names, typed event buses, framework registration, and runtime dispatch may be missed.' };
}

function analyzeResourceAndTransactions(functions, filesByPath, limits) {
    const resources = [];
    const transactions = [];
    const exceptions = [];
    const findings = [];
    const acquisition = /\b(?:open|createReadStream|createWriteStream|getConnection|acquire|lock|connect|new\s+(?:FileInputStream|FileOutputStream|BufferedReader|BufferedWriter|Socket|Scanner|InputStream|OutputStream))\s*\(/i;
    const release = /\b(?:close|dispose|release|unlock|destroy|disconnect)\s*\(/i;
    const txStart = /\b(?:beginTransaction|startTransaction|transaction\.begin|begin_tx|BEGIN)\b/i;
    const txFinish = /\b(?:commit|rollback|transaction\.commit|transaction\.rollback|COMMIT|ROLLBACK)\b/i;
    for (const fn of functions.slice(0, limits.maxFunctions)) {
        const code = functionText(fn, filesByPath);
        if (!code.trim()) continue;
        const path = normPath(fn.file);
        const startLine = Number(fn.line) || 1;
        const hasResource = acquisition.test(code);
        const hasRelease = release.test(code);
        const scoped = /\b(?:try\s*\(|using\s*\(|with\s+[^:\n]+:|try\s*\{[\s\S]{0,2000}finally\s*\{)/i.test(code);
        if (hasResource) {
            const item = { function: fn.name, file: path, line: startLine, acquisitionDetected: true, releaseDetected: hasRelease, structuredCleanupHint: scoped, confidence: 'LOW', semantics: 'Lexical resource lifecycle hint; not a control-flow proof.' };
            resources.push(item);
            if (!hasRelease && !scoped) findings.push(finding('lifecycle.possible-missing-cleanup', 'Possible resource cleanup gap', path, startLine, `Function ${fn.name || '(anonymous)'} appears to acquire a resource but no close/release/finally/using pattern was found in the extracted source span. Review manually.`, 'low', 'LOW'));
        }
        if (txStart.test(code) || (/@Transactional|transactional/i.test(code) && /\b(?:commit|rollback)\b/i.test(code))) {
            const starts = (code.match(/\b(?:beginTransaction|startTransaction|transaction\.begin|begin_tx|BEGIN)\b/gi) || []).length;
            const finishes = (code.match(/\b(?:commit|rollback|transaction\.commit|transaction\.rollback|COMMIT|ROLLBACK)\b/gi) || []).length;
            transactions.push({ function: fn.name, file: path, line: startLine, starts, finishes, hasCommit: /\b(?:commit|transaction\.commit|COMMIT)\b/i.test(code), hasRollback: /\b(?:rollback|transaction\.rollback|ROLLBACK)\b/i.test(code), confidence: 'LOW' });
            if (starts > 0 && finishes === 0) findings.push(finding('transaction.possible-unclosed-transaction', 'Possible transaction completion gap', path, startLine, `Function ${fn.name || '(anonymous)'} appears to begin a transaction without an explicit commit/rollback in the extracted span. Framework-managed transaction completion may make this a false positive.`, 'low', 'LOW'));
        }
        const throws = [...code.matchAll(/\b(?:throw|raise)\b/g)].map((m) => ({ line: startLine + code.slice(0, m.index).split('\n').length - 1, kind: m[0] }));
        if (throws.length) {
            exceptions.push({ function: fn.name, file: path, line: startLine, thrownOrRaised: throws.length, localCatchOrExcept: /\b(?:catch|except)\b/.test(code), localTry: /\btry\b/.test(code), locations: throws.slice(0, 20), confidence: 'LOW', semantics: 'Local lexical summary; cannot prove propagation or that all paths are handled.' });
        }
    }
    return { resources: { status: 'partial', analyzedFunctions: Math.min(functions.length, limits.maxFunctions), items: resources, semantics: 'Bounded lexical resource lifetime heuristics; no CFG/path-sensitive close analysis.' }, transactions: { status: 'partial', analyzedFunctions: Math.min(functions.length, limits.maxFunctions), items: transactions, semantics: 'Explicit transaction token heuristics; framework-managed transactions and cross-function boundaries are not proven.' }, exceptions: { status: 'partial', functionsWithExplicitThrowOrRaise: exceptions.length, items: exceptions, semantics: 'Summarizes explicit throw/raise and local catch/except syntax only; not a complete exception graph.' }, findings };
}

function analyzePathConditions(functions, filesByPath, limits) {
    const candidates = [];
    let analyzed = 0;
    for (const fn of functions.slice(0, limits.maxFunctions)) {
        const code = functionText(fn, filesByPath);
        if (!code) continue;
        analyzed++;
        const tests = [];
        const re = /\bif\s*\(\s*(!\s*)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)/g;
        let match;
        while ((match = re.exec(code))) {
            tests.push({ variable: match[2], negated: Boolean(match[1]), offset: match.index, line: (Number(fn.line) || 1) + code.slice(0, match.index).split('\n').length - 1 });
        }
        for (let i = 0; i < tests.length; i++) {
            const other = tests.slice(i + 1).find((item) => item.variable === tests[i].variable && item.negated !== tests[i].negated && item.offset - tests[i].offset < 1500);
            if (!other) continue;
            candidates.push({ file: normPath(fn.file), function: fn.name, variable: tests[i].variable, firstLine: tests[i].line, secondLine: other.line, relationship: 'opposite-boolean-guards-in-same-function', confidence: 'LOW', note: 'May be a contradictory/unreachable path if the conditions apply to the same state; nesting/control-flow semantics are not proven.' });
            if (candidates.length >= 500) break;
        }
        if (candidates.length >= 500) break;
    }
    return { status: analyzed < functions.length ? 'partial' : 'complete', analyzedFunctions: analyzed, possibleContradictions: candidates, semantics: 'Only simple boolean variable guards are compared lexically; this is not symbolic execution or path feasibility proof.' };
}

function analyzeApiContracts(endpoints, limits) {
    const routeKey = (endpoint) => {
        const route = String(endpoint.path || '/').replace(/:[A-Za-z_$][\w$]*/g, '{}').replace(/\{[^}]+\}/g, '{}').replace(/<[^>]+>/g, '{}').replace(/\/+$/, '') || '/';
        return `${String(endpoint.method || 'GET').toUpperCase()} ${route}`;
    };
    const groups = new Map();
    for (const endpoint of endpoints.slice(0, limits.maxEndpoints)) {
        const key = routeKey(endpoint);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ method: String(endpoint.method || 'GET').toUpperCase(), path: endpoint.path, file: normPath(endpoint.file), line: endpoint.line || null, framework: endpoint.framework || null });
    }
    const collisions = [...groups.entries()].filter(([, items]) => new Set(items.map((item) => `${item.file}|${item.line}`)).size > 1).map(([normalizedRoute, items]) => ({ normalizedRoute, endpoints: items, confidence: 'LOW', note: 'Routes normalize to the same method and parameter shape; may be intentional or framework-disambiguated.' }));
    const methods = {};
    for (const ep of endpoints) methods[String(ep.method || 'UNKNOWN').toUpperCase()] = (methods[String(ep.method || 'UNKNOWN').toUpperCase()] || 0) + 1;
    return { status: endpoints.length > limits.maxEndpoints ? 'partial' : 'complete', discoveredEndpointCount: endpoints.length, byMethod: methods, normalizedRouteCollisions: collisions, semantics: 'Compares statically discovered route method/path signatures only; does not validate request/response payload schemas or runtime routing precedence.' };
}

function analyzeCallGraphConsistency(files, functions, dependencies, callGraph) {
    const fileSet = new Set(files.map((file) => normPath(file.path)));
    const functionKeys = new Set(functions.map((fn) => `${normPath(fn.file)}|${Number(fn.line) || 0}|${String(fn.name || '')}`));
    const missingResolvedDependencyTargets = [];
    for (const edge of dependencies) {
        if (edge.resolution === 'resolved' && fileSet.has(normPath(edge.source)) && !fileSet.has(normPath(edge.target))) missingResolvedDependencyTargets.push({ source: edge.source, target: edge.target, type: edge.type || 'import', line: edge.line || null });
    }
    const missingCallFiles = [];
    const duplicateCalls = new Map();
    for (const edge of arr(callGraph.functionConnections)) {
        if (edge.resolution !== 'resolved') continue;
        if (!fileSet.has(normPath(edge.callerFile)) || !fileSet.has(normPath(edge.calleeFile))) missingCallFiles.push({ callerFile: edge.callerFile, calleeFile: edge.calleeFile, callSiteLine: edge.callSiteLine });
        const key = `${edge.callerFunctionKey}|${edge.calleeFunctionKey}|${edge.callSiteLine}|${edge.callSiteExcerpt || ''}`;
        duplicateCalls.set(key, (duplicateCalls.get(key) || 0) + 1);
    }
    const duplicateCallSiteEdges = [...duplicateCalls.entries()].filter(([, count]) => count > 1).map(([key, count]) => ({ key, count }));
    return { status: missingResolvedDependencyTargets.length || missingCallFiles.length || duplicateCallSiteEdges.length ? 'partial' : 'complete', checks: { filesDiscovered: fileSet.size, functionsDiscovered: functions.length, functionKeysAvailable: functionKeys.size, resolvedDependenciesChecked: dependencies.filter((edge) => edge.resolution === 'resolved').length, resolvedCallsChecked: arr(callGraph.functionConnections).filter((edge) => edge.resolution === 'resolved').length }, diagnostics: { missingResolvedDependencyTargets, missingCallFiles, duplicateCallSiteEdges }, semantics: 'Checks structural integrity of reported edges. A clean result does not prove that all true edges were discovered.' };
}

function analyzeReachability(files, functions, callGraph, endpoints, testLinkage, limits) {
    const byKey = new Map();
    const nameToKeys = new Map();
    const keyOf = (fn) => `${normPath(fn.file)}|${Number(fn.line) || 0}|${String(fn.name || '')}`;
    for (const fn of functions.slice(0, limits.maxFunctions)) {
        const key = keyOf(fn); byKey.set(key, fn);
        if (!nameToKeys.has(fn.name)) nameToKeys.set(fn.name, []);
        nameToKeys.get(fn.name).push(key);
    }
    const adj = new Map();
    for (const edge of arr(callGraph.functionConnections)) {
        if (edge.resolution !== 'resolved' || !edge.callerFunctionKey || !edge.calleeFunctionKey) continue;
        if (!adj.has(edge.callerFunctionKey)) adj.set(edge.callerFunctionKey, new Set());
        adj.get(edge.callerFunctionKey).add(edge.calleeFunctionKey);
    }
    const routePaths = new Set(endpoints.map((ep) => normPath(ep.file)));
    const testPaths = new Set(arr(testLinkage?.links).map((link) => normPath(link.testFile)));
    const roots = new Set();
    for (const fn of byKey.values()) {
        if (fn.isExported || /^(?:main|run|start|init|handler|handle|configure|bootstrap)$/i.test(fn.name || '') || routePaths.has(normPath(fn.file)) || testPaths.has(normPath(fn.file))) roots.add(keyOf(fn));
    }
    // Callgraph keys are generated by Parser and may differ from this fallback key;
    // retain only reachability grounded in actual edge keys and known source keys.
    const knownKeys = new Set([...byKey.keys(), ...[...adj.keys()], ...[...adj.values()].flatMap((value) => [...value])]);
    const seen = new Set([...roots].filter((key) => knownKeys.has(key)));
    const queue = [...seen];
    let traversedEdges = 0;
    while (queue.length && traversedEdges < limits.maxGraphEdges) {
        const key = queue.shift();
        for (const target of adj.get(key) || []) {
            traversedEdges++;
            if (!seen.has(target)) { seen.add(target); queue.push(target); }
        }
    }
    const likelyUnreachable = [...byKey.entries()].filter(([key, fn]) => !seen.has(key) && (fn.isExported || fn.isTopLevel) && !routePaths.has(normPath(fn.file)) && !testPaths.has(normPath(fn.file))).slice(0, 500).map(([key, fn]) => ({ key, name: fn.name, file: normPath(fn.file), line: fn.line || null, confidence: 'LOW', note: 'No path found from heuristic roots in the resolved static call graph; dynamic/framework entry points may be missing.' }));
    return { status: functions.length > limits.maxFunctions || traversedEdges >= limits.maxGraphEdges ? 'partial' : 'complete', rootCount: roots.size, reachableFunctionKeyCount: seen.size, likelyUnreachable, traversedEdges, semantics: 'Conservative reachability over resolved function-call edges and heuristic entry-point roots. Not a dead-code proof.' };
}

function analyzeRiskPropagation(files, dependencies, findings, limits) {
    const fileSet = new Set(files.map((file) => normPath(file.path)));
    const seeds = [...new Set(findings.filter((item) => ['security', 'vulnerability', 'taint'].includes(String(item.category || '').toLowerCase()) || /security|injection|secret|vulnerab|taint/i.test(`${item.ruleId || ''} ${item.title || ''}`)).map((item) => normPath(item.location?.path || item.file || item.path)).filter((path) => fileSet.has(path)))];
    const importersByDependency = new Map();
    for (const edge of dependencies) {
        const importer = normPath(edge.source); const dependency = normPath(edge.target);
        if (!fileSet.has(importer) || !fileSet.has(dependency)) continue;
        if (!importersByDependency.has(dependency)) importersByDependency.set(dependency, new Set());
        importersByDependency.get(dependency).add(importer);
    }
    const propagation = [];
    for (const seed of seeds) {
        const seen = new Set([seed]); const queue = [{ path: seed, depth: 0 }];
        while (queue.length && propagation.length < limits.maxRiskPaths) {
            const current = queue.shift();
            if (current.depth >= limits.maxRiskDepth) continue;
            for (const importer of importersByDependency.get(current.path) || []) {
                if (seen.has(importer)) continue;
                seen.add(importer); queue.push({ path: importer, depth: current.depth + 1 });
                propagation.push({ sourceFindingFile: seed, dependentFile: importer, depth: current.depth + 1, relationship: 'depends-on-risk-seed', confidence: 'LOW', note: 'Impact propagation through file imports; this is not proof that the dependent file is exploitable.' });
            }
        }
    }
    return { status: propagation.length >= limits.maxRiskPaths ? 'partial' : 'complete', seedFiles: seeds, propagation, summary: { seedFileCount: seeds.length, impactedFileCount: new Set(propagation.map((item) => item.dependentFile)).size }, semantics: 'Dependency-based review prioritization only; risk does not automatically transfer as a confirmed vulnerability.' };
}

function clusterFindings(findings) {
    const groups = new Map();
    for (const item of findings) {
        const path = normPath(item.location?.path || item.file || item.path);
        const line = item.location?.startLine ?? item.line ?? '';
        const family = String(item.ruleId || item.category || 'finding').split('.')[0];
        const key = `${family}|${path}|${line}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ ruleId: item.ruleId || null, title: item.title || item.name || 'Finding', severity: item.severity || 'info', confidence: item.confidence || 'unknown' });
    }
    return [...groups.entries()].filter(([, items]) => items.length > 1).map(([key, items]) => ({ id: `cluster:${stableAnalysisHash(key)}`, key, count: items.length, items, semantics: 'Same file/line/family grouping candidate; not a definitive root-cause classification.' }));
}


function analyzeSecurityInvariants(endpoints, filesByPath, dataFlow) {
    const authPattern = /@PreAuthorize|@Secured|@RolesAllowed|requires_auth|requireAuth|isAuthenticated|login_required|passport\.authenticate|authMiddleware|verifyToken|UseGuards|authorize\s*\(|authenticate\s*\(/i;
    const endpointChecks = endpoints.map((endpoint) => {
        const path = normPath(endpoint.file);
        const sourceFile = filesByPath.get(path);
        const lines = String(sourceFile?.content || '').split('\n');
        const center = Math.max(0, (Number(endpoint.line) || 1) - 1);
        const excerptLines = lines.slice(Math.max(0, center - 12), Math.min(lines.length, center + 13));
        const nearbySignal = authPattern.test(excerptLines.join('\n'));
        return {
            method: String(endpoint.method || 'UNKNOWN').toUpperCase(), route: endpoint.path || '/', file: path, line: endpoint.line || null,
            invariant: 'authentication-or-authorization-signal', result: nearbySignal ? 'nearby-signal-found' : 'no-nearby-signal-found',
            sourceAnalysis: 'same-file-nearby-window', confidence: 'LOW',
            note: nearbySignal ? 'An auth-related source pattern is nearby; enforcement still needs verification.' : 'No auth signal found in the nearby source window. Global middleware, gateway, annotations elsewhere, or framework policy can protect this route.',
        };
    });
    const sourceSinkSignals = arr(dataFlow?.flows).slice(0, 1000).map((flow) => ({
        source: flow.source || flow.sourceEvent || flow.origin || null,
        sink: flow.sink || flow.sinkEvent || flow.destination || null,
        path: flow.path || flow.file || null,
        confidence: flow.confidence || 'LOW',
        semantics: 'Existing data-flow candidate retained as an invariant-review hint; not a confirmed vulnerability.',
    }));
    return { status: endpoints.length ? 'partial' : 'skipped', endpointChecks, sourceSinkSignals, summary: { endpointCount: endpoints.length, endpointsWithoutNearbyAuthSignal: endpointChecks.filter((item) => item.result === 'no-nearby-signal-found').length, dataFlowReviewSignals: sourceSinkSignals.length }, semantics: 'Local-source invariants only. This pass cannot determine global security configuration or prove authorization.' };
}

function analyzeStateAndConcurrency(files, limits) {
    const stateByFile = [];
    const concurrencyHints = [];
    const generatedFiles = [];
    for (const file of files) {
        const path = normPath(file.path);
        const content = String(file.content || '').slice(0, limits.maxFileChars);
        if (/(?:^|\/)(?:generated|build|dist|vendor|\.next|target|out)(?:\/|$)/i.test(path) || /@Generated|DO NOT EDIT|generated by/i.test(content.slice(0, 1000))) {
            generatedFiles.push({ path, reason: 'Path/name/header resembles generated or vendor output; confirm whether it should be included in repository analyses.' });
        }
        const states = [...content.matchAll(/\b(?:this\.)?(?:status|state|phase)\s*(?:=|:\s*)\s*(["'`])([^"'`\n]{1,80})\1/g)].map((match) => ({ value: match[2], line: content.slice(0, match.index).split('\n').length }));
        if (states.length) stateByFile.push({ file: path, assignedStates: [...new Set(states.map((item) => item.value))], transitions: states, confidence: 'LOW', semantics: 'Assignment-site inventory; it does not establish valid transitions, guards, or temporal behavior.' });
        const patterns = [
            ['async-await', /\b(?:async|await)\b/g], ['thread-or-lock', /\b(?:Thread|synchronized|ReentrantLock|Mutex|Semaphore|Lock)\b/g],
            ['shared-state-write', /\b(?:this\.[A-Za-z_$][\w$]*|[A-Z][A-Z0-9_]{2,})\s*(?:=|\+=|-=|\+\+|--)/g],
            ['promise-fanout', /\b(?:Promise\.all|Promise\.allSettled|CompletableFuture\.allOf|gather)\s*\(/g],
        ];
        for (const [kind, re] of patterns) {
            const matches = [...content.matchAll(re)];
            if (matches.length) concurrencyHints.push({ file: path, kind, count: matches.length, sampleLines: matches.slice(0, 10).map((match) => content.slice(0, match.index).split('\n').length), confidence: 'LOW', note: kind === 'shared-state-write' ? 'Potential mutable state write; race conditions require control/thread analysis.' : 'Concurrency-related syntax only; presence alone is not a defect.' });
        }
    }
    return { stateTransitions: { status: stateByFile.length ? 'partial' : 'complete', files: stateByFile, semantics: 'Static assignment inventory, not a complete state machine or model checker.' }, concurrency: { status: concurrencyHints.length ? 'partial' : 'complete', hints: concurrencyHints, semantics: 'Concurrency syntax and mutation hints; no happens-before, lock-order, or race proof.' }, generatedCode: { status: 'complete', candidates: generatedFiles, note: 'Candidates are reported, not automatically excluded, to avoid hiding relevant source.' } };
}

/** Run bounded additional analyses over the existing engine's shared outputs. */
export function runAdvancedAnalysis(input = {}, customRulesResult = null) {
    const files = arr(input.files);
    const functions = arr(input.functions);
    const classes = arr(input.classes);
    const dependencies = arr(input.dependencies);
    const callGraph = input.callGraph || {};
    const endpoints = arr(input.apiEndpoints);
    const initialFindings = arr(input.findings);
    const filesByPath = new Map(files.map((file) => [normPath(file.path), file]));
    const limits = { maxFunctions: 5000, maxCloneComparisons: 300000, maxCloneResults: 1000, maxEventRefs: 10000, maxEventFlows: 3000, maxFileChars: 2 * 1024 * 1024, maxEndpoints: 10000, maxGraphEdges: 100000, maxRiskPaths: 5000, maxRiskDepth: 8 };
    const unsupportedFiles = files.filter((file) => recognizedButUnsupportedExtension.test(file.path || '')).map((file) => normPath(file.path));
    const eventFlows = analyzeEventFlows(files, limits);
    const lifecycle = analyzeResourceAndTransactions(functions, filesByPath, limits);
    const pathConditions = analyzePathConditions(functions, filesByPath, limits);
    const apiContracts = analyzeApiContracts(endpoints, limits);
    const securityInvariants = analyzeSecurityInvariants(endpoints, filesByPath, input.dataFlow);
    const stateAndConcurrency = analyzeStateAndConcurrency(files, limits);
    const semanticClones = analyzeSemanticClones(functions, filesByPath, limits);
    const consistency = analyzeCallGraphConsistency(files, functions, dependencies, callGraph);
    const reachability = analyzeReachability(files, functions, callGraph, endpoints, input.testLinkage, limits);
    const riskPropagation = analyzeRiskPropagation(files, dependencies, initialFindings, limits);
    const customRuleFindings = arr(customRulesResult?.findings);
    const findings = [...lifecycle.findings, ...customRuleFindings];
    for (const collision of apiContracts.normalizedRouteCollisions) {
        const first = collision.endpoints[0];
        findings.push(finding('api.ambiguous-normalized-route', 'Potentially overlapping API routes', first.file, first.line, `Multiple endpoints normalize to ${collision.normalizedRoute}. Check route precedence and intended parameter shapes.`, 'low', 'LOW'));
    }
    const unsupportedStatus = unsupportedFiles.length ? 'partial' : 'complete';
    const status = [eventFlows, lifecycle.resources, lifecycle.transactions, lifecycle.exceptions, pathConditions, apiContracts, securityInvariants, stateAndConcurrency.stateTransitions, stateAndConcurrency.concurrency, semanticClones, consistency, reachability, riskPropagation].some((pass) => pass.status === 'partial') || customRulesResult?.status === 'partial' || unsupportedFiles.length ? 'partial' : 'complete';
    return {
        schemaVersion: 1, status,
        summary: { filesAnalyzed: files.length, functionsAvailable: functions.length, classesAvailable: classes.length, addedFindingCandidates: findings.length, unsupportedFiles: unsupportedFiles.length },
        eventFlows,
        exceptionFlow: lifecycle.exceptions,
        resourceLifecycle: lifecycle.resources,
        transactionAnalysis: lifecycle.transactions,
        pathFeasibility: pathConditions,
        apiContracts,
        securityInvariants,
        stateTransitions: stateAndConcurrency.stateTransitions,
        concurrency: stateAndConcurrency.concurrency,
        generatedCode: stateAndConcurrency.generatedCode,
        configurationLinks: input.configLinkage || { status: 'unavailable', links: [], referencedButNotDefined: [] },
        databaseSchema: input.databaseSchema || { tables: [], semantics: 'No schema facts supplied.' },
        architectureDrift: input.architectureDrift || { status: 'unavailable', violationCount: null },
        semanticClones,
        graphConsistency: consistency,
        reachability,
        riskPropagation,
        findingClusters: clusterFindings([...initialFindings, ...findings]),
        customRules: customRulesResult || { schemaVersion: 1, status: 'not-configured', ruleCount: 0, findings: [], diagnostics: [] },
        coverage: { status: unsupportedStatus, supportedFiles: files.filter((file) => supportedHeuristicExtension.test(file.path || '')).length, unsupportedFiles, limitations: ['No full CFG or compiler-grade type model is built by these passes.', 'Symbolic execution, formal model checking, and general termination proofs are not implemented.', 'Event, lifecycle, reachability, route-collision, and path-condition outputs are heuristic candidates.'] },
        limits,
        findings,
        semantics: 'V6 extends the prior analysis with bounded, evidence-oriented heuristics. Result absence is not proof of safety; candidate signals require review.',
    };
}

export const advancedAnalysisInternals = { normalizedTokens, tokenShingles, jaccard, functionText };
