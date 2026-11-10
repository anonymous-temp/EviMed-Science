/** G7: read-only snapshot/origin audit, bounded one-user files and a seeded 200-line sample. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat, appendFile } from 'node:fs/promises';
import { ControlPlaneDatabase } from '../../../apps/server/src/controlPlaneDatabase.mjs';
import { NativeMemoryOverlay, memoryLines, lineFingerprint, originalSources } from '../../../apps/server/src/nativeMemoryOverlay.mjs';
import { filterCapturedMessage } from '../../../apps/server/src/memoryGateway.mjs';
import { verifyLines } from '../../../apps/server/src/nativeMemoryVerification.mjs';
import { OpenVikingClient } from '../../../apps/server/src/openVikingClient.mjs';
import { OpenVikingSessions, nativeMemoryFile } from '../../../apps/server/src/openVikingSessions.mjs';
import { nativeMemoryRoot } from '../../../apps/server/src/openVikingLayout.mjs';
import { controlUserId } from '../run/lab.mjs';
import { engineShard } from '../run/run.mjs';
const out='/srv/evimed/runs/gx-g7-1', input='/srv/evimed/runs/v3-synthetic-users-dev-product-1';
await mkdir(out,{recursive:true});
async function json(path){if((await stat(path)).size>10_000_000)throw Error('bounded_json_limit');return JSON.parse(await readFile(path,'utf8'));}
const run=await json(`${input}/run.json`), start=Date.now(), seed='gx-g7-20261110-v1';
const db=new ControlPlaneDatabase({databaseUrl:(await readFile('/srv/evimed/ovlab/database.url','utf8')).trim(),databasePoolMax:2,databaseConnectionTimeoutMs:10000});
const overlay=new NativeMemoryOverlay({database:db});
const engineKey=(await readFile('/srv/evimed/ovlab/root.key','utf8')).trim();
const sessions=run.engine.urls.map(url=>new OpenVikingSessions(new OpenVikingClient({openVikingUrl:url,openVikingApiKey:engineKey,openVikingAccount:run.engine.account,openVikingRequestTimeoutMs:30000}),{timeoutMs:30000}));
// The template mandates these English labels and user-language output, not fixed Chinese tokens. Chinese labels below
// are literal renderings observed in this run; keep their inventory and strict lexical limits in the result.
const labels={suggestion:['assistant suggested','assistant 建议','助手建议'],opinion:['user believes','用户认为'],document_claim:['document says','文档说','文档称']};
const normalize=s=>String(s).normalize('NFKC').toLowerCase().replace(/\s+/gu,'');
const byType={},users=[],attribution={},sample=[];
try{
for(const userKey of run.cases){
 const userId=controlUserId(run.runId,userKey),root=nativeMemoryRoot(userId),dir=`${input}/cases/${userKey}/snapshots`;
 const snaps=(await readdir(dir)).filter(n=>/^\d+\.json$/.test(n)).sort((a,b)=>Number(a.split('.')[0])-Number(b.split('.')[0]));
 const snap=await json(`${dir}/${snaps.at(-1)}`),files=Object.entries(snap.files);
 const origins=await overlay.originsOf(userId,files.map(([rel])=>`${root}/${rel}`));
 const lines=[];let n=0,withOrigin=0;
 for(const [rel,body]of files){
  const uri=`${root}/${rel}`,type=nativeMemoryFile(uri,root)?.type??(rel==='profile.md'?'profile':rel.split('/')[0]);
  const counts=byType[type]??={n:0,withOrigin:0,withConversation:0};
  for(const text of memoryLines(body).filter(t=>!/^#|^>\s*来源变更：/.test(t))){
   n++;counts.n++;lines.push({rel,text});const fingerprint=lineFingerprint(text),origin=origins.get(uri)?.get(fingerprint);
   if(!origin){await appendFile(`${out}/missing-origins.jsonl`,JSON.stringify({userKey,userId,uri,type,text,fingerprint})+'\n');continue;}withOrigin++;counts.withOrigin++;
   if(originalSources(origin).some(s=>s.archiveUri&&s.engineSession))counts.withConversation++;
   const rank=createHash('sha256').update(`${seed}\0${userKey}\0${uri}\0${fingerprint}`).digest('hex');
   sample.push({userKey,userId,uri,type,text,fingerprint,origin,rank});sample.sort((a,b)=>a.rank.localeCompare(b.rank));if(sample.length>200)sample.pop();
  }
 }
 const gold=await json(`/srv/evimed/data/memdata-data/dev/${userKey}/gold.json`);
 for(const item of gold.store.filter(x=>Object.hasOwn(labels,x.category)&&x.attribution)){
  const hits=lines.filter(line=>normalize(line.text).includes(normalize(item.current)));
  const marked=hits.filter(line=>labels[item.category].some(label=>normalize(line.text).includes(normalize(label))));
  const counts=attribution[item.category]??={planted:0,matchedItems:0,labelledItems:0,matchedLines:0,labelledLines:0};
  counts.planted++;counts.matchedItems+=hits.length>0;counts.labelledItems+=marked.length>0;counts.matchedLines+=hits.length;counts.labelledLines+=marked.length;
  await appendFile(`${out}/attribution.jsonl`,JSON.stringify({userKey,plantId:item.plantId,category:item.category,attribution:item.attribution,anchor:item.current,matched:hits,labelled:marked.length})+'\n');
 }
 users.push({userKey,afterSession:snap.afterSession,files:files.length,n,withOrigin});
 await appendFile(`${out}/STATUS`,`${new Date().toISOString()} DONE origins ${userKey} ${withOrigin}/${n}\n`);
}
const checks=[];
for(const row of sample){
 const excerpts=[];let archives=0,unreadable=0;
 for(const origin of originalSources(row.origin)){
  if(!origin.archiveUri){unreadable++;continue;}
  const raw=await sessions[engineShard(row.userKey,sessions.length)].read(row.userId,`${origin.archiveUri}/messages.jsonl`).catch(()=>null);
  if(!raw||Buffer.byteLength(raw)>2_000_000){unreadable++;continue;}
  archives++;
  for(const line of raw.split('\n').filter(Boolean)){
   const message=JSON.parse(line);
   const decision=filterCapturedMessage(message);
   if('forward' in decision)excerpts.push({text:decision.forward.parts.map(p=>p.text).join('\n'),created_at:message.created_at??null});
  }
 }
 const verdict=verifyLines({lines:[row],sources:excerpts})[0];
 const checked={...row,rank:undefined,status:!archives?'archive_unreadable':verdict.status,missingTokens:verdict.missingTokens,archives,unreadable};
 checks.push(checked);await appendFile(`${out}/sample.jsonl`,JSON.stringify(checked)+'\n');
}
const n=users.reduce((s,u)=>s+u.n,0),withOrigin=users.reduce((s,u)=>s+u.withOrigin,0);
const summary={automated:true,sourceRun:run.runId,sourceCommit:run.commit,engine:run.engine,seed,users,n,withOrigin,originShare:withOrigin/n,
 byType:Object.fromEntries(Object.entries(byType).map(([k,v])=>[k,{...v,share:v.withOrigin/v.n}])),
 sample:{n:checks.length,supported:checks.filter(c=>c.status==='supported').length,missingTokens:checks.filter(c=>c.status==='contradicted_or_unsupported').length,noHardTokens:checks.filter(c=>c.status==='needs_reading').length,archiveUnreadable:checks.filter(c=>c.status==='archive_unreadable').length,allTokensPresent:checks.filter(c=>!c.missingTokens.length&&c.archives).length},
 attribution,labels,attributionLimit:'Strict lexical labels only; gold-current substring after NFKC/whitespace normalization. Missing anchors remain in planted denominator; synonyms, source titles and contextual attribution need semantic review. Label counts are not proof of semantic correctness.',
 wallSeconds:(Date.now()-start)/1000};
await writeFile(`${out}/summary.json`,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({n,withOrigin,byType:summary.byType,sample:summary.sample,attribution}));
}finally{await db.close();}
