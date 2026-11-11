/** G13: stream corpus files; pack 20 unchanged statements per memory file; search via the product gateway. */
import {createReadStream} from 'node:fs';
import {appendFile,readFile,writeFile,mkdir} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openLab,firstLine} from '../run/lab.mjs';
const out='/srv/evimed/runs/gx-g13-1',data='/srv/evimed/data/memdata-data/scale',pack=20;
await mkdir(out,{recursive:true});
const start=Date.now(),manifest=JSON.parse(await readFile(`${data}/manifest.json`,'utf8'));
const summary={automated:true,engineUrl:'http://127.0.0.1:19345',engineContainer:'ovlab5',manifest,statementsPerFile:pack,
 writePath:'POST /api/v1/content/write mode=create wait=true; 20 original statement bullet lines per product notes file',
 writeDeviation:'NativeMemoryStore.remember extracts via a model per add. Corpus events/cases are disabled product types; every statement uses notes. Statement text and ids stay in the external load manifest. This measures packed files, not one vector per statement or extraction.',
 query:'200 deterministic sha256-ranked statements per size; unchanged prefix of ceil(60%) code points capped at 80.',sizes:[],costCny:null};
const lab=await openLab({engineUrl:summary.engineUrl,engineKeyFile:'/srv/evimed/ovlab/root.key',databaseUrlFile:'/srv/evimed/ovlab/database.url',account:'evlab-gx-g13-1',runId:'gx-g13-1',historySearch:true,rejectionJudge:false,databasePoolMax:2});
// Clean the bounded, interrupted single-statement pilot through the product's user deletion path.
try{const pilot=await lab.user('scale');await lab.eraseUser(pilot);}catch(e){summary.pilotCleanup=firstLine(e);}
const user=await lab.user('packed-scale'),{sessions,client}=lab.parts,root=sessions.memoryRoot(user.userId),memory=lab.memoryFor(user);
summary.user=user;
function stats(){try{return JSON.parse(execFileSync('docker',['stats','--no-stream','--format','{{json .}}','ovlab5'],{encoding:'utf8',timeout:10000}).trim());}catch{return null;}}
async function models(){try{return await client.request({path:'/api/v1/observer/models',userId:user.userId});}catch(e){return {error:firstLine(e)};}}
let loaded=0,loadMs=0,embeddingQueueProcessed=0,embeddingRequeues=0,errors=0;
const initialMemory=stats(),initialModels=await models();
async function save(){summary.wallSeconds=(Date.now()-start)/1000;await writeFile(`${out}/summary.json`,JSON.stringify(summary,null,2)+'\n');}
try{
for(const size of [1000,10000,100000]){
 if(size===100000&&loadMs/Math.max(1,loaded)*90000>3600000){summary.skipped100000={reason:'Observed writes project the additional 90,000 statements above one hour',estimatedAdditionalSeconds:loadMs/loaded*90000/1000,additionalFiles:4500};break;}
 const sample=[],hash=createHash('sha256'),stageStart=Date.now(),beforeErrors=errors,beforeQueue=embeddingQueueProcessed;
 let index=0,group=[];
 const lines=createInterface({input:createReadStream(`${data}/scale-${size}.jsonl`),crlfDelay:Infinity});
 for await(const line of lines){
  hash.update(line+'\n');if(!line.trim())continue;const item=JSON.parse(line);index++;
  const fileIndex=Math.floor((index-1)/pack),uri=`${root}/notes/scale-${String(fileIndex).padStart(6,'0')}.md`;
  const rank=createHash('sha256').update(`gx-g13-query-v1\0${item.id}`).digest('hex');sample.push({...item,rank,uri});sample.sort((a,b)=>a.rank.localeCompare(b.rank));if(sample.length>200)sample.pop();
  if(index<=loaded)continue;
  group.push(item);
  if(group.length<pack&&index<size)continue;
  const t0=Date.now();
  try{
   const response=await client.request({method:'POST',path:'/api/v1/content/write',userId:user.userId,timeoutMs:60000,body:{uri,content:group.map(i=>`- ${i.text}`).join('\n'),mode:'create',wait:true,telemetry:true}});
   embeddingQueueProcessed+=response.result?.queue_status?.Embedding?.processed??0;
   embeddingRequeues+=response.result?.queue_status?.Embedding?.requeue_count??0;
   await appendFile(`${out}/packed-load.jsonl`,JSON.stringify({index,ids:group.map(i=>i.id),uri,ms:Date.now()-t0,result:response.result,telemetry:response.telemetry})+'\n');
  }catch(e){errors++;await appendFile(`${out}/packed-errors.jsonl`,JSON.stringify({index,uri,error:firstLine(e)})+'\n');}
  loadMs+=Date.now()-t0;group=[];
  await appendFile(`${out}/STATUS`,`${new Date().toISOString()} DONE packed-load ${index}/${size}\n`);
 }
 if(hash.digest('hex')!==manifest.sha256[`scale-${size}.jsonl`])throw Error('corpus_hash_mismatch');
 const stageLoadSeconds=(Date.now()-stageStart)/1000;loaded=size;
 const afterLoadMemory=stats(),afterLoadModels=await models(),results=[];
 for(const item of sample){
  const chars=Array.from(item.text),query=chars.slice(0,Math.min(80,Math.max(1,Math.ceil(chars.length*.6)))).join(''),t0=performance.now();
  const answer=await memory.callTool('search',{query,limit:5}),ms=performance.now()-t0;
  let hits=[];try{hits=JSON.parse(answer.blocks[0]).memories??[];}catch{}
  const row={size,id:item.id,sourceUri:item.uri,query,ms,error:answer.isError,hit:hits.slice(0,5).some(h=>h.uri===item.uri),hits,blocks:answer.blocks};
  results.push(row);await appendFile(`${out}/queries-${size}.jsonl`,JSON.stringify(row)+'\n');
 }
 const times=results.map(r=>r.ms).sort((a,b)=>a-b),q=p=>times[Math.ceil(p*times.length)-1];
 summary.sizes.push({size,files:size/pack,n:results.length,hit5:results.filter(r=>r.hit).length,hitAt5:results.filter(r=>r.hit).length/results.length,errors:results.filter(r=>r.error).length,p50Ms:q(.5),p95Ms:q(.95),stageLoadSeconds,cumulativeLoadSeconds:loadMs/1000,loadErrors:errors-beforeErrors,embeddingQueueProcessed:embeddingQueueProcessed-beforeQueue,cumulativeEmbeddingQueueProcessed:embeddingQueueProcessed,embeddingRequeues,embeddingProviderCalls:null,costCny:null,initialMemory,afterLoadMemory,afterQueriesMemory:stats(),initialModels,afterLoadModels,afterQueriesModels:await models()});
 await save();console.log(JSON.stringify(summary.sizes.at(-1)));
}
summary.costLimit='Engine request telemetry returns duration only; queue Embedding.processed counts engine jobs, not independently attested provider HTTP calls. Observer model counters are captured; shared-host deltas are not per-user billing.';
await save();
}catch(e){summary.error=firstLine(e);await save();throw e;}finally{await lab.close();}
