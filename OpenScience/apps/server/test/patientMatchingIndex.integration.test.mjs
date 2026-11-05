import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { createPatientMatchingIndexPorts } from '../src/patientMatchingIndex.mjs';

const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options={skip:!url&&'An isolated local PostgreSQL with pgvector is required'};
let isolated,database;
before(async()=>{if(!url)return;isolated=await createGeoTestDatabase(url,'matchingindex');database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:5,databaseConnectionTimeoutMs:2000});await database.query('CREATE EXTENSION vector');});
after(async()=>{await database?.close();await isolated?.drop();});
const hash=letter=>`sha256:${letter.repeat(64)}`;
const vector=index=>Array.from({length:1024},(_,i)=>i===index?1:0);
const envelope={scope:{tenantId:'owner',projectId:'project'},input:{query:'cancer',limit:2}};
function fixture(){let calls=0,records=[{registryId:'trial-a',text:'cancer',sourceDigest:hash('a')}];
  const authority={collectionId:'registry',sourceDigest:hash('b'),expectedRecords:2,buildAllowed:true};
  const models={dimensions:1024,embeddingProfileDigest:hash('c'),embed:async e=>{calls++;return {status:'complete',data:{embeddingProfileDigest:models.embeddingProfileDigest,vectors:e.input.texts.map(text=>vector(text==='cancer'?0:1))}};}};
  const ports=createPatientMatchingIndexPorts({database,models,authorize:async()=>authority,loadRecords:async()=>records});
  return {ports,models,authority,setRecords:r=>{records=r;},calls:()=>calls};}

test('generation resumes once, serves the same embedding profile and stays immutable',options,async()=>{
  const f=fixture();
  assert.equal((await f.ports.query(envelope)).data.code,'patient_matching_index_not_ready');
  const partial=await f.ports.build(envelope);assert.equal(partial.status,'partial');assert.equal(partial.data.indexed,1);
  await f.ports.build(envelope);assert.equal(f.calls(),1,'valid stored embeddings are reused');
  f.setRecords([{registryId:'trial-b',text:'diabetes',sourceDigest:hash('d')}]);
  const ready=await f.ports.build(envelope);assert.equal(ready.status,'complete');assert.equal(ready.data.indexed,2);
  const query=await f.ports.query(envelope);assert.equal(query.data.searchMode,'exact-pgvector');assert.equal(query.data.candidates[0].registryId,'trial-a');assert.equal(query.data.generation,ready.data.generation);
  assert.equal((await f.ports.query({...envelope,scope:{...envelope.scope,projectId:'foreign'}})).data.code,'patient_matching_index_not_ready');
  f.setRecords([{registryId:'trial-c',text:'extra',sourceDigest:hash('e')}]);
  const calls=f.calls();assert.equal((await f.ports.build(envelope)).data.code,'patient_matching_index_generation_immutable');assert.equal(f.calls(),calls);
  assert.equal((await database.query('SELECT count(*)::integer AS n FROM evimed_matching.trial_index_rows WHERE generation=$1',[ready.data.generation])).rows[0].n,2);
  await database.query('UPDATE evimed_matching.trial_index_generations SET indexed_records=-1 WHERE generation=$1',[ready.data.generation]);
  f.setRecords([{registryId:'trial-a',text:'cancer',sourceDigest:hash('a')}]);
  assert.equal((await f.ports.build(envelope)).data.indexed,2,'legacy generation counter is backfilled exactly once');
  assert.equal((await database.query('SELECT indexed_records FROM evimed_matching.trial_index_generations WHERE generation=$1',[ready.data.generation])).rows[0].indexed_records,2);

  f.authority.expectedRecords=3;
  const changed=await f.ports.build(envelope);assert.notEqual(changed.data.generation,ready.data.generation);assert.equal(changed.status,'partial');
});

test('bad embedding dimensions and an oversized source manifest cannot create a ready index',options,async()=>{
  const f=fixture();f.authority.collectionId='bad';f.authority.expectedRecords=1;
  f.setRecords([{registryId:'a',text:'a',sourceDigest:hash('a')},{registryId:'b',text:'b',sourceDigest:hash('b')}]);
  assert.equal((await f.ports.build(envelope)).data.code,'patient_matching_index_manifest_mismatch');
  f.setRecords([{registryId:'a',text:'a',sourceDigest:hash('a')}]);
  f.models.embed=async()=>({status:'complete',data:{embeddingProfileDigest:f.models.embeddingProfileDigest,vectors:[[1,2]]}});
  assert.equal((await f.ports.build(envelope)).data.code,'patient_matching_index_vector_invalid');
  assert.equal((await f.ports.query(envelope)).data.code,'patient_matching_index_not_ready');
});

test('concurrent disjoint chunks count only inserted rows and never transfer a generation-wide identity list',options,async()=>{
 let fullIdentityReads=0;
 const traced={query:(...args)=>database.query(...args),transaction:operation=>database.transaction(client=>operation({query:(sql,args)=>{if(sql.includes('SELECT registry_id,source_digest FROM')&&!sql.includes('ANY('))fullIdentityReads++;return client.query(sql,args);}}))};
 const models={dimensions:1024,embeddingBatchSize:20,embeddingProfileDigest:hash('f'),embed:async e=>({status:'complete',data:{embeddingProfileDigest:hash('f'),vectors:e.input.texts.map(()=>vector(0))}})};
 const ports=createPatientMatchingIndexPorts({database:traced,models,authorize:async()=>({collectionId:'concurrent',sourceDigest:hash('a'),expectedRecords:4,buildAllowed:true}),loadRecords:async e=>e.input.records});
 const records=['a','b','c','d'].map(id=>({registryId:id,text:id,sourceDigest:hash(id)}));
 const results=await Promise.all([ports.build({...envelope,input:{records:records.slice(0,2)}}),ports.build({...envelope,input:{records:records.slice(2)}})]);
 assert.ok(results.some(result=>result.data.state==='ready'));assert.equal(fullIdentityReads,0);
 const row=await database.query('SELECT indexed_records FROM evimed_matching.trial_index_generations WHERE generation=$1',[results[0].data.generation]);assert.equal(row.rows[0].indexed_records,4);
});
