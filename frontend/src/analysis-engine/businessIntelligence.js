import { isApplicationSource } from './sourceClassification.js';
/**
 * Conservative source-backed decision discovery. This is NOT a compiler: a rule
 * is emitted only if its branch boundaries and an outcome are visible in the
 * same source snapshot. Unsupported/ambiguous constructs are omitted.
 */
import { identifyCodeLanguage, maskLanguageNonCode } from './languageIntelligence.js';

const SUPPORTED = new Set(['Python', 'JavaScript', 'TypeScript', 'Java', 'Kotlin', 'C#', 'Go', 'Ruby', 'PHP', 'Swift', 'Dart']);
const INDENT_BASED = new Set(['Python']);
const GUARD = /^\s*(?:if|else\s+if|elif|guard|unless)\b/;
const COMPARISON = /(?:===?|!==?|<=?|>=?|\bis\b|\bin\b|\bnot\b|\bcontains\b|\bhas\b|\bexists\b)/;
const DOMAIN_GUARD = /\b(?:order|orders|payment|invoice|customer|account|subscription|shipment|refund|booking|product|inventory|cart|claim|eligibility|billing|transaction|user|employee|leave|salary|role|permission)\s*\./i;
// Boolean predicate calls convey real branch intent even without == or !=.
// This captures common Spring repository checks while leaving results inferred.
const BOOLEAN_PREDICATE = /\b(?:existsBy[A-Z]\w*|exists\s*\(|isPresent\s*\(|hasPermission\s*\(|hasRole\s*\(|isEligible\s*\(|isAuthorized\s*\(|alreadyExists\s*\(|isDuplicate\s*\()/;
const CONTROL = /\b(throw|raise|return|break|continue)\b/;
const STATUS_UPDATE = /\b([A-Za-z_$][\w$.]*)\.(status|state)\s*=(?!=)\s*(['"`])([\w.-]{1,90})\3/g;
const OUTCOME_KIND = { throw: 'exception', raise: 'exception', return: 'return', break: 'loop-exit', continue: 'loop-continue' };
/** Ranking hint for AI consumers, not proof that a branch is a business policy.
 * Technical guards remain available; consumers can select business-likely candidates
 * instead of treating all conditional branches as confirmed business rules. */
function rankRuleContext(condition, outcome, transitions = []) {
    const input = `${condition || ''} ${outcome?.excerpt || ''}`.toLowerCase();
    const domainSignals = [
        /\b(?:order|orders|payment|invoice|customer|account|subscription|shipment|refund|booking|product|inventory|cart|claim|eligibility|billing|transaction|user|employee|leave|salary|role|permission)\b/,
        /\b(?:status|state|balance|amount|price|stock|quantity|credit|discount|limit|quota|permission|role|approved|cancelled|shipped|paid|expired)\b/,
        /\b(?:business|policy|plan|tier|entitlement|overdue|fulfill|settle|checkout)\b/,
    ].map((pattern) => pattern.test(input));
    const operationalSignals = [
        /\b(?:config|logger|logging|debug|env|environment|process|cache|token|parse|json|array|length|index|path|file|files|import|module|response|http|exception|error|stack)\b/,
        /\b(?:none|null|undefined|empty|length|hasattr|isinstance|typeof|throw|raise|retry|timeout|fallback|return|break|continue)\b/,
    ].map((pattern) => pattern.test(input));
    let score = domainSignals.reduce((n,v)=>n+(v?2:0),0) + (transitions.length ? 2 : 0)
        - operationalSignals.reduce((n,v)=>n+(v?1:0),0);
    // A single broad `status` keyword without a domain entity is not a
    // reliable indicator of business logic; avoid over-promoting it.
    // Common repository-derived business invariants can be expressed as
    // predicate calls without a binary comparison (e.g. existsByEmail).
    const domainPredicate = /\b(?:existsBy(?:Email|Username|Employee|Role|Account|Phone|Order|Invoice)\w*|hasPermission|hasRole|isEligible|isAuthorized)\s*\(/i.test(input);
    if (domainPredicate) score += 2;
    const businessEntity = domainSignals[0] || domainSignals[2] || domainPredicate;
    const category = (businessEntity && score >= 1) || (transitions.length && score >= 3)
        ? 'business-likely' : (!businessEntity && score <= 0 ? 'technical-guard-likely' : 'unclassified');
    return { category, score, indicators: {
        domainEntity: !!businessEntity, domainStateOrValue: !!domainSignals[1], domainPredicate,
        stateTransition: transitions.length > 0, operationalGuard: operationalSignals.some(Boolean),
    }, semantics: 'Static prioritization hint only; not a probability or verified business-policy label.' };
}

const indent = line => (line.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '    ').length;
const fileLines = (file) => ({ source: file.content.split(/\r?\n/), code: maskLanguageNonCode(file.content, identifyCodeLanguage(file.path)).split(/\r?\n/) });

// Require a balanced brace body. A later unrelated function's return cannot
// accidentally be promoted to the condition's outcome.
function braceBody(code, start) {
    let open = -1;
    for (let i = start; i <= Math.min(code.length - 1, start + 2); i++) {
        const before = code[i].indexOf('{');
        if (before >= 0) { open = i; break; }
        if (i > start && code[i].trim() && code[i].trim() !== '{') break;
    }
    if (open < 0) return null;
    let depth = 0, started = false;
    for (let i = open; i < code.length; i++) {
        for (const char of code[i]) {
            if (char === '{') { depth++; started = true; }
            if (char === '}') depth--;
            if (started && depth === 0) return { start: open, end: i, mode: 'braces' };
            if (depth < 0) return null;
        }
    }
    return null; // unmatched braces: no confident branch boundary
}

function pythonBody(code, start) {
    if (!/\:\s*$/.test(code[start])) return null;
    const base = indent(code[start]);
    let bodyStart = -1, bodyEnd = -1;
    for (let j = start + 1; j < code.length; j++) {
        if (!code[j].trim()) continue;
        if (indent(code[j]) <= base) break;
        if (bodyStart < 0) bodyStart = j;
        bodyEnd = j;
    }
    return bodyStart >= 0 ? { start: bodyStart, end: bodyEnd, mode: 'indent' } : null;
}

function sameLineBranch(code, start) {
    // Only a single-line guard with an unambiguously trailing statement.
    const body = code[start].match(/^\s*(?:if|else\s+if|elif|unless)\s*\([^\n]*?\)\s*(?:\{|;)?\s*((?:throw|return|break|continue)\b[^\n]*)$/);
    return body && !code[start].includes('{') ? { start, end: start, mode: 'inline' } : null;
}

// Simple one-line Python guards are common in legacy repositories. Require
// exactly one source-level colon outside quotes/comments and a visible action.
// Complex multiline and lambda/ternary forms remain intentionally unresolved.
function pythonInlineBody(code, start) {
    const text = code[start] || '';
    const colon = text.indexOf(':');
    if (colon < 0 || text.indexOf(':', colon + 1) >= 0) return null;
    const tail = text.slice(colon + 1).trim();
    return /^(?:return|raise|break|continue)\b/.test(tail) ||
        /^[A-Za-z_$][\w$.]*\.(?:status|state)\s*=(?!=)/.test(tail)
        ? { start, end:start, mode:'python-inline' } : null;
}

// Report an outcome only when it occurs in the guard's immediate body, not
// solely inside a nested if/try/loop. No general control-flow graph is built.
function immediateBraceStatements(code, boundary) {
    const statements = [];
    let depth = 0;
    for (let j = boundary.start; j <= boundary.end; j++) {
        const line = code[j];
        const begin = j === boundary.start ? line.indexOf('{') : 0;
        const finish = j === boundary.end ? line.lastIndexOf('}') : line.length;
        if (begin < 0 || finish < begin) continue;
        let segment = '';
        for (let k = begin + (j === boundary.start ? 1 : 0); k < finish; k++) {
            const c = line[k];
            if (c === '{') { depth++; segment += ' '; continue; }
            if (c === '}') { depth = Math.max(0, depth - 1); segment += ' '; continue; }
            segment += depth === 0 ? c : ' ';
        }
        // Avoid attributing a nested bare if's result to the outer branch.
        if (/\b(?:if|elif|else\s+if)\b[^;{}]*\b(?:return|raise|throw)\b/.test(segment)) continue;
        statements.push({line:j, statement:segment, offset:begin + (j === boundary.start ? 1 : 0)});
    }
    return statements;
}

function ownerOf(functions, file, line) {
    const possible = (functions || []).filter(fn => fn.file === file && Number.isInteger(fn.line) && Number.isInteger(fn.endLine) && fn.line <= line && fn.endLine >= line)
        .sort((a,b) => (a.endLine-a.line)-(b.endLine-b.line) || a.line-b.line);
    if (!possible.length || (possible.length > 1 && possible[0].endLine-possible[0].line === possible[1].endLine-possible[1].line)) return null;
    const fn = possible[0];
    return { functionKey: fn.key || `${fn.file}|${fn.line}|${fn.name}`, name: fn.name, file: fn.file, line: fn.line };
}

export function analyzeBusinessIntelligence(files = [], options = {}) {
    const maxRules = Math.max(1, Math.min(3000, Number(options.maxRules) || 1500));
    const maxBranchLines = Math.max(2, Math.min(100, Number(options.maxBranchLines) || 40));
    const functions = Array.isArray(options.functions) ? options.functions : [];
    const rules = [], stateTransitions = [];
    const diagnostics = { examinedConditions: 0, unboundedConditions: 0, withoutOutcome: 0, skippedLongBranch: 0 };
    let truncated = false;
    for (const file of files) {
        if (typeof file?.content !== 'string' || !SUPPORTED.has(identifyCodeLanguage(file.path))) continue;
        if (!options.includeTestSources && !isApplicationSource(file.path)) continue;
        const { source, code } = fileLines(file);
        for (let i = 0; i < code.length; i++) {
            if (!GUARD.test(code[i]) || (!COMPARISON.test(code[i]) && !DOMAIN_GUARD.test(code[i]) && !BOOLEAN_PREDICATE.test(code[i]))) continue;
            diagnostics.examinedConditions++;
            const boundary = INDENT_BASED.has(identifyCodeLanguage(file.path)) ? (pythonBody(code,i) || pythonInlineBody(code,i)) : (braceBody(code,i) || sameLineBranch(code,i));
            if (!boundary) { diagnostics.unboundedConditions++; continue; }
            if (boundary.end - i > maxBranchLines) { diagnostics.skippedLongBranch++; continue; }
            // For brace-style conditions, only statements *inside* braces count.
            // `if (x) {} return y` on one line must not be treated as a guard.
            let outcomes = [];
            let transitions = [];
            const candidates = boundary.mode === 'braces'
                ? immediateBraceStatements(code, boundary)
                : Array.from({length:boundary.end-boundary.start+1},(_,at) => ({line:boundary.start+at, statement:code[boundary.start+at]}));
            for (const {line:j, statement:rawStatement, offset = 0} of candidates) {
                let statement = rawStatement;
                let sourceOffset = offset;
                if (boundary.mode === 'inline') { const at = statement.indexOf(')') + 1; statement = statement.slice(at); sourceOffset += at; }
                if (boundary.mode === 'python-inline') { const at = statement.indexOf(':') + 1; statement = statement.slice(at); sourceOffset += at; }
                const match = statement.match(CONTROL);
                if (match) outcomes.push({ line:j+1, kind:OUTCOME_KIND[match[1]], excerpt:source[j].trim().slice(0,180) });
                // Parse status/state updates only if executable assignment syntax
                // exists outside strings/comments; capture constant from source.
                const assignment = /\b([A-Za-z_$][\w$.]*)\.(status|state)\s*=(?!=)/g;
                for (const a of statement.matchAll(assignment)) {
                    const suffix = source[j].slice(sourceOffset + a.index + a[0].length);
                    const value = suffix.match(/^\s*(['"`])([\w.-]{1,90})\1/);
                    if (value) transitions.push({ entity:a[1], property:a[2], to:value[2], file:file.path, line:j+1, evidence:source[j].trim().slice(0,180) });
                }
            }
            if (!outcomes.length && !transitions.length) { diagnostics.withoutOutcome++; continue; }
            if (rules.length >= maxRules) { truncated = true; break; }
            const id = `rule:${file.path}:${i+1}`;
            const owner = ownerOf(functions, file.path, i+1);
            const outcome = outcomes[0] || { line:transitions[0].line, kind:'state-transition', excerpt:transitions[0].evidence };
            // Rank on executable condition tokens, not trailing comments or
            // arbitrary message text. The original condition stays in evidence.
            const relevance = rankRuleContext(code[i].trim(), { ...outcome, excerpt: '' }, transitions);
            const rule = { id, file:file.path, line:i+1, endLine:boundary.end+1,
                condition:source[i].trim().slice(0,220), outcome, outcomes, relevance,
                owner, boundaryMethod:boundary.mode, confidence:'low', provenance:'bounded-branch-with-visible-outcome',
                semantics:'Source-backed conditional branch candidate, not a confirmed business policy or necessarily reached runtime path.' };
            rules.push(rule);
            for (const transition of transitions) stateTransitions.push({ ...transition, ruleId:id, guardLine:i+1, owner });
        }
        if (truncated) break;
    }
    return { schemaVersion:2, status:truncated?'bounded':'complete', rules, stateTransitions, truncated, diagnostics,
        summary:{ candidateRules:rules.length, stateTransitions:stateTransitions.length,
            businessLikely:rules.filter(rule=>rule.relevance.category === 'business-likely').length,
            technicalGuardLikely:rules.filter(rule=>rule.relevance.category === 'technical-guard-likely').length,
            unclassified:rules.filter(rule=>rule.relevance.category === 'unclassified').length,
            ...diagnostics },
        semantics:'Bounded static branch observations. No inferred business intent, actual execution or completeness guarantee.' };
}
