import assert from 'node:assert/strict';
import { computeChangeImpact, computeFunctionImpact } from '../changeImpact.js';
import { analyzeTestLinkage } from '../testLinkage.js';
import { SUPPORTED_CODE_LANGUAGES, identifyCodeLanguage, maskLanguageNonCode } from '../languageIntelligence.js';
let count=0;
function check(name,fn){fn();console.log(`PASS ${++count}: ${name}`)}
check('30 unique language profiles',()=>assert.equal(new Set(SUPPORTED_CODE_LANGUAGES).size,30));
const cases = [
['js','JavaScript'],['jsx','JavaScript'],['ts','TypeScript'],['tsx','TypeScript'],['py','Python'],['java','Java'],['go','Go'],['rs','Rust'],['rb','Ruby'],['php','PHP'],['c','C'],['cpp','C++'],['cs','C#'],['swift','Swift'],['kt','Kotlin'],['scala','Scala'],['clj','Clojure'],['ex','Elixir'],['erl','Erlang'],['hs','Haskell'],['lua','Lua'],['r','R'],['jl','Julia'],['dart','Dart'],['elm','Elm'],['fs','F#'],['ml','OCaml'],['pl','Perl'],['sh','Shell'],['ps1','PowerShell'],['groovy','Groovy'],['vba','VBA']];
for(const [ext, expected] of cases) check(`detect .${ext}`,()=>assert.equal(identifyCodeLanguage(`src/sample.${ext}`),expected));
check('Windows path and uppercase extension',()=>assert.equal(identifyCodeLanguage('src\\FOO.PY'),'Python'));
check('Dockerfile/Makefile casing',()=>{assert.equal(identifyCodeLanguage('src/dockerfile'),'Shell');assert.equal(identifyCodeLanguage('MAKEFILE'),'Shell')});
check('unknown extensions do not pretend to be code',()=>assert.equal(identifyCodeLanguage('README.unknown'),null));
check('comment masking preserves offsets/newlines',()=>{for (const [ext,lang] of cases){const s='alpha\n beta\n';const m=maskLanguageNonCode(s,lang);assert.equal(m.length,s.length);assert.equal(m.split('\n').length,s.split('\n').length)}});
check('change impact direct/transitive, no changed node in cycle',()=>{const x=computeChangeImpact('a.ts',[{source:'b.ts',target:'a.ts',resolution:'resolved'},{source:'c.ts',target:'b.ts',resolution:'resolved'},{source:'a.ts',target:'c.ts',resolution:'resolved'}]);assert.deepEqual(x.affectedFiles.map(v=>v.path),['b.ts','c.ts'])});
check('ambiguous edges do not become confirmed dependents',()=>{const x=computeChangeImpact('a.ts',[{source:'b.ts',target:'a.ts',resolution:'ambiguous'}]);assert.equal(x.affectedFiles.length,0);assert.equal(x.possibleDirectDependents.length,1)});
check('unresolved edges do not assert impact',()=>assert.equal(computeChangeImpact('a.ts',[{source:'b.ts',target:'a.ts',resolution:'unresolved'}]).affectedFiles.length,0));
check('bounded impact is flagged when truncated',()=>{const x=computeChangeImpact('a.ts',[{source:'b.ts',target:'a.ts',resolution:'resolved'},{source:'c.ts',target:'a.ts',resolution:'resolved'}],{}, {maxNodes:1});assert.equal(x.affectedFiles.length,1);assert.equal(x.completeness,'partial')});
check('reject traversal in changed paths',()=>assert.throws(()=>computeChangeImpact('../secret',[]),TypeError));
check('function impact cannot count changed function through cycle',()=>{const x=computeFunctionImpact('a|1|f',[{callerFunctionKey:'b|2|g',calleeFunctionKey:'a|1|f',resolution:'resolved'},{callerFunctionKey:'a|1|f',calleeFunctionKey:'b|2|g',resolution:'resolved'}]);assert.deepEqual(x.affectedFunctions.map(f=>f.functionKey),['b|2|g'])});
check('test filename fallback stays within language family',()=>{const x=analyzeTestLinkage([{path:'src/order.py'},{path:'src/order.test.ts'}],[]);assert.equal(x.links.length,0)});
check('JS test filename links JS source',()=>{const x=analyzeTestLinkage([{path:'src/order.js'},{path:'src/order.test.js'}],[]);assert.equal(x.links.length,1)});
check('TSX convention links same-family TS source',()=>{const x=analyzeTestLinkage([{path:'src/order.tsx'},{path:'src/order.test.ts'}],[]);assert.equal(x.links.length,1)});
check('explicit cross-language link remains possible through resolved evidence',()=>{const x=analyzeTestLinkage([{path:'src/order.py'},{path:'src/order.test.ts'}],[{source:'src/order.test.ts',target:'src/order.py',resolution:'resolved'}]);assert.equal(x.links.length,1);assert.equal(x.links[0].confidence,'high')});
console.log(`STEP 7–10 targeted checks: ${count} PASS`);
