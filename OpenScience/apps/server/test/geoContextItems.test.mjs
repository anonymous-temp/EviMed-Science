import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { ContextItemAuthorization, contextPolicyIdentity } from '../src/geoContextItems.mjs';
import { ResidentProfiles } from '../src/residentProfile.mjs';

const policy = {kind:'geo-project',ownerId:'u',controlProjectId:'p',ownerCreatedAt:'a',projectCreatedAt:'b',policyVersion:1,revision:1,referenceId:'floor',namespace:{id:'ns'}};
const row = (id='m', project='p') => ({id,kind:'method',projectId:null,revision:1,payload:{recordType:'learned-method',status:'approved',frontmatter:{name:id},contentDigest:'a'.repeat(64),dependencies:[],provenance:{sourceProjectId:project,sourceProjectIds:[project],runId:'r'}}});
function fixture(items=[row()]) {
  const documents = {list:async (_u,_k,options) => ({items:items.filter(item=>!options.filter?.provenance || item.payload.provenance.sourceProjectId===options.filter.provenance.sourceProjectId),nextCursor:null}),history:async()=>[]};
  documents.matchesSnapshots=async(_user,snapshots,{fields})=>snapshots.every(snapshot=>{
    const current=items.find(item=>item.kind===snapshot.kind&&item.id===snapshot.id);
    return current?.revision===snapshot.revision&&isDeepStrictEqual(Object.fromEntries(Object.keys(fields).map(key=>[key,current.payload[key]??null])),Object.fromEntries(Object.keys(fields).map(key=>[key,snapshot.payload[key]??null])));
  });
  const resolver = async (owner,project,runId)=>({id:runId,userId:owner,projectId:project,automated:false});
  const verify = async ({policy,document,run,lineageDigest})=>({...contextPolicyIdentity(policy),documentId:document.id,documentRevision:document.revision,runId:run.id,contentDigest:document.payload.contentDigest,lineageDigest,complete:true,inputReceiptRefs:['accepted-input'],launchedContextRef:'launch',launchedContextDigest:'b'.repeat(64)});
  return {documents,resolver,verify};
}
test('a project tag or a source run alone cannot certify a derived private body',async()=>{
  const f=fixture();
  const items=new ContextItemAuthorization({documents:f.documents,contextPolicies:{forProject:async()=>policy},resolveSourceRun:f.resolver});
  assert.equal(await items.method(policy,row()),false);
  assert.equal(await items.method({kind:'owned'},row()),true);
  assert.equal(await items.method(null,row()),false);
});
test('canonical complete history and server-owned body/input receipt authorize the project',async()=>{
  const f=fixture();
  const items=new ContextItemAuthorization({documents:f.documents,contextPolicies:{forProject:async()=>policy},resolveSourceRun:f.resolver,verifyAcceptedContext:f.verify});
  assert.equal(await items.method(policy,row()),true);
  assert.equal(await items.method({...policy,ownerId:'foreign'},row()),false);
  f.documents.history=async()=>[{revision:0,payload:row('m','foreign').payload}];
  assert.equal(await items.method(policy,row()),false);
});
test('foreign/missing dependency and changed canonical revision are refused before hydration',async()=>{
  const candidate=row(); candidate.payload.dependencies=[{name:'missing',digest:'a'.repeat(64)}];
  const f=fixture([candidate]); const items=new ContextItemAuthorization({documents:f.documents,contextPolicies:{forProject:async()=>policy},resolveSourceRun:f.resolver,verifyAcceptedContext:f.verify});
  assert.equal(await items.method(policy,candidate),false);
  candidate.payload.dependencies=[]; candidate.revision=2;
  assert.equal(await items.method(policy,row()),false);
});
test('shared resident dispatch never reads the personal records, counts or capsule profile',async()=>{
  const forbidden=()=>{throw new Error('personal read');};
  const store={memoryEngine:async()=> 'native',paused:async()=>({}),residentRecords:forbidden,lookupCounts:forbidden,residentState:async()=>({digest:null,compactedSince:false})};
  const resident=new ResidentProfiles({config:{},store,capsules:{profileFacts:forbidden,lookupCount:forbidden},contextPolicies:{forProject:async()=>policy},projectCard:async()=>[{slot:'goal',text:'Shared task'}]});
  const result=await resident.forDispatch('u',{projectId:'p',sessionId:'s',attended:true});
  assert.match(result.text,/Shared task/);
  assert.equal((await resident.forDispatch('u',{projectId:'p',sessionId:'s',attended:false})).text,'');
});

test('a foreign private body is never inspected by the authorizer',async()=>{
  const foreign=row('foreign','other');
  Object.defineProperty(foreign.payload,'body',{get(){throw new Error('foreign body read');}});
  const f=fixture([foreign]);
  const items=new ContextItemAuthorization({documents:f.documents,contextPolicies:{forProject:async()=>policy},resolveSourceRun:f.resolver,verifyAcceptedContext:f.verify});
  assert.equal(await items.method(policy,foreign),false);
});
test('an incomplete history bound and an automated source never become exclusive proof',async()=>{
  const f=fixture();
  f.documents.history=async()=>Array.from({length:100},(_,i)=>({revision:200-i,payload:row().payload}));
  const items=new ContextItemAuthorization({documents:f.documents,contextPolicies:{forProject:async()=>policy},maxPages:1,resolveSourceRun:f.resolver,verifyAcceptedContext:f.verify});
  assert.equal(await items.method(policy,row()),false);
  f.documents.history=async()=>[];items.resolveSourceRun=async()=>({id:'r',userId:'u',projectId:'p',automated:true});
  assert.equal(await items.method(policy,row()),false);
});
test('resident policy failure has no personal fallback and digest changes with policy revision',async()=>{
  let current=policy, deliveredDigest=null;
  const forbidden=()=>assert.fail('personal read');
  const store={memoryEngine:async()=> 'native',paused:async()=>({}),residentState:async()=>({digest:deliveredDigest,compactedSince:false}),noteResidentDelivered:async(_u,_p,_s,digest)=>{deliveredDigest=digest;},residentRecords:forbidden,lookupCounts:forbidden};
  const policies={forProject:async()=>current};
  const resident=new ResidentProfiles({config:{},store,contextPolicies:policies,projectCard:async()=>[{slot:'goal',text:'Shared task'}]});
  const first=await resident.forDispatch('u',{projectId:'p',sessionId:'s',attended:true});await first.delivered();
  assert.equal((await resident.forDispatch('u',{projectId:'p',sessionId:'s',attended:true})).reason,'unchanged');
  current={...policy,revision:2};assert.equal((await resident.forDispatch('u',{projectId:'p',sessionId:'s',attended:true})).reason,'changed');
  policies.forProject=async()=>{throw new Error('Policy unavailable');};
  await assert.rejects(resident.forDispatch('u',{projectId:'p',sessionId:'s',attended:true}),/Policy unavailable/);
});

test('one authorization memoizes a shared dependency DAG and bounds total proof/metadata work',async()=>{
 const rows=[];let previous=[];
 for(let level=0;level<12;level++){
  const dependencies=previous.map(item=>({name:item.id,digest:item.payload.contentDigest}));
  previous=[row(`level-${level}-a`),row(`level-${level}-b`)];
  for(const item of previous)item.payload.dependencies=dependencies;
  rows.push(...previous);
 }
 const f=fixture(rows);let proofs=0,lists=0;
 f.documents.list=async(_user,_kind,options)=>{lists++;return {items:rows.filter(item=>(!options.filter?.recordType||item.payload.recordType===options.filter.recordType)&&(!options.filter?.frontmatter||item.id===options.filter.frontmatter.name)&&(!options.filter?.contentDigest||item.payload.contentDigest===options.filter.contentDigest)),nextCursor:null};};
 const authorizer=new ContextItemAuthorization({documents:f.documents,contextPolicies:{forProject:async()=>policy},resolveSourceRun:f.resolver,verifyAcceptedContext:async input=>{proofs++;return f.verify(input);}});
 assert.equal(await authorizer.method(policy,previous[0]),true);
 assert.ok(proofs<=rows.length,`${proofs} proof calls for ${rows.length} unique methods`);
 assert.ok(lists<rows.length*10,`${lists} metadata lists for ${rows.length} unique methods`);
 const limited=new ContextItemAuthorization({documents:f.documents,contextPolicies:{forProject:async()=>policy},resolveSourceRun:f.resolver,verifyAcceptedContext:f.verify,maxWork:20});
 assert.equal(await limited.method(policy,previous[0]),false,'An incomplete bounded closure cannot authorize context');
 rows[0].payload.provenance.sourceProjectId='foreign';
 assert.equal(await authorizer.method(policy,previous[0]),false,'Memoized permissions do not survive into another call');
});
