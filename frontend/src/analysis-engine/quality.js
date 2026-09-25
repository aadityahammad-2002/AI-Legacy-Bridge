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

export function mineTodoComments(files) {
    const findings = [];
    files.forEach((f) => {
        const content = f.content || '';
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
        const isPython = /\.py$/.test(fn.file);
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

    const total = allFunctions.length || 1;
    return {
        totalFunctions: allFunctions.length,
        documented,
        coveragePct: Math.round((documented / total) * 100),
        undocumentedSample: undocumented.slice(0, 50),
        confidence: 'INFERENCE',
        confidenceReason: 'Checks for a doc-comment block immediately preceding (or, for Python, immediately following) each function\'s signature line — a doc comment placed elsewhere, or a non-standard style, would be missed.',
    };
}

// ---------------------------------------------------------------------
// 3. Config file misconfiguration scanning (non-secret)
// ---------------------------------------------------------------------

const MISCONFIG_PATTERNS = [
    { name: 'Debug mode enabled', re: /\b(DEBUG|debug)\s*[:=]\s*(true|True|1)\b/, severity: 'medium' },
    { name: 'Wildcard CORS origin', re: /(?:Access-Control-Allow-Origin|cors\s*\(\s*\{?\s*origin)\s*[:=]?\s*['"]?\*/, severity: 'high' },
    { name: 'TLS/SSL verification disabled', re: /(?:verify\s*=\s*False|rejectUnauthorized\s*[:=]\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0)/, severity: 'high' },
    { name: 'Bound to all interfaces', re: /(?:host\s*[:=]\s*['"]0\.0\.0\.0['"]|HOST\s*=\s*0\.0\.0\.0)/, severity: 'low' },
    { name: 'Default/weak-looking credential', re: /(?:password|passwd)\s*[:=]\s*['"]?(?:admin|password|changeme|123456)['"]?/i, severity: 'high' },
];

const CONFIG_FILE_RE = /\.(env|properties|ya?ml|json|toml|ini|conf|cfg)$/i;

export function scanConfigMisconfig(files) {
    const findings = [];
    files.filter((f) => CONFIG_FILE_RE.test(f.path)).forEach((f) => {
        const lines = (f.content || '').split('\n');
        lines.forEach((line, idx) => {
            MISCONFIG_PATTERNS.forEach(({ name, re, severity }) => {
                if (re.test(line)) {
                    findings.push({
                        title: name, severity, file: f.path, line: idx + 1,
                        code: line.trim().substring(0, 100),
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

function expectedConvention(filePath) {
    if (/\.py$/.test(filePath)) return { fn: SNAKE_CASE, fnLabel: 'snake_case' };
    if (/\.(java|kt)$/.test(filePath)) return { fn: CAMEL_CASE, fnLabel: 'camelCase' };
    return { fn: CAMEL_CASE, fnLabel: 'camelCase' }; // JS/TS/Go default
}

/**
 * Flags function names that don't match the conventional casing for their
 * language. Class names aren't checked here (allFunctions doesn't
 * distinguish classes from functions in this engine) — scope is
 * deliberately just function/method names.
 */
export function checkNamingConventions(allFunctions) {
    const violations = [];
    allFunctions.forEach((fn) => {
        if (!fn.name || /^(_|__)/.test(fn.name)) return; // skip private/dunder conventions
        const { fn: re, fnLabel } = expectedConvention(fn.file);
        if (!re.test(fn.name)) {
            violations.push({
                name: fn.name, file: fn.file, line: fn.line, expected: fnLabel,
                confidence: 'INFERENCE',
                confidenceReason: `Function/method names in this file type are conventionally ${fnLabel}; this one isn't — could be intentional (e.g. matching an external API's naming).`,
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
        const content = f.content || '';
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
