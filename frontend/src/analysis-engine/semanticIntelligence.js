/** Symbol-level static intelligence. Conservative: never convert a name match
 * into a proven cross-file binding without a resolved import and unique target.
 * This is NOT a compiler or dynamic dispatch engine. */
import { identifyCodeLanguage, maskLanguageNonCode } from './languageIntelligence.js';

const k = (f) => `${f.file}|${f.line}|${f.name}`;
const limit = (n, max) => Math.max(1, Math.min(max, Number(n) || max));
const uniq = (values) => [...new Set(values)];

function baseDeclarations(file) {
    const lang = identifyCodeLanguage(file.path);
    if (!lang) return [];
    const sanitized = maskLanguageNonCode(file.content, lang);
    const result = [];
    const expressions = [
        // Java, JS/TS, C#, Scala, Swift, Kotlin, Ruby, and similar syntax.
        /\b(?:class|interface|struct|trait)\s+([A-Za-z_$][\w$]*)\s*(?:\([^\n)]*\))?\s*(?:extends\s+([A-Za-z_$][\w$.<>]*(?:\s*,\s*[A-Za-z_$][\w$.<>]*)*)|implements\s+([A-Za-z_$][\w$.<>]*(?:\s*,\s*[A-Za-z_$][\w$.<>]*)*))?/g,
        // C++ and C#: class Child : public Base, AnotherBase / class Child : Base
        /\b(?:class|struct|interface)\s+([A-Za-z_$][\w$]*)\s*:\s*(?:public\s+|private\s+|protected\s+)?([A-Za-z_$][\w:]*(?:\s*,\s*(?:(?:public|private|protected)\s+)?[A-Za-z_$][\w:]*)*)/g,
    ];
    for (const expression of expressions) {
        for (const match of sanitized.matchAll(expression)) {
            const bases = (match[2] || match[3] || '').split(',').map(s => s.trim().replace(/^(?:public|private|protected)\s+/, '').split(/[.<:]/).filter(Boolean).pop()).filter(Boolean);
            const line = sanitized.slice(0, match.index).split('\n').length;
            for (const base of bases) result.push({ childName: match[1], baseName: base, file: file.path, line, provenance: 'lexical-type-declaration' });
        }
    }
    // Python class Child(Base, pkg.Mixin): with comment and string masking.
    if (lang === 'Python') {
        const py = /\bclass\s+([A-Za-z_]\w*)\s*\(\s*([^)]{1,320})\)/g;
        for (const match of sanitized.matchAll(py)) {
            const line = sanitized.slice(0, match.index).split('\n').length;
            for (const raw of match[2].split(',')) {
                const base = raw.trim().split('.').pop();
                if (/^[A-Za-z_]\w*$/.test(base)) result.push({ childName: match[1], baseName: base, file: file.path, line, provenance: 'python-base-class-list' });
            }
        }
    }
    return result;
}

/** Bounded, source-identified symbol relationships and candidate inheritance. */
export function analyzeSemanticIntelligence({ files = [], functions = [], classes = [], dependencies = [], functionConnections = [] } = {}, options = {}) {
    const maxSymbols = limit(options.maxSymbols, 20000);
    const maxRelations = limit(options.maxRelations, 25000);
    const symbols = functions.slice(0, maxSymbols).filter(fn => fn.file && fn.name && Number.isInteger(fn.line)).map(fn => ({
        key: fn.key || k(fn), file: fn.file, name: fn.name, line: fn.line, endLine: fn.endLine || fn.line,
        scope: fn.className || null, kind: fn.type || 'function', provenance: fn.extractionProvenance || 'inherited-parser-result',
    }));
    const definitions = new Map();
    for (const c of classes) {
        if (!c?.name || !c.file) continue;
        if (!definitions.has(c.name)) definitions.set(c.name, []);
        definitions.get(c.name).push(c);
    }
    const outgoing = new Map();
    for (const d of dependencies) {
        if (d.resolution !== 'resolved') continue;
        if (!outgoing.has(d.source)) outgoing.set(d.source, new Set());
        outgoing.get(d.source).add(d.target);
    }
    const inheritance = [];
    let unresolved = 0, ambiguous = 0;
    for (const file of files) {
        for (const declaration of baseDeclarations(file)) {
            if (inheritance.length >= maxRelations) break;
            const candidates = (definitions.get(declaration.baseName) || []).filter(c =>
                c.file === file.path || outgoing.get(file.path)?.has(c.file));
            const unique = uniq(candidates.map(c => `${c.file}:${c.line}:${c.name}`));
            let resolution = 'unresolved';
            if (unique.length === 1) resolution = 'static-candidate';
            else if (unique.length > 1) resolution = 'ambiguous';
            if (resolution === 'unresolved') unresolved++;
            if (resolution === 'ambiguous') ambiguous++;
            inheritance.push({ ...declaration, resolution, confidence: resolution === 'static-candidate' ? 'medium' : 'low',
                target: unique.length === 1 ? { file: candidates[0].file, line: candidates[0].line, name: candidates[0].name } : null,
                candidateCount: unique.length,
                caveat: 'Lexical base-class relationship; imported names, generics, and dynamic dispatch are not type-checked.',
            });
        }
        if (inheritance.length >= maxRelations) break;
    }
    const matchedKeys = new Set(symbols.map(s => s.key));
    const calls = [];
    for (const edge of functionConnections) {
        if (calls.length >= maxRelations) break;
        if (edge.resolution !== 'resolved' || !matchedKeys.has(edge.callerFunctionKey) || !matchedKeys.has(edge.calleeFunctionKey)) continue;
        if (!Number.isInteger(edge.callSiteLine)) continue;
        calls.push({ source: edge.callerFunctionKey, target: edge.calleeFunctionKey,
            evidence: { file: edge.callerFile, line: edge.callSiteLine }, confidence: edge.confidence || 'medium',
            provenance: edge.attribution || 'heuristic-caller-attribution' });
    }
    const result = {
        schemaVersion: 1, status: symbols.length < functions.length || calls.length >= maxRelations || inheritance.length >= maxRelations ? 'bounded' : 'partial',
        summary: { symbolsIndexed: symbols.length, resolvedCallRelations: calls.length,
            inheritanceCandidates: inheritance.length, ambiguousBases: ambiguous, unresolvedBases: unresolved },
        symbols, calls, inheritance,
        semantics: 'Calls are existing uniquely resolved call-site links; inheritance is an explicit lexical candidate only, not compiler-verified inheritance or virtual dispatch.',
    };
    return result;
}

/** Reverse impact over uniquely resolved function-key edges, bounded and cycle-safe. */
export function computeSymbolImpact(symbolKey, semanticModel, options = {}) {
    const maxNodes = limit(options.maxNodes, 2000);
    const maxDepth = limit(options.maxDepth, 20);
    const known = new Set(semanticModel?.symbols?.map(s => s.key) || []);
    if (!known.has(symbolKey)) return { status: 'unknown-symbol', changedSymbol: symbolKey, impacted: [] };
    const reverse = new Map();
    for (const edge of semanticModel.calls || []) {
        if (!known.has(edge.source) || !known.has(edge.target)) continue;
        if (!reverse.has(edge.target)) reverse.set(edge.target, []);
        reverse.get(edge.target).push(edge);
    }
    const seen = new Set([symbolKey]);
    const queue = [{ key: symbolKey, depth: 0 }];
    const impacted = [];
    let truncated = false;
    for (let i = 0; i < queue.length; i++) {
        const { key, depth } = queue[i];
        const inbound = reverse.get(key) || [];
        if (depth >= maxDepth) { if (inbound.length) truncated = true; continue; }
        for (const edge of inbound) {
            if (seen.has(edge.source)) continue;
            if (seen.size >= maxNodes) { truncated = true; break; }
            seen.add(edge.source);
            impacted.push({ symbolKey: edge.source, distance: depth + 1, via: edge.target, evidence: edge.evidence });
            queue.push({ key: edge.source, depth: depth + 1 });
        }
    }
    return { status: truncated ? 'bounded' : 'static-candidate', changedSymbol: symbolKey, impacted, truncated,
        semantics: 'Reverse static caller impact only; no proof of runtime reachability or dynamic dispatch.' };
}
