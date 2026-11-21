import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountProjections } from '../src/memoryAccountProjections.mjs';
import { humanInputReceipt, inputDigest } from '../src/memoryHumanSegments.mjs';
import { clinicalSegmentDigest } from '../src/memoryClinicalSegments.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { renderResidentProfile } from '../src/residentProfile.mjs';

const quote = '以后报告用表格。';
function fixture() {
  const config={memoryAccountPresentationEnabled:true};
  const source = {id:'local-method',payload:{status:'approved',body:'Local statistical method with private project details.',
    contentDigest:inputDigest('method'),provenance:{scope:'statistical-analysis',sourceProjectId:'study',evidence:[{runId:'r', quote}]}}};
  const run={id:'r',sessionId:'original',kernelRequestIds:['input'],memoryInput:humanInputReceipt(quote)};
  const file={type:'preferences',uri:'viking://user/u/memories/preferences/self/tone.md',body:'以后语气正式一点。'};
  const records=[{uri:file.uri,id:'preference',status:'active',origin:'manual',value:file.body,contentHash:inputDigest(file.body),
    sourcePrivacy:{classification:'ordinary'},attribution:{origins:['manual']}}];
  const f={config, source, run, file, records, deleted:false, clinical:false, shared:false};
  const decisions=new Map(), origins=new Map(), external=new Map();
  const projection=createAccountProjections({config, native:{files:async()=>[file],records:async()=>records},overlay:{instructionCheck:async(_u,id)=>decisions.get(id),recordInstructionCheck:async(_u,id,verdict)=>decisions.set(id,verdict),files:async()=>new Map([[file.uri,file]]),originsOf:async()=>origins,externalSources:async()=>external},
    methods:{approvedMethods:async()=>[source]},provenance:{ordinaryDocument:async()=>!f.shared}, settings:{resetInstant:async()=>null},
    contexts:{forProject:async()=>({kind:f.shared?'geo-project':'owned',projectCreatedAt:'epoch'}),assertLive:async()=>{}},projectFor:async(userId,id)=>({id,userId}),
    projectRuns:async()=>[run],deleted:async()=>f.deleted,clinical:async(_u,_p,refs)=>f.clinical || refs.some(ref=>ref.sessionId==='sealed')});
  return {...f, control:f,projection,origins,external};
}

test('owned modules receive only standing original quotes from current preferences and methods', async()=>{
  const f=fixture(), original=structuredClone(f.source);
  for (const project of ['reports','analysis','frontier','deep-research']) {
    const memos=await f.projection.presentation('u',project,'session');
    assert.deepEqual(new Set(memos.map(row=>row.content)),new Set([quote,f.file.body]));
    assert.ok(memos.every(row=>row.applicationScope==='account-presentation'));
    const rendered=renderResidentProfile({presentation:memos});
    assert.match(rendered.standing,/以后报告用表格/);assert.doesNotMatch(rendered.text,/statistical method|private project/);
  }
  assert.deepEqual(f.source,original);
  f.source.payload.status='archived';assert.equal((await f.projection.presentation('u','report','s')).length,1);
  f.config.memoryAccountPresentationEnabled=false;assert.deepEqual(await f.projection.presentation('u','report','s'),[]);
});

test('missing or narrowed scope, sealed context, revoked sources and shared methods grant nothing',async()=>{
  const f=fixture(); f.records.length=0;
  const read=()=>f.projection.presentation('u','report','s');
  for (const text of ['本项目以后报告用表格。','以后默认随机效应。','照患者的表格。','I might prefer tables.']) {
    f.source.payload.provenance.evidence[0].quote=text;
    assert.deepEqual(await read(),[]);
  }
  f.source.payload.provenance.evidence[0].quote=quote;
  for(const key of ['clinical','deleted','shared']){f.control[key]=true;assert.deepEqual(await read(),[]);f.control[key]=false;}
  f.run.memoryInput=humanInputReceipt('本项目'+quote);assert.deepEqual(await read(),[]);
});

test('withdrawing one account projection leaves its local source intact and can be reversed',async()=>{
  const f=fixture(), original=structuredClone(f.source);
  const list=()=>f.projection.list('u'), read=()=>f.projection.presentation('u','analysis','s');
  const {id}= (await list()).find(row=>row.content===quote);
  assert.equal(await f.projection.setEnabled('u',id,false),true);
  assert.equal((await list()).find(row=>row.id===id).disabled,true);
  assert.deepEqual((await read()).map(row=>row.content),[f.file.body]);
  assert.deepEqual(f.source,original);
  assert.equal(await f.projection.setEnabled('u',id,true),true);
  assert.ok((await read()).some(row=>row.id===id));
  assert.equal(await f.projection.setEnabled('u','unknown',false),false);
});

test('a sealed source can contribute only its separately attested standing quote',async()=>{
  const f=fixture(), projectId='study', sessionId='sealed', inputSeq=6, epoch='epoch';
  f.source.payload.status='retired';
  f.file.body=quote+' (as of 2026-11-01)'; f.records[0].value=f.file.body; f.records[0].origin='engine';
  f.run.sessionId=sessionId;
  f.run.memoryInput=humanInputReceipt('> SEALED-MATERIAL\n\n'+quote);
  const ref={operation:'clinical-segment',sessionId,runId:f.run.id,inputSeq,inputDigest:f.run.memoryInput.digest,projectCreatedAt:epoch,saidAt:f.run.memoryInput.at};
  const digest=clinicalSegmentDigest('u',projectId,ref,quote);
  const archiveUri='archive';
  f.origins.set(f.file.uri,new Map([[lineFingerprint(f.file.body),{archiveUri,engineSession:'evimed-segment-'+digest,projectId,projectCreatedAt:epoch}]]));
  f.external.set(archiveUri,{...ref,digest});
  f.config.memoryClinicalSegmentsEnabled=true;
  const read=()=>f.projection.presentation('u','analysis','destination');
  assert.deepEqual((await read()).map(m=>m.content),[quote]);assert.doesNotMatch(JSON.stringify(await read()),/SEALED-MATERIAL/);
  f.external.get(archiveUri).inputSeq++;
  assert.deepEqual(await read(),[]);
});

test('the account route changes only projections owned by the authenticated reader',async()=>{
  const {createMemoryRoutes}=await import('../src/memoryRoutes.mjs');
  const {Readable}=await import('node:stream');
  const f=fixture(), id=(await f.projection.list('u'))[0].id;
  const handler=createMemoryRoutes({config:{memoryAccountPresentationEnabled:true,maxJsonBytes:4096},
    accountProjections:f.projection,context:async()=>({user:{id:'u'}})});
  async function request(method,url,body) {
    const req=Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req,{method,url,headers:{}});
    let response;
    const res={writeHead:()=>{},end:bytes=>{response=JSON.parse(bytes);}};
    await handler(req,res);
    return response.data;
  }
  assert.equal((await request('GET','/api/memory/account-presentation')).length,2);
  const url='/api/memory/account-presentation/'+id;
  assert.deepEqual(await request('PUT',url,{enabled:false}),{id,enabled:false});
  assert.ok(!(await f.projection.presentation('u','other','s')).some(memo=>memo.id===id));
  await assert.rejects(request('PUT',url,{enabled:'false'}),{code:'memory_settings_invalid'});
});
