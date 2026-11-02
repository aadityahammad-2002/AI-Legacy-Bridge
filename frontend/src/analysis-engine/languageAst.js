/** Optional Tree-sitter declaration extraction for grammars actually loaded at
 * runtime. This never calls the network itself; an explicit parser provider is
 * required. Syntax trees verify declaration boundaries, not name binding. */
const DECLARATION_NODES = new Set([
    'function_declaration', 'function_definition', 'function_item',
    'method_declaration', 'method_definition', 'method', 'singleton_method',
    'constructor_declaration', 'local_function_statement',
    'function_def', 'function_definition_statement', 'function_statement',
    'function_definition_node', 'function', 'function_expression',
    'local_function', 'function_definition', 'function_signature',
]);
const EXCLUDE = new Set(['function_expression', 'function_signature']);
const RESERVED = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'fn', 'def', 'func', 'end', 'return']);
function textFor(node, source) {
    if (!node) return '';
    if (typeof node.text === 'string') return node.text;
    return source.slice(node.startIndex ?? 0, node.endIndex ?? 0);
}
function namedChildren(node) { return node?.namedChildren || []; }
function getName(node, source) {
    for (const field of ['name', 'declarator', 'identifier', 'property']) {
        let child;
        try { child = node.childForFieldName?.(field); } catch { /* mocked provider */ }
        if (!child) continue;
        const text = textFor(child, source);
        // C/C++ function declarators include parameter lists and pointer syntax.
        const match = text.match(/(?:([A-Za-z_~][\w:]*)\s*)\(/);
        if (match) return match[1].split('::').pop();
        if (/^[A-Za-z_$][\w$!?=]*$/.test(text)) return text;
    }
    for (const child of namedChildren(node)) {
        if (/^(?:identifier|name|property_identifier|field_identifier|simple_identifier|constant|operator_identifier)$/.test(child.type || '')) {
            const name = textFor(child, source).trim();
            if (name && !RESERVED.has(name)) return name;
        }
    }
    // The parser has already established a function declaration node; use a
    // bounded lexical fallback for grammar-specific declarator node layouts.
    const snippet = textFor(node, source).slice(0, 500);
    const candidate = snippet.match(/(?:function|fn|func|def|sub)\s+([A-Za-z_$][\w$!?]*)/) || snippet.match(/([A-Za-z_$][\w$]*)\s*\(/);
    return candidate?.[1] || null;
}
export function extractLoadedTreeSitterFunctions(source, filename, parser, options = {}) {
    if (!parser || typeof parser.parse !== 'function') return { status: 'not-loaded', functions: [] };
    let tree;
    try { tree = parser.parse(String(source || '')); }
    catch (error) { return { status: 'parse-failed', functions: [], error: String(error?.message || error).slice(0, 200) }; }
    const root = tree?.rootNode;
    if (!root) return { status: 'parse-failed', functions: [] };
    // A tree with syntax errors can contain valid subtrees. Do not silently call
    // the entire file syntax-verified in that state: use the lexical fallback.
    if (root.hasError?.() || root.hasError === true) return { status: 'syntax-errors', functions: [] };
    const functions = [], stack = [{ node: root, className: null, depth: 0 }];
    const visited = new Set();
    const lines = String(source || '').split('\n');
    const maxNodes = options.maxNodes ?? 150000;
    while (stack.length && visited.size < maxNodes) {
        const frame = stack.pop(), node = frame.node;
        if (!node || visited.has(node)) continue;
        visited.add(node);
        const kind = node.type || '';
        const isClass = /^(?:class_declaration|class_definition|struct_item|class_specifier|type_declaration|impl_item|object_declaration)$/.test(kind);
        const className = isClass ? getName(node, source) || frame.className : frame.className;
        if (DECLARATION_NODES.has(kind) && !EXCLUDE.has(kind)) {
            const name = getName(node, source);
            const start = (node.startPosition?.row ?? 0) + 1;
            const end = (node.endPosition?.row ?? start - 1) + 1;
            if (name && !RESERVED.has(name) && start >= 1 && end >= start && end <= lines.length) {
                functions.push({ name, file: filename, line: start, endLine: end,
                    code: lines.slice(start - 1, Math.min(end, start + 14)).join('\n') + (end - start >= 15 ? '\n  // ...' : ''),
                    type: kind.includes('method') ? 'method' : 'function',
                    className: frame.className || undefined, isClassMethod: !!frame.className,
                    isTopLevel: frame.depth <= 2, isExported: false,
                    extractionProvenance: 'tree-sitter-ast', extractionConfidence: 'syntax-verified',
                    endLineConfidence: 'ast',
                });
                if (functions.length >= (options.maxFunctions ?? 12000)) break;
            }
        }
        const children = namedChildren(node);
        for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], className, depth: frame.depth + 1 });
    }
    return { status: stack.length ? 'truncated' : 'complete', functions, visitedNodes: visited.size,
        semantics: 'Tree-sitter node types and source spans establish syntactic declarations. No compiler-level symbol binding, macro expansion, or runtime dispatch is inferred.' };
}
