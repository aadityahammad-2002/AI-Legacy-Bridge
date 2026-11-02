/** Compare against actual v8.2 user self-analysis corpus: same source paths.
 * Source files must be supplied in HARDENING_CORPUS_PATH at evaluation time. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { analyzeRepository } from '../orchestrator.js';
const directory = process.env.HARDENING_CORPUS_PATH;
if (!directory) throw new Error('Set HARDENING_CORPUS_PATH to the extracted real repository sources.');
const paths = JSON.parse(await readFile(process.env.HARDENING_CORPUS_MANIFEST,'utf8'));
const files = await Promise.all(paths.map(async path=>({path,content:await readFile(join(directory,path),'utf8')})));
const result = await analyzeRepository({name:'AI-Legacy-Bridge-main'},files);
const endpoints = result.apiEndpoints.map(e=>({path:e.path,file:e.file,framework:e.framework}));
const output = {
  status:'passed', engineVersion:result.engineVersion, files:result.files.length, symbols:result.functions.length,
  endpointsCount:endpoints.length, endpoints, fixtureEndpoints:endpoints.filter(e=>/benchmarks|__tests__|\.test\./i.test(e.file)).length,
  graph:result.graphQuality.summary, graphEntities:result.analysisModel.summary.entityCount,
  graphEdges:result.analysisModel.summary.edgeCount,
  modelDiagnostics:result.analysisModel.diagnostics,
  findings:result.findings.length, uniqueFindingIds:new Set(result.findings.map(f=>f.id)).size,
  coverage:result.analysisCoverage.status, functionCalls:result.callGraph.diagnostics,
  contract:result.outputContractValidation,
  businessRules:result.businessIntelligence.summary,
  semantics:'Unlabelled first-party full-source regression; measures internal consistency, not external semantic precision.'
};
assert.equal(output.fixtureEndpoints,0);
assert.equal(output.findings,output.uniqueFindingIds);
assert.equal(result.outputContractValidation.status,'valid');
assert.equal(result.graphQuality.summary.invalidLine,0);
assert.equal(result.graphQuality.summary.danglingEdges,0);
console.log(JSON.stringify(output,null,2));
