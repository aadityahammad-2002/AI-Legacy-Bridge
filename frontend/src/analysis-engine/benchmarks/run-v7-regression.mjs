import assert from 'node:assert/strict';
import { analyzeRepository } from '../orchestrator.js';
import { clearAnalysisCache } from '../analysisCache.js';
import { analyzeCrossSystemIntelligence } from '../crossSystemIntelligence.js';
import { analyzeSemanticIntelligence, computeSymbolImpact } from '../semanticIntelligence.js';
import { analyzeSyntaxDiagnostics } from '../syntaxDiagnostics.js';
import { Parser } from '../parser.js';

const repository = [
    { path: 'ui/entry.js', content: 'import { run } from "./work.js";\nexport const start = () => run();\n' },
    { path: 'ui/work.js', content: 'import { helper } from "./helper.js";\nexport function run() { return helper(); }\n' },
    { path: 'ui/helper.js', content: 'export function helper() { return 1; }\n' },
    { path: 'backend/Producer.java', content: 'class Producer { void emit() { kafkaTemplate.send("orders.created", item); } }' },
    { path: 'backend/consumer.py', content: 'consumer = KafkaConsumer("orders.created")' },
    { path: 'db/schema.sql', content: 'CREATE TABLE orders (id int);' },
    { path: 'backend/db.py', content: 'def read():\n    return db.query("SELECT * FROM orders")\n' },
    { path: 'backend/classes.py', content: 'class Base:\n    pass\nclass Child(Base):\n    pass\n' },
];
const first = await analyzeRepository({ name: 'v7-sample' }, repository);
assert.match(first.engineVersion, /^8\./);
assert.equal(first.dependencyExecution.mode, 'full-dependency-resolution');
assert.equal(first.dependencyExecution.recalculatedSourceFiles, repository.length);
assert.ok(first.dependencyResolutionCheckpoint?.entries.length === repository.length,
    'snapshot needs all source edges and source keys to be reusable');
assert.ok(first.dependencies.some(e => e.source === 'ui/work.js' && e.target === 'ui/helper.js'));
assert.ok(first.semanticIntelligence.symbols.length > 0);
assert.ok(first.semanticIntelligence.inheritance.some(i => i.childName === 'Child' && i.baseName === 'Base' && i.target?.file === 'backend/classes.py'));
assert.equal(first.crossSystemIntelligence.summary.candidateMessageLinks, 1);
assert.equal(first.crossSystemIntelligence.summary.matchedSchemaTables, 1);
assert.match(first.architectureReport, /Actual Incremental Dependency Execution/);
assert.match(first.architectureReport, /Cross-System Static Message and Database Evidence/);

clearAnalysisCache();
const reused = await analyzeRepository({ name: 'v7-sample' }, repository, null, { previousResult: first });
assert.equal(reused.dependencyExecution.mode, 'partial-dependency-resolution');
assert.equal(reused.dependencyExecution.reusedSourceFiles, repository.length);
assert.equal(reused.dependencyExecution.recalculatedSourceFiles, 0);
assert.deepEqual(reused.dependencies, first.dependencies, 'identical files must have identical edges');
assert.equal(reused.incrementalAnalysis.incrementalDependencyExecutionImplemented, true);

const changed = repository.map(f => f.path === 'ui/work.js' ? { ...f, content: 'export function run() { return 0; }\n' } : f);
clearAnalysisCache();
const partial = await analyzeRepository({ name: 'v7-sample' }, changed, null, { previousResult: first });
const full = await analyzeRepository({ name: 'v7-sample' }, changed);
assert.equal(partial.dependencyExecution.recalculatedSourceFiles, 1);
assert.equal(partial.dependencyExecution.reusedSourceFiles, repository.length - 1);
assert.deepEqual(partial.dependencies, full.dependencies, 'partial graph must equal complete graph');
assert.equal(partial.dependencies.some(e => e.source === 'ui/work.js' && e.target === 'ui/helper.js'), false);
assert.equal(partial.incrementalAnalysis.diff.modified.includes('ui/work.js'), true);

const removed = await analyzeRepository({ name: 'v7-sample' }, changed.filter(f => f.path !== 'ui/helper.js'), null, { previousResult: first });
assert.equal(removed.dependencyExecution.mode, 'full-dependency-resolution', 'changed file namespace invalidates all dependency edges');
assert.ok(!removed.dependencies.some(e => e.target === 'ui/helper.js'), 'removed targets must disappear');

const jsconfig = { path: 'ui/tsconfig.json', content: '{ "compilerOptions": {} }' };
const configFirst = await analyzeRepository({ name: 'config' }, [...repository, jsconfig]);
const configChanged = await analyzeRepository({ name: 'config' }, [...repository, { ...jsconfig, content: '{ "compilerOptions": {"baseUrl":"."} }' }], null, { previousResult: configFirst });
assert.equal(configChanged.dependencyExecution.mode, 'full-dependency-resolution', 'resolution configuration invalidates graph');
assert.equal(configChanged.dependencyExecution.contextInvalidated, true);

const distractions = analyzeCrossSystemIntelligence([
    { path: 'comments.js', content: '// producer.send("hidden.topic")\nconst ignored = "consumer.subscribe(\\\"hidden.topic\\\")";\n' },
    { path: 'fakes.js', content: '// producer.send("hidden.topic")\nfunction next() { return true; }' },
    { path: 'sender.java', content: 'kafkaTemplate.send("confirmed.topic", x);' },
    { path: 'receiver.py', content: 'consumer = KafkaConsumer("confirmed.topic")' },
    { path: 'sql.py', content: 'db.query("UPDATE orders SET count = 1")' },
], { tables: [{ name: 'orders', file: 'schema.sql' }] });
assert.equal(distractions.summary.candidateMessageLinks, 1);
assert.equal(distractions.messages.some(m => m.channel === 'hidden.topic'), false, 'strings and comments are not call sites');
assert.equal(distractions.summary.matchedSchemaTables, 1);

const semantic = analyzeSemanticIntelligence({
    files: [{ path: 'a.py', content: 'class Child(Base):\n pass' }, { path: 'b.py', content: 'class Base:\n pass' }],
    classes: [{ file: 'a.py', name: 'Child', line: 1 }, { file: 'b.py', name: 'Base', line: 1 }],
    functions: [
        { file: 'a.py', name: 'a', line: 3 },
        { file: 'b.py', name: 'b', line: 4 },
        { file: 'b.py', name: 'c', line: 6 },
    ],
    dependencies: [{ source: 'a.py', target: 'b.py', resolution: 'resolved' }],
    functionConnections: [
        { callerFunctionKey: 'a.py|3|a', calleeFunctionKey: 'b.py|4|b', resolution: 'resolved', callerFile: 'a.py', callSiteLine: 3 },
        { callerFunctionKey: 'b.py|6|c', calleeFunctionKey: 'a.py|3|a', resolution: 'resolved', callerFile: 'b.py', callSiteLine: 6 },
        { callerFunctionKey: 'b.py|4|b', calleeFunctionKey: 'b.py|6|c', resolution: 'ambiguous', callerFile: 'b.py', callSiteLine: 4 },
    ],
});
assert.equal(semantic.inheritance.find(e => e.childName === 'Child').resolution, 'static-candidate');
const impact = computeSymbolImpact('b.py|4|b', semantic);
assert.deepEqual(new Set(impact.impacted.map(i => i.symbolKey)), new Set(['a.py|3|a','b.py|6|c']));
assert.equal(computeSymbolImpact('missing', semantic).status, 'unknown-symbol');

// Loaded syntax grammar is used for non-JS languages, and its errors are not
// silently called verified. This stub models a provider, not real accuracy.
const parser = Parser._tsParsers.java;
try {
    Parser._tsParsers.java = { parse: () => ({ rootNode: { hasError: () => false } }) };
    const syntaxGood = analyzeSyntaxDiagnostics([{ path: 'A.java', content: 'class A {}' }]);
    assert.equal(syntaxGood.summary.verified, 1);
    Parser._tsParsers.java = { parse: () => ({ rootNode: { hasError: () => true } }) };
    const syntaxBad = analyzeSyntaxDiagnostics([{ path: 'A.java', content: 'class {' }]);
    assert.equal(syntaxBad.summary.failed, 1);
} finally {
    if (parser) Parser._tsParsers.java = parser; else delete Parser._tsParsers.java;
}

console.log(JSON.stringify({ status: 'passed', test: 'v7-integration', checks: [
    'portable cryptographically keyed dependency reuse', 'changed source invalidates owned edges',
    'namespace and resolution-config invalidation', 'full vs partial graph equivalence',
    'source-backed static messaging and SQL/schema linking', 'no fake calls in comments/strings',
    'inheritance candidate binding and reverse symbol impact', 'loaded Tree-sitter syntax diagnostics',
    'v7 fields in end-to-end report',
], initialGraph: first.dependencies.length, reusedFiles: reused.dependencyExecution.reusedSourceFiles }, null, 2));
