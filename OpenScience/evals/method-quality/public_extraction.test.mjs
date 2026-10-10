import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groundPublicExtraction,publicExtractionPrompt} from './public_extraction.mjs';
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
