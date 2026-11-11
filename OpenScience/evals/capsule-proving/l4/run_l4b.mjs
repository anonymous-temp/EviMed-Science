#!/usr/bin/env node
/** P34: sequential product sleeps on the exact frozen L4 seed stores.
 * No sealed data; no replacements for the product's grouping, decision or writes.
 * Costs include every repair attempt; stop before CNY 150 at conservative peak rates.
 * node .../run_l4b.mjs --size 50 --arm off|on [--passes 20] [--calls 12]
 */
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { ProductDocuments } from '../../../apps/server/src/productStore.mjs';
import { ControlPlaneDatabase } from '../../../apps/server/src/controlPlaneDatabase.mjs';
import { MethodConsolidation } from '../../../apps/server/src/methodConsolidation.mjs';
import { OfflineLoop, OFFLINE_USER } from '../learn/offlineLoop.mjs';
import { createDeepSeekClient, firstLine } from '../run/deepseek.mjs';
import { diskEmbedder, scoreDecisions, claimsOf, pairKey } from './run_l4.mjs';

const load = file => readFile(file, 'utf8').then(JSON.parse);
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 1));
const args = Object.fromEntries(Array.from({ length: (process.argv.length-2)/2 }, (_,i) => [process.argv[2+i*2].slice(2), process.argv[3+i*2]]));
const size = Number(args.size), arm = args.arm, passes = Number(args.passes ?? 20), limit = Number(args.calls ?? 12);
if (![50,200,600].includes(size) || !['on','off'].includes(arm) || passes !== 20) throw new Error('Invalid L4b arguments');
const root = '/srv/evimed/runs', runId = `l4b-${size}-${arm}-${arm==='on'?7:6}`, dir = path.join(root, runId);
const costOf = usage => ((usage.promptTokens-usage.cachedTokens)*2 + usage.cachedTokens*.04 + usage.completionTokens*8)/1e6;

async function main() {
  await mkdir(dir, {recursive:true});
  const status = value => appendFile(path.join(dir,'STATUS'), `${new Date().toISOString()} ${JSON.stringify(value)}\n`);
  const stateFile = path.join(dir,'library.json');
  try { await readFile(stateFile); } catch(error) { if(error.code !== 'ENOENT')throw error; await save(stateFile, await load(path.join(root,`l4-${size}-1/seed/library.json`))); }
  const seed = await load(stateFile), mapping = await load(path.join(root,`l4-${size}-1/mapping.json`));
  const gold = (await load(`/srv/evimed/data/memdata-data/l4/gold-${size}.json`)).pairs;
  const embedder = await diskEmbedder({root,embedKey:'/srv/evimed/secrets/dashscope.api-key'});
  const client = createDeepSeekClient({keyFile:'/srv/evimed/secrets/deepseek.api-key', model:'deepseek-flash', thinking:'disabled', timeoutMs:600000});
  const spendFile = path.join(root, 'l4b-p34-spend.jsonl');
  const model = {...client, complete: async request => {
    const costs = await readFile(spendFile,'utf8').catch(error => {if(error.code==='ENOENT')return '';throw error;});
    const spent = costs.trim().split('\n').filter(Boolean).reduce((n,line)=>n+JSON.parse(line).costCny,0);
    const balance = await readFile(path.join(root,'BUDGET-LAST'),'utf8');
    if (spent > 140 || Number(balance.match(/balance\s+(\d+(?:\.\d+)?)/)?.[1] ?? 0) < 150) throw new Error('L4b budget guard');
    const result = await client.complete(request);
    await appendFile(spendFile,JSON.stringify({at:new Date().toISOString(),runId,costCny:costOf(result.usage),usage:result.usage})+'\n');
    return result;
  }};
  const loop = await OfflineLoop.open({dir,env:seed.env,policy:seed.policy,model,cacheDir:path.join(dir,'cache'),embed:embedder.embed,embedModel:embedder.model});
  // Real lane-only PostgreSQL persistence and authority; the external step
  // transport stays the existing L4 direct-model adapter. No production data.
  const dbUrl=new URL((await readFile('/srv/evimed/ovlab/database.url','utf8')).trim());
  dbUrl.pathname=`/evimed_test_p34_l4b_${size}_${arm}`;
  const database=new ControlPlaneDatabase({databaseUrl:dbUrl.href,databasePoolMax:2,databaseConnectionTimeoutMs:5000});
  const owner=`p34-${runId}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'L4b lab','development') ON CONFLICT DO NOTHING",[owner]);
  const real=new ProductDocuments(database), mirrored=new Map();
  const remember=row=>{if(row)mirrored.set(JSON.stringify([OFFLINE_USER,row.kind,row.id]),{...row,userId:OFFLINE_USER});return row;};
  for(const row of seed.documents.rows)if(row.kind==='method') {
    const prior=await real.get(owner,row.kind,row.id);
    remember(prior??await real.put(owner,row.kind,row.id,row.payload,{expectedRevision:0}));
  }
  for(const kind of ['method','method-consolidation']) {
    let cursor=null;do{const page=await real.list(owner,kind,{limit:100,cursor});page.items.forEach(remember);cursor=page.nextCursor;}while(cursor);
  }
  const documents=new Proxy(real,{get(target,key){
    if(key==='rows')return mirrored;
    if(key==='snapshot')return()=>({rows:[...mirrored.values()],revisions:[],clock:seed.documents.clock});
    if(['get','put','list','history','remove','restore','search'].includes(key))return async(_user,...rest)=>{
      const result=await target[key](owner,...rest);if(key==='put'||key==='get')remember(result);return result;
    };
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  loop.documents=documents;loop.learning.documents=documents;
  const requests = new Map(), outputs = [], stepUsage = new Map();
  loop.consolidation = new MethodConsolidation({ learning:loop.learning,
    dispatch: async request => {requests.set(request.dispatchId,request); const before=loop.steps.usage.calls; const identity=await loop.steps.dispatch(request); stepUsage.set(request.dispatchId,loop.steps.usage.calls-before); return identity;},
    readResult: async identity => {const answer={...await loop.steps.readResult(identity),usage:{calls:stepUsage.get(identity.dispatchId)??0}};outputs.push({action:requests.get(identity.dispatchId)?.input.action,answer});return answer;},
    similarity:loop.similarity,queueEnabled:arm==='on',recallEnabled:arm==='on',modelCalls:limit,
    now:()=>new Date(loop.state.clock),wait:async()=>{} });
  if(loop.consolidation.pairQueue)loop.consolidation.pairQueue.now=()=>new Date();
  let lock = {heldMs:0,waitMs:0,acquisitions:0};
  loop.documents.observeLearnedLibraryLock = timing => {lock.heldMs+=timing.heldMs;lock.waitMs+=timing.waitMs;lock.acquisitions++;};
  const checkpoint = path.join(dir,'report.json');
  let report;
  try {report=await load(checkpoint);} catch(error) {if(error.code!=='ENOENT')throw error;report={runId,size,arm,model:client.model,thinking:client.thinking,modelCallBudget:limit,budgetSemantics:'Admit model steps while under the call allowance; charge actual transport calls including repairs after each step. An already admitted bounded step may finish over the allowance. Cached reads cost zero.',passes:[],
    scope:'Product LearningService, MethodConsolidation, ProductDocuments and PostgreSQL learned-library authority on isolated evimed_test_p34_l4b databases; direct model-step transport, no DSH. Retirement cap unchanged.',
    originalLibrary:`l4-${size}-1/seed/library.json`,sourceDigests:Object.fromEntries(await Promise.all([
      '../../../apps/server/src/methodConsolidation.mjs','../../../apps/server/src/methodConsolidationQueue.mjs',
      '../../../apps/server/src/methodSimilarity.mjs','../../../apps/server/src/learnedLibraryAuthority.mjs','./run_l4b.mjs',
    ].map(async file=>[file,createHash('sha256').update(await readFile(new URL(file,import.meta.url))).digest('hex')]))),predictions:[]};}
  for(let pass=report.passes.length+1;pass<=passes;pass++) {
    lock={heldMs:0,waitMs:0,acquisitions:0}; outputs.length=0;
    const started=performance.now(), embeddingTokensBefore=embedder.counters.tokens??0;
    const callCountBefore=(await readFile(spendFile,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.runId===runId).length;
    const spendBefore=(await readFile(spendFile,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.runId===runId).reduce((n,row)=>n+row.costCny,0);
    const result=await loop.consolidation.sleep({job:{id:`${runId}-pass-${pass}`,userId:owner,projectId:loop.project.id,payload:{action:'sleep'}}});
    const assignments=outputs.filter(row=>row.action==='decide').flatMap(row=>row.answer.output?.assignments??[]);
    report.predictions.push(...claimsOf(assignments,mapping));
    const scored=scoreDecisions(gold,report.predictions);
    const stored=[];
    const reverse=new Map(Object.entries(mapping).map(([a,b])=>[b,a]));
    const rows=[...loop.documents.rows.values()].filter(row=>row.kind==='method');
    for(const row of rows)for(const relation of row.payload.learning?.relations??[]) {
      const a=reverse.get(row.id),b=reverse.get(relation.target);if(!a||!b)continue;
      stored.push({a,b,type:relation.type,...(relation.type==='subset'?{wider:b}:{})});
    }
    const harms=rows.flatMap(row=>(row.payload.provenance?.pendingRetirements??[]).flatMap(a=>(row.payload.provenance?.pendingRetirements??[]).filter(b=>a.methodId<b.methodId).map(b=>({a:reverse.get(a.methodId),b:reverse.get(b.methodId)}))))
      .filter(pair=>pair.a&&pair.b&&gold.some(g=>g.relation!=='duplicate'&&pairKey(g.a,g.b)===pairKey(pair.a,pair.b)));
    const spendRows=(await readFile(spendFile,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.runId===runId);
    const costCny=spendRows.reduce((n,row)=>n+row.costCny,0)-spendBefore;
    const passCalls=spendRows.length-callCountBefore;
    const embeddingTokens=(embedder.counters.tokens??0)-embeddingTokensBefore;
    const metric={pass,embeddingTokens,embeddingCostCnyUpper:embeddingTokens*.000525/1000,wallMs:performance.now()-started,modelCalls:passCalls,modelSteps:result.coverage?.modelCalls??null,costCnyPeakUpper:costCny,
      lock:{...lock,kind:'PostgreSQL learned-library authority; excludes model time'},recall:Object.fromEntries(Object.entries(scored.byKind).map(([kind,row])=>[kind,row.recall])),
      recordedRecall:Object.fromEntries(Object.entries(scoreDecisions(gold,stored).byKind).map(([kind,row])=>[kind,row.recall])),
      harmfulCanonicalMerges:harms.length,retired:rows.filter(row=>row.payload.status==='retired').length,result};
    report.passes.push(metric);
    loop.state.clock+=3600000;
    await save(stateFile,{...loop.state,documents:loop.documents.snapshot()});
    await save(checkpoint,report);await status(metric);
    process.stdout.write(JSON.stringify({runId,pass,recall:metric.recordedRecall,modelCalls:metric.modelCalls,costCny,backlog:result.coverage?.backlog,harmfulCanonicalMerges:harms.length})+'\n');
    if(harms.length)throw new Error('L4b harmful planted merge: preserved the failing pass and stopped this arm.');
  }
  await status({phase:'complete'});
  await database.close();
}
main().catch(error=>{process.stderr.write(firstLine(error)+'\n');process.exitCode=1;});
