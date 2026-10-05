import test from 'node:test';
import assert from 'node:assert/strict';
import { routeExplicitEvolutionTool, trustedEvolutionNativeName } from '../src/evolutionToolRouting.mjs';
test('exact installed execution identity routes to its sole public capability without overriding explicit or bound scope',()=>{
  const tools=[{id:'tool-cohort',payload:{status:'active',validationLevel:'V2',nativeName:'cohort_model',capabilityIds:['statistical-analysis']}}];
  const agents=[{id:'statistical-analysis',version:'1',runtimeAgent:'statistics'},{id:'other',version:'1',runtimeAgent:'other'}];
  const route=(text,session={mode:'open-domain'},chosen=null)=>routeExplicitEvolutionTool(text,tools,agents,session,chosen);
  assert.equal(route('使用已安装工具 tool-cohort 实际计算').agentId,'statistical-analysis');
  assert.equal(route('Please run cohort_model').agentId,'statistical-analysis');
  assert.equal(route('解释 tool-cohort 的用途'),null);assert.equal(route('Use tool-cohort-v2'),null);
  assert.equal(route('Use tool-cohort',{mode:'specialist',agentId:'other'}),null);
  assert.equal(route('Use tool-cohort',{mode:'open-domain'},{agent:null}),null);
  tools[0].payload.status='staged';assert.equal(route('Use tool-cohort'),null);tools[0].payload.status='active';
  tools[0].payload.capabilityIds=['statistical-analysis','other'];assert.equal(route('Use tool-cohort'),null);
  tools[0].payload.capabilityIds=['internal'];agents.push({id:'internal',version:'1',runtimeAgent:'internal',visibility:'internal'});assert.equal(route('Use tool-cohort'),null);
});

test('public native identity is the bounded publisher receipt, never a candidate alias or fabricated legacy name',()=>{
  const trusted={nativeName:`platform-${'a'.repeat(24)}`};
  assert.equal(trustedEvolutionNativeName(trusted),trusted.nativeName);
  assert.equal(trustedEvolutionNativeName({}),undefined);
  assert.equal(trustedEvolutionNativeName({nativeName:'candidate_alias'}),undefined);
  assert.equal(trustedEvolutionNativeName({nativeName:`platform-${'a'.repeat(1000)}`}),undefined);
});

test('explicit numeric tool calls use the shared statistical capability while other ambiguity remains unresolved',()=>{
  const agents=['statistical-analysis','drug-selection','comprehensive-drug-evaluation'].map(id=>({id,version:'1',runtimeAgent:id}));
  const tool={id:'published',payload:{status:'active',validationLevel:'V2',toolKind:'calculation',capabilityIds:agents.map(agent=>agent.id)}};
  const route=(tools=[tool],session={mode:'open-domain'},choice=null)=>routeExplicitEvolutionTool('Use published',tools,agents,session,choice);
  assert.equal(route().agentId,'statistical-analysis');
  assert.equal(route([tool],{mode:'specialist',agentId:'drug-selection'}),null);
  assert.equal(route([tool],{mode:'open-domain'},{agent:agents[1]}),null);
  tool.payload.toolKind='workflow';assert.equal(route(),null);
  tool.payload.toolKind='calculation';tool.payload.capabilityIds=['drug-selection','comprehensive-drug-evaluation'];assert.equal(route(),null);
});
