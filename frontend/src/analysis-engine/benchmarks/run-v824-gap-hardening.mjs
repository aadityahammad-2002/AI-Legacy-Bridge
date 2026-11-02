import assert from 'node:assert/strict';
import { buildCallGraph } from '../callGraph.js';
import { analyzeExecutionIntelligence } from '../executionIntelligence.js';
import { analyzeBusinessIntelligence } from '../businessIntelligence.js';

function callModel(files, definitions) {
    return buildCallGraph(files.map(([path,content])=>({path,content})),definitions);
}
const packageFiles = [
    ['app/api/entry.py','from ..domain import payment\ndef submit(order):\n    return payment.charge(order)\n'],
    ['app/domain/payment.py','def charge(order):\n    return True\n'],
    ['other/domain/payment.py','def charge(order):\n    return False\n'],
];
const packageFunctions = [
    {file:'app/api/entry.py',name:'submit',line:2,endLine:3,type:'function'},
    {file:'app/domain/payment.py',name:'charge',line:1,endLine:2,type:'function'},
    {file:'other/domain/payment.py',name:'charge',line:1,endLine:2,type:'function'},
];
const imported = callModel(packageFiles,packageFunctions);
assert(imported.functionConnections.some(e=>e.resolution==='resolved' && e.callerFile==='app/api/entry.py' && e.calleeFile==='app/domain/payment.py' && e.callName==='charge'),'python relative import resolves the correct package');
assert(!imported.functionConnections.some(e=>e.callerFile==='app/api/entry.py' && e.calleeFile==='other/domain/payment.py'),'wrong similarly named package must not be selected');

const fakeRelative = callModel([
    ['app/api/entry.py','from ..missing import payment\ndef submit(o):\n    return payment.charge(o)'],
    ['other/missing/payment.py','def charge(o):\n    return True'],
], [
    {file:'app/api/entry.py',name:'submit',line:2,endLine:3,type:'function'},
    {file:'other/missing/payment.py',name:'charge',line:1,endLine:2,type:'function'},
]);
assert(!fakeRelative.functionConnections.some(e=>e.resolution==='resolved' && e.calleeFile==='other/missing/payment.py'),'relative module imports must not fall back to cross-package suffix guesses');

const receiver = callModel([['src/receiver.js','class Widget { save() { return true; } }\nfunction unrelated() { return this.save(); }']], [
    {file:'src/receiver.js',name:'Widget.save',className:'Widget',isClassMethod:true,line:1,endLine:1,type:'method'},
    {file:'src/receiver.js',name:'unrelated',line:2,endLine:2,type:'function'},
]);
assert(!receiver.functionConnections.some(e=>e.resolution==='resolved' && e.receiver==='this'),'top-level this.method cannot select arbitrary class method');

const source = [
    'function createOrder(req, res) { return res.send("ok"); }',
    'router.post(',
    '  "/api/orders",',
    '  validateInput,',
    '  createOrder',
    ');',
].join('\n');
const apiInput = {files:[{path:'src/api.js',content:source}],functions:[{file:'src/api.js',name:'createOrder',line:1,endLine:1,type:'function'}],endpoints:[{file:'src/api.js',line:2,method:'POST',path:'/api/orders',framework:'Express'}]};
const traced = analyzeExecutionIntelligence(apiInput);
assert.equal(traced.summary.tracedEndpoints,1,'multiline Express routes resolve explicit named handler');
assert.equal(traced.flows[0].handler.functionKey,'src/api.js|1|createOrder');
const fake = analyzeExecutionIntelligence({...apiInput,endpoints:[{...apiInput.endpoints[0],path:'/api/other'}]});
assert.equal(fake.summary.unresolvedHandlers,1,'wrong route literal cannot connect to handler');
const inline = analyzeExecutionIntelligence({...apiInput,files:[{path:'src/api.js',content:'router.post("/api/orders", (req,res)=>res.end());'}],endpoints:[{file:'src/api.js',line:1,method:'POST',path:'/api/orders',framework:'Express'}]});
assert.equal(inline.summary.unresolvedHandlers,1,'inline callback without extracted symbol must remain unresolved');
const badLine = analyzeExecutionIntelligence({...apiInput,functionConnections:[{callerFunctionKey:'src/api.js|1|createOrder',calleeFunctionKey:'src/api.js|1|createOrder',callerFile:'src/api.js',callSiteLine:100000,resolution:'resolved'}]});
assert.equal(badLine.summary.excludedUnresolvedCallEdges,1,'invalid source-line calls excluded from execution traces');

const businessFiles = [
    {path:'domain/order.py',content:'def cancel(order):\n    if order.status == "SHIPPED": return False\n    if order.status == "PENDING": order.status = "CANCELLED"\n    if config.DEBUG: return False  # invoice payment order\n'},
    {path:'domain/order.js',content:'function f(order) {\n  if (order.enabled) {\n    if (order.cancelled) { throw Error("blocked"); }\n  }\n  if (order.expired) { throw Error("expired"); }\n}\n'},
];
const rules = analyzeBusinessIntelligence(businessFiles);
assert(rules.rules.some(r=>r.file==='domain/order.py' && r.line===2),'Python one-line return is a bounded rule');
assert(rules.rules.some(r=>r.file==='domain/order.py' && r.line===3),'Python one-line status change is a bounded rule');
assert(!rules.rules.some(r=>r.file==='domain/order.js' && r.line===2),'nested-only outcome should not be incorrectly attached to outer guard');
assert(rules.rules.some(r=>r.file==='domain/order.js' && r.line===3),'nested guard retains its own direct outcome');
assert(rules.rules.some(r=>r.file==='domain/order.js' && r.line===5),'independent direct outcome still included');
assert(!rules.rules.some(r=>r.file==='domain/order.py' && r.line===4 && r.relevance.category==='business-likely'),'trailing comment words cannot promote debug guard to business');
assert(rules.stateTransitions.some(t=>t.line===3 && t.to==='CANCELLED'));
console.log(JSON.stringify({status:'passed',testCases:13,scope:'hand-labeled static evidence and negative controls; not enterprise precision benchmark',moduleRelativeLinks:imported.functionConnections.filter(e=>e.resolution==='resolved').length,tracedEndpoint:traced.summary.tracedEndpoints,ruleCandidates:rules.rules.length}));
