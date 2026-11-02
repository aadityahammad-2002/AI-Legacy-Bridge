import { Parser } from './parser.js';
import { identifyCodeLanguage } from './languageIntelligence.js';
/** Optional parser-backed syntax checks; never call unsupported languages valid. */
export function analyzeSyntaxDiagnostics(files = [], options = {}) {
    const limit = Math.max(1, Math.min(10000, Number(options.maxFiles) || 2000));
    const maxBytes = Math.max(1024, Math.min(1024 * 1024, Number(options.maxSourceLength) || 200000));
    const checks = [];
    let verified = 0, failed = 0, unsupported = 0, oversized = 0;
    const eligible = (files || []).filter((file) => identifyCodeLanguage(file.path) || /\.json$/i.test(file.path));
    const candidate = eligible.slice(0, limit);
    for (const file of candidate) {
        const path = file.path;
        const content = String(file.content || '');
        const ext = path.split('.').pop().toLowerCase();
        if (content.length > maxBytes) { oversized++; checks.push({ path, status: 'skipped', reason: 'source-size-limit' }); continue; }
        let parser = null;
        try {
            if (ext === 'json' && /(?:^|\/)(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i.test(path)) {
                unsupported++; checks.push({ path, status: 'unverified', reason: 'jsonc-config-requires-jsonc-parser' }); continue;
            }
            if (ext === 'json') {
                parser = 'JSON.parse'; JSON.parse(content);
            } else if (Parser.getLoadedTreeSitterParser(path)?.parse) {
                parser = 'tree-sitter-loaded-grammar';
                const tree = Parser.getLoadedTreeSitterParser(path).parse(content);
                if (!tree?.rootNode) throw new Error('Grammar returned no syntax tree');
                if (tree.rootNode.hasError?.() || tree.rootNode.hasError === true) throw new Error('Syntax tree contains ERROR nodes');
            } else if (['js', 'mjs', 'cjs'].includes(ext) && globalThis.acorn?.parse) {
                parser = 'acorn';
                globalThis.acorn.parse(content, { ecmaVersion: 'latest', sourceType: ext === 'cjs' ? 'script' : 'module', locations: true, allowHashBang: true });
            } else if (['jsx', 'ts', 'tsx'].includes(ext) && globalThis.Babel?.transform) {
                // Browser already loads Babel for code extraction. Do not fetch or run a toolchain.
                parser = 'babel';
                globalThis.Babel.transform(content, { filename: path, presets: [
                    ...(ext === 'ts' || ext === 'tsx' ? ['typescript'] : []),
                    ...(ext === 'jsx' || ext === 'tsx' ? ['react'] : []),
                ], code: false, ast: true, sourceMaps: false });
            }
            if (!parser) { unsupported++; checks.push({ path, status: 'unverified', reason: 'parser-not-available-for-language' }); continue; }
            verified++;
            checks.push({ path, status: 'parsed', parser });
        } catch (error) {
            if (!parser) { unsupported++; checks.push({ path, status: 'unverified', reason: 'parser-initialization-failed' }); continue; }
            failed++;
            checks.push({ path, status: 'syntax-error', parser,
                line: error?.loc?.line || error?.location?.start?.line || null,
                column: error?.loc?.column ?? error?.location?.start?.column ?? null,
                message: String(error?.message || error).slice(0, 250),
            });
        }
    }
    const bounded = eligible.length > limit;
    return { schemaVersion: 1, status: failed || unsupported || oversized || bounded ? 'partial' : 'complete',
        summary: { verified, failed, unsupported, oversized, candidateFiles: candidate.length, limitReached: bounded }, checks,
        semantics: 'Syntax verified with explicitly loaded Tree-sitter grammars, optional Acorn/Babel, or JSON.parse. Other recognized languages remain unverified. A valid syntax tree does not establish type correctness or program behavior.',
    };
}
