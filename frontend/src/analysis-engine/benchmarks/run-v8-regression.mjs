import assert from 'node:assert/strict';
import { analyzeRepository, queryAnalysisModel } from '../orchestrator.js';
const files = [
 {path:'backend/producer.js',content:'function send(order) {\n if (order.status === "CLOSED") {\n throw new Error("blocked");\n }\n producer.send("orders.created", order);\n }'},
 {path:'backend/consumer.js',content:'consumer.subscribe("orders.created");'},
 {path:'db/schema.sql',content:'CREATE TABLE orders (id INT);'},
 {path:'backend/query.py',content:'def load():\n    return db.query("SELECT * FROM orders")\n'},
 {path:'frontend/a.js', content:'// if (fake == true) { throw Error() }\nconst fake = "if (x == 2) throw err";'}
];
const output = await analyzeRepository({name:'v8-fixture'},files);
assert.match(output.engineVersion,/^8\./);
assert.ok(output.businessIntelligence.rules.some(r=>r.file==='backend/producer.js'));
assert.ok(!output.businessIntelligence.rules.some(r=>r.file==='frontend/a.js'));
const g=output.analysisModel;
assert.ok(queryAnalysisModel(g,{entityKind:'message-channel'}).some(e=>e.name==='orders.created'));
assert.ok(queryAnalysisModel(g,{entityKind:'business-rule-candidate'}).length > 0);
assert.ok(g.edges.some(e=>e.type==='publishes-candidate'));
assert.ok(g.edges.some(e=>e.type==='subscribes-candidate'));
assert.equal(g.diagnostics.danglingEdgeCount,0);
assert.ok(output.dependencies && output.executionIntelligence && output.semanticIntelligence);
console.log('v8 graph/rule integration regression passed', {rules:output.businessIntelligence.rules.length, graphEdges:g.edges.length});
