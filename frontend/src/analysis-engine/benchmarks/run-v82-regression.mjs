import assert from 'node:assert/strict';
import { analyzeRepository } from '../orchestrator.js';
import { analyzeBusinessIntelligence } from '../businessIntelligence.js';
import { analyzeCrossSystemIntelligence } from '../crossSystemIntelligence.js';
import { auditEngineeringGraph } from '../graphQuality.js';
import { traceEngineeringFlows } from '../engineeringIntelligence.js';
import { evaluateIntelligenceLabels } from '../intelligenceBenchmark.js';

// Hand-labeled positive and negative branch evidence, not a production accuracy benchmark.
const ruleCorpus = [
    {path:'orders.py',content:[
        'def cancel(order):',
        '    if order.status == "SHIPPED":',
        '        raise ValueError("cannot cancel")',
        '    if order.status == "PENDING":',
        '        order.status = "CANCELLED"',
        '        return True',
        '    if order.status == "EMPTY":',
        '        pass',
        '    return False',
    ].join('\n')},
    {path:'orders.js',content:[
        'function cancel(order) {',
        '  if (order.status === "CLOSED") {',
        '    throw Error("locked");',
        '  }',
        '  if (order.status === "NEW") {}',
        '  return false;',
        '}',
        '// if (false === true) { throw Error("fake") }',
        'const note = "if (status === CANCELLED) { throw fake }";',
    ].join('\n')},
];
const rules = analyzeBusinessIntelligence(ruleCorpus, { functions:[{file:'orders.py',name:'cancel',line:1,endLine:9},{file:'orders.js',name:'cancel',line:1,endLine:7}] });
assert.equal(rules.rules.length,3, 'only actual branches with in-scope outcomes should be included');
assert.deepEqual(rules.rules.map(r=>r.line),[2,4,2]);
assert.equal(rules.stateTransitions.length,1);
assert.equal(rules.stateTransitions[0].to,'CANCELLED');
assert.equal(rules.rules[1].owner?.name,'cancel');
assert(!rules.rules.some(r=>r.line===7 || r.line===5 || r.line===8), 'no out-of-branch or commented rule');
assert(rules.diagnostics.withoutOutcome >= 2);
const evaluation = evaluateIntelligenceLabels({businessIntelligence:rules},[
    {kind:'rule',file:'orders.py',line:2,present:true},
    {kind:'rule',file:'orders.py',line:4,present:true},
    {kind:'rule',file:'orders.js',line:2,present:true},
    {kind:'rule',file:'orders.py',line:7,present:false},
    {kind:'rule',file:'orders.js',line:5,present:false},
]);
assert.equal(evaluation.total.tp,3);
assert.equal(evaluation.total.tn,2);
assert.equal(evaluation.total.fp,0);
assert.equal(evaluation.total.fn,0);

const cross = analyzeCrossSystemIntelligence([
    {path:'kafka-producer.java',content:'kafkaTemplate.send("orders.created", order);'},
    {path:'unrelated.js',content:'eventBus.on("orders.created", fn);'},
    {path:'kafka-consumer.py',content:'reader = KafkaConsumer("orders.created")'},
    {path:'sql.py',content:'db.query("SELECT * FROM orders")'},
],{tables:[{name:'orders',file:'a.sql'},{name:'orders',file:'b.sql'}]});
assert.equal(cross.messageLinks.length,1,'link only to explicitly same transport');
assert.equal(cross.messageLinks[0].target.file,'kafka-consumer.py');
assert.equal(cross.summary.matchedSchemaTables,0,'ambiguous table names should not be arbitrarily linked');
assert.equal(cross.summary.ambiguousSchemaMatches,1);

const graph = { entities:[
    {id:'ui',kind:'file',name:'ui.js',path:'ui.js'},
    {id:'endpoint',kind:'endpoint',name:'POST /orders',path:'api.py'},
    {id:'handler',kind:'function',name:'create',path:'api.py'},
    {id:'unknown',kind:'external-reference',name:'unknown'},
], edges:[
    {id:'http',source:'ui',target:'endpoint',type:'http-request-candidate',resolution:'inferred',sourcePath:'ui.js',line:1},
    {id:'handler',source:'endpoint',target:'handler',type:'handler-function-candidate',resolution:'inferred',sourcePath:'api.py',line:1},
    {id:'unresolved',source:'handler',target:'unknown',type:'calls',resolution:'unresolved',sourcePath:'api.py',line:9},
    {id:'fallback',source:'ui',target:'unknown',type:'calls',resolution:'resolved',symbolResolution:'file-level-fallback',sourcePath:'ui.js',line:1},
    {id:'fake-contains',source:'handler',target:'unknown',type:'contains',resolution:'resolved',sourcePath:'api.py',line:1},
] };
const audit = auditEngineeringGraph(graph,[{path:'ui.js',content:'request()'},{path:'api.py',content:'def create():\n  pass'}]);
assert.equal(audit.summary.invalidLine,1);
assert.equal(audit.status,'partial');
const pathResult = traceEngineeringFlows(graph,'ui');
assert.equal(pathResult.paths.length,1);
assert.equal(pathResult.paths[0].entities.at(-1).id,'handler');
assert.equal(pathResult.paths[0].runtimeVerified,false);

const integrationFiles = [
    {path:'client.js',content:'fetch("/api/orders", {method:"POST"});'},
    {path:'api/orders.py',content:'from service import place_order\n@app.post("/api/orders")\ndef create_order():\n    return place_order()'},
    {path:'api/service.py',content:'def place_order():\n    if order.status == "SHIPPED":\n        raise ValueError("blocked")\n    return True'},
    {path:'pub.js',content:'eventBus.publish("orders.created", item);'},
    {path:'sub.js',content:'eventBus.on("orders.created", handler);'},
];
const integrated = await analyzeRepository({name:'v82-engine-regression'}, integrationFiles);
assert.match(integrated.engineVersion,/^8\.2\./);
assert(integrated.businessIntelligence.rules.length>=1);
assert.equal(integrated.evidenceAudit.summary.invalid,0);
assert.equal(integrated.graphQuality.summary.invalidLine,0);
assert(integrated.analysisModel.edges.some(e=>e.type==='http-request-candidate'));
assert(integrated.analysisModel.edges.some(e=>e.type==='delivers-to-candidate'));
assert(integrated.analysisModel.edges.some(e=>e.type==='governs-rule-candidate'));
console.log(JSON.stringify({ status:'passed', version:integrated.engineVersion, positiveRules:rules.rules.length,
    stateTransitions:rules.stateTransitions.length, validatedGraphEvidence:integrated.graphQuality.summary.evidenceValid,
    traceLinks:integrated.executionIntelligence.clientLinks.length, checkedEvidence:integrated.evidenceAudit.summary.checked,
    disclaimer:'Controlled hand-labeled smoke tests, not full-world semantic precision or recall.' },null,2));
