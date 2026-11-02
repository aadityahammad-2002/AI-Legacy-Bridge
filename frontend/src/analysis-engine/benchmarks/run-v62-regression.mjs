/** Node-only regression for v6.2: execution evidence, runtime correlation, syntax
 * honesty, checkpoint reuse, source-reference integrity and labelled edges. */
import assert from 'node:assert/strict';
import { analyzeRepository } from '../orchestrator.js';
import { clearAnalysisCache } from '../analysisCache.js';
import { analyzeExecutionIntelligence } from '../executionIntelligence.js';
import { correlateRuntimeEvidence } from '../runtimeEvidence.js';
import { auditSourceEvidence } from '../evidenceAudit.js';
import { analyzeSyntaxDiagnostics } from '../syntaxDiagnostics.js';
import { evaluateGraphEdges } from '../graphBenchmark.js';

const sample = [
    { path: 'backend/orders.py', content: `from .service import place_order\nfrom fastapi import FastAPI\napp = FastAPI()\n@app.post('/api/orders')\ndef create_order():\n    return place_order()\n` },
    { path: 'backend/service.py', content: `def place_order():\n    return 7\n` },
    { path: 'frontend/submit.js', content: `export function submit() { return fetch('/api/orders', {method:'POST'}); }` },
    { path: 'tsconfig.json', content: '{ // valid JSONC config\n "compilerOptions": {"strict": true,},\n}' },
];
const first = await analyzeRepository({ name: 'runtime-evidence' }, sample);
assert.match(first.engineVersion, /^8\./);
assert.equal(first.executionIntelligence.summary.staticClientLinks, 1);
assert.equal(first.executionIntelligence.summary.tracedEndpoints, 1);
assert.equal(first.executionIntelligence.flows[0].steps.length, 2);
assert.equal(first.executionIntelligence.flows[0].edges[0].evidence.file, 'backend/orders.py');
assert.equal(first.executionIntelligence.flows[0].edges[0].evidence.line, 6);
assert.equal(first.executionIntelligence.flows[0].handler.confidence, 'low');
assert.equal(first.runtimeEvidence.status, 'not-provided');
assert.equal(first.evidenceAudit.summary.invalid, 0);
assert.match(first.architectureReport, /Source-Backed Candidate Execution Paths/);
assert.match(first.architectureReport, /Runtime Instrumentation Correlation/);
assert.match(first.architectureReport, /Source Reference Integrity/);
assert.equal(first.syntaxDiagnostics.checks.find((item) => item.path === 'tsconfig.json')?.status, 'unverified', 'JSONC must not be mislabelled malformed JSON');

clearAnalysisCache();
const reread = await analyzeRepository({ name: 'runtime-evidence' }, sample, null, { previousResult: first });
assert.ok(reread.analysisCache.portableExtractionHits >= 2, 'portable snapshot must work even after clearing in-memory cache');
assert.ok(reread.analysisCache.portableComplexityHits >= 2);
assert.deepEqual(reread.executionIntelligence.flows, first.executionIntelligence.flows, 'checkpoint use must preserve graph behavior');
assert.deepEqual(reread.dependencies, first.dependencies);
const modified = sample.map((file) => file.path === 'backend/orders.py'
    ? { ...file, content: file.content.replace('place_order()', 'return_42()') } : file);
clearAnalysisCache();
const changed = await analyzeRepository({ name: 'runtime-evidence' }, modified, null, { previousResult: first });
assert.equal(changed.incrementalAnalysis.diff.modified.includes('backend/orders.py'), true);
assert.ok(changed.analysisCache.portableExtractionHits >= 1);
assert.equal(changed.executionIntelligence.flows[0].steps.length, 1, 'old dependency must never leak into new graph');
const removed = await analyzeRepository({ name: 'runtime-evidence' }, sample.filter((file) => file.path !== 'backend/service.py'), null, { previousResult: first });
assert.equal(removed.executionIntelligence.flows[0].steps.length, 1, 'deleted file cannot be a callee');

const fake = analyzeExecutionIntelligence({
    files: [{ path: 'api.py' }, { path: 'other.py' }],
    endpoints: [{ method: 'GET', path: '/x', file: 'api.py', line: 1, framework: 'FastAPI' }],
    functions: [{ file: 'api.py', line: 2, name: 'handler', endLine: 4 }, { file: 'other.py', line: 2, name: 'handler', endLine: 4 }],
    functionConnections: [{ callerFunctionKey: 'api.py|2|handler', calleeFunctionKey: 'other.py|2|handler', resolution: 'ambiguous', callerFile: 'api.py', callSiteLine: 3 }],
    clientCalls: [{ method: 'POST', path: '/x', file: 'client.ts', line: 1 }],
});
assert.equal(fake.summary.tracedEndpoints, 1);
assert.equal(fake.flows[0].steps.length, 1, 'ambiguous links must not be promoted to resolved paths');
assert.equal(fake.summary.staticClientLinks, 0, 'HTTP method mismatch cannot count as link');
const orphanHandler = analyzeExecutionIntelligence({
    files: [{ path: 'api.py' }], endpoints: [{ method: 'GET', path: '/x', file: 'api.py', line: 5, framework: 'FastAPI' }], functions: [],
});
assert.equal(orphanHandler.flows[0].status, 'unresolved-handler');
const conflictingClient = analyzeExecutionIntelligence({
    files: [{ path: 'a.py' }, { path: 'b.py' }],
    endpoints: [
        { method: 'GET', path: '/api/health', file: 'a.py', line: 1, framework: 'FastAPI' },
        { method: 'GET', path: '/api/health', file: 'b.py', line: 1, framework: 'FastAPI' },
    ],
    clientCalls: [{ file: 'client.js', line: 2, method: 'GET', path: '/api/health' }],
});
assert.equal(conflictingClient.summary.ambiguousClientCalls, 1);
assert.equal(conflictingClient.clientLinks.length, 0, 'duplicate static routes must not produce a fabricated service link');
const limitedGraph = analyzeExecutionIntelligence({
    files: [{ path: 'handlers.py' }],
    endpoints: [{ method: 'GET', path: '/graph', file: 'handlers.py', line: 1, framework: 'FastAPI' }],
    functions: [
        { file: 'handlers.py', line: 2, endLine: 3, name: 'one' },
        { file: 'handlers.py', line: 4, endLine: 5, name: 'two' },
        { file: 'handlers.py', line: 6, endLine: 7, name: 'three' },
    ],
    functionConnections: [
        { callerFunctionKey: 'handlers.py|2|one', calleeFunctionKey: 'handlers.py|4|two', callerFile: 'handlers.py', callSiteLine: 3, resolution: 'resolved' },
        { callerFunctionKey: 'handlers.py|4|two', calleeFunctionKey: 'handlers.py|6|three', callerFile: 'handlers.py', callSiteLine: 5, resolution: 'resolved' },
        { callerFunctionKey: 'handlers.py|6|three', calleeFunctionKey: 'handlers.py|2|one', callerFile: 'handlers.py', callSiteLine: 7, resolution: 'resolved' },
    ],
}, { maxDepth: 1 });
assert.equal(limitedGraph.flows[0].truncated, true);
assert.equal(limitedGraph.flows[0].steps.length, 2);


const syntax = analyzeSyntaxDiagnostics([
    { path: 'bad.json', content: '{ invalid' },
    { path: 'good.json', content: '{"ok":true}' },
    { path: 'tsconfig.json', content: '{ /* comment */ "compilerOptions": {} }' },
]);
assert.equal(syntax.summary.failed, 1);
assert.equal(syntax.summary.verified, 1);
assert.equal(syntax.summary.unsupported, 1);
assert.equal(syntax.checks.find((item) => item.path === 'bad.json').status, 'syntax-error');
const invalidRef = auditSourceEvidence([{ path: 'a.ts', content: 'line1\nline2' }], { dependencies: [
    { source: 'a.ts', target: 'missing.ts', resolution: 'resolved', line: 99 },
] });
assert.equal(invalidRef.status, 'failed');
assert.equal(invalidRef.summary.invalid, 2);

const otel = correlateRuntimeEvidence([
    { traceId: 'tr', spanId: 'root', attributes: { 'http.request.method': 'POST', 'http.route': '/api/orders' } },
    { traceId: 'tr', spanId: 'child', parentSpanId: 'root' },
    { traceId: 'tr', spanId: 'orphan', parentSpanId: 'missing' },
], first.apiEndpoints);
assert.equal(otel.summary.observedParentChildLinks, 1);
assert.equal(otel.summary.orphanParents, 1);
assert.equal(otel.summary.matchedEndpoints, 1);
assert.equal(otel.status, 'partial');
const withRuntime = await analyzeRepository({ name: 'runtime-evidence' }, sample, null, { runtimeSpans: [
    { traceId: 'verified-trace', spanId: 'root', attributes: { 'http.method': 'POST', 'http.route': '/api/orders' } },
] });
assert.equal(withRuntime.runtimeEvidence.summary.matchedEndpoints, 1);

const labeled = evaluateGraphEdges([
    { source: 'backend/orders.py', target: 'backend/service.py', present: true },
    { source: 'frontend/submit.js', target: 'backend/service.py', present: false },
], first.dependencies);
assert.equal(labeled.status, 'labelled-sample');
assert.equal(labeled.truePositives, 1);
assert.equal(labeled.falsePositives, 0);
assert.equal(labeled.falseNegatives, 0);
assert.equal(labeled.precision, 1);
assert.equal(evaluateGraphEdges([], first.dependencies).precision, null);

console.log(JSON.stringify({ status: 'passed', suite: 'v6.2-source-backed-intelligence', checks: [
    'FastAPI route to imported function with source-line evidence',
    'strict frontend/backend HTTP method and path links',
    'ambiguous and absent handler exclusion',
    'portable SHA-256 extraction checkpoint across cold cache',
    'changed and deleted sources never leak stale graph edges',
    'JSON/JSONC parser status separation',
    'invalid source-reference detection',
    'optional supplied OpenTelemetry-like correlation',
    'manually labelled graph edge evaluation',
], snapshotReuse: { extractionHits: reread.analysisCache.portableExtractionHits, complexityHits: reread.analysisCache.portableComplexityHits },
    sourceEvidence: first.evidenceAudit.summary, endToEnd: first.executionIntelligence.summary }, null, 2));
