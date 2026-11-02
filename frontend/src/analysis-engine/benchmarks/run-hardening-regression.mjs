/** Focused v8.2 hardening checks: preserve original functionality and reject
 * previously observed self-analysis false positives. Source-backed fixtures,
 * not an enterprise accuracy benchmark or runtime behavior test. */
import assert from 'node:assert/strict';
import { analyzeRepository } from '../orchestrator.js';
import { discoverEndpoints, extractClientApiCalls } from '../api.js';
import { analyzeFrameworkSignals } from '../frameworkAnalysis.js';
import { analyzeBusinessIntelligence } from '../businessIntelligence.js';
import { deduplicateFindings } from '../findingQuality.js';
import { auditEngineeringGraph } from '../graphQuality.js';
import { analyzeExecutionIntelligence } from '../executionIntelligence.js';
import { validateAnalysisResult } from '../analysisContracts.js';
import { toAnalysisJson } from '../reportFormats.js';
import { classifyAnalysisSource } from '../sourceClassification.js';
import { ENGINE_VERSION } from '../engineVersion.js';
import { extractFileDependencies } from '../moduleResolution.js';
import { identifyCodeLanguage } from '../languageIntelligence.js';

const outcomes = {};
function verify(name, condition) { assert.ok(condition, name); outcomes[name] = 'passed'; }

const esmFiles = [
    {path:'src/entry.mts', content:'import { work } from "./worker.mjs"; work();'},
    {path:'src/worker.mts', content:'export function work() { return true; }'},
    {path:'src/helper.cts', content:'export const helper = () => 1;'},
];
const esmDeps = extractFileDependencies(esmFiles, []);
verify('existing TypeScript module variants parsed consistently', identifyCodeLanguage('src/entry.mts')==='TypeScript' && identifyCodeLanguage('src/helper.cts')==='TypeScript' && esmDeps.some(x => x.source==='src/entry.mts' && x.target==='src/worker.mts' && x.resolution==='resolved'));
const sources = [
    {path:'src/server.js', content:[
        'const doc = `router.get("/template-only", noop)`;',
        '// router.get("/comment-only", noop);',
        'const example = "app.post(\\"/string-only\\", handler)";',
        'function health(req, res) { return res.send("ok"); }',
        'router.get("/live", health);',
        'fetch("/api/live");',
    ].join('\n')},
    {path:'src/benchmarks/run-regression.mjs', content:'router.get("/fixture", handler);'},
    {path:'ai-service/app/main.py', content:[
        'from fastapi import FastAPI', 'app = FastAPI()', '@app.get("/health")',
        'def health():', '    return True',
    ].join('\n')},
    {path:'backend/Orders.java', content:[
        '@RequestMapping("/orders")', 'class Orders {',
        '  @GetMapping("/{id}")', '  public String get() { return "ok"; }',
        '}',
    ].join('\n')},
];
const routes = discoverEndpoints(sources);
verify('real routes retained', routes.length === 3 && routes.some(r => r.path === '/live') && routes.some(r => r.path === '/health') && routes.some(r => r.path === '/orders/{id}'));
verify('strings and comments excluded from API inventory', !routes.some(r => /template|comment|string|fixture/.test(r.path)));
verify('correct framework per language', routes.every(r => (r.framework==='Express' ? r.file.endsWith('.js') : r.framework==='Spring' ? r.file.endsWith('.java') : r.file.endsWith('.py'))));
const frameworks = analyzeFrameworkSignals(sources);
verify('no Python Express/Fastify misclassification', !frameworks.byFile['ai-service/app/main.py']?.some(x => ['express','fastify'].includes(x.framework)));
verify('no fake route registration in JS template string', !frameworks.routes.some(r=>r.path === '/template-only' || r.path === '/fixture'));
verify('client calls exclude illustrative strings', extractClientApiCalls(sources).length === 1);
verify('fixture classification is explicit', classifyAnalysisSource('src/benchmarks/run-regression.mjs')==='test-or-fixture' && classifyAnalysisSource('src/server.js')==='application');

const colliding = [
    {id:'v5:same', ruleId:'api.ambiguous-normalized-route', title:'Overlapping API', file:'src/server.js', line:9, message:'GET /users overlaps'},
    {id:'v5:same', ruleId:'api.ambiguous-normalized-route', title:'Overlapping API', file:'src/server.js', line:9, message:'POST /users overlaps'},
    {id:'v5:same', ruleId:'api.ambiguous-normalized-route', title:'Overlapping API', file:'src/server.js', line:9, message:'POST /users overlaps'},
];
const unique = deduplicateFindings(colliding);
verify('distinct findings get distinct stable IDs', unique.findings.length === 2 && new Set(unique.findings.map(x=>x.id)).size === 2 && unique.duplicateCount===1);
verify('stable finding ID assignment independent of input order', JSON.stringify(unique.findings.map(x=>[x.message,x.id]).sort()) === JSON.stringify(deduplicateFindings(colliding.slice().reverse()).findings.map(x=>[x.message,x.id]).sort()));

const code = [{path:'src/order.py',content:'def cancel(order):\n    if order.status == "PENDING":\n        order.status = "CANCELLED"\n        return True\n    return False\n'},
    {path:'src/__tests__/order.test.py',content:'def fake():\n    if order.status == "PENDING":\n        raise ValueError()\n'},
    {path:'src/nested.py',content:'class A:\n    def outer(self):\n        def inner():\n            return True\n        return inner()\n    def sibling(self):\n        return False\n'}];
const business = analyzeBusinessIntelligence(code);
verify('branch evidence scoped to production code', business.rules.length === 1 && business.rules[0].file==='src/order.py' && business.rules[0].owner===null);
verify('state change is backed by branch outcome', business.stateTransitions.length === 1 && business.stateTransitions[0].to==='CANCELLED');
const integrated = await analyzeRepository({name:'hardening'}, [...sources,...code]);
verify('nested Python function not misidentified as class method', integrated.functions.some(f=>f.file==='src/nested.py' && f.name==='inner') && integrated.functions.some(f=>f.file==='src/nested.py' && f.name==='A.sibling'));
verify('dependency output has no invalid source evidence', integrated.evidenceAudit.summary.invalid === 0);
verify('graph edges reference valid entities and source lines', integrated.graphQuality.summary.danglingEdges===0 && integrated.graphQuality.summary.invalidLine===0 && integrated.graphQuality.summary.duplicateEdgeIds===0);
verify('no benchmark endpoints in unified graph', !integrated.analysisModel.entities.some(e=>e.kind==='endpoint' && /benchmarks/.test(e.path)));
verify('source evidence preserved for real endpoints', integrated.analysisModel.entities.some(e=>e.kind==='endpoint' && e.path==='ai-service/app/main.py' && e.startLine===3));
verify('result contract valid', validateAnalysisResult(integrated).status==='valid' && integrated.outputContractValidation.status==='valid');
verify('repeat scans preserve identity sets', JSON.stringify((await analyzeRepository({name:'hardening'}, [...sources,...code])).analysisModel.edges.map(e=>e.id).sort()) === JSON.stringify(integrated.analysisModel.edges.map(e=>e.id).sort()));
verify('export JSON is valid and excludes raw fileContents', !toAnalysisJson({analysis:integrated,fileContents:{'secret.js':'secret'}}).includes('"fileContents"') && JSON.parse(toAnalysisJson(integrated)).engineVersion === ENGINE_VERSION);

const graph = auditEngineeringGraph({entities:[{id:'a',path:'src/a.js'}, {id:'b',path:'src/b.js'}], edges:[
    {id:'dup',source:'a',target:'b',type:'calls',line:1,resolution:'resolved'},
    {id:'dup',source:'a',target:'b',type:'calls',line:1,resolution:'resolved'},
]},[{path:'src/a.js',content:'call();'},{path:'src/b.js',content:'function call(){}'}]);
verify('duplicated graph relations flagged', graph.summary.duplicateEdgeIds===1 && graph.summary.duplicateRelations===1 && graph.status==='partial');
const namedFlow = analyzeExecutionIntelligence({
    endpoints:[{file:'src/route.js',line:2,method:'POST',path:'/api/orders',framework:'Express'}],
    files:[{path:'src/route.js',content:'function handler(req, res) { return true; }\napp.post("/api/orders", handler);'}],
    functions:[{file:'src/route.js',name:'handler',line:1,endLine:1,key:'src/route.js|1|handler'}]
});
verify('explicit named Express handler linked', namedFlow.flows[0].handler?.basis==='explicit-named-handler-argument');
const unknownFlow = analyzeExecutionIntelligence({
    endpoints:[{file:'src/route.js',line:2,method:'POST',path:'/api/orders',framework:'Express'}],
    files:[{path:'src/route.js',content:'function wrapper() {\n  app.post("/api/orders", (req) => work(req));\n}\n'}],
    functions:[{file:'src/route.js',name:'wrapper',line:1,endLine:3,key:'src/route.js|1|wrapper'}]
});
verify('registration wrapper not hallucinated as route handler', unknownFlow.flows[0].status==='unresolved-handler');
const invalidResult = validateAnalysisResult({...integrated,findings:[...colliding]});
verify('duplicate findings violate result contract', invalidResult.status==='invalid');
console.log(JSON.stringify({status:'passed',engineVersion:ENGINE_VERSION, checks:Object.keys(outcomes).length, outcomes,
    sample:{files:integrated.files.length,endpoints:integrated.apiEndpoints.length,graphEdges:integrated.analysisModel.edges.length},
    caveat:'Fixture correctness and deterministic self-checks, not enterprise precision/recall or runtime validation.'},null,2));
