import assert from 'node:assert/strict';
import { analyzeHeuristicDataFlows, analyzeInterproceduralDataFlows } from '../dataFlow.js';
import { analyzeApiContracts,extractClientApiCalls } from '../api.js';
import { buildAnalysisCoverage } from '../analysisContracts.js';
const f=(path,content)=>({path,name:path.split('/').at(-1),content});
const flows=x=>analyzeHeuristicDataFlows([x]).flows;
const check=(name,test)=>{assert.ok(test,name);console.log('PASS',name)};
// A-G source-to-sink probes plus one negative probe. These fixtures are
// inferred from the agreed acceptance requirements, not user-provided snippets.
check('A multi-line SQL call',flows(f('a.js',`const input = req.query.id;
db.query(
   input
);`)).some(x=>x.sink.kind==='sql-query'));
check('B multi-line assignment',flows(f('b.js',`const input = (
 req.body.id
);
db.query(input);`)).some(x=>x.sink.kind==='sql-query'));
check('C object destructuring',flows(f('c.js',`const { id: userId } = req.params;
db.query(userId);`)).some(x=>x.sink.kind==='sql-query'));
check('D array destructuring',flows(f('d.js',`const [first, second] = req.body;
eval(second);`)).some(x=>x.sink.kind==='dynamic-evaluation'));
check('E Python f-string expression',flows(f('e.py',`data = request.get_json()
db.execute(f"SELECT {data['id']}")`)).some(x=>x.sink.kind==='sql-query'));
check('F Java annotated request param',flows(f('f.java',`public void run(@RequestParam String id) {
 db.execute(id);
}`)).some(x=>x.sink.kind==='sql-query'));
check('G FastAPI Query/Body',flows(f('g.py',`def handle(user: str = Query(...), data: str = Body(...)):
 db.execute(user)`)).some(x=>x.sink.kind==='sql-query'));
check('H unrelated source not tainting SQL',flows(f('h.js',`const input=req.params.id;
db.query('SELECT 1');`)).length===0);
const routes=[{path:'/auth/login',method:'POST'},{path:'/users/{id}',method:'GET'},{path:'/api/v1/operations',method:'GET'}];
const web=f('src/page.tsx', `fetch('/auth/login',{method:'POST'});
fetch('/users/123');
fetch('/dashboard');
fetch('/auth/missing',{method:'POST'});
<a href="/auth/login" />;
fetch('/auth/login',{method:dynamicMethod});`);
const linked=extractClientApiCalls([web],routes);
check('I backend-route evidence accepts non-prefixed auth path',linked.some(c=>c.path==='/auth/login'&&c.method==='POST'));
check('J dynamic route segment matches',linked.some(c=>c.path==='/users/123'));
check('K nav/missing/nonliteral method are rejected',linked.length===2);
const contract=analyzeApiContracts([web],routes);
check('L matched API contract',contract.matchedCalls===2&&contract.mismatchCount===0);
const wrongMethod=analyzeApiContracts([f('src/wrong.ts',`fetch('/auth/login',{method:'GET'});`)],routes);
check('M real HTTP method mismatch preserved',wrongMethod.mismatchCount===1);
const html=f('frontend/index.html','<html><body>markup only</body></html>');
const cov=buildAnalysisCoverage({files:[html],fileStatuses:[{path:html.path,language:'html',parserStrategy:'heuristic-regex',extraction:{status:'complete'},complexity:{status:'skipped',reason:'not applicable to this file'}}]});
check('N markup-only HTML complexity not counted as skipped',cov.parserCoverage.skippedCodeFiles===0);
const escaped=flows(f('fstring.py',`name = request.get_json()\ndb.query(f'hello {{literal}} {name}')`));
check('O f-string escaped braces do not hide real interpolation',escaped.length===1);
const nestedJS=flows(f('multiline.js',`function f(req, db) {\nconst {\n id,\n  extra: rename\n} = req.params;\ndb.query(\n rename\n);\n}`));
check('P multiline object destructuring with alias',nestedJS.length===1);
const noFlow=flows(f('fstring2.py',`ignored = f"request.args has been documented"\ndb.query('constant')`));
check('Q f-string ordinary text not treated as Python code',noFlow.length===0);
// Existing bounded interprocedural pass: multiline call arguments must reach
// the callee without changing the output schema or inference depth.
const inFiles=[f('src/in.js',`function entry(req) {\n const { id } = req.params;\n unsafe(\n   id\n );\n}`),f('src/out.js',`function unsafe(input) {\n db.query(\n input\n );\n}`)];
const inFns=[{name:'entry',file:'src/in.js',line:1,endLine:6},{name:'unsafe',file:'src/out.js',line:1,endLine:5}];
const inEdges=[{callerFunctionKey:'src/in.js|1|entry',calleeFunctionKey:'src/out.js|1|unsafe',callerFile:'src/in.js',calleeFile:'src/out.js',callName:'unsafe',calleeFunctionName:'unsafe',callSiteLine:3,resolution:'resolved'}];
const cross=analyzeInterproceduralDataFlows(inFiles,inFns,inEdges);
check('R interprocedural multiline call retains taint propagation',cross.flows.some(x=>x.source.path==='src/in.js'&&x.sink.path==='src/out.js'));
console.log('FREEZE PROBES: all passed');
