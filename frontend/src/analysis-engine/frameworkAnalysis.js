import { isApplicationSource } from './sourceClassification.js';
/**
 * Framework convention evidence. This is a transparent signal inventory, not
 * a framework-aware semantic model: it reports observed conventions and exact
 * source lines without inferring runtime behavior from names alone.
 */
const RULES = [
    { framework: 'spring', role: 'controller', re: /@(?:RestController|Controller)\b/, category: 'type-role', confidence: 'high' },
    { framework: 'spring', role: 'service', re: /@Service\b/, category: 'type-role', confidence: 'high' },
    { framework: 'spring', role: 'repository', re: /@Repository\b/, category: 'type-role', confidence: 'high' },
    { framework: 'spring', role: 'component', re: /@Component\b/, category: 'type-role', confidence: 'high' },
    { framework: 'spring', role: 'configuration', re: /@Configuration\b/, category: 'type-role', confidence: 'high' },
    { framework: 'spring', role: 'http-route', re: /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b/, category: 'route', confidence: 'high' },
    { framework: 'spring', role: 'dependency-injection', re: /@(?:Autowired|Inject|Resource)\b/, category: 'dependency-injection', confidence: 'high' },
    { framework: 'fastapi', role: 'application', re: /\bFastAPI\s*\(/, category: 'application', confidence: 'high' },
    { framework: 'fastapi', role: 'http-route', re: /@\w+\.(?:get|post|put|patch|delete|options|head|api_route|websocket)\s*\(/, category: 'route', confidence: 'medium' },
    { framework: 'fastapi', role: 'dependency-injection', re: /\bDepends\s*\(/, category: 'dependency-injection', confidence: 'high' },
    { framework: 'flask', role: 'http-route', re: /@\w+\.route\s*\(/, category: 'route', confidence: 'medium' },
    { framework: 'django', role: 'url-configuration', re: /\burlpatterns\s*=|\b(?:path|re_path)\s*\(/, category: 'routing', confidence: 'medium' },
    { framework: 'express', role: 'http-route', re: /\b(?:app|router|server)\s*\.\s*(?:get|post|put|patch|delete|options|head|all|use)\s*\(/, category: 'route', confidence: 'medium' },
    { framework: 'fastify', role: 'http-route', re: /\b(?:fastify|app|server)\s*\.\s*(?:route|get|post|put|patch|delete)\s*\(/, category: 'route', confidence: 'medium' },
    { framework: 'koa', role: 'http-route', re: /\brouter\s*\.\s*(?:get|post|put|patch|delete|use)\s*\(/, category: 'route', confidence: 'low' },
    { framework: 'react', role: 'component-or-hook', re: /\b(?:useState|useEffect|useMemo|useCallback|useReducer|useContext)\s*\(/, category: 'ui', confidence: 'medium' },
    { framework: 'react', role: 'component', re: /\bfunction\s+[A-Z][A-Za-z0-9_$]*\s*\([^)]*\)\s*\{/, category: 'ui', confidence: 'low' },
    { framework: 'vue', role: 'component-or-hook', re: /\b(?:defineComponent|defineProps|defineEmits|onMounted|ref|computed)\s*\(/, category: 'ui', confidence: 'medium' },
    { framework: 'pytest', role: 'test', re: /^\s*def\s+test_[A-Za-z0-9_]+\s*\(/, category: 'test', confidence: 'high' },
    { framework: 'jest-vitest', role: 'test', re: /\b(?:describe|it|test)\s*\(/, category: 'test', confidence: 'medium' },
];

function maskCommentsPreserveLines(content, path) {
    const source = String(content || '');
    const output = source.split('');
    const python = /\.(?:py|pyw|pyi)$/i.test(path);
    let state = 'code', quote = '', triple = false, escaped = false;
    for (let i = 0; i < source.length; i++) {
        const c = source[i], next = source[i + 1], third = source[i + 2];
        if (state === 'line') { if (c === '\n') state = 'code'; else output[i] = ' '; continue; }
        if (state === 'block') {
            if (c === '*' && next === '/') { output[i] = output[i + 1] = ' '; i++; state = 'code'; }
            else if (c !== '\n' && c !== '\r') output[i] = ' ';
            continue;
        }
        if (state === 'string') {
            if (escaped) { if (c !== '\n' && c !== '\r') output[i] = ' '; escaped = false; continue; }
            if (c === '\\') { output[i] = ' '; escaped = true; continue; }
            if (triple && c === quote && next === quote && third === quote) { output[i] = output[i + 1] = output[i + 2] = ' '; i += 2; state = 'code'; triple = false; continue; }
            if (!triple && c === quote) { output[i] = ' '; state = 'code'; continue; }
            if (c !== '\n' && c !== '\r') output[i] = ' ';
            continue;
        }
        if (python && c === '#') { output[i] = ' '; state = 'line'; continue; }
        if (!python && c === '/' && next === '/') { output[i] = output[i + 1] = ' '; i++; state = 'line'; continue; }
        if (!python && c === '/' && next === '*') { output[i] = output[i + 1] = ' '; i++; state = 'block'; continue; }
        if (python && ((c === '"' && next === '"' && third === '"') || (c === "'" && next === "'" && third === "'"))) { quote = c; triple = true; output[i] = output[i + 1] = output[i + 2] = ' '; i += 2; state = 'string'; continue; }
        if (c === '"' || c === "'" || (!python && c === "`")) { quote = c; triple = false; output[i] = ' '; state = 'string'; }
    }
    return output.join('');
}

function simpleFnName(fn) {
    return String(fn?.name || '').split('.').pop();
}

function extractRouteCandidate(file, rawLine, maskedLine, lineNumber) {
    const path = String(file.path || '');
    let match;
    if (/\.(?:java|kt|kts|cs|scala|groovy)$/i.test(path)) {
        match = maskedLine.match(/@(Get|Post|Put|Patch|Delete|Request)Mapping\b/);
        if (!match) return null;
        const annotation = match[1];
        const annotationText = rawLine.slice(match.index);
        const routeText = annotationText.match(/\(([^)]*)\)/)?.[1] || '';
        const routePath = routeText.match(/['"]([^'"]*)['"]/)?.[1] || null;
        const explicitVerb = routeText.match(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)/i)?.[1]?.toUpperCase();
        const method = annotation === 'Request' ? (explicitVerb || 'ANY') : annotation.toUpperCase();
        return { framework: 'spring', method, path: routePath, line: lineNumber, handlerMode: 'next-method', evidence: rawLine.trim().slice(0, 300), confidence: 'medium' };
    }
    if (/\.(?:py|pyw|pyi)$/i.test(path)) {
        match = maskedLine.match(/^\s*@\s*[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete|options|head|api_route|route|websocket)\s*\(/i);
        if (!match) return null;
        const rawDecorator = rawLine.trim();
        const routePath = rawDecorator.match(/\(\s*['"]([^'"]*)['"]/)?.[1] || null;
        return { framework: /\.route\s*\(/i.test(maskedLine) ? 'flask' : 'fastapi', method: match[1].toUpperCase(), path: routePath, line: lineNumber, handlerMode: 'next-method', evidence: rawLine.trim().slice(0, 300), confidence: routePath === null ? 'low' : 'medium' };
    }
    if (/\.(?:js|jsx|mjs|cjs|ts|tsx)$/i.test(path)) {
        match = maskedLine.match(/\b(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|options|head|all|route)\s*\(/i);
        if (!match) return null;
        const rawCall = rawLine.slice(match.index);
        const routePath = rawCall.match(/^\w+\s*\.\s*\w+\s*\(\s*['"]([^'"]*)['"]/)?.[1] || null;
        const args = rawCall.match(/\([^)]{0,1000}\)/)?.[0] || '';
        const namedHandler = args.match(/,\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\)?\s*$/)?.[1] || null;
        return { framework: 'express', method: match[1].toUpperCase(), path: routePath, line: lineNumber, handlerMode: namedHandler ? 'named-handler' : 'inline-or-unknown', handlerName: namedHandler, evidence: rawLine.trim().slice(0, 300), confidence: routePath === null ? 'low' : 'medium' };
    }
    return null;
}

function combineRoutePaths(basePath, methodPath) {
    const parts = [basePath, methodPath].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim().replace(/^\/+|\/+$/g, ''));
    return parts.length ? `/${parts.filter(Boolean).join('/')}` : '/';
}

function findSpringClassBasePaths(files, functionsByFile) {
    const baseByClass = new Map();
    const baseAnnotationLines = new Set();
    for (const file of files || []) {
        if (!/\.(?:java|kt|kts|cs|scala|groovy)$/i.test(file?.path || '') || typeof file.content !== 'string') continue;
        const rawLines = file.content.split('\n');
        const maskedLines = maskCommentsPreserveLines(file.content, file.path).split('\n');
        const fnLines = (functionsByFile.get(file.path) || []).map((fn) => Number(fn.line)).filter(Number.isInteger);
        for (let index = 0; index < maskedLines.length; index++) {
            const maskedLine = maskedLines[index] || '';
            if (!/@RequestMapping\b/.test(maskedLine)) continue;
            const routePath = (rawLines[index] || '').match(/@RequestMapping\s*\(([^)]*)\)/)?.[1]?.match(/['"]([^'"]*)['"]/)?.[1] || '';
            const nextFnLine = fnLines.filter((line) => line > index + 1).sort((a, b) => a - b)[0] || Number.POSITIVE_INFINITY;
            let className = null;
            for (let look = index; look < Math.min(maskedLines.length, index + 12) && look + 1 < nextFnLine; look++) {
                const classMatch = (maskedLines[look] || '').match(/\bclass\s+([A-Za-z_$][\w$]*)/);
                if (classMatch) { className = classMatch[1]; break; }
            }
            if (!className) continue;
            baseAnnotationLines.add(`${file.path}|${index + 1}`);
            if (!baseByClass.has(`${file.path}|${className}`)) baseByClass.set(`${file.path}|${className}`, routePath);
        }
    }
    return { baseByClass, baseAnnotationLines };
}

function bindRoutes(files, functions = [], limit = 2000) {
    const routes = [];
    const byFile = new Map();
    for (const fn of functions || []) {
        if (!fn?.file) continue;
        if (!byFile.has(fn.file)) byFile.set(fn.file, []);
        byFile.get(fn.file).push(fn);
    }
    const { baseByClass: springBaseByClass, baseAnnotationLines: springBaseAnnotationLines } = findSpringClassBasePaths(files, byFile);
    const seen = new Set();
    for (const file of files || []) {
        if (!file?.path || typeof file.content !== 'string' || !isApplicationSource(file.path)) continue;
        const rawLines = file.content.split('\n');
        const maskedLines = maskCommentsPreserveLines(file.content, file.path).split('\n');
        for (let index = 0; index < maskedLines.length && routes.length < limit; index++) {
            const candidate = extractRouteCandidate(file, rawLines[index] || '', maskedLines[index] || '', index + 1);
            if (!candidate) continue;
            // A class-level @RequestMapping is a base path, not a standalone endpoint.
            if (candidate.framework === 'spring' && springBaseAnnotationLines.has(`${file.path}|${candidate.line}`)) continue;
            const key = `${file.path}|${candidate.line}|${candidate.framework}|${candidate.method}|${candidate.path || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const fileFunctions = (byFile.get(file.path) || []).slice().sort((a, b) => Number(a.line) - Number(b.line));
            let handler = null;
            let candidates = [];
            if (candidate.handlerMode === 'named-handler' && candidate.handlerName) {
                candidates = fileFunctions.filter((fn) => simpleFnName(fn) === candidate.handlerName);
            } else if (candidate.handlerMode === 'next-method') {
                candidates = fileFunctions.filter((fn) => Number(fn.line) > candidate.line && Number(fn.line) <= candidate.line + 12 &&
                    ['method', 'function', 'arrow', 'async_method', 'async_function', 'classmethod', 'staticmethod', 'property', 'constructor'].includes(String(fn.type || '').replace(/^async_/, '')))
                    .sort((a, b) => Number(a.line) - Number(b.line));
                if (candidates.length) {
                    const firstLine = Number(candidates[0].line);
                    candidates = candidates.filter((fn) => Number(fn.line) === firstLine);
                }
            }
            if (candidates.length === 1) handler = candidates[0];
            if (candidate.framework === 'spring' && handler?.className) {
                const basePath = springBaseByClass.get(`${file.path}|${handler.className}`);
                if (basePath) candidate.path = combineRoutePaths(basePath, candidate.path);
            }
            const status = handler ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'unresolved';
            routes.push({
                id: `route:${file.path}:${candidate.line}:${candidate.method}:${candidate.path || 'unknown'}`,
                framework: candidate.framework, method: candidate.method, path: candidate.path,
                file: file.path, line: candidate.line,
                handlerName: handler?.name || candidate.handlerName || null,
                handlerFile: handler?.file || null, handlerLine: handler?.line || null,
                resolution: status, confidence: status === 'resolved' ? candidate.confidence : 'low',
                candidates: candidates.map((fn) => ({ name: fn.name, file: fn.file, line: fn.line })),
                evidence: candidate.evidence,
                semantics: 'Route and handler linkage is inferred from framework conventions and nearby source declarations; runtime registration and route composition were not verified.',
            });
        }
        if (routes.length >= limit) break;
    }
    return routes;
}

export function analyzeFrameworkSignals(files = [], options = {}) {
    const maxSignals = Math.max(1, Math.min(10000, Number(options.maxSignals) || 3000));
    const maxRoutes = Math.max(1, Math.min(10000, Number(options.maxRoutes) || 2000));
    const signals = [];
    const frameworks = Object.create(null);
    const byFile = Object.create(null);
    for (const file of files) {
        if (!file?.path || typeof file.content !== 'string') continue;
        const masked = maskCommentsPreserveLines(file.content, file.path);
        const rawLines = file.content.split('\n');
        const maskedLines = masked.split('\n');
        for (let index = 0; index < maskedLines.length; index++) {
            const line = maskedLines[index];
            if (!line.trim()) continue;
            for (const rule of RULES) {
                const path = file.path;
                const python = /\.(?:py|pyw|pyi)$/i.test(path);
                const jvm = /\.(?:java|kt|kts|groovy)$/i.test(path);
                const js = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i.test(path);
                if (['fastapi','flask','django','pytest'].includes(rule.framework) && !python) continue;
                if (rule.framework === 'spring' && !jvm) continue;
                if (['express','fastify','koa','react','vue','jest-vitest'].includes(rule.framework) && !js) continue;
                if (rule.framework === 'jest-vitest' && !/\b(?:import|require)\b[\s\S]{0,250}\b(?:vitest|jest)\b/.test(file.content.slice(0, 4000)) &&
                    !/(?:^|\/)(?:tests?|__tests__|benchmarks?|specs?)(?:\/|$)|\.(?:test|spec)\./i.test(path)) continue;
                // app.get is shared syntax across Express and Fastify: don't
                // count it twice without a framework-specific import/identifier.
                if (rule.framework === 'fastify' && !/\b(?:from\s*['"]fastify['"]|require\(['"]fastify['"]\)|fastify\s*\()/i.test(file.content.slice(0, 6000))) continue;
                if (rule.framework === 'koa' && !/\b(?:from\s*['"]@koa\/router['"]|require\(['"]@koa\/router['"]\))/i.test(file.content.slice(0, 6000))) continue;
                if (rule.framework === 'express' && /\b(?:from\s*['"]fastify['"]|require\(['"]fastify['"]\))/i.test(file.content.slice(0, 6000))) continue;
                if (!rule.re.test(line)) continue;
                const signal = {
                    id: `framework:${rule.framework}:${file.path}:${index + 1}:${rule.role}`,
                    framework: rule.framework, role: rule.role, category: rule.category,
                    file: file.path, line: index + 1, confidence: rule.confidence,
                    evidence: rawLines[index].trim().slice(0, 300),
                    semantics: 'Framework convention matched statically; runtime registration, reachability, and effective configuration were not verified.',
                };
                signals.push(signal);
                frameworks[rule.framework] = (frameworks[rule.framework] || 0) + 1;
                if (!byFile[file.path]) byFile[file.path] = [];
                byFile[file.path].push({ framework: rule.framework, role: rule.role, line: index + 1, confidence: rule.confidence });
                if (signals.length >= maxSignals) break;
            }
            if (signals.length >= maxSignals) break;
        }
        if (signals.length >= maxSignals) break;
    }
    const roleCounts = Object.create(null);
    for (const signal of signals) roleCounts[signal.role] = (roleCounts[signal.role] || 0) + 1;
    const frameworkNames = Object.keys(frameworks).sort();
    const routes = bindRoutes(files, options.functions || [], maxRoutes);
    const routeSummary = {
        total: routes.length,
        resolvedHandlers: routes.filter((route) => route.resolution === 'resolved').length,
        unresolvedHandlers: routes.filter((route) => route.resolution === 'unresolved').length,
        ambiguousHandlers: routes.filter((route) => route.resolution === 'ambiguous').length,
        limitReached: routes.length >= maxRoutes,
    };
    return {
        schemaVersion: 1,
        status: signals.length >= maxSignals ? 'partial' : 'heuristic',
        semantics: 'Framework-aware evidence inventory. These pattern matches are leads, not proof that routes/DI bindings are active at runtime.',
        detectedFrameworks: frameworkNames,
        frameworkSignalCounts: frameworks,
        roleCounts,
        signalCount: signals.length,
        resultLimitReached: signals.length >= maxSignals,
        signals,
        byFile,
        routes,
        routeSummary,
    };
}
