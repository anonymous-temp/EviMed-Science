import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { methodContentDigest } from '@evimed/domain';
import { ContextItemAuthorization, CONTEXT_ITEM_FIELDS, contextFactContentDigest, contextPolicyIdentity } from '../src/geoContextItems.mjs';
import { canonicalJson } from '../src/geoStore.mjs';
import { normalizeTranscript } from '../src/dshRuntimeAdapter.mjs';
import { CapsuleService } from '../src/capsuleService.mjs';
import { LearningService } from '../src/learningService.mjs';
import { selectLearnedMethods, learnedMethodDirectoryName } from '../src/learnedMethodMount.mjs';
import { selectCapsuleMethods, materializeCapsuleMethods } from '../src/capsuleMethods.mjs';
import { createNativeInputFixture } from './helpers/geoNativeInputFixture.mjs';
import { makePack } from './helpers/capsuleFixtures.mjs';
import { BODY, frontmatter } from './helpers/methodSkillFixture.mjs';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required',timeout:60000};
const sha256=value=>createHash('sha256').update(value).digest('hex');
const hash=value=>sha256(canonicalJson(value));

async function fixture(t) {
  const f=await createNativeInputFixture(t,4), policy=f.policy;
  await f.accounts.createProject(f.users.owner,"other","Other");
  const request=f.request('lesson'), frame=await f.prepare(request);
  await f.execute(request,frame,async()=>{await f.journal.beforeForward(request);f.journal.observe(request,{state:'accepted',authority:'native-mux'});});
  const transcript=normalizeTranscript('root',[{type:'turn/start',seq:0,data:{turn:1}},{type:'user/message',seq:1,data:{source:{kind:'user',rpcId:request.requestId},content:request.content}},{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}}]);
  const run={id:'source-run',userId:'owner',projectId:f.project.id,sessionId:'root',nativeTurn:{startSeq:0},kernelRequestIds:[request.requestId]};
  const attribution=await f.journal.forRun(f.project,run,transcript);
  assert.equal(attribution.complete,true);
  const receiptIds=attribution.inputs.map(input=>input.referenceId);
  const receipts=new Map();
  const items=new ContextItemAuthorization({documents:f.documents,contextPolicies:{forProject:async()=>policy},resolveSourceRun:async(owner,project,id)=>owner==='owner'&&project===run.projectId&&id===run.id?run:null,
    verifyAcceptedContext:async({document,lineageDigest,run:source})=>{
      const saved=await f.documents.get('owner','geo-plan-context',receipts.get(document.id));
      const current=await f.journal.forRun(f.project,source,transcript);
      if(!saved || !current.complete || canonicalJson(current.inputs.map(input=>input.referenceId))!==canonicalJson(saved.payload.inputReceiptRefs)
        || saved.payload.documentRevision!==document.revision || saved.payload.lineageDigest!==lineageDigest) return null;
      return saved.payload;
    }});
  // This fixture models the producer's separate body-bound receipt. Actual
  // accepted human input is independently consumed through GeoNativeInputs.
  const certify=async(row)=>{
    const kind=row.kind, canonical=await items.canonical(policy,kind,row.id,row.payload.recordType), versions=await items.versions(policy,kind,canonical);
    const lineageDigest=hash(versions.map(version=>({id:version.id,revision:version.revision,payload:version.payload,deletedAt:version.deletedAt??null})));
    const payload={recordType:'context-item-source-proof',...contextPolicyIdentity(policy),documentId:row.id,documentRevision:row.revision,runId:run.id,
      contentDigest:row.payload.contentDigest,lineageDigest,complete:true,inputReceiptRefs:receiptIds,launchedContextRef:'launch-fixture',launchedContextDigest:'1'.repeat(64)};
    const id=`proof-${row.id}`;receipts.set(row.id,id);const old=await f.documents.get('owner','geo-plan-context',id);
    await f.documents.put('owner','geo-plan-context',id,payload,{projectId:run.projectId,expectedRevision:old?.revision??0});
  };
  const method=async(id,extra={})=>{
    const payload={recordType:'learned-method',status:'approved',frontmatter:{...frontmatter,name:id},body:BODY,dependencies:[],
      provenance:{runId:run.id,sourceProjectId:run.projectId,sourceProjectIds:[run.projectId],capabilityId:'geo-content'},...extra};
    payload.contentDigest=methodContentDigest(payload,sha256);
    const row=await f.documents.put('owner','method',id,payload,{expectedRevision:0});await certify(row);return row;
  };
  const capsules=new CapsuleService(f.documents,{indexing:{recall:()=>assert.fail('Whole capsule semantic nomination is forbidden')}});
  const capsule=await capsules.ownCapsule('owner',{create:true});
  const fact=async(id,extra={},projectId=run.projectId)=>{
    const payload={capsuleId:capsule.id,projectId,origin:'explicit',factKind:'method_preference',layer:'methods',status:'approved',content:'Check every source denominator.',
      provenance:[{type:'run',id:run.id,projectId:run.projectId}],...extra};
    payload.contentDigest=contextFactContentDigest(payload);
    const row=await f.documents.put('owner','fact',id,payload,{projectId,expectedRevision:0});if(projectId===run.projectId && payload.projectId===run.projectId)await certify(row);return row;
  };
  return {...f,items,run,certify,method,capsules,capsule,fact};
}

test('actual-PG capsule shortlist searches only proved ids before body reads; ordinary account stays broad',options,async t=>{
  const f=await fixture(t), good=await f.fact('allowed'), unproved=await f.fact('unproved'), foreign=await f.fact('foreign',{},'other');
  await f.documents.remove('owner','geo-plan-context',`proof-${unproved.id}`,1);
  await f.fact('global',{},null);
  // A received pack as an import leaves it (main's `makePack`: `CapsuleService.create` left the service), then put in force as a guest.
  const pack=await makePack(f.capsules,'owner',{title:'Received pack',share:{authorId:'external',snapshotHash:'snapshot'}});
  await f.capsules.activate('owner',pack.id);
  await f.fact('imported-global',{capsuleId:pack.id,origin:'imported',provenance:[{type:'import',id:'external'}]},null);
  await f.fact('contradictory',{projectId:'other'});
  const originalGet=f.documents.get.bind(f.documents), originalSearch=f.documents.search.bind(f.documents);
  f.documents.get=async(user,kind,id,options)=>{if(kind==='fact' && id!==good.id) assert.fail(`Private hydration: ${id}`);return originalGet(user,kind,id,options);};
  f.documents.search=async(user,kind,query,input)=>{assert.equal(input.projectId,f.project.id);assert.deepEqual(input.ids,[good.id]);assert.deepEqual(input.expectedRevisions,[{id:good.id,revision:good.revision}]);return originalSearch(user,kind,query,input);};
  const result=await f.capsules.recall('owner',{query:'denominator',projectId:f.project.id,projectOnly:true,authorizeEntry:(activation,entry)=>f.items.capsule(f.policy,activation,entry)});
  assert.deepEqual(result.items.map(item=>item.id),[good.id]);
  assert.deepEqual(await originalSearch('owner','fact','denominator',{projectId:f.project.id,ids:[]}),[]);
  assert.deepEqual(await originalSearch('owner','fact','denominator',{projectId:f.project.id,expectedRevisions:[]}),[]);
  assert.equal(await originalGet('owner','fact',good.id,{expectedRevision:good.revision+1}),null);
  assert.equal((await originalGet('owner','fact',good.id,{expectedRevision:good.revision})).id,good.id);
  assert.deepEqual((await originalSearch('owner','fact','denominator',{projectId:f.project.id,ids:[foreign.id,good.id]})).map(item=>item.id),[good.id]);
  const selected=await selectCapsuleMethods(f.capsules,{userId:'owner',projectId:f.project.id,contextPolicy:f.policy,contextItems:f.items});
  assert.deepEqual(selected.map(item=>item.id),[good.id]);
  f.documents.get=originalGet;f.documents.search=originalSearch;f.capsules.indexing=null;
  const ordinary=await f.capsules.recall('owner',{query:'denominator',projectId:f.project.id});
  assert.ok(ordinary.items.some(item=>item.id==='global'));
  assert.ok(ordinary.items.some(item=>item.id==='unproved'));
  assert.ok(ordinary.items.some(item=>item.id==='imported-global'));
  await f.capsules.disable('owner',f.capsule.id);
  assert.equal((await f.capsules.recall('owner',{query:'denominator',projectId:f.project.id,projectOnly:true,authorizeEntry:(a,e)=>f.items.capsule(f.policy,a,e)})).items.length,0);
});

test('full historical lineage and server body digest beat project tags, source run and forged payload flags',options,async t=>{
  const f=await fixture(t), good=await f.method('same-project');
  assert.equal(await f.items.method(f.policy,good),true);
  const forged={...good,payload:{...good.payload,body:'A changed private body'}};
  assert.equal(await f.items.method(f.policy,forged),false);
  const mixed=await f.method('mixed',{provenance:{sourceProjectId:f.project.id,sourceProjectIds:[f.project.id,'other'],runId:f.run.id,complete:true,approved:true}});
  assert.equal(await f.items.method(f.policy,mixed),false);
  const old=await f.method('historical',{provenance:{sourceProjectId:'other',runId:f.run.id}});
  const revised=await f.documents.put('owner','method',old.id,good.payload,{expectedRevision:old.revision});await f.certify(revised);
  assert.equal(await f.items.method(f.policy,revised),false);
  const metadata=(await f.documents.list('owner','method',{filter:{recordType:'learned-method'},fields:CONTEXT_ITEM_FIELDS})).items;
  assert.equal(metadata.find(item=>item.id===good.id).payload.body,undefined);
  assert.ok((await f.documents.history('owner','method',revised.id,{fields:CONTEXT_ITEM_FIELDS})).every(version=>!('body' in version.payload)));
});

test('paginated learned selection authorizes before similarity, excludes dependency/keep leaks and writes attachments',options,async t=>{
  const f=await fixture(t), allowed=[];
  for(let i=0;i<101;i++)allowed.push(await f.method(`method-${String(i).padStart(3,'0')}`,i===100?{files:{'scripts/check.py':'print("ok")'}}:{}));
  const dependent=await f.method('missing-dependency',{dependencies:[{name:'foreign',digest:'sha256:'+'a'.repeat(64)}]});
  await f.method('foreign',{provenance:{runId:f.run.id,sourceProjectId:'other'}});
  const learning=new LearningService({documents:f.documents});
  const original=learning.getMethod.bind(learning), hydrated=[];
  learning.getMethod=async(user,id,input)=>{assert.notEqual(id,'foreign');assert.notEqual(id,dependent.id);hydrated.push(id);return original(user,id,input);};
  const result=await selectLearnedMethods(learning,{userId:'owner',projectId:f.project.id,contextPolicy:f.policy,contextItems:f.items,maxCount:110,maxBytes:1000000,query:'denominator',
    keep:[learnedMethodDirectoryName('foreign')],similarity:{nearest:async(_query,rows)=>{assert.equal(rows.length,101);return Object.assign(rows.map(method=>({method,score:1})),{mode:'lexical'});}}});
  assert.equal(hydrated.length,101);assert.equal(result.length,101);assert.equal(result.kept.length,0);
  const directory=path.join(f.project.workspaceDir,'selected-methods');
  const foreignDirectory=path.join(directory,learnedMethodDirectoryName('foreign'));
  await fs.mkdir(foreignDirectory,{recursive:true});await fs.writeFile(path.join(foreignDirectory,'SKILL.md'),'Prior personal body');
  await materializeCapsuleMethods({capsules:null,learning,project:f.project,directory,contextPolicy:f.policy,contextItems:f.items,query:'denominator',maxPromptBytes:1000000,keep:[learnedMethodDirectoryName('foreign')],
    similarity:{nearest:async(_query,rows)=>Object.assign(rows.filter(row=>row.id==='method-100').map(method=>({method,score:1})),{mode:'lexical'})}});
  assert.equal(await fs.readFile(path.join(directory,learnedMethodDirectoryName('method-100'),'scripts/check.py'),'utf8'),'print("ok")');
  await assert.rejects(fs.access(foreignDirectory),{code:'ENOENT'});
});

test('capsule revocation and canonical changes between metadata/search/return discard the earlier text',options,async t=>{
  const f=await fixture(t), good=await f.fact('raced');
  const search=f.documents.search.bind(f.documents);
  f.documents.search=async(...args)=>{const result=await search(...args);await f.capsules.disable('owner',f.capsule.id);return result;};
  const recall=()=>f.capsules.recall('owner',{query:'denominator',projectId:f.project.id,projectOnly:true,authorizeEntry:(a,e)=>f.items.capsule(f.policy,a,e)});
  assert.deepEqual((await recall()).items,[]);
  await f.capsules.activate('owner',f.capsule.id);
  f.documents.search=async(...args)=>{const result=await search(...args);await f.documents.put('owner','fact',good.id,{...good.payload,content:'Changed after nomination'},{expectedRevision:good.revision});return result;};
  assert.deepEqual((await recall()).items,[]);
});


test('exact authorized dependencies are admitted and source changes during ranking omit the dependent body',options,async t=>{
  const f=await fixture(t),dependency=await f.method('dependency');
  const dependent=await f.method('dependent',{dependencies:[{name:'dependency',digest:dependency.payload.contentDigest}]});
  const learning=new LearningService({documents:f.documents});
  const scope={userId:'owner',projectId:f.project.id,contextPolicy:f.policy,contextItems:f.items,maxCount:10,maxBytes:100000};
  assert.deepEqual(new Set((await selectLearnedMethods(learning,scope)).map(item=>item.id)),new Set(['dependency','dependent']));
  const result=await selectLearnedMethods(learning,{...scope,query:'denominator',similarity:{nearest:async(_query,rows)=>{
    await f.documents.put('owner','method',dependency.id,{...dependency.payload,status:'retired'},{expectedRevision:dependency.revision});
    return Object.assign(rows.map(method=>({method,score:1})),{mode:'lexical'});
  }}});
  assert.equal(result.length,0);assert.equal(await f.items.method(f.policy,dependent),false);
});

for(const pathKind of ['capsule-search','capsule-mount','learned-mount'])test(`shared ${pathKind} never hydrates a replacement revision after metadata authorization`,options,async t=>{
  const f=await fixture(t);
  const target=pathKind==='learned-mount'?await f.method('race-method'):await f.fact('race-fact');
  let changed=false;const hydrated=[];
  const replace=async()=>{
    if(changed)return;changed=true;
    const payload=target.kind==='fact'?{...target.payload,content:'denominator foreign replacement',provenance:[{type:'run',id:'foreign-run',projectId:'other'}]}:
      {...target.payload,body:'Foreign replacement body',provenance:{sourceProjectId:'other',runId:'foreign-run'}};
    await f.documents.put('owner',target.kind,target.id,payload,{expectedRevision:target.revision});
  };
  const get=f.documents.get.bind(f.documents),search=f.documents.search.bind(f.documents);
  f.documents.get=async(user,kind,id,input)=>{
    if(pathKind!=='capsule-search'&&kind===target.kind&&id===target.id){await replace();const row=await get(user,kind,id,input);if(row)hydrated.push(row);return row;}
    return get(user,kind,id,input);
  };
  f.documents.search=async(...args)=>{if(pathKind==='capsule-search'){await replace();const found=await search(...args);hydrated.push(...found);return found;}return search(...args);};
  if(pathKind==='capsule-search')assert.deepEqual((await f.capsules.recall('owner',{query:'denominator',projectId:f.project.id,projectOnly:true,authorizeEntry:(a,e)=>f.items.capsule(f.policy,a,e)})).items,[]);
  if(pathKind==='capsule-mount')assert.deepEqual(await selectCapsuleMethods(f.capsules,{userId:'owner',projectId:f.project.id,contextPolicy:f.policy,contextItems:f.items}),[]);
  if(pathKind==='learned-mount')assert.equal((await selectLearnedMethods(new LearningService({documents:f.documents}),{userId:'owner',projectId:f.project.id,contextPolicy:f.policy,contextItems:f.items,maxCount:10,maxBytes:100000})).length,0);
  assert.equal(changed,true,'Race occurred immediately before full SQL hydration');
  assert.deepEqual(hydrated,[],'No replacement body was returned by the underlying SQL read');
});

test('a cached ancestor cannot authorize a transitive method retired during the same PostgreSQL traversal',options,async t=>{
 const f=await fixture(t),leaf=await f.method('closure-leaf');
 const common=await f.method('closure-common',{dependencies:[{name:leaf.id,digest:leaf.payload.contentDigest}]});
 const a=await f.method('closure-a',{dependencies:[{name:common.id,digest:common.payload.contentDigest}]});
 const b=await f.method('closure-b',{dependencies:[{name:common.id,digest:common.payload.contentDigest}]});
 const root=await f.method('closure-root',{dependencies:[{name:a.id,digest:a.payload.contentDigest},{name:b.id,digest:b.payload.contentDigest}]});
 const verify=f.items.verifyAcceptedContext;let retired=false;
 f.items.verifyAcceptedContext=async input=>{
  if(input.document.id===b.id&&!retired){retired=true;await f.documents.put('owner','method',leaf.id,{...leaf.payload,status:'retired'},{expectedRevision:leaf.revision});}
  return verify(input);
 };
 assert.equal(await f.items.method(f.policy,root),false,'The whole memoized closure must still match at completion');assert.equal(retired,true);
});

test('closure comparison checks exact metadata even when an adversarial direct write retains the revision',options,async t=>{
 const f=await fixture(t),row=await f.method('metadata-snapshot');
 const snapshot=await f.items.canonical(f.policy,'method',row.id,'learned-method');
 assert.equal(await f.documents.matchesSnapshots('owner',[snapshot],{fields:CONTEXT_ITEM_FIELDS}),true);
 await f.db.query("UPDATE evimed_product.documents SET payload=jsonb_set(payload,'{provenance,sourceProjectIds}',$3::jsonb) WHERE user_id=$1 AND kind='method' AND id=$2",['owner',row.id,JSON.stringify([f.project.id,'other'])]);
 const changed=await f.documents.get('owner','method',row.id);
 assert.equal(changed.revision,row.revision);
 assert.equal(await f.documents.matchesSnapshots('owner',[snapshot],{fields:CONTEXT_ITEM_FIELDS}),false);
 assert.equal(await f.documents.matchesSnapshots('editor',[snapshot],{fields:CONTEXT_ITEM_FIELDS}),false);
});
