import test from 'node:test';
import assert from 'node:assert/strict';
import {evolutionPublicPapers} from '../src/evolutionService.mjs';
test('public papers expose canonical identities without arbitrary URLs or private material',()=>{
  assert.deepEqual(evolutionPublicPapers([{doi:'10.1234/method',title:'Method',url:'http://127.0.0.1/private',privateNotes:'secret'},'PMID:123','PMC456',{id:'private-dataset',title:'Private'}]),[
    {id:'10.1234/method',title:'Method',url:'https://doi.org/10.1234/method'},
    {id:'123',title:'123',url:'https://pubmed.ncbi.nlm.nih.gov/123/'},
    {id:'PMC456',title:'PMC456',url:'https://pmc.ncbi.nlm.nih.gov/articles/PMC456/'}]);
});
