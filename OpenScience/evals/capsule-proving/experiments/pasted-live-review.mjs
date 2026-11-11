// Read-only P30 audit of lines the frozen guard actually held in its own development accounts.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ControlPlaneDatabase } from '../../../apps/server/src/controlPlaneDatabase.mjs';
import { OpenVikingClient } from '../../../apps/server/src/openVikingClient.mjs';
import { OpenVikingSessions } from '../../../apps/server/src/openVikingSessions.mjs';
import { instructionSourceMessage } from '../../../apps/server/src/nativeMemoryInstructionOrigin.mjs';
import { removalLines } from '../../../apps/server/src/nativeMemoryRejections.mjs';
import { lineFingerprint } from '../../../apps/server/src/nativeMemoryOverlay.mjs';
const out=process.argv[2], names=process.argv.slice(3);
if(!out||!names.length||names.some(n=>!/^p30-(inject-[123]|g9-1)$/.test(n)))throw Error('own_run_names_required');
await mkdir(out,{recursive:true});
const database=new ControlPlaneDatabase({databaseUrl:(await readFile('/srv/evimed/ovlab/database.url','utf8')).trim(),databasePoolMax:1,databaseConnectionTimeoutMs:10000});
const key=(await readFile('/srv/evimed/ovlab/root.key','utf8')).trim();
const rows=[],coverage=[];
for(const name of names){
 const root=`/srv/evimed/runs/${name}`,run=JSON.parse(await readFile(path.join(root,'run.json'),'utf8'));
 if(run.split!=='dev'||run.flags.memoryPastedInstructionRobustEnabled!==true)throw Error('frozen_development_guard_required');
 const users=(await database.query('SELECT DISTINCT user_id FROM evimed_memory.native_commits WHERE user_id LIKE $1',[`evlab_${name}_%`])).rows;
 for(const user of users){
  const userId=user.user_id,caseId=userId.slice(`evlab_${name}_`.length);
  const urls=run.engine.urls??[run.engine.url],shard=createHash('sha256').update(caseId).digest().readUInt32BE(0)%urls.length;
  if(!/^http:\/\/127\.0\.0\.1:1935[89]$/.test(urls[shard]))throw Error('own_engine_required');
  const sessions=new OpenVikingSessions(new OpenVikingClient({openVikingUrl:urls[shard],openVikingApiKey:key,openVikingAccount:run.engine.account,openVikingRequestTimeoutMs:30000}));
  const revisions=(await database.query('SELECT id,uri,"before","after",reason,changed_at FROM evimed_memory.native_revisions WHERE user_id=$1 AND actor=$2 AND reason LIKE $3 ORDER BY id',[userId,'platform','%pasted_instruction%'])).rows;
  const checks=(await database.query('SELECT result,checked_at FROM evimed_memory.native_instruction_checks WHERE user_id=$1 ORDER BY checked_at DESC',[userId])).rows;
  const archiveCache=new Map(); let lines=0;
  for(const revision of revisions)for(const text of removalLines(revision.before??'',revision.after??'')){
   const hash=createHash('sha256').update(text).digest('hex');let receipt=null,checkedAt=null;
   for(const check of checks){
    if(new Date(check.checked_at)>new Date(revision.changed_at))continue;
    receipt=check.result.receipts?.find(r=>r.candidates.includes(hash));
    if(receipt){checkedAt=check.checked_at;break;}
   }
   if(!receipt)throw Error('held_line_receipt_missing');
   const conversation=[];
   for(const source of receipt.sources){
    if(!source.archiveUri)continue;
    if(!archiveCache.has(source.archiveUri)){
     const raw=await sessions.read(userId,`${source.archiveUri}/messages.jsonl`);if(!raw)throw Error('held_source_archive_missing');
     archiveCache.set(source.archiveUri,raw.split('\n').filter(Boolean).map(l=>instructionSourceMessage(JSON.parse(l),source.archiveUri)).filter(Boolean));
    }
    const message=archiveCache.get(source.archiveUri).find(m=>m.id===source.id&&m.role===source.role);
    if(message&&!conversation.some(m=>JSON.stringify(m)===JSON.stringify(message)))conversation.push(message);
   }
   if(!conversation.length)throw Error('held_source_messages_missing');
   const id=`${name}/${caseId}/revision-${revision.id}`,pending=revision.reason.includes('pasted_instruction_pending');
   const suffix=`${revision.uri}\u0000${lineFingerprint(text)}`;
   rows.push({id,run:name,caseId,rep:1,sessionId:`revision-${revision.id}`,checkedAt,reason:revision.reason,
    request:{candidates:[{candidate:0,text,sourceMessages:conversation.map((_,i)=>i)}],conversation},
    refused:pending?[]:[suffix],pending:pending?[suffix]:[]});lines++;
  }
  coverage.push({run:name,caseId,checks:checks.length,heldRevisions:revisions.length,heldLines:lines});console.log(name,caseId,checks.length,revisions.length,lines);
 }
}
await writeFile(path.join(out,'rows.jsonl'),rows.map(row=>JSON.stringify(row)+'\n').join(''));
await writeFile(path.join(out,'manifest.json'),JSON.stringify({at:new Date().toISOString(),jobs:rows.length,runs:names,coverage,evidence:'Actual platform-held lines; receipt-bound source messages; read-only, no replay or ingestion.'},null,2));
await appendFile(path.join(out,'STATUS'),`${new Date().toISOString()} DONE ${rows.length} held lines\n`);
await database.close();
