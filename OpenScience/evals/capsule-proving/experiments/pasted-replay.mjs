// Read-only P30 replay: recorded engine diffs and archives, never re-ingestion or engine writes.
import { readFile, readdir, mkdir, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serialJsonlWriter, recordedIds } from './pasted-recording.mjs';
import { createHash } from 'node:crypto';
import { ControlPlaneDatabase } from '../../../apps/server/src/controlPlaneDatabase.mjs';
import { NativeMemoryWorker } from '../../../apps/server/src/nativeMemoryWorker.mjs';
import { createPastedInstructionJudge } from '../../../apps/server/src/nativeMemoryPastedInstructions.mjs';
import { INSTRUCTION_ORIGIN_POLICY_HASH } from '../../../apps/server/src/nativeMemoryInstructionOrigin.mjs';
import { callModelForControlPlane } from '../../../apps/server/src/modelGateway.mjs';
import { OpenVikingClient } from '../../../apps/server/src/openVikingClient.mjs';
import { OpenVikingSessions } from '../../../apps/server/src/openVikingSessions.mjs';
import { memoryLines, lineFingerprint, readNativeMemoryOriginalSources } from '../../../apps/server/src/nativeMemoryOverlay.mjs';
const base='/srv/evimed/runs', data='/srv/evimed/data/memdata-data';
const out=process.argv[2]; if(!out) throw Error('output directory required');
await mkdir(out,{recursive:true});
const appendRow=serialJsonlWriter(path.join(out,'rows.jsonl'));
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const database = new ControlPlaneDatabase({ databaseUrl: (await readFile('/srv/evimed/ovlab/database.url','utf8')).trim(), databasePoolMax: 1, databaseConnectionTimeoutMs: 10000 });
const key=(await readFile('/srv/evimed/ovlab/root.key','utf8')).trim();
const config={memoryPastedInstructionCheckEnabled:true,memoryPastedInstructionRobustEnabled:process.argv.includes('--robust'), deepseekProviderEnabled:true,deepseekApiKey:(await readFile('/srv/evimed/secrets/deepseek.api-key','utf8')).trim(),deepseekBaseUrl:'https://api.deepseek.com',deepseekModel:'deepseek-flash',memoryExtractionModel:'deepseek-flash',memoryExtractionTimeoutMs:60000};
const sourceHashes={};
for(const file of ['nativeMemoryWorker.mjs','nativeMemoryPastedInstructions.mjs','nativeMemoryInstructionOrigin.mjs','nativeMemoryVerification.mjs','nativeMemoryOverlay.mjs'])sourceHashes[file]=createHash('sha256').update(await readFile(new URL('../../../apps/server/src/'+file,import.meta.url))).digest('hex');
const completed=await recordedIds(path.join(out,'rows.jsonl'));
const jobs=[];
const caseAt=process.argv.indexOf('--only-case'), sessionAt=process.argv.indexOf('--only-session'), workersAt=process.argv.indexOf('--workers');
const workers=workersAt<0?4:Number(process.argv[workersAt+1]);if(!Number.isInteger(workers)||workers<1||workers>16)throw Error('replay_workers_invalid');
for(const name of (await readdir(base)).filter(n=>/^(r3-|r4-|p29-)/.test(n)).sort()){
 const run=await json(path.join(base,name,'run.json')).catch(()=>null); if(!run||run.split!=='dev')continue;
 const scores=(await readFile(path.join(base,name,'scores/rows.jsonl'),'utf8').catch(()=>'' )).split('\n').filter(Boolean).map(l=>JSON.parse(l));
 const planted=scores.filter(r=>r.kind==='store'&&r.category==='injection');
 for(const caseId of [...new Set(planted.map(r=>r.caseId))]){
  if(caseAt>=0&&caseId!==process.argv[caseAt+1])continue;
  const ingest=(await readFile(path.join(base,name,'cases',caseId,'ingest.jsonl'),'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l));
  let selected=ingest;
  let gold=null,schedule=null;
  if(run.set==='synthetic-users'){
   gold=await json(path.join(data,'dev',caseId,'gold.json'));schedule=await json(path.join(data,'dev',caseId,'schedule.json'));
   const ids=new Set(gold.store.filter(s=>s.category==='injection'||['preference_explicit','preference_repeated','correction'].includes(s.category)).map(s=>s.plantId));
   const ns=new Set(schedule.events.filter(e=>ids.has(e.plantId)).map(e=>e.session));
   selected=ingest.filter((r,i)=>ns.has(i+1));
  }
  const urls=run.engine.urls??[run.engine.url];const shard=createHash('sha256').update(caseId).digest().readUInt32BE(0)%urls.length;
  const sessions=new OpenVikingSessions(new OpenVikingClient({openVikingUrl:urls[shard],openVikingApiKey:key,openVikingAccount:run.engine.account,openVikingRequestTimeoutMs:30000}));
  const userId=`evlab_${name}_${caseId}`;
  const revisions=(await database.query('SELECT id,uri,actor,archive_uri,"before","after" FROM evimed_memory.native_revisions WHERE user_id=$1 ORDER BY id',[userId])).rows;
  const positions=new Map(ingest.map((r,i)=>[r.commit?.archiveUri,i]));
  function projection(record) {
    const target=positions.get(record.commit.archiveUri), files=new Map(),origins=new Map(),lastSource=new Map();
    for(const row of revisions){
      if(row.actor==='engine') lastSource.set(row.uri,row.archive_uri);
      const source=row.archive_uri??lastSource.get(row.uri),position=positions.get(source);
      if(position===undefined||position>=target)continue;
      const prior=files.get(row.uri)??'',next=row.after??'',held=origins.get(row.uri)??new Map();
      const previous=new Set(memoryLines(prior).map(lineFingerprint));
      const surviving=new Set(memoryLines(next).map(lineFingerprint));
      for(const print of held.keys())if(!surviving.has(print))held.delete(print);
      for(const text of memoryLines(next))if(!previous.has(lineFingerprint(text)))held.set(lineFingerprint(text),{archiveUri:source,projectId:ingest[position].project?.id??null});
      origins.set(row.uri,held);
      if(row.after===null)files.delete(row.uri);else files.set(row.uri,next);
    }
    return {files,origins};
  }
  for(const record of selected){
   if(sessionAt>=0&&record.sessionId!==process.argv[sessionAt+1])continue;
   const archiveUri=record.commit?.archiveUri;if(!archiveUri)continue;
   const diffRaw=await sessions.read(`evlab_${name}_${caseId}`,`${archiveUri}/memory_diff.json`);
   const raw=await sessions.read(`evlab_${name}_${caseId}`,`${archiveUri}/messages.jsonl`);
   if(!diffRaw||!raw){await appendFile(path.join(out,'unavailable.jsonl'),JSON.stringify({run:name,caseId,archiveUri,diff:!!diffRaw,messages:!!raw})+'\n');continue;}
   const diff=JSON.parse(diffRaw),ops=diff.operations??{},prior=projection(record);
   for(let rep=1;rep<=(process.argv.includes('--once')?1:5);rep++) jobs.push({id:`${name}/${caseId}/${record.sessionId}/${rep}`,run:name,caseId,rep,record,archiveUri,ops,raw,gold,sessions,prior});
  }
 }
}
await writeFile(path.join(out,'manifest.json'),JSON.stringify({at:new Date().toISOString(),robust:config.memoryPastedInstructionRobustEnabled,repetitions:process.argv.includes('--once')?1:5,projection:'Recorded engine before/after isolates changed-line checking; retained revision metadata provides predecessor-source evidence. No ingestion or mutations; not a reconstruction of the original worker schedule.',policyHash:config.memoryPastedInstructionRobustEnabled?INSTRUCTION_ORIGIN_POLICY_HASH:null,sourceHashes,workers,filter:{caseId:caseAt<0?null:process.argv[caseAt+1],sessionId:sessionAt<0?null:process.argv[sessionAt+1]},jobs:jobs.length,runs:[...new Set(jobs.map(j=>j.run))]},null,2));
let cursor=0;
await Promise.all(Array.from({length:workers},async()=>{for(;;){const job=jobs[cursor++];if(!job)return;if(completed.has(job.id))continue;
 const {id,run,caseId,rep,archiveUri,ops,raw,record,gold,sessions,prior}=job;let request=null;const answers=[],requests=[];
 const classifier=createPastedInstructionJudge({config,callModel:async(d,c)=>{request=JSON.parse(c.body.messages[1].content);const sequence=requests.length;requests.push(request);const r=await callModelForControlPlane(d,c);answers[sequence]=r?.choices?.[0]?.message?.content??'';return r;}});
 const limits=[];const judge={check:async input=>{const result=await classifier.check(input);limits.push(...(result.receipts??[]).map(r=>({inputChars:r.inputChars,limited:r.limited,attempts:r.attempts})));return result;}};
 const overlay={originsOf:async(_u,uris)=>new Map(uris.map(uri=>[uri,prior.origins.get(uri)??new Map()])),
  removalOrigins:(_u,uris)=>readNativeMemoryOriginalSources((sql,values)=>database.query(sql,values),_u,uris),instructionCheck:async()=>null,recordInstructionCheck:async()=>{},
  file:async(_u,uri)=>{const operation=[...(ops.adds??[]),...(ops.updates??[])].find(row=>row.uri===uri);return typeof operation?.before==='string'?{body:operation.before}:null;}};
 const worker=new NativeMemoryWorker({config,memorySettings:null,sessions,overlay,pastedInstructionJudge:judge});
 const userId=`evlab_${run}_${caseId}`;const sourceRoot=archiveUri.split('/sessions/')[0]; const archiveCache=new Map([[`${archiveUri}/messages.jsonl`,Promise.resolve(raw)]]);
 const context={sessions:{userRoot:()=>sourceRoot,memoryRoot:()=>sourceRoot+'/memories',read:async(_u,uri)=>{
   if(uri.endsWith('/messages.jsonl')){if(!archiveCache.has(uri))archiveCache.set(uri,sessions.read(userId,uri));return archiveCache.get(uri);}
   return [...(ops.adds??[]),...(ops.updates??[])].find(o=>o.uri===uri)?.after??null;
 }}};
 const reviewed=await worker.checkPastedInstructions({userId,archiveUri,projectId:record.project?.id??null},ops,context); const refused=[...reviewed];
 const row={id,run,caseId,rep,sessionId:record.sessionId,archiveUri,ledger:record.ledger,request,requests,answers,limits,refused,pending:[...(reviewed.pending??[])],
  realPreferenceRefusals:refused.filter(k=>gold?.store.some(s=>s.expectStored===true&&['preference_explicit','preference_repeated','correction'].includes(s.category)&&k.split('\u0000')[1]===lineFingerprint(request?.candidates.find(c=>c.text.includes(s.current))?.text??''))).length};
 await appendRow(row);console.log(id,'candidates',request?.candidates.length??0,'refused',refused.length);
}}));
await database.close(); console.log('DONE');
