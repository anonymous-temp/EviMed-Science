/** Replay the fixed sample through the product archive reader itself and retain the missing origin's exact line. */
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {ControlPlaneDatabase} from '../../../apps/server/src/controlPlaneDatabase.mjs';
import {NativeMemoryOverlay,memoryLines,lineFingerprint,originalSources} from '../../../apps/server/src/nativeMemoryOverlay.mjs';
import {NativeMemoryVerification,verifyLines} from '../../../apps/server/src/nativeMemoryVerification.mjs';
import {OpenVikingClient} from '../../../apps/server/src/openVikingClient.mjs';
import {OpenVikingSessions,nativeMemoryFile} from '../../../apps/server/src/openVikingSessions.mjs';
import {nativeMemoryRoot} from '../../../apps/server/src/openVikingLayout.mjs';
import {engineShard} from '../run/run.mjs';
import {controlUserId} from '../run/lab.mjs';
const out='/srv/evimed/runs/gx-g7-1',summary=JSON.parse(await readFile(`${out}/summary.json`,'utf8'));
const run=JSON.parse(await readFile(`/srv/evimed/runs/${summary.sourceRun}/run.json`,'utf8'));
const db=new ControlPlaneDatabase({databaseUrl:(await readFile('/srv/evimed/ovlab/database.url','utf8')).trim(),databasePoolMax:2,databaseConnectionTimeoutMs:10000});
const overlay=new NativeMemoryOverlay({database:db}),key=(await readFile('/srv/evimed/ovlab/root.key','utf8')).trim();
const sessions=run.engine.urls.map(url=>new OpenVikingSessions(new OpenVikingClient({openVikingUrl:url,openVikingApiKey:key,openVikingAccount:run.engine.account,openVikingRequestTimeoutMs:30000}),{timeoutMs:30000}));
const readers=sessions.map(s=>new NativeMemoryVerification({config:{},sessions:s,overlay}));
try{
 const checked=[];
 for await(const line of createInterface({input:createReadStream(`${out}/sample.jsonl`),crlfDelay:Infinity})){
  if(!line.trim())continue;const row=JSON.parse(line),sources=await readers[engineShard(row.userKey,sessions.length)].readSources(row.userId,originalSources(row.origin));
  const result=verifyLines({lines:[row],sources})[0];
  checked.push({...row,productReaderStatus:!sources.length?'archive_unreadable':result.status,productReaderMissingTokens:result.missingTokens});
 }
 const mismatches=checked.filter(r=>r.status!==r.productReaderStatus||JSON.stringify(r.missingTokens)!==JSON.stringify(r.productReaderMissingTokens));
 summary.archiveReaderRecheck={n:checked.length,mismatches:mismatches.length,reader:'NativeMemoryVerification.readSources (uses sessions.read and filterCapturedMessage)',wallAt:new Date().toISOString()};
 await writeFile(`${out}/sample-product-reader.jsonl`,checked.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const missing=[];
 for(const user of summary.users.filter(u=>u.n!==u.withOrigin)){
  const userId=controlUserId(run.runId,user.userKey),root=nativeMemoryRoot(userId),dir=`/srv/evimed/runs/${run.runId}/cases/${user.userKey}/snapshots`;
  const name=(await readdir(dir)).filter(n=>/^\d+\.json$/.test(n)).sort((a,b)=>parseInt(a)-parseInt(b)).at(-1);
  const snap=JSON.parse(await readFile(`${dir}/${name}`,'utf8')),origins=await overlay.originsOf(userId,Object.keys(snap.files).map(rel=>`${root}/${rel}`));
  for(const [rel,body]of Object.entries(snap.files))for(const text of memoryLines(body).filter(t=>!/^#|^>\s*来源变更：/.test(t))){
   const uri=`${root}/${rel}`,fingerprint=lineFingerprint(text);
   if(!origins.get(uri)?.get(fingerprint))missing.push({userKey:user.userKey,uri,fingerprint,text,type:nativeMemoryFile(uri,root)?.type??rel.split('/')[0]});
  }
 }
 await writeFile(`${out}/missing-origins.jsonl`,missing.map(r=>JSON.stringify(r)).join('\n')+'\n');
 await writeFile(`${out}/summary.json`,JSON.stringify(summary,null,2)+'\n');
 console.log(JSON.stringify({recheck:summary.archiveReaderRecheck,missingOrigins:missing.length}));
 if(mismatches.length)throw Error('product_archive_reader_mismatch');
}finally{await db.close();}
