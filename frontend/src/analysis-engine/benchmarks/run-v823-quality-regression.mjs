import assert from 'node:assert/strict';
import { buildCallGraph } from '../callGraph.js';
import { analyzeBusinessIntelligence } from '../businessIntelligence.js';
import { buildUnifiedAnalysisModel } from '../unifiedAnalysisModel.js';

// Independently stated expected edges, including deliberately misleading
// name collisions and non-imported object receivers. Not an enterprise eval.
const files = [
    { path: 'app/order_api.py', content: 'from . import pricing\ndef checkout(order):\n    return pricing.apply_discount(order)\n' },
    { path: 'app/pricing.py', content: 'def apply_discount(order):\n    return order.total\n' },
    { path: 'src/api.js', content: 'import * as rules from "./rules.js";\nexport function validate(order) { return rules.check(order); }\n' },
    { path: 'src/rules.js', content: 'export function check(order) { return order.status; }\n' },
    { path: 'java/BillingService.java', content: 'public class BillingService {\n public int pay() { return 1; }\n}\n' },
    { path: 'java/BillingController.java', content: 'public class BillingController {\n private BillingService service;\n public int charge() { return service.pay(); }\n}\n' },
    { path: 'src/unrelated.js', content: 'export function get() { return true; }\nexport function unknown() { return suspicious.get(); }\n' },
    { path: 'java/pkg/InvoiceService.java', content: 'package pkg;\npublic class InvoiceService {\n public int issue() { return 1; }\n}\n' },
    { path: 'java/pkg/InvoiceApi.java', content: 'package pkg;\npublic class InvoiceApi {\n private InvoiceService invoice;\n public int invoke() { return invoice.issue(); }\n}\n' },
    { path: 'docs/README.md', content: 'Example only: rules.check(order), invoice.issue(), pricing.apply_discount(order)\n' },
];
const functions = [
    {file:'app/order_api.py',name:'checkout',line:2,endLine:3,type:'function'},
    {file:'app/pricing.py',name:'apply_discount',line:1,endLine:2,type:'function'},
    {file:'src/api.js',name:'validate',line:2,endLine:2,type:'function'},
    {file:'src/rules.js',name:'check',line:1,endLine:1,type:'function'},
    {file:'java/BillingService.java',name:'pay',line:2,endLine:2,type:'method'},
    {file:'java/BillingController.java',name:'charge',line:3,endLine:3,type:'method'},
    {file:'src/unrelated.js',name:'get',line:1,endLine:1,type:'function'},
    {file:'src/unrelated.js',name:'unknown',line:2,endLine:2,type:'function'},
    {file:'java/pkg/InvoiceService.java',name:'issue',line:3,endLine:3,type:'method'},
    {file:'java/pkg/InvoiceApi.java',name:'invoke',line:4,endLine:4,type:'method'},
];
const graph = buildCallGraph(files,functions,[{source:'java/BillingController.java',target:'java/BillingService.java',resolution:'resolved',type:'import'}]);
const expected = new Set([
    'app/order_api.py|app/pricing.py|apply_discount',
    'src/api.js|src/rules.js|check',
    'java/BillingController.java|java/BillingService.java|pay',
    'java/pkg/InvoiceApi.java|java/pkg/InvoiceService.java|issue',
]);
const observed = new Set(graph.functionConnections.filter(e=>e.resolution==='resolved')
    .map(e=>`${e.callerFile}|${e.calleeFile}|${e.callName}`));
const tp = [...observed].filter(e=>expected.has(e)).length;
const fp = [...observed].filter(e=>!expected.has(e)).length;
const fn = [...expected].filter(e=>!observed.has(e)).length;
const callPrecision = tp/(tp+fp || 1), callRecall = tp/(tp+fn || 1);
assert(callPrecision >= .8 && callRecall >= .8,'known call targets should be resolved without false edges');
assert(graph.diagnostics.unresolvedCalls.some(e=>e.receiver==='suspicious' && e.functionName==='get'), 'unimported ambiguous receiver stays unresolved');
assert(graph.diagnostics.resolvedNamespaceCalls >= 2, 'explicit imported namespaces resolved');
assert(functions.find(e=>e.name==='charge').className==='BillingController');

const ruleFiles = [
    {path:'domain/orders.py',content:[
        'def cancel(order):','    if order.status == "SHIPPED":','        raise ValueError("Cannot cancel shipped order")',
        '    if order.total > 500:','        return "VIP"',
        '    if config.DEBUG:','        return False',
        '    if cache is None:','        return False',
        '    if invoice.paid:','        return False',
        '    return True',
    ].join('\n')},
    {path:'domain/billing.js',content:[
        'function handle(payment, order, cache) {',
        'if (payment.status === "FAILED") { throw new Error("Payment failed"); }',
        'if (order.status === "OPEN") { return true; }',
        'if (cache === null) { return false; }',
        'if (process.env.DEBUG === "1") { return false; }',
        'return false;',
        '}',
    ].join('\n')},
];
const business = analyzeBusinessIntelligence(ruleFiles, {maxRules:30,functions:[]});
const gold = [
    ['domain/orders.py',2,true],['domain/orders.py',4,true],['domain/orders.py',6,false],
    ['domain/orders.py',8,false],['domain/orders.py',10,true],
    ['domain/billing.js',2,true],['domain/billing.js',3,true],
    ['domain/billing.js',4,false],['domain/billing.js',5,false],
];
let btp=0,bfp=0,bfn=0,btn=0;
for (const [path,line,wanted] of gold) {
    const rule=business.rules.find(r=>r.file===path && r.line===line);
    const predicted=rule?.relevance?.category==='business-likely';
    if (wanted && predicted) btp++;else if(wanted)bfn++;else if(predicted)bfp++;else btn++;
}
const businessPrecision=btp/(btp+bfp||1), businessRecall=btp/(btp+bfn||1);
assert(businessPrecision>=.8&&businessRecall>=.8,'controlled business-likely selection needs precision and recall >=80%');

const model=buildUnifiedAnalysisModel({files:[{path:'a.js',content:'a()'},{path:'b.js',content:'b()'}],functions:[],dependencies:[
    {source:'a.js',target:'b.js',resolution:'resolved',type:'import',line:1},
    {source:'b.js',target:'a.js',resolution:'inferred',type:'import',line:1},
    {source:'b.js',target:'absent',resolution:'unresolved',type:'import',line:1},
]});
assert.equal(model.diagnostics.inferredRelationCount,1);
assert.equal(model.diagnostics.unresolvedRelationCount,1);
assert.equal(model.diagnostics.externalReferenceCount,1);
assert.equal(model.diagnostics.danglingEdgeCount,0);
console.log(JSON.stringify({status:'passed',baselineScope:'controlled handwritten labeled fixtures — not independent enterprise evaluation',
    call:{tp,fp,fn,precision:callPrecision,recall:callRecall,resolvedExplicitNamespace:graph.diagnostics.resolvedNamespaceCalls},
    business:{tp:btp,fp:bfp,fn:bfn,tn:btn,precision:businessPrecision,recall:businessRecall},
    graph:{inferred:model.diagnostics.inferredRelationCount,genuinelyUnresolved:model.diagnostics.unresolvedRelationCount}},null,2));
