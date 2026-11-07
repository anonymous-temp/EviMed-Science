import assert from 'node:assert/strict';
import test from 'node:test';
import { createPatientMatchingModelPorts } from '../src/patientMatchingModels.mjs';

const scope = { tenantId: 'user-a', actorId: 'user-a', projectId: 'project-a', conversationId: 'root-a' };
function fixture(fetchImpl) {
  const events = [];
  const ledger = {
    async reserveModel(input) { events.push(['reserve', input]); return { id: 'reservation-a' }; },
    async settleModel(_user, _id, input) { events.push(['settle', input]); },
    async release() { events.push(['release']); }, async markUncertain() { events.push(['uncertain']); },
  };
  const ports = createPatientMatchingModelPorts({ config: { dashscopeApiKey: 'provider-test-key', requireDurableUsageLedger: true }, usageLedger: ledger,
    authorize: async (envelope) => { events.push(['authorize']); return { userId: envelope.scope.actorId, projectId: envelope.scope.projectId, runId: 'run-a' }; },
    fetchImpl: async (...args) => { events.push(['fetch']); return fetchImpl(...args); } });
  return { ports, events };
}

test('embedding maps every returned vector and reserves before provider dispatch', async () => {
  const f = fixture(async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'qwen3.7-text-embedding');
    return Response.json({ model: body.model, data: [{ index: 0, embedding: Array(1024).fill(0.5) }], usage: { total_tokens: 100 } });
  });
  const result = await f.ports.embed({ scope, input: { texts: ['preserved public trial'] } });
  assert.equal(result.status, 'complete');
  assert.equal(result.data.vectors[0].length, 1024);
  assert.deepEqual(f.events.map(event => event[0]), ['authorize', 'reserve', 'authorize', 'fetch', 'settle']);
});

test('dimension/identity errors are not usable vectors, but measured usage remains settled', async () => {
  const f = fixture(async () => Response.json({ data: [{ index: 0, embedding: [1, 2] }], usage: { total_tokens: 20 } }));
  const result = await f.ports.embed({ scope, input: { texts: ['public trial'] } });
  assert.equal(result.status, 'failed');
  assert.equal(result.data.code, 'patient_matching_embedding_invalid');
  assert.equal(f.events.at(-1)[0], 'settle');
});

test('provider refusal releases the reservation and does not echo credentials or error bodies', async () => {
  const f = fixture(async () => new Response('provider-test-key private response', { status: 401 }));
  const result = await f.ports.embed({ scope, input: { texts: ['public trial'] } });
  assert.equal(result.status, 'failed');
  assert.ok(!JSON.stringify(result).includes('provider-test-key'));
  assert.equal(f.events.at(-1)[0], 'release');
});

test('rerank returns exact candidate identities; an invalid provider order preserves the incoming list explicitly', async () => {
  const f = fixture(async () => Response.json({ results: [{ index: 0, relevance_score: 0.7 }, { index: 0, relevance_score: 0.9 }], usage: { total_tokens: 20 } }));
  const result = await f.ports.rerank({ scope, input: { query: 'lung', candidates: [{ registryId: 'A', text: 'A source' }, { registryId: 'B', text: 'B source' }] } });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.data.order, ['A', 'B']);
  assert.equal(result.data.fallback, true);
});

test('typed fit asks Jev once per candidate with the pinned profile and the five-level rubric, without changing the review model', async () => {
  const config = { reviewJevModel: 'jev-1.13.0' };
  const seen = [];
  const ports = createPatientMatchingModelPorts({ config,
    authorize: async () => ({ userId: 'user-a', projectId: 'project-a' }),
    callJevImpl: async (dependencies, call) => {
      assert.equal(dependencies.config.reviewJevModel, 'jev-1.14.0');
      assert.equal(dependencies.config.reviewJevApiBase, 'https://api.typesafe.ai/v1');
      assert.equal(call.questions.fit.type, 'score');
      assert.equal(call.questions.fit.criteria.length, 5);
      seen.push(call.state.trial_record);
      return { answers: { fit: { type: 'score', score: call.state.trial_record === 'Trial B' ? 3.6 : 0.4, confidence: 0.7 } }, model: 'jev-1.14.0' };
    },
  });
  const result = await ports.jevFit({ scope, input: { query: 'patient passages', candidates: [{ registryId: 'A', text: 'Trial A' }, { registryId: 'B', text: 'Trial B' }] } });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.data.scores.map(row => [row.registryId, row.score]), [['A', 0.4], ['B', 3.6]]);
  assert.deepEqual(seen.sort(), ['Trial A', 'Trial B']);
  assert.equal(config.reviewJevModel, 'jev-1.13.0');
});

test('a failed or out-of-range Jev answer leaves that candidate unscored and the others scored', async () => {
  const ports = createPatientMatchingModelPorts({ config: {},
    authorize: async () => ({ userId: 'user-a', projectId: 'project-a' }),
    callJevImpl: async (_dependencies, call) => {
      if (call.state.trial_record === 'bad') return { answers: { fit: { type: 'score', score: 7 } } };
      if (call.state.trial_record === 'down') throw Object.assign(new Error('provider'), { code: 'jev_http_503' });
      return { answers: { fit: { type: 'score', score: 2 } }, model: 'jev-1.14.0' };
    },
  });
  const result = await ports.jevFit({ scope, input: { query: 'p', candidates: [{ registryId: 'A', text: 'ok' }, { registryId: 'B', text: 'bad' }, { registryId: 'C', text: 'down' }] } });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.data.scores.map(row => [row.registryId, row.score, row.code ?? null]), [['A', 2, null], ['B', null, 'patient_matching_priority_invalid'], ['C', null, 'jev_http_503']]);
});

test('embedding endpoints form distinct immutable profiles',()=>{
 const a=createPatientMatchingModelPorts({config:{vcrMatchEmbeddingApiBase:'https://example.test/one'},authorize:async()=>null});
 const b=createPatientMatchingModelPorts({config:{vcrMatchEmbeddingApiBase:'https://example.test/two'},authorize:async()=>null});
 assert.notEqual(a.embeddingProfileDigest,b.embeddingProfileDigest);
});
test('Jev source authorization is repeated by its retry/fetch hook',async()=>{
 let authorized=0;
 const ports=createPatientMatchingModelPorts({config:{},authorize:async()=>{if(++authorized>1)throw new Error('revoked');return {userId:'user-a',projectId:'project-a'};},callJevImpl:async deps=>{await deps.assertModelAccess();throw new Error('provider must not be reached');}});
 const value=await ports.jevFit({scope,input:{query:'objective',candidates:[{registryId:'a',text:'public'}]}});
 assert.equal(authorized,2);assert.equal(value.status,'failed');assert.equal(value.data.scores[0].score,null);
});

test('documented native rerank dialect and repeated query billing remain bounded',async()=>{
 let reservation;
 const ports=createPatientMatchingModelPorts({config:{dashscopeApiKey:'fixture',vcrMatchRerankApiBase:'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank'},authorize:async()=>({userId:'user-a',projectId:'project-a'}),usageLedger:{reserveModel:async row=>{reservation=row;return {id:'r'};},settleModel:async()=>{},release:async()=>{},markUncertain:async()=>{}},fetchImpl:async(_url,options)=>{
  const body=JSON.parse(options.body);assert.equal(body.input.documents.length,2);assert.equal(body.parameters.top_n,2);assert.ok(body.parameters.instruct);
  return Response.json({output:{results:[{index:1,relevance_score:1},{index:0,relevance_score:0}]},usage:{total_tokens:10}});
 }});
 const result=await ports.rerank({scope,input:{query:'q'.repeat(8000),candidates:[{registryId:'A',text:'a'},{registryId:'B',text:'b'}]}});assert.deepEqual(result.data.order,['B','A']);assert.ok(reservation.estimatedCost>=16000*0.5/1000000,'query is charged per document, not once');
});

test('qualified embedding request limit is twenty texts and larger batches stop before dispatch',async()=>{
 let sends=0;const f=fixture(async(_url,options)=>{sends++;const body=JSON.parse(options.body);return Response.json({data:body.input.map((_,index)=>({index,embedding:Array(1024).fill(0.5)})),usage:{total_tokens:20}});});
 assert.equal(f.ports.embeddingBatchSize,20);assert.equal((await f.ports.embed({scope,input:{texts:Array(20).fill('public')}})).status,'complete');assert.equal((await f.ports.embed({scope,input:{texts:Array(21).fill('public')}})).status,'failed');assert.equal(sends,1);
});

test('one full judged candidate pool is ranked in a single request without mixing batch-relative scores',async()=>{
 let requests=0;
 const f=fixture(async(_url,options)=>{requests++;const body=JSON.parse(options.body);assert.equal(body.documents.length,153);return Response.json({results:body.documents.map((_,index)=>({index,relevance_score:index/153})),usage:{total_tokens:1530}});});
 const candidates=Array.from({length:153},(_,index)=>({registryId:`NCT${String(index).padStart(8,'0')}`,text:'Adult clinical trial source'}));
 const result=await f.ports.rerank({scope,input:{query:'adult lung cancer',candidates}});assert.equal(result.status,'complete');assert.equal(result.data.order.length,153);assert.equal(result.data.order[0],candidates[152].registryId);assert.equal(requests,1);assert.equal(result.data.scores.length,153);
});
