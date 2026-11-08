import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPatientMatchingDiscovery} from '../src/patientMatchingDiscovery.mjs';
const scope={tenantId:'owner',actorId:'owner',projectId:'project',conversationId:'root'},origin={userId:'owner',projectId:'project',rootSessionId:'root'};
test('fused retrieval is reranked once and saves exactly the candidate order returned to the caller',async()=>{
 let saved,calls=0,authorizationSources;
 const discover=createPatientMatchingDiscovery({vcr:{service:{runtimeRead:async(_study,kind,input)=>kind==='candidates'?{collection:{id:'frozen-collection',revision:'frozen-revision'},candidates:[{registryId:'NCT00000001'},{registryId:'NCT00000002'}],registries:[{status:'ok'}]}:(()=>{assert.equal(input.collection,'frozen-collection');assert.equal(input.collectionRevision,'frozen-revision');return {record:{title:input.registryId,eligibilityText:'Adults'}};})()},candidateSearches:{save:async(_study,r)=>{saved=r;return 'search';}}},index:{query:async()=>({status:'complete',data:{generation:'dense-one',candidates:[{registryId:'NCT00000002'},{registryId:'NCT00000003'}]}})},models:{embeddingProfileDigest:'profile',rerank:async e=>{calls++;authorizationSources=e.input.patientSources;return {status:'complete',data:{model:'qwen3.7-text-rerank',order:['NCT00000003','NCT00000002','NCT00000001']}};}}});
 const data=(await discover({scope,origin,study:{id:'study'},meta:{taskId:'task',contextSubjectKey:'person',selectedPairs:[]},input:{query:'lung cancer',limit:2},patient:{sources:[{sourceId:'original'}],passages:[{text:'preserved private record'}]}})).data;
 assert.equal(calls,1);assert.deepEqual(authorizationSources,[{sourceId:'original'}]);assert.deepEqual(data.candidates.map(r=>r.registryId),saved.items.slice(0,2).map(r=>r.registryId));assert.deepEqual(saved.rerank.finalOrder,saved.items.map(r=>r.registryId));assert.doesNotMatch(JSON.stringify(saved.request),/preserved private record/);assert.equal(data.retrieved,3);
});
test('optional index failure retains usable registry candidates and protocol discovery uses the owned roster',async()=>{
 let retrieval=0;
 const vcr={documents:{roster:async()=>[{subjectKey:'person'},{subjectKey:'person'},{subjectKey:'other'}]},service:{runtimeRead:async()=>{retrieval++;return {candidates:[{registryId:'NCT00000001'}]};}},candidateSearches:{save:async()=> 'search'}};
 const discover=createPatientMatchingDiscovery({vcr,index:{query:async()=>{throw new Error('outage');}},models:{embeddingProfileDigest:'profile'}});
 const trial=await discover({scope,origin,study:{id:'study'},meta:{taskId:'task',selectedPairs:[]},input:{query:'condition'}});assert.equal(trial.data.candidates.length,1);assert.equal(trial.data.coverage.dense.status,'unsupported');
 const people=await discover({scope,origin,study:{id:'study'},meta:{protocolVersionId:'protocol'},input:{}});assert.deepEqual(people.data.people,[{subjectKey:'person',label:'person'},{subjectKey:'other',label:'other'}]);assert.equal(people.data.available,2);assert.equal(retrieval,2,'one candidate retrieval and one full-source read; protocol discovery adds none');
});
test('long or blank discovery questions stop before source/model work and preserve the task context',async()=>{
 let reads=0,models=0;
 const discover=createPatientMatchingDiscovery({vcr:{service:{runtimeRead:async()=>{reads++;throw new Error('must not read');}}},models:{rerank:async()=>{models++;}}});
 for(const query of [' '.repeat(20),'a'.repeat(201),'病'.repeat(201)]){
  const answer=await discover({scope,origin,study:{id:'study'},meta:{taskId:'preserved-task',selectedPairs:[]},input:{query}});assert.equal(answer.status,'unsupported');assert.equal(answer.data.maxQueryCharacters,200);
 }
 assert.equal(reads,0);assert.equal(models,0);
});
test('discovery asks the lexical branch for the condition and its ranked terms, and saves the rerank and Jev orders fused', async () => {
 let asked, saved, prefetched;
 const ids = ['NCT00000001', 'NCT00000002', 'NCT00000003'];
 const vcr = { service: { runtimeRead: async (_study, kind, input, options) => {
   if (kind === 'candidates') { asked = { ...input, listMax: options?.listMax }; return { candidates: ids.map(registryId => ({ registryId, title: registryId })), registries: [{ status: 'ok' }] }; }
   return { record: { title: input.registryId, eligibilityText: `criteria of ${input.registryId}` } };
 }, prefetchRegistryRecords: async (wanted) => { prefetched = wanted; return { prefetched: wanted.length, missing: 0 }; } }, candidateSearches: { save: async (_study, value) => { saved = value; return 'search'; } } };
 const models = { embeddingProfileDigest: 'profile',
   rerank: async () => ({ status: 'complete', data: { order: [...ids], model: 'qwen3.7-text-rerank' } }),
   jevFit: async (envelope) => {
     assert.match(envelope.input.candidates[0].text, /^Title: NCT00000001\nTarget conditions:/);
     assert.match(envelope.input.candidates[0].text, /Eligibility Criteria \(raw\):\ncriteria of NCT00000001/);
     return { status: 'complete', data: { model: 'jev-1.14.0', rubric: 'jev-fit-5-v1', answered: 3, scores: [{ registryId: ids[0], score: 0.2 }, { registryId: ids[1], score: 3.9 }, { registryId: ids[2], score: 3.8 }] } };
   } };
 const discover = createPatientMatchingDiscovery({ vcr, models, depth: 50 });
 const answer = await discover({ scope, origin, study: { id: 'study' }, meta: { taskId: 'task', contextSubjectKey: 'person', selectedPairs: [] },
   input: { query: 'non-small cell lung cancer', terms: ['EGFR exon 19 deletion', 'osimertinib', '', 'EGFR exon 19 deletion'], limit: 3 }, patient: { sources: [], passages: [{ text: 'record' }] } });
 assert.deepEqual(asked.terms, ['EGFR exon 19 deletion', 'osimertinib']);
 assert.equal(asked.limit, 50);
 assert.deepEqual(prefetched, ids, 'live ClinicalTrials.gov records are read in one batch before the single reads');
 assert.equal(asked.listMax, 50, 'the live search hands over its whole kept list up to the depth, not a run-sized page');
 assert.deepEqual(saved.rerank.rerankOrder, ids);
 assert.deepEqual(saved.rerank.jev.order, [ids[1], ids[2], ids[0]]);
 assert.deepEqual(saved.rerank.finalOrder, [ids[1], ids[0], ids[2]], 'rank fusion: the second candidate leads both orders on the sum, the first keeps its rerank lead over the third');
 assert.equal(saved.rerank.policy, 'triallink-3');
 assert.deepEqual(answer.data.candidates.map(row => row.registryId), saved.rerank.finalOrder);
});
test('without Jev the rerank order stands, and a failed Jev answer never fails discovery', async () => {
 const ids = ['NCT00000001', 'NCT00000002'];
 const vcr = { service: { runtimeRead: async (_s, kind, input) => kind === 'candidates' ? { candidates: ids.map(registryId => ({ registryId })) } : { record: { title: input.registryId } } }, candidateSearches: { save: async () => 'search' } };
 const rerank = async () => ({ status: 'complete', data: { order: [ids[1], ids[0]] } });
 const off = await createPatientMatchingDiscovery({ vcr, models: { embeddingProfileDigest: 'profile', rerank, jevFit: async () => { throw new Error('must not be asked'); } }, jevEnabled: false })({ scope, origin, study: {}, meta: { taskId: 't', selectedPairs: [] }, input: { query: 'q' } });
 assert.deepEqual(off.data.candidates.map(row => row.registryId), [ids[1], ids[0]]);
 const failed = await createPatientMatchingDiscovery({ vcr, models: { embeddingProfileDigest: 'profile', rerank, jevFit: async () => ({ status: 'failed', data: { code: 'jev_http_503' } }) } })({ scope, origin, study: {}, meta: { taskId: 't', selectedPairs: [] }, input: { query: 'q' } });
 assert.deepEqual(failed.data.candidates.map(row => row.registryId), [ids[1], ids[0]]);
 assert.equal(failed.data.rerank.jev.state, 'failed');
});
function longRecordFixture(models, extra = {}) {
 const asked = [];
 const vcr = { service: { runtimeRead: async (_s, kind, input) => { if (kind === 'candidates') { asked.push(input); return { candidates: [{ registryId: 'NCT00000001' }, { registryId: 'NCT00000002' }], registries: [{ status: 'ok' }] }; } return { record: { title: input.registryId } }; } }, candidateSearches: { save: async () => 'search' } };
 return { asked, discover: createPatientMatchingDiscovery({ vcr, models: { embeddingProfileDigest: 'profile', rerank: async () => ({ status: 'partial', data: {} }), ...models }, jevEnabled: false, ...extra }) };
}
const run = (discover, input, patient) => discover({ scope, origin, study: {}, meta: { taskId: 't', contextSubjectKey: 'person', selectedPairs: [] }, input: { query: 'lung cancer', ...input }, patient });
const longPatient = () => ({ sources: [], note: { hash: 'h1' }, passages: [{ text: 'OLDEST visit. ' + 'Filler sentence one. '.repeat(400) }, { text: 'Newest visit: progression on osimertinib. Age 61.' }] });

test('a long record is ranked by its profile summary, which also supplies age and sex, and the profile is cached per record', async () => {
 let profiles = 0, rankQuery;
 const { discover, asked } = longRecordFixture({ profile: async e => { profiles++; assert.deepEqual(e.input.patientSources, []); return { status: 'complete', data: { text: 'Demographics: 61 male', age: 61, sex: 'male' } }; }, rerank: async e => { rankQuery = e.input.query; return { status: 'partial', data: {} }; } });
 await run(discover, {}, longPatient());
 assert.equal(rankQuery, 'lung cancer\nDemographics: 61 male');
 assert.equal(asked[0].age, 61); assert.equal(asked[0].sex, 'male');
 await run(discover, {}, longPatient());
 assert.equal(profiles, 1, 'the same record is summarised once');
});

test('the tool\'s age, sex and region win over the profile and reach the registry filter', async () => {
 const { discover, asked } = longRecordFixture({ profile: async () => ({ status: 'complete', data: { text: 'P', age: 61, sex: 'male' } }) });
 await run(discover, { age: 40, sex: 'female', region: 'China' }, longPatient());
 assert.deepEqual([asked[0].age, asked[0].sex, asked[0].region], [40, 'female', 'China']);
 const short = longRecordFixture({});
 await run(short.discover, {}, { sources: [], passages: [{ text: 'short' }] });
 assert.equal('age' in short.asked[0] || 'sex' in short.asked[0] || 'region' in short.asked[0], false);
});

test('a failed profile falls back to the newest whole sentences and never fails discovery', async () => {
 let rankQuery;
 const { discover } = longRecordFixture({ profile: async () => { throw new Error('down'); }, rerank: async e => { rankQuery = e.input.query; return { status: 'partial', data: {} }; } });
 const answer = await run(discover, {}, longPatient());
 assert.equal(answer.status, 'complete');
 assert.ok(rankQuery.length <= 6000);
 assert.match(rankQuery, /Newest visit: progression on osimertinib\. Age 61\.$/);
 assert.doesNotMatch(rankQuery, /OLDEST/);
 const noPort = longRecordFixture({ rerank: async e => { rankQuery = e.input.query; return { status: 'partial', data: {} }; } });
 await run(noPort.discover, {}, longPatient());
 assert.match(rankQuery, /Newest visit/);
});

test('a short record is the query and passages joined, byte for byte', async () => {
 let rankQuery;
 const { discover } = longRecordFixture({ profile: async () => { throw new Error('must not be asked'); }, rerank: async e => { rankQuery = e.input.query; return { status: 'partial', data: {} }; } });
 await run(discover, {}, { sources: [], passages: [{ text: 'first' }, { text: 'second' }] });
 assert.equal(rankQuery, 'lung cancer\nfirst\nsecond');
});

test('the configured rank view reaches the rerank documents and the saved profile id', async () => {
 let saved, text;
 const vcr = { service: { runtimeRead: async (_s, kind, input) => kind === 'candidates' ? { candidates: [{ registryId: 'NCT00000001' }, { registryId: 'NCT00000002' }] } : { record: { title: input.registryId, eligibilityText: 'Inclusion Criteria:\n- ' + 'x'.repeat(3000) } } }, candidateSearches: { save: async (_s, value) => { saved = value; return 's'; } } };
 await createPatientMatchingDiscovery({ vcr, jevEnabled: false, rankView: 'trial-record', models: { embeddingProfileDigest: 'p', rerank: async e => { text = e.input.candidates[0].text; return { status: 'partial', data: {} }; } } })({ scope, origin, study: {}, meta: { taskId: 't', selectedPairs: [] }, input: { query: 'q' } });
 assert.equal(saved.rerank.view.profile, 'trial-record-12k-v1');
 assert.ok(text.length > 3000);
});
