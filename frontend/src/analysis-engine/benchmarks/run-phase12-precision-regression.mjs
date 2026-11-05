/** Phase 1/2 existing-feature correctness regression. No new analysis sections. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Parser } from '../parser.js';
import { buildCallGraph } from '../callGraph.js';
import { discoverEndpoints, extractClientApiCalls, analyzeApiContracts } from '../api.js';
const require = createRequire(import.meta.url);
const acornPath = process.env.PHASE12_ACORN_PATH;
if (acornPath) globalThis.acorn = require(acornPath);
else { try { const mod = await import('acorn'); globalThis.acorn = mod.default || mod; } catch { /* optional runtime not installed yet */ } }
const f=(path,content)=>({path,name:path.split('/').at(-1),content,isCode:true});
let pass=0;
const check=(value,label)=>{assert.ok(value,label);pass++;};
const eq=(left,right,label)=>{assert.deepEqual(left,right,label);pass++;};

const js='export function rerun(){rerun();}\nclass Store { save = async (x) => x; method(x){return this.save(x);} count = 4; }';
const jsDefs=Parser.extract(js,'src/store.js',{});
if (globalThis.acorn){
 check(jsDefs.some(x=>x.name==='save'&&x.className==='Store'&&x.isClassMethod),'AST recognizes callable class field');
 check(!jsDefs.some(x=>x.name==='count'),'AST ignores non-callable class fields');
 eq(Parser.findCalls(js,['rerun'],'src/store.js',Parser.buildFunctionDefLineIndex(jsDefs)).rerun,1,'AST counts recursive call on declaration line');
}
if (globalThis.acorn) check(jsDefs.some(x=>x.name==='method'&&x.className==='Store'),'existing AST class method preserved');
const py='class Outer:\n    class Inner:\n        def go(self):\n            return 1\n    def top(self):\n        def nested():\n            return 2\n        return nested()\n';
const pyDefs=Parser.extract(py,'src/app.py',{});
check(pyDefs.some(x=>x.name==='Outer.Inner.go'&&x.className==='Outer.Inner'),'nested class method retains fully qualified ownership');
check(pyDefs.some(x=>x.name==='Outer.top'&&x.className==='Outer'),'outer method after nested class retains owner');
check(pyDefs.some(x=>x.name==='nested'&&!x.isClassMethod),'function inside method not incorrectly class method');
const localClass = Parser.extract('class Outer:\n    def make(self):\n        class Local:\n            def go(self):\n                return 1\n        return Local()\n    def after(self):\n        return 2\n', 'src/local.py', {});
check(localClass.some(x=>x.name==='Local.go'&&x.className==='Local'&&x.isClassMethod),'class nested in function still owns local method');
check(localClass.some(x=>x.name==='Outer.after'&&x.isClassMethod),'class method after local class preserved');
// Simulated tree-sitter node layout exercises the loaded parser path without
// changing the runtime grammar loading policy.
const child=(type,text,kids=[],callee=null)=>({type,text,childCount:kids.length,child(i){return kids[i]},childForFieldName(name){return name==='function'?callee:null}});
const name=()=>child('identifier','run');
const direct=child('call','run()',[],name());
const receiver=child('attribute','obj.run');
const member=child('call','obj.run()',[],receiver);
const root=child('module','',[
 child('function_definition','def run(): pass',[name()]),
 child('assignment','other = run',[name()]),
 direct,
 member,
 child('return_statement','return run',[name()]),
]);
const previous=Parser._tsParsers.python;
try {
 Parser._tsParsers.python={parse(){return {rootNode:root,delete(){}}}};
 eq(Parser.findCalls('def run():pass\nother=run\nrun()\nobj.run()\nreturn run',['run'],'src/app.py',{}).run,1,'Python syntax tree only counts direct calls');
} finally { if(previous) Parser._tsParsers.python=previous; else delete Parser._tsParsers.python; }

const apiSource=`from fastapi import APIRouter, FastAPI
app = FastAPI()
users_router = APIRouter(prefix='/api/users')
admin_router = APIRouter(prefix='/api/admin')
@users_router.get('/list')
def list_users(): pass
@admin_router.post('/list')
def list_admin(): pass
@app.get('/health')
def health(): pass`;
const routes=discoverEndpoints([f('backend/api.py',apiSource)]);
check(routes.some(r=>r.path==='/api/users/list'&&r.method==='GET'),'scoped FastAPI user router prefix');
check(routes.some(r=>r.path==='/api/admin/list'&&r.method==='POST'),'scoped FastAPI admin router prefix');
check(routes.some(r=>r.path==='/health'&&r.method==='GET'),'FastAPI app route not polluted by router prefix');
const flaskSource=`from flask import Blueprint, Flask
users = Blueprint('users', __name__, url_prefix='/api/users')
admin = Blueprint('admin', __name__, url_prefix='/api/admin')
@users.route('/list')
def get_list(): pass
@admin.route('/list', methods=['POST'])
def post_list(): pass`;
const flasks=discoverEndpoints([f('backend/routes.py',flaskSource)]);
check(flasks.some(r=>r.path==='/api/users/list'&&r.method==='GET'),'scoped Flask blueprint users');
check(flasks.some(r=>r.path==='/api/admin/list'&&r.method==='POST'),'scoped Flask blueprint admin');
const unprefixed = discoverEndpoints([f('backend/plain.py', "plain = APIRouter()\nother = APIRouter(prefix='/api/other')\n@plain.get('/health')\ndef health(): pass")]);
check(unprefixed.some(r=>r.path==='/health'),'unprefixed router does not borrow another router prefix');
const clients=[f('frontend/src/api.js', `fetch(API_BASE + '/api/users/list');
await axios.post(SERVICE_URL + '/api/admin/list');
fetch('/api/users/list',{method: dynamicMethod});
fetch('/api/users/list',{method:'GET'});
// fetch(API_BASE + '/api/commented');
fetch(otherValue + '/api/not-confirmed');
fetch('/profile');`)];
const clientCalls=extractClientApiCalls(clients);
check(clientCalls.some(x=>x.kind==='fetch-concat'&&x.path==='/api/users/list'),'static fetch concatenation');
check(clientCalls.some(x=>x.kind==='http-client-concat'&&x.path==='/api/admin/list'&&x.method==='POST'),'static axios concatenation');
check(!clientCalls.some(x=>x.path==='/api/commented'||x.path==='/api/not-confirmed'),'no comment/unknown base guesses');
check(!clientCalls.some(x=>x.method==='GET'&&x.line===3),'dynamic method not incorrectly GET');
check(analyzeApiContracts(clients,routes).matchedCalls===3,'existing API contract matching accepts new statics');

const sec=(files)=>Parser.detectSecurity(files);
const safeRenderer=String.raw`import { highlightSyntax } from './highlightSyntax.js';
function SourceViewModal({file,path}) {
 const lines = file ? highlightSyntax(file.content, path) : [];
 return <pre>{lines.map((html, i) => <span key={i} dangerouslySetInnerHTML={{ __html: html }} />)}</pre>;
}`;
const safeProducer=String.raw`export function highlightSyntax(code){
 function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
 return code.split('\n').map((line) => { let escaped = esc(line); return escaped; });
}`;
const secFiles=[f('frontend/src/highlightSyntax.js',safeProducer),f('frontend/src/Renderer.jsx',safeRenderer)];
check(!sec(secFiles).some(x=>x.title==='Potential XSS Sink'),'verified escaped renderer suppresses false warning');
check(sec([f('frontend/src/Renderer.jsx',safeRenderer)]).some(x=>x.title==='Potential XSS Sink'),'no sanitizer source means sink stays reported');
const extraUnsafeSink = safeRenderer + '\nconst unsafe = <div dangerouslySetInnerHTML={{__html: userHtml}} />;';
check(sec([f('frontend/src/highlightSyntax.js',safeProducer),f('frontend/src/Renderer.jsx',extraUnsafeSink)]).some(x=>x.title==='Potential XSS Sink'),'extra unsafe HTML sink in verified component still reported');
check(sec([f('frontend/src/highlightSyntax.js',safeProducer.replace(".replace(/</g, '&lt;')",'')),f('frontend/src/Renderer.jsx',safeRenderer)]).some(x=>x.title==='Potential XSS Sink'),'missing HTML escaping keeps sink reported');
check(sec([f('frontend/src/unsafe.jsx',`const unsafe = external; return <div dangerouslySetInnerHTML={{__html: unsafe}} />;`)]).some(x=>x.title==='Potential XSS Sink'),'unescaped source remains reported');
check(sec([f('src/password.js',`const password = 'realSecretValue_1234';`)]).some(x=>x.title==='Hardcoded Secret'),'hardcoded credential still detected');
check(sec([f('src/eval.js',`eval(userInput);`)]).some(x=>x.title==='Dynamic Code Execution'),'true eval still detected');

// Optional same-source test on the actual snapshot; absent in consumer repo.
const sourcePath=process.env.PHASE12_SOURCE_DIR;
if (sourcePath){
 const rp=f('frontend/src/components/RepositoryPanel.jsx',readFileSync(sourcePath+'/RepositoryPanel.jsx','utf8'));
 const hl=f('frontend/src/components/highlightSyntax.js',readFileSync(sourcePath+'/highlightSyntax.js','utf8'));
 check(!sec([rp,hl]).some(x=>x.title==='Potential XSS Sink'),'actual repository highlighter flow safely escaped');
}
console.log(JSON.stringify({status:'passed',checks:pass,acorn:!!globalThis.acorn,realSource:!!sourcePath}));
