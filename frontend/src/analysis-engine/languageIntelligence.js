/**
 * Conservative, language-aware lexical extraction for source languages without an
 * active compiler/AST provider. This is deliberately NOT compiler-grade parsing:
 * lexical declarations get heuristic provenance; uncertain ranges remain bounded.
 * No network requests, evaluation of project code, or third-party dependencies.
 */
const PROFILES = [
    ['JavaScript', ['js', 'jsx', 'mjs', 'cjs']],
    ['TypeScript', ['ts', 'tsx', 'mts', 'cts']],
    ['Python', ['py', 'pyw', 'pyi']],
    ['Java', ['java']], ['Go', ['go']], ['Rust', ['rs']],
    ['Ruby', ['rb']], ['PHP', ['php']], ['C', ['c', 'h']],
    ['C++', ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx']],
    ['C#', ['cs']], ['Swift', ['swift']], ['Kotlin', ['kt', 'kts']],
    ['Scala', ['scala']], ['Clojure', ['clj', 'cljs', 'cljc']],
    ['Elixir', ['ex', 'exs']], ['Erlang', ['erl', 'hrl']],
    ['Haskell', ['hs', 'lhs']], ['Lua', ['lua']], ['R', ['r']],
    ['Julia', ['jl']], ['Dart', ['dart']], ['Elm', ['elm']],
    ['F#', ['fs', 'fsx']], ['OCaml', ['ml', 'mli']],
    ['Perl', ['pl', 'pm']], ['Shell', ['sh', 'bash', 'zsh', 'fish']],
    ['PowerShell', ['ps1', 'psm1']], ['Groovy', ['groovy', 'gradle']],
    ['VBA', ['vba', 'bas', 'cls']],
];
const EXT_LANGUAGE = new Map(PROFILES.flatMap(([language, extensions]) => extensions.map((ext) => [ext, language])));
export const SUPPORTED_CODE_LANGUAGES = Object.freeze(PROFILES.map(([name]) => name));

export function identifyCodeLanguage(path) {
    const name = String(path || '').replace(/\\/g, '/').split('/').pop();
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (name === 'Dockerfile' || name === 'Makefile') return 'Shell';
    return EXT_LANGUAGE.get(ext) || null;
}

const hashComments = new Set(['Python', 'R', 'Julia', 'Perl', 'Shell', 'PowerShell', 'Ruby', 'Elixir', 'PHP']);
const dashComments = new Set(['Haskell', 'Elm', 'Lua']);
const semicolonComments = new Set(['Clojure']);
const percentComments = new Set(['Erlang']);
const blockComments = new Set(['Haskell', 'Elm', 'OCaml', 'F#']);
const apostropheIsIdentifier = new Set(['Haskell', 'Elm', 'OCaml', 'F#', 'Clojure']);

/** Mask strings/comments while preserving exact offsets/newlines for citations. */
export function maskLanguageNonCode(content, language) {
    const source = String(content || '');
    const out = source.split('');
    const setBlank = (at) => { if (at < source.length && source[at] !== '\n' && source[at] !== '\r') out[at] = ' '; };
    let state = 'code', quote = '', quoteLength = 1, blockEnd = '', nestedBlocks = 0;
    for (let i = 0; i < source.length;) {
        const ch = source[i], next = source[i + 1], third = source[i + 2];
        if (state === 'line') {
            if (ch === '\n') state = 'code'; else setBlank(i);
            i++; continue;
        }
        if (state === 'block') {
            if (blockEnd === '-}' && source.slice(i, i + 2) === '{-') {
                nestedBlocks++; setBlank(i); setBlank(i + 1); i += 2; continue;
            }
            if (source.slice(i, i + blockEnd.length) === blockEnd) {
                for (let j = 0; j < blockEnd.length; j++) setBlank(i + j);
                i += blockEnd.length;
                if (--nestedBlocks === 0) state = 'code';
                continue;
            }
            setBlank(i++); continue;
        }
        if (state === 'string') {
            if (ch === '\\' && i + 1 < source.length) { setBlank(i); setBlank(i + 1); i += 2; continue; }
            if (source.slice(i, i + quoteLength) === quote.repeat(quoteLength)) {
                for (let j = 0; j < quoteLength; j++) setBlank(i + j);
                i += quoteLength; state = 'code'; continue;
            }
            setBlank(i++); continue;
        }
        if (language === 'VBA' && ch === "'") { setBlank(i); state = 'line'; i++; continue; }
        // String literals have precedence over comment openers.
        if (ch === '"' || ch === '`' || (ch === "'" && !apostropheIsIdentifier.has(language))) {
            quote = ch; quoteLength = (language === 'Python' || language === 'Java') && ch === String.fromCharCode(34) && next === ch && third === ch ? 3 : (language === 'Python' && ch === String.fromCharCode(39) && next === ch && third === ch ? 3 : 1);
            for (let j = 0; j < quoteLength; j++) setBlank(i + j);
            i += quoteLength; state = 'string'; continue;
        }
        const bracketBlock = blockComments.has(language) && (source.slice(i, i + 2) === '{-' || source.slice(i, i + 2) === '(*');
        const slashBlock = !['Python', 'Ruby', 'R', 'Shell', 'PowerShell', 'Haskell', 'Elm', 'Erlang', 'Clojure', 'Julia', 'Perl'].includes(language) && ch === '/' && next === '*';
        if (bracketBlock || slashBlock) {
            blockEnd = bracketBlock ? (ch === '{' ? '-}' : '*)') : '*/';
            nestedBlocks = 1; state = 'block'; setBlank(i); setBlank(i + 1); i += 2; continue;
        }
        const hash = hashComments.has(language) && ch === '#';
        const dash = dashComments.has(language) && ch === '-' && next === '-';
        const semicolon = semicolonComments.has(language) && ch === ';';
        const percent = percentComments.has(language) && ch === '%';
        const slash = !['Python', 'Ruby', 'R', 'Shell', 'PowerShell', 'Haskell', 'Elm', 'Erlang', 'Clojure', 'Julia', 'Perl'].includes(language) && ch === '/' && next === '/';
        if (hash || dash || semicolon || percent || slash) {
            setBlank(i);
            if (dash || slash) { setBlank(i + 1); i++; }
            state = 'line'; i++; continue;
        }
        i++;
    }
    return out.join('');
}

const identifier = '[A-Za-z_$][\\w$]*';
const rules = {
    Java: [/^\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s*)?(?:[\w$<>.?\[\],]+\s+)+([\w$]+)\s*\(/],
    Go: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?\(/],
    Rust: [/^\s*(?:(?:pub(?:\([^)]*\))?|async|unsafe|extern(?:\s+"[^"]+")?)\s+)*fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/],
    Ruby: [/^\s*def\s+(?:(?:self|[A-Za-z_]\w*)\.)?([A-Za-z_]\w*[?!=]?)/],
    PHP: [/^\s*(?:(?:public|protected|private|final|abstract|static)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/],
    C: [/^\s*(?:(?:static|inline|extern|const|volatile|unsigned|signed|struct)\s+)*(?:[\w*]+\s+)+\**\s*([A-Za-z_]\w*)\s*\(/],
    'C++': [/^\s*(?:(?:static|inline|virtual|constexpr|explicit|extern|const|unsigned|signed|typename)\s+)*(?:[\w:<>,*&~]+\s+)+([A-Za-z_~][\w:]*)\s*\(/],
    'C#': [/^\s*(?:(?:public|private|protected|internal|static|virtual|async|override|sealed|abstract|partial|new)\s+)*(?:[\w<>,.?\[\]]+\s+)+([A-Za-z_]\w*)\s*\(/],
    Swift: [/^\s*(?:(?:public|private|fileprivate|open|internal|static|class|mutating|override)\s+)*func\s+([A-Za-z_]\w*)\s*[<(]/],
    Kotlin: [/\b(?:suspend\s+)?fun\s+(?:<[^>]+>\s*)?(?:[\w.<>?]+\.)?([A-Za-z_]\w*)\s*[<(]/],
    Scala: [/^\s*(?:(?:override|private|protected|implicit|final|inline)\s+)*def\s+([A-Za-z_]\w*)\s*(?:\[|\(|:|=)/],
    Clojure: [/^\s*\(\s*defn-?\s+([A-Za-z_*!?+<>\/-][\w*!?+<>\/-]*)/],
    Elixir: [/^\s*def(?:p|macro|macrop)?\s+([a-z_]\w*[?!]?)\s*(?:\(|\s|,|do\b)/],
    Erlang: [/^([a-z][a-zA-Z0-9_@]*)\s*\([^\n]*\)\s*(?:when\s+[^\n]+\s*)?->/],
    Haskell: [/^([a-z_][\w']*)\s+(?:[^=\n]+\s*)?=/],
    Lua: [/^\s*(?:local\s+)?function\s+(?:[A-Za-z_]\w*[.:])*([A-Za-z_]\w*)\s*\(/, /^\s*(?:local\s+)?([A-Za-z_]\w*)\s*=\s*function\s*\(/],
    R: [/^\s*([A-Za-z_.][\w.]*)\s*(?:<-|=)\s*function\s*\(/],
    Julia: [/^\s*function\s+([A-Za-z_][\w!]*)\s*(?:\{|\()/, /^\s*([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:::[^=]+)?=/],
    Dart: [/^\s*(?:(?:static|external|async|sync|abstract)\s+)*(?:[\w<>?,.]+\s+)+([A-Za-z_]\w*)\s*\(/],
    Elm: [/^([a-z][\w']*)\s+(?:[^=\n]+\s*)?=/],
    'F#': [/^\s*let\s+(?:rec\s+|mutable\s+|inline\s+)*(?:private\s+)?([A-Za-z_][\w']*)\b/, /^\s*member\s+\w+\.([A-Za-z_][\w']*)\b/],
    OCaml: [/^\s*let\s+(?:rec\s+)?([a-z_][\w']*)\b/],
    Perl: [/^\s*sub\s+([A-Za-z_]\w*)\b/],
    Shell: [/^\s*function\s+([A-Za-z_][\w-]*)\s*(?:\(\s*\))?\s*(?:\{|$)/, /^\s*([A-Za-z_][\w-]*)\s*\(\s*\)\s*(?:\{|$)/],
    PowerShell: [/^\s*(?:function|filter)\s+([A-Za-z_][\w:-]*)\b/i],
    Groovy: [/^\s*(?:(?:public|protected|private|static|final|synchronized)\s+)*(?:(?:def|[A-Za-z_][\w<>?.]*)\s+)+([A-Za-z_]\w*)\s*\(/],
    VBA: [/^\s*(?:(?:public|private|friend|static)\s+)*(?:sub|function|property\s+(?:get|let|set))\s+([A-Za-z_]\w*)\b/i],
};
const skipNames = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'typeof', 'new', 'class', 'record', 'interface', 'struct', 'enum', 'else', 'when', 'with', 'match', 'type', 'module', 'do', 'fun', 'let', 'try', 'except', 'case']);
const braceBased = new Set(['Java', 'Go', 'Rust', 'PHP', 'C', 'C++', 'C#', 'Swift', 'Kotlin', 'Scala', 'Dart', 'Groovy', 'Shell', 'PowerShell', 'Perl', 'R']);
const endBased = new Set(['Ruby', 'Elixir', 'Lua', 'Julia']);
const topLevelBounded = new Set(['Erlang', 'Haskell', 'Elm', 'F#', 'OCaml']);

/** A source-token check for Java declarations, not compiler binding.
 * Require an actual method/abstract signature and reject invocations such as
 * `return new X(...)`, `throw new Error(...)`, and expression text.
 */
export function isLikelyJavaDeclaration(scanLines, index, name, maskedSource, offsets) {
    const line = scanLines[index] || '';
    const start = line.indexOf(name + '(');
    const nameAt = start >= 0 ? start : line.search(new RegExp('\\b' + name + '\\s*\\('));
    if (nameAt < 0) return false;
    const prefix = line.slice(0, nameAt).trim();
    if (!prefix || /[=;{}]|->/.test(prefix) || /\b(?:return|throw|new|if|else|while|for|switch|case|catch|yield|assert|break|continue|record|class|interface|enum)\b/.test(prefix)) return false;
    if (/^@/.test(prefix) || !/[A-Za-z_$][\w$<>.?\[\]]*\s*$/.test(prefix)) return false;
    let open = maskedSource.indexOf('(', offsets[index] + nameAt);
    if (open < 0 || open > offsets[index] + line.length) return false;
    let depth = 0, close = -1;
    for (let k = open; k < Math.min(maskedSource.length, open + 3000); k++) {
        if (maskedSource[k] === '(') depth++;
        if (maskedSource[k] === ')' && --depth === 0) { close = k; break; }
    }
    if (close < 0 || lineForOffset(offsets, close) > index + 12) return false;
    // A method ends in a body, `throws ... {`, or an abstract/interface `;`.
    // It is never a `return foo(...)` expression.
    const after = maskedSource.slice(close + 1, close + 240).trimStart();
    return /^(?:throws\s+[\w.$,\s]+\s*)?(?:\{|;)/.test(after);
}

function lineForOffset(offsets, at) {
    let low = 0, high = offsets.length;
    while (low + 1 < high) {
        const mid = (low + high) >>> 1;
        if (offsets[mid] <= at) low = mid; else high = mid;
    }
    return low + 1;
}
function bracedRange(masked, lines, offsets, index, maxLookahead = 6) {
    const first = offsets[index];
    // Expression-bodied declarations have no brace block. Never borrow a later
    // function or class body and fabricate an execution span for this symbol.
    if (/\)\s*(?::\s*[\w<>?,.]+)?\s*=\s*[^\s{]/.test(lines[index]) && !lines[index].includes('{')) return null;
    const last = Math.min(masked.length, (offsets[Math.min(lines.length - 1, index + maxLookahead)] || 0) + (lines[Math.min(lines.length - 1, index + maxLookahead)] || '').length);
    let open = masked.indexOf('{', first);
    if (open < 0 || open >= last || masked.slice(first, open).includes(';')) return null;
    let depth = 0;
    const limit = Math.min(masked.length, open + 350000);
    for (let i = open; i < limit; i++) {
        if (masked[i] === '{') depth++;
        if (masked[i] === '}' && --depth === 0) return lineForOffset(offsets, i);
    }
    return null;
}
function endKeywordRange(lines, index, language) {
    const indent = (lines[index].match(/^[ \t]*/) || [''])[0].length;
    // Matching lexical indentation alone cannot prove nested dynamic constructs;
    // this estimate stays tagged as heuristic, even when an end is found.
    for (let i = index + 1; i < Math.min(lines.length, index + 700); i++) {
        const text = lines[i];
        if (!/^\s*end\b/.test(text)) continue;
        const current = (text.match(/^[ \t]*/) || [''])[0].length;
        if (current === indent) return i + 1;
    }
    return index + 1;
}
function topLevelRange(lines, index, language) {
    if (language === 'Erlang') {
        for (let i = index; i < Math.min(lines.length, index + 800); i++) if (/\.\s*$/.test(lines[i].trim())) return i + 1;
        return index + 1;
    }
    for (let i = index + 1; i < Math.min(lines.length, index + 800); i++) {
        if (!lines[i].trim() || /^\s*(?:--|#|\(\*)/.test(lines[i])) continue;
        if (!/^\s/.test(lines[i]) && /^(?:[a-zA-Z_]|let\b|type\b|module\b)/.test(lines[i])) return i;
    }
    return lines.length;
}

export function extractLanguageFunctions(content, filename, options = {}) {
    const language = identifyCodeLanguage(filename);
    if (!language || !rules[language]) return { language, functions: [], mode: 'unsupported' };
    const source = String(content || '');
    const masked = maskLanguageNonCode(source, language);
    const scan = masked.split('\n'), original = source.split('\n');
    const offsets = [];
    let offset = 0;
    for (const line of scan) { offsets.push(offset); offset += line.length + 1; }
    // Keep Java lexical methods anchored to their enclosing class for
    // source-backed controller/handler and caller attribution. No runtime
    // type resolution or compiler binding is attempted.
    const javaClasses = [];
    if (language === 'Java') for (let ci = 0; ci < scan.length; ci++) {
        const found = scan[ci].match(/\b(?:class|record|interface|enum)\s+([A-Za-z_$][\w$]*)/);
        if (!found) continue;
        const end = bracedRange(masked, scan, offsets, ci, 8);
        if (end != null) javaClasses.push({ name: found[1], start: ci + 1, end });
    }
    const functions = [];
    const seen = new Set();
    for (let i = 0; i < scan.length; i++) {
        const line = scan[i];
        if (!line.trim()) continue;
        for (const pattern of rules[language]) {
            const match = line.match(pattern);
            if (!match) continue;
            const name = match[1];
            if (!name || skipNames.has(name.toLowerCase()) || seen.has(`${i}|${name}`)) break;
            if (language === 'Java' && !isLikelyJavaDeclaration(scan, i, name, masked, offsets)) continue;
            // Multi-language bare prototypes and interfaces are declarations, not
            // executable bodies. Avoid attributing calls to them as facts.
            let endLine = i + 1;
            let confidence = 'declaration-line-only';
            if (braceBased.has(language)) {
                const ending = bracedRange(masked, scan, offsets, i, language === 'R' ? 1 : 6);
                if (ending != null) { endLine = ending; confidence = 'bounded-heuristic'; }
            } else if (endBased.has(language)) {
                const ending = endKeywordRange(scan, i, language);
                if (ending > i + 1) { endLine = ending; confidence = 'bounded-heuristic'; }
            } else if (topLevelBounded.has(language)) {
                endLine = topLevelRange(scan, i, language);
                confidence = endLine > i + 1 ? 'bounded-heuristic' : 'declaration-line-only';
            }
            // Kotlin, Scala and Julia expression-bodied functions cannot be
            // reliably assigned a braced range; declaration-only remains safe.
            const startLine = i + 1;
            const javaClass = language === 'Java' ? javaClasses.filter(cls => cls.start < startLine && startLine <= cls.end).sort((a,b)=>b.start-a.start)[0] : null;
            const relevant = original.slice(i, Math.min(endLine, i + 15)).join('\n');
            functions.push({
                name: name.split('::').pop(), file: filename, line: startLine, endLine,
                code: relevant + (endLine - startLine + 1 > 15 ? '\n  // ...' : ''),
                isTopLevel: !/^\s/.test(line), isExported: /\b(?:public|pub|export)\b/.test(line),
                type: javaClass ? 'method' : 'function',
                ...(javaClass ? {className:javaClass.name,isClassMethod:true} : {}),
                extractionLanguage: language,
                extractionProvenance: 'language-aware-lexical',
                extractionConfidence: 'heuristic', endLineConfidence: confidence,
            });
            seen.add(`${i}|${name}`);
            break;
        }
        if (functions.length >= (options.maxFunctions || 12000)) break;
    }
    return { language, functions, mode: 'language-aware-lexical' };
}

const typeRules = {
    Python: /^\s*class\s+([A-Za-z_]\w*)/, JavaScript: /\bclass\s+([A-Za-z_$][\w$]*)/,
    TypeScript: /\b(?:class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/,
    Java: /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/,
    Go: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface|\w+)/,
    Rust: /\b(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/,
    Ruby: /^\s*(?:class|module)\s+([A-Za-z_]\w*)/,
    PHP: /\b(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/,
    C: /\b(?:struct|union|enum)\s+([A-Za-z_]\w*)/,
    'C++': /\b(?:class|struct|union|enum)\s+([A-Za-z_]\w*)/,
    'C#': /\b(?:class|struct|interface|record|enum)\s+([A-Za-z_]\w*)/,
    Swift: /\b(?:class|struct|protocol|enum|actor)\s+([A-Za-z_]\w*)/,
    Kotlin: /\b(?:class|interface|object|enum\s+class)\s+([A-Za-z_]\w*)/,
    Scala: /\b(?:class|trait|object|enum)\s+([A-Za-z_]\w*)/,
    Clojure: /^\s*\(\s*(?:defrecord|deftype|defprotocol)\s+([A-Za-z_]\w*)/,
    Elixir: /^\s*defmodule\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/,
    Erlang: /^\s*-record\s*\(\s*([a-z_]\w*)/, Haskell: /^\s*(?:data|newtype|type|class)\s+([A-Z][\w']*)/,
    Lua: /^\s*(?:local\s+)?([A-Za-z_]\w*)\s*=\s*\{/, Julia: /^\s*(?:mutable\s+)?struct\s+([A-Za-z_]\w*)/,
    Dart: /\b(?:class|mixin|enum|extension)\s+([A-Za-z_]\w*)/,
    Elm: /^\s*type\s+(?:alias\s+)?([A-Z][\w']*)/,
    'F#': /^\s*type\s+([A-Za-z_][\w']*)/, OCaml: /^\s*(?:type|module)\s+([A-Za-z_][\w']*)/,
    Perl: /^\s*package\s+([A-Za-z_]\w*(?:::\w+)*)/, PowerShell: /^\s*class\s+([A-Za-z_]\w*)/i,
    Groovy: /\b(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/,
    VBA: /^\s*(?:public|private)?\s*type\s+([A-Za-z_]\w*)/i,
};
export function extractLanguageTypes(content, filename) {
    const language = identifyCodeLanguage(filename);
    const pattern = typeRules[language];
    if (!pattern) return [];
    const scan = maskLanguageNonCode(content, language).split('\n');
    const entries = [];
    const seen = new Set();
    for (let i = 0; i < scan.length; i++) {
        const match = scan[i].match(pattern);
        if (!match || !match[1] || seen.has(`${i}|${match[1]}`)) continue;
        seen.add(`${i}|${match[1]}`);
        entries.push({ name: match[1], file: filename, line: i + 1,
            kind: match[0].trim().split(/\s+/)[0], language,
            extractionProvenance: 'language-aware-lexical', extractionConfidence: 'heuristic' });
        if (entries.length >= 5000) break;
    }
    return entries;
}

export function summarizeLanguageDepth(fileStatuses = []) {
    const languages = {};
    for (const entry of fileStatuses) {
        const language = identifyCodeLanguage(entry.path);
        if (!language) continue;
        const row = languages[language] ||= { files: 0, astFiles: 0, lexicalFiles: 0, failedFiles: 0, skippedFiles: 0, modes: {} };
        row.files++;
        const mode = entry.parserStrategy || 'unknown';
        row.modes[mode] = (row.modes[mode] || 0) + 1;
        if (['ast', 'tree-sitter-ast'].includes(mode)) row.astFiles++;
        else if (entry.extraction?.status === 'failed') row.failedFiles++;
        else if (entry.extraction?.status === 'skipped') row.skippedFiles++;
        else row.lexicalFiles++;
    }
    return { status: 'reported', languages,
        supportedLanguages: SUPPORTED_CODE_LANGUAGES.length,
        parsedLanguages: Object.keys(languages).length,
        semantics: 'Language recognition does not imply semantic accuracy. AST count includes only actively used AST parsers, not configured grammars. Lexical symbol detection cannot establish compiler-level name binding, dynamic dispatch, macros, or runtime behavior.' };
}
