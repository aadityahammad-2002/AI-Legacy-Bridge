/**
 * Bounded, heuristic same-file source-to-sink signal scanner.
 *
 * This is deliberately NOT a taint-analysis engine or a vulnerability verdict:
 * it does not model scopes, interprocedural calls, sanitizers, overloads,
 * framework semantics, or control flow. Results are low-confidence leads for
 * a developer to inspect. No result means "not detected by these rules", not
 * proof that a repository is safe.
 */
const SUPPORTED = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyw|pyi|java)$/i;
const SOURCE_FILE_RE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|py|pyw|pyi|java|kt|kts|cs|scala|groovy|go|rs|rb|php|c|h|cc|cpp|hpp|swift|sql)$/i;
const MAX_FLOWS_PER_FILE = 20;
const MAX_TOTAL_FLOWS = 200;
const MAX_PROPAGATION_LINES = 60;
const MAX_ACTIVE_VARIABLES = 300;

function languageFor(path) {
    const value = String(path || '').toLowerCase();
    if (/\.pyw?$|\.pyi$/.test(value)) return 'python';
    if (/\.java$/.test(value)) return 'java';
    return 'javascript';
}

function maskNonCode(content, language) {
    const source = String(content || '');
    const out = source.split('');
    let state = 'code';
    let quote = '';
    let triple = false;
    const templates = [];
    for (let i = 0; i < source.length;) {
        const c = source[i], next = source[i + 1], third = source[i + 2];
        if (state === 'line-comment') {
            if (c === '\n') state = 'code'; else out[i] = ' ';
            i++; continue;
        }
        if (state === 'block-comment') {
            if (c === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'code'; }
            else { if (c !== '\n' && c !== '\r') out[i] = ' '; i++; }
            continue;
        }
        if (state === 'string') {
            if (c === '\\') { if (c !== '\n' && c !== '\r') out[i] = ' '; if (i + 1 < source.length && source[i + 1] !== '\n' && source[i + 1] !== '\r') out[i + 1] = ' '; i += 2; continue; }
            if (triple && c === quote && next === quote && third === quote) { out[i] = out[i + 1] = out[i + 2] = ' '; i += 3; state = 'code'; triple = false; continue; }
            if (!triple && c === quote) { out[i] = ' '; i++; state = 'code'; continue; }
            if (c !== '\n' && c !== '\r') out[i] = ' ';
            i++; continue;
        }
        if (state === 'template') {
            if (c === '\\') { if (c !== '\n' && c !== '\r') out[i] = ' '; if (i + 1 < source.length && source[i + 1] !== '\n' && source[i + 1] !== '\r') out[i + 1] = ' '; i += 2; continue; }
            if (c === '`') { out[i] = ' '; i++; templates.pop(); state = 'code'; continue; }
            if (c === '$' && next === '{') { out[i] = ' '; out[i + 1] = ' '; const frame = templates[templates.length - 1]; frame.inExpression = true; frame.braceDepth = 1; i += 2; state = 'code'; continue; }
            if (c !== '\n' && c !== '\r') out[i] = ' ';
            i++; continue;
        }

        const activeTemplateExpression = templates.length ? templates[templates.length - 1] : null;
        if (activeTemplateExpression?.inExpression) {
            if (c === '{') activeTemplateExpression.braceDepth += 1;
            else if (c === '}') {
                activeTemplateExpression.braceDepth -= 1;
                if (activeTemplateExpression.braceDepth === 0) { out[i] = ' '; activeTemplateExpression.inExpression = false; state = 'template'; i++; continue; }
            }
        }
        if (language === 'python' && c === '#') { out[i] = ' '; state = 'line-comment'; i++; continue; }
        if (language !== 'python' && c === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; state = 'line-comment'; i += 2; continue; }
        if (language !== 'python' && c === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; state = 'block-comment'; i += 2; continue; }
        if (language === 'python' && ((c === '"' && next === '"' && third === '"') || (c === "'" && next === "'" && third === "'"))) {
            quote = c; triple = true; out[i] = out[i + 1] = out[i + 2] = ' '; i += 3; state = 'string'; continue;
        }
        if (language !== 'python' && c === '`') { out[i] = ' '; templates.push({ inExpression: false, braceDepth: 0 }); state = 'template'; i++; continue; }
        if (c === '"' || c === "'") { quote = c; triple = false; out[i] = ' '; i++; state = 'string'; continue; }
        i++;
    }
    return out.join('');
}

function startsNewFunctionScope(line, language) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return false;
    if (language === 'python') return /^(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*/.test(trimmed);
    if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/.test(trimmed)) return true;
    if (/^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=.*(?:=>|\bfunction\b)/.test(trimmed)) return true;
    // Java/C-like method declarations. Exclude control statements and common
    // calls by requiring a declaration-shaped prefix and a body/opening brace.
    if (language === 'java' && !/^(?:if|for|while|switch|catch|return|throw|new|else|do)\b/.test(trimmed)) {
        return /^(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|\s)+)?[A-Za-z_$][\w.$<>?,\[\]|&]*\s+[A-Za-z_$][\w$]*\s*\([^;]*\)\s*(?:throws\s+[\w., ]+\s*)?\{?\s*$/.test(trimmed);
    }
    // JavaScript/TypeScript class/object methods and concise methods.
    if (!/^(?:if|for|while|switch|catch|return|throw|new|else|do|try)\b/.test(trimmed)) {
        return /^(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^;]*\)\s*\{\s*$/.test(trimmed);
    }
    return false;
}

function detectMitigationSignals(rhs, language) {
    const value = String(rhs || '');
    const candidates = language === 'python'
        ? [/\b(?:html\.escape|markupsafe\.escape|bleach\.clean)\s*\(/i]
        : language === 'java'
            ? [/\b(?:Encode\.forHtml|HtmlUtils\.htmlEscape|StringEscapeUtils\.escapeHtml4?)\s*\(/i]
            : [/\b(?:DOMPurify\.sanitize|sanitizeHtml|escapeHtml|escapeHTML|he\.encode|xss)\s*\(/i];
    return candidates.filter((pattern) => pattern.test(value)).map((pattern) => pattern.source.replace(/\\b|\\s\*\\\(/g, '').slice(0, 100));
}

function sourceKinds(language, line) {
    const patterns = language === 'python' ? [
        { kind: 'request-input', re: /\brequest\s*\.\s*(?:args|form|json|values|data|files)\b|\binput\s*\(/ },
    ] : language === 'java' ? [
        { kind: 'request-input', re: /\b(?:request|httpRequest)\s*\.\s*get(?:Parameter|Header|QueryString)\s*\(/ },
    ] : [
        { kind: 'request-input', re: /\b(?:req|request)\s*\.\s*(?:body|query|params|headers|cookies)\b/ },
        { kind: 'browser-input', re: /\b(?:location\s*\.\s*(?:search|hash)|new\s+URLSearchParams)\b/ },
    ];
    return patterns.filter((item) => item.re.test(line)).map((item) => item.kind);
}

const SINKS = [
    { kind: 'sql-query', re: /(?:\.\s*(?:query|execute|raw)\s*\(|\b(?:executeQuery|executeUpdate|prepareStatement|createQuery)\s*\()/i },
    { kind: 'command-execution', re: /\b(?:exec|execSync|spawn|system|popen)\s*\(/i },
    { kind: 'dynamic-evaluation', re: /\beval\s*\(|\bnew\s+Function\s*\(/i },
    { kind: 'html-injection', re: /\binnerHTML\s*=|\bdangerouslySetInnerHTML\b/i },
];

function assignmentOnLine(line, language) {
    if (/^\s*(?:function\b|async\s+function\b|class\b|def\b|return\b|throw\b|if\b|while\b|for\b|switch\b|case\b|import\b|from\b|export\s+(?:import|\{)|\/\/|\/\*|\*)/.test(line)) return null;
    const patterns = language === 'java' ? [
        /^\s*(?:(?:final\s+)?(?:byte|short|int|long|float|double|boolean|char|String|Object|var|[A-Z][\w.$<>?,\[\]]*)\s+)([A-Za-z_$][\w$]*)\s*=(?!=|>)([\s\S]*?)\s*;?\s*$/,
        /^\s*([A-Za-z_$][\w$]*)\s*=(?!=|>)([\s\S]*?)\s*;?\s*$/,
    ] : [
        /^\s*(?:(?:const|let|var|final)\s+)?([A-Za-z_$][\w$]*)\s*=(?!=|>)([\s\S]*?)\s*;?\s*$/,
    ];
    for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) return { variable: match[1], rhs: match[2] || '' };
    }
    return null;
}

function identifierUsed(line, name) {
    return new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Za-z0-9_$])`).test(line);
}

function dedupeOrigins(origins) {
    const byKey = new Map();
    for (const origin of origins) byKey.set(`${origin.sourceLine}|${origin.sourceKind}|${origin.variable}`, origin);
    return [...byKey.values()].slice(0, 10);
}

export function analyzeHeuristicDataFlows(files = [], options = {}) {
    const maxTotalFlows = Math.max(1, Math.min(MAX_TOTAL_FLOWS, Number(options.maxTotalFlows) || MAX_TOTAL_FLOWS));
    const flows = [];
    const supportedFiles = [];
    let sourceEventCount = 0;
    let sinkEventCount = 0;
    let filesWithSourceOrSink = 0;
    let functionScopeResets = 0;
    let mitigationSignalsObserved = 0;

    for (const file of files) {
        if (!file?.path || typeof file.content !== 'string' || !SUPPORTED.test(file.path)) continue;
        supportedFiles.push(file.path);
        const language = languageFor(file.path);
        const masked = maskNonCode(file.content, language);
        const lines = masked.split('\n');
        const active = new Map();
        let localFlows = 0;
        let sawSourceOrSink = false;
        const seenFlows = new Set();

        for (let index = 0; index < lines.length; index++) {
            const lineNumber = index + 1;
            const line = lines[index];
            // Do not leak a local variable's taint into an unrelated later
            // function. Closures/interprocedural flows are intentionally not
            // traced by this bounded heuristic scanner.
            if (startsNewFunctionScope(line, language)) { active.clear(); functionScopeResets += 1; }
            for (const [name, origins] of active.entries()) {
                const current = origins.filter((origin) => lineNumber - origin.lastTaintedLine <= MAX_PROPAGATION_LINES);
                if (current.length) active.set(name, current);
                else active.delete(name);
            }

            const sources = sourceKinds(language, line);
            const sinkKinds = SINKS.filter((sink) => sink.re.test(line)).map((sink) => sink.kind);
            if (sources.length || sinkKinds.length) sawSourceOrSink = true;
            sourceEventCount += sources.length;
            sinkEventCount += sinkKinds.length;
            const assignment = assignmentOnLine(line, language);
            const originsInExpression = [];
            if (assignment) {
                for (const [name, origins] of active.entries()) {
                    if (identifierUsed(assignment.rhs, name)) originsInExpression.push(...origins);
                }
            } else {
                for (const [name, origins] of active.entries()) {
                    if (identifierUsed(line, name)) originsInExpression.push(...origins);
                }
            }

            const newOrigins = [];
            for (const sourceKind of sources) {
                newOrigins.push({ sourceLine: lineNumber, sourceKind, variable: assignment?.variable || '<inline-source>', lastTaintedLine: lineNumber });
            }
            const mitigationSignals = assignment ? detectMitigationSignals(assignment.rhs, language) : [];
            if (mitigationSignals.length) mitigationSignalsObserved += mitigationSignals.length;
            const propagatedFromExpression = originsInExpression.map((origin) => ({
                ...origin,
                lastTaintedLine: lineNumber,
                ...(mitigationSignals.length ? { mitigationSignals: [...new Set([...(origin.mitigationSignals || []), ...mitigationSignals])] } : {}),
            }));
            const propagated = dedupeOrigins([...propagatedFromExpression, ...newOrigins]);
            if (assignment) {
                if (propagated.length) active.set(assignment.variable, propagated);
                else active.delete(assignment.variable); // A later untainted assignment kills this variable's prior heuristic taint.
                // Keep the local taint environment bounded on generated/very large files.
                while (active.size > MAX_ACTIVE_VARIABLES) active.delete(active.keys().next().value);
            }

            if (!sinkKinds.length || !propagated.length) continue;
            for (const origin of propagated) {
                if (origin.sourceLine > lineNumber) continue;
                for (const sinkKind of sinkKinds) {
                    const key = `${origin.sourceLine}|${lineNumber}|${origin.sourceKind}|${sinkKind}`;
                    if (seenFlows.has(key)) continue;
                    seenFlows.add(key);
                    if (localFlows >= MAX_FLOWS_PER_FILE || flows.length >= maxTotalFlows) break;
                    flows.push({
                        id: `data-flow:${file.path}:${origin.sourceLine}:${lineNumber}:${origin.sourceKind}:${sinkKind}`,
                        source: { path: file.path, line: origin.sourceLine, kind: origin.sourceKind, variable: origin.variable },
                        sink: { path: file.path, line: lineNumber, kind: sinkKind },
                        propagation: origin.variable === '<inline-source>' ? 'same-line heuristic' : 'identifier/assignment heuristic',
                        ...(origin.mitigationSignals?.length ? { mitigationSignals: origin.mitigationSignals, interpretation: 'Potential flow with a sanitizer/encoder-like call observed; effectiveness and context were not verified.' } : {}),
                        confidence: 'low', severity: 'potential',
                        evidence: [
                            { path: file.path, line: origin.sourceLine, excerpt: String(lines[origin.sourceLine - 1] || '').trim().slice(0, 240) },
                            { path: file.path, line: lineNumber, excerpt: String(lines[lineNumber - 1] || '').trim().slice(0, 240) },
                        ],
                        limitations: ['Single-file heuristic only', 'Approximate function-boundary detection; nested scopes/control flow are not modeled.', 'Sanitizer-like calls are recorded as signals, not verified; no interprocedural data flow.'],
                    });
                    localFlows += 1;
                }
                if (localFlows >= MAX_FLOWS_PER_FILE || flows.length >= maxTotalFlows) break;
            }
            if (flows.length >= maxTotalFlows) break;
        }
        if (sawSourceOrSink) filesWithSourceOrSink += 1;
        if (flows.length >= maxTotalFlows) break;
    }

    const unsupportedFiles = files.filter((file) => file?.path && typeof file.content === 'string' && SOURCE_FILE_RE.test(file.path) && !SUPPORTED.test(file.path)).map((file) => file.path).sort();
    const sourceFiles = files.filter((file) => file?.path && typeof file.content === 'string' && SOURCE_FILE_RE.test(file.path));
    return {
        schemaVersion: 2,
        status: unsupportedFiles.length ? 'partial' : 'heuristic-limited',
        semantics: 'Low-confidence source-to-sink leads for explicitly supported files only. Unsupported source languages are enumerated; results do not model complete scopes, control flow, aliases, sanitizer semantics, or runtime behavior. No reported flow is not proof of safety.',
        limits: { maxPropagationLines: MAX_PROPAGATION_LINES, maxFlowsPerFile: MAX_FLOWS_PER_FILE, maxTotalFlows },
        coverage: {
            sourceFiles: sourceFiles.length,
            supportedFiles: supportedFiles.length,
            unsupportedFiles: unsupportedFiles.length,
            supportedExtensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py', '.pyw', '.pyi', '.java'],
            unsupportedExtensions: [...new Set(unsupportedFiles.map((path) => `.${String(path).split('.').pop().toLowerCase()}`))].sort(),
            complete: unsupportedFiles.length === 0,
        },
        summary: {
            supportedFiles: supportedFiles.length,
            sourceFiles: sourceFiles.length,
            unsupportedFiles: unsupportedFiles.length,
            filesWithSourceOrSink,
            functionScopeResets,
            mitigationSignalsObserved,
            sourceEvents: sourceEventCount,
            sinkEvents: sinkEventCount,
            potentialFlows: flows.length,
            resultLimitReached: flows.length >= maxTotalFlows,
        },
        unsupportedFiles,
        flows,
    };
}


/**
 * Bounded one-to-three-call-hop source-to-sink tracing over uniquely resolved
 * call-graph edges. This is still heuristic: it does not model full control
 * flow, aliasing, virtual dispatch, or sanitizer semantics. It intentionally
 * emits low-confidence investigation leads rather than vulnerability verdicts.
 */
export function analyzeInterproceduralDataFlows(files = [], functions = [], functionConnections = [], options = {}) {
    const maxDepth = Math.max(1, Math.min(3, Number(options.maxDepth) || 3));
    const maxFlows = Math.max(1, Math.min(500, Number(options.maxFlows) || 100));
    const maxStates = Math.max(50, Math.min(5000, Number(options.maxStates) || 1500));
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    const sourceMasks = new Map();
    const funcs = new Map();
    const paramsByFunction = new Map();
    const outgoing = new Map();

    const fnKey = (fn) => `${fn?.file || ''}|${fn?.line || ''}|${fn?.name || ''}`;
    const simpleName = (name) => String(name || '').split('.').pop();
    const getMasked = (file) => {
        if (!sourceMasks.has(file.path)) sourceMasks.set(file.path, maskNonCode(file.content || '', languageFor(file.path)));
        return sourceMasks.get(file.path);
    };
    const languageParams = (fn, file) => {
        const language = languageFor(file.path);
        const source = getMasked(file);
        const lines = source.split('\n');
        const start = Math.max(0, Number(fn.line || 1) - 1);
        const end = Math.min(lines.length, Number(fn.endLine || fn.line || 1), start + 80);
        const excerpt = lines.slice(start, end).join('\n');
        const name = simpleName(fn.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let match = null;
        if (language === 'python') {
            match = excerpt.match(new RegExp(`\\b(?:async\\s+)?def\\s+${name}\\s*\\(([\\s\\S]*?)\\)\\s*(?:->\\s*[^:]+)?\\s*:`, 'm'));
        } else if (language === 'java') {
            match = excerpt.match(new RegExp(`\\b${name}\\s*\\(([\\s\\S]*?)\\)\\s*(?:throws\\s+[\\w., ]+)?\\s*(?:\\{|;|$)`, 'm'));
        } else {
            match = excerpt.match(new RegExp(`\\bfunction\\s*\\*?\\s*${name}\\s*\\(([\\s\\S]*?)\\)`, 'm')) ||
                excerpt.match(new RegExp(`\\b${name}\\s*[:=]\\s*(?:async\\s*)?\\(([\\s\\S]*?)\\)\\s*(?:=>|\\{)`, 'm')) ||
                excerpt.match(new RegExp(`\\b${name}\\s*\\(([\\s\\S]*?)\\)\\s*\\{`, 'm'));
        }
        if (!match) return [];
        const raw = match[1] || '';
        const paramSegments = [];
        let startAt = 0, round = 0, square = 0, curly = 0;
        for (let index = 0; index < raw.length; index++) {
            const c = raw[index];
            if (c === '(') round++; else if (c === ')') round = Math.max(0, round - 1);
            else if (c === '[') square++; else if (c === ']') square = Math.max(0, square - 1);
            else if (c === '{') curly++; else if (c === '}') curly = Math.max(0, curly - 1);
            else if (c === ',' && round === 0 && square === 0 && curly === 0) { paramSegments.push(raw.slice(startAt, index)); startAt = index + 1; }
        }
        if (raw.slice(startAt).trim()) paramSegments.push(raw.slice(startAt));
        return paramSegments.map((part) => {
            const first = part.split('=')[0].trim();
            if (language === 'python') return first.replace(/^\*{0,2}/, '').split(':')[0].trim();
            if (language === 'java') return (first.match(/([A-Za-z_$][\w$]*)\s*(?:\[\])?\s*$/) || [])[1] || '';
            if (first.startsWith('{') || first.startsWith('[')) return first;
            return (first.split(':')[0] || '').replace(/^\.\.\./, '').trim();
        }).filter(Boolean);
    };
    const splitArguments = (original, masked) => {
        const result = [];
        let startAt = 0, round = 0, square = 0, curly = 0;
        for (let i = 0; i < masked.length; i++) {
            const c = masked[i];
            if (c === '(') round++; else if (c === ')') round = Math.max(0, round - 1);
            else if (c === '[') square++; else if (c === ']') square = Math.max(0, square - 1);
            else if (c === '{') curly++; else if (c === '}') curly = Math.max(0, curly - 1);
            else if (c === ',' && round === 0 && square === 0 && curly === 0) { result.push(original.slice(startAt, i).trim()); startAt = i + 1; }
        }
        if (original.slice(startAt).trim()) result.push(original.slice(startAt).trim());
        return result;
    };
    const argsAtCall = (edge) => {
        const file = filesByPath.get(edge.callerFile);
        if (!file) return [];
        const masked = getMasked(file), original = file.content;
        const lines = masked.split('\n');
        const lineStart = lines.slice(0, Math.max(0, (edge.callSiteLine || 1) - 1)).reduce((sum, line) => sum + line.length + 1, 0);
        const lineEnd = masked.indexOf('\n', lineStart);
        const rawLine = masked.slice(lineStart, lineEnd < 0 ? masked.length : lineEnd);
        const callName = String(edge.callName || edge.calleeFunctionName || '').split('.').pop();
        let callOffset = Number.isInteger(edge.callSiteColumn) ? lineStart + edge.callSiteColumn - 1 : -1;
        if (callOffset < lineStart || callOffset > (lineEnd < 0 ? masked.length : lineEnd) || !masked.slice(callOffset, callOffset + callName.length).includes(callName)) {
            const escaped = callName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
            const found = pattern.exec(rawLine);
            if (!found) return [];
            callOffset = lineStart + found.index;
        }
        const open = masked.indexOf('(', callOffset + callName.length);
        if (open < 0 || (lineEnd >= 0 && open > lineEnd + 4000)) return [];
        let depth = 0, close = -1;
        for (let i = open; i < masked.length && i - open < 8000; i++) {
            if (masked[i] === '(') depth++;
            else if (masked[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
        }
        if (close < 0) return [];
        return splitArguments(original.slice(open + 1, close), masked.slice(open + 1, close));
    };

    for (const fn of functions) {
        const file = filesByPath.get(fn.file);
        if (!file || !Number.isInteger(Number(fn.line))) continue;
        const key = fn.key || fnKey(fn);
        funcs.set(key, { ...fn, key, file: file.path, endLine: Number(fn.endLine || fn.line) });
        paramsByFunction.set(key, languageParams(fn, file));
    }
    for (const edge of functionConnections || []) {
        if (!edge?.callerFunctionKey || !edge?.calleeFunctionKey || edge.resolution !== 'resolved') continue;
        if (!funcs.has(edge.callerFunctionKey) || !funcs.has(edge.calleeFunctionKey)) continue;
        if (!outgoing.has(edge.callerFunctionKey)) outgoing.set(edge.callerFunctionKey, []);
        outgoing.get(edge.callerFunctionKey).push({ ...edge, args: argsAtCall(edge) });
    }

    const sourceOrigin = (file, line, kind, variable) => ({ sourcePath: file.path, sourceLine: line, sourceKind: kind, sourceVariable: variable || '<inline-source>' });
    const seenFlows = new Set();
    const outputFlows = [];
    const queue = [];
    const stateSeen = new Set();
    let statesProcessed = 0;
    let callsWithTaintedArguments = 0;
    let sinkChecks = 0;

    // Seed only functions whose source span contains a recognized input source.
    // This avoids spending the state budget on unrelated utility functions;
    // caller states are added when tainted arguments reach their parameters.
    for (const fn of funcs.values()) {
        const file = filesByPath.get(fn.file);
        if (!file) continue;
        const maskedLines = getMasked(file).split('\n');
        const start = Math.max(1, Number(fn.line) || 1);
        const end = Math.min(maskedLines.length, Math.max(start, Number(fn.endLine) || start));
        let hasSource = false;
        for (let line = start; line <= end && !hasSource; line++) hasSource = sourceKinds(languageFor(file.path), maskedLines[line - 1] || '').length > 0;
        if (hasSource) queue.push({ functionKey: fn.key, taintedParams: {}, origins: {}, trace: [], depth: 0 });
    }

    while (queue.length && statesProcessed < maxStates && outputFlows.length < maxFlows) {
        const state = queue.shift();
        const fn = funcs.get(state.functionKey);
        const file = fn && filesByPath.get(fn.file);
        if (!fn || !file) continue;
        const taintSignature = Object.entries(state.taintedParams).sort(([a], [b]) => a.localeCompare(b)).map(([index, origins]) => `${index}:${(origins || []).map((origin) => `${origin.sourcePath}:${origin.sourceLine}:${origin.sourceKind}`).sort().join(';')}`).join(',');
        const stateKey = `${state.functionKey}|${state.depth}|${taintSignature}|${state.trace.map((item) => `${item.callerFile}:${item.callSiteLine}:${item.calleeFunctionKey}`).join(',')}`;
        if (stateSeen.has(stateKey)) continue;
        stateSeen.add(stateKey); statesProcessed++;
        const language = languageFor(file.path);
        const masked = getMasked(file);
        const lines = masked.split('\n');
        const originalLines = file.content.split('\n');
        const startLine = Math.max(1, Number(fn.line) || 1);
        const endLine = Math.min(lines.length, Math.max(startLine, Number(fn.endLine) || startLine));
        const params = paramsByFunction.get(fn.key) || [];
        const active = new Map();
        for (const [index, origins] of Object.entries(state.taintedParams)) {
            const name = params[Number(index)];
            if (name && Array.isArray(origins) && origins.length) active.set(name, origins);
        }
        const outgoingEdges = (outgoing.get(fn.key) || []).filter((edge) => edge.callSiteLine >= startLine && edge.callSiteLine <= endLine);

        for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
            const line = lines[lineNumber - 1] || '';
            const sources = sourceKinds(language, line);
            const sinkKinds = SINKS.filter((sink) => sink.re.test(line)).map((sink) => sink.kind);
            const assignment = assignmentOnLine(line, language);
            const usedOrigins = [];
            const expression = assignment ? assignment.rhs : line;
            for (const [name, origins] of active.entries()) if (identifierUsed(expression, name)) usedOrigins.push(...origins);
            const inlineOrigins = sources.map((kind) => sourceOrigin(file, lineNumber, kind, assignment?.variable || '<inline-source>'));
            const propagated = dedupeOrigins([...usedOrigins, ...inlineOrigins]);
            if (assignment) {
                if (propagated.length) active.set(assignment.variable, propagated);
                else active.delete(assignment.variable);
                while (active.size > MAX_ACTIVE_VARIABLES) active.delete(active.keys().next().value);
            }

            if (sinkKinds.length) {
                sinkChecks += 1;
                for (const origin of propagated) {
                    const crossFunction = origin.sourcePath !== file.path || state.trace.length > 0;
                    if (!crossFunction && origin.sourceLine === lineNumber && !identifierUsed(line, origin.sourceVariable)) {
                        // Inline expression sources are still worth considering for same-line sinks.
                        if (origin.sourceVariable !== '<inline-source>') continue;
                    }
                    for (const sinkKind of sinkKinds) {
                        const id = `${origin.sourcePath}:${origin.sourceLine}|${file.path}:${lineNumber}|${sinkKind}|${state.trace.length}`;
                        if (seenFlows.has(id)) continue;
                        seenFlows.add(id);
                        outputFlows.push({
                            id: `interprocedural-flow:${id}`,
                            source: { path: origin.sourcePath, line: origin.sourceLine, kind: origin.sourceKind, variable: origin.sourceVariable },
                            sink: { path: file.path, line: lineNumber, kind: sinkKind },
                            propagation: state.trace.length ? 'bounded interprocedural parameter flow' : 'function-local taint summary',
                            callTrace: state.trace.map((item) => ({ from: item.callerFunctionKey, to: item.calleeFunctionKey, path: item.callerFile, line: item.callSiteLine, excerpt: item.callSiteExcerpt || null })),
                            confidence: 'low', severity: 'potential',
                            evidence: [
                                { path: origin.sourcePath, line: origin.sourceLine, excerpt: String(filesByPath.get(origin.sourcePath)?.content || '').split('\n')[origin.sourceLine - 1]?.trim().slice(0, 240) || '' },
                                { path: file.path, line: lineNumber, excerpt: String(originalLines[lineNumber - 1] || '').trim().slice(0, 240) },
                            ],
                            limitations: ['Bounded heuristic interprocedural analysis only.', 'Does not model full control flow, variable aliases, dynamic dispatch, or sanitizer correctness.', 'A reported flow is not proof of exploitability; no reported flow is not proof of safety.'],
                        });
                        if (outputFlows.length >= maxFlows) break;
                    }
                    if (outputFlows.length >= maxFlows) break;
                }
            }
            if (outputFlows.length >= maxFlows || state.depth >= maxDepth) continue;

            for (const edge of outgoingEdges.filter((candidate) => candidate.callSiteLine === lineNumber)) {
                if (!edge.args?.length) continue;
                const calleeParams = paramsByFunction.get(edge.calleeFunctionKey) || [];
                const taintedParams = {};
                const originsByParam = {};
                for (let argIndex = 0; argIndex < edge.args.length && argIndex < calleeParams.length; argIndex++) {
                    const arg = edge.args[argIndex];
                    const argOrigins = [];
                    for (const [name, origins] of active.entries()) if (identifierUsed(arg, name)) argOrigins.push(...origins);
                    // A direct request/browser source at the call-site can be passed without a local variable.
                    for (const kind of sourceKinds(language, arg)) argOrigins.push(sourceOrigin(file, lineNumber, kind, '<inline-source>'));
                    const uniqueOrigins = dedupeOrigins(argOrigins);
                    if (uniqueOrigins.length) {
                        taintedParams[argIndex] = uniqueOrigins;
                        originsByParam[argIndex] = uniqueOrigins;
                    }
                }
                if (!Object.keys(taintedParams).length) continue;
                callsWithTaintedArguments++;
                queue.push({
                    functionKey: edge.calleeFunctionKey,
                    taintedParams,
                    origins: originsByParam,
                    trace: [...state.trace, edge].slice(-maxDepth),
                    depth: state.depth + 1,
                });
                if (queue.length > maxStates) break;
            }
        }
        if (outputFlows.length >= maxFlows) break;
    }

    return {
        schemaVersion: 1,
        status: statesProcessed >= maxStates || outputFlows.length >= maxFlows ? 'partial' : 'heuristic-limited',
        semantics: 'Bounded interprocedural source-to-sink leads using resolved call edges and heuristic argument-to-parameter mapping. Results are low-confidence and do not model complete control flow, types, aliasing, dynamic dispatch, or sanitizer semantics.',
        limits: { maxDepth, maxFlows, maxStates },
        summary: { functionsIndexed: funcs.size, resolvedCallEdgesUsed: [...outgoing.values()].reduce((sum, edges) => sum + edges.length, 0), statesProcessed, callsWithTaintedArguments, sinkChecks, potentialFlows: outputFlows.length, resultLimitReached: outputFlows.length >= maxFlows, stateLimitReached: statesProcessed >= maxStates },
        flows: outputFlows,
    };
}
