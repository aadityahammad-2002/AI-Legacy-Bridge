import assert from 'node:assert/strict';
import { traceEngineeringFlows, computeEngineeringImpact, buildEngineeringQuestionContext, locateIntelligenceEntities } from '../engineeringIntelligence.js';
const entities = [
{id:'ui',kind:'file',name:'checkout.js',path:'ui/checkout.js'},
{id:'api',kind:'endpoint',name:'/orders',path:'backend/orders.py'},
{id:'handler',kind:'file',name:'orders.py',path:'backend/orders.py'},
{id:'service',kind:'function',name:'placeOrder',path:'backend/service.py'},
{id:'rule',kind:'business-rule-candidate',name:'if order.cancelled',path:'backend/service.py'}];
const edges=[
{id:'a',source:'ui',target:'api',type:'calls',line:5,resolution:'resolved',confidence:'high'},
{id:'b',source:'api',target:'handler',type:'handler-file-candidate',line:8,resolution:'inferred',confidence:'low'},
{id:'c',source:'handler',target:'service',type:'calls',line:10,resolution:'resolved'},
{id:'d',source:'service',target:'rule',type:'contains-rule-candidate',line:19,resolution:'inferred'},
{id:'e',source:'service',target:'handler',type:'calls',line:3,resolution:'inferred'}];
const model={entities,edges};
const flow=traceEngineeringFlows(model,'ui');
assert.equal(flow.paths.length,1);assert.equal(flow.paths[0].entities.at(-1).id,'service');assert.equal(flow.paths[0].runtimeVerified,false);assert.equal(flow.paths[0].confidence,'candidate');
const impact=computeEngineeringImpact(model,['service']);
assert(impact.affectedEntities.some(e=>e.id==='ui'));assert(impact.relatedRules.some(r=>r.rule.id==='rule'));
assert.equal(locateIntelligenceEntities(model,'placeOrder')[0].id,'service');
const context=buildEngineeringQuestionContext(model,'What does placeOrder change?');
assert(context.matchedEntities.some(e=>e.id==='service'));assert(context.relationships.some(x=>x.evidence.line===19));
assert.equal(traceEngineeringFlows(model,'absent').status,'not-found');
const long={entities:Array.from({length:2000},(_,i)=>({id:`n${i}`,name:`function${i}`,kind:'function'})),edges:Array.from({length:1999},(_,i)=>({id:`e${i}`,source:`n${i}`,target:`n${i+1}`,type:'calls',resolution:'resolved',line:i+1}))};
assert.equal(traceEngineeringFlows(long,'n0',{maxDepth:2}).truncated,true);
assert.equal(computeEngineeringImpact(long,['n1999'],{maxNodes:40,maxDepth:200}).affectedEntities.length,12);
console.log('v8.1 engineering intelligence regression passed');
