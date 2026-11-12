// Refuse reuse of any P30 account state before the final fresh-ingest proof.
import { readFile, writeFile } from 'node:fs/promises';
import { ControlPlaneDatabase } from '../../../apps/server/src/controlPlaneDatabase.mjs';
import { OpenVikingClient } from '../../../apps/server/src/openVikingClient.mjs';
const runs=['p30-inject-1','p30-inject-2','p30-inject-3','p30-g9-1'];
const key=(await readFile('/srv/evimed/ovlab/root.key','utf8')).trim();
const database=new ControlPlaneDatabase({databaseUrl:(await readFile('/srv/evimed/ovlab/database.url','utf8')).trim(),databasePoolMax:1,databaseConnectionTimeoutMs:10000});
const receipt={at:new Date().toISOString(),engines:[],commits:[]};
for(const openVikingUrl of ['http://127.0.0.1:19358','http://127.0.0.1:19359']){
 const client=new OpenVikingClient({openVikingUrl,openVikingApiKey:key,openVikingAccount:'default',openVikingRequestTimeoutMs:30000});
 const body=await client.request({path:'/api/v1/admin/accounts'});
 const present=(body.result??[]).filter(row=>runs.some(run=>row.account_id===`evlab-${run}`)).map(row=>row.account_id);
 receipt.engines.push({url:openVikingUrl,present});
 if(present.length)throw Error('fresh_engine_account_precondition_failed');
}
for(const run of runs){
 const prefix=`evlab_${run}_`;
 const result=await database.query('SELECT count(*) AS n FROM evimed_memory.native_commits WHERE left(user_id,length($1))=$1',[prefix]);
 const count=Number(result.rows[0].n);receipt.commits.push({run,count});
 if(count)throw Error('fresh_commit_precondition_failed');
}
await writeFile('/srv/evimed/runs/p30-fresh-preflight.json',JSON.stringify(receipt,null,2));
await database.close();console.log('Fresh-account preconditions verified.');
