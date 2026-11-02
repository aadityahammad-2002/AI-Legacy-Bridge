/**
 * Language-aware, best-effort maintainability measurements.
 * These measurements are descriptive heuristics; they do not claim compiler
 * cyclomatic complexity, test coverage, or a calibrated maintainability score.
 */
import { Parser } from './parser.js';

const SOURCE_RE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyw|pyi|java|kt|kts|go|c|h|cc|cpp|hpp|cs|scala|swift|rb|php|rs)$/i;
const DEFAULT_THRESHOLDS = Object.freeze({ longFunctionLines: 60, highParameterCount: 5, deepNesting: 4, highEstimatedComplexity: 11, highEstimatedCognitiveComplexity: 12 });

function languageFor(path) {
    const value = String(path || '').toLowerCase();
    if (/\.(?:py|pyw|pyi)$/.test(value)) return 'python';
    if (/\.(?:java|kt|kts|cs|scala|swift|go|c|h|cc|cpp|hpp|rs)$/.test(value)) return 'brace-language';
    return 'javascript';
}

function maskNonCode(source, path) {
    const text = String(source || '');
    const out = text.split('');
    const language = languageFor(path);
    let state = 'code', quote = '', triple = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i], next = text[i + 1], third = text[i + 2];
        if (state === 'line-comment') {
            if (c === '\n') state = 'code'; else out[i] = ' ';
            continue;
        }
        if (state === 'block-comment') {
            if (c === '*' && next === '/') { out[i] = out[i + 1] = ' '; i++; state = 'code'; }
            else if (c !== '\n' && c !== '\r') out[i] = ' ';
            continue;
        }
        if (state === 'string' || state === 'template') {
            if (escaped) { if (c !== '\n' && c !== '\r') out[i] = ' '; escaped = false; continue; }
            if (c === '\\') { if (c !== '\n' && c !== '\r') out[i] = ' '; escaped = true; continue; }
            if (triple && c === quote && next === quote && third === quote) { out[i] = out[i + 1] = out[i + 2] = ' '; i += 2; state = 'code'; triple = false; continue; }
            if (!triple && c === quote) { out[i] = ' '; state = 'code'; continue; }
            if (c !== '\n' && c !== '\r') out[i] = ' ';
            continue;
        }
        if (language === 'python' && c === '#') { out[i] = ' '; state = 'line-comment'; continue; }
        if (language !== 'python' && c === '/' && next === '/') { out[i] = out[i + 1] = ' '; i++; state = 'line-comment'; continue; }
        if (language !== 'python' && c === '/' && next === '*') { out[i] = out[i + 1] = ' '; i++; state = 'block-comment'; continue; }
        if (language === 'python' && ((c === '"' && next === '"' && third === '"') || (c === "'" && next === "'" && third === "'"))) {
            quote = c; triple = true; out[i] = out[i + 1] = out[i + 2] = ' '; i += 2; state = 'string'; continue;
        }
        if (language !== 'python' && c === '`') { quote = '`'; triple = false; out[i] = ' '; state = 'template'; continue; }
        if (c === '"' || c === "'") { quote = c; triple = false; out[i] = ' '; state = 'string'; }
    }
    return out.join('');
}

function splitTopLevel(value, delimiter = ',') {
    const output = [];
    let start = 0, round = 0, square = 0, curly = 0, angle = 0, quote = '', escaped = false;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (quote) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === quote) quote = '';
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '(') round++; else if (c === ')') round = Math.max(0, round - 1);
        else if (c === '[') square++; else if (c === ']') square = Math.max(0, square - 1);
        else if (c === '{') curly++; else if (c === '}') curly = Math.max(0, curly - 1);
        else if (c === '<') angle++; else if (c === '>') angle = Math.max(0, angle - 1);
        else if (c === delimiter && round === 0 && square === 0 && curly === 0 && angle === 0) { output.push(value.slice(start, i)); start = i + 1; }
    }
    output.push(value.slice(start));
    return output.map((item) => item.trim()).filter(Boolean);
}

export function extractParameterList(sourceSpan, fn, path) {
    const simple = String(fn?.name || '').split('.').pop();
    if (!simple) return null;
    const language = languageFor(path);
    const escaped = simple.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let match;
    if (language === 'python') {
        match = sourceSpan.match(new RegExp(`\\b(?:async\\s+)?def\\s+${escaped}\\s*\\(([\\s\\S]*?)\\)\\s*(?:->\\s*[^:]+)?\\s*:`, 'm'));
    } else if (language === 'brace-language') {
        match = sourceSpan.match(new RegExp(`\\b${escaped}\\s*\\(([\\s\\S]*?)\\)\\s*(?:throws\\s+[\\w., ]+)?\\s*(?:\\{|;|$)`, 'm'));
        // Avoid interpreting a plain call expression as a declaration unless parser metadata says method/constructor.
        if (match && !['method', 'constructor'].includes(String(fn?.type || '').toLowerCase()) && fn?.isClassMethod !== true) match = null;
    } else {
        const patterns = [
            new RegExp(`\\bfunction\\s*\\*?\\s*${escaped}\\s*\\(([\\s\\S]*?)\\)`, 'm'),
            new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?\\(([\\s\\S]*?)\\)\\s*(?::\\s*[^=\\n]+)?(?:=>|\\{)`, 'm'),
            new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?([A-Za-z_$][\\w$]*)\\s*(?::\\s*[^=\\n]+)?=>`, 'm'),
            new RegExp(`\\b${escaped}\\s*\\(([\\s\\S]*?)\\)\\s*\\{`, 'm'),
        ];
        for (const pattern of patterns) { match = sourceSpan.match(pattern); if (match) break; }
    }
    if (!match) return null;
    const raw = match[1] || match[2] || '';
    const parameters = splitTopLevel(raw).map((parameter) => {
        const noDefault = splitTopLevel(parameter, '=')[0] || parameter;
        if (language === 'python') return noDefault.replace(/^\s*(?:\*{1,2})?\s*/, '').split(':')[0].trim();
        if (language === 'brace-language') {
            const withoutAnnotations = noDefault.replace(/@[\w$.]+(?:\([^)]*\))?\s*/g, '').trim();
            const matchName = withoutAnnotations.match(/([A-Za-z_$][\w$]*)\s*(?:\[\])?\s*$/);
            return matchName?.[1] || withoutAnnotations;
        }
        const withoutAccess = noDefault.replace(/^\s*(?:\.\.\.)?\s*/, '').trim();
        if (withoutAccess.startsWith('{') || withoutAccess.startsWith('[')) return withoutAccess;
        return (withoutAccess.split(':')[0] || '').trim();
    }).filter(Boolean);
    return { count: parameters.length, names: parameters, evidence: 'heuristic-signature-parse' };
}

function countNesting(masked, language) {
    if (language === 'python') {
        const nonBlank = String(masked || '').split('\n').filter((line) => line.trim());
        if (!nonBlank.length) return 0;
        const indentation = (line) => (line.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '    ').length;
        const baseIndent = indentation(nonBlank[0]);
        let max = 0;
        for (const line of nonBlank) {
            const trimmed = line.trim();
            if (!/^(?:if|elif|else|for|while|try|except|finally|with|match|case)\b/.test(trimmed)) continue;
            // Function/class declaration indentation is a baseline, not a
            // control-flow nesting level. A first branch inside a method is 1.
            const relative = Math.max(0, indentation(line) - baseIndent);
            max = Math.max(max, Math.max(1, Math.floor(relative / 4)));
        }
        return max;
    }
    // Count explicit control-flow blocks, not every brace. Object literals,
    // class bodies and function bodies otherwise inflate this metric.
    let max = 0;
    const controlBlocks = [];
    for (let index = 0; index < masked.length; index++) {
        const c = masked[index];
        if (c === '{') {
            const previousOpen = Math.max(masked.lastIndexOf('{', index - 1), masked.lastIndexOf('}', index - 1));
            // Keep newlines between a multi-line condition and its opening brace.
            const prefix = masked.slice(previousOpen + 1, index).trim();
            const isControl = /\b(?:if|for|while|switch|catch)\s*\([^{}]*\)\s*$/.test(prefix) || /\b(?:else|try|finally|do)\s*$/.test(prefix);
            controlBlocks.push(isControl);
            if (isControl) max = Math.max(max, controlBlocks.filter(Boolean).length);
        } else if (c === '}') {
            if (controlBlocks.length) controlBlocks.pop();
        }
    }
    return max;
}

function countBranchSignals(masked, language) {
    const patterns = language === 'python'
        ? [/\b(?:if|elif|while|for|except|case)\b/g, /\b(?:and|or)\b/g]
        : [/\bif\s*\(/g, /\bfor\s*\(/g, /\bwhile\s*\(/g, /\bcatch\s*\(/g, /\bcase\b/g, /&&/g, /\|\|/g, /\?\?(?![=])/g, /(?<!\?)\?(?![?.])/g];
    return patterns.reduce((sum, pattern) => sum + (masked.match(pattern) || []).length, 0);
}

function estimateCognitiveComplexity(masked, language) {
    const lines = String(masked || '').split('\n');
    if (language === 'python') {
        let total = 0;
        const nestingStack = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const indent = (line.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '    ').length;
            while (nestingStack.length && nestingStack[nestingStack.length - 1] >= indent) nestingStack.pop();
            const branches = (trimmed.match(/^(?:if|elif|for|while|except|case|match)\b/g) || []).length;
            if (branches) total += branches * (1 + nestingStack.length);
            total += (trimmed.match(/\b(?:and|or)\b/g) || []).length;
            if (/^(?:if|elif|for|while|try|except|with|match|case)\b/.test(trimmed)) nestingStack.push(indent);
        }
        return total;
    }
    let depth = 0, total = 0;
    for (const line of lines) {
        const before = depth;
        const patterns = [/\bif\s*\(/g, /\bfor\s*\(/g, /\bwhile\s*\(/g, /\bcatch\s*\(/g, /\bcase\b/g];
        for (const pattern of patterns) total += (line.match(pattern) || []).length * (1 + Math.max(0, before - 1));
        total += (line.match(/&&|\|\||\?\?(?![=])/g) || []).length;
        for (const c of line) {
            if (c === '{') depth++;
            else if (c === '}') depth = Math.max(0, depth - 1);
        }
    }
    return total;
}

export function buildMaintainabilityMetrics(files = [], functions = [], options = {}) {
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    const byPath = new Map(files.map((file) => [file.path, file]));
    const perFunction = [];
    const skipped = [];
    const byLanguage = Object.create(null);
    for (const fn of functions) {
        const file = byPath.get(fn?.file);
        if (!file || typeof file.content !== 'string' || !SOURCE_RE.test(file.path)) { skipped.push({ file: fn?.file || null, name: fn?.name || null, reason: 'unsupported-or-missing-source' }); continue; }
        const lines = file.content.split('\n');
        const start = Number(fn.line), end = Number(fn.endLine ?? fn.line);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length || fn.endLineConfidence === 'declaration-line-only') {
            skipped.push({ file: fn.file, name: fn.name, line: start || null, reason: 'unreliable-source-span' }); continue;
        }
        const source = lines.slice(start - 1, end).join('\n');
        const language = languageFor(file.path);
        const masked = maskNonCode(source, file.path);
        const nonBlankLines = masked.split('\n').filter((line) => line.trim()).length;
        const parameters = extractParameterList(source, fn, file.path);
        const branchSignals = countBranchSignals(masked, language);
        const nestingDepth = countNesting(masked, language);
        const estimatedCognitiveComplexity = estimateCognitiveComplexity(masked, language);
        const returnCount = language === 'python'
            ? (masked.match(/^\s*return\b/gm) || []).length
            : (masked.match(/\breturn\b/g) || []).length;
        let estimatedComplexity = null;
        try { const result = Parser.calcComplexity(source, file.path); if (Number.isFinite(result?.score)) estimatedComplexity = result.score; } catch { /* optional metric */ }
        const findings = [];
        if (nonBlankLines > thresholds.longFunctionLines) findings.push({ ruleId: 'maintainability.long-function', severity: 'medium', threshold: thresholds.longFunctionLines, observed: nonBlankLines });
        if (parameters && parameters.count > thresholds.highParameterCount) findings.push({ ruleId: 'maintainability.high-parameter-count', severity: 'low', threshold: thresholds.highParameterCount, observed: parameters.count });
        if (nestingDepth > thresholds.deepNesting) findings.push({ ruleId: 'maintainability.deep-nesting', severity: 'medium', threshold: thresholds.deepNesting, observed: nestingDepth });
        if (estimatedComplexity !== null && estimatedComplexity >= thresholds.highEstimatedComplexity) findings.push({ ruleId: 'maintainability.high-estimated-complexity', severity: 'medium', threshold: thresholds.highEstimatedComplexity, observed: estimatedComplexity });
        if (estimatedCognitiveComplexity >= thresholds.highEstimatedCognitiveComplexity) findings.push({ ruleId: 'maintainability.high-estimated-cognitive-complexity', severity: 'medium', threshold: thresholds.highEstimatedCognitiveComplexity, observed: estimatedCognitiveComplexity });
        perFunction.push({
            key: `${fn.file}|${start}|${fn.name}`, name: fn.name, file: fn.file, startLine: start, endLine: end,
            sourceLines: end - start + 1, nonBlankLines, parameterCount: parameters?.count ?? null,
            parameterNames: parameters?.names || null, parameterCountStatus: parameters ? 'estimated' : 'unknown',
            returnCount, nestingDepth, branchSignals, estimatedComplexity, estimatedCognitiveComplexity,
            confidence: 'heuristic', findings,
            evidence: { path: fn.file, startLine: start, endLine: end, excerpt: lines.slice(start - 1, Math.min(end, start + 5)).join('\n').slice(0, 500) },
        });
        const bucket = byLanguage[language] || { functions: 0, totalLines: 0, parameterCountsKnown: 0, averageLines: 0, maxNestingDepth: 0 };
        bucket.functions += 1; bucket.totalLines += nonBlankLines; bucket.parameterCountsKnown += parameters ? 1 : 0; bucket.maxNestingDepth = Math.max(bucket.maxNestingDepth, nestingDepth); byLanguage[language] = bucket;
    }
    Object.values(byLanguage).forEach((bucket) => { bucket.averageLines = Math.round(bucket.totalLines / Math.max(1, bucket.functions) * 100) / 100; });
    const findings = perFunction.flatMap((item) => item.findings.map((finding) => ({ ...finding, functionKey: item.key, name: item.name, file: item.file, line: item.startLine, endLine: item.endLine, confidence: 'low-to-medium', evidence: item.evidence })));
    return {
        schemaVersion: 1, status: skipped.length ? 'partial' : functions.length === 0 ? 'skipped' : 'complete',
        semantics: 'Descriptive maintainability signals derived from source spans. Complexity and cognitive-complexity estimates are syntax-light heuristics, not compiler-derived metrics or a calibrated maintainability index. Unknown parameter counts remain unknown rather than treated as zero.',
        thresholds, totalFunctions: functions.length, analyzedFunctions: perFunction.length, skippedFunctions: skipped.length,
        coveragePct: functions.length ? Math.round(perFunction.length / functions.length * 1000) / 10 : null,
        byLanguage, summary: {
            longFunctions: findings.filter((item) => item.ruleId === 'maintainability.long-function').length,
            highParameterCount: findings.filter((item) => item.ruleId === 'maintainability.high-parameter-count').length,
            deepNesting: findings.filter((item) => item.ruleId === 'maintainability.deep-nesting').length,
            highEstimatedComplexity: findings.filter((item) => item.ruleId === 'maintainability.high-estimated-complexity').length,
            highEstimatedCognitiveComplexity: findings.filter((item) => item.ruleId === 'maintainability.high-estimated-cognitive-complexity').length,
        },
        findings: findings.slice(0, 1000),
        topLongFunctions: [...perFunction].sort((a, b) => b.nonBlankLines - a.nonBlankLines).slice(0, 50),
        topNestedFunctions: [...perFunction].sort((a, b) => b.nestingDepth - a.nestingDepth).slice(0, 50),
        functions: perFunction.slice(0, 5000), skipped: skipped.slice(0, 500),
    };
}
