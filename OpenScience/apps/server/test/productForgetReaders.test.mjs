import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductDocuments } from '../src/productStore.mjs';

for (const surface of ['get','list','search','history']) test(`${surface} checks the complete derived payload before disclosing any projection`, async () => {
  const row = {id:'m1',kind:'method',user_id:'u',project_id:'source-project',payload:{body:'Private derived text',provenance:{runId:'r1'}},revision:1,
    created_at:new Date(),updated_at:new Date(),recorded_at:new Date(),deleted_at:null};
  // No PostgreSQL operations in this unit; integration covers the real schema and rejection parent.
  const database = {transaction:async()=>{},query:async()=>({rows:[row]})};
  const documents = new ProductDocuments(database);
  let observed = false;
  documents.memoryForgetReader = async (_user,value) => { observed = true; assert.equal(value.payload.provenance.runId,'r1'); assert.equal(value.projectId,'source-project'); return false; };
  const result = surface === 'get' ? await documents.get('u','method','m1')
    : surface === 'list' ? (await documents.list('u','method',{fields:{body:8}})).items
      : surface === 'search' ? await documents.search('u','method','Private') : await documents.history('u','method','m1',{fields:{body:8}});
  assert.equal(observed,true);
  assert.deepEqual(result,surface === 'get' ? null : []);
});

for (const surface of ['get','list','learningEvidenceOf','listResultCorrections']) test(`feedback ${surface} cannot recycle withdrawn quotations`, async () => {
  const { FeedbackEvents } = await import('../src/feedbackEvents.mjs');
  const row = {id:'event1',user_id:'u',project_id:'p',run_id:'r',trigger_kind:'learning-evidence',subject_type:'run',subject_id:'r',detail:{quote:'M-41633'},occurred_at:new Date(),recorded_at:new Date()};
  const database = {transaction:async()=>{},query:async()=>({rows:[row]})};
  const feedback = new FeedbackEvents({database});
  let checked = false;
  feedback.memoryForgetReader = async (_user,value) => { checked = true; assert.match(JSON.stringify(value),/M-41633/); return false; };
  const result = surface === 'get' ? await feedback.get('u','event1') : surface === 'list' ? (await feedback.list('u')).items
    : surface === 'learningEvidenceOf' ? await feedback.learningEvidenceOf('u','r') : await feedback.listResultCorrections('u','v1');
  assert.equal(checked,true);
  assert.deepEqual(result,surface === 'get' ? null : []);
});

test('FT12 lifecycle bookkeeping reads the real method row past the reader fence; ordinary readers still do not', async () => {
  const row = {id:'m1',kind:'method',user_id:'u',project_id:null,payload:{status:'approved',provenance:{sourceProjectId:'gone',runId:'r1'}},revision:1,
    created_at:new Date(),updated_at:new Date(),recorded_at:new Date(),deleted_at:null};
  const documents = new ProductDocuments({transaction:async()=>{},query:async()=>({rows:[row]})});
  documents.memoryForgetReader = async () => false;
  assert.equal(await documents.get('u','method','m1'),null);
  assert.deepEqual((await documents.list('u','method')).items,[]);
  assert.equal((await documents.get('u','method','m1',{lifecycle:true}))?.payload.status,'approved');
  assert.deepEqual((await documents.list('u','method',{lifecycle:true})).items.map(item=>item.id),['m1']);
});
