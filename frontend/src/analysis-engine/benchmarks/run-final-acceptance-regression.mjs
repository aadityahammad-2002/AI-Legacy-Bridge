import assert from 'node:assert/strict';
import { extractClientApiCalls, analyzeApiContracts } from '../api.js';
import { buildAnalysisCoverage } from '../analysisContracts.js';
import { ENGINE_VERSION } from '../engineVersion.js';

const file = (path, content) => ({path, name:path.split('/').at(-1), content});
let checks = 0;
function verify(result, message) {assert.ok(result, message); checks++;}
const wrapper = file('apps/web/src/lib/api.ts', `export const BASE=process.env.PUBLIC_API_URL||'http://localhost:8000/api/v1';
export async function api<T=any>(path:string,method='GET',body?:unknown){return fetch(BASE+path,{method,body})}`);
const client = file('apps/web/src/app/page.tsx', `import {api as httpApi} from '@/lib/api';
httpApi('/auth/me'); httpApi<{ok:boolean}>('/users','POST',{id:1}); httpApi('/items', dynamicMethod);
const local = 'api(\"/fake\")'; // httpApi('/comment')
`);
const direct = file('apps/web/src/components/main.tsx', `import {api} from '../lib/api'; api('/operations');`);
const notHttp = file('apps/web/src/lib/math.ts', `export function api(path){return 2+path.length;}`);
const notHttpClient = file('apps/web/src/components/math.tsx', `import {api} from '../lib/math'; api('/not-http');`);
const calls = extractClientApiCalls([wrapper,client,direct,notHttp,notHttpClient]);
verify(calls.some(c=>c.path==='/api/v1/auth/me'&&c.method==='GET'), 'imported GET wrapper');
verify(calls.some(c=>c.path==='/api/v1/users'&&c.method==='POST'), 'typed generic POST wrapper');
verify(calls.some(c=>c.path==='/api/v1/operations'&&c.method==='GET'), 'relative import wrapper');
verify(calls.length===3, 'dynamic methods, strings, comments, and non-http api are ignored');
const unrelated = file('apps/web/src/lib/fake.ts', `export const BASE='/api/v1';
export function api(path){return path;}
export function request(path){return fetch(BASE+path);}`);
const unrelatedClient = file('apps/web/src/components/fake.tsx', `import {api} from '../lib/fake'; api('/not-network');`);
verify(extractClientApiCalls([unrelated,unrelatedClient]).length===0, 'wrapper never borrows fetch from another function');
const envOnly = file('apps/web/src/lib/env-api.ts', `export const BASE=process.env.NEXT_PUBLIC_API_URL;
export function api(path,method='GET'){return fetch(BASE+path,{method});}`);
const envClient = file('apps/web/src/components/env.tsx', `import {api} from '../lib/env-api'; api('/secret');`);
verify(extractClientApiCalls([envOnly,envClient]).length===0,'no guessed prefix for runtime-only bases');
const shadow = file('apps/web/src/components/shadow.tsx', `import {api} from '../lib/api';
const api=(value)=>value;api('/not-http');`);
verify(extractClientApiCalls([wrapper,shadow]).length===0,'shadowed imported function never blindly assigned to HTTP');
const plainJs = file('client/src/lib/api.js',`export const API_BASE='/api';
export function makeRequest(path,method='GET'){return fetch(API_BASE+path,{method});}`);
const plainClient = file('client/src/page.js',`import {makeRequest} from './lib/api';makeRequest('/v1/users');`);
verify(extractClientApiCalls([plainJs,plainClient]).some(c=>c.path==='/api/v1/users'&&c.method==='GET'), 'general exported wrapper names work, not just api');

const contract=analyzeApiContracts([wrapper,client,direct,notHttp,notHttpClient],[
 {method:'GET',path:'/api/v1/auth/me',file:'routes.py',line:1},
 {method:'POST',path:'/api/v1/users',file:'routes.py',line:2},
 {method:'GET',path:'/api/v1/operations',file:'routes.py',line:3},
]);
verify(contract.matchedCalls===3&&contract.mismatchCount===0, 'wrapper contracts match');
const html=file('frontend/index.html','<html><body><h1>Hello</h1></body></html>');
const scripts=file('frontend/app.js','const x=1;');
const baseStates=[{path:html.path,language:'html',parserStrategy:'heuristic-regex',extraction:{status:'complete'},complexity:{status:'skipped',reason:'not applicable to this file'}},{path:scripts.path,language:'javascript',parserStrategy:'ast',extraction:{status:'complete'},complexity:{status:'complete'}}];
const cov=buildAnalysisCoverage({files:[html,scripts],fileStatuses:baseStates,stageStatuses:{extraction:'complete'}});
verify(cov.parserCoverage.skippedCodeFiles===0, 'markup-only HTML not classified as skipped executable code');
verify(!cov.statusReasons.some(s=>s.includes('skipped')), 'no false markup skipped reason');
const failed=buildAnalysisCoverage({files:[html,scripts],fileStatuses:baseStates.map((s,i)=>i===1?{...s,complexity:{status:'skipped',reason:'actual code skipped'}}:s),stageStatuses:{extraction:'complete'}});
verify(failed.parserCoverage.skippedCodeFiles===1&&failed.status==='partial', 'real source skip stays partial');
verify(ENGINE_VERSION!=='8.2.9', 'updated version prevents stale cached extraction');
console.log(JSON.stringify({status:'passed',checks,clientCalls:calls.length,contractMatches:contract.matchedCalls}));
