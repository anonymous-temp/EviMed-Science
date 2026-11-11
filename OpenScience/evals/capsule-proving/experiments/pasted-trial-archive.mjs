// Archive and retire only P30's own interrupted synthetic lab trials before their fresh replacements.
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ControlPlaneDatabase } from '../../../apps/server/src/controlPlaneDatabase.mjs';
import { OpenVikingClient } from '../../../apps/server/src/openVikingClient.mjs';
import { OpenVikingSessions } from '../../../apps/server/src/openVikingSessions.mjs';
if (!process.argv.includes('--retire-own-trials')) throw Error('explicit lab-only retirement required');
const version=process.argv.includes('--second-attempt')?'v2':'v1';
const root='/srv/evimed/runs',urls=['http://127.0.0.1:19358','http://127.0.0.1:19359'];
const key=(await readFile('/srv/evimed/ovlab/root.key','utf8')).trim();
const db=new ControlPlaneDatabase({ databaseUrl:(await readFile('/srv/evimed/ovlab/database.url','utf8')).trim(),databasePoolMax:1,databaseConnectionTimeoutMs:10000 });
const report=[];
for(const run of ['p30-inject-1','p30-inject-2','p30-inject-3','p30-g9-1']){
 const account=`evlab-${run}`,prefix=`evlab_${run}_`;
 const destination=`${root}/p30-attempt-${version}-${run.slice(4)}`;
 await mkdir(`${destination}/recorded-archives`,{recursive:true});
 const commits=(await db.query('SELECT * FROM evimed_memory.native_commits WHERE left(user_id,length($1))=$1 ORDER BY user_id,archive_uri',[prefix])).rows;
 const revisions=(await db.query('SELECT * FROM evimed_memory.native_revisions WHERE left(user_id,length($1))=$1 ORDER BY id',[prefix])).rows;
 await writeFile(`${destination}/revisions.json`,JSON.stringify(revisions));
 await writeFile(`${destination}/commits.json`,JSON.stringify(commits));
 const clients=urls.map(openVikingUrl=>new OpenVikingClient({openVikingUrl,openVikingApiKey:key,openVikingAccount:account,openVikingRequestTimeoutMs:30000}));
 for(const row of commits){
  const caseId=row.user_id.slice(prefix.length),shard=createHash('sha256').update(caseId).digest().readUInt32BE(0)%urls.length;
  const sessions=new OpenVikingSessions(clients[shard]);
  const backup=`${destination}/recorded-archives/${createHash('sha256').update(row.archive_uri).digest('hex')}.json`;
  if(await readFile(backup,'utf8').then(()=>true,()=>false))continue;
  const content={commit:row,messages:await sessions.read(row.user_id,`${row.archive_uri}/messages.jsonl`),diff:await sessions.read(row.user_id,`${row.archive_uri}/memory_diff.json`)};
  await writeFile(backup,JSON.stringify(content));
 }
 const states=[];
 for(const openVikingUrl of urls){
  const client=new OpenVikingClient({openVikingUrl,openVikingApiKey:key,openVikingAccount:"default",openVikingRequestTimeoutMs:30000});
  let absent=false;
  for(let attempt=0;attempt<8&&!absent;attempt++){
   try { await client.request({method:'DELETE',path:`/api/v1/admin/accounts/${account}`}); }
   catch(error){if(Number(error.upstreamStatus)===404){absent=true;break;}if(![409,412].includes(Number(error.upstreamStatus)))throw Error('own_trial_engine_retirement_failed');}
   for(let poll=0;poll<20;poll++){
    const body=await client.request({path:'/api/v1/admin/accounts'});
    const found=(body.result??[]).find(row=>row.account_id===account);
    if(!found){absent=true;break;}
    await new Promise(resolve=>setTimeout(resolve,1000));
   }
  }
  if(!absent)throw Error('own_trial_engine_still_present');states.push('absent');
 }
 for(const table of ['history_chunks','history_archives','history_fences'])await db.query(`DELETE FROM evimed_memory.${table} WHERE left(owner_id,length($1))=$1`,[prefix]);
 const removed=await db.query('DELETE FROM evimed_control.users WHERE left(id,length($1))=$1',[prefix]);
 // Keep the original run directory whole beside its archived native receipts.
 await rename(`${root}/${run}`,`${destination}/run`);
 report.push({run,archive:destination,commits:commits.length,revisions:revisions.length,engine:states,users:removed.rowCount});
 console.log(run,'archived and retired');
}
await writeFile(`${root}/p30-attempt-${version}-retirement.json`,JSON.stringify(report,null,2));
await db.close();
