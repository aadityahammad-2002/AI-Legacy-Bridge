import { describe, expect, it } from 'vitest';
import { buildCallGraph } from '../callGraph.js';
import { extractFileDependencies } from '../moduleResolution.js';

const fn = (name, file, line = 1, extra = {}) => ({
    name, file, line, code: `function ${name}() {}`, isTopLevel: true, ...extra,
});

describe('conservative call graph resolution', () => {
    it('uses source-brace ranges when parser metadata only knows the declaration line', () => {
        const files = [
            { path: 'src/main.js', content: "import { run } from './service.js';\nfunction main() {\n  run();\n}\nmain();" },
            { path: 'src/service.js', content: 'export function run() {}' },
        ];
        const result = buildCallGraph(files, [
            fn('main', 'src/main.js', 2, { endLine: 2, endLineConfidence: 'declaration-line-only', code: 'function main() {' }),
            fn('run', 'src/service.js', 1, { isExported: true }),
        ], extractFileDependencies(files, []));
        expect(result.functionConnections).toEqual(expect.arrayContaining([
            expect.objectContaining({ callName: 'run', callSiteLine: 3, callerFunctionName: 'main', attribution: 'heuristic-function-line-range' }),
        ]));
    });
    it('keeps unresolved receiver sites out of the resolved-call attribution denominator', () => {
        const files = [
            { path: 'src/main.js', content: "import { work } from './service.js';\nfunction main() {\n  work();\n}\nmain();\nunknown.receiver.missing();" },
            { path: 'src/service.js', content: 'export function work() { return true; }' },
        ];
        const result = buildCallGraph(files, [
            fn('main', 'src/main.js', 2, { endLine: 4, endLineConfidence: 'explicit' }),
            fn('work', 'src/service.js', 1, { isExported: true }),
        ], extractFileDependencies(files, []));
        expect(result.diagnostics.functionCallSiteCount).toBe(2);
        expect(result.diagnostics.unattributedFunctionCallSiteCount).toBe(1);
        expect(result.diagnostics.unresolvedUnattributedCallSiteCount).toBe(1);
        expect(result.diagnostics.unattributedFunctionCallSiteCount).toBeLessThanOrEqual(result.diagnostics.functionCallSiteCount);
    });

    it('counts every located call site even when serialized function edges are bounded', () => {
        const calls = Array.from({ length: 25 }, () => '  run();').join('\n');
        const files = [
            { path: 'src/many.js', content: `import { run } from './worker.js';\nfunction main() {\n${calls}\n}\nmain();` },
            { path: 'src/worker.js', content: 'export function run() { return true; }' },
        ];
        const result = buildCallGraph(files, [
            fn('main', 'src/many.js', 2, { endLine: 28, endLineConfidence: 'explicit' }),
            fn('run', 'src/worker.js', 1, { isExported: true }),
        ], extractFileDependencies(files, []));
        expect(result.diagnostics.locatedFunctionCallSiteCount).toBe(26);
        expect(result.diagnostics.functionCallSiteCount).toBe(26);
        expect(result.functionConnections.length).toBeLessThan(result.diagnostics.functionCallSiteCount);
        expect(result.diagnostics.callSiteEvidenceMissingCount).toBe(0);
    });

    it('does not count a statically imported identifier as an extra call', () => {
        const files = [
            { path: 'src/main.js', content: "import { run } from './service.js';\nrun();" },
            { path: 'src/service.js', content: 'export function run() {}' },
        ];
        const result = buildCallGraph(files, [fn('run', 'src/service.js', 1, { isExported: true })]);
        expect(result.connections).toHaveLength(1);
        expect(result.connections[0]).toMatchObject({ source: 'src/service.js', target: 'src/main.js', fn: 'run', count: 1, resolution: 'resolved' });
        expect(result.diagnostics.totalCallNameReferences).toBe(1);
    });

    it('ignores call-like text in comments and strings while retaining source-line evidence', () => {
        const files = [
            { path: 'src/main.js', content: "import { run } from './service.js';\n// run();\nconst text = 'run()';\nrun();" },
            { path: 'src/service.js', content: 'export function run() {}' },
        ];
        const result = buildCallGraph(files, [fn('run', 'src/service.js', 1, { isExported: true })]);
        expect(result.connections[0].count).toBe(1);
        expect(result.connections[0].callSiteEvidence).toMatchObject({
            path: 'src/main.js', kind: 'heuristic-line-locator',
            sites: [expect.objectContaining({ line: 4, excerpt: 'run();' })],
        });
    });

    it('does not mask the rest of a file when an import has a trailing line comment', () => {
        const files = [
            { path: 'src/main.js', content: "import { run } from './service.js'; // import detail\nrun();\nfinish();" },
            { path: 'src/service.js', content: 'export function run() {}' },
            { path: 'src/finish.js', content: 'export function finish() {}' },
        ];
        const result = buildCallGraph(files, [fn('run', 'src/service.js'), fn('finish', 'src/finish.js')], [
            { source: 'src/main.js', target: 'src/service.js', type: 'import', resolution: 'resolved', importBindings: [{ importedName: 'run', localName: 'run' }] },
            { source: 'src/main.js', target: 'src/finish.js', type: 'import', resolution: 'resolved', importBindings: [{ importedName: 'finish', localName: 'finish' }] },
        ]);
        expect(result.connections).toEqual(expect.arrayContaining([
            expect.objectContaining({ fn: 'run', target: 'src/main.js', count: 1 }),
        ]));
        expect(result.diagnostics.unresolvedCalls).toEqual(expect.arrayContaining([
            expect.objectContaining({ functionName: 'finish', count: 1 }),
        ]));
    });

    it('does not resolve a cross-file call based on a globally unique name alone', () => {
        const files = [
            { path: 'src/main.js', content: 'run();' },
            { path: 'src/service.js', content: 'export function run() {}' },
        ];
        const result = buildCallGraph(files, [fn('run', 'src/service.js')]);
        expect(result.connections).toEqual([]);
        expect(result.diagnostics.unresolvedCallCount).toBe(1);
        expect(result.fnStats['src/service.js|1|run'].unresolvedIncoming).toBe(1);
    });

    it('marks duplicate cross-file definitions ambiguous when no import selects a target', () => {
        const files = [
            { path: 'src/main.js', content: 'run();' },
            { path: 'src/a.js', content: 'export function run() {}' },
            { path: 'src/b.js', content: 'export function run() {}' },
        ];
        const result = buildCallGraph(files, [fn('run', 'src/a.js'), fn('run', 'src/b.js')]);
        expect(result.connections).toEqual([]);
        expect(result.diagnostics.ambiguousCallCount).toBe(1);
        expect(result.fnStats['src/a.js|1|run'].unresolvedIncoming).toBe(1);
        expect(result.fnStats['src/b.js|1|run'].unresolvedIncoming).toBe(1);
    });

    it('still resolves imported calls when the binding uniquely identifies a module', () => {
        const files = [
            { path: 'src/main.js', content: "import { run } from './a.js';\nrun();" },
            { path: 'src/a.js', content: 'export function run() {}' },
            { path: 'src/b.js', content: 'export function run() {}' },
        ];
        const result = buildCallGraph(files, [fn('run', 'src/a.js'), fn('run', 'src/b.js')]);
        expect(result.connections).toHaveLength(1);
        expect(result.connections[0]).toMatchObject({ source: 'src/a.js', target: 'src/main.js', count: 1, resolution: 'resolved' });
    });


    it('resolves renamed imports through tsconfig path aliases', () => {
        const files = [
            { path: 'tsconfig.json', content: '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}' },
            { path: 'src/main.ts', content: "import { run as execute } from '@/service';\nexecute();" },
            { path: 'src/service.ts', content: 'export function run() {}' },
        ];
        // Imported module resolution is the canonical source for TS path aliases
        // and explicit local/imported symbol names.
        const deps = extractFileDependencies(files, []);
        const result = buildCallGraph(files, [fn('run', 'src/service.ts', 1, { isExported: true })], deps);
        expect(result.connections).toHaveLength(1);
        expect(result.connections[0]).toMatchObject({ source: 'src/service.ts', target: 'src/main.ts', fn: 'execute', count: 1, resolvedBy: 'explicit imported alias' });
    });

    it('resolves imported function calls through a named re-export barrel', () => {
        const files = [
            { path: 'src/main.ts', content: "import { execute as run } from './barrel';\nexport function main() { return run(); }" },
            { path: 'src/barrel.ts', content: "export { run as execute } from './service.js';" },
            { path: 'src/service.ts', content: 'export function run() { return true; }' },
        ];
        const deps = extractFileDependencies(files, []);
        const result = buildCallGraph(files, [
            fn('main', 'src/main.ts', 2, { isExported: true }),
            fn('run', 'src/service.ts', 1, { isExported: true }),
        ], deps);
        expect(result.connections).toEqual(expect.arrayContaining([
            expect.objectContaining({
                source: 'src/service.ts', target: 'src/main.ts', fn: 'run', count: 1,
                resolution: 'resolved', resolvedBy: 'explicit imported binding through re-export chain',
            }),
        ]));
        expect(result.diagnostics.unresolvedCalls).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ file: 'src/main.ts', functionName: 'run' }),
        ]));
    });

    it('resolves local exported aliases to their source declaration', () => {
        const files = [
            { path: 'src/main.ts', content: "import { publicRun as execute } from './service';\nexecute();" },
            { path: 'src/service.ts', content: 'function internalRun() {}\nexport { internalRun as publicRun };' },
        ];
        const deps = extractFileDependencies(files, []);
        const result = buildCallGraph(files, [fn('internalRun', 'src/service.ts')], deps);
        expect(result.connections).toEqual(expect.arrayContaining([
            expect.objectContaining({
                source: 'src/service.ts', target: 'src/main.ts', fn: 'execute', resolution: 'resolved',
                resolvedBy: 'explicit imported binding through local export alias',
            }),
        ]));
    });

    it('resolves a named default-export function import', () => {
        const files = [
            { path: 'src/main.ts', content: "import doWork from './service.js';\ndoWork();" },
            { path: 'src/service.ts', content: 'export default function actualWork() {}' },
        ];
        const deps = extractFileDependencies(files, []);
        const result = buildCallGraph(files, [fn('actualWork', 'src/service.ts')], deps);
        expect(result.connections).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: 'src/service.ts', target: 'src/main.ts', fn: 'doWork', resolution: 'resolved' }),
        ]));
    });

    it('resolves calls through an export-star barrel when the target symbol is unique', () => {
        const files = [
            { path: 'src/main.ts', content: "import { run } from './barrel';\nrun();" },
            { path: 'src/barrel.ts', content: "export * from './service.js';" },
            { path: 'src/service.ts', content: 'export function run() {}' },
        ];
        const deps = extractFileDependencies(files, []);
        const result = buildCallGraph(files, [fn('run', 'src/service.ts', 1, { isExported: true })], deps);
        expect(result.connections).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: 'src/service.ts', target: 'src/main.ts', fn: 'run', resolution: 'resolved' }),
        ]));
    });

    it('preserves separate call sites on the same source line', () => {
        const files = [
            { path: 'src/main.js', content: "import { run } from './service.js';\nrun(); run();" },
            { path: 'src/service.js', content: 'export function run() {}' },
        ];
        const deps = extractFileDependencies(files, []);
        const result = buildCallGraph(files, [fn('run', 'src/service.js', 1, { isExported: true })], deps);
        const connection = result.connections.find((edge) => edge.fn === 'run');
        expect(connection.count).toBe(2);
        expect(connection.callSiteEvidence.sites).toHaveLength(2);
        expect(new Set(connection.callSiteEvidence.sites.map((site) => site.column)).size).toBe(2);
    });

    it('does not count a Java method declaration as a self-call', () => {
        const files = [
            { path: 'app/Payment.java', content: 'package app;\npublic class Payment {\n    public void charge() { }\n}' },
        ];
        const result = buildCallGraph(files, [fn('charge', 'app/Payment.java', 3, { type: 'method', isTopLevel: false })]);
        expect(result.functionConnections).toEqual([]);
        expect(result.fnStats['app/Payment.java|3|charge'].internal).toBe(0);
    });

    it('ignores Java call-shaped text inside comments and text blocks', () => {
        const source = [
            'class Caller {',
            '  String field = """',
            '    charge();',
            '  """;',
            '  public void charge() {}',
            '  public void run() {',
            '    String query = """',
            '      charge();',
            '    """;',
            '    charge();',
            '  }',
            '}',
        ].join('\n');
        const files = [{ path: 'app/Caller.java', content: source }];
        const functions = [
            fn('charge', 'app/Caller.java', 5, { type: 'method', isTopLevel: false, endLine: 5, code: 'public void charge() {}' }),
            fn('run', 'app/Caller.java', 6, { type: 'method', isTopLevel: false, endLine: 11, code: source.split('\n').slice(5, 11).join('\n') }),
        ];
        const result = buildCallGraph(files, functions);
        const chargeCalls = result.functionConnections.filter((edge) => edge.calleeFunctionName === 'charge' && edge.callerFunctionName === 'run');
        expect(chargeCalls).toHaveLength(1);
        expect(chargeCalls[0].callSiteLine).toBe(10);
    });

    it('masks Python import declarations but keeps calls in Python bodies', () => {
        const files = [
            { path: 'pkg/main.py', content: 'from .service import run\n\ndef main():\n    run()\n' },
            { path: 'pkg/service.py', content: 'def run():\n    return True\n' },
        ];
        const result = buildCallGraph(files, [fn('run', 'pkg/service.py', 1), fn('main', 'pkg/main.py', 3)]);
        expect(result.connections).toHaveLength(1);
        expect(result.connections[0]).toMatchObject({ source: 'pkg/service.py', target: 'pkg/main.py', fn: 'run', count: 1 });
    });
});

describe('call-graph uncertainty prevents false dead-code claims', () => {
    it('does not mark definitions as unused when unresolved references could target them', async () => {
        const { buildIssues } = await import('../callGraph.js');
        const files = [
            { path: 'src/main.js', content: 'run();', functionCount: 0 },
            { path: 'src/service.js', content: 'export function run() {}', functionCount: 1 },
        ];
        const result = buildCallGraph(files, [fn('run', 'src/service.js')]);
        const issues = buildIssues({ files, connections: result.connections, fnStats: result.fnStats, duplicates: [], layerViolations: [], dependencies: [] });
        expect(issues.some((item) => item.title.includes('Unused Functions'))).toBe(false);
    });
});
