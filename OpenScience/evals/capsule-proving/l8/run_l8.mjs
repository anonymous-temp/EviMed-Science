#!/usr/bin/env node
/** L8 development-only runner. Outputs and data stay on the lab, outside the checkout. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createDeepSeekClient, firstLine } from '../run/deepseek.mjs';
import { openStatus } from '../run/status.mjs';
import { directoryDigest } from '../run/run.mjs';
import { answerTask } from './answer_l8.mjs';
import { summarize, scoreCalls } from './score_l8.mjs';

export const BOTH = {memorySearchHintEnabled:true,memoryOpeningIndexEnabled:true};
const ARMS = ['no-memory','memory','memory+method'];
const json = async file => JSON.parse(await readFile(file,'utf8'));
async function maybeJSON(file) { try { return await json(file); } catch(e) { if (e.code === 'ENOENT') return null; throw e; } }
async function atomic(file,value) { await writeFile(file+'.tmp',JSON.stringify(value,null,2)+'\n'); await rename(file+'.tmp',file); }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Dataset wording uses content, whereas the lab contract uses text and dated session ids. */
export function labSessions(input) {
  return (input.sessions ?? []).map((s,i) => ({...s,sessionId:s.sessionId ?? `s${String(i+1).padStart(3,'0')}`,at:s.at ?? new Date(Date.UTC(2026,9,1+i)).toISOString(),project:s.project ?? null,
    messages:s.messages.map(m => ({...m,text:m.text ?? m.content ?? ''}))}));
}
export async function retryOpen(open, options, sleep = delay) {
  for (let attempt=0;;attempt++) {
    try { return await open(options); }
    catch(e) { if (attempt >= 4 || !(e.code === '40P01' || /40P01|deadlock detected/.test(e.message))) throw e; await sleep(500*(attempt+1)); }
  }
}
export function parseArgs(args) {
  const o = {data:'/srv/evimed/data/memdata-data/l8-dev',out:'/srv/evimed/runs/l8-dev-1',concurrency:4,engineUrls:['http://127.0.0.1:19330'],arms:ARMS,only:[],limit:0,
    engineKeyFile:'/srv/evimed/ovlab/root.key',databaseUrlFile:'/srv/evimed/ovlab/database.url',deepseekKeyFile:'/srv/evimed/secrets/deepseek.api-key',pluginTgz:'/srv/evimed/cache/dsh-memory-plugin-0.5.31.tgz',ledger:'/srv/evimed/results/ledger.jsonl'};
  const flags = {'--data':'data','--out':'out','--concurrency':'concurrency','--engine-url':'engineUrls','--only':'only','--arms':'arms','--limit':'limit','--engine-key-file':'engineKeyFile','--database-url-file':'databaseUrlFile','--deepseek-key-file':'deepseekKeyFile','--plugin-tgz':'pluginTgz','--ledger':'ledger'};
  for(let i=0;i<args.length;i++) {
    const key=flags[args[i]], value=args[++i];
    if (!key || !value) throw new Error('Unknown flag or missing value');
    o[key]=['engineUrls','only','arms'].includes(key) ? value.split(',').filter(Boolean) : ['concurrency','limit'].includes(key) ? Number(value) : value;
  }
  if (!Number.isInteger(o.concurrency) || o.concurrency<1 || o.concurrency>6) throw new Error('Concurrency must be 1..6');
  if (!Number.isInteger(o.limit) || o.limit<0) throw new Error('Limit must be nonnegative');
  if (!o.arms.length || o.arms.some(a => !ARMS.includes(a))) throw new Error('Invalid arms');
  if (!o.engineUrls.length) throw new Error('At least one engine URL is required');
  if (/sealed/i.test(o.data)) throw new Error('Only development data is permitted');
  o.out=resolve(o.out); o.data=resolve(o.data);
  return o;
}

/** dependencies permit offline fake lab/model tests; actual runs always use the product lab. */
export async function runL8(options, dependencies = {}) {
  const o = options, runId=basename(o.out);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error('Unsafe run id');
  const items = dependencies.items ?? await Promise.all((await readdir(join(o.data,'items'))).filter(n => n.endsWith('.json')).sort().map(n => json(join(o.data,'items',n))));
  let selected=items.filter(i => !o.only.length || o.only.includes(i.id));
  if (o.limit) selected=selected.slice(0,o.limit);
  if (!selected.length) throw new Error('No development items selected');
  if (selected.some(i => i.split !== 'dev')) throw new Error('Only development items allowed');
  if (new Set(selected.map(i=>i.id)).size !== selected.length) throw new Error('Duplicate item id');
  await mkdir(join(o.out,'records'),{recursive:true});
  const status=await openStatus(join(o.out,'STATUS'));
  const adapterDigest=hash(await Promise.all(['run_l8.mjs','answer_l8.mjs','score_l8.mjs'].map(async n=>[n,await readFile(new URL(n,import.meta.url),'utf8')])));
  const identity={schema:'l8-v3',adapterDigest,runId,dataDigest:hash(selected),arms:o.arms,engineUrls:o.engineUrls,variant:BOTH,model:{name:'deepseek-flash',thinking:'enabled',reasoningEffort:'high'}};
  const prior=await maybeJSON(join(o.out,'run.json'));
  if (prior && prior.identityDigest !== hash(identity)) throw new Error('Resume options/data changed; use another run directory');
  let commit='unknown';
  try { commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(); } catch { /* isolated tests */ }
  const meta=prior ?? {...identity,identityDigest:hash(identity),startedAt:new Date().toISOString(),automated:true,set:'l8',split:'dev',commit};
  await atomic(join(o.out,'run.json'),meta);
  const labs=[];
  const rows=[];
  const client=dependencies.client ?? createDeepSeekClient({keyFile:o.deepseekKeyFile,thinking:'enabled',reasoningEffort:'high'});
  const jobs=selected.flatMap(item => o.arms.map(arm => ({item,arm})));
  try {
    const open = dependencies.openLab ?? (await import('../run/lab.mjs')).openLab;
    for (const engineUrl of o.engineUrls) labs.push(await retryOpen(open,{engineUrl,engineKeyFile:o.engineKeyFile,databaseUrlFile:o.databaseUrlFile,deepseekKeyFile:o.deepseekKeyFile,
      runId,account:`evlab-${runId}`,historySearch:true,databasePoolMax:2,answerVariants:[{name:'both',config:BOTH}]}));
    const templates=await directoryDigest(fileURLToPath(new URL('../../../deploy/web/openviking/memory-templates/',import.meta.url)));
    meta.engine={version:labs[0].facts?.engineVersion ?? 'unknown',templatesDigest:templates.digest,
      shards:labs.map((l,i)=>({url:o.engineUrls[i],facts:l.facts}))};
    meta.adapterDigest=adapterDigest;
    await atomic(join(o.out,'run.json'),meta);
    let next=0;
    // Stable job -> shard binding survives concurrency changes and resumed jobs.
    async function worker() {
      while(next<jobs.length) {
        const index=next++, {item,arm}=jobs[index], lab=labs[index%labs.length];
        const variants=arm==='no-memory' ? [''] : ['','both'];
        const key=`${item.id}/${arm}`;
        const pathFor=v=>join(o.out,'records',`${item.id}.${arm}${v ? '.'+v : ''}.json`);
        if (variants.every(v=>status.isDone(`${key}/answer/${v||'base'}`))) { for(const v of variants) rows.push(await json(pathFor(v))); continue; }
        let ingest=[];
        try {
          const user=await lab.user(`${item.id}_${arm}_v3`);
          if (arm!=='no-memory') for (const session of labSessions(item.arms[arm].input)) {
            const step=`${key}/ingest/${session.sessionId}`, file=join(o.out,'records',`${item.id}.${arm}.ingest.${session.sessionId}.json`);
            if (status.isDone(step)) { lab.noteConversation?.(user,session); ingest.push(await json(file)); }
            else { const record=await lab.ingestSession(user,session); await atomic(file,record); ingest.push(record); await status.markDone(step); }
          }
          for (const variant of variants) {
            const step=`${key}/answer/${variant||'base'}`;
            if (status.isDone(step)) { rows.push(await json(pathFor(variant))); continue; }
            // Atomic record written before STATUS: a crash in that gap resumes without another model call.
            let row=await maybeJSON(pathFor(variant));
            if (!row || row.error) {
              const memory=arm==='no-memory' ? undefined : lab.memoryFor(user,{variant});
              row=await (dependencies.answerTask ?? answerTask)({item,arm,variant,memory,client,pluginTgz:o.pluginTgz});
              row.ingest=ingest.map(r=>({sessionId:r.sessionId,usage:r.usage,ms:r.ms,commit:r.commit}));
              await atomic(pathFor(variant),row);
            }
            rows.push(row);
            if (row.error) await status.markFailed(step,row.error); else await status.markDone(step,{pass:row.score.pass});
            dependencies.report?.(`${key}/${variant||'base'} ${row.error ? 'error' : row.score.pass ? 'pass' : 'fail'}`);
          }
        } catch(error) {
          const diagnostic=firstLine(error);
          await status.markFailed(key,diagnostic);
          for(const variant of variants) {
            const held=await maybeJSON(pathFor(variant));
            if (rows.some(r=>r.itemId===item.id && r.arm===arm && r.variant===variant)) continue;
            const row=held ?? {itemId:item.id,arm,variant,armLabel:arm+(variant ? ':'+variant : ''),level:item.level,length:item.length,source:item.source,graph:item.graph,toolCalls:[],error:diagnostic,score:scoreCalls(item.arms[arm].gold,[],diagnostic)};
            await atomic(pathFor(variant),row); rows.push(row);
          }
        }
      }
    }
    await Promise.all(Array.from({length:Math.min(o.concurrency,jobs.length)},()=>worker()));
  } finally { for(const lab of labs) await lab.close(); }
  rows.sort((a,b)=>a.itemId.localeCompare(b.itemId)||a.armLabel.localeCompare(b.armLabel));
  await writeFile(join(o.out,'rows.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const summary={runId,...summarize(rows),finishedAt:new Date().toISOString()};
  await atomic(join(o.out,'summary.json'),summary);
  for(const [arm,s] of Object.entries(summary.arms)) {
    // Extraction is charged once for each arm's base, not again for its read-only answer variant.
    const rs=rows.filter(r=>r.armLabel===arm), extraction=rs.filter(r=>!r.variant).flatMap(r=>r.ingest ?? []);
    const ledger={runId,commit:meta.commit,engine:{version:meta.engine.version,templatesDigest:meta.engine.templatesDigest},arm,flags:{variant:arm.endsWith(':both') ? BOTH : {},thinking:'enabled',reasoningEffort:'high',historySearch:true},set:'l8',split:'dev',metric:'accuracy',n:s.n,value:s.passRate,ci95:s.ci95,
      judged:{code:s.n-s.errors,judge:0,unknown:0,error:s.errors},tokens:{...s.tokens,extractionPrompt:extraction.reduce((n,r)=>n+(r.usage?.promptTokens||0),0),extractionCompletion:extraction.reduce((n,r)=>n+(r.usage?.completionTokens||0),0)},costCny:null,wallSeconds:s.seconds,scorer:'l8-v1',rawPath:o.out,notes:'Strict ordered scoreTrajectory; development only. Variants share per-arm ingested memory. Synthetic undated sessions stamped 2026-10-01 onward.'};
    const file=join(o.out,`ledger.${arm}.json`); await atomic(file,ledger);
    if (!dependencies.skipLedger) execFileSync('node',['evals/capsule-proving/run/ledger.mjs','add','--json',file,'--ledger',o.ledger],{stdio:'pipe',cwd:'/srv/evimed/repo/OpenScience'});
  }
  return summary;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { runL8(parseArgs(process.argv.slice(2)),{report:s=>console.log(s)}).then(s=>console.log(JSON.stringify(s))).catch(e=>{console.error(firstLine(e));process.exitCode=1;}); }
  catch(e) {console.error(firstLine(e));process.exitCode=1;}
}
