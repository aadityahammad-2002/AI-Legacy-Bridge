/**
 * Dependency-free smoke benchmark for the core analysis contracts.
 * Run from the frontend folder with: node src/analysis-engine/benchmarks/run-regression.mjs
 * This is not a replacement for Vitest or compiler-backed language tests.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '../orchestrator.js';
import { computeChangeImpact, computeFunctionImpact } from '../changeImpact.js';
import { extractFileDependencies } from '../moduleResolution.js';
import { buildCallGraph } from '../callGraph.js';
import { analyzeHeuristicDataFlows, analyzeInterproceduralDataFlows } from '../dataFlow.js';
import { buildMaintainabilityMetrics } from '../functionMetrics.js';
import { analyzeFrameworkSignals } from '../frameworkAnalysis.js';
import { analyzeTestLinkage } from '../testLinkage.js';
import { Parser } from '../parser.js';
import { computeDocumentationCoverage, mineTodoComments, scanBasicA11y, scanConfigMisconfig } from '../quality.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, 'fixtures');

async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...await walk(fullPath));
        else files.push(fullPath);
    }
    return files;
}

const fixturePaths = await walk(fixtureRoot);
const files = await Promise.all(fixturePaths.map(async (fullPath) => ({
    path: path.relative(fixtureRoot, fullPath).split(path.sep).join('/'),
    content: await readFile(fullPath, 'utf8'),
})));
const attributionFixtureFiles = [
    { path: 'attribution/main.js', content: "import { run } from './service.js';\nfunction main() {\n  run();\n}\nmain();" },
    { path: 'attribution/service.js', content: 'export function run() {}' },
];
const attributionFixtureDependencies = extractFileDependencies(attributionFixtureFiles, []);
const attributionFixture = buildCallGraph(attributionFixtureFiles, [
    { name: 'main', file: 'attribution/main.js', line: 2, endLine: 2, endLineConfidence: 'declaration-line-only', type: 'function', isTopLevel: true, code: 'function main() {' },
    { name: 'run', file: 'attribution/service.js', line: 1, endLine: 1, type: 'function', isTopLevel: true, isExported: true, code: 'export function run() {}' },
], attributionFixtureDependencies);
assert.ok(attributionFixture.functionConnections.some((edge) => edge.callName === 'run' && edge.callSiteLine === 3 && edge.callerFunctionName === 'main'),
    'A source-inferred braced range should attribute a call within a function when parser metadata only contains the declaration line.');

const expectedFiles = files.length;
const started = performance.now();
const first = await analyzeRepository({ name: 'analysis-engine-regression-fixtures', source: 'local' }, files);
const firstDurationMs = Math.round((performance.now() - started) * 100) / 100;

const expectedEdges = [
    { source: 'typescript/src/main.ts', target: 'typescript/src/barrel.ts', resolution: 'resolved' },
    { source: 'typescript/src/barrel.ts', target: 'typescript/src/service.ts', type: 're-export', resolution: 'resolved' },
    { source: 'typescript/src/local-main.ts', target: 'typescript/src/local-alias.ts', resolution: 'resolved' },
    { source: 'typescript/src/default-main.ts', target: 'typescript/src/default-service.ts', resolution: 'resolved' },
    { source: 'python/pkg/consumer.py', target: 'python/pkg/service.py', resolution: 'resolved' },
    { source: 'java/app/Order.java', target: 'java/app/Payment.java', type: 'same-package', resolution: 'inferred' },
];
for (const expected of expectedEdges) {
    assert.ok(first.dependencies.some((edge) => Object.entries(expected).every(([key, value]) => edge[key] === value)),
        `Missing expected dependency edge: ${JSON.stringify(expected)}`);
}
assert.ok(first.callGraph.connections.some((edge) => edge.source === 'typescript/src/service.ts' && edge.target === 'typescript/src/main.ts' && edge.resolution === 'resolved'),
    'Expected a TypeScript call edge through a re-export barrel.');
assert.ok(first.callGraph.connections.some((edge) => edge.source === 'python/pkg/service.py' && edge.target === 'python/pkg/consumer.py' && edge.resolution === 'resolved'),
    'Expected a Python call edge through a package-relative import.');
assert.ok(first.callGraph.functionConnections.some((edge) => edge.calleeFunctionName === 'prepare' && edge.callerFunctionName === 'run'),
    'Expected a resolved function-level edge from run to prepare.');
assert.ok(!first.callGraph.functionConnections.some((edge) => edge.callerFunctionKey && edge.callerFunctionKey === edge.calleeFunctionKey && edge.callerFile === 'java/app/Payment.java'),
    'A Java method declaration must not be counted as a self-call.');
const pythonPackageMemberDiagnostics = {};
const pythonPackageMemberEdges = extractFileDependencies([
    { path: 'pkg/__init__.py', content: 'from . import sibling, package_function\n' },
    { path: 'pkg/sibling.py', content: 'def run(): return True' },
], [], pythonPackageMemberDiagnostics);
assert.ok(pythonPackageMemberEdges.some((edge) => edge.source === 'pkg/__init__.py' && edge.target === 'pkg/sibling.py' && edge.resolution === 'resolved'),
    '`from . import sibling` should resolve to the sibling module independently.');
assert.equal(pythonPackageMemberDiagnostics.ambiguousImports?.length || 0, 0,
    'Multiple names in `from . import ...` should not be conflated into one ambiguous package edge.');
assert.equal(pythonPackageMemberDiagnostics.unresolvedPackageMembers?.[0]?.importedName, 'package_function',
    'A package attribute that cannot be proven to be a sibling module should be reported as unknown package-member resolution.');
const javaWildcardDiagnostics = {};
const javaWildcardEdges = extractFileDependencies([
    { path: 'app/Use.java', content: 'package app;\nimport app.dto.*;\nclass Use {}' },
    { path: 'app/dto/First.java', content: 'package app.dto; class First {}' },
    { path: 'app/dto/Second.java', content: 'package app.dto; class Second {}' },
], [
    { name: 'Use', file: 'app/Use.java', package: 'app', line: 3 },
    { name: 'First', file: 'app/dto/First.java', package: 'app.dto', line: 1 },
    { name: 'Second', file: 'app/dto/Second.java', package: 'app.dto', line: 1 },
], javaWildcardDiagnostics);
assert.equal(javaWildcardEdges.filter((edge) => edge.type === 'wildcard-import' && edge.resolution === 'inferred').length, 2,
    'Java wildcard package imports should emit possible/inferred edges, not mark the package wildcard as ambiguous.');
assert.equal(javaWildcardDiagnostics.ambiguousImports?.length || 0, 0,
    'Java wildcard imports must not add a generic ambiguous-import diagnostic.');

// Java text blocks and comments are data, not import/call sites.
const javaTextBlockSource = [
    'package demo;', '/*', 'import demo.FakeComment;', '*/', 'class Example {',
    '  String note = """', '  import demo.FakeTextBlock;', '  """;', '}',
].join('\n');
const javaTextBlockFiles = [
    { path: 'src/demo/Example.java', content: javaTextBlockSource },
    { path: 'src/demo/FakeComment.java', content: 'package demo; class FakeComment {}' },
    { path: 'src/demo/FakeTextBlock.java', content: 'package demo; class FakeTextBlock {}' },
];
const javaTextBlockClasses = [
    { name: 'Example', file: 'src/demo/Example.java', package: 'demo', line: 5 },
    { name: 'FakeComment', file: 'src/demo/FakeComment.java', package: 'demo', line: 1 },
    { name: 'FakeTextBlock', file: 'src/demo/FakeTextBlock.java', package: 'demo', line: 1 },
];
assert.deepEqual(extractFileDependencies(javaTextBlockFiles, javaTextBlockClasses), [],
    'Java import-looking lines in comments/text blocks must not create dependencies.');
const javaCallTextBlock = [
    'class Caller {', '  String field = """', '    charge();', '  """;', '  public void charge() {}',
    '  public void run() {', '    String query = """', '      charge();', '    """;', '    charge();', '  }', '}',
].join('\n');
const javaCallGraph = buildCallGraph([{ path: 'app/Caller.java', content: javaCallTextBlock }], [
    { name: 'charge', file: 'app/Caller.java', line: 5, endLine: 5, type: 'method', isTopLevel: false, code: 'public void charge() {}' },
    { name: 'run', file: 'app/Caller.java', line: 6, endLine: 11, type: 'method', isTopLevel: false, code: javaCallTextBlock.split('\n').slice(5, 11).join('\n') },
]);
const realJavaChargeCalls = javaCallGraph.functionConnections.filter((edge) => edge.calleeFunctionName === 'charge' && edge.callerFunctionName === 'run');
assert.equal(realJavaChargeCalls.length, 1, 'Java text-block call-looking strings must not create fake call edges.');
assert.equal(realJavaChargeCalls[0].callSiteLine, 10, 'The retained Java call edge must point to the real invocation line.');

// Explicit receiver calls are resolved only when class context proves a unique target.
const receiverFile = { path: 'java/app/Runner.java', content: [
    'class Base {', '  public int prepare() { return 1; }', '}',
    'class Runner extends Base {', '  public int local() { return 2; }', '  public int run() { return super.prepare() + this.local(); }', '}',
].join('\n') };
const receiverGraph = buildCallGraph([receiverFile], [
    { name: 'prepare', file: receiverFile.path, line: 2, endLine: 2, type: 'method', className: 'Base', isClassMethod: true, isTopLevel: false, code: 'public int prepare() { return 1; }' },
    { name: 'local', file: receiverFile.path, line: 5, endLine: 5, type: 'method', className: 'Runner', isClassMethod: true, isTopLevel: false, code: 'public int local() { return 2; }' },
    { name: 'run', file: receiverFile.path, line: 6, endLine: 6, type: 'method', className: 'Runner', isClassMethod: true, isTopLevel: false, code: 'public int run() { return super.prepare() + this.local(); }' },
]);
assert.ok(receiverGraph.functionConnections.some((edge) => edge.receiver === 'super' && edge.calleeFunctionName === 'prepare' && edge.resolvedBy === 'same-file-direct-superclass'),
    'A unique direct superclass method should resolve for `super.method()`.');
assert.ok(receiverGraph.functionConnections.some((edge) => edge.receiver === 'this' && edge.calleeFunctionName === 'local' && edge.callerFunctionName === 'run'),
    'A unique same-class `this.method()` call should resolve.');
const transitiveSuperFile = { path: 'java/app/Hierarchy.java', content: [
    'class Grand {', '  public int target(int x) { return x; }', '}',
    'class Middle extends Grand { }',
    'class Leaf extends Middle {', '  public int run() { return super.target(1); }', '}',
].join('\n') };
const transitiveSuperGraph = buildCallGraph([transitiveSuperFile], [
    { name: 'target', file: transitiveSuperFile.path, line: 2, endLine: 2, type: 'method', className: 'Grand', isClassMethod: true, isTopLevel: false, code: 'public int target(int x) { return x; }' },
    { name: 'run', file: transitiveSuperFile.path, line: 6, endLine: 6, type: 'method', className: 'Leaf', isClassMethod: true, isTopLevel: false, code: 'public int run() { return super.target(1); }' },
]);
assert.ok(transitiveSuperGraph.functionConnections.some((edge) => edge.receiver === 'super' && edge.calleeFunctionName === 'target' && edge.resolvedBy === 'resolved-ancestor-superclass-chain'),
    '`super.method()` should traverse a unique single-inheritance chain when the direct parent inherits the method.');
const pythonSuperFile = { path: 'python/pkg/child.py', content: [
    'class Base:', '    def target(self, value):', '        return value',
    'class Child(Base):', '    def run(self):', '        return super().target(1)',
].join('\n') };
const pythonSuperGraph = buildCallGraph([pythonSuperFile], [
    { name: 'Base.target', file: pythonSuperFile.path, line: 2, endLine: 3, type: 'method', className: 'Base', isClassMethod: true, isTopLevel: false, code: 'def target(self, value):\n return value' },
    { name: 'Child.run', file: pythonSuperFile.path, line: 5, endLine: 6, type: 'method', className: 'Child', isClassMethod: true, isTopLevel: false, code: 'def run(self):\n return super().target(1)' },
]);
assert.ok(pythonSuperGraph.functionConnections.some((edge) => edge.receiver === 'super' && edge.calleeFunctionName === 'Base.target' && edge.callerFunctionName === 'Child.run'),
    'Python super().method() should resolve for a unique, explicit single-inheritance base.');
const receiverOverloadFile = { path: 'typescript/src/receiver-overloads.ts', content: [
    'class Calculator {', '  calculate(value: number) { return value; }', '  calculate(value: number, extra: number) { return value + extra; }', '  run() { return this.calculate(2); }', '}',
].join('\n') };
const receiverOverloadGraph = buildCallGraph([receiverOverloadFile], [
    { name: 'calculate', file: receiverOverloadFile.path, line: 2, endLine: 2, type: 'method', className: 'Calculator', isClassMethod: true, isTopLevel: false, code: 'calculate(value: number) { return value; }' },
    { name: 'calculate', file: receiverOverloadFile.path, line: 3, endLine: 3, type: 'method', className: 'Calculator', isClassMethod: true, isTopLevel: false, code: 'calculate(value: number, extra: number) { return value + extra; }' },
    { name: 'run', file: receiverOverloadFile.path, line: 4, endLine: 4, type: 'method', className: 'Calculator', isClassMethod: true, isTopLevel: false, code: 'run() { return this.calculate(2); }' },
]);
assert.ok(receiverOverloadGraph.functionConnections.some((edge) => edge.receiver === 'this' && edge.calleeFunctionName === 'calculate' && edge.calleeStartLine === 2 && edge.argumentCount === 1 && String(edge.resolvedBy).includes('overload matched')),
    'Explicit receiver calls should use known argument count to disambiguate supported overload cases.');

const typedReceiverFiles = [
    { path: 'typescript/src/PaymentService.ts', content: 'export class PaymentService { charge(amount: number) { return amount; } }' },
    { path: 'typescript/src/OrderService.ts', content: 'import { PaymentService } from "./PaymentService";\nclass OrderService {\n  constructor(private service: PaymentService) {}\n  checkout() { this.service.charge(4); }\n}' },
];
const typedReceiverGraph = buildCallGraph(typedReceiverFiles, [
    { name: 'charge', file: 'typescript/src/PaymentService.ts', line: 1, endLine: 1, type: 'method', className: 'PaymentService', isClassMethod: true, isTopLevel: false, code: 'charge(amount: number) { return amount; }' },
    { name: 'checkout', file: 'typescript/src/OrderService.ts', line: 4, endLine: 4, type: 'method', className: 'OrderService', isClassMethod: true, isTopLevel: false, code: 'checkout() { this.service.charge(4); }' },
], [{ source: 'typescript/src/OrderService.ts', target: 'typescript/src/PaymentService.ts', type: 'import', resolution: 'resolved', importBindings: [{ localName: 'PaymentService', importedName: 'PaymentService' }] }]);
assert.ok(typedReceiverGraph.functionConnections.some((edge) => edge.receiver === 'this.service' && edge.calleeFunctionName === 'charge' && edge.resolvedBy === 'explicit-imported-receiver-type'),
    'A declared/constructor-injected receiver type should resolve a cross-file member call.');
assert.ok(!typedReceiverGraph.diagnostics.unresolvedCalls.some((call) => call.functionName === 'PaymentService'),
    'Imported class/type names must not be treated as unresolved function calls.');

const overloadFile = { path: 'java/app/Calc.java', content: [
    'class Calc {', '  int calculate(int a) { return a; }', '  int calculate(int a, int b) { return a + b; }', '  int run() { return calculate("x"); }', '}',
].join('\n') };
const overloadGraph = buildCallGraph([overloadFile], [
    { name: 'calculate', file: overloadFile.path, line: 2, endLine: 2, type: 'method', className: 'Calc', isClassMethod: true, isTopLevel: false, code: 'int calculate(int a) { return a; }' },
    { name: 'calculate', file: overloadFile.path, line: 3, endLine: 3, type: 'method', className: 'Calc', isClassMethod: true, isTopLevel: false, code: 'int calculate(int a, int b) { return a + b; }' },
    { name: 'run', file: overloadFile.path, line: 4, endLine: 4, type: 'method', className: 'Calc', isClassMethod: true, isTopLevel: false, code: 'int run() { return calculate("x"); }' },
]);
assert.ok(overloadGraph.functionConnections.some((edge) => edge.calleeFunctionName === 'calculate' && edge.calleeStartLine === 2 && edge.argumentCount === 1 && String(edge.resolvedBy).includes('overload matched')),
    'Known call-site arity should conservatively disambiguate fully-known overload candidates, including string-literal arguments.');

// Parser/quality negative cases: comments and literals must not masquerade as code.
const complexityWithDecoys = Parser.calcComplexity([
    '// if (commented) for (;;) {}',
    'const message = "if (string) { for (;;) {} }";',
    'function real(value) {',
    '  if (value) return 1;',
    '}',
].join('\n'), 'src/complexity.js');
assert.equal(complexityWithDecoys.score, 2, 'Comments and ordinary strings must not inflate the branch-count metric.');
assert.equal(Parser.calcComplexity('<html><body><img src="x"></body></html>', 'index.html').status, 'skipped',
    'Markup without executable script must not be represented as zero/low complexity.');

const longFunctionLines = [
    'export function longBranch(input) {',
    ...Array.from({ length: 16 }, (_, index) => `  const value${index} = ${index};`),
    '  if (input) return true;',
    '  return false;',
    '}',
];
const longFunctionResult = await analyzeRepository({ name: 'long-function-complexity-fixture', source: 'local' }, [
    { path: 'src/long.ts', content: longFunctionLines.join('\n') },
]);
const longFunctionMetric = longFunctionResult.functionComplexity.topComplexFunctions.find((item) => item.name === 'longBranch');
assert.ok(longFunctionMetric, 'Function-complexity summary should include extracted functions.');
assert.equal(longFunctionMetric.score, 2, 'Per-function complexity should inspect the complete function span, not only the truncated display snippet.');
assert.equal(longFunctionMetric.endLine, longFunctionLines.length, 'Function complexity should retain the full source end line.');
assert.ok(!longFunctionResult.functions.find((item) => item.name === 'longBranch')?.code?.includes('if (input)'),
    'Regression fixture must prove that the display snippet ends before the late branch.');
const fallbackDiagnostics = {};
const fallbackFunctions = Parser.extract('// function decoy() {}\nconst s = "function hidden() {}";\nfunction actual() {\n if (x) return true;\n}', 'src/fallback.js', fallbackDiagnostics);
assert.deepEqual(fallbackFunctions.map((fn) => fn.name), ['actual'], 'Regex fallback must not extract declarations from comments/strings.');
assert.equal(fallbackFunctions[0].endLine, 5, 'Regex fallback must preserve an estimated full function end-line range.');
assert.equal(computeDocumentationCoverage([], []).coveragePct, null, 'No discovered functions must yield not-applicable documentation coverage, not a false 0%.');
const todoFindings = mineTodoComments([{ path: 'src/todo.js', content: 'const note = "TODO: string";\n// TODO: real follow-up' }]);
assert.equal(todoFindings.length, 1, 'TODO mining should only report actual comments.');
assert.equal(scanBasicA11y([{ path: 'src/a11y.jsx', content: '{/* <img src="fake.png"> */}\n<img src="actual.png">' }]).length, 1,
    'Accessibility checks should ignore commented-out markup.');
const configFindings = scanConfigMisconfig([
    { path: '.env', content: 'DEBUG=false # DEBUG=true is a comment\nPASSWORD=correct-horse # password=admin is a comment' },
    { path: 'config/settings.yml', content: 'debug: false # DEBUG=true\npassword: "correct # password=admin" # password=admin in a comment' },
]);
assert.equal(configFindings.length, 0, 'Config rule matching must ignore misconfiguration patterns inside inline comments/quoted values.');
const activeConfigFindings = scanConfigMisconfig([
    { path: '.env', content: 'DEBUG=true\nPASSWORD=admin' },
    { path: 'config/one-line.json', content: '{\"debug\":true,\"password\":\"admin\",\"origin\":\"*\"}' },
]);
assert.equal(activeConfigFindings.length, 5, 'Config rules must still report active debug/weak-credential values in line-based and JSON configs.');

const baseUrlDiagnostics = {};
const baseUrlEdges = extractFileDependencies([
    { path: 'tsconfig.json', content: '{\"compilerOptions\":{\"baseUrl\":\".\"}}' },
    { path: 'src/main.ts', content: "import React from 'react'; import { local } from './local.js';" },
    { path: 'src/local.ts', content: 'export const local = true;' },
], [], baseUrlDiagnostics);
assert.deepEqual(baseUrlEdges.map((edge) => edge.target), ['src/local.ts'], 'A baseUrl catch-all must not misclassify an external bare import as a missing local module.');
assert.deepEqual(baseUrlDiagnostics.unresolvedLocalImports, [], 'External packages must not become unresolved-local-import diagnostics.');
const packageMapDiagnostics = {};
const packageMapEdges = extractFileDependencies([
    { path: 'packages/app/package.json', content: JSON.stringify({ name: '@demo/app', imports: { '#internal/*': './src/internal/*.ts' } }) },
    { path: 'packages/app/src/main.ts', content: "import { add } from '@demo/lib/utils'; import { helper } from '#internal/helper';" },
    { path: 'packages/app/src/internal/helper.ts', content: 'export function helper() { return 1; }' },
    { path: 'packages/lib/package.json', content: JSON.stringify({ name: '@demo/lib', exports: { '.': './src/index.ts', './utils': './src/utils.ts', './features/*': './src/features/*.ts' } }) },
    { path: 'packages/lib/src/index.ts', content: 'export * from "./utils";' },
    { path: 'packages/lib/src/utils.ts', content: 'export function add(a, b) { return a + b; }' },
], [], packageMapDiagnostics);
assert.ok(packageMapEdges.some((edge) => edge.source === 'packages/app/src/main.ts' && edge.target === 'packages/lib/src/utils.ts' && edge.resolvedBy === 'workspace-package-manifest'), 'Workspace package exports should resolve to checked-in package source.');
assert.ok(packageMapEdges.some((edge) => edge.source === 'packages/app/src/main.ts' && edge.target === 'packages/app/src/internal/helper.ts' && edge.resolvedBy === 'package-import-map'), 'Package-local #imports maps should resolve within their nearest package scope.');
assert.equal(packageMapDiagnostics.unresolvedLocalImports?.length || 0, 0, 'Resolved package maps should not produce unresolved-local-import diagnostics.');

const templateFlow = analyzeHeuristicDataFlows([{
    path: 'src/template-flow.js',
    content: 'function query(req, db) {\n const input = req.query.value;\n db.query(`SELECT * FROM users WHERE name = ${input}`);\n}',
}]);
assert.ok(templateFlow.summary.potentialFlows > 0, 'Data-flow scanner should preserve executable template interpolation expressions.');
const commentOnlyFlow = analyzeHeuristicDataFlows([{
    path: 'src/comment-flow.js',
    content: '// req.query.name; db.query(input);\nconst note = "req.body.value and db.query(fake)";',
}]);
assert.equal(commentOnlyFlow.summary.potentialFlows, 0, 'Comments and ordinary strings must not create data-flow leads.');
const dataFlowCoverage = analyzeHeuristicDataFlows([
    { path: 'src/known.ts', content: 'export function safe() { return true; }' },
    { path: 'src/other.go', content: 'func run() {}' },
    { path: 'src/readme.md', content: '# not source code' },
]);
assert.equal(dataFlowCoverage.coverage.sourceFiles, 2, 'Data-flow coverage should count recognized source files, not documentation.');
assert.equal(dataFlowCoverage.coverage.supportedFiles, 1, 'Data-flow coverage should enumerate supported source files.');
assert.deepEqual(dataFlowCoverage.unsupportedFiles, ['src/other.go'], 'Unsupported source files should be explicitly reported.');
assert.equal(dataFlowCoverage.status, 'partial', 'Data-flow coverage should be partial when source languages are unsupported.');
assert.ok(first.callGraph.connections.some((edge) => edge.source === 'typescript/src/local-alias.ts' && edge.target === 'typescript/src/local-main.ts' && edge.resolvedBy === 'explicit imported binding through local export alias'),
    'Expected an aliased local export call edge.');
assert.ok(first.callGraph.connections.some((edge) => edge.source === 'typescript/src/default-service.ts' && edge.target === 'typescript/src/default-main.ts' && edge.resolution === 'resolved'),
    'Expected a named default-export call edge.');
assert.equal(first.analysisInput.discoveredFiles, expectedFiles, 'All fixture files should be accounted for.');
assert.ok(first.analysisCoverage && first.analysisCoverage.status, 'Analysis coverage contract should be present.');
assert.ok(first.analysisCoverage.parserCoverage.byLanguage.typescript.codeFiles > 0, 'Coverage should include per-language parser details.');
assert.ok(Object.hasOwn(first.analysisCoverage.callGraph, 'resolutionPct'), 'Coverage should report observed call-resolution rate.');
assert.ok(Object.hasOwn(first.analysisCoverage.dependencyResolution, 'edgeResolutionPct'), 'Coverage should report emitted-edge resolution rate.');
assert.ok(first.functionComplexity?.topComplexFunctions?.length > 0, 'Function complexity should be present in the analysis model.');
assert.ok(!(first.analysisCoverage.dependencyResolution.unresolvedLocalImports || []).some((item) => item.path === 'typescript/src/decoys.ts' || item.path === 'python/pkg/__init__.py'),
    'Import-shaped comments/docstrings/template text must not create unresolved-import diagnostics.');

const impact = computeChangeImpact('typescript/src/service.ts', first.dependencies, first.analysisCoverage.dependencyResolution);
assert.ok(impact.directDependents.some((item) => item.path === 'typescript/src/barrel.ts'), 'Barrel should be a direct dependent.');
assert.ok(impact.transitiveDependents.some((item) => item.path === 'typescript/src/main.ts'), 'Main should be a transitive dependent.');
const prepareEdge = first.callGraph.functionConnections.find((edge) => edge.calleeFunctionName === 'prepare' && edge.callerFunctionName === 'run');
assert.ok(prepareEdge, 'Function-level impact needs a resolved target edge.');
const functionImpact = computeFunctionImpact(prepareEdge.calleeFunctionKey, first.callGraph.functionConnections, first.callGraph.diagnostics);
assert.ok(functionImpact.directCallers.some((item) => item.name === 'run'), 'run should directly call prepare.');
assert.ok(functionImpact.transitiveCallers.some((item) => item.name === 'main'), 'main should be a transitive caller through run.');

const resetFlow = analyzeHeuristicDataFlows([{
    path: 'src/reset.js',
    content: `function query(db, req) {\n  let input = req.query.name;\n  input = 'fixed';\n  db.query(input);\n}`,
}]);
assert.equal(resetFlow.summary.potentialFlows, 0, 'Overwriting tainted data with a constant should kill stale heuristic taint.');

const metricFixtureFile = { path: 'src/arrow.ts', content: [
    'export const handle = req => {', '  if (req) {', '    if (req.value) return req.value;', '  }', '  return null;', '};',
].join('\n') };
const metricResult = buildMaintainabilityMetrics([metricFixtureFile], [
    { name: 'handle', file: metricFixtureFile.path, line: 1, endLine: 6, type: 'arrow', isTopLevel: true, code: 'export const handle = req => { ... }' },
]);
assert.equal(metricResult.functions[0]?.parameterCount, 1, 'Maintainability metrics should recognize single-parameter arrow functions.');
assert.ok(metricResult.functions[0]?.estimatedCognitiveComplexity >= 2, 'Maintainability metrics should include nesting-weighted cognitive-complexity signals.');
const nestingMetrics = buildMaintainabilityMetrics([
    { path: 'src/metrics.py', content: 'class Example:\n    def simple(self):\n        return 1\n    def nested(self, value):\n        if value:\n            if value > 1:\n                return 1\n        return 0' },
    { path: 'src/object-literal.ts', content: 'function configure() {\n  const options = { nested: { value: 1 } };\n  return options;\n}' },
    { path: 'src/control-flow.ts', content: 'function nested(value) {\n  if (value) {\n    while (value) {\n      return true;\n    }\n  }\n  return false;\n}' },
], [
    { name: 'Example.simple', file: 'src/metrics.py', line: 2, endLine: 3, type: 'method' },
    { name: 'Example.nested', file: 'src/metrics.py', line: 4, endLine: 8, type: 'method' },
    { name: 'configure', file: 'src/object-literal.ts', line: 1, endLine: 4, type: 'function' },
    { name: 'nested', file: 'src/control-flow.ts', line: 1, endLine: 7, type: 'function' },
]);
assert.equal(nestingMetrics.functions.find((fn) => fn.name === 'Example.simple')?.nestingDepth, 0, 'A Python method declaration indentation must not count as control nesting.');
assert.equal(nestingMetrics.functions.find((fn) => fn.name === 'Example.nested')?.nestingDepth, 2, 'Python nested control blocks should use relative method indentation.');
assert.equal(nestingMetrics.functions.find((fn) => fn.name === 'configure')?.nestingDepth, 0, 'Nested object literal braces must not inflate control-flow nesting.');
assert.equal(nestingMetrics.functions.find((fn) => fn.name === 'nested')?.nestingDepth, 2, 'Nested if/while control blocks should be counted.');
const frameworkResult = analyzeFrameworkSignals([
    { path: 'src/api.py', content: 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/health")\ndef health(): return {"ok": True}' },
    { path: 'src/ignored.py', content: '# @app.post("/fake")\ntext = "@app.delete(\"/fake\")"' },
], { functions: [{ name: 'health', file: 'src/api.py', line: 4, endLine: 4, type: 'function' }] });
assert.ok(frameworkResult.signals.some((item) => item.framework === 'fastapi' && item.role === 'http-route' && item.line === 3), 'Framework analysis should report line-evidenced FastAPI routes.');
assert.ok(!frameworkResult.signals.some((item) => item.evidence.includes('/fake')), 'Framework analysis should ignore comments and strings.');
assert.ok(frameworkResult.routes.some((route) => route.framework === 'fastapi' && route.method === 'GET' && route.path === '/health' && route.handlerName === 'health' && route.resolution === 'resolved'), 'Framework route inventory should link a FastAPI route to its nearby handler when uniquely found.');
const springRouteResult = analyzeFrameworkSignals([{
    path: 'java/app/UsersController.java',
    content: '@RequestMapping("/api")\nclass UsersController {\n  @GetMapping("/users")\n  public List<User> users() { return List.of(); }\n}',
}], { functions: [{ name: 'users', file: 'java/app/UsersController.java', line: 4, endLine: 4, type: 'method', isClassMethod: true, className: 'UsersController' }] });
assert.equal(springRouteResult.routes.length, 1, 'A class-level Spring @RequestMapping should be a base path, not a separate endpoint.');
assert.equal(springRouteResult.routes[0]?.path, '/api/users', 'Spring controller base path and method path should be combined.');
assert.equal(springRouteResult.routes[0]?.handlerName, 'users', 'Spring route should link to the uniquely identified method.');
const linkageResult = analyzeTestLinkage([
    { path: 'src/checkout.ts', content: 'export function checkout() { return true; }' },
    { path: 'src/checkout.test.ts', content: "import { checkout } from './checkout';\ntest('checkout works', () => checkout());" },
], [{ source: 'src/checkout.test.ts', target: 'src/checkout.ts', type: 'import', resolution: 'resolved', line: 1, evidence: "import { checkout } from './checkout'" }], [{
    callerFunctionKey: 'src/checkout.test.ts|2|checkout works', callerFile: 'src/checkout.test.ts', callerFunctionName: 'checkout works', callerStartLine: 2,
    calleeFunctionKey: 'src/checkout.ts|1|checkout', calleeFile: 'src/checkout.ts', calleeFunctionName: 'checkout', calleeStartLine: 1,
    callSiteLine: 2, callSiteExcerpt: "test('checkout works', () => checkout())", resolution: 'resolved', attribution: 'heuristic-function-line-range',
}]);
assert.equal(linkageResult.linkedTestFileCount, 1, 'Import evidence should link a test file to its source module.');
assert.ok(linkageResult.functionLinks.some((link) => link.sourceFunction === 'checkout' && link.testFile === 'src/checkout.test.ts'), 'Resolved call-graph evidence should link a test function to the production function it calls.');
const interproceduralFiles = [
    { path: 'src/handler.js', content: 'export function handler(req, db) {\n  const input = req.query.name;\n  runQuery(input, db);\n}' },
    { path: 'src/query.js', content: 'export function runQuery(value, db) {\n  db.query(value);\n}' },
];
const interproceduralFunctions = [
    { name: 'handler', file: 'src/handler.js', line: 1, endLine: 4, type: 'function', key: 'src/handler.js|1|handler' },
    { name: 'runQuery', file: 'src/query.js', line: 1, endLine: 3, type: 'function', key: 'src/query.js|1|runQuery' },
];
const interproceduralResult = analyzeInterproceduralDataFlows(interproceduralFiles, interproceduralFunctions, [{
    callerFunctionKey: 'src/handler.js|1|handler', callerFunctionName: 'handler', callerFile: 'src/handler.js', callSiteLine: 3, callSiteColumn: 3, callName: 'runQuery',
    calleeFunctionKey: 'src/query.js|1|runQuery', calleeFunctionName: 'runQuery', calleeFile: 'src/query.js', resolution: 'resolved',
}]);
assert.ok(interproceduralResult.flows.some((flow) => flow.sinkKind === 'sql-query' || flow.sink?.kind === 'sql-query' || JSON.stringify(flow).includes('sql-query')),
    'Interprocedural heuristic data-flow should trace request input through a uniquely resolved function call to a SQL sink.');

const secondStarted = performance.now();
const second = await analyzeRepository({ name: 'analysis-engine-regression-fixtures', source: 'local' }, files);
const secondDurationMs = Math.round((performance.now() - secondStarted) * 100) / 100;
assert.ok(second.analysisCache.extractionHits > 0, 'Repeat run should reuse cached file extraction.');
assert.ok(second.analysisCache.complexityHits > 0, 'Repeat run should reuse cached complexity results.');

console.log(JSON.stringify({
    status: 'passed',
    fixtureFiles: expectedFiles,
    sourceInferredCallerAttribution: 'passed',
    expectedDependencyEdges: expectedEdges.length,
    dependencyEdgesObserved: first.dependencies.length,
    resolvedFileCallEdgesObserved: first.callGraph.connections.length,
    resolvedFunctionCallEdgesObserved: first.callGraph.functionConnections.length,
    functionImpact: { directCallers: functionImpact.directCallers.length, transitiveCallers: functionImpact.transitiveCallers.length },
    staleTaintResetCheck: resetFlow.summary.potentialFlows === 0 ? 'passed' : 'failed',
    parserAndQualityChecks: {
        commentAndStringComplexity: 'passed',
        javaTextBlockImportAndCallMasking: 'passed',
        pythonRelativePackageMembers: 'passed',
        javaWildcardImportSemantics: 'passed',
        markupWithoutScriptStatus: 'skipped',
        regexFallbackFullSpan: 'passed',
        functionComplexityUsesFullSourceSpan: 'passed',
        emptyDocumentationCoverageNotApplicable: 'passed',
        commentOnlyTodoMining: 'passed',
        commentedMarkupA11y: 'passed',
        inlineConfigComments: 'passed',
        baseUrlExternalImportClassification: 'passed',
        workspacePackageExportsAndImportsMaps: 'passed',
        templateInterpolationDataFlow: 'passed',
        commentOnlyDataFlow: 'passed',
        explicitDataFlowCoverageReporting: 'passed',
        explicitReceiverAndDirectSuperCalls: 'passed',
        transitiveSingleInheritanceSuperCall: 'passed',
        pythonSuperCall: 'passed',
        receiverOverloadArity: 'passed',
        typedReceiverCalls: 'passed',
        arityBasedOverloadDisambiguation: 'passed',
        singleParameterArrowMetrics: 'passed',
        controlFlowNestingMetrics: 'passed',
        cognitiveComplexitySignals: 'passed',
        frameworkRouteSignals: 'passed',
        springControllerBasePath: 'passed',
        testToSourceFunctionLinkage: 'passed',
        interproceduralDataFlow: 'passed',
    },
    coverageStatus: first.analysisCoverage.status,
    cacheHitsOnSecondRun: {
        extraction: second.analysisCache.extractionHits,
        complexity: second.analysisCache.complexityHits,
    },
    timingMs: { firstRun: firstDurationMs, secondRun: secondDurationMs },
    limitations: [
        'Fixture benchmark covers representative patterns, not compiler-grade semantic correctness for arbitrary repositories.',
        'Timing results are environment-specific and are not a performance SLA.',
        'The bounded data-flow scanner is not evaluated as a vulnerability detector by this benchmark.',
    ],
}, null, 2));
