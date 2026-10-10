import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groundPublicExtraction,publicExtractionPrompt,freezePublicEntities,publicEntityPrompt,publicRelationPrompt,groundPublicRelations,extractPublicTwoPass} from './public_extraction.mjs';
const example={documentId:'public-1',text:'😀 aspirin inhibits COX. aspirin.'};
test('source grounding computes UTF-16 offsets and keeps repeated mentions distinct',()=>{
  const result=groundPublicExtraction(example,JSON.stringify({entities:[['a','CHEMICAL','aspirin',1],['b','GENE','COX',1],['c','CHEMICAL','aspirin',2]],relations:[['INHIBITOR','a','b']]}));
  assert.deepEqual(result.entities.map(row=>[row.start,row.end]),[[3,10],[20,23],[25,32]]);
  assert.equal(result.relations.length,1);assert.deepEqual(result.groundingIssues,[]);
});
test('unsupported surfaces and duplicate spans cannot fabricate evidence or relation endpoints',()=>{
  const result=groundPublicExtraction(example,JSON.stringify({entities:[['a','CHEMICAL','aspirin',1],['b','GENE','invented',1],['c','CHEMICAL','aspirin',1],['d','GENE','COX',999999999]],relations:[['INHIBITOR','a','b']]}));
  assert.equal(result.entities.length,1);assert.equal(result.relations.length,0);assert.equal(result.groundingIssues.length,4);
});
test('malformed or truncated output stays a failure, and prompts contain no gold or offset instructions',()=>{
  assert.throws(()=>groundPublicExtraction(example,'{"entities":['));
  assert.throws(()=>groundPublicExtraction(example,'{}'),/extraction_arrays_missing/);
  assert.ok(publicExtractionPrompt(example).includes('exact source surface'));
});
test('new relation evidence must be verbatim and duplicate relations stay visible as issues',()=>{
  const result=groundPublicExtraction(example,JSON.stringify({entities:[['a','CHEMICAL','aspirin',1],['b','GENE','COX',1]],relations:[['INHIBITOR','a','b','aspirin inhibits COX'],['INHIBITOR','a','b','aspirin inhibits COX'],['ACTIVATOR','a','b','invented evidence']]}));
  assert.equal(result.relations.length,1);
  assert.deepEqual(result.groundingIssues.map(row=>row.kind),['duplicate_relation','relation_quote_unresolved']);
});
test('prediction projection never includes accidentally supplied reference labels',()=>{
  const prompt=publicExtractionPrompt({...example,reference:{secret:'gold-label-canary'},split:'holdout'});
  assert.ok(!prompt.includes('gold-label-canary'));
  assert.ok(!prompt.includes('holdout'));
});

test('two passes freeze source-sorted IDs and reject attempted entity redefinition',()=>{
  const frozen=freezePublicEntities(example,JSON.stringify({entities:[['wrong-b','GENE','COX',1],['wrong-a','CHEMICAL','aspirin',1]],relations:[]}));
  assert.deepEqual(frozen.entities.map(e=>[e.id,e.type]),[['e1','CHEMICAL'],['e2','GENE']]);
  assert.ok(Object.isFrozen(frozen.entities));assert.ok(Object.isFrozen(frozen.entities[0]));
  assert.throws(()=>groundPublicRelations(example,frozen,'{"entities":[],"relations":[]}'),/frozen_entities_redefinition/);
  const result=groundPublicRelations(example,frozen,JSON.stringify({relations:[['INHIBITOR','e1','e2','aspirin inhibits COX',1]]}));
  assert.equal(result.relations.length,1);assert.deepEqual(result.relations[0].quoteLocator,{start:3,end:23,offsetUnit:'utf16'});
});
test('quotation bytes alone cannot bind another mention or a fabricated quotation instance',()=>{
  const e={documentId:'x',text:'aspirin. aspirin inhibits COX. aspirin inhibits COX.'};
  const f=freezePublicEntities(e,JSON.stringify({entities:[['a','CHEMICAL','aspirin',1],['b','CHEMICAL','aspirin',2],['c','GENE','COX',1],['d','CHEMICAL','aspirin',3],['e','GENE','COX',2]],relations:[]}));
  const r=groundPublicRelations(e,f,JSON.stringify({relations:[['INHIBITOR','e1','e3','aspirin inhibits COX',1],['INHIBITOR','e2','e3','aspirin inhibits COX',2],['INHIBITOR','e2','e3','aspirin inhibits COX',1],['INHIBITOR','e4','e5','aspirin inhibits COX',999],['INHIBITOR','e2','e3','aspirin inhibits COX']]}));
  assert.equal(r.relations.length,1);assert.equal(r.groundingIssues.length,4);
});
test('fixed endpoint type prevents chemical-to-chemical relations and no pass includes gold',()=>{
  const e={...example,reference:{secret:'gold-canary'},split:'holdout'};
  const f=freezePublicEntities(e,JSON.stringify({entities:[['a','CHEMICAL','aspirin',1],['b','GENE','COX',1]],relations:[]}));
  const r=groundPublicRelations(e,f,JSON.stringify({relations:[['INHIBITOR','e1','e1','aspirin inhibits COX',1]]}));
  assert.equal(r.relations.length,0);assert.equal(r.groundingIssues[0].kind,'relation_unresolved');
  for(const prompt of [publicEntityPrompt(e),publicRelationPrompt(e,f.entities)]){assert.ok(!prompt.includes('gold-canary'));assert.ok(!prompt.includes('holdout'));}
});

test('cross-sentence endpoints require explicit coreference evidence and remain unresolved here',()=>{
  const e={documentId:'x',text:'aspirin was administered. COX activity fell.'};
  const f=freezePublicEntities(e,JSON.stringify({entities:[['a','CHEMICAL','aspirin',1],['b','GENE','COX',1]],relations:[]}));
  const r=groundPublicRelations(e,f,JSON.stringify({relations:[['INHIBITOR','e1','e2',e.text,1]]}));
  assert.equal(r.relations.length,0);assert.equal(r.groundingIssues[0].kind,'relation_quote_endpoint_mismatch');
});

test('sentence separators reject lowercase, non-Latin and ambiguous abbreviation endpoint links',()=>{
  for (const middle of [' was administered. ', ' was administered! ', ' was administered? ', ' was administered.” ', '已用药。', '已用药！', '已用药？', ' administered\n', ' (e.g. ', ' administered…']) {
    const e={documentId:'boundary',text:`aspirin${middle}cox activity fell.`};
    const f=freezePublicEntities(e,JSON.stringify({entities:[['a','CHEMICAL','aspirin',1],['g','GENE','cox',1]],relations:[]}));
    const r=groundPublicRelations(e,f,JSON.stringify({relations:[['INHIBITOR','e1','e2',e.text,1]]}));
    assert.equal(r.relations.length,0,middle);
    assert.equal(r.groundingIssues[0].kind,'relation_quote_endpoint_mismatch',middle);
  }
});

test('decimal measurements within a sentence preserve exact endpoint support',()=>{
  const e={documentId:'decimal',text:'aspirin at 0.5 mg inhibits cox.'};
  const f=freezePublicEntities(e,JSON.stringify({entities:[['a','CHEMICAL','aspirin',1],['g','GENE','cox',1]],relations:[]}));
  const r=groundPublicRelations(e,f,JSON.stringify({relations:[['INHIBITOR','e1','e2',e.text,1]]}));
  assert.equal(r.relations.length,1);
  assert.deepEqual(r.relations[0].quoteLocator,{start:0,end:e.text.length,offsetUnit:'utf16'});
});

test('formal evaluation workflow freezes IDs before the relation turn and archives both turn identities',async()=>{
  const calls=[];let recorded=false;
  const native=async request=>{
    calls.push(request);
    if(calls.length===1)return {code:0,latencyMs:1,text:JSON.stringify({entities:[['random-g','GENE','COX',1],['random-c','CHEMICAL','aspirin',1]],relations:[]})};
    assert.equal(recorded,true);assert.ok(request.prompt.includes('"id":"e1"'));assert.ok(!request.prompt.includes('random-c'));
    return {code:0,latencyMs:2,text:JSON.stringify({relations:[['INHIBITOR','e1','e2','aspirin inhibits COX',1]]})};
  };
  const result=await extractPublicTwoPass({...example,id:'workflow'},native,async frozen=>{assert.equal(frozen.entities[0].id,'e1');recorded=true;});
  assert.deepEqual(calls.map(c=>c.filename),['workflow-entities','workflow-relations']);assert.equal(result.prediction.relations.length,1);
  assert.equal(result.entityResult.latencyMs+result.relationResult.latencyMs,3);
});
test('a malformed entity pass never sends an unfrozen relation prompt',async()=>{
  let calls=0;
  await assert.rejects(extractPublicTwoPass(example,async()=>{calls++;return {code:0,text:'{"entities":[...]}'};}));
  assert.equal(calls,1);
});
