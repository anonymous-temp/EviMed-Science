import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountProjections } from '../src/memoryAccountProjections.mjs';
import { humanInputReceipt, inputDigest } from '../src/memoryHumanSegments.mjs';
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
  const projection=createAccountProjections({config, native:{files:async()=>[file],records:async()=>records},overlay:{files:async()=>new Map([[file.uri,file]]),originsOf:async()=>new Map()},
    methods:{approvedMethods:async()=>[source]},provenance:{ordinaryDocument:async()=>!f.shared}, settings:{resetInstant:async()=>null},
    contexts:{forProject:async()=>({kind:f.shared?'geo-project':'owned'}),assertLive:async()=>{}},projectFor:async(userId,id)=>({id,userId}),
    projectRuns:async()=>[run],deleted:async()=>f.deleted,clinical:async()=>f.clinical});
  return {...f, control:f,projection};
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
