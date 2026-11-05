/** Targeted Phase 3/4 regression of existing outputs; runnable with Node alone. */
import assert from 'node:assert/strict';
import { analyzeHeuristicDataFlows, analyzeInterproceduralDataFlows } from '../dataFlow.js';
import { computeModuleBoundaries } from '../architecture.js';
import { computeChangeImpact, computeFunctionImpact } from '../changeImpact.js';
import { analyzeTestLinkage } from '../testLinkage.js';
import { buildAnalysisCoverage } from '../analysisContracts.js';
import { ENGINE_VERSION } from '../engineVersion.js';
import { runAdvancedAnalysis } from '../advancedAnalysis.js';

let checks = 0;
const check = (value, expected, description) => { assert.deepEqual(value, expected, description); checks++; };
const js = (content) => [{ path: 'src/probe.js', content }];
const count = (content) => analyzeHeuristicDataFlows(js(content)).flows.length;
const base = 'function run(req, db) {\nconst value = req.body.value;\n';
check(count(base + 'db.query(value);\n}'), 1, 'Real SQL flow');
check(count(base + "const safe = value; db.query('SELECT 1');\n}"), 0, 'Unrelated constant SQL sink on compound line');
check(count(base + 'const reg = /a/; reg.exec(value);\n}'), 0, 'RegExp.exec not a command sink');
check(count(base + 'db.query(req.query.name);\n}'), 1, 'Direct inline source without unrelated tainted variable');
check(count(base + 'db.query("SELECT 1");\n}'), 0, 'Constant query');
check(count(base + 'db.query(value);\n}'), 1, 'Repeat deterministic result');
check(count(base + "eval(value);\n}"), 1, 'Real dynamic-eval sink');
check(count(base + "const safe = 'ok';\ndb.query(safe);\n}"), 0, 'Assignment kill');
check(count(base + 'const escaped = escapeHtml(value);\nnode.innerHTML = escaped;\n}'), 1, 'Mitigation hint does not silently suppress flow');
check(analyzeHeuristicDataFlows(js(base + 'const escaped = escapeHtml(value);\nnode.innerHTML = escaped;\n}')).flows[0].mitigationSignals?.length > 0, true, 'Mitigation hint recorded');
check(count('// db.query(req.body)\nfunction noRisk() {\n const x="eval(req.body)";\n}'), 0, 'No string/comment sink');
check(analyzeHeuristicDataFlows([{path:'server/query.py',content:'def search(request, cursor):\n    user = request.args.get("name")\n    cursor.execute(user)\n'}]).flows.length, 1, 'Python input to database sink');
const interfiles = [
 {path:'src/input.js',content:'function entry(req) {\n const v = req.body.value;\n return unsafe(v);\n}'},
 {path:'src/sink.js',content:'function unsafe(arg) {\n db.query(arg);\n}'},
];
const f1={name:'entry',file:'src/input.js',line:1,endLine:4};
const f2={name:'unsafe',file:'src/sink.js',line:1,endLine:3};
const edge={callerFunctionKey:'src/input.js|1|entry',calleeFunctionKey:'src/sink.js|1|unsafe',callerFile:'src/input.js',calleeFile:'src/sink.js',calleeFunctionName:'unsafe',callName:'unsafe',callSiteLine:3,resolution:'resolved'};
const inter = analyzeInterproceduralDataFlows(interfiles,[f1,f2],[edge]);
check(inter.flows.some(f=>f.source.path==='src/input.js' && f.sink.path==='src/sink.js'),true,'Interprocedural propagation preserved');
check(inter.summary.stateLimitReached,false,'Natural completion is not state truncation');
const unsafeFree = analyzeInterproceduralDataFlows([interfiles[0],{...interfiles[1],content:'function unsafe(arg) {\n db.query("fixed");\n}'}],[f1,f2],[edge]);
check(unsafeFree.flows.length,0,'No false interprocedural sink on constant call');
const order='backend/src/main/java/com/acme/order/OrderService.java';
const pay='backend/src/main/java/com/acme/payment/PaymentService.java';
const files=[{path:order},{path:pay}];
const dependencies=[{source:order,target:pay,resolution:'resolved'}];
const architecture=computeModuleBoundaries({files,dependencies});
check(architecture.edges,[{from:'order',to:'payment',count:1}],'Maven package/domain boundaries');
check(architecture.modules.map(m=>m.name),['order','payment'],'Stable sorted package names');
check(computeModuleBoundaries({files:[...files].reverse(),dependencies:[...dependencies].reverse()}),architecture,'Determinism under input reordering');
check(computeModuleBoundaries({files:[{path:'src/orders/Order.ts'},{path:'src/payments/Payment.ts'}],dependencies:[{source:'src/orders/Order.ts',target:'src/payments/Payment.ts',resolution:'resolved'}]}).edges[0].from,'orders','JS source-root boundaries preserved');
const deps=[{source:'src/b.js',target:'src/core.js',resolution:'resolved'},{source:'src/a.js',target:'src/core.js',resolution:'resolved'},{source:'src/c.js',target:'src/a.js',resolution:'resolved'},{source:'src/c.js',target:'src/core.js',resolution:'ambiguous'}];
const impact=computeChangeImpact('src/core.js',deps);
check(impact.affectedFiles.map(x=>x.path),['src/a.js','src/b.js','src/c.js'],'Direct and transitive impact');
check(impact.possibleDirectDependents.map(x=>x.path),['src/c.js'],'Ambiguous impact separate');
check(computeChangeImpact('src/core.js',[...deps].reverse()),impact,'Impact deterministic across dependency order');
check(computeChangeImpact('src/core.js',deps,{}, {maxNodes:1}).completeness,'partial','Bounded impact honestly marked partial');
const callerEdges=[{callerFunctionKey:'src/a.js|1|a',calleeFunctionKey:'src/b.js|1|b',callerFunctionName:'a',callerFile:'src/a.js',resolution:'resolved',confidence:'medium'},{callerFunctionKey:'src/c.js|1|c',calleeFunctionKey:'src/a.js|1|a',callerFunctionName:'c',callerFile:'src/c.js',resolution:'resolved',confidence:'medium'}];
check(computeFunctionImpact('src/b.js|1|b',callerEdges).affectedFunctions.length,2,'Function-level reverse impact retained');
const link=analyzeTestLinkage([{path:'src/order.py',content:'def f(): pass'},{path:'src/test_order.py',content:'def test_f(): pass'}]);
check(link.links[0].confidence,'low','Naming test linkage remains low confidence');
check(analyzeTestLinkage([{path:'src/order.py',content:'def f(): pass'},{path:'src/order.test.ts',content:'test()'}]).links.length,0,'Cross-language basename not inferred');
const cov=buildAnalysisCoverage({files:[{path:'src/a.js'}],fileStatuses:[{path:'src/a.js',language:'JavaScript',parserStrategy:'heuristic',extraction:'complete',complexity:'complete'}],stageStatuses:{parser:'complete'}});
check(cov.status,'partial','Heuristic parser does not imply complete code coverage');
check(cov.parserCoverage.heuristicParserFiles,1,'Partial parser coverage counters');
const separateTrees = analyzeTestLinkage([{path:'backend/tests/test_order.py',content:'def test_order(): pass'},{path:'backend/app/order.py',content:'def order(): pass'}]);
check(separateTrees.links[0]?.sourceFile,'backend/app/order.py','Separated Python source and test trees linked via unique basename');
check(separateTrees.links[0]?.confidence,'low','Basename recovery never asserts test coverage');
check(analyzeTestLinkage([{path:'backend/tests/test_order.py',content:''},{path:'backend/app/order.py',content:''},{path:'backend/services/order.py',content:''}]).links.length,0,'Ambiguous same-name production targets excluded');
const codePath = (content) => runAdvancedAnalysis({
    files:[{path:'src/flag.js',content}],functions:[{name:'test',file:'src/flag.js',line:1,endLine:content.split('\n').length}],
}).pathFeasibility.possibleContradictions.length;
check(codePath('function test(flag) {\n const note = "if(flag)";\n if(!flag) return false;\n}'),0,'Branch text inside strings ignored');
check(codePath('function test(flag) {\n // if(flag)\n if(!flag) return false;\n}'),0,'Branch text inside comments ignored');
check(codePath('function test(flag) {\n if(flag) return true;\n if(!flag) return false;\n}'),1,'Executable opposite guards retained as a low-confidence hint');
const skippedCode = buildAnalysisCoverage({files:[{path:'src/skip.js'}], fileStatuses:[{path:'src/skip.js',language:'JavaScript',parserStrategy:'ast',extraction:'skipped',complexity:'skipped'}]});
check(skippedCode.status,'partial','Skipped code extraction cannot report complete coverage');
check(skippedCode.parserCoverage.skippedCodeFiles,1,'Skipped code reported separately from non-code');
const skippedDocumentation = buildAnalysisCoverage({files:[{path:'README.md'}], fileStatuses:[{path:'README.md',parserStrategy:'not-code',extraction:'skipped',complexity:'skipped'}]});
check(skippedDocumentation.parserCoverage.skippedCodeFiles,0,'Skipped documentation does not masquerade as skipped code');
check(ENGINE_VERSION,'8.2.11','Version changed to prevent stale report reuse');
console.log(JSON.stringify({status:'passed',engineVersion:ENGINE_VERSION,checks,focus:'existing semantic, data-flow, dependency, impact, test linkage and coverage accuracy',noNewAnalysisSections:true}));
