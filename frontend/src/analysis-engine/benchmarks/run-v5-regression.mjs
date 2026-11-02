/** Focused regression checks for V5 model, custom rules, and advanced analyses. */
import assert from 'node:assert/strict';
import { analyzeRepository, compareAnalysisResults, queryAnalysisModel, sliceAnalysisModel, toSarifLog, toAnalysisJson, createAnalysisSnapshot } from '../orchestrator.js';
import { buildUnifiedAnalysisModel } from '../unifiedAnalysisModel.js';
import { runAdvancedAnalysis } from '../advancedAnalysis.js';
import { loadCustomRules, runCustomRules } from '../ruleEngine.js';

const files = [
    { path: 'src/events.js', content: [
        'export function emitInvoice(bus, invoice) {',
        "  bus.emit('invoice.created', invoice);",
        '}',
        'export function subscribeInvoice(bus) {',
        "  bus.on('invoice.created', handleInvoice);",
        '}',
        'export function readReport(path) {',
        '  const stream = open(path);',
        '  return stream.read();',
        '}',
        'export function charge(db) {',
        '  db.beginTransaction();',
        '  db.updateLedger();',
        '}',
        "export function legacyDanger(input) { return eval(input); }",
    ].join('\n') },
    { path: '.analysis-engine-rules.json', content: JSON.stringify({ rules: [{ id: 'no-legacy-danger', message: 'Avoid legacyDanger calls', severity: 'warning', category: 'security', pattern: '\\blegacyDanger\\s*\\(' }] }) },
    { path: 'src/AccountRoutes.js', content: "router.get('/accounts/:id', getAccount);\n" },
    { path: 'src/AccountRoutes2.js', content: "router.get('/accounts/{accountId}', getAccount);\n" },
    { path: 'src/consumer.dart', content: 'void run() {}\n' },
    { path: 'analysis-suppressions.json', content: JSON.stringify({ suppressions: [{ ruleId: 'custom.no-legacy-danger', path: 'src/events.js', line: 15, reason: 'Legacy compatibility shim; tracked for migration.' }] }) },
];

const customConfig = loadCustomRules(files);
assert.equal(customConfig.rules.length, 1, 'A repository-local custom rule should load.');
const custom = runCustomRules(files, customConfig);
assert.ok(custom.findings.some((item) => item.ruleId === 'custom.no-legacy-danger'), 'Custom line rule should emit a stable finding.');

const functions = [
    { name: 'emitInvoice', file: 'src/events.js', line: 1, endLine: 3, type: 'function', isExported: true, isTopLevel: true },
    { name: 'subscribeInvoice', file: 'src/events.js', line: 4, endLine: 6, type: 'function', isExported: true, isTopLevel: true },
    { name: 'readReport', file: 'src/events.js', line: 7, endLine: 10, type: 'function', isExported: true, isTopLevel: true },
    { name: 'charge', file: 'src/events.js', line: 11, endLine: 14, type: 'function', isExported: true, isTopLevel: true },
];
const advanced = runAdvancedAnalysis({
    files, functions, dependencies: [{ source: 'src/AccountRoutes.js', target: 'src/events.js', type: 'import', resolution: 'resolved' }],
    callGraph: { functionConnections: [] },
    apiEndpoints: [
        { method: 'GET', path: '/accounts/:id', file: 'src/AccountRoutes.js', line: 1, framework: 'Express' },
        { method: 'GET', path: '/accounts/{accountId}', file: 'src/AccountRoutes2.js', line: 1, framework: 'Express' },
    ],
    findings: [], testLinkage: { links: [] },
}, custom);
assert.ok(advanced.eventFlows.flows.some((flow) => flow.event === 'invoice.created'), 'Publisher/subscriber event name should be linked.');
assert.ok(advanced.resourceLifecycle.items.some((item) => item.function === 'readReport' && !item.releaseDetected), 'Missing cleanup candidate should be recorded.');
assert.ok(advanced.transactionAnalysis.items.some((item) => item.function === 'charge' && !item.hasCommit && !item.hasRollback), 'Unbalanced explicit transaction should be recorded.');
assert.ok(advanced.apiContracts.normalizedRouteCollisions.length > 0, 'Equivalent parameterized route shapes should be compared.');
assert.ok(advanced.coverage.unsupportedFiles.includes('src/consumer.dart'), 'Known unsupported code extension should be visible.');

const snapshotA = await createAnalysisSnapshot([{ path: 'src/z.js', content: 'z' }, { path: 'src/a.js', content: 'a' }]);
const snapshotB = await createAnalysisSnapshot([{ path: 'src/a.js', content: 'a' }, { path: 'src/z.js', content: 'z' }]);
const snapshotC = await createAnalysisSnapshot([{ path: 'src/a.js', content: 'changed' }, { path: 'src/z.js', content: 'z' }]);
assert.equal(snapshotA.id, snapshotB.id, 'Snapshot ID should be independent of input file order.');
assert.notEqual(snapshotA.id, snapshotC.id, 'Snapshot ID should change when source content changes.');

const model = buildUnifiedAnalysisModel({
    files: [{ path: 'src/a.js', language: 'javascript' }, { path: 'src/b.js', language: 'javascript' }],
    functions: [{ name: 'start', file: 'src/a.js', line: 1, endLine: 3, isExported: true }, { name: 'work', file: 'src/b.js', line: 1, endLine: 3 }],
    dependencies: [{ source: 'src/a.js', target: 'src/b.js', type: 'import', resolution: 'resolved' }],
    callGraph: { functionConnections: [{ callerFunctionKey: 'src/a.js|1|start', callerFunctionName: 'start', callerFile: 'src/a.js', callerStartLine: 1, calleeFunctionKey: 'src/b.js|1|work', calleeFunctionName: 'work', calleeFile: 'src/b.js', calleeStartLine: 1, callSiteLine: 2, resolution: 'resolved' }] },
    apiEndpoints: [], databaseSchema: { tables: [] }, testLinkage: { links: [] }, findings: [],
});
assert.equal(model.status, 'complete');
assert.ok(queryAnalysisModel(model, { entityKind: 'function', name: 'work' }).length === 1, 'Model query should return matching symbols.');
const sourceEntity = model.entities.find((entity) => entity.kind === 'file' && entity.path === 'src/a.js');
const slice = sliceAnalysisModel(model, { seedId: sourceEntity.id, direction: 'forward', maxDepth: 3 });
assert.ok(slice.entities.some((entity) => entity.path === 'src/b.js'), 'Forward slice should cross the dependency edge.');
const current = { findings: [{ ruleId: 'security.demo', title: 'Demo issue', file: 'src/a.js', line: 3 }], dependencies: [{ source: 'src/a.js', target: 'src/b.js', type: 'import', resolution: 'resolved' }], apiEndpoints: [{ method: 'GET', path: '/a', file: 'src/a.js', line: 1 }], databaseSchema: { tables: [{ name: 'alpha', file: 'src/a.js' }] } };
const previous = { findings: [], dependencies: [], apiEndpoints: [], databaseSchema: { tables: [] } };
const diff = compareAnalysisResults(previous, current);
assert.equal(diff.summary.newFindings, 1);
assert.equal(diff.summary.addedRoutes.length, 1);
assert.equal(diff.summary.addedTables.length, 1);

const integrated = await analyzeRepository({ name: 'v5-integration', source: 'local' }, files);
assert.ok(integrated.analysisModel?.entities?.length, 'analyzeRepository should return the unified model.');
assert.ok(integrated.advancedAnalysis?.eventFlows, 'analyzeRepository should wire advanced analyses.');
assert.equal(integrated.customRules?.ruleCount, 1, 'analyzeRepository should load repository-local rules.');
assert.ok(integrated.analysisCoverage?.unifiedModel, 'Coverage should report the unified model stage.');
assert.ok(integrated.findings.some((item) => item.ruleId === 'custom.no-legacy-danger'), 'Custom findings should join the main findings array.');
assert.ok(integrated.findings.some((item) => item.ruleId === 'custom.no-legacy-danger' && item.status === 'suppressed'), 'Exact repository-local suppression should label matching finding.');
assert.equal(integrated.findingSuppression.summary.suppressedFindings, 1);
const sarif = toSarifLog(integrated);
assert.equal(sarif.version, '2.1.0');
assert.ok(sarif.runs[0].results.length > 0, 'SARIF export should include findings.');
assert.ok(JSON.parse(toAnalysisJson({ ok: true })).ok, 'JSON export helper should produce parseable JSON.');
assert.ok(integrated.analysisSnapshot?.id, 'Integrated run should record a snapshot ID.');

console.log(JSON.stringify({
    status: 'passed', benchmark: 'analysis-engine-v5-regression',
    customRules: { loaded: customConfig.rules.length, findings: custom.findings.length },
    eventFlows: advanced.eventFlows.flows.length,
    resourceLifecycleCandidates: advanced.resourceLifecycle.items.length,
    transactionCandidates: advanced.transactionAnalysis.items.length,
    routeCollisions: advanced.apiContracts.normalizedRouteCollisions.length,
    unsupportedFilesReported: advanced.coverage.unsupportedFiles.length,
    model: model.summary,
    queryCount: queryAnalysisModel(model, { entityKind: 'function', name: 'work' }).length,
    slicedEntities: slice.entities.length,
    integratedModelEntities: integrated.analysisModel.summary.entityCount,
    integratedFindings: integrated.findings.length,
    suppressedFindings: integrated.findingSuppression.summary.suppressedFindings,
    sarifResults: sarif.runs[0].results.length,
    snapshotAlgorithm: integrated.analysisSnapshot.algorithm,
    snapshotReproducibility: snapshotA.id === snapshotB.id && snapshotA.id !== snapshotC.id ? 'passed' : 'failed',
    limitations: ['Heuristic analyses are candidates, not proofs.', 'Formal symbolic execution, general model checking, and universal termination proofs are not implemented.'],
}, null, 2));
