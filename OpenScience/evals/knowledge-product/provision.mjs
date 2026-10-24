// Disposable owned fixture setup through the product's authenticated public APIs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Api } from '../general-tasks/runner/cell.mjs';
import { verifyCorpus } from './run.mjs';
import { nativeScenarios,runNativeLifecycle,nativePrerequisites,lifecycleEligibility,assertRestoredIdentity } from './native_lifecycle.mjs';
import { freezeSeededMemory,fatalCollectionError } from './protocol.mjs';
import {contextMaterials,seedAuthoredMemory} from './personal_context.mjs';
import { SIZES,contextId } from './coverage.mjs';
import { verifyLiveBudgetWiring,verifyBoundCollector } from './shared_budget.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
export function safeCleanupIds(receipt) {
  if (!receipt.runId || receipt.created.some(o => o.runId !== receipt.runId)) throw new Error('Fixture ownership mismatch');
  return receipt.created.map(o => o.id);
}
export async function checked(api, method, route, body, statuses = [200,201]) {
  if(api.evalBudget)await verifyBoundCollector(api.base,api.evalBudget.scope,api.evalBudget.config);
  const r = await api.call(method, route, body);
  if (!statuses.includes(r.status)) throw new Error(`${method} ${route}: HTTP ${r.status} ${r.json?.code ?? ''}`);
  return r.json?.data;
}
export async function provision({base, dataDir, privateDir, benchmark, arm = 'candidate', seedCorpus = true, coverage = false, sharedBudget = null, runtimeMode='kernel',runtimeEvidence=null,databaseBindingsFile=null}) {
  await verifyCorpus(benchmark);
  if(sharedBudget)await verifyBoundCollector(base,arm,sharedBudget);
  await fs.mkdir(privateDir, {recursive:true,mode:0o700});
  const runId = `kbeval_${randomBytes(6).toString('hex')}`;
  const context = { runId, base, accounts:{}, created:[], receipt:{runId,created:[]}, privateDir,sharedBudget,arm,runtimeMode,runtimeEvidence,databaseBindingsFile };
  context.cleanup = async () => {
    safeCleanupIds(context.receipt);
    for (const a of Object.values(context.accounts)) { a.api.evalBudget=null; await checked(a.api,'DELETE','/api/account',{confirm:a.userId,password:a.password}); }
  };
  try {
  for (const logical of ['account-alpha','account-beta']) {
    const api = new Api(base);api.evalBudget=sharedBudget?{scope:arm,config:sharedBudget}:null; const password = randomBytes(20).toString('hex');
    const username = `${runId}_${logical.slice(-5)}`;
    const registration = await checked(api,'POST','/api/auth/register',{username,password,name:username});
    api.csrf = registration.csrfToken ?? registration.session?.csrfToken ?? '';
    const me = await checked(api,'GET','/api/me');
    api.csrf ||= me.csrfToken;
    const userId = me.user.id;
    const credentialsFile = path.join(privateDir,`${logical}.json`);
    await fs.writeFile(credentialsFile, JSON.stringify({cookie:api.cookie,csrf:api.csrf}),{mode:0o600});
    const account = {api,userId,password,credentialsFile,projects:{}};
    context.accounts[logical] = account;
    const owned = {id:userId,type:'account',runId}; context.created.push(owned); context.receipt.created.push(owned);
    for (const projectName of ['project-alpha','project-beta']) {
      const id = `${runId}_${logical.slice(-5)}_${projectName.slice(-5)}`;
      await checked(api,'POST','/api/projects',{id,name:id});
      account.projects[projectName] = {id,workspace:path.join(dataDir,'users',userId,'projects',id,'workspace'),sourceMap:{}};
    }
    api.project = account.projects['project-alpha'].id;
  }
  const owner = context.accounts['account-alpha'];
  if (coverage) await seedContexts({context,benchmark,dataDir,sharedBudget});
  if (seedCorpus && !coverage) for (const source of benchmark.sources) {
    const bytes = await fs.readFile(path.join(root,source.path));
    const originalOnly=source.originalOnly===true,relative=`${originalOnly?'originals':'knowledge-base'}/${source.id}${path.extname(source.path)}`;
    const data = await checked(owner.api,'POST','/api/files/upload',{root:originalOnly?'workspace':'base',path:relative,data:bytes.toString('base64'),encoding:'base64'});
    if(!originalOnly){if (!data.source?.id) throw new Error('Product upload did not register source');owner.projects['project-alpha'].sourceMap[source.id] = data.source.id;}
    (owner.projects['project-alpha'].originalFiles??={})[source.id]=relative;
  }
  const bindings = {base,accounts:Object.fromEntries(Object.entries(context.accounts).map(([key,a])=>[key,{userId:a.userId,credentialsFile:a.credentialsFile,projects:a.projects}]))};
  await fs.writeFile(path.join(privateDir,'bindings.json'),JSON.stringify({[arm]:bindings},null,2),{mode:0o600});
  await fs.writeFile(path.join(privateDir,'ownership.json'),JSON.stringify(context.receipt,null,2),{mode:0o600});
  context.bindings = bindings;
  return context;
  } catch (error) {
    try { await context.cleanup(); } catch (cleanupError) { throw new AggregateError([error,cleanupError], 'Provisioning and owned fixture cleanup failed'); }
    throw error;
  }
}
async function seedContexts({context,benchmark,dataDir,sharedBudget}) {
  // The live coordinator is checked before a source upload or memory commit can trigger paid background work.
  await verifyLiveBudgetWiring(sharedBudget);
  const primary=context.accounts['account-alpha'].projects['project-alpha'];primary.contexts={};
  const selected=benchmark.cases.filter(c=>c.stratum!=='lifecycle');
  const groups=[...new Set(selected.map(c=>contextId(c.evaluation)))];
  for(const key of groups){
    const cases=selected.filter(c=>contextId(c.evaluation)===key),evaluation=cases[0].evaluation;
    await verifyLiveBudgetWiring(sharedBudget);
    const api=new Api(context.base);api.evalBudget={scope:context.arm,config:sharedBudget};const password=randomBytes(20).toString('hex'),username=`${context.runId}_${key.replaceAll('-','_')}`;
    const registration=await checked(api,'POST','/api/auth/register',{username,password,name:username});api.csrf=registration.csrfToken??registration.session?.csrfToken??'';
    const me=await checked(api,'GET','/api/me');api.csrf||=me.csrfToken;
    const credentialsFile=path.join(context.privateDir,`${key}.json`);await fs.writeFile(credentialsFile,JSON.stringify({cookie:api.cookie,csrf:api.csrf}),{mode:0o600});
    const owner={api,userId:me.user.id,password,credentialsFile,projects:{}};
    context.accounts[`context-${key}`]=owner;const owned={id:owner.userId,type:'account',runId:context.runId};context.created.push(owned);context.receipt.created.push(owned);
    const id=`${context.runId}_${key}`;await checked(owner.api,'POST','/api/projects',{id,name:id});owner.api.project=id;
    if(evaluation.substrate==='knowledge')await checked(owner.api,'PUT','/api/memory/settings',{learningPaused:true,recallPaused:true});
    const {originals,seeds}=contextMaterials(benchmark,cases);
    const scope={id,userId:owner.userId,credentialsFile,workspace:path.join(dataDir,'users',owner.userId,'projects',id,'workspace'),sourceMap:{},originalFiles:{},originalTexts:{},evaluation,seededMemoryChunks:0,seededArchiveIds:[]};
    primary.contexts[key]=scope;owner.projects['project-alpha']=scope;
    if(evaluation.substrate!=='knowledge'){
      const settings=await checked(owner.api,'GET','/api/memory/settings');
      if(settings.engine!=='native')throw new Error(`Context ${key} requires an actual native-memory account; refusing legacy substitution`);
    }
    const target=SIZES[evaluation.size];if(originals.length>target)throw new Error('Source set exceeds frozen project-size target');
    const material=[...originals,...Array.from({length:target-originals.length},(_,i)=>({id:`distractor-${key}-${i}`,distractor:true,text:`Authored benchmark distractor ${i}. Warehouse inventory slot ${i} holds item ${i+1000}. No policy or clinical question is answered here.`}))];
    for(const source of material){
      await verifyLiveBudgetWiring(sharedBudget);
      const ext=source.distractor?'.txt':path.extname(source.path),bytes=source.distractor?Buffer.from(source.text):await fs.readFile(path.join(root,source.path));
      const relative=`${source.id}${ext}`;
      const knowledge=evaluation.substrate!=='memory'&&!source.originalOnly;
      const uploaded=await checked(owner.api,'POST','/api/files/upload',{root:knowledge?'base':'workspace',path:knowledge?`knowledge-base/${relative}`:`originals/${relative}`,data:bytes.toString('base64'),encoding:'base64'});
      if(!source.distractor)scope.originalTexts[source.id]=await fs.readFile(path.join(root,source.extractedTextPath??source.path),'utf8');
      scope.originalFiles[source.id]=knowledge?`knowledge-base/${relative}`:`originals/${relative}`;
      if(knowledge){if(!uploaded.source?.id)throw new Error('Source intake failed');scope.sourceMap[source.id]=uploaded.source.id;}
    }
    if(evaluation.substrate!=='knowledge'){
      const receipts=await seedAuthoredMemory((...args)=>checked(owner.api,...args),{projectId:id,seeds,beforeEach:()=>verifyLiveBudgetWiring(sharedBudget)});
      scope.seededArchiveIds.push(...receipts.map(receipt=>receipt.id));scope.seededMemoryChunks=receipts.length;
      scope.memoryFreeze=await freezeSeededMemory((...args)=>checked(owner.api,...args),{seedIds:scope.seededArchiveIds,requiredSeeds:seeds});
    }
    scope.documentCount=material.length;
    // Completion of intake/recall is checked again from genuine tool output by the report; seeding alone is never readiness proof.
  }
}
async function note(api, projectId, suffix, body='Revision one secret BENCH_CANARY_4c6a.') {
  return (await checked(api,'POST','/api/sources/notes',{projectId,title:`probe-${suffix}-${randomBytes(4).toString('hex')}`,body})).source;
}
async function probe(c, ctx) {
  if(nativeScenarios.includes(c.scenario))return runNativeLifecycle(c,ctx);
  const a = ctx.accounts['account-alpha'], b = ctx.accounts['account-beta'];
  const p = a.projects['project-alpha'].id, other = a.projects['project-beta'].id;
  a.api.project = p; b.api.project = b.projects['project-alpha'].id;
  const source = await note(a.api,p,c.scenario); const receipts=[];
  const request = async(api,method,url,body) => {
    if(ctx.sharedBudget)await verifyBoundCollector(ctx.base,ctx.arm,ctx.sharedBudget);
    const r = await api.call(method,url,body);
    receipts.push({method,url,status:r.status,body:r.json}); return r;
  };
  const assert = (ok,label) => {if(!ok)throw new Error(label);};
  const deny = r => assert([400,401,403,404,409,410].includes(r.status),'Unauthorized access was not denied');
  const absent = r => {assert(r.status===200,'Inventory unavailable'); assert(!JSON.stringify(r.json).includes(source.id),'Source leaked into inventory');};
  const remove = () => request(a.api,'DELETE',`/api/sources/${source.id}`,{expectedRevision:source.revision});
  const pathOf = `/api/sources/${source.id}`;
  let blocked = null;
  switch(c.scenario) {
    case 'cross-account': case 'source-link': deny(await request(b.api,'GET',pathOf)); break;
    case 'cross-project': case 'empty-project': absent(await request(a.api,'GET',`/api/sources?projectId=${other}`)); break;
    case 'deleted': await remove(); deny(await request(a.api,'GET',pathOf)); break;
    case 'superseded': case 'history': { const next = await request(a.api,'PUT',`${pathOf}/note`,{title:'Revision two',body:'Revision two current BENCH_CANARY_b27f.'}); assert(next.status===200,'Replacement failed'); assert(next.json.data.source.id!==source.id,'No new immutable revision'); deny(await request(a.api,'GET',pathOf)); break; }
    case 'other-search': absent(await request(b.api,'GET',`/api/sources?projectId=${b.api.project}&q=BENCH_CANARY_4c6a`)); break;
    case 'other-browse': deny(await request(b.api,'GET',`${pathOf}/note`)); break;
    case 'other-graph': deny(await request(b.api,'GET',`/api/knowledge-pages/graph?projectId=${p}`)); break;
    case 'other-wiki': deny(await request(b.api,'GET',`/api/knowledge-pages/tree?projectId=${p}`)); break;
    case 'spoof-user': deny(await request(b.api,'GET',`${pathOf}?userId=${a.userId}`)); break;
    case 'spoof-project': deny(await request(b.api,'GET',`/api/sources?projectId=${p}`)); break;
    case 'path': case 'encoded': { const traversal=c.scenario==='path'?'../secret.txt':'%2e%2e/secret.txt'; deny(await request(a.api,'GET',`/api/files/content?root=base&path=${encodeURIComponent(traversal)}`)); break; }
    case 'active': {const r=await request(a.api,'GET',`${pathOf}/note`);assert(r.status===200 && r.json.data.body.includes('BENCH_CANARY'),'Active note unavailable');break;}
    case 'share': case 'reattach': {assert([200,201].includes((await request(a.api,'POST','/api/library',{sourceId:source.id})).status),'Library add failed');if(c.scenario==='reattach'){assert((await request(a.api,'DELETE',`/api/library/${source.id}`)).status===200,'Library remove failed');assert([200,201].includes((await request(a.api,'POST','/api/library',{sourceId:source.id})).status),'Library reattach failed');} const r=await request(a.api,'GET','/api/library');assert(r.status===200&&JSON.stringify(r.json).includes(source.id),'Library item missing');break;}
    case 'revoked': case 'detach': case 'private': {await request(a.api,'POST','/api/library',{sourceId:source.id});assert((await request(a.api,'DELETE',`/api/library/${source.id}`)).status===200,'Library revoke failed');const r=await request(a.api,'GET','/api/library');assert(r.status===200&&!JSON.stringify(r.json).includes(source.id),'Revoked source remains in library');break;}
    case 'restore': {
      const original=await fetch(`${ctx.base}/api/files/download/${encodeURIComponent(source.payload.paths[0])}?root=base`,{headers:{Cookie:a.api.cookie,'x-open-science-project':p}});assert(original.status===200,'Original restoration bytes unavailable');const bytes=Buffer.from(await original.arrayBuffer());
      await remove();const restored=await checked(a.api,'POST','/api/files/upload',{root:'base',path:source.payload.logicalPath,data:bytes.toString('base64'),encoding:'base64'});
      assertRestoredIdentity(source,restored.source);receipts.push({operation:'exact-original-restoration',beforeId:source.id,afterId:restored.source.id,beforeGeneration:source.payload.generation,afterGeneration:restored.source.payload.generation,sha256:restored.source.payload.fingerprint.sha256});
      assert((await request(a.api,'GET',pathOf)).status===200,'Exact restored source unavailable');break;
    }
    case 'isolate-session': {const id=`${ctx.runId}_session`;await request(a.api,'PUT',`/api/research-sessions/${id}`,{mode:'open-domain'});const r=await request(b.api,'GET','/api/research-sessions');assert(r.status===200&&!JSON.stringify(r.json).includes(id),'Session leaked');break;}
    default: throw new Error(`No adapter for ${c.scenario}`);
  }
  return {caseId:c.id,status:blocked?'blocked':'pass',blocked,receipts,qualityRun:false};
}
export function lifecyclePlan(benchmark) { return benchmark.cases.filter(c=>c.stratum==='lifecycle').map(c=>({id:c.id,execute:ctx=>probe(c,ctx)})); }
export async function runLifecycle(benchmark,ctx) {
  const rows=[];let nativeRequirements;try{nativeRequirements=await nativePrerequisites(ctx);}catch(error){nativeRequirements={ready:false,requiredApis:[],reason:error.message};}
  for(const item of lifecyclePlan(benchmark))try{rows.push(await item.execute(ctx));}catch(e){if(fatalCollectionError(e))throw e;rows.push({caseId:item.id,status:'fail',error:e.message,details:e.details??null,qualityRun:false});}
  return {kind:'real-product-http-lifecycle-only',qualityEligible:lifecycleEligibility(rows,{runtimeMode:ctx.runtimeMode}),nativeRequirements,coverage:'Actual HTTP authorization plus required native engine/runtime, signed import, expiry and exact restoration probes',runId:ctx.runId,denominator:30,counts:Object.fromEntries(['pass','blocked','fail'].map(s=>[s,rows.filter(r=>r.status===s).length])),rows};
}
