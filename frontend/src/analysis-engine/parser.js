import { extractLoadedTreeSitterFunctions } from './languageAst.js';
import { extractLanguageFunctions, identifyCodeLanguage, maskLanguageNonCode, isLikelyJavaDeclaration } from './languageIntelligence.js';
/*
 * This analysis engine (function/class extraction, import
 * resolution, call-graph building, pattern/duplicate/security detection,
 * complexity + health scoring) with UI/React app stripped out.
 * It runs entirely in the browser — no repository content ever leaves the
 * client during analysis itself; only the final structured JSON result is
 * sent to our backend (see orchestrator.js).
 *
 * Dependencies (loaded as browser globals — see index.html / vite config):
 *   - acorn (AST parser for JS/TS)
 *   - @babel/standalone as window.Babel (JSX + TypeScript transform)
 * Both are optional at runtime: if absent, extraction falls back to the
 * regex-based extractors below (extractWithRegex / extractOtherLanguages),
 * which is how Java, Go, Rust, and most non-JS languages are handled anyway.
 */

/**
 * Masks comments while preserving source strings and line offsets. The security
 * scanner pairs this with maskSourceNonCode() so value-aware secret checks can
 * inspect literal values while executable-code rules ignore strings/comments.
 */
function maskSourceComments(content, filename) {
    const source = String(content || '');
    const ext = String(filename || '').toLowerCase().split('.').pop();
    const isPython = ['py', 'pyw', 'pyi'].includes(ext);
    const isVba = ['vba', 'bas', 'cls', 'vb'].includes(ext);
    const output = source.split('');
    let state = 'code';
    let quote = '';
    let triple = false;
    for (let i = 0; i < source.length;) {
        const c = source[i], next = source[i + 1], third = source[i + 2];
        if (state === 'line-comment') {
            if (c === '\n') state = 'code'; else output[i] = ' ';
            i++; continue;
        }
        if (state === 'block-comment') {
            if (c === '*' && next === '/') { output[i] = ' '; output[i + 1] = ' '; i += 2; state = 'code'; }
            else { if (c !== '\n') output[i] = ' '; i++; }
            continue;
        }
        if (state === 'string') {
            if (c === '\\') { i += Math.min(2, source.length - i); continue; }
            if (triple && c === quote && next === quote && third === quote) { i += 3; state = 'code'; triple = false; continue; }
            if (!triple && c === quote) state = 'code';
            i++; continue;
        }
        if (isPython && c === '#') { output[i] = ' '; state = 'line-comment'; i++; continue; }
        if (isVba && c === "'") { output[i] = ' '; state = 'line-comment'; i++; continue; }
        if (!isPython && !isVba && c === '/' && next === '/') { output[i] = ' '; output[i + 1] = ' '; state = 'line-comment'; i += 2; continue; }
        if (!isPython && !isVba && c === '/' && next === '*') { output[i] = ' '; output[i + 1] = ' '; state = 'block-comment'; i += 2; continue; }
        if (isPython && ((c === '"' && next === '"' && third === '"') || (c === "'" && next === "'" && third === "'"))) { quote = c; triple = true; state = 'string'; i += 3; continue; }
        if (c === '"' || c === "'" || (!isPython && !isVba && c === '`')) { quote = c; triple = false; state = 'string'; i++; continue; }
        i++;
    }
    return output.join('');
}

function maskSourceNonCode(content, filename) {
    const source = String(content || '');
    const ext = String(filename || '').toLowerCase().split('.').pop();
    const isPython = ['py', 'pyw', 'pyi'].includes(ext);
    const isVba = ['vba', 'bas', 'cls', 'vb'].includes(ext);
    const isJsLike = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte'].includes(ext);
    const output = source.split('');
    const templates = [];
    let state = 'code';
    let quote = '';
    let triple = false;

    const mask = (index) => {
        if (index >= 0 && index < output.length && source[index] !== '\n' && source[index] !== '\r') output[index] = ' ';
    };

    for (let i = 0; i < source.length;) {
        const c = source[i], next = source[i + 1], third = source[i + 2];

        if (state === 'line-comment') {
            if (c === '\n' || c === '\r') state = 'code';
            else mask(i);
            i++;
            continue;
        }
        if (state === 'block-comment') {
            if (c === '*' && next === '/') {
                mask(i); mask(i + 1); i += 2; state = 'code';
            } else { mask(i); i++; }
            continue;
        }
        if (state === 'string') {
            if (c === '\\') { mask(i); mask(i + 1); i += Math.min(2, source.length - i); continue; }
            if (triple && c === quote && next === quote && third === quote) {
                mask(i); mask(i + 1); mask(i + 2); i += 3; state = 'code'; triple = false; continue;
            }
            if (!triple && c === quote) { mask(i); i++; state = 'code'; continue; }
            mask(i); i++; continue;
        }
        if (state === 'template') {
            if (c === '\\') { mask(i); mask(i + 1); i += Math.min(2, source.length - i); continue; }
            if (c === '`') {
                mask(i); i++; templates.pop(); state = 'code'; continue;
            }
            if (c === '$' && next === '{') {
                mask(i); mask(i + 1);
                const frame = templates[templates.length - 1];
                if (frame) { frame.inExpression = true; frame.braceDepth = 1; }
                i += 2; state = 'code'; continue;
            }
            mask(i); i++; continue;
        }

        // Inside ${...}, count braces but preserve real expression code.
        const frame = templates[templates.length - 1];
        if (frame?.inExpression) {
            if (c === '{') frame.braceDepth++;
            else if (c === '}') {
                frame.braceDepth--;
                if (frame.braceDepth === 0) {
                    mask(i); i++; frame.inExpression = false; state = 'template'; continue;
                }
            }
        }

        if (isPython && c === '#') { mask(i); state = 'line-comment'; i++; continue; }
        if (isVba && c === "'") { mask(i); state = 'line-comment'; i++; continue; }
        if (!isPython && !isVba && c === '/' && next === '/') { mask(i); mask(i + 1); state = 'line-comment'; i += 2; continue; }
        if (!isPython && !isVba && c === '/' && next === '*') { mask(i); mask(i + 1); state = 'block-comment'; i += 2; continue; }

        if (isPython && ((c === '"' && next === '"' && third === '"') || (c === "'" && next === "'" && third === "'"))) {
            quote = c; triple = true; mask(i); mask(i + 1); mask(i + 2); state = 'string'; i += 3; continue;
        }
        if (isJsLike && c === '`') {
            mask(i); templates.push({ inExpression: false, braceDepth: 0 }); state = 'template'; i++; continue;
        }
        if (c === '"' || c === "'" || (!isJsLike && !isPython && !isVba && c === '`')) { quote = c; triple = false; mask(i); state = 'string'; i++; continue; }
        i++;
    }
    return output.join('');
}

/**
 * Security-only lexical cleanup. The general extractors retain their existing
 * masks; these two extra masks prevent executable-code heuristics from treating
 * JavaScript regex source or literal JSX documentation as executable calls.
 * All replacements preserve character offsets/newlines for evidence lines.
 */
function maskSecurityRegExpLiterals(source, codeMask, filename) {
    if (!/\.(?:js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/i.test(filename || '')) return codeMask;
    const out = codeMask.split('');
    const blank = (i) => { if (source[i] !== '\n' && source[i] !== '\r') out[i] = ' '; };
    for (let i = 0; i < source.length; i++) {
        if (source[i] !== '/' || out[i] !== '/' || source[i + 1] === '/' || source[i + 1] === '*') continue;
        // Regex is an expression value, unlike division or path-like operators.
        let prev = i - 1;
        while (prev >= 0 && /\s/.test(codeMask[prev])) prev--;
        const prevChar = prev >= 0 ? codeMask[prev] : '';
        const before = codeMask.slice(Math.max(0, prev - 16), prev + 1);
        if (!/[=(:,\[!{;?&|]/.test(prevChar) && !/(?:\breturn|\bthrow|\bcase|\btypeof|\binstanceof|=>)$/.test(before)) continue;
        let j = i + 1, escaped = false, charClass = false;
        for (; j < source.length && source[j] !== '\n' && source[j] !== '\r'; j++) {
            const c = source[j];
            if (escaped) { escaped = false; continue; }
            if (c === '\\') { escaped = true; continue; }
            if (c === '[') { charClass = true; continue; }
            if (c === ']' && charClass) { charClass = false; continue; }
            if (c === '/' && !charClass) break;
        }
        if (j >= source.length || source[j] !== '/' || j === i + 1) continue;
        let end = j + 1;
        while (end < source.length && /[dgimsuvy]/.test(source[end])) end++;
        for (let k = i; k < end; k++) blank(k);
        i = end - 1;
    }
    return out.join('');
}

function maskSecurityJsxLiteralText(codeMask, filename) {
    if (!/\.(?:jsx|tsx)$/i.test(filename || '')) return codeMask;
    // A JSX text node can contain words such as eval(), but it is not JS.
    // Curly-braced JSX expressions are deliberately excluded from this mask.
    return codeMask.replace(/(<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\s*>)([^<>{}]+)(?=<)/g,
        (match, tag, text) => tag + text.replace(/[^\n\r]/g, ' '));
}

function isValidationErrorLiteralAssignment(line, match, value) {
    const lhs = line.slice(0, match.index).trim();
    const isErrorsReceiver = /(?:^|\W)(?:errors?|errs?|validationErrors?|fieldErrors?|formErrors?)\s*\.\s*[A-Za-z_$]*$/i.test(lhs) ||
        /(?:^|\W)(?:errors?|errs?|validationErrors?|fieldErrors?|formErrors?)\s*\[\s*['"][^'"]+['"]\s*\]\s*$/i.test(lhs);
    const diagnostic = /^(?:required\b|password\s+(?:is|must|does|should|cannot|can't|too|needs)|passwords?\s+do\s+not|(?:current|new|confirm)\s+password\s+(?:is|must)|min(?:imum)?\s+\d+\s+characters?|please\s+(?:enter|provide)|must\s+be|at\s+least|invalid\s+(?:password|input)|does\s+not\s+match|cannot\s+be\s+empty)/i.test(value);
    const inlineIf = /^\s*if\s*\(.*\)\s*[A-Za-z_$][\w$]*\.\s*$/i.test(lhs);
    // Error bags store human-readable messages; the `e.password = ...` shape
    // also occurs in one-line conditional validation blocks.
    return diagnostic && (isErrorsReceiver || inlineIf);
}

/**
 * Bounded brace-based end-line estimate used only by regex extractors.
 * AST-backed extractors remain authoritative when available. If a block body
 * cannot be identified, return the declaration line rather than inventing a
 * broad range that could attribute unrelated calls to the function.
 */
function estimateBracedEndLine(content, startLine, functionName, kind, filename) {
    const source = String(content || '');
    const lines = source.split('\n');
    if (!Number.isFinite(startLine) || startLine < 1 || startLine > lines.length) return startLine;
    const masked = maskSourceNonCode(source, filename || '');
    const maskedLines = masked.split('\n');
    const lineStart = maskedLines.slice(0, startLine - 1).reduce((total, line) => total + line.length + 1, 0);
    const lineEnd = masked.indexOf('\n', lineStart);
    const declarationLine = masked.slice(lineStart, lineEnd < 0 ? masked.length : lineEnd);
    const escaped = String(functionName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameMatch = new RegExp('\\b' + escaped + '\\b').exec(declarationLine);
    if (!nameMatch) return startLine;

    let bodySearchStart = -1;
    if (kind === 'arrow') {
        const arrowIndex = declarationLine.indexOf('=>', nameMatch.index + nameMatch[0].length);
        if (arrowIndex < 0) return startLine;
        let candidate = lineStart + arrowIndex + 2;
        while (candidate < masked.length && /\s/.test(masked[candidate])) candidate++;
        // Expression-bodied arrows are intentionally bounded to the declaration line.
        if (masked[candidate] !== '{') return startLine;
        bodySearchStart = candidate;
    } else {
        let signatureStart = lineStart + nameMatch.index;
        if (kind === 'function') {
            const functionKeyword = declarationLine.indexOf('function');
            if (functionKeyword >= 0) signatureStart = lineStart + functionKeyword + 'function'.length;
        }
        const openParen = masked.indexOf('(', signatureStart);
        if (openParen < 0) return startLine;
        let depth = 0;
        let closeParen = -1;
        for (let i = openParen; i < masked.length; i++) {
            if (masked[i] === '(') depth++;
            else if (masked[i] === ')') {
                depth--;
                if (depth === 0) { closeParen = i; break; }
            }
            // Avoid wandering into an unrelated function if a signature is malformed.
            if (i - openParen > 2000) break;
        }
        if (closeParen < 0) return startLine;
        let candidate = closeParen + 1;
        const maxSearch = Math.min(masked.length, candidate + 2000);
        while (candidate < maxSearch) {
            const char = masked[candidate];
            if (char === '{') { bodySearchStart = candidate; break; }
            if (char === ';') return startLine;
            candidate++;
        }
        if (bodySearchStart < 0) return startLine;
    }

    let braceDepth = 0;
    for (let i = bodySearchStart; i < masked.length; i++) {
        if (masked[i] === '{') braceDepth++;
        else if (masked[i] === '}') {
            braceDepth--;
            if (braceDepth === 0) return masked.slice(0, i).split('\n').length;
        }
        if (i - bodySearchStart > 250000) break;
    }
    return startLine;
}

function getSecurityScanContent(file) {
    return file && file.content ? maskSourceComments(file.content, file.path || file.name || '') : '';
}

function isVerifiedEscapedSyntaxRenderer(file, files) {
    const source = String(file?.content || '');
    // A generic sanitizer name is not evidence. Require the exact producer,
    // mapping and sink relationship, plus inspect the imported implementation.
    const importMatch = source.match(/import\s*\{\s*highlightSyntax\s*\}\s*from\s*['"](\.[^'"]+)['"]/);
    const htmlSinks = source.match(/dangerouslySetInnerHTML\b/g) || [];
    // Do not suppress a second, unrelated sink in the same component file.
    if (htmlSinks.length !== 1 || !importMatch ||
        !/\bconst\s+lines\s*=\s*file\s*\?\s*highlightSyntax\s*\(\s*file\.content\s*,\s*path\s*\)\s*:\s*\[\s*\]/.test(source) ||
        !/\blines\.map\s*\(\s*\(\s*html\b/.test(source) ||
        !/dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*html\s*\}\}/.test(source)) return false;
    const dir = String(file.path || '').split('/').slice(0,-1).join('/');
    const segments = (dir ? dir+'/' : '') + importMatch[1];
    const normalized = [];
    for (const segment of segments.split('/')) {
        if (segment === '..') normalized.pop();
        else if (segment && segment !== '.') normalized.push(segment);
    }
    const modulePath = normalized.join('/');
    const producer = (files || []).find(item => item.path === modulePath);
    if (!producer) return false;
    const body = String(producer.content || '');
    if (!/export\s+function\s+highlightSyntax\s*\(/.test(body) ||
        !/return\s+code\.split\s*\(\s*['"]\\n['"]\s*\)\.map\s*\(\s*\(?\s*line\b/.test(body) ||
        !/\b(?:let|const)\s+escaped\s*=\s*esc\(line\)/.test(body) ||
        !/return\s+escaped\s*;/.test(body)) return false;
    const escMatch = body.match(/function\s+esc\s*\(\s*s\s*\)\s*\{([\s\S]*?)\}/);
    if (!escMatch) return false;
    const esc = escMatch[1];
    return /s\.replace\(\s*\/\&\/g\s*,\s*['"]&amp;['"]\)/.test(esc) &&
        /\.replace\(\s*\/\<\/g\s*,\s*['"]&lt;['"]\)/.test(esc) &&
        /\.replace\(\s*\/\>\/g\s*,\s*['"]&gt;['"]\)/.test(esc);
}

function isSanitizedPreviewRenderer(content){
    content = content || '';
    return content.includes("function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}") &&
           content.includes("var escaped=esc(line);") &&
           content.includes("dangerouslySetInnerHTML:{__html:lineHtml||' '}");
}

/** Yields to the browser event loop between analysis batches so the UI stays responsive on large repos. */
function yieldToBrowser(){
    if(typeof scheduler!=='undefined'&&scheduler.yield){
        return scheduler.yield();
    }
    if(typeof MessageChannel!=='undefined'){
        return new Promise(function(resolve){
            var channel=new MessageChannel();
            channel.port1.onmessage=function(){
                channel.port1.close();
                channel.port2.close();
                resolve();
            };
            channel.port2.postMessage(0);
        });
    }
    return new Promise(function(resolve){setTimeout(resolve,0);});
}

function isArchitectureTestFile(path){
    var p=String(path||'').toLowerCase().replace(/\\/g,'/');
    return /(^|\/)tests?\//.test(p)||/(^|\/)__tests__(\/|$)/.test(p)||/\.test\.(js|jsx|ts|tsx|mjs|cjs)$/.test(p)||/\.spec\.(js|jsx|ts|tsx|mjs|cjs)$/.test(p)||/\.smoke\.(js|mjs|cjs)$/.test(p);
}

function isArchitectureFixtureFile(path){
    var p=String(path||'').toLowerCase().replace(/\\/g,'/');
    return /(^|\/)fixtures(\/|$)/.test(p)||/(^|\/)__fixtures__(\/|$)/.test(p);
}

function isDocumentationPath(path){
    var p=String(path||'').toLowerCase().replace(/\\/g,'/');
    if(/(^|\/)docs?(\/|$)/.test(p))return true;
    if(/\.(md|markdown|mdx)$/.test(p))return true;
    return false;
}

function isDevToolingPath(path){
    var p=String(path||'').toLowerCase().replace(/\\/g,'/');
    if(/(^|\/)\.github(\/|$)/.test(p))return true;
    if(/(^|\/)\.claude(\/|$)/.test(p))return true;
    if(/(^|\/)(scripts|tools|tooling)(\/|$)/.test(p))return true;
    return false;
}

function isNonProductionPath(path){
    var p=String(path||'').toLowerCase().replace(/\\/g,'/');
    if(isSecretScanExemptPath(p))return true;
    if(isDevToolingPath(p))return true;
    return false;
}

function isSecretScanExemptPath(path){
    var p=String(path||'').toLowerCase().replace(/\\/g,'/');
    if(isArchitectureTestFile(p))return true;
    if(/(^|\/)benchmarks?(\/|$)|(^|\/)__mocks__(\/|$)/.test(p))return true;
    if(isArchitectureFixtureFile(p))return true;
    if(isDocumentationPath(p))return true;
    return false;
}

function isPlaceholderSecretValue(matchText){
    var value=String(matchText||'').replace(/^[^=:]*[=:]\s*/, '').trim().replace(/^['"`]|['"`]$/g,'').toLowerCase();
    return /^(?:changeme|change-me|change_me|example|sample|placeholder|your[-_ ]?(?:api[-_ ]?)?key|your[-_ ]?token|dummy|redacted|replace[-_ ]?me|todo|xxx+|\*{3,}|<[^>]+>)$/.test(value) || /^(?:password|pass|secret|user|username):(password|pass|example|changeme|placeholder)@/.test(value);
}

function normalizeArchitecturePath(value){
    return (value||'').replace(/\\/g,'/').replace(/^\/+/,'').replace(/\/{2,}/g,'/');
}

function isArchitectureBackendPath(path){
    var p=normalizeArchitecturePath(path).toLowerCase();
    if(/(^|\/)(a-)?backend(\/|$)/.test(p))return true;
    if(/(^|\/)server(\/|$)/.test(p))return true;
    if(/(^|\/)workers?(\/|$)/.test(p))return true;
    if(/(^|\/)functions(\/|$)/.test(p))return true;
    if(/(^|\/)lambda(\/|$)/.test(p))return true;
    if(/^src\/app\/api\//.test(p))return false;
    var segments=p.split('/').filter(Boolean);
    for(var i=0;i<segments.length;i++){
        var seg=segments[i];
        if(seg==='middleware'||seg==='controllers'||seg==='handlers')return true;
        if(seg==='routes'||seg==='services'){
            if(i===0)return true;
            var prev=segments[i-1];
            if(prev==='backend'||prev==='a-backend'||prev==='server'||prev==='api')return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Synthetic accessor extraction — additive pass for annotation/keyword-
// generated methods (Lombok, Kotlin/Scala data classes, Ruby attr_*,
// Python @dataclass). Never removes or replaces anything extract() already
// found; only appends extra function entries so call-graph/impact-analysis
// can "see" methods that exist only after compilation/codegen.
// ---------------------------------------------------------------------------

function extractSyntheticAccessors(content, filename, addFn, extractCode) {
    var ext = filename.toLowerCase();
    var lines = content.split('\n');

    if (/\.java$/.test(ext)) {
        extractLombokAccessors(content, filename, lines, addFn, extractCode);
    } else if (/\.kts?$/.test(ext)) {
        extractKotlinDataClassMembers(content, filename, lines, addFn, extractCode);
    } else if (/\.scala$/.test(ext)) {
        extractScalaCaseClassMembers(content, filename, lines, addFn, extractCode);
    } else if (/\.rb$/.test(ext)) {
        extractRubyAttrAccessors(content, filename, lines, addFn, extractCode);
    } else if (/\.pyw?$/.test(ext)) {
        extractPythonDataclassMembers(content, filename, lines, addFn, extractCode);
    }
}

// ---- Java: Lombok @Getter/@Setter/@Data ----
function extractLombokAccessors(content, filename, lines, addFn, extractCode) {
    var classAnnotations = [];
    var pendingAnnotations = [];
    var inClass = false;
    var className = null;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var trimmed = line.trim();

        var annMatch = trimmed.match(/^@(\w+)/);
        if (annMatch) {
            pendingAnnotations.push(annMatch[1]);
            continue;
        }

        var classMatch = line.match(/^\s*(?:public|private|protected)?\s*(?:abstract\s+|final\s+)*class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
        if (classMatch) {
            className = classMatch[1];
            classAnnotations = pendingAnnotations.slice();
            pendingAnnotations = [];
            inClass = true;
            continue;
        }

        if (trimmed !== '') pendingAnnotations = [];
        if (!inClass) continue;

        var hasGetter = classAnnotations.indexOf('Getter') >= 0 || classAnnotations.indexOf('Data') >= 0 || classAnnotations.indexOf('Value') >= 0;
        var hasSetter = classAnnotations.indexOf('Setter') >= 0 || classAnnotations.indexOf('Data') >= 0;
        if (!hasGetter && !hasSetter) continue;

        // Require a real type token before the field name. Previously the
        // leading whitespace alone could satisfy the "type" section,
        // causing @JoinTable(joinColumns = ...) to invent Lombok accessors.
        var fieldMatch = line.match(/^\s*(?:(?:private|protected|public|static|final|transient|volatile)\s+)*(?:[\w$<>?,.\[\]]+\s+)+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=|;)/);
        var isDeclarationKeyword = /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum|@)/.test(line);
        if (fieldMatch && !isDeclarationKeyword) {
            var fieldName = fieldMatch[1];
            var isBoolField = /\bboolean\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*(?:=|;)/.test(line);
            var cap = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
            var lineNum = i + 1;

            if (hasGetter) {
                addFn({
                    name: (isBoolField ? 'is' : 'get') + cap, file: filename, line: lineNum,
                    code: extractCode(lineNum, lineNum), isTopLevel: false, isExported: true,
                    isClassMethod: true, type: 'method', className: className, isSynthetic: true,
                });
            }
            if (hasSetter) {
                addFn({
                    name: 'set' + cap, file: filename, line: lineNum,
                    code: extractCode(lineNum, lineNum), isTopLevel: false, isExported: true,
                    isClassMethod: true, type: 'method', className: className, isSynthetic: true,
                });
            }
        }
    }
}

// ---- Kotlin: data class ----
function extractKotlinDataClassMembers(content, filename, lines, addFn, extractCode) {
    lines.forEach(function (line, idx) {
        var m = line.match(/\bdata\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/);
        if (!m) return;
        var className = m[1];
        var lineNum = idx + 1;

        ['equals', 'hashCode', 'toString', 'copy'].forEach(function (name) {
            addFn({
                name: name, file: filename, line: lineNum, code: extractCode(lineNum, lineNum),
                isTopLevel: false, isExported: true, isClassMethod: true,
                type: 'method', className: className, isSynthetic: true,
            });
        });

        (m[2] || '').split(',').forEach(function (param) {
            var pm = param.trim().match(/^(?:val|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
            if (!pm) return;
            var prop = pm[1];
            addFn({
                name: 'get' + prop.charAt(0).toUpperCase() + prop.slice(1), file: filename, line: lineNum,
                code: extractCode(lineNum, lineNum), isTopLevel: false, isExported: true,
                isClassMethod: true, type: 'method', className: className, isSynthetic: true,
            });
        });
    });
}

// ---- Scala: case class ----
function extractScalaCaseClassMembers(content, filename, lines, addFn, extractCode) {
    lines.forEach(function (line, idx) {
        var m = line.match(/\bcase\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/);
        if (!m) return;
        var className = m[1];
        var lineNum = idx + 1;
        ['equals', 'hashCode', 'toString', 'copy', 'unapply'].forEach(function (name) {
            addFn({
                name: name, file: filename, line: lineNum, code: extractCode(lineNum, lineNum),
                isTopLevel: false, isExported: true, isClassMethod: true,
                type: 'method', className: className, isSynthetic: true,
            });
        });
    });
}

// ---- Ruby: attr_accessor / attr_reader / attr_writer ----
function extractRubyAttrAccessors(content, filename, lines, addFn, extractCode) {
    lines.forEach(function (line, idx) {
        var m = line.match(/^\s*(attr_accessor|attr_reader|attr_writer)\s+(.+)$/);
        if (!m) return;
        var kind = m[1];
        var lineNum = idx + 1;
        var symbols = m[2].match(/:([a-zA-Z_][a-zA-Z0-9_]*[?!]?)/g) || [];
        symbols.forEach(function (sym) {
            var name = sym.slice(1);
            if (kind === 'attr_accessor' || kind === 'attr_reader') {
                addFn({
                    name: name, file: filename, line: lineNum, code: extractCode(lineNum, lineNum),
                    isTopLevel: true, isExported: true, type: 'method', isSynthetic: true,
                });
            }
            if (kind === 'attr_accessor' || kind === 'attr_writer') {
                addFn({
                    name: name + '=', file: filename, line: lineNum, code: extractCode(lineNum, lineNum),
                    isTopLevel: true, isExported: true, type: 'method', isSynthetic: true,
                });
            }
        });
    });
}

// ---- Python: @dataclass ----
function extractPythonDataclassMembers(content, filename, lines, addFn, extractCode) {
    lines.forEach(function (line, idx) {
        if (!/^\s*@dataclass\b/.test(line)) return;
        for (var j = idx + 1; j < lines.length; j++) {
            var classMatch = lines[j].match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/);
            if (classMatch) {
                var className = classMatch[1];
                var lineNum = j + 1;
                ['__init__', '__repr__', '__eq__'].forEach(function (name) {
                    addFn({
                        name: className + '.' + name, file: filename, line: lineNum,
                        code: extractCode(lineNum, lineNum), isTopLevel: false, isExported: false,
                        isClassMethod: true, type: 'method', className: className, isSynthetic: true,
                    });
                });
                break;
            }
            if (lines[j].trim() !== '' && !lines[j].trim().startsWith('@')) break;
        }
    });
}

function maskNonCodeForFallback(content, options = {}) {
    const source = String(content || '');
    if (options.isPython) return source; // Python fallback already calls stripPythonNonCode before reaching this pass.
    const isVBA = !!options.isVBA;
    const output = source.split('');
    let state = 'code';
    let quote = '';
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];
        if (state === 'line-comment') {
            if (c === '\n') state = 'code'; else output[i] = ' ';
            i++;
            continue;
        }
        if (state === 'block-comment') {
            if (c === '*' && next === '/') { output[i] = ' '; output[i + 1] = ' '; i += 2; state = 'code'; }
            else { if (c !== '\n') output[i] = ' '; i++; }
            continue;
        }
        if (state === 'string') {
            if (c === '\\') { output[i] = ' '; if (i + 1 < source.length && source[i + 1] !== '\n') output[i + 1] = ' '; i += 2; continue; }
            if (c === quote) { output[i] = ' '; i++; state = 'code'; continue; }
            if (c !== '\n') output[i] = ' ';
            i++;
            continue;
        }
        if (isVBA && c === "'") { output[i] = ' '; i++; state = 'line-comment'; continue; }
        if (!isVBA && c === '/' && next === '/') { output[i] = ' '; output[i + 1] = ' '; i += 2; state = 'line-comment'; continue; }
        if (!isVBA && c === '/' && next === '*') { output[i] = ' '; output[i + 1] = ' '; i += 2; state = 'block-comment'; continue; }
        if (c === '"' || (!isVBA && c === "'") || (!isVBA && options.isJS && c === '`')) {
            quote = c; output[i] = ' '; i++; state = 'string'; continue;
        }
        i++;
    }
    return output.join('');
}

const Parser={
    // Tree-sitter parsers are loaded lazily from CDN and used when a language has
    // a stable grammar path. Regex remains an explicit fallback, not a silent lie.
    _tsRuntimePromise:null,
    _tsLanguagePromises:Object.create(null),
    _tsLanguages:Object.create(null),
    _tsParsers:Object.create(null),
    _callCandidateThreshold:250,
    treeSitterWasmBase:'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/',
    treeSitterGrammars:{
        python:{grammar:'python',exts:['.py','.pyw','.pyi'],coverage:'calls'},
        javascript:{grammar:'javascript',exts:['.js','.jsx','.mjs','.cjs'],coverage:'available'},
        typescript:{grammar:'typescript',exts:['.ts'],coverage:'available'},
        tsx:{grammar:'tsx',exts:['.tsx'],coverage:'available'},
        go:{grammar:'go',exts:['.go'],coverage:'available'},
        rust:{grammar:'rust',exts:['.rs'],coverage:'available'},
        java:{grammar:'java',exts:['.java'],coverage:'available'},
        ruby:{grammar:'ruby',exts:['.rb'],coverage:'available'},
        php:{grammar:'php',exts:['.php'],coverage:'available'},
        c:{grammar:'c',exts:['.c','.h'],coverage:'available'},
        cpp:{grammar:'cpp',exts:['.cpp','.cc','.hpp'],coverage:'available'},
        csharp:{grammar:'c_sharp',exts:['.cs'],coverage:'available'},
        swift:{grammar:'swift',exts:['.swift'],coverage:'available'},
        kotlin:{grammar:'kotlin',exts:['.kt','.kts'],coverage:'available'},
        scala:{grammar:'scala',exts:['.scala'],coverage:'available'},
        elixir:{grammar:'elixir',exts:['.ex','.exs'],coverage:'available'},
        lua:{grammar:'lua',exts:['.lua'],coverage:'available'},
        bash:{grammar:'bash',exts:['.sh','.bash','.zsh','.fish'],coverage:'available'}
    },
    treeSitterFetchTimeoutMs:8000,
    _withTimeout:function(promise,ms){
        return Promise.race([
            promise,
            new Promise(function(_,reject){setTimeout(function(){reject(new Error('tree-sitter fetch timed out'));},ms);})
        ]);
    },
    initTreeSitter:async function(){
        if(this._tsRuntimePromise)return this._tsRuntimePromise;
        this._tsRuntimePromise=(async()=>{
            if(typeof TreeSitter==='undefined')return null;
            try{
                await Parser._withTimeout(TreeSitter.init({
                    locateFile:function(scriptName){
                        return 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.20.8/'+scriptName;
                    }
                }),Parser.treeSitterFetchTimeoutMs);
                return TreeSitter;
            }catch(e){
                return null;
            }
        })();
        return this._tsRuntimePromise;
    },
    getTreeSitterConfig:function(filename){
        var lower=(filename||'').toLowerCase();
        var configs=Object.values(Parser.treeSitterGrammars);
        for(var i=0;i<configs.length;i++){
            if(configs[i].exts.some(function(ext){return lower.endsWith(ext);})){
                return configs[i];
            }
        }
        return null;
    },
    loadTreeSitterLanguage:async function(config){
        if(!config)return null;
        if(this._tsLanguages[config.grammar])return this._tsLanguages[config.grammar];
        if(this._tsLanguagePromises[config.grammar])return this._tsLanguagePromises[config.grammar];
        this._tsLanguagePromises[config.grammar]=(async()=>{
            var runtime=await Parser.initTreeSitter();
            if(!runtime)return null;
            try{
                var lang=await Parser._withTimeout(runtime.Language.load(Parser.treeSitterWasmBase+'tree-sitter-'+config.grammar+'.wasm'),Parser.treeSitterFetchTimeoutMs);
                var parser=new runtime();
                parser.setLanguage(lang);
                Parser._tsLanguages[config.grammar]=lang;
                Parser._tsParsers[config.grammar]=parser;
                return lang;
            }catch(e){
                return null;
            }
        })();
        return this._tsLanguagePromises[config.grammar];
    },
    prepareTreeSitter:async function(files){
        var configs=new Map();
        (files||[]).forEach(function(file){
            var cfg=Parser.getTreeSitterConfig(file.path||file.name);
            if(cfg)configs.set(cfg.grammar,cfg);
        });
        await Promise.all(Array.from(configs.values()).map(function(cfg){return Parser.loadTreeSitterLanguage(cfg);}));
    },
    getLoadedTreeSitterParser:function(filename){
        var cfg=Parser.getTreeSitterConfig(filename);
        return cfg?Parser._tsParsers[cfg.grammar]||null:null;
    },
    getParserProvenance:function(filename){
        var lower=(filename||'').toLowerCase();
        var cfg=Parser.getTreeSitterConfig(filename);
        if(cfg&&Parser._tsParsers[cfg.grammar])return cfg.coverage==='calls'?'tree-sitter:'+cfg.grammar+'-calls':'tree-sitter:'+cfg.grammar;
        if(['.js','.jsx','.ts','.tsx','.mts','.cts','.mjs','.cjs','.vue','.svelte'].some(function(ext){return lower.endsWith(ext);})&&typeof acorn!=='undefined')return 'acorn-babel';
        if(Parser.isMarkdown&&Parser.isMarkdown(filename))return 'markdown-link-parser';
        if(Parser.isCode(filename))return 'heuristic-regex';
        return 'text';
    },
    codeExts:['.js','.jsx','.ts','.tsx','.mts','.cts','.mjs','.cjs','.py','.pyw','.pyi','.java','.go','.rb','.php','.rs','.c','.cpp','.cc','.cxx','.h','.hpp','.hh','.hxx','.cs','.swift','.kt','.kts','.scala','.clj','.cljs','.cljc','.ex','.exs','.erl','.hrl','.hs','.lhs','.lua','.r','.R','.jl','.dart','.elm','.fs','.fsx','.ml','.mli','.pl','.pm','.sh','.bash','.zsh','.fish','.ps1','.psm1','.groovy','.gradle','.vba','.bas','.cls','.xlsm','.xlam','.xlsb','.xla','.xlw'],
    scriptContainerExts:['.html','.htm','.xhtml','.vue','.svelte'],
    textExts:['.md','.markdown','.txt','.json','.jsonl','.yaml','.yml','.toml','.xml','.html','.htm','.css','.scss','.sass','.less','.svg','.graphql','.gql','.sql','.prisma','.proto','.tf','.tfvars','.env','.env.example','.gitignore','.gitattributes','.gitmodules','.eslintrc','.prettierrc','.babelrc','.editorconfig','.ini','.cfg','.conf','.properties','.lock','.csv','.tsv','.rst','.tex','.cmake','.rake','.vba','.bas','.cls','.xlsm','.xlam','.xlsb','.xla','.xlw','.mod','.sum'],
    textNames:['dockerfile','containerfile','makefile','rakefile','gemfile','podfile','pipfile','procfile','brewfile','justfile','taskfile','cmakelists.txt','license','copying','notice','readme','changelog','authors','contributors','owners','codeowners','go.mod','go.sum'],
    binExts:['.png','.jpg','.jpeg','.gif','.ico','.webp','.bmp','.svg','.woff','.woff2','.ttf','.eot','.otf','.pdf','.zip','.tar','.gz','.rar','.7z','.exe','.dll','.so','.dylib','.bin','.dat','.db','.sqlite','.mp3','.mp4','.wav','.avi','.mov','.webm'],
    isCode:function(n){
        var lower=n.toLowerCase();
        return Parser.codeExts.some(function(e){return lower.endsWith(e);})||
            Parser.scriptContainerExts.some(function(e){return lower.endsWith(e);});
    },
    isText:function(n){
        var lower=n.toLowerCase();
        return Parser.textExts.some(function(e){return lower.endsWith(e);})||Parser.textNames.indexOf(lower)>=0;
    },
    isBinary:function(n){return Parser.binExts.some(function(e){return n.toLowerCase().endsWith(e);});},
    isIncluded:function(n){return !Parser.isBinary(n)&&(Parser.isCode(n)||Parser.isText(n));},
    isScriptContainer:function(n){return Parser.scriptContainerExts.some(function(e){return n.toLowerCase().endsWith(e);});},
    isVBA:function(n){return ['.vba','.bas','.cls','.xlsm','.xlam','.xlsb','.xla','.xlw'].some(function(e){return n.toLowerCase().endsWith(e);});},
    isHTML:function(n){return ['.html','.htm','.xhtml'].some(function(e){return n.toLowerCase().endsWith(e);});},
    isCSS:function(n){return ['.css','.scss','.sass','.less'].some(function(e){return n.toLowerCase().endsWith(e);});},
    isJSON:function(n){return ['.json'].some(function(e){return n.toLowerCase().endsWith(e);});},
    parseHTMLAttributes:function(attrs){
        if(!attrs)return[];
        var parsed=[];
        var attrRegex=/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        var match;
        while((match=attrRegex.exec(attrs))){
            var value=match[2]!==undefined?match[2]:(match[3]!==undefined?match[3]:match[4]);
            parsed.push({
                name:(match[1]||'').toLowerCase(),
                value:value===undefined?'':value,
                valueStart:value===undefined?-1:match.index+match[0].indexOf(value)
            });
        }
        return parsed;
    },
    getScriptTagAttribute:function(attrs,name){
        var parsed=Parser.parseHTMLAttributes(attrs);
        var lowered=name.toLowerCase();
        for(var i=0;i<parsed.length;i++){
            if(parsed[i].name===lowered)return parsed[i].value;
        }
        return'';
    },
    getScriptBlockInfo:function(attrs){
        var type=(Parser.getScriptTagAttribute(attrs,'type')||'').split(';')[0].trim().toLowerCase();
        var lang=(Parser.getScriptTagAttribute(attrs,'lang')||'').split(';')[0].trim().toLowerCase();
        var info={executable:false,isTS:false,sourceType:'script'};

        if(!type){
            info.executable=true;
        }else if(type==='module'){
            info.executable=true;
            info.sourceType='module';
        }else if(
            type.match(/^(?:text|application)\/(?:x-)?(?:java|ecma)script$/)||
            type==='text/babel'||type==='text/jsx'||type==='application/jsx'||
            type==='application/babel'
        ){
            info.executable=true;
        }else if(
            type.match(/^(?:text|application)\/(?:x-)?typescript$/)||
            type==='text/tsx'||type==='application/tsx'
        ){
            info.executable=true;
            info.isTS=true;
        }

        if(lang==='ts'||lang==='tsx'||lang==='typescript'){
            info.executable=true;
            info.isTS=true;
        }else if(lang==='js'||lang==='jsx'||lang==='javascript'||lang==='babel'){
            info.executable=true;
        }

        return info;
    },
    getEmbeddedCodeBlocks:function(content,filename,options){
        if(!content||!Parser.isScriptContainer(filename))return[];
        var blocks=[];
        var scriptRegex=/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi;
        var match;
        var scriptRanges=[];
        while((match=scriptRegex.exec(content))){
            var attrs=match[1]||'';
            var info=Parser.getScriptBlockInfo(attrs);
            var scriptContent=match[2]||'';
            scriptRanges.push({start:match.index,end:match.index+match[0].length});
            if(!info.executable||!scriptContent.trim())continue;
            var openTagEnd=match[0].indexOf('>');
            if(openTagEnd<0)continue;
            var bodyStart=match.index+openTagEnd+1;
            blocks.push({
                content:scriptContent,
                offset:content.slice(0,bodyStart).split('\n').length-1,
                isTS:info.isTS,
                sourceType:info.sourceType,
                kind:'script'
            });
        }

        if(options&&options.includeHandlers&&Parser.isHTML(filename)){
            var tagRegex=/<([a-z][\w:-]*)([^<>]*?)>/gi;
            while((match=tagRegex.exec(content))){
                var tagStart=match.index;
                var insideScript=false;
                for(var sri=0;sri<scriptRanges.length;sri++){
                    if(tagStart>=scriptRanges[sri].start&&tagStart<scriptRanges[sri].end){
                        insideScript=true;
                        break;
                    }
                }
                if(insideScript)continue;
                var attrs=match[2]||'';
                var attrsStart=match[0].indexOf(attrs);
                var parsedAttrs=Parser.parseHTMLAttributes(attrs);
                for(var ai=0;ai<parsedAttrs.length;ai++){
                    var attr=parsedAttrs[ai];
                    if(!/^on[a-z][\w:-]*$/i.test(attr.name)||attr.valueStart<0)continue;
                    if(!attr.value||!attr.value.trim())continue;
                    var valueStart=tagStart+attrsStart+attr.valueStart;
                    blocks.push({
                        content:attr.value,
                        offset:content.slice(0,valueStart).split('\n').length-1,
                        isTS:false,
                        sourceType:'script',
                        kind:'handler'
                    });
                }
            }
        }

        return blocks;
    },
    hasEmbeddedCode:function(content,filename){
        return Parser.getEmbeddedCodeBlocks(content,filename,{includeHandlers:true}).length>0;
    },
    isMarkdown:function(n){return ['.md','.markdown'].some(function(e){return n.toLowerCase().endsWith(e);});},
    // Mirror of tests/md-extractors.mjs::extractMarkdownLinks. Keep in sync.
    extractMarkdownLinks:function(content){
        if(!content)return[];
        var stripped=content.replace(/```[\s\S]*?```/g,'').replace(/~~~[\s\S]*?~~~/g,'').replace(/`[^`\n]*`/g,'');
        var links=[];
        var wikiRe=/\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;
        var m;
        while((m=wikiRe.exec(stripped))!==null){
            links.push({kind:'wikilink',raw:m[0],target:m[1].trim()});
        }
        var mdRe=/(!?)\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g;
        while((m=mdRe.exec(stripped))!==null){
            if(m[1]==='!')continue;
            var url=m[3].trim();
            if(!url)continue;
            if(/^(?:https?:|mailto:|ftp:|file:|tel:|#)/i.test(url))continue;
            var clean=url.split('#')[0].split('?')[0];
            if(!clean)continue;
            links.push({kind:'mdlink',raw:m[0],target:url});
        }
        return links;
    },
    // Mirror of tests/md-extractors.mjs::resolveMarkdownLink. Keep in sync.
    resolveMarkdownLink:function(rawTarget,fromPath,allPaths,kind){
        if(!rawTarget)return null;
        var allLower=allPaths.map(function(p){return p.toLowerCase();});
        function findExact(candidate){
            var c=candidate.toLowerCase();
            var i=allLower.indexOf(c);
            return i>=0?allPaths[i]:null;
        }
        function findWithMd(candidate){
            var hit=findExact(candidate);
            if(hit)return hit;
            if(!/\.(md|markdown)$/i.test(candidate)){
                var mdHit=findExact(candidate+'.md');
                if(mdHit)return mdHit;
                return findExact(candidate+'.markdown');
            }
            return null;
        }
        if(kind==='mdlink'){
            var cleanTarget=rawTarget.split('#')[0].split('?')[0];
            var resolved;
            if(cleanTarget.charAt(0)==='/'){
                resolved=cleanTarget.slice(1);
            }else{
                var fromDir=fromPath.indexOf('/')>=0?fromPath.split('/').slice(0,-1).join('/'):'';
                var parts=(fromDir?fromDir.split('/'):[]).concat(cleanTarget.split('/'));
                var out=[];
                for(var pi=0;pi<parts.length;pi++){
                    var p=parts[pi];
                    if(p===''||p==='.')continue;
                    if(p==='..'){out.pop();continue;}
                    out.push(p);
                }
                resolved=out.join('/');
            }
            var direct=findWithMd(resolved);
            if(direct)return direct;
        }
        var baseName=rawTarget.split('#')[0].split('?')[0].split('/').pop();
        if(!baseName)return null;
        for(var i=0;i<allPaths.length;i++){
            var pname=allPaths[i].split('/').pop().toLowerCase();
            if(/\.(md|markdown)$/i.test(baseName)){
                if(pname===baseName.toLowerCase())return allPaths[i];
            }else if(pname===baseName.toLowerCase()+'.md'||pname===baseName.toLowerCase()+'.markdown'){
                return allPaths[i];
            }
        }
        return null;
    },
    detectLayer:function(p){
        // Prepend a leading slash so root-level layer folders (e.g. "services/x.ts")
        // match the same substring patterns as nested ones (e.g. "src/services/x.ts").
        var l='/'+p.toLowerCase().replace(/^\/+/,'');
        // Test files
        if(l.includes('/test')||l.match(/test_\w+\.py$/)||l.match(/\w+_test\.py$/)||l.includes('conftest'))return'test';
        // UI/View layer
        if(l.includes('/ui/')||l.includes('/views/')||l.includes('/pages/')||l.includes('/templates/')||l.includes('/static/'))return'ui';
        if(l.includes('/component'))return'components';
        // Service/API layer
        if(l.includes('/service')||l.includes('/api/')||l.includes('/controller')||l.includes('/endpoint')||l.includes('/router'))return'services';
        // Python middleware/handler layer
        if(l.includes('/middleware')||l.includes('/handler')||l.includes('/signal'))return'services';
        // Utility/Helper layer
        if(l.includes('/util')||l.includes('/helper')||l.includes('/lib/')||l.includes('/common/'))return'utils';
        // Data/Model layer
        if(l.includes('/data')||l.includes('/model')||l.includes('/store')||l.includes('/schema')||l.includes('/serializer'))return'data';
        // Python-specific data layers
        if(l.includes('/migration'))return'data';
        if(l.includes('/fixtures/'))return'data';
        // Task/Worker layer
        if(l.includes('/task')||l.includes('/worker')||l.includes('/celery')||l.includes('/job'))return'services';
        // Config layer
        if(l.includes('/config')||l.includes('/settings')||l.match(/settings\.py$/))return'config';
        // VBA-specific layer detection
        if(l.includes('/modules/')||l.includes('/bas/'))return'modules';
        if(l.includes('/forms/')||l.includes('/userforms/'))return'ui';
        if(l.includes('/classes/'))return'data';
        if(l.includes('/standard/'))return'utils';
        // Unknown paths are not proven utility/helper layers. Using `utils`
        // here caused ordinary root-level files to generate false architecture
        // violations against services/controllers.
        return'other';
    },
    detectPatterns:function(files){
        var patterns=[];
        var singletons=files.filter(function(f){return f.content&&(f.content.includes('getInstance')||f.content.match(/let\s+instance\s*=/)||f.content.match(/private\s+static\s+instance/));});
        if(singletons.length)patterns.push({name:'Singleton',icon:'lock',desc:'Ensures a class has only one instance. Common for configuration, logging, or connection pools.',severity:'info',files:singletons.map(function(f){return{name:f.name,path:f.path};}),metrics:{instances:singletons.length}});
        var factories=files.filter(function(f){return f.content&&(f.name.toLowerCase().includes('factory')||f.content.match(/create[A-Z]\w*\s*\(/)||f.content.includes('return new'));});
        if(factories.length)patterns.push({name:'Factory',icon:'factory',desc:'Creates objects without specifying exact class. Enables loose coupling and extensibility.',severity:'info',files:factories.map(function(f){return{name:f.name,path:f.path};}),metrics:{factories:factories.length}});
        var observers=files.filter(function(f){return f.content&&(f.content.includes('subscribe')||f.content.includes('addEventListener')||f.content.includes('.on(')||f.content.includes('emit('));});
        if(observers.length)patterns.push({name:'Observer/Event',icon:'eye',desc:'Defines a subscription mechanism for event-driven architecture. Great for decoupling.',severity:'info',files:observers.map(function(f){return{name:f.name,path:f.path};}),metrics:{emitters:observers.length}});
        var hooks=files.filter(function(f){return f.content&&f.content.match(/export\s+(?:const|function)\s+use[A-Z]/);});
        if(hooks.length)patterns.push({name:'Custom Hooks',icon:'hook',desc:'React hooks for reusable stateful logic. Promotes code reuse and separation of concerns.',severity:'info',files:hooks.map(function(f){return{name:f.name,path:f.path};}),metrics:{hooks:hooks.length}});
        var hocs=files.filter(function(f){return f.content&&(f.content.match(/with[A-Z]\w*\s*=\s*\(/)||f.content.match(/export\s+default\s+connect/));});
        if(hocs.length)patterns.push({name:'Higher-Order Component',icon:'spark',desc:'Functions that take a component and return an enhanced component.',severity:'info',files:hocs.map(function(f){return{name:f.name,path:f.path};}),metrics:{hocs:hocs.length}});
        var providers=files.filter(function(f){return f.content&&(f.content.includes('createContext')||f.content.includes('Provider')||f.content.includes('useContext'));});
        if(providers.length)patterns.push({name:'Context Provider',icon:'globe',desc:'React Context for global state. Alternative to prop drilling.',severity:'info',files:providers.map(function(f){return{name:f.name,path:f.path};}),metrics:{contexts:providers.length}});
        // VBA-specific patterns
        var vbaUserForms=files.filter(function(f){return f.content&&(f.content.match(/Attribute\s+VB_Name\s*=\s*["']UserForm/i)||f.name.match(/UserForm/i));});
        if(vbaUserForms.length)patterns.push({name:'UserForms',icon:'layout',desc:'VBA UserForms for UI components. Common in Excel/Access automation.',severity:'info',files:vbaUserForms.map(function(f){return{name:f.name,path:f.path};}),metrics:{forms:vbaUserForms.length}});
        var vbaModules=files.filter(function(f){return f.content&&(f.content.match(/Attribute\s+VB_Name\s*=\s*["']Module/i)||f.name.match(/Module/i));});
        if(vbaModules.length)patterns.push({name:'Modules',icon:'box',desc:'VBA Modules for reusable code and business logic.',severity:'info',files:vbaModules.map(function(f){return{name:f.name,path:f.path};}),metrics:{modules:vbaModules.length}});
        var vbaClasses=files.filter(function(f){return f.content&&(f.content.match(/Attribute\s+VB_Name\s*=\s*["']Class/i)||f.name.match(/Class/i));});
        if(vbaClasses.length)patterns.push({name:'Class Modules',icon:'building',desc:'VBA Class Modules for object-oriented programming patterns.',severity:'info',files:vbaClasses.map(function(f){return{name:f.name,path:f.path};}),metrics:{classes:vbaClasses.length}});
        // Python-specific patterns
        var decoratorFiles=files.filter(function(f){return f.content&&f.name.endsWith('.py')&&f.content.match(/@\w+\s*(?:\(.*\))?\s*\n\s*(?:def|class)/);});
        var pyDecorators=decoratorFiles.filter(function(f){return f.content.match(/@(?:app\.route|router\.|blueprint\.|get|post|put|delete|patch)\s*\(/);});
        if(pyDecorators.length)patterns.push({name:'Route Decorators',icon:'route',desc:'Flask/FastAPI/Django route decorators for URL routing. Common in Python web frameworks.',severity:'info',files:pyDecorators.map(function(f){return{name:f.name,path:f.path};}),metrics:{routes:pyDecorators.length}});
        var dataclasses=files.filter(function(f){return f.content&&f.name.endsWith('.py')&&f.content.match(/@dataclass/);});
        if(dataclasses.length)patterns.push({name:'Dataclasses',icon:'database',desc:'Python dataclasses for structured data. Reduces boilerplate for data-holding classes.',severity:'info',files:dataclasses.map(function(f){return{name:f.name,path:f.path};}),metrics:{dataclasses:dataclasses.length}});
        var abcFiles=files.filter(function(f){return f.content&&f.name.endsWith('.py')&&(f.content.match(/\bABC\b/)||f.content.match(/@abstractmethod/)||f.content.match(/ABCMeta/));});
        if(abcFiles.length)patterns.push({name:'Abstract Base Classes',icon:'layers',desc:'Python ABCs enforce interface contracts. Ensures subclasses implement required methods.',severity:'info',files:abcFiles.map(function(f){return{name:f.name,path:f.path};}),metrics:{abcs:abcFiles.length}});
        var ctxManagers=files.filter(function(f){return f.content&&f.name.endsWith('.py')&&(f.content.match(/@contextmanager/)||f.content.match(/def\s+__enter__/));});
        if(ctxManagers.length)patterns.push({name:'Context Managers',icon:'refresh',desc:'Python context managers for resource management (with statement). Ensures proper cleanup.',severity:'info',files:ctxManagers.map(function(f){return{name:f.name,path:f.path};}),metrics:{managers:ctxManagers.length}});
        var pyMixins=files.filter(function(f){return f.content&&f.name.endsWith('.py')&&f.content.match(/class\s+\w*Mixin\w*\s*[\(:]?/);});
        if(pyMixins.length)patterns.push({name:'Mixins',icon:'puzzle',desc:'Python mixins for reusable behavior through multiple inheritance.',severity:'info',files:pyMixins.map(function(f){return{name:f.name,path:f.path};}),metrics:{mixins:pyMixins.length}});
        var pySignals=files.filter(function(f){return f.content&&f.name.endsWith('.py')&&(f.content.match(/Signal\s*\(/)||f.content.match(/@receiver\s*\(/)||f.content.match(/\.connect\s*\(/));});
        if(pySignals.length)patterns.push({name:'Django Signals',icon:'radio',desc:'Django signals for decoupled event-driven communication between components.',severity:'info',files:pySignals.map(function(f){return{name:f.name,path:f.path};}),metrics:{signals:pySignals.length}});
        var pyMiddleware=files.filter(function(f){return f.content&&f.name.endsWith('.py')&&(f.content.match(/class\s+\w*Middleware/)||f.content.match(/def\s+middleware\s*\(/)||f.name.toLowerCase().includes('middleware'));});
        if(pyMiddleware.length)patterns.push({name:'Middleware',icon:'link',desc:'Request/response middleware for cross-cutting concerns (auth, logging, CORS).',severity:'info',files:pyMiddleware.map(function(f){return{name:f.name,path:f.path};}),metrics:{middleware:pyMiddleware.length}});
        var godFiles=files.filter(function(f){return f.isCode!==false&&f.functions&&f.functions.length>15;});
        if(godFiles.length)patterns.push({name:'God Object',icon:'warning',desc:'Files with too many responsibilities (15+ functions). Consider splitting into smaller modules.',severity:'warning',isAnti:true,files:godFiles.map(function(f){return{name:f.name,path:f.path,fns:f.functions.length};}),metrics:{files:godFiles.length,avgFns:Math.round(godFiles.reduce(function(s,f){return s+f.functions.length;},0)/godFiles.length)}});
        var longFiles=files.filter(function(f){return f.isCode!==false&&f.lines&&f.lines>500;});
        if(longFiles.length)patterns.push({name:'Long File',icon:'scroll',desc:'Files over 500 lines are harder to maintain. Consider breaking into smaller modules.',severity:'warning',isAnti:true,files:longFiles.map(function(f){return{name:f.name,path:f.path,lines:f.lines};}),metrics:{files:longFiles.length,avgLines:Math.round(longFiles.reduce(function(s,f){return s+f.lines;},0)/longFiles.length)}});
        // VBA-specific anti-patterns
        var vbaGodFiles=files.filter(function(f){return f.isCode!==false&&f.functions&&f.functions.length>20;});
        if(vbaGodFiles.length)patterns.push({name:'VBA God Module',icon:'warning',desc:'VBA modules with 20+ procedures. Consider splitting into smaller modules.',severity:'warning',isAnti:true,files:vbaGodFiles.map(function(f){return{name:f.name,path:f.path,fns:f.functions.length,lines:f.lines};}),metrics:{files:vbaGodFiles.length,avgFns:Math.round(vbaGodFiles.reduce(function(s,f){return s+f.functions.length;},0)/vbaGodFiles.length)}});
        return patterns;
    },
    detectDuplicates:function(files,allFns){
        var duplicates=[];

        // Common function names that are expected to be duplicated across files
        // These are idiomatic patterns, not DRY violations
        var commonNames=new Set([
            // React lifecycle and handlers
            'render','componentDidMount','componentWillUnmount','componentDidUpdate',
            'shouldComponentUpdate','getDerivedStateFromProps','getSnapshotBeforeUpdate',
            'handleClick','handleChange','handleSubmit','handleInput','handleKeyDown',
            'handleKeyUp','handleKeyPress','handleBlur','handleFocus','handleScroll',
            'handleMouseEnter','handleMouseLeave','handleDrag','handleDrop',
            'onClick','onChange','onSubmit','onBlur','onFocus','onKeyDown',
            // Common utility names
            'init','setup','cleanup','destroy','reset','clear','update','refresh',
            'validate','parse','format','transform','convert','process','execute',
            'get','set','fetch','load','save','create','delete','remove','add',
            'find','filter','map','reduce','sort','merge','clone','copy',
            // Test patterns
            'beforeEach','afterEach','beforeAll','afterAll','describe','it','test',
            'setUp','tearDown','mock',
            // Common class methods
            'toString','valueOf','equals','hashCode','compare','clone',
            'serialize','deserialize','toJSON','fromJSON',
            // Express/API patterns
            'index','show','store','update','destroy','create','edit',
            // Python common patterns
            '__init__','__str__','__repr__','__len__','__eq__','__hash__','__enter__','__exit__',
            '__getattr__','__setattr__','__delattr__','__getitem__','__setitem__','__contains__',
            '__iter__','__next__','__call__','__bool__','__lt__','__gt__','__le__','__ge__',
            'upgrade','downgrade','setUp','tearDown','setUpClass','tearDownClass',
            'main','create_app','configure','register','on_startup','on_shutdown','lifespan',
            // Vue lifecycle
            'mounted','created','updated','destroyed','beforeCreate','beforeMount',
            // Angular lifecycle
            'ngOnInit','ngOnDestroy','ngOnChanges','ngAfterViewInit',
            // Svelte
            'onMount','onDestroy',
            // Next.js App Router route-handler & metadata exports (framework-mandated names)
            'GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS',
            'generateMetadata','generateStaticParams','generateImageMetadata','generateSitemaps','middleware'
        ]);

        // Group functions by name (excluding common names)
        var fnByName=Object.create(null);
        allFns.forEach(function(fn){
            // Skip functions outside shipped product code (tests, fixtures, tooling, docs)
            if(isNonProductionPath(fn.file))return;
            // Skip non-string names (e.g. numeric object-literal keys from the JS AST walker)
            if(typeof fn.name!=='string')return;
            // Skip common/idiomatic names
            if(commonNames.has(fn.name))return;
            // Skip very short names (likely false positives)
            if(fn.name.length<3)return;
            // Skip class methods (same method name in different classes is normal)
            if(fn.isClassMethod)return;
            // Skip Python class-scoped names (ClassName.method)
            if(fn.name.includes('.'))return;
            // Skip decorated functions (framework handlers have similar structures by design)
            if(fn.decorators&&fn.decorators.length>0)return;

            if(!fnByName[fn.name])fnByName[fn.name]=[];
            fnByName[fn.name].push(fn);
        });

        // Find duplicate names across different files - only report if suspicious
        Object.entries(fnByName).forEach(function(entry){
            var name=entry[0],fns=entry[1];
            var uniqueFiles=[...new Set(fns.map(function(f){return f.file;}))];

            // Only flag if in 3+ files (2 files might be intentional)
            if(uniqueFiles.length>=3){
                // Check if the code is actually similar (not just same name)
                var codeSamples=fns.filter(function(f){return f.code&&f.code.length>30;});
                if(codeSamples.length>=2){
                    // Compare first two code samples for similarity
                    var sim=Parser.codeSimilarity(codeSamples[0].code,codeSamples[1].code);
                    if(sim>0.5){  // More than 50% similar - likely a real duplicate
                        duplicates.push({
                            type:'name',
                            name:name,
                            count:uniqueFiles.length,
                            files:fns.map(function(f){return{file:f.file,line:f.line};}),
                            similarity:Math.round(sim*100),
                            suggestion:'Function "'+name+'" appears in '+uniqueFiles.length+' files with '+Math.round(sim*100)+'% similarity - consider consolidating'
                        });
                    }
                }
            }
        });

        // Find similar code blocks (improved algorithm)
        // Use structural hash that captures the essence of the code
        var codeGroups=Object.create(null);
        allFns.forEach(function(fn){
            if(!fn.code||fn.code.length<80)return;  // Skip very short functions

            // Create a structural fingerprint
            var fingerprint=Parser.codeFingerprint(fn.code);
            if(!fingerprint)return;

            if(!codeGroups[fingerprint])codeGroups[fingerprint]=[];
            codeGroups[fingerprint].push(fn);
        });

        Object.values(codeGroups).forEach(function(fns){
            if(fns.length>1){
                var uniqueFiles=[...new Set(fns.map(function(f){return f.file;}))];
                // Must be in different files to be a real duplication issue
                if(uniqueFiles.length>1){
                    // Verify with actual similarity check
                    var sim=Parser.codeSimilarity(fns[0].code,fns[1].code);
                    if(sim>0.7){  // 70% or more similar
                        duplicates.push({
                            type:'code',
                            name:fns.map(function(f){return f.name;}).join(', '),
                            count:fns.length,
                            files:fns.map(function(f){return{file:f.file,name:f.name,line:f.line};}),
                            similarity:Math.round(sim*100),
                            suggestion:'Similar code blocks ('+Math.round(sim*100)+'% match) - consider extracting to a shared utility'
                        });
                    }
                }
            }
        });

        return duplicates;
    },

    // Calculate code similarity using normalized comparison (0-1 scale)
    codeSimilarity:function(code1,code2){
        if(!code1||!code2)return 0;

        // Normalize both code blocks
        function normalize(code){
            return code
                .replace(/\/\/.*$/gm,'')           // Remove JS single-line comments
                .replace(/#.*$/gm,'')              // Remove Python/Ruby comments
                .replace(/\/\*[\s\S]*?\*\//g,'')   // Remove multi-line comments
                .replace(/"""[\s\S]*?"""/g,'S')    // Remove Python docstrings (triple double)
                .replace(/'''[\s\S]*?'''/g,'S')    // Remove Python docstrings (triple single)
                .replace(/['"`][^'"`]*['"`]/g,'S') // Normalize strings
                .replace(/\b\d+\.?\d*\b/g,'N')     // Normalize numbers
                .replace(/\s+/g,' ')               // Normalize whitespace
                .trim();
        }

        var n1=normalize(code1);
        var n2=normalize(code2);

        if(n1===n2)return 1;
        if(n1.length===0||n2.length===0)return 0;

        // Use longest common subsequence ratio
        var lcs=Parser.lcsLength(n1,n2);
        var maxLen=Math.max(n1.length,n2.length);
        return lcs/maxLen;
    },

    // Longest common subsequence length (optimized for similarity)
    lcsLength:function(s1,s2){
        // Use simplified approach for performance
        if(s1.length>500||s2.length>500){
            // For long strings, use sampling
            s1=s1.substring(0,500);
            s2=s2.substring(0,500);
        }

        var m=s1.length,n=s2.length;
        var prev=new Array(n+1).fill(0);
        var curr=new Array(n+1).fill(0);

        for(var i=1;i<=m;i++){
            for(var j=1;j<=n;j++){
                if(s1[i-1]===s2[j-1]){
                    curr[j]=prev[j-1]+1;
                }else{
                    curr[j]=Math.max(prev[j],curr[j-1]);
                }
            }
            var tmp=prev;prev=curr;curr=tmp;
            curr.fill(0);
        }
        return prev[n];
    },

    // Create a structural fingerprint for code (for grouping similar code)
    codeFingerprint:function(code){
        if(!code||code.length<50)return null;

        // Extract structural elements
        var structure=code
            .replace(/\/\/.*$/gm,'')           // Remove comments
            .replace(/\/\*[\s\S]*?\*\//g,'')
            .replace(/['"`][^'"`]*['"`]/g,'')  // Remove string contents
            .replace(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g,'I')  // All identifiers -> I
            .replace(/\b\d+\.?\d*\b/g,'N')     // All numbers -> N
            .replace(/\s+/g,'');               // Remove whitespace

        // Take a hash-like fingerprint based on structure length and key patterns
        var patterns={
            loops:(structure.match(/for|while/g)||[]).length,
            conditions:(structure.match(/if|\?/g)||[]).length,
            calls:(structure.match(/I\(/g)||[]).length,
            returns:(structure.match(/return/g)||[]).length,
            len:Math.floor(structure.length/50)*50  // Bucket by length
        };

        // Create fingerprint string
        return 'L'+patterns.loops+'C'+patterns.conditions+'F'+patterns.calls+'R'+patterns.returns+'S'+patterns.len;
    },
    detectLayerViolations:function(files,connections){
        var violations=[];
        var layerOrder={presentation:0,ui:0,component:0,components:0,page:0,view:0,feature:1,service:2,services:2,api:2,data:3,model:3,util:4,utils:4,helper:4,lib:4,core:4,config:5,test:6,modules:5,forms:0,classes:3};
        var fileByPath={};
        files.forEach(function(f){fileByPath[f.path]=f;});
        connections.forEach(function(c){
            // Convention (see buildAnalysisData): source = file DEFINING the fn (imported),
            // target = file CALLING it (the importer). The importer is c.target.
            var importedFile=fileByPath[c.source];
            var importerFile=fileByPath[c.target];
            if(!importedFile||!importerFile)return;
            var importedLayer=(importedFile.layer||'').toLowerCase();
            var importerLayer=(importerFile.layer||'').toLowerCase();
            // Test files legitimately depend on every layer — never flag them as violators.
            // Use both classifiers: isArchitectureTestFile catches *.test/*.spec files outside
            // a tests/ dir; the 'test' layer catches Python test_*.py, conftest.py, and test-folders.
            if(isArchitectureTestFile(importerFile.path)||importerLayer==='test')return;
            var importedLevel=layerOrder[importedLayer];
            var importerLevel=layerOrder[importerLayer];
            // Violation: a more-foundational file (higher level number) imports from a higher-up layer.
            if(importerLevel!==undefined&&importedLevel!==undefined&&importerLevel>importedLevel&&importerLevel-importedLevel>1){
                violations.push({
                    from:importerFile.path,
                    fromLayer:importerFile.layer,
                    to:importedFile.path,
                    toLayer:importedFile.layer,
                    fn:c.fn,
                    suggestion:importerFile.layer+' should not import from '+importedFile.layer+'. Consider inverting the dependency or using dependency injection.'
                });
            }
        });
        return violations;
    },
    calcComplexity:function(content,filename){
        if(!content)return{score:0,level:'low',method:'heuristic-branch-count',decisionPoints:0};
        if(filename&&Parser.isScriptContainer(filename)){
            var blocks=Parser.getEmbeddedCodeBlocks(content,filename,{includeHandlers:true});
            if(!blocks.length)return{score:null,level:'not-applicable',status:'skipped',method:'not-applicable',decisionPoints:null,limitations:['No executable script block was found in this markup file.']};
            content=blocks.map(function(block){return block.content;}).join('\n');
        }
        // Count only code tokens: comments and string literals must not inflate
        // complexity merely because they contain words such as `if` or `for`.
        var ext=String(filename||'').toLowerCase().split('.').pop();
        var isPython=['py','pyw','pyi'].includes(ext);
        var code=maskSourceNonCode(content,filename||'');
        var complexity=1;
        var patterns=isPython
            ? [/\b(?:if|elif|while)\b/g,/\bfor\b/g,/\bexcept\b/g,/\b(?:and|or)\b/g]
            : [/\bif\s*\(/g,/\bfor\s*\(/g,/\bwhile\s*\(/g,/\bcase\b/g,/\bcatch\s*\(/g,/&&/g,/\|\|/g,/\?\?(?![=])/g,/(?<!\?)\?(?![?.])\s*[^:\n]*:/g];
        patterns.forEach(function(pattern){var matches=code.match(pattern);if(matches)complexity+=matches.length;});
        var level='low';
        if(complexity>30)level='critical';
        else if(complexity>20)level='high';
        else if(complexity>10)level='medium';
        return {score:complexity,level:level,method:'heuristic-branch-count',decisionPoints:Math.max(0,complexity-1),limitations:['File-level approximate branch count, not compiler-reported cyclomatic complexity.','Complex constructs, macros, generated code and language-specific control flow may be under- or over-counted.']};
    },
    generateSuggestions:function(data){
        var suggestions=[];
        // Based on dead functions
        if(data.stats.dead>10){
            suggestions.push({priority:'high',icon:'broom',title:'Remove Dead Code',desc:data.stats.dead+' unused functions detected. Removing them will improve maintainability and reduce bundle size.',action:'Review unused functions in the Issues panel',impact:'Reduces codebase by ~'+(data.stats.dead*15)+' lines'});
        }
        // Based on circular dependencies
        var circular=data.issues.filter(function(i){return i.title&&i.title.includes('Circular');});
        if(circular.length){
            suggestions.push({priority:'critical',icon:'refresh',title:'Break Circular Dependencies',desc:circular.length+' circular dependencies found. These cause tight coupling and make testing difficult.',action:'Extract shared code to a new module or use dependency injection',impact:'Improves testability and modularity'});
        }
        // Based on god files
        var godFiles=data.issues.filter(function(i){return i.title&&i.title.includes('Large');});
        if(godFiles.length){
            suggestions.push({priority:'high',icon:'split',title:'Split Large Files',desc:godFiles.length+' files have too many functions. Split by responsibility.',action:'Group related functions and extract to separate modules',impact:'Improves code navigation and testing'});
        }
        // Based on high coupling
        var coupling=data.issues.filter(function(i){return i.title&&i.title.includes('Coupled');});
        if(coupling.length){
            suggestions.push({priority:'medium',icon:'link',title:'Reduce Coupling',desc:coupling.length+' files are imported by many others. Consider if this is intentional.',action:'Review if these should be split or if importers should be consolidated',impact:'Reduces blast radius of changes'});
        }
        // Based on duplicates
        if(data.duplicates&&data.duplicates.length>0){
            var nameDups=data.duplicates.filter(function(d){return d.type==='name';});
            var codeDups=data.duplicates.filter(function(d){return d.type==='code';});
            if(nameDups.length){
                suggestions.push({priority:'medium',icon:'copy',title:'Resolve Naming Conflicts',desc:nameDups.length+' function names are duplicated across files. This can cause confusion.',action:'Rename functions to be more specific or consolidate into shared module',impact:'Prevents bugs from importing wrong function'});
            }
            if(codeDups.length){
                suggestions.push({priority:'high',icon:'box',title:'Extract Duplicated Code',desc:codeDups.length+' instances of similar code found. DRY principle violation.',action:'Create shared utility functions',impact:'Reduces maintenance burden and potential bugs'});
            }
        }
        // Based on layer violations
        if(data.layerViolations&&data.layerViolations.length>0){
            suggestions.push({priority:'high',icon:'layers',title:'Fix Architecture Violations',desc:data.layerViolations.length+' layer violations found. Lower layers should not depend on higher layers.',action:'Invert dependencies or use interfaces/events',impact:'Improves architecture and testability'});
        }
        // Based on security
        var highSec=data.securityIssues?data.securityIssues.filter(function(s){return s.severity==='high';}):[];
        if(highSec.length){
            suggestions.push({priority:'critical',icon:'shield',title:'Fix Security Issues',desc:highSec.length+' high-severity security issues found.',action:'Address hardcoded secrets, injection risks immediately',impact:'Prevents potential security breaches'});
        }
        // Test coverage hint
        var testFiles=data.files.filter(function(f){return f.name.includes('.test.')||f.name.includes('.spec.')||f.path.includes('__tests__');});
        var testRatio=data.files.length>0?(testFiles.length/data.files.length*100):0;
        if(testRatio<10&&data.files.length>10){
            suggestions.push({priority:'medium',icon:'beaker',title:'Add Test Coverage',desc:'Only '+testFiles.length+' test files found ('+Math.round(testRatio)+'%). Consider adding more tests.',action:'Focus on testing critical paths and high-complexity files',impact:'Prevents regressions and improves confidence'});
        }
        return suggestions.sort(function(a,b){var p={critical:0,high:1,medium:2,low:3};return p[a.priority]-p[b.priority];});
    },
    detectSecurity:function(files){
        var issues=[];
        files.forEach(function(f){
            var scanContent=getSecurityScanContent(f);
            if(!scanContent)return;
            // Keep the comment-masked source for value-aware checks, and a second
            // lexical mask for executable-code checks. This prevents patterns in
            // string literals (including this scanner's own regexes/examples) from
            // being mistaken for code while preserving original line offsets.
            var codeContent=maskSourceNonCode(f.content||'',f.path||f.name||'');
            codeContent=maskSecurityRegExpLiterals(f.content||'',codeContent,f.path||f.name||'');
            codeContent=maskSecurityJsxLiteralText(codeContent,f.path||f.name||'');
            var lines=scanContent.split('\n');
            var codeLines=codeContent.split('\n');
            lines.forEach(function(line,idx){
                var secretPattern=/(?:password|passwd|pwd|secret|api_key|apikey|token|auth)\s*[=:]\s*(['"])([^'"]{4,})\1/i;
                var secretMatch=line.match(secretPattern);
                var activeKey=secretMatch&&codeLines[idx]&&codeLines[idx].slice(secretMatch.index,secretMatch.index+secretMatch[0].search(/\s*[=:]/)).trim();
                // `secret = 'prefix_' + secrets.token_urlsafe(...)` assigns a
                // computed token, not a hardcoded literal. Also avoid reporting
                // password-field *validation messages* as stored credentials.
                var rhsEnd=secretMatch?secretMatch.index+secretMatch[0].length:0;
                var trailing=secretMatch?line.slice(rhsEnd).trim():'';
                var concatenatedLiterals=/^(?:\+\s*(?:'[^']*'|"[^"]*"))+\s*(?:[;,})\]]|$)/.test(trailing);
                var completeLiteral=!trailing||/^[;,})\]]/.test(trailing)||/^\/\//.test(trailing)||concatenatedLiterals;
                var validationMessage=secretMatch&&isValidationErrorLiteralAssignment(line,secretMatch,secretMatch[2]);
                if(!isSecretScanExemptPath(f.path)&&secretMatch&&activeKey&&!/^\s*$/.test(activeKey)&&completeLiteral&&!validationMessage&&!line.includes('process.env')&&!line.includes('config.')&&!isPlaceholderSecretValue(secretMatch[0])){
                    issues.push({severity:'high',title:'Hardcoded Secret',file:f.name,path:f.path,line:idx+1,desc:'A credential-shaped assignment appears in executable source. Verify whether the value is live; rotate it if real and move it to an environment variable or secrets manager.',code:line.trim().substring(0,80),confidence:'INFERENCE',confidenceReason:'Assignment shape is present in executable code; this heuristic cannot determine whether the value is live, revoked, or a sample.'});
                }
            });
            var hasSqlConcat=!!(codeContent.match(/\b(?:query|execute|raw)\s*\(/)&& scanContent.match(/\b(?:query|execute|raw)\s*\(\s*(?:'[^']*'|\"[^\"]*\"|`[^`]*`)\s*\+/));
            var hasSqlTemplateInjection=false;
            // Only flag interpolated template literals passed to an executable DB call;
            // `${...}` text inside an ordinary quoted string is not interpolation.
            var templateDbCall=/\b(?:query|execute|raw)\s*\(\s*`([^`]*\$\{[^`]*)`/gi;
            var dbCall;
            while((dbCall=templateDbCall.exec(scanContent))!==null){
                if(/(?:SELECT|INSERT|UPDATE|DELETE)/i.test(dbCall[1])){hasSqlTemplateInjection=true;break;}
            }
            if(!codeContent.match(/\b(?:query|execute|raw|executeQuery|executeUpdate|prepareStatement|createQuery)\s*\(/))hasSqlTemplateInjection=false;
            if(f.isCode&&(hasSqlConcat||hasSqlTemplateInjection)){
                var m=scanContent.match(/.*(query|execute|SELECT|INSERT|UPDATE|DELETE).*(\+|\$\{).*/i);
                var sqlLine=codeLines.findIndex(function(l){return /\b(?:query|execute|raw|executeQuery|executeUpdate|prepareStatement|createQuery)\s*\(/.test(l);});
                issues.push({severity:'high',title:'Potential SQL Injection Risk',file:f.name,path:f.path,line:sqlLine>=0?sqlLine+1:undefined,desc:'A SQL construction pattern may combine query text with dynamic input. Verify parameterization and value binding before treating this as exploitable.',code:sqlLine>=0?lines[sqlLine].trim().substring(0,120):(m?m[0].trim().substring(0,120):''),confidence:'INFERENCE',confidenceReason:'String-construction heuristic; query parameterization, taint reachability, and driver semantics were not proven.'});
            }
            var hasInnerHtmlAssignment=codeContent.match(/innerHTML\s*=/);
            var hasDangerousHtmlRender=codeContent.match(/dangerouslySetInnerHTML/);
            var isSafePreviewRender=!hasInnerHtmlAssignment&&hasDangerousHtmlRender&&
                (isSanitizedPreviewRenderer(f.content||'')||isVerifiedEscapedSyntaxRenderer(f,files));
            var htmlValueRegex=/dangerouslySetInnerHTML\s*[:=]\s*\{\{?\s*__html\s*:\s*([^}]+)\}/g;
            var allHtmlValuesLiteral=true;
            var foundHtmlValue=false;
            var htmlMatch;
            while((htmlMatch=htmlValueRegex.exec(scanContent))!==null){
                foundHtmlValue=true;
                if(!/^(['"`])(?:(?!\1)[\s\S])*\1$/.test(htmlMatch[1].trim())){
                    allHtmlValuesLiteral=false;
                }
            }
            var isSafeStaticHtml=!hasInnerHtmlAssignment&&hasDangerousHtmlRender&&foundHtmlValue&&allHtmlValuesLiteral;
            if(!isNonProductionPath(f.path)&&(hasInnerHtmlAssignment||hasDangerousHtmlRender)&&!isSafePreviewRender&&!isSafeStaticHtml){
                var xssLine=codeLines.findIndex(function(l){return /innerHTML\s*=|dangerouslySetInnerHTML/.test(l);});
                issues.push({severity:'high',title:'Potential XSS Sink',file:f.name,path:f.path,line:xssLine>=0?xssLine+1:undefined,desc:'An executable HTML injection sink was found. Exploitability depends on the value reaching this sink and the escaping/sanitization path.',code:xssLine>=0?lines[xssLine].trim().substring(0,160):'',confidence:'INFERENCE',confidenceReason:'Sink-only heuristic; source-to-sink reachability and sanitizer behavior were not proven.'});
            }
            if(!/\.(?:py|pyw|pyi)$/i.test(f.path||f.name||'')&&/(?<![\w$.])eval\s*\(/.test(codeContent)){
                var evalLine=codeLines.findIndex(function(l){return /(?<![\w$.])eval\s*\(/.test(l);});
                issues.push({severity:'medium',title:'Dynamic Code Execution',file:f.name,path:f.path,line:evalLine+1,desc:'eval() executes arbitrary code. Avoid if possible or validate input strictly.',code:evalLine>=0?lines[evalLine].trim().substring(0,80):'',confidence:'INFERENCE',confidenceReason:'Executable eval call detected; source and runtime input reachability are not proven.'});
            }
            var functionMatch=codeContent.match(/\b(?:new\s+)?Function\s*\(/);
            if(functionMatch){
                var functionLine=codeLines.findIndex(function(l){return /\b(?:new\s+)?Function\s*\(/.test(l);});
                issues.push({severity:'medium',title:'Function Constructor',file:f.name,path:f.path,line:functionLine>=0?functionLine+1:undefined,desc:'Function constructor is similar to eval(). Consider alternatives.',code:functionLine>=0?lines[functionLine].trim().substring(0,120):'',confidence:'INFERENCE',confidenceReason:'Executable Function-constructor call detected; the argument source and runtime reachability are not proven.'});
            }
            var commandRe=/(?:\b(?:child_process|cp)\.\s*(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(|(?<![\w$.])(?:exec|execSync|spawn|spawnSync)\s*\()/;
            var execMatch=codeContent.match(commandRe);
            if(!isNonProductionPath(f.path)&&execMatch){
                var commandLine=codeLines.findIndex(function(l){return commandRe.test(l);});
                issues.push({severity:'medium',title:'Command Execution',file:f.name,path:f.path,line:commandLine>=0?commandLine+1:undefined,desc:'A command-execution API was found. Injection risk depends on how arguments are constructed and whether a shell is involved.',code:commandLine>=0?lines[commandLine].trim().substring(0,120):'',confidence:'INFERENCE',confidenceReason:'API-use heuristic; attacker-controlled input flow and shell semantics were not proven.'});
            }
            if(codeContent.match(/console\.(log|debug|info)\(/)){
                var consoleCount=(codeContent.match(/console\.(log|debug|info)\(/g)||[]).length;
                if(consoleCount>3){
                    var debugSeverity=isArchitectureBackendPath(f.path)?'info':'low';
                    issues.push({severity:debugSeverity,title:'Debug Statements',file:f.name,path:f.path,desc:consoleCount+' console statements found. Remove before production.',code:''});
                }
            }
            // VBA-specific security checks
            var isVbaFile=/\.(?:vba|bas|cls|vb)$/i.test(f.path||f.name||'');
            if(isVbaFile&&codeContent.match(/SendKeys\s*\(/i)){
                issues.push({severity:'high',title:'SendKeys Usage',file:f.name,path:f.path,desc:'SendKeys can be exploited for code injection. Avoid using SendKeys.',code:''});
            }
            if(isVbaFile&&!isNonProductionPath(f.path)&&codeContent.match(/Shell\s*\(/i)){
                var shellLine=codeLines.findIndex(function(l){return /Shell\s*\(/i.test(l);});
                issues.push({severity:'high',title:'Shell Command Execution',file:f.name,path:f.path,line:shellLine>=0?shellLine+1:undefined,desc:'Shell() executes system commands. Review whether command text includes untrusted input.',code:shellLine>=0?lines[shellLine].trim().substring(0,120):'',confidence:'INFERENCE',confidenceReason:'VBA Shell API detected; command construction and user-controlled input are not proven.'});
            }
            if(isVbaFile&&codeContent.match(/CreateObject\s*\(/i)&&scanContent.match(/CreateObject\s*\(\s*["']WScript\.Shell["']/i)){
                var wscriptLine=codeLines.findIndex(function(l){return /CreateObject\s*\(/i.test(l);});
                issues.push({severity:'high',title:'WScript.Shell Creation',file:f.name,path:f.path,line:wscriptLine>=0?wscriptLine+1:undefined,desc:'Creating WScript.Shell object allows command execution. Review how command arguments are constructed.',code:wscriptLine>=0?lines[wscriptLine].trim().substring(0,120):'',confidence:'INFERENCE',confidenceReason:'VBA automation API detected; actual command execution and input control are not proven.'});
            }
            if(isVbaFile&&codeContent.match(/Application\.Run\s*\(/i)){
                issues.push({severity:'medium',title:'Dynamic Code Execution',file:f.name,path:f.path,desc:'Application.Run can execute arbitrary code. Validate input.',code:''});
            }
            if(isVbaFile&&codeContent.match(/On Error Resume Next/i)){
                var errorResumeCount=(codeContent.match(/On Error Resume Next/gi)||[]).length;
                if(errorResumeCount>2){
                    issues.push({severity:'medium',title:'Excessive Error Suppression',file:f.name,path:f.path,desc:errorResumeCount+' instances of "On Error Resume Next" found. This can hide bugs.',code:''});
                }
            }
            // TODO/FIXME comment mining is handled by quality.js, which scans comment tokens
            // directly. `scanContent` intentionally masks comments for security rules.
            // Python-specific security checks
            var securityFileName=String(f.name||f.path||'');
            var isPyFile=/\.(?:py|pyw)$/i.test(securityFileName);
            if(isPyFile&&codeContent){
                // eval() and exec() - arbitrary code execution
                if(/(?<![\w$.])eval\s*\(/.test(codeContent)){
                    var evalLine=codeLines.findIndex(function(l){return /(?<![\w$.])eval\s*\(/.test(l);});
                    issues.push({severity:'high',title:'Python eval()',file:f.name,path:f.path,line:evalLine>=0?evalLine+1:undefined,desc:'eval() executes arbitrary Python code. Use ast.literal_eval() for safe parsing.',code:evalLine>=0?lines[evalLine].trim().substring(0,80):''});
                }
                if(/(?<![\w$.])exec\s*\(/.test(codeContent)){
                    var execLine=codeLines.findIndex(function(l){return /(?<![\w$.])exec\s*\(/.test(l);});
                    issues.push({severity:'high',title:'Python exec()',file:f.name,path:f.path,line:execLine>=0?execLine+1:undefined,desc:'exec() executes arbitrary Python code. This is almost always a security risk.',code:execLine>=0?lines[execLine].trim().substring(0,80):''});
                }
                // pickle - deserialization attacks
                if(codeContent.match(/\bpickle\.load/)||codeContent.match(/\bunpickle/)){
                    issues.push({severity:'high',title:'Pickle Deserialization',file:f.name,path:f.path,desc:'pickle.load() can execute arbitrary code from untrusted data. Use JSON or safe alternatives.',code:''});
                }
                // subprocess with shell=True
                if(!isNonProductionPath(f.path)&&codeContent.match(/subprocess\.\w+\([^)]*shell\s*=\s*True/)){
                    issues.push({severity:'high',title:'Shell Injection Risk',file:f.name,path:f.path,desc:'subprocess with shell=True is vulnerable to command injection. Use shell=False with a list of args.',code:''});
                }
                // os.system / os.popen - command injection
                if(codeContent.match(/\bos\.system\s*\(/)||codeContent.match(/\bos\.popen\s*\(/)){
                    var osLine=codeLines.findIndex(function(l){return l.match(/\bos\.(system|popen)\s*\(/);});
                    issues.push({severity:'high',title:'OS Command Execution',file:f.name,path:f.path,line:osLine>=0?osLine+1:undefined,desc:'os.system()/os.popen() are vulnerable to command injection. Use subprocess with shell=False.',code:osLine>=0?lines[osLine].trim().substring(0,80):''});
                }
                // __import__ - dynamic imports
                // Literal module names are static imports in practice. A computed
                // name remains a candidate, not a proven user-controlled value.
                var importCall=/(?<![\w.])__import__\s*\(/g;
                var importMatch;
                while((importMatch=importCall.exec(codeContent))!==null){
                    var argument=(scanContent.slice(importCall.lastIndex).match(/^\s*(?:(['"])(?:\\.|(?!\1)[^\\])*?\1|([^,\n)]+))/)||[]);
                    if(argument[1]&&!argument[2])continue;
                    var importLine=codeContent.slice(0,importMatch.index).split('\n').length;
                    issues.push({severity:'medium',title:'Dynamic Import',file:f.name,path:f.path,line:importLine,desc:'__import__() with a computed module name may load unintended modules. Review the provenance of the argument.',code:lines[importLine-1]?.trim().substring(0,120)||'',confidence:'INFERENCE',confidenceReason:'Computed import argument, not evidence that the module name is user controlled.'});
                }
                // Bare except clauses
                var bareExcepts=(codeContent.match(/\bexcept\s*:/g)||[]).length;
                if(bareExcepts>2){
                    issues.push({severity:'medium',title:'Bare Except Clauses',file:f.name,path:f.path,desc:bareExcepts+' bare except: clauses found. These catch all exceptions including SystemExit and KeyboardInterrupt.',code:''});
                }
                // assert in non-test files
                if(!/test/i.test(String(f.name||''))&&!/test/i.test(String(f.path||''))){
                    var assertCount=(codeContent.match(/\bassert\s+/g)||[]).length;
                    if(assertCount>5){
                        issues.push({severity:'low',title:'Assert in Production',file:f.name,path:f.path,desc:assertCount+' assert statements found. Assertions are stripped with python -O. Use proper validation.',code:''});
                    }
                }
                // Hardcoded DEBUG = True
                if(codeContent.match(/\bDEBUG\s*=\s*True\b/)){
                    issues.push({severity:'medium',title:'Debug Mode Enabled',file:f.name,path:f.path,desc:'DEBUG = True found. Ensure this is disabled in production.',code:''});
                }
            }
        });
        return issues.sort(function(a,b){var sev={high:0,medium:1,low:2,info:3};return sev[a.severity]-sev[b.severity];});
    },
    // AST-based function extraction - accurate detection without false positives
    extract:function(content,filename,diagnostics){
        var fns=[];
        diagnostics=diagnostics||{};
        diagnostics.mode='heuristic-regex';
        var lines=content.split('\n');

        // Helper to extract code snippet for a function
        function extractCode(startLine,endLine){
            var code=[];
            var start=Math.max(0,startLine-1);
            var end=Math.min(lines.length,endLine||startLine+20);
            for(var i=start;i<end&&code.length<15;i++){
                code.push(lines[i]);
            }
            if(code.length>=15)code.push('  // ...');
            return code.join('\n');
        }

        // Track functions by line to allow same name at different locations
        var seenAtLine={};
        function addFn(fnObj){
            var key=fnObj.name+'@'+fnObj.line;
            // A legacy regex hit may identify a Java method correctly but
            // stop its span on the declaration line. The later masked lexical
            // pass can supply a properly bounded body for the *same* symbol.
            // Upgrade only on stronger evidence, never enlarge an AST result
            // or merge different methods that merely share a name.
            var existingIndex=seenAtLine[key];
            if (existingIndex !== undefined) {
                var prior=fns[existingIndex];
                var priorEnd=Number(prior.endLine)||Number(prior.line)||0;
                var nextEnd=Number(fnObj.endLine)||Number(fnObj.line)||0;
                var eligible=fnObj.extractionProvenance==='language-aware-lexical' &&
                    prior.extractionProvenance!=='tree-sitter-ast' &&
                    prior.extractionProvenance!=='ast' &&
                    fnObj.endLineConfidence==='bounded-heuristic' &&
                    nextEnd>priorEnd && nextEnd<=lines.length &&
                    fnObj.file===prior.file && fnObj.line===prior.line;
                if(eligible) {
                    fns[existingIndex]={...prior,...fnObj};
                }
                return;
            }
            seenAtLine[key]=fns.length;
            fns.push(fnObj);
        }

        var scriptBlocks=Parser.getEmbeddedCodeBlocks(content,filename,{includeHandlers:false}).filter(function(block){
            return block.kind==='script';
        });
        if(scriptBlocks.length){
            var blockModes=[];
            scriptBlocks.forEach(function(block){
                var blockDiagnostics={};
                Parser.extractJSFunctions(block.content,filename,block.offset,addFn,extractCode,block.isTS,blockDiagnostics);
                if(blockDiagnostics.mode)blockModes.push(blockDiagnostics.mode);
            });
            diagnostics.mode=blockModes.length&&blockModes.every(function(mode){return mode==='ast';})?'ast':
                (blockModes.some(function(mode){return mode!=='ast';})?'regex-fallback':'embedded-script');
            return fns;
        }
        if(Parser.isScriptContainer(filename)){
            diagnostics.mode='embedded-script-not-found';
            return fns;
        }

        // Only use a real syntax tree if an external Tree-sitter runtime and
        // grammar were explicitly configured and successfully initialized.
        // Lexical fallback remains honest when unavailable or unparsable.
        const astParser = Parser.getLoadedTreeSitterParser(filename);
        if (astParser && !/\.(?:js|jsx|mjs|cjs|ts|tsx|py|pyw|pyi)$/i.test(filename)) {
            const treeExtraction = extractLoadedTreeSitterFunctions(content, filename, astParser);
            if (treeExtraction.status === 'complete' && treeExtraction.functions.length) {
                treeExtraction.functions.forEach(addFn);
                diagnostics.mode = 'tree-sitter-ast';
                diagnostics.language = identifyCodeLanguage(filename);
                diagnostics.syntaxTreeNodes = treeExtraction.visitedNodes;
                diagnostics.semantics = treeExtraction.semantics;
                return fns;
            }
            diagnostics.astFallback = treeExtraction.status;
        }

        // Check file type
        var ext=filename.toLowerCase();
        var isJS=ext.endsWith('.js')||ext.endsWith('.jsx')||ext.endsWith('.mjs')||ext.endsWith('.cjs');
        var isTS=ext.endsWith('.ts')||ext.endsWith('.tsx')||ext.endsWith('.mts')||ext.endsWith('.cts');
        var isVue=ext.endsWith('.vue');
        var isSvelte=ext.endsWith('.svelte');
        var isPython=ext.endsWith('.py')||ext.endsWith('.pyw')||ext.endsWith('.pyi');

        // Extract script content from Vue/Svelte files
        var scriptContent=content;
        var scriptOffset=0;
        if(isVue||isSvelte){
            var scriptMatch=content.match(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/i);
            if(scriptMatch){
                scriptContent=scriptMatch[1];
                scriptOffset=content.substring(0,content.indexOf(scriptMatch[1])).split('\n').length-1;
                isJS=true;  // Treat extracted script as JS
                // Check if it's TypeScript
                if(content.match(/<script\b[^>]*\blang=["']ts["'][^>]*>/i)){
                    isTS=true;
                    isJS=false;
                }
            }else{
                // No script tag found
                return fns;
            }
            lines=scriptContent.split('\n');
        }

        // Try AST parsing for JS/TS files using real parsers
        if(isJS||isTS){
          if(typeof acorn!=='undefined'){
            var parseContent=scriptContent;
            var parseSuccess=false;

            // Use Babel (real parser) to handle JSX and TypeScript properly
            // Babel transforms JSX → React.createElement and strips TS types,
            // producing clean JS that acorn can parse into a proper AST
            if(typeof Babel!=='undefined'){
                try{
                    var babelPresets=['react'];
                    if(isTS)babelPresets.push('typescript');
                    var babelResult=Babel.transform(parseContent,{
                        presets:babelPresets,
                        filename:filename||'file.js',
                        sourceType:'module',
                        retainLines:true
                    });
                    parseContent=babelResult.code;
                }catch(babelErr){
                    // Babel failed, fall back to manual TypeScript stripping
                    if(isTS){
                        parseContent=Parser.stripTypeScript(scriptContent);
                    }
                }
            }else if(isTS){
                parseContent=Parser.stripTypeScript(scriptContent);
            }

            // Parse clean JS with acorn
            try{
                var ast=acorn.parse(parseContent,{
                    ecmaVersion:2022,
                    sourceType:'module',
                    allowHashBang:true,
                    allowAwaitOutsideFunction:true,
                    allowImportExportEverywhere:true,
                    allowReturnOutsideFunction:true,
                    locations:true
                });
                parseSuccess=true;

                // Walk the AST to find ALL function definitions
                function walk(node,scope,parentIsExport,currentClass){
                    if(!node||typeof node!=='object')return;

                    var isTopLevel=(scope===0);
                    var activeClass=(node.type==='ClassDeclaration'||node.type==='ClassExpression')
                        ? ((node.id&&node.id.name)||currentClass||null) : (currentClass||null);

                    // FunctionDeclaration: function foo() {}
                    if(node.type==='FunctionDeclaration'&&node.id&&node.id.name){
                        var line=(node.loc?node.loc.start.line:1)+scriptOffset;
                        var endLine=(node.loc?node.loc.end.line:line)+scriptOffset;
                        addFn({
                            name:node.id.name,
                            file:filename,
                            line:line,
                            code:extractCode(line,endLine),
                            endLine:endLine,
                            isTopLevel:isTopLevel,
                            isExported:parentIsExport||false,
                            type:'function'
                        });
                    }

                    // VariableDeclaration: const foo = () => {} or const foo = function() {}
                    if(node.type==='VariableDeclaration'){
                        node.declarations.forEach(function(decl){
                            if(decl.id&&decl.id.type==='Identifier'&&decl.init){
                                var init=decl.init;
                                // Direct function expression or arrow function ONLY
                                // NOT CallExpression (e.g., array.map(x => x))
                                if(init.type==='FunctionExpression'||init.type==='ArrowFunctionExpression'){
                                    var line=(decl.loc?decl.loc.start.line:1)+scriptOffset;
                                    var endLine=(decl.loc?decl.loc.end.line:line)+scriptOffset;
                                    addFn({
                                        name:decl.id.name,
                                        file:filename,
                                        line:line,
                                        code:extractCode(line,endLine),
                            endLine:endLine,
                                        isTopLevel:isTopLevel,
                                        isExported:parentIsExport||false,
                                        type:init.type==='ArrowFunctionExpression'?'arrow':'function'
                                    });
                                }
                            }
                        });
                    }

                    // MethodDefinition in classes
                    if(node.type==='MethodDefinition'&&node.key){
                        var name=node.key.name||node.key.value;
                        if(name&&name!=='constructor'){
                            var line=(node.loc?node.loc.start.line:1)+scriptOffset;
                            var endLine=(node.loc?node.loc.end.line:line)+scriptOffset;
                            addFn({
                                name:name,
                                file:filename,
                                line:line,
                                code:extractCode(line,endLine),
                            endLine:endLine,
                                isTopLevel:false,
                                isExported:false,
                                type:'method',
                                isClassMethod:true,
                                className:activeClass||undefined,
                                isGetter:node.kind==='get',
                                isSetter:node.kind==='set'
                            });
                        }
                    }

                    // Class fields can contain callable arrow/function values, e.g.
                    // class Store { save = async () => {...} }. Babel/Acorn model
                    // these as PropertyDefinition/FieldDefinition, not MethodDefinition.
                    // Only include *callable* initializers; ordinary data fields are not functions.
                    if((node.type==='PropertyDefinition'||node.type==='FieldDefinition'||node.type==='ClassProperty')&&
                        node.key&&node.value&&
                        (node.value.type==='ArrowFunctionExpression'||node.value.type==='FunctionExpression')){
                        var fieldName=node.computed?null:(node.key.name||node.key.value);
                        if(typeof fieldName==='string'&&fieldName){
                            var fieldLine=(node.loc?node.loc.start.line:1)+scriptOffset;
                            var fieldEnd=(node.loc?node.loc.end.line:fieldLine)+scriptOffset;
                            addFn({
                                name:fieldName,file:filename,line:fieldLine,endLine:fieldEnd,
                                code:extractCode(fieldLine,fieldEnd),isTopLevel:false,isExported:false,
                                type:'method',isClassMethod:true,className:activeClass||undefined,
                                extractionProvenance:'ast',extractionConfidence:'syntax-verified',
                                endLineConfidence:'ast'
                            });
                        }
                    }

                    // Property with method shorthand: { foo() {} }
                    if(node.type==='Property'&&node.method&&node.key){
                        var name=node.key.name||node.key.value;
                        if(name){
                            var line=(node.loc?node.loc.start.line:1)+scriptOffset;
                            var endLine=(node.loc?node.loc.end.line:line)+scriptOffset;
                            addFn({
                                name:name,
                                file:filename,
                                line:line,
                                code:extractCode(line,endLine),
                            endLine:endLine,
                                isTopLevel:false,
                                isExported:false,
                                type:'method'
                            });
                        }
                    }

                    // Property with function value: { foo: function() {} } or { foo: () => {} }
                    if(node.type==='Property'&&!node.method&&node.value&&node.key){
                        var val=node.value;
                        if(val.type==='FunctionExpression'||val.type==='ArrowFunctionExpression'){
                            var name=node.key.name||node.key.value;
                            if(name){
                                var line=(node.loc?node.loc.start.line:1)+scriptOffset;
                                var endLine=(node.loc?node.loc.end.line:line)+scriptOffset;
                                addFn({
                                    name:name,
                                    file:filename,
                                    line:line,
                                    code:extractCode(line,endLine),
                            endLine:endLine,
                                    isTopLevel:false,
                                    isExported:false,
                                    type:'method'
                                });
                            }
                        }
                    }

                    // Handle exports
                    var nextIsExport=false;
                    if(node.type==='ExportNamedDeclaration'||node.type==='ExportDefaultDeclaration'){
                        nextIsExport=true;
                        if(node.declaration){
                            walk(node.declaration,scope,true,activeClass);
                            return;
                        }
                    }

                    // Recurse - increase scope for function bodies
                    var newScope=scope;
                    if(node.type==='FunctionDeclaration'||node.type==='FunctionExpression'||
                       node.type==='ArrowFunctionExpression'||node.type==='ClassDeclaration'||
                       node.type==='ClassExpression'){
                        newScope=scope+1;
                    }

                    for(var key in node){
                        if(key==='loc'||key==='range'||key==='start'||key==='end'||key==='raw')continue;
                        var child=node[key];
                        // Class identity applies while traversing a class body,
                        // but does not leak into local functions declared inside a method.
                        var childClass = activeClass;
                        if(node.type==='MethodDefinition'&&key==='value')childClass=null;
                        if(node.type==='FunctionDeclaration'||node.type==='FunctionExpression'||node.type==='ArrowFunctionExpression')childClass=null;
                        if(Array.isArray(child)){
                            child.forEach(function(c){walk(c,newScope,nextIsExport,childClass);});
                        }else if(child&&typeof child==='object'&&child.type){
                            walk(child,newScope,nextIsExport,childClass);
                        }
                    }
                }

                walk(ast,0,false,null);

            }catch(e){
                // AST parsing failed
                parseSuccess=false;
            }

            // Record whether this file's function extraction came from the AST
            // or fell back to regex, so repository coverage can report uncertainty.
            diagnostics.mode=parseSuccess?'ast':'regex-fallback';
            if(!parseSuccess){
                Parser.extractWithRegex(scriptContent,filename,scriptOffset,addFn,extractCode);
            }
          } else {
            // Keep JavaScript/TypeScript extraction useful in environments where
            // the optional Acorn global is not loaded. This path is explicitly
            // reported as heuristic fallback and never claims AST coverage.
            diagnostics.mode='regex-fallback';
            Parser.extractWithRegex(scriptContent,filename,scriptOffset,addFn,extractCode);
          }
        }else if(isPython){
            diagnostics.mode='python-regex';
            // Python: extract classes, functions, async functions, decorators, and methods
            var classScopes=[];
            var functionScopes=[];
            var decorators=[];
            var pythonScanLines=Parser.stripPythonNonCode(content).split('\n');
            lines.forEach(function(line,idx){
                var scanLine=pythonScanLines[idx]||'';
                var trimmed=scanLine.trimStart();
                var indent=(scanLine.match(/^(\s*)/)||['',''])[1].length;
                // Dedentation closes nested defs/classes but not enclosing classes.
                // This is lexical ownership, not runtime type inference.
                if(trimmed){
                    while(functionScopes.length&&functionScopes[functionScopes.length-1]>=indent)functionScopes.pop();
                    while(classScopes.length&&classScopes[classScopes.length-1].indent>=indent)classScopes.pop();
                }

                // Track decorators
                if(trimmed.match(/^@\w/)){
                    decorators.push(line.trim());
                    return;
                }

                // Detect class definitions
                var classMatch=scanLine.match(/^(\s*)class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[\(:]?/);
                if(classMatch){
                    var cIndent=classMatch[1].length;
                    var localClassName=classMatch[2];
                    var className=classScopes.length&&!functionScopes.length
                        ?classScopes[classScopes.length-1].name+'.'+localClassName:localClassName;
                    var cEndLine=idx+1;
                    for(var i=idx+1;i<lines.length;i++){
                        var nl=pythonScanLines[i]||'';
                        if(nl.trim()==='')continue;
                        var ni=(nl.match(/^(\s*)/)||['',''])[1].length;
                        if(ni<=cIndent&&nl.trim()!==''){cEndLine=i;break;}
                        cEndLine=i+1;
                    }
                    var hasDecorator=decorators.length>0;
                    var isDataclass=decorators.some(function(d){return d.includes('dataclass');});
                    var isABC=scanLine.includes('ABC')||scanLine.includes('ABCMeta');
                    addFn({
                        name:className,
                        file:filename,
                        line:idx+1,
                        code:extractCode(idx+1,Math.min(idx+20,cEndLine)),
                        endLine:cEndLine,
                        isTopLevel:cIndent===0,
                        isExported:cIndent===0,
                        type:isDataclass?'dataclass':isABC?'abstract_class':'class',
                        decorators:hasDecorator?decorators.slice():undefined
                    });
                    classScopes.push({name:className,indent:cIndent});
                    decorators=[];
                    return;
                }

                // Active class context is the innermost enclosing class that
                // has not been closed by indentation.
                var currentClass=classScopes.length?classScopes[classScopes.length-1].name:null;
                var classIndent=classScopes.length?classScopes[classScopes.length-1].indent:-1;

                // Detect function/method definitions (including async def)
                var m=scanLine.match(/^(\s*)(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
                if(m){
                    var fIndent=m[1].length;
                    var name=m[2];
                    var isAsync=scanLine.match(/\basync\s+def\b/)!==null;
                    // A nested def inside a method is not itself a class method.
                    // Track the last enclosing def's indentation before binding.
                    // A local class nested *inside* a function still owns its
                    // own methods. Only defs nested in a function belonging
                    // to the current class are ordinary nested functions.
                    var nestedWithinFunction=functionScopes.some(function(fnIndent){return fnIndent>classIndent;});
                    var isMethod=currentClass!==null&&fIndent>classIndent&&!nestedWithinFunction;
                    functionScopes.push(fIndent);
                    var isDunder=name.startsWith('__')&&name.endsWith('__');
                    var isPrivate=name.startsWith('_')&&!isDunder;
                    var isSelf=scanLine.match(/def\s+\w+\s*\(\s*self[\s,)]/);
                    var isCls=scanLine.match(/def\s+\w+\s*\(\s*cls[\s,)]/);
                    var hasDecorator=decorators.length>0;
                    var isProperty=decorators.some(function(d){return d.includes('@property');});
                    var isStaticmethod=decorators.some(function(d){return d.includes('@staticmethod');});
                    var isClassmethod=decorators.some(function(d){return d.includes('@classmethod');});

                    var endLine=idx+1;
                    for(var i=idx+1;i<lines.length;i++){
                        var nextLine=pythonScanLines[i]||'';
                        if(nextLine.trim()==='')continue;
                        var nextIndent=(nextLine.match(/^(\s*)/)||['',''])[1].length;
                        if(nextIndent<=fIndent&&nextLine.trim()!=='') break;
                        // The function range ends at its last nonblank body line;
                        // trailing blank separators are not part of the function.
                        endLine=i+1;
                    }

                    var fnType='function';
                    if(isMethod){
                        if(isProperty)fnType='property';
                        else if(isStaticmethod)fnType='staticmethod';
                        else if(isClassmethod)fnType='classmethod';
                        else fnType='method';
                    }
                    if(isAsync)fnType='async_'+fnType;

                    addFn({
                        name:isMethod&&currentClass?currentClass+'.'+name:name,
                        file:filename,
                        line:idx+1,
                        code:extractCode(idx+1,endLine),
                        endLine:endLine,
                        isTopLevel:fIndent===0,
                        isExported:fIndent===0&&!isPrivate,
                        isClassMethod:isMethod,
                        type:fnType,
                        className:isMethod?currentClass:undefined,
                        decorators:hasDecorator?decorators.slice():undefined
                    });
                    decorators=[];
                }else if(!classMatch){
                    // Reset decorators if line is not a def or class
                    if(trimmed!==''&&!trimmed.startsWith('#')&&!trimmed.startsWith('@')){
                        decorators=[];
                    }
                }
            });
        }else{
            // Other languages: use language-specific regex
            diagnostics.mode='language-regex';
            Parser.extractOtherLanguages(content,filename,addFn,extractCode);
        }

         // Additive pass: annotation/keyword-generated methods (Lombok, data/case class, attr_*, @dataclass)
        extractSyntheticAccessors(content, filename, addFn, extractCode);

        // Deepen languages that previously had sparse/no declarations. Keep
        // existing AST/Python results authoritative at identical name+line.
        // Every supplemented symbol explicitly declares lexical provenance.
        if (!isJS && !isTS && !isPython) {
            const supplemental = extractLanguageFunctions(content, filename);
            if (supplemental.mode === 'language-aware-lexical') {
                supplemental.functions.forEach(addFn);
                diagnostics.mode = 'language-aware-lexical';
                diagnostics.language = supplemental.language;
                diagnostics.lexicalSupplementCount = supplemental.functions.length;
                diagnostics.semantics = 'Source-token declaration extraction, not compiler-grade binding or runtime proof.';
            }
        }
        return fns;
    },

    // Strip Python string literals and comments for accurate token-level analysis
    // This is a proper tokenizer approach: preserves code structure while removing non-code content
    stripPythonNonCode:function(content){
        var result=[];
        var i=0;
        var len=content.length;
        while(i<len){
            // Triple-quoted strings (must check before single quotes)
            if(i<len-2&&((content[i]==='"'&&content[i+1]==='"'&&content[i+2]==='"')||(content[i]==="'"&&content[i+1]==="'"&&content[i+2]==="'"))){
                var q3=content[i];
                i+=3;
                while(i<len-2){
                    if(content[i]===q3&&content[i+1]===q3&&content[i+2]===q3){i+=3;break;}
                    result.push(content[i]==='\n'?'\n':' ');
                    i++;
                }
            }
            // String prefixes (f/r/b/u and combinations like rb, fr, etc.)
            else if(i<len-1&&/^[frbuFRBU]{1,2}$/.test(content.slice(i,i+1+(content[i+1]&&/[frbuFRBU"']/.test(content[i+1])?1:0)).replace(/["']/g,''))&&
                    (content[i+1]==='"'||content[i+1]==="'"||content[i+2]==='"'||content[i+2]==="'")){
                // Skip prefix chars
                while(i<len&&content[i]!=='"'&&content[i]!=="'"){result.push(' ');i++;}
                // Fall through to string handling below (don't continue)
                if(i>=len)break;
                // Check for triple-quoted prefixed string
                if(i<len-2&&content[i+1]===content[i]&&content[i+2]===content[i]){
                    var pq3=content[i];i+=3;
                    while(i<len-2){
                        if(content[i]===pq3&&content[i+1]===pq3&&content[i+2]===pq3){i+=3;break;}
                        result.push(content[i]==='\n'?'\n':' ');i++;
                    }
                }else{
                    var pq=content[i];result.push(' ');i++;
                    while(i<len&&content[i]!==pq&&content[i]!=='\n'){
                        if(content[i]==='\\'){result.push(' ');i++;}
                        if(i<len){result.push(content[i]==='\n'?'\n':' ');i++;}
                    }
                    if(i<len&&content[i]===pq){result.push(' ');i++;}
                }
            }
            // Regular single/double quoted strings
            else if(content[i]==='"'||content[i]==="'"){
                var q=content[i];result.push(' ');i++;
                while(i<len&&content[i]!==q&&content[i]!=='\n'){
                    if(content[i]==='\\'){result.push(' ');i++;}
                    if(i<len){result.push(content[i]==='\n'?'\n':' ');i++;}
                }
                if(i<len&&content[i]===q){result.push(' ');i++;}
            }
            // Comments
            else if(content[i]==='#'){
                while(i<len&&content[i]!=='\n'){result.push(' ');i++;}
            }
            // Normal code - pass through
            else{
                result.push(content[i]);i++;
            }
        }
        return result.join('');
    },

    // Strip TypeScript syntax for Acorn parsing
    stripTypeScript:function(content){
        // Process line by line for more control
        var lines=content.split('\n');
        var result=[];
        var inInterface=false;
        var braceDepth=0;

        for(var i=0;i<lines.length;i++){
            var line=lines[i];

            // Skip type-only imports/exports
            if(line.match(/^\s*import\s+type\s/)||line.match(/^\s*export\s+type\s/)){
                result.push('');
                continue;
            }

            // Track interface/type blocks to skip
            if(line.match(/^\s*(?:export\s+)?interface\s+/)||line.match(/^\s*(?:export\s+)?type\s+\w+\s*=/)){
                inInterface=true;
                braceDepth=0;
            }

            if(inInterface){
                for(var j=0;j<line.length;j++){
                    if(line[j]==='{')braceDepth++;
                    if(line[j]==='}')braceDepth--;
                }
                if(braceDepth<=0&&(line.includes('}')||line.includes(';')||!line.match(/[{;]/))){
                    inInterface=false;
                }
                result.push('');
                continue;
            }

            // Remove type annotations carefully
            // Function params: (x: Type) -> (x)
            line=line.replace(/(\w)\s*:\s*[A-Za-z_$<>[\]|&\s,]+(?=[,\)])/g,'$1');
            // Return types: ): Type => -> ) =>  or ): Type { -> ) {
            line=line.replace(/\)\s*:\s*[A-Za-z_$<>[\]|&\s]+(?=\s*[{=>])/g,')');
            // Variable types: let x: Type = -> let x =
            line=line.replace(/(let|const|var)\s+(\w+)\s*:\s*[A-Za-z_$<>[\]|&\s]+\s*=/g,'$1 $2 =');
            // Generic type params: func<T>( -> func(
            // Apply repeatedly to handle nested or multiple occurrences
            var prevLine;
            do{
                prevLine=line;
                line=line.replace(/<[A-Za-z_$,\s]+>(?=\s*\()/g,'');
            }while(line!==prevLine);
            // As casts: x as Type -> x
            line=line.replace(/\s+as\s+[A-Za-z_$<>[\]|&\s]+(?=[,;\)\]\}]|$)/g,'');
            // Non-null assertions: x! -> x
            line=line.replace(/!(?=[\.\[\)\],;\s])/g,'');
            // Declare statements
            if(line.match(/^\s*declare\s+/)){
                result.push('');
                continue;
            }

            result.push(line);
        }

        return result.join('\n');
    },

    // Comprehensive regex fallback for JS/TS when AST fails
    extractWithRegex:function(content,filename,offset,addFn,extractCode){
        var lines=content.split('\n');
        var scanLines=maskSourceNonCode(content,filename).split('\n');
        var lineOffset=Number(offset)||0;
        lines.forEach(function(line,idx){
            var lineNum=idx+1+lineOffset;
            var scanLine=scanLines[idx]||'';
            var m;
            function endLine(name,kind){
                return estimateBracedEndLine(content,idx+1,name,kind,filename)+lineOffset;
            }

            // Named function declarations (capture export keyword for isExported).
            if((m=scanLine.match(/(export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/)))
                addFn({name:m[2],file:filename,line:lineNum,code:extractCode(lineNum,endLine(m[2],'function')),endLine:endLine(m[2],'function'),isTopLevel:true,isExported:!!m[1],type:'function'});

            // Arrow functions assigned to const/let/var at START of meaningful content.
            if((m=scanLine.match(/(export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/)))
                addFn({name:m[2],file:filename,line:lineNum,code:extractCode(lineNum,endLine(m[2],'arrow')),endLine:endLine(m[2],'arrow'),isTopLevel:true,isExported:!!m[1],type:'arrow'});

            // Arrow functions with single param (no parens): const foo = x =>
            if((m=scanLine.match(/(export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/)))
                addFn({name:m[2],file:filename,line:lineNum,code:extractCode(lineNum,endLine(m[2],'arrow')),endLine:endLine(m[2],'arrow'),isTopLevel:true,isExported:!!m[1],type:'arrow'});

            // Function expressions: const foo = function
            if((m=scanLine.match(/(export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?function\s*[(\w]/)))
                addFn({name:m[2],file:filename,line:lineNum,code:extractCode(lineNum,endLine(m[2],'function')),endLine:endLine(m[2],'function'),isTopLevel:true,isExported:!!m[1],type:'function'});

            // Class methods (inside class body): methodName() { or async methodName() {
            if((m=scanLine.match(/^\s+(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*\{/))&&!scanLine.match(/^\s*(if|for|while|switch|catch|function|const|let|var)\b/))
                addFn({name:m[1],file:filename,line:lineNum,code:extractCode(lineNum,endLine(m[1],'method')),endLine:endLine(m[1],'method'),isTopLevel:false,type:'method',isClassMethod:true});

            // Object method shorthand: foo() { or foo: function
            if((m=scanLine.match(/^\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(?:async\s+)?function/)))
                addFn({name:m[1],file:filename,line:lineNum,code:extractCode(lineNum,endLine(m[1],'function')),endLine:endLine(m[1],'function'),isTopLevel:false,type:'method'});

            // Object property arrow: foo: () =>
            if((m=scanLine.match(/^\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/)))
                addFn({name:m[1],file:filename,line:lineNum,code:extractCode(lineNum,endLine(m[1],'arrow')),endLine:endLine(m[1],'arrow'),isTopLevel:false,type:'method'});
        });
    },

    // Extract functions from other languages (best-effort regex fallback).
    // Scan a comment/string-masked view to avoid declarations fabricated by
    // examples in comments and strings. This is still not a compiler parser.
    extractOtherLanguages:function(content,filename,addFn,extractCode){
        var lines=content.split('\n');
        var scanLines=maskLanguageNonCode(content, identifyCodeLanguage(filename)).split('\n');
        var jvmLike=/\.(?:java|kt|kts|cs|scala|groovy)$/i.test(filename||'');
        var sourceBaseName=String(filename||'').split(/[\/]/).pop().replace(/\.[^.]+$/,'');
        var offsets=[], position=0;
        scanLines.forEach(function(row){offsets.push(position); position+=row.length+1;});
        var maskedSource=scanLines.join('\n');
        function nearestDeclaredType(lineIndex){
            for(var prior=lineIndex;prior>=0;prior--){
                var declaration=(scanLines[prior]||'').match(/\b(?:class|record|enum|interface|object|trait|struct)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
                if(declaration)return declaration[1];
            }
            return sourceBaseName;
        }

        lines.forEach(function(line,idx){
            var lineNum=idx+1;
            var scanLine=scanLines[idx]||'';
            var m;
            // Type declarations are not callable functions. The previous C/C++
            // fallback pattern also matched Java records such as `record RoleSeed(...)`.
            if(/\b(?:class|record|enum|interface|object|trait|struct|type)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*(?:[<(]|\{|$)/.test(scanLine))return;
            function addEstimated(name,type,isTopLevel,extra){
                var end=estimateBracedEndLine(content,lineNum,name,type,filename);
                addFn({name:name,file:filename,line:lineNum,code:extractCode(lineNum,end),endLine:end,isTopLevel:!!isTopLevel,type:type,...(extra||{})});
            }

            // Go: func name(
            if((m=scanLine.match(/^func\s+(?:\([^)]+\)\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/)))
                addEstimated(m[1],'function',true);

            // Java/C#/Kotlin: public void methodName( or similar. A constructor
            // has no return type and shares the enclosing class name; skip it as
            // a normal method node so it cannot pollute naming/dead-code metrics.
            if((m=scanLine.match(/(?:public|private|protected|internal|static|final|override|virtual|abstract|async)\s+(?:(?:static|final|override|virtual|abstract|async)\s+)*(?:\w+\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/))){
                var constructorName=nearestDeclaredType(idx-1);
                var bareConstructor=scanLine.match(/^\s*(?:(?:public|protected|private)\s+)?([A-Z_$][A-Za-z0-9_$]*)\s*\(/);
                var validJava=!/\.java$/i.test(filename||'') || isLikelyJavaDeclaration(scanLines,idx,m[1],maskedSource,offsets);
                if(validJava&&!(jvmLike&&((m[1]===constructorName)||(m[1]===sourceBaseName&&bareConstructor))))addEstimated(m[1],'method',false,{className:constructorName,isClassMethod:true});
            }

            // Kotlin: fun name(
            if((m=scanLine.match(/(?:suspend\s+)?fun\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/)))
                addEstimated(m[1],'function',true);

            // Ruby: def name (Ruby `end` blocks do not use braces, so line is the safe range.)
            if((m=scanLine.match(/^\s*def\s+([a-zA-Z_][a-zA-Z0-9_?!]*)/)))
                addFn({name:m[1],file:filename,line:lineNum,code:extractCode(lineNum),endLine:lineNum,isTopLevel:true,type:'function',endLineConfidence:'declaration-line-only'});

            // Rust: fn name or pub fn name
            if((m=scanLine.match(/(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/)))
                addEstimated(m[1],'function',true);

            // PHP: function name( or public function name(
            if((m=scanLine.match(/(?:public|private|protected|static)?\s*function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/)))
                addEstimated(m[1],'function',true);

            // C/C++: type name( at start or with visibility
            if(/\.(?:c|cc|cpp|cxx|h|hpp|hh|hxx)$/i.test(filename||'') && (m=scanLine.match(/^(?:static\s+)?(?:inline\s+)?(?:virtual\s+)?(?:\w+\s+)+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^;]*$/)))
                if(!scanLine.match(/^\s*(if|for|while|switch|return|sizeof|typeof)\b/))
                    addEstimated(m[1],'function',true);

            // Swift: func name
            if((m=scanLine.match(/(?:public|private|internal|fileprivate|open)?\s*(?:static\s+)?(?:class\s+)?func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/)))
                addEstimated(m[1],'function',true);

            // Scala: def name
            if((m=scanLine.match(/\bdef\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[(\[]/)))
                addEstimated(m[1],'function',true);

            // Elixir: def name or defp name
            if((m=scanLine.match(/\bdefp?\s+([a-zA-Z_][a-zA-Z0-9_?!]*)/)))
                addFn({name:m[1],file:filename,line:lineNum,code:extractCode(lineNum),endLine:lineNum,isTopLevel:true,type:'function',endLineConfidence:'declaration-line-only'});

            // Lua: function name( or local function name(
            if((m=scanLine.match(/(?:local\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_.:]*)\s*\(/)))
                addEstimated(m[1].split(/[.:]/).pop(),'function',true);

            // VBA: Sub Name() or Function Name()
            if((m=scanLine.match(/(?:Public|Private|Friend)?\s*(?:Sub|Function)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/i)))
                addFn({name:m[1],file:filename,line:lineNum,code:extractCode(lineNum),endLine:lineNum,isTopLevel:true,type:'function',endLineConfidence:'declaration-line-only'});
        });
    },

    extractJSFunctions:function(content,filename,offset,addFn,extractCode,isTS,diagnostics){
        diagnostics=diagnostics||{};
        if(!content||!content.trim()){diagnostics.mode='empty';return;}
        if(typeof acorn!=='undefined'){
            var parseContent=content;
            var parseSuccess=false;

            if(typeof Babel!=='undefined'){
                try{
                    var babelPresets=['react'];
                    if(isTS)babelPresets.push('typescript');
                    var babelResult=Babel.transform(parseContent,{
                        presets:babelPresets,
                        filename:filename||'file.js',
                        sourceType:'module',
                        retainLines:true
                    });
                    parseContent=babelResult.code;
                }catch(babelErr){
                    if(isTS){
                        parseContent=Parser.stripTypeScript(content);
                    }
                }
            }else if(isTS){
                parseContent=Parser.stripTypeScript(content);
            }

            try{
                var ast=acorn.parse(parseContent,{
                    ecmaVersion:2022,
                    sourceType:'module',
                    allowHashBang:true,
                    allowAwaitOutsideFunction:true,
                    allowImportExportEverywhere:true,
                    allowReturnOutsideFunction:true,
                    locations:true
                });
                parseSuccess=true;

                function walk(node,scope,parentIsExport){
                    if(!node||typeof node!=='object')return;
                    var isTopLevel=(scope===0);

                    if(node.type==='FunctionDeclaration'&&node.id&&node.id.name){
                        var line=(node.loc?node.loc.start.line:1)+offset;
                        var endLine=(node.loc?node.loc.end.line:line)+offset;
                        addFn({
                            name:node.id.name,
                            file:filename,
                            line:line,
                            code:extractCode(line,endLine),
                            endLine:endLine,
                            isTopLevel:isTopLevel,
                            isExported:parentIsExport||false,
                            type:'function'
                        });
                    }

                    if(node.type==='VariableDeclaration'){
                        node.declarations.forEach(function(decl){
                            if(decl.id&&decl.id.type==='Identifier'&&decl.init){
                                var init=decl.init;
                                if(init.type==='FunctionExpression'||init.type==='ArrowFunctionExpression'){
                                    var line=(decl.loc?decl.loc.start.line:1)+offset;
                                    var endLine=(decl.loc?decl.loc.end.line:line)+offset;
                                    addFn({
                                        name:decl.id.name,
                                        file:filename,
                                        line:line,
                                        code:extractCode(line,endLine),
                            endLine:endLine,
                                        isTopLevel:isTopLevel,
                                        isExported:parentIsExport||false,
                                        type:init.type==='ArrowFunctionExpression'?'arrow':'function'
                                    });
                                }
                            }
                        });
                    }

                    if(node.type==='MethodDefinition'&&node.key){
                        var methodName=node.key.name||(node.key.value!=null?String(node.key.value):null);
                        if(methodName&&methodName!=='constructor'){
                            var methodLine=(node.loc?node.loc.start.line:1)+offset;
                            var methodEndLine=(node.loc?node.loc.end.line:methodLine)+offset;
                            addFn({
                                name:methodName,
                                file:filename,
                                line:methodLine,
                                code:extractCode(methodLine,methodEndLine),
                                isTopLevel:false,
                                isExported:false,
                                type:'method',
                                isClassMethod:true,
                                isGetter:node.kind==='get',
                                isSetter:node.kind==='set'
                            });
                        }
                    }

                    if(node.type==='Property'&&node.method&&node.key){
                        var shorthandName=node.key.name||(node.key.value!=null?String(node.key.value):null);
                        if(shorthandName){
                            var shorthandLine=(node.loc?node.loc.start.line:1)+offset;
                            var shorthandEndLine=(node.loc?node.loc.end.line:shorthandLine)+offset;
                            addFn({
                                name:shorthandName,
                                file:filename,
                                line:shorthandLine,
                                code:extractCode(shorthandLine,shorthandEndLine),
                                isTopLevel:false,
                                isExported:false,
                                type:'method'
                            });
                        }
                    }

                    if(node.type==='Property'&&!node.method&&node.value&&node.key){
                        var val=node.value;
                        if(val.type==='FunctionExpression'||val.type==='ArrowFunctionExpression'){
                            var propName=node.key.name||(node.key.value!=null?String(node.key.value):null);
                            if(propName){
                                var propLine=(node.loc?node.loc.start.line:1)+offset;
                                var propEndLine=(node.loc?node.loc.end.line:propLine)+offset;
                                addFn({
                                    name:propName,
                                    file:filename,
                                    line:propLine,
                                    code:extractCode(propLine,propEndLine),
                                    isTopLevel:false,
                                    isExported:false,
                                    type:'method'
                                });
                            }
                        }
                    }

                    var nextIsExport=false;
                    if(node.type==='ExportNamedDeclaration'||node.type==='ExportDefaultDeclaration'){
                        nextIsExport=true;
                        if(node.declaration){
                            walk(node.declaration,scope,true);
                            return;
                        }
                    }

                    var newScope=scope;
                    if(node.type==='FunctionDeclaration'||node.type==='FunctionExpression'||
                       node.type==='ArrowFunctionExpression'||node.type==='ClassDeclaration'||
                       node.type==='ClassExpression'){
                        newScope=scope+1;
                    }

                    for(var key in node){
                        if(key==='loc'||key==='range'||key==='start'||key==='end'||key==='raw')continue;
                        var child=node[key];
                        if(Array.isArray(child)){
                            child.forEach(function(c){walk(c,newScope,nextIsExport);});
                        }else if(child&&typeof child==='object'&&child.type){
                            walk(child,newScope,nextIsExport);
                        }
                    }
                }

                walk(ast,0,false);
            }catch(e){
                parseSuccess=false;
            }

            diagnostics.mode=parseSuccess?'ast':'regex-fallback';
            if(!parseSuccess){
                Parser.extractWithRegex(content,filename,offset,addFn,extractCode);
            }
            return;
        }

        diagnostics.mode='regex-fallback';
        Parser.extractWithRegex(content,filename,offset,addFn,extractCode);
    },
    findJSCalls:function(content,fnNames,defLines,options){
        fnNames=Parser.candidateFunctionNames(content,fnNames);
        var calls={};
        var refs={};
        if(!fnNames.length)return calls;
        fnNames.forEach(function(fn){calls[fn]=0;refs[fn]=0;});

        var sourceType=options&&options.sourceType==='script'?'script':'module';
        var isTS=!!(options&&options.isTS);

        if(typeof acorn!=='undefined'){
            try{
                var jsContent=content;
                if(typeof Babel!=='undefined'){
                    try{
                        var babelPresets=['react'];
                        if(isTS)babelPresets.push('typescript');
                        var babelResult=Babel.transform(content,{
                            presets:babelPresets,
                            filename:options&&options.filename?options.filename:'file.js',
                            sourceType:sourceType,
                            retainLines:true
                        });
                        jsContent=babelResult.code;
                    }catch(babelErr){
                        jsContent=isTS?Parser.stripTypeScript(content):content;
                    }
                }else if(isTS){
                    jsContent=Parser.stripTypeScript(content);
                }

                var ast=acorn.parse(jsContent,{
                    ecmaVersion:2022,
                    sourceType:sourceType,
                    allowHashBang:true,
                    allowAwaitOutsideFunction:true,
                    allowImportExportEverywhere:true,
                    allowReturnOutsideFunction:true,
                    locations:true,
                    tolerant:true
                });
                var fnSet=new Set(fnNames);

                function walk(node,inDeclaration){
                    if(!node||typeof node!=='object')return;
                    var isDecl=node.type==='FunctionDeclaration'||node.type==='VariableDeclarator';

                    if(node.type==='CallExpression'){
                        var callee=node.callee;
                        if(callee.type==='Identifier'&&fnSet.has(callee.name)){
                            var line=callee.loc?callee.loc.start.line:0;
                            if(!defLines[callee.name]||defLines[callee.name]!==line){
                                calls[callee.name]++;
                            }
                        }
                        node.arguments.forEach(function(arg){
                            if(arg.type==='Identifier'&&fnSet.has(arg.name)){
                                refs[arg.name]++;
                            }
                        });
                    }

                    if(node.type==='ArrayExpression'){
                        node.elements.forEach(function(el){
                            if(el&&el.type==='Identifier'&&fnSet.has(el.name)){
                                refs[el.name]++;
                            }
                        });
                    }
                    if(node.type==='Property'&&node.value&&node.value.type==='Identifier'&&fnSet.has(node.value.name)){
                        refs[node.value.name]++;
                    }

                    if(node.type==='Identifier'&&fnSet.has(node.name)&&!inDeclaration){
                        // Identifier references are handled via the surrounding parent nodes.
                    }

                    for(var key in node){
                        if(key==='loc'||key==='range'||key==='start'||key==='end')continue;
                        var child=node[key];
                        var nextInDecl=isDecl&&(key==='id'||key==='key');
                        if(Array.isArray(child)){
                            child.forEach(function(c){walk(c,nextInDecl);});
                        }else if(child&&typeof child==='object'&&child.type){
                            walk(child,nextInDecl);
                        }
                    }
                }

                walk(ast,false);
                fnNames.forEach(function(fn){
                    calls[fn]=calls[fn]+(refs[fn]||0);
                });
                return calls;
            }catch(e){
                // Fall back to regex below.
            }
        }

        return Parser.countCandidateCalls(content,fnNames,{isJS:true});
    },

    buildFunctionNameIndex:function(fnNames){
        var exact=new Set();
        var byBase=Object.create(null);
        (fnNames||[]).forEach(function(fn){
            if(typeof fn!=='string'||!fn)return;
            exact.add(fn);
            if(fn.indexOf('.')>=0){
                var parts=fn.split('.');
                var base=parts[parts.length-1];
                if(!byBase[base])byBase[base]=[];
                byBase[base].push(fn);
            }
        });
        return{exact:exact,byBase:byBase};
    },

    buildFunctionDefLineIndex:function(fnDefs){
        var byFile=Object.create(null);
        (fnDefs||[]).forEach(function(fn){
            if(!byFile[fn.file])byFile[fn.file]=Object.create(null);
            byFile[fn.file][fn.name]=fn.line;
        });
        return byFile;
    },

    functionKey:function(fn){
        if(!fn)return'';
        return [fn.file||'',fn.line||'',String(fn.name==null?'':fn.name)].join('|');
    },

    buildFunctionDefinitionIndex:function(fnDefs){
        var byName=Object.create(null);
        var byKey=Object.create(null);
        (fnDefs||[]).forEach(function(fn){
            if(!fn||typeof fn.name!=='string'||!fn.name)return;
            var key=Parser.functionKey(fn);
            fn.key=key;
            if(byKey[key])return;
            byKey[key]=fn;
            if(!byName[fn.name])byName[fn.name]=[];
            byName[fn.name].push(fn);
        });
        return{byName:byName,byKey:byKey};
    },

    resolveCallGraphImportPath:function(importPath,fromFile,files){
        if(!importPath||/^(?:node:|https?:|data:|mailto:)/i.test(importPath))return null;
        var fromPath=String(fromFile||'').replace(/\\/g,'/').replace(/^\/+/,'');
        var fromDir=fromPath.indexOf('/')>=0?fromPath.split('/').slice(0,-1).join('/'):'';
        var fromExt=(fromPath.split('.').pop()||'').toLowerCase();
        var isPython=['py','pyw','pyi'].indexOf(fromExt)>=0;
        var candidates=[];
        function normalizePath(path){
            var out=[];
            String(path||'').replace(/\\/g,'/').split('/').forEach(function(part){
                if(!part||part==='.')return;
                if(part==='..')out.pop();
                else out.push(part);
            });
            return out.join('/');
        }
        function addCandidate(path){
            path=normalizePath(path);
            if(path&&candidates.indexOf(path)<0)candidates.push(path);
        }

        if(importPath.startsWith('@/'))addCandidate('src/'+importPath.slice(2));
        else if(importPath.startsWith('~/'))addCandidate('src/'+importPath.slice(2));
        else if(importPath.startsWith('./')||importPath.startsWith('../'))addCandidate((fromDir?fromDir+'/':'')+importPath);
        else if(isPython&&/^\.+/.test(importPath)){
            var dotCount=(importPath.match(/^\.+/)||[''])[0].length;
            var rest=importPath.slice(dotCount).replace(/\./g,'/');
            var parts=fromDir?fromDir.split('/'):[];
            for(var di=1;di<dotCount;di++)parts.pop();
            addCandidate(parts.concat(rest?rest.split('/'):[]).join('/'));
        }else if(isPython){
            var modulePath=importPath.replace(/\./g,'/');
            addCandidate((fromDir?fromDir+'/':'')+modulePath);
            addCandidate(modulePath);
        }else{
            return null;
        }

        var pathMap=Object.create(null);
        (files||[]).forEach(function(file){
            var p=String(file.path||file.name||'').replace(/\\/g,'/').replace(/^\/+/,'');
            if(p)pathMap[p.toLowerCase()]=p;
        });
        var exts=['','.js','.jsx','.ts','.tsx','.mts','.cts','.mjs','.cjs','.vue','.svelte','.py','.pyw','.pyi','.vba','.bas','.cls','/index.js','/index.jsx','/index.ts','/index.tsx','/__init__.py'];
        for(var i=0;i<candidates.length;i++){
            for(var j=0;j<exts.length;j++){
                var candidate=normalizePath(candidates[i]+exts[j]).toLowerCase();
                if(pathMap[candidate])return pathMap[candidate];
            }
        }
        return null;
    },

    extractCallGraphImportMap:function(content,fromFile,files){
        var locals=Object.create(null);
        var targets=new Set();
        function addLocal(localName,resolved){
            if(!localName||!resolved)return;
            if(!locals[localName])locals[localName]=new Set();
            locals[localName].add(resolved);
            targets.add(resolved);
        }
        function addTarget(resolved){
            if(resolved)targets.add(resolved);
        }
        function parseImportNames(spec,resolved){
            (spec||'').split(',').forEach(function(part){
                part=part.trim().replace(/^type\s+/,'').trim();
                if(!part||part==='default')return;
                var alias=part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
                if(alias){addLocal(alias[2],resolved);return;}
                var destructured=part.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/);
                if(destructured){addLocal(destructured[2],resolved);return;}
                var name=part.match(/^([A-Za-z_$][\w$]*)$/);
                if(name)addLocal(name[1],resolved);
            });
        }
        function parseJsImportSpec(spec,resolved){
            spec=(spec||'').trim().replace(/^type\s+/,'').trim();
            if(!spec)return;
            var named=spec.match(/\{([\s\S]*?)\}/);
            if(named)parseImportNames(named[1],resolved);
            var ns=spec.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
            if(ns)addLocal(ns[1],resolved);
            var defaultPart=spec.split('{')[0].split('*')[0].split(',')[0].trim();
            if(/^[A-Za-z_$][\w$]*$/.test(defaultPart))addLocal(defaultPart,resolved);
        }

        var source=String(content||'');
        var match;
        var jsImportRe=/\bimport\s+(?!\()([\s\S]*?)\s+from\s*['"`]([^'"`]+)['"`]/g;
        while((match=jsImportRe.exec(source))!==null){
            var importSpec=match[1]||'';
            if(/^\s*type\b/.test(importSpec))continue;
            var resolved=Parser.resolveCallGraphImportPath(match[2],fromFile,files);
            addTarget(resolved);
            parseJsImportSpec(importSpec,resolved);
        }
        var cjsNamedRe=/\b(?:const|let|var)\s+\{([\s\S]*?)\}\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
        while((match=cjsNamedRe.exec(source))!==null){
            var namedResolved=Parser.resolveCallGraphImportPath(match[2],fromFile,files);
            addTarget(namedResolved);
            parseImportNames(match[1],namedResolved);
        }
        var cjsDefaultRe=/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
        while((match=cjsDefaultRe.exec(source))!==null){
            var defaultResolved=Parser.resolveCallGraphImportPath(match[2],fromFile,files);
            addLocal(match[1],defaultResolved);
        }

        var pyFromRe=/^\s*from\s+([.\w]+)\s+import\s+([^\n#]+)/gm;
        while((match=pyFromRe.exec(source))!==null){
            var pyResolved=Parser.resolveCallGraphImportPath(match[1],fromFile,files);
            addTarget(pyResolved);
            parseImportNames(match[2].replace(/[()]/g,''),pyResolved);
        }
        var pyImportRe=/^\s*import\s+([^\n#]+)/gm;
        while((match=pyImportRe.exec(source))!==null){
            match[1].split(',').forEach(function(part){
                part=part.trim();
                var pieces=part.split(/\s+as\s+/);
                var moduleName=(pieces[0]||'').trim();
                var localName=(pieces[1]||moduleName.split('.').pop()||'').trim();
                var moduleResolved=Parser.resolveCallGraphImportPath(moduleName,fromFile,files);
                addLocal(localName,moduleResolved);
            });
        }

        var localFiles=Object.create(null);
        Object.keys(locals).forEach(function(name){
            localFiles[name]=Array.from(locals[name]);
        });
        return{locals:localFiles,targets:targets};
    },

    candidateFunctionNames:function(content,fnNames,fnIndex){
        if(!content||!fnNames||!fnNames.length)return[];
        if(fnNames.length<=Parser._callCandidateThreshold)return fnNames;
        var wordSet=new Set(String(content).match(/\b[a-zA-Z_$][\w$]*\b/g)||[]);
        if(!wordSet.size)return[];
        var index=fnIndex||Parser.buildFunctionNameIndex(fnNames);
        var out=[];
        var seen=new Set();
        wordSet.forEach(function(word){
            if(index.exact.has(word)&&!seen.has(word)){
                seen.add(word);
                out.push(word);
            }
            var baseMatches=index.byBase[word];
            if(baseMatches){
                baseMatches.forEach(function(fn){
                    if(!seen.has(fn)){
                        seen.add(fn);
                        out.push(fn);
                    }
                });
            }
        });
        return out;
    },

    countCandidateCalls:function(content,fnNames,options){
        var calls=Object.create(null);
        var refs=Object.create(null);
        var candidateSet=new Set(fnNames||[]);
        var rawSource=String(content||'');
        var opts=options||{};
        var source=opts.isPython ? Parser.stripPythonNonCode(rawSource) : maskNonCodeForFallback(rawSource,opts);
        fnNames.forEach(function(fn){calls[fn]=0;refs[fn]=0;});
        if(!source||!candidateSet.size)return calls;

        var tokenRe=/\b[a-zA-Z_$][\w$]*\b/g;
        var match;
        while((match=tokenRe.exec(source))!==null){
            var name=match[0];
            if(!candidateSet.has(name))continue;
            var start=match.index;
            var end=start+name.length;
            var prev=start-1;
            while(prev>=0&&/\s/.test(source[prev]))prev--;
            var next=end;
            while(next<source.length&&/\s/.test(source[next]))next++;
            var nextChar=source[next]||'';
            var prevChar=prev>=0?source[prev]:'';
            var lineStart=source.lastIndexOf('\n',start-1)+1;
            var prefix=source.slice(lineStart,start);
            var isDefinition=false;
            if(/\b(function|class|def)\s*$/.test(prefix))isDefinition=true;
            if(opts.isPython&&/\b(async\s+def|def|class)\s*$/.test(prefix))isDefinition=true;
            if(opts.isVBA&&/\b(Sub|Function)\s+$/i.test(prefix))isDefinition=true;
            if(opts.isJava&&nextChar==='('){
                // The token fallback must not count `public void charge(` as a call
                // to charge. Strip common Java modifiers/annotations and recognize a
                // return-type + method-name prefix, while excluding statement keywords.
                var javaPrefix=prefix
                    .replace(/^\s*(?:@[A-Za-z_$][\w.$]*(?:\([^)]*\))?\s*)*/, '')
                    .replace(/^\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|default|transient|volatile|sealed|non-sealed)\s+)*/, '');
                var isJavaStatementPrefix=/^\s*(?:return|throw|new|if|while|for|switch|case|catch|yield|assert|do|else)\b/.test(prefix);
                if(!isJavaStatementPrefix&&/^\s*(?:<[^>]+>\s*)?(?:[A-Za-z_$][\w.$<>?,\[\]|&]*\s+)+$/.test(javaPrefix))isDefinition=true;
            }
            if(nextChar==='('&&!isDefinition){
                calls[name]++;
            }else if(!isDefinition&&'[,[:(={'.indexOf(prevChar)>=0&&' ,])};\n\r'.indexOf(nextChar)>=0){
                refs[name]++;
            }else if(opts.isPython&&prevChar==='@'&&!isDefinition){
                refs[name]++;
            }
        }

        if(opts.isJS&&source.indexOf('<')>=0){
            var jsxTagRe=/<\/?\s*([A-Za-z_$][\w$]*)[\s>\/{]/g;
            while((match=jsxTagRe.exec(source))!==null){
                if(candidateSet.has(match[1]))refs[match[1]]++;
            }
            var jsxExprRe=/[{=]\s*([A-Za-z_$][\w$]*)\s*[}(,;\s]/g;
            while((match=jsxExprRe.exec(source))!==null){
                if(candidateSet.has(match[1]))refs[match[1]]++;
            }
        }

        if(opts.isVBA){
            // VBA can dispatch macros by a string name; this is intentionally
            // checked against the original source after ordinary string masking.
            var vbaRunRe=/Application\.Run\s*["']([A-Za-z_]\w*)["']/gi;
            while((match=vbaRunRe.exec(rawSource))!==null){
                if(candidateSet.has(match[1]))calls[match[1]]++;
            }
        }

        fnNames.forEach(function(fn){
            calls[fn]=Math.max(0,calls[fn]||0)+(refs[fn]||0);
        });
        return calls;
    },

    // AST-based call detection - finds actual function calls and references
    findCalls:function(content,fnNames,definingFile,fnDefs,fnIndex){
        fnNames=Parser.candidateFunctionNames(content,fnNames,fnIndex);
        var calls={};
        var refs={};  // Functions used as callbacks/references without ()
        if(!fnNames.length)return calls;
        fnNames.forEach(function(fn){calls[fn]=0;refs[fn]=0;});

        // Build a set of definition lines to exclude
        var defLines={};
        if(fnDefs&&!Array.isArray(fnDefs)){
            defLines=fnDefs[definingFile]||{};
        }else if(fnDefs){
            fnDefs.forEach(function(fn){
                if(fn.file===definingFile){
                    defLines[fn.name]=fn.line;
                }
            });
        }

        if(Parser.isScriptContainer(definingFile)){
            var blocks=Parser.getEmbeddedCodeBlocks(content,definingFile,{includeHandlers:true});
            if(!blocks.length)return calls;
            blocks.forEach(function(block){
                var blockCalls=Parser.findJSCalls(block.content,fnNames,defLines,{
                    filename:definingFile,
                    isTS:block.isTS,
                    sourceType:block.kind==='handler'?'script':block.sourceType
                });
                fnNames.forEach(function(fn){
                    calls[fn]+=blockCalls[fn]||0;
                });
            });
            return calls;
        }

        // Detect file language from defining file extension
        var ext=definingFile?definingFile.split('.').pop().toLowerCase():'';
        var isPython=['py','pyw','pyi'].indexOf(ext)>=0;
        var isJS=['js','jsx','ts','tsx','mjs','cjs','vue','svelte'].indexOf(ext)>=0;
        var isVBA=['vba','bas','cls','xlsm','xlam'].indexOf(ext)>=0;

        // Python: use tree-sitter real parser (WASM) for accurate AST-based detection
        if(isPython){
            var tsParser=Parser.getLoadedTreeSitterParser(definingFile);
            if(tsParser){
                try{
                    var tree=tsParser.parse(content);
                    var root=tree.rootNode;
                    var fnSet=new Set(fnNames);

                    // Count only a `call` node with a direct identifier callee.
                    // Assignments, type annotations, return references, decorator
                    // names and object.method() are NOT direct function calls.
                    // Receiver calls are handled separately by callGraph.js.
                    function walkPy(node){
                        if(node.type==='call'){
                            var callee=node.childForFieldName?.('function');
                            if(callee?.type==='identifier'&&fnSet.has(callee.text)){
                                calls[callee.text]++;
                            }
                        }
                        for(var i=0;i<node.childCount;i++) walkPy(node.child(i));
                    }
                    walkPy(root);
                    tree.delete();
                    return calls;
                }catch(tsErr){
                    // tree-sitter parse failed, fall through to tokenizer fallback
                }
            }

            // Fallback: token-level analysis with string/comment stripping
            var cleanContent=Parser.stripPythonNonCode(content);
            return Parser.countCandidateCalls(cleanContent,fnNames,{isPython:true});
        }

        if(isJS&&typeof acorn!=='undefined'){
            try{
                // Use Babel (real parser) to handle JSX and TypeScript
                // Babel transforms JSX → React.createElement calls and strips TS types,
                // so acorn can parse the result into a proper AST for accurate call detection
                var jsContent=content;
                if(typeof Babel!=='undefined'){
                    try{
                        var babelPresets=['react'];
                        if(ext==='ts'||ext==='tsx')babelPresets.push('typescript');
                        var babelResult=Babel.transform(content,{
                            presets:babelPresets,
                            filename:definingFile||'file.js',
                            sourceType:'module',
                            retainLines:true
                        });
                        jsContent=babelResult.code;
                    }catch(babelErr){
                        // Babel failed, fall back to manual TypeScript stripping
                        jsContent=content
                            .replace(/:\s*[A-Za-z_$][\w$<>,\s|&\[\]]*(?=\s*[=,\)\}\];])/g,'')
                            .replace(/\bas\s+[A-Za-z_$][\w$<>,\s|&\[\]]*(?=\s*[,\)\}\];])/g,'')
                            .replace(/<[A-Za-z_$][\w$<>,\s|&\[\]]*>(?=\s*\()/g,'')
                            .replace(/^import\s+type\s+.*/gm,'')
                            .replace(/^export\s+type\s+.*/gm,'')
                            .replace(/^export\s+interface\s+.*/gm,'')
                            .replace(/interface\s+[A-Za-z_$][\w$]*\s*\{[^}]*\}/g,'')
                            .replace(/type\s+[A-Za-z_$][\w$]*\s*=\s*[^;]+;/g,'');
                    }
                }else{
                    jsContent=content
                        .replace(/:\s*[A-Za-z_$][\w$<>,\s|&\[\]]*(?=\s*[=,\)\}\];])/g,'')
                        .replace(/\bas\s+[A-Za-z_$][\w$<>,\s|&\[\]]*(?=\s*[,\)\}\];])/g,'')
                        .replace(/<[A-Za-z_$][\w$<>,\s|&\[\]]*>(?=\s*\()/g,'')
                        .replace(/^import\s+type\s+.*/gm,'')
                        .replace(/^export\s+type\s+.*/gm,'')
                        .replace(/^export\s+interface\s+.*/gm,'')
                        .replace(/interface\s+[A-Za-z_$][\w$]*\s*\{[^}]*\}/g,'')
                        .replace(/type\s+[A-Za-z_$][\w$]*\s*=\s*[^;]+;/g,'');
                }

                var ast=acorn.parse(jsContent,{
                    ecmaVersion:2022,
                    sourceType:'module',
                    allowHashBang:true,
                    allowAwaitOutsideFunction:true,
                    allowImportExportEverywhere:true,
                    locations:true,
                    tolerant:true
                });

                var fnSet=new Set(fnNames);

                function walk(node,inDeclaration){
                    if(!node||typeof node!=='object')return;

                    // Track if we're in a function declaration to skip counting the name
                    var isDecl=node.type==='FunctionDeclaration'||node.type==='VariableDeclarator';

                    // CallExpression: foo() or foo.bar()
                    if(node.type==='CallExpression'){
                        var callee=node.callee;
                        if(callee.type==='Identifier'&&fnSet.has(callee.name)){
                            // CallExpression nodes are executable calls, not
                            // declaration identifiers. The old definition-line
                            // exclusion dropped same-line recursive calls.
                            calls[callee.name]++;
                        }
                        // Also check arguments for function references
                        node.arguments.forEach(function(arg){
                            if(arg.type==='Identifier'&&fnSet.has(arg.name)){
                                refs[arg.name]++;
                            }
                        });
                    }

                    // Function passed as reference (callback): arr.map(fn), addEventListener('click', fn)
                    if(node.type==='Identifier'&&fnSet.has(node.name)&&!inDeclaration){
                        // This is handled via parent context - check if parent is not a CallExpression callee
                        // refs tracking happens in CallExpression arguments above
                    }

                    // Array element or object property value containing function ref
                    if(node.type==='ArrayExpression'){
                        node.elements.forEach(function(el){
                            if(el&&el.type==='Identifier'&&fnSet.has(el.name)){
                                refs[el.name]++;
                            }
                        });
                    }
                    if(node.type==='Property'&&node.value&&node.value.type==='Identifier'&&fnSet.has(node.value.name)){
                        refs[node.value.name]++;
                    }

                    // Recurse
                    for(var key in node){
                        if(key==='loc'||key==='range'||key==='start'||key==='end')continue;
                        var child=node[key];
                        var nextInDecl=isDecl&&(key==='id'||key==='key');
                        if(Array.isArray(child)){
                            child.forEach(function(c){walk(c,nextInDecl);});
                        }else if(child&&typeof child==='object'&&child.type){
                            walk(child,nextInDecl);
                        }
                    }
                }

                walk(ast,false);

                // Combine calls and refs
                fnNames.forEach(function(fn){
                    calls[fn]=calls[fn]+(refs[fn]||0);
                });

                return calls;

            }catch(e){
                // Fall back to regex but be more careful
            }
        }

        // Fallback: regex-based but more careful
        return Parser.countCandidateCalls(content,fnNames,{isJS:isJS,isVBA:isVBA,isJava:ext==='java'});
    }
};

function calcBlast(fileId,conns,files){
    // Comprehensive impact analysis for a file
    // Connection format: {source: fileDefiningFn, target: fileCallingFn, fn: fnName, count: callCount}

    // Build adjacency lists for fast lookups
    var exportedTo={};// fileId -> Set of files that import from it
    var importedFrom={};// fileId -> Set of files it imports from
    var exportedFns={};// fileId -> Map of fn -> count of external calls

    conns.forEach(function(c){
        var src=typeof c.source==='object'?c.source.id:c.source;
        var tgt=typeof c.target==='object'?c.target.id:c.target;
        // src exports, tgt imports
        if(!exportedTo[src])exportedTo[src]=new Set();
        exportedTo[src].add(tgt);
        if(!importedFrom[tgt])importedFrom[tgt]=new Set();
        importedFrom[tgt].add(src);
        // Module dependency edges participate in file blast radius but are
        // not function-call evidence, so do not count them as used functions.
        if(c.type!=='dependency'){
            if(!exportedFns[src])exportedFns[src]=new Map();
            var fnMap=exportedFns[src];
            fnMap.set(c.fn,(fnMap.get(c.fn)||0)+(c.count||1));
        }
    });

    // 1. Direct dependents (files that directly import from this file)
    var directDeps=exportedTo[fileId]?Array.from(exportedTo[fileId]):[];

    // 2. Transitive dependents (BFS with depth tracking)
    var transitive=new Map();// fileId -> depth
    var queue=directDeps.map(function(f){return{file:f,depth:1};});
    var visited=new Set([fileId].concat(directDeps));
    while(queue.length>0){
        var item=queue.shift();
        if(item.depth>3)continue;// Limit depth to 3 for transitive
        transitive.set(item.file,item.depth);
        var nextDeps=exportedTo[item.file]||new Set();
        nextDeps.forEach(function(f){
            if(!visited.has(f)){
                visited.add(f);
                queue.push({file:f,depth:item.depth+1});
            }
        });
    }

    // 3. Functions exported (how many of this file's functions are used)
    var fnUsage=exportedFns[fileId]||new Map();
    var fnsUsed=fnUsage.size;
    var totalCalls=0;
    fnUsage.forEach(function(cnt){totalCalls+=cnt;});

    // 4. Dependencies (files this file imports from - its risk)
    var dependencies=importedFrom[fileId]?Array.from(importedFrom[fileId]):[];

    // 5. Calculate weighted impact score
    // Direct deps count fully, transitive count with decay
    var impactScore=directDeps.length;
    transitive.forEach(function(depth,f){
        if(depth>1)impactScore+=1/depth;// 0.5 for depth 2, 0.33 for depth 3
    });

    // 6. Calculate centrality (how connected is this file)
    var centrality=directDeps.length+dependencies.length+fnsUsed;

    // Determine level based on direct dependents and functions used
    var level='low';
    var connectedFiles=files.filter(function(f){return exportedTo[f.path]||importedFrom[f.path];}).length;
    var relativePct=connectedFiles>0?Math.round(directDeps.length/connectedFiles*100):0;

    if(directDeps.length>=8||fnsUsed>=5)level='critical';
    else if(directDeps.length>=4||fnsUsed>=3)level='high';
    else if(directDeps.length>=2||fnsUsed>=1)level='medium';

    return{
        affected:directDeps,
        transitive:Array.from(transitive.keys()),
        count:directDeps.length,
        transitiveCount:transitive.size,
        percent:relativePct,
        level:level,
        depth:transitive.size>0?Math.max.apply(null,Array.from(transitive.values())):0,
        fnsUsed:fnsUsed,
        totalCalls:totalCalls,
        dependencies:dependencies,
        impactScore:Math.round(impactScore*10)/10,
        centrality:centrality
    };
}

function calcHealth(data){
    if(!data)return{score:0,grade:'F'};
    var score=100;
    var deadPct=data.stats.functions>0?(data.stats.dead/data.stats.functions*100):0;
    score-=Math.min(20,deadPct);
    var circular=data.issues.filter(function(i){return i.title.includes('Circular');}).length;
    score-=Math.min(20,circular*5);
    var god=data.issues.filter(function(i){return i.title.includes('Large');}).length;
    score-=Math.min(15,god*3);
    var avgCoup=data.stats.files>0?(data.stats.connections/data.stats.files):0;
    score-=Math.min(15,Math.max(0,avgCoup-3)*2);
    var sec=data.securityIssues?data.securityIssues.filter(function(i){return i.severity==='high';}).length:0;
    score-=Math.min(20,sec*5);
    score=Math.max(0,Math.round(score));
    var grade='F';
    if(score>=90)grade='A';else if(score>=80)grade='B';else if(score>=70)grade='C';else if(score>=60)grade='D';
    return{score:score,grade:grade};
}
// ===== CODEFLOW_METRICS_END =====

export { Parser, calcBlast, calcHealth };
