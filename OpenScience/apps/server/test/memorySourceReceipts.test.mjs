import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceReceiptState } from '../src/memorySourceReceipts.mjs';
const ref=(id,classification='ordinary')=>({id,contentDigest:'a'.repeat(64),sourcePrivacy:{schemaVersion:1,classification,reasons:[]},attribution:{schemaVersion:1,origins:['engine'],confirmed:false}});
test('only a trusted source resolver can retain an ordinary classification in a run receipt',()=>{
  assert.equal(sourceReceiptState([ref('a')]).sourcePrivacy.classification,'unclassified');
  assert.equal(sourceReceiptState([ref('a')],{trusted:true}).sourcePrivacy.classification,'ordinary');
  assert.equal(sourceReceiptState([ref('a','private'),ref('b')],{trusted:true}).sourcePrivacy.classification,'private');
});
test('bounded source references never silently drop privacy on overflow',()=>{
  const state=sourceReceiptState(Array.from({length:41},(_,i)=>ref(String(i))),{trusted:true});
  assert.equal(state.originalSources.length,40);assert.equal(state.sourcePrivacy.classification,'unclassified');
  assert.equal(sourceReceiptState(state.originalSources,{trusted:true,inheritedPrivacy:state.sourcePrivacy}).sourcePrivacy.classification,'unclassified');
});
