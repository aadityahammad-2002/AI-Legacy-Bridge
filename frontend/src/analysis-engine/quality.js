/**
 * quality.js — Phase 3, batch 9 (Comments/Naming/Similarity).
 * (Copy-paste/structural duplicate detection already exists in parser.js
 * and is not duplicated here.)
 *
 *   1. TODO/FIXME/HACK comment mining
 *   2. Documentation coverage % (functions with a preceding doc comment)
 *   3. Config file scanning for misconfiguration (secrets are handled
 *      separately in parser.js/security.js — this covers non-secret
 *      misconfig: debug flags left on, wildcard CORS, disabled TLS
 *      verification)
 *   4. Naming convention checker (per-language casing conventions)
 *   5. OpenAPI/Swagger auto-generation from discovered endpoints
 *      (explicitly best-effort/low-confidence for dynamic languages,
 *      per the roadmap note — param/response types can't be inferred
 *      reliably from JS/Python source alone)
 *   6. Basic accessibility (a11y) scan — scope is deliberately narrow:
 *      missing alt text on <img>, and missing/invalid ARIA roles. Nothing
 *      broader (contrast, keyboard nav, etc.) is claimed.
 */

// ---------------------------------------------------------------------
// 1. TODO/FIXME/HACK mining
// ---------------------------------------------------------------------

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b[:\-]?\s*(.*)/;

function commentOnlyView(content, path) {
    const source = String(content || '');
    const lower = String(path || '').toLowerCase();
    const ext = lower.split('.').pop();
    const isPythonOrHash = ['py', 'pyw', 'pyi', 'sh', 'bash', 'zsh', 'fish', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf'].includes(ext) || /(?:^|\/)(?:dockerfile|makefile|containerfile)$/i.test(lower);
    const isVba = ['vba', 'bas', 'cls'].includes(ext);
    const isHtmlLike = ['html', 'htm', 'xhtml', 'xml', 'md', 'markdown', 'mdx', 'vue', 'svelte'].includes(ext);
    const out = source.split('').map((char) => char === '\n' || char === '\r' ? char : ' ');
    let state = 'code', quote = '', triple = false;
    const copyCommentChar = (i) => { out[i] = source[i]; };
    for (let i = 0; i < source.length;) {
        const c = source[i], next = source[i + 1], third = source[i + 2];
        if (state === 'line-comment') {
            if (c === '\n') state = 'code'; else copyCommentChar(i);
            i++; continue;
        }
        if (state === 'block-comment') {
            if (c === '*' && next === '/') { copyCommentChar(i); copyCommentChar(i + 1); i += 2; state = 'code'; }
            else { if (c !== '\n' && c !== '\r') copyCommentChar(i); i++; }
            continue;
        }
        if (state === 'html-comment') {
            if (c === '-' && next === '-' && third === '>') { copyCommentChar(i); copyCommentChar(i + 1); copyCommentChar(i + 2); i += 3; state = 'code'; }
            else { if (c !== '\n' && c !== '\r') copyCommentChar(i); i++; }
            continue;
        }
        if (state === 'string') {
            if (c === '\\') { i += Math.min(2, source.length - i); continue; }
            if (triple && c === quote && next === quote && third === quote) { i += 3; state = 'code'; triple = false; continue; }
            if (!triple && c === quote) state = 'code';
            i++; continue;
        }
        if (isHtmlLike && c === '<' && source.slice(i, i + 4) === '<!--') { copyCommentChar(i); copyCommentChar(i + 1); copyCommentChar(i + 2); copyCommentChar(i + 3); i += 4; state = 'html-comment'; continue; }
        if (isPythonOrHash && c === '#') { copyCommentChar(i); state = 'line-comment'; i++; continue; }
        if (isVba && c === "'") { copyCommentChar(i); state = 'line-comment'; i++; continue; }
        if (ext === 'sql' && c === '-' && next === '-') { copyCommentChar(i); copyCommentChar(i + 1); i += 2; state = 'line-comment'; continue; }
        if (!isPythonOrHash && !isVba && !isHtmlLike && c === '/' && next === '/') { copyCommentChar(i); copyCommentChar(i + 1); i += 2; state = 'line-comment'; continue; }
        if (c === '/' && next === '*') { copyCommentChar(i); copyCommentChar(i + 1); i += 2; state = 'block-comment'; continue; }
        if (ext === 'py' || ext === 'pyw' || ext === 'pyi') {
            if ((c === '"' && next === '"' && third === '"') || (c === "'" && next === "'" && third === "'")) { quote = c; triple = true; state = 'string'; i += 3; continue; }
        }
        if (c === '"' || c === "'" || (!isPythonOrHash && !isVba && c === '`')) { quote = c; triple = false; state = 'string'; i++; continue; }
        i++;
    }
    return out.join('');
}


function maskCommentsInSource(content, path) {
    const source = String(content || '');
    const commentView = commentOnlyView(source, path);
    return source.split('').map((char, index) => {
        if (char === '\n' || char === '\r') return char;
        return commentView[index] !== ' ' ? ' ' : char;
    }).join('');
}

function isCommentOnlyConfigLine(line, path) {
    const trimmed = String(line || '').trimStart();
    if (!trimmed) return true;
    const ext = String(path || '').toLowerCase().split('.').pop();
    if (['env', 'properties', 'ini', 'cfg', 'conf', 'toml', 'yaml', 'yml'].includes(ext)) {
        return /^(?:#|;|!)/.test(trimmed);
    }
    if (['json', 'jsonc'].includes(ext)) return /^(?:\/\/|\/\*|\*|\*\/)/.test(trimmed);
    return /^(?:#|;|!|\/\/|\/\*|\*|<!--|--)/.test(trimmed);
}

/**
 * Remove inline configuration comments without cutting comment markers inside
 * quoted values. This is intentionally a lightweight scanner, not a complete
 * YAML/TOML/JSONC parser; quote and escape handling errs on the conservative
 * side and is used only to avoid reporting a pattern that appears in a comment.
 */
function stripInlineConfigComment(line, filePath) {
    const source = String(line || '');
    const ext = String(filePath || '').toLowerCase().split('.').pop();
    const supportsSlashComments = ['jsonc'].includes(ext);
    const hashComments = ['env', 'properties', 'ini', 'cfg', 'conf', 'toml', 'yaml', 'yml'].includes(ext);
    const semicolonComments = ['properties', 'ini', 'cfg', 'conf'].includes(ext);
    const exclamationComments = ['properties'].includes(ext);
    if (!hashComments && !semicolonComments && !exclamationComments && !supportsSlashComments) return source;

    let quote = '';
    let escaped = false;
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        const next = source[i + 1];
        if (quote) {
            if (escaped) { escaped = false; continue; }
            if (char === '\\' && quote !== "'") { escaped = true; continue; }
            if (char === quote) {
                // YAML and TOML quote styles escape a single quote by doubling it.
                if (quote === "'" && next === "'") { i++; continue; }
                quote = '';
            }
            continue;
        }
        if (char === '"' || char === "'") { quote = char; continue; }
        const precededBySpace = i === 0 || /\s/.test(source[i - 1]);
        if (hashComments && char === '#' && precededBySpace) return source.slice(0, i);
        if (semicolonComments && char === ';' && precededBySpace) return source.slice(0, i);
        if (exclamationComments && char === '!' && i === 0) return source.slice(0, i);
        if (supportsSlashComments && char === '/' && (next === '/' || next === '*')) return source.slice(0, i);
    }
    return source;
}

/** Extract JSON/JSONC key-value tokens from one line without matching text inside values. */
function jsonKeyValueSegments(line) {
    const source = String(line || '');
    const segments = [];
    let i = 0;
    while (i < source.length) {
        if (source[i] !== '"') { i++; continue; }
        const keyStart = i;
        i++;
        let escaped = false;
        while (i < source.length) {
            const char = source[i++];
            if (escaped) { escaped = false; continue; }
            if (char === '\\') { escaped = true; continue; }
            if (char === '"') break;
        }
        const rawKey = source.slice(keyStart, i);
        let key;
        try { key = JSON.parse(rawKey); } catch { continue; }
        let cursor = i;
        while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor++;
        if (source[cursor] !== ':') continue;
        cursor++;
        while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor++;
        const valueStart = cursor;
        if (source[cursor] === '"') {
            cursor++;
            escaped = false;
            while (cursor < source.length) {
                const char = source[cursor++];
                if (escaped) { escaped = false; continue; }
                if (char === '\\') { escaped = true; continue; }
                if (char === '"') break;
            }
        } else {
            while (cursor < source.length && !/[},]/.test(source[cursor])) cursor++;
        }
        const rawValue = source.slice(valueStart, cursor).trim();
        segments.push(`${key}: ${rawValue}`);
        // Continue scanning after the key token rather than after the value:
        // nested object properties may themselves contain relevant settings.
        i = keyStart + rawKey.length;
    }
    return segments;
}

export function mineTodoComments(files) {
    const findings = [];
    files.forEach((f) => {
        const content = commentOnlyView(f.content || '', f.path || '');
        content.split('\n').forEach((line, idx) => {
            const m = line.match(TODO_RE);
            if (m) {
                findings.push({
                    tag: m[1].toUpperCase(), text: m[2].trim().substring(0, 160),
                    file: f.path, line: idx + 1,
                    confidence: 'FACT', confidenceReason: 'Literal comment tag matched directly in source.',
                });
            }
        });
    });
    return findings;
}

// ---------------------------------------------------------------------
// 2. Documentation coverage %
// ---------------------------------------------------------------------

const DOC_COMMENT_BEFORE_RE = {
    jsdoc: /\/\*\*[\s\S]*?\*\/\s*$/,
    pydoc: /^\s*(?:"""[\s\S]*?"""|'''[\s\S]*?''')\s*$/,
};

/**
 * For each known function, checks whether the ~3 lines immediately above
 * its definition line contain a doc comment (JSDoc/Javadoc block, or,
 * for Python, treats the first statement of the function body as a
 * docstring check separately since Python docstrings come AFTER the
 * signature, not before it).
 */
export function computeDocumentationCoverage(files, allFunctions) {
    const filesByPath = new Map(files.map((f) => [f.path, f.content ? f.content.split('\n') : []]));
    let documented = 0;
    const undocumented = [];

    allFunctions.forEach((fn) => {
        const lines = filesByPath.get(fn.file) || [];
        const isPython = /\.(?:py|pyw|pyi)$/i.test(fn.file);
        let hasDoc = false;

        if (isPython) {
            // Python docstring is the first non-blank line AFTER the def line.
            for (let i = (fn.line || 1); i < Math.min(lines.length, (fn.line || 1) + 3); i++) {
                if (/^\s*("""|''')/.test(lines[i] || '')) { hasDoc = true; break; }
                if ((lines[i] || '').trim()) break;
            }
        } else {
            const before = lines.slice(Math.max(0, (fn.line || 1) - 4), (fn.line || 1) - 1).join('\n');
            hasDoc = DOC_COMMENT_BEFORE_RE.jsdoc.test(before);
        }

        if (hasDoc) documented += 1;
        else undocumented.push({ name: fn.name, file: fn.file, line: fn.line });
    });

    const total = allFunctions.length;
    return {
        totalFunctions: total,
        documented,
        coveragePct: total ? Math.round((documented / total) * 100) : null,
        status: total ? 'measured' : 'not-applicable',
        undocumentedSample: undocumented.slice(0, 50),
        confidence: 'INFERENCE',
        confidenceReason: 'Checks for a doc-comment block immediately preceding (or, for Python, immediately following) each function\'s signature line — a doc comment placed elsewhere, or a non-standard style, would be missed.',
    };
}

// ---------------------------------------------------------------------
// 3. Config file misconfiguration scanning (non-secret)
// ---------------------------------------------------------------------

const MISCONFIG_PATTERNS = [
    { name: 'Debug mode enabled', re: /^\s*[{,]?\s*["']?(DEBUG|debug|debugMode|debug_mode)["']?\s*[:=]\s*["']?(true|True|1)\b/i, severity: 'medium' },
    { name: 'Wildcard CORS origin', re: /^\s*[{,]?\s*["']?(?:Access-Control-Allow-Origin|corsOrigin|cors_origin|origin)["']?\s*[:=]\s*["']?\*/i, severity: 'high' },
    { name: 'TLS/SSL verification disabled', re: /^\s*[{,]?\s*["']?(?:verify|rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED)["']?\s*[:=]\s*(?:["']?(?:False|false|0)["']?)(?:\s|,|}|$)/, severity: 'high' },
    { name: 'Bound to all interfaces', re: /^\s*[{,]?\s*["']?(?:host|HOST)["']?\s*[:=]\s*["']?0\.0\.0\.0["']?(?:\s|,|}|$)/, severity: 'low' },
    { name: 'Default/weak-looking credential', re: /^\s*[{,]?\s*["']?(?:password|passwd)["']?\s*[:=]\s*["']?(?:admin|password|changeme|123456)["']?(?:\s|,|}|$)/i, severity: 'high' },
];

const CONFIG_FILE_RE = /\.(env|properties|ya?ml|jsonc?|toml|ini|conf|cfg)$/i;

export function scanConfigMisconfig(files) {
    const findings = [];
    files.filter((f) => CONFIG_FILE_RE.test(f.path)).forEach((f) => {
        const lines = (f.content || '').split('\n');
        lines.forEach((line, idx) => {
            if (isCommentOnlyConfigLine(line, f.path)) return;
            const searchableLine = stripInlineConfigComment(line, f.path);
            if (!searchableLine.trim()) return;
            const isJson = /\.jsonc?$/i.test(f.path);
            const candidates = isJson ? jsonKeyValueSegments(searchableLine) : [searchableLine];
            MISCONFIG_PATTERNS.forEach(({ name, re, severity }) => {
                const matchedCandidate = candidates.find((candidate) => re.test(candidate));
                if (matchedCandidate) {
                    findings.push({
                        title: name, severity, file: f.path, line: idx + 1,
                        code: matchedCandidate.trim().substring(0, 100),
                        confidence: 'INFERENCE',
                        confidenceReason: `Matched a known misconfiguration pattern (${name}) — may be intentional for local/dev environments rather than production.`,
                    });
                }
            });
        });
    });
    return findings;
}

// ---------------------------------------------------------------------
// 4. Naming convention checker
// ---------------------------------------------------------------------

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]*$/;
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;
const JVM_EXT = /\.(?:java|kt|kts|groovy|scala|cs)$/i;

function expectedConvention(filePath) {
    const path = String(filePath || '').toLowerCase();
    if (/\.(?:py|pyw|pyi)$/.test(path)) return { fn: SNAKE_CASE, fnLabel: 'snake_case' };
    if (JVM_EXT.test(path)) return { fn: CAMEL_CASE, fnLabel: 'camelCase' };
    return { fn: CAMEL_CASE, fnLabel: 'camelCase' };
}

function simpleDeclaredName(name) {
    const value = String(name || '');
    // Python extraction may qualify methods as Class.method. Naming convention
    // applies to the method identifier, not its containing class prefix.
    return value.split('.').filter(Boolean).at(-1) || value;
}

function looksLikeTypeDeclaration(fn, name) {
    const code = String(fn?.code || '').trimStart();
    const type = String(fn?.type || '').toLowerCase();
    if (['class', 'record', 'enum', 'interface', 'trait', 'struct', 'type'].includes(type)) return true;
    // Regex extraction in some language fallbacks represents a type declaration
    // as a function-shaped record. Do not run a function naming rule on it.
    const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(String.raw`^(?:export\s+)?(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|sealed\s+|data\s+|open\s+|static\s+)*(?:class|record|enum|interface|trait|struct|type)\s+${escaped}\b`).test(code);
}

function isLikelyReactComponent(fn, name, filePath) {
    if (!PASCAL_CASE.test(name)) return false;
    // React/Vue/Svelte components and page/layout exports intentionally use
    // PascalCase. For ambiguous .js/.ts sources, only exempt component-shaped
    // names or source snippets with obvious JSX rather than all uppercase names.
    if (/\.(?:jsx|tsx|vue|svelte)$/i.test(filePath || '')) return true;
    const code = String(fn?.code || '');
    return /(?:Component|Page|Layout|View|Screen|Widget|Provider|Dialog|Modal|Panel|Card|Form)$/.test(name)
        || /return\s*\(?\s*</.test(code)
        || /=>\s*\(?\s*</.test(code);
}

/**
 * Language- and symbol-aware naming checks. This is still a best-effort rule:
 * source extraction doesn't reliably distinguish every constructor/type/function
 * across all languages, so obvious non-function declarations are excluded and
 * uncertain cases carry inference metadata instead of being stated as facts.
 */
export function checkNamingConventions(allFunctions) {
    const violations = [];
    (Array.isArray(allFunctions) ? allFunctions : []).forEach((fn) => {
        if (!fn || !fn.name || /^(_|__)/.test(fn.name)) return;
        const filePath = String(fn.file || '');
        const name = simpleDeclaredName(fn.name);
        if (!name || looksLikeTypeDeclaration(fn, name)) return;
        const code = String(fn.code || '').trimStart();
        const type = String(fn.type || '').toLowerCase();
        const className = String(fn.className || '').split('.').filter(Boolean).at(-1);
        // Constructors are named after their type in Java/C#/Kotlin and do not
        // follow method camelCase. Avoid matching arbitrary same-name methods.
        if (JVM_EXT.test(filePath) && (type.includes('constructor') || (className && name === className) || new RegExp(String.raw`^(?:(?:public|protected|private)\s+)*${name}\s*\(`).test(code))) return;
        // `__init__`, dunder methods and common framework lifecycle hooks are
        // intentional API names, not useful generic naming findings.
        if (/^__[A-Za-z0-9_]+__$/.test(name)) return;

        const { fn: re, fnLabel } = expectedConvention(filePath);
        if (isLikelyReactComponent(fn, name, filePath)) return;
        // Python methods should be checked by their leaf name, not `Class.method`.
        if (!re.test(name)) {
            violations.push({
                name: fn.name, file: filePath, line: fn.line, expected: fnLabel,
                confidence: 'INFERENCE',
                confidenceReason: `The extracted function/method identifier "${name}" does not match the ${fnLabel} convention for this language. Constructors, type declarations and likely UI components are excluded; verify parser classification for unusual declarations.`,
                ruleId: 'naming.function-convention',
                symbolType: type || 'unknown',
            });
        }
    });
    return violations;
}

// ---------------------------------------------------------------------
// 5. OpenAPI/Swagger auto-generation
// ---------------------------------------------------------------------

/**
 * Generates a minimal OpenAPI 3.0 skeleton from discovered endpoints.
 * Explicitly best-effort: request/response schemas can't be reliably
 * inferred from dynamically-typed source (Python/JS), so bodies are left
 * as generic objects rather than guessed shapes.
 */
export function generateOpenApiSpec(apiEndpoints, title = 'Discovered API', dynamicLanguage = true) {
    const paths = {};
    apiEndpoints.forEach((ep) => {
        if (!paths[ep.path]) paths[ep.path] = {};
        paths[ep.path][ep.method.toLowerCase()] = {
            summary: `${ep.method} ${ep.path}`,
            responses: { 200: { description: 'Successful response' } },
            ...(ep.authProtected ? { security: [{ bearerAuth: [] }] } : {}),
        };
    });

    return {
        spec: {
            openapi: '3.0.0',
            info: { title, version: '0.0.0-auto-generated' },
            paths,
            components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
        },
        confidence: 'UNCERTAIN',
        confidenceReason: dynamicLanguage
            ? 'Auto-generated from statically discovered routes only — request/response body schemas cannot be reliably inferred from dynamically-typed source, so they are left generic. Best-effort scaffold, not a verified contract.'
            : 'Auto-generated from statically discovered routes; body schemas are left generic pending explicit type annotations.',
    };
}

// ---------------------------------------------------------------------
// 6. Basic accessibility (a11y) scan — scope: alt-text + ARIA roles only
// ---------------------------------------------------------------------

const FRONTEND_FILE_RE = /\.(jsx?|tsx?|html|vue)$/;

export function scanBasicA11y(files) {
    const findings = [];
    files.filter((f) => FRONTEND_FILE_RE.test(f.path)).forEach((f) => {
        const content = maskCommentsInSource(f.content || '', f.path);
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
            if (/<img\b(?![^>]*\balt\s*=)[^>]*>/i.test(line)) {
                findings.push({
                    title: 'Missing alt text', file: f.path, line: idx + 1,
                    code: line.trim().substring(0, 100),
                    confidence: 'FACT', confidenceReason: '<img> tag matched with no alt attribute present on the same line.',
                });
            }
            const roleMatch = line.match(/role\s*=\s*["']([^"']+)["']/);
            if (roleMatch && !VALID_ARIA_ROLES.has(roleMatch[1])) {
                findings.push({
                    title: `Invalid ARIA role: "${roleMatch[1]}"`, file: f.path, line: idx + 1,
                    code: line.trim().substring(0, 100),
                    confidence: 'FACT', confidenceReason: `"${roleMatch[1]}" is not a recognized WAI-ARIA role.`,
                });
            }
        });
    });
    return findings;
}

const VALID_ARIA_ROLES = new Set([
    'alert', 'alertdialog', 'application', 'article', 'banner', 'button', 'cell', 'checkbox',
    'columnheader', 'combobox', 'complementary', 'contentinfo', 'dialog', 'directory', 'document',
    'feed', 'figure', 'form', 'grid', 'gridcell', 'group', 'heading', 'img', 'link', 'list',
    'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option', 'presentation',
    'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar',
    'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab', 'table',
    'tablist', 'tabpanel', 'term', 'textbox', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);
