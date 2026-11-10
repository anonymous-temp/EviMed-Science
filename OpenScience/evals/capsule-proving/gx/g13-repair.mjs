/** Retry only transport/indexing failures, with identical corpus bytes; no quality case is rerun. */
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {readFile,appendFile} from 'node:fs/promises';
import {OpenVikingClient} from '../../../apps/server/src/openVikingClient.mjs';
import {controlUserId,firstLine} from '../run/lab.mjs';
const out='/srv/evimed/runs/gx-g13-1',errors=[];
for await(const line of createInterface({input:createReadStream(`${out}/packed-errors.jsonl`),crlfDelay:Infinity}))if(line.trim())errors.push(JSON.parse(line));
const repaired=new Set();try{for(const line of (await readFile(`${out}/repairs.jsonl`,'utf8')).split('\n').filter(Boolean)){const r=JSON.parse(line);if(!r.error)repaired.add(r.uri);}}catch{}
const groups=new Map(errors.filter(row=>!repaired.has(row.uri)).map(row=>[row.index,{...row,items:[]} ]));let i=0;
for await(const line of createInterface({input:createReadStream('/srv/evimed/data/memdata-data/scale/scale-10000.jsonl'),crlfDelay:Infinity})){
 if(!line.trim())continue;i++;const group=groups.get(Math.ceil(i/20)*20);if(group)group.items.push(JSON.parse(line));
}
const client=new OpenVikingClient({openVikingUrl:'http://127.0.0.1:19345',openVikingApiKey:(await readFile('/srv/evimed/ovlab/root.key','utf8')).trim(),openVikingAccount:'evlab-gx-g13-1',openVikingRequestTimeoutMs:60000});
for(const row of groups.values()){
 if(row.items.length!==20)throw Error('repair_corpus_group_incomplete');
 const start=Date.now();let result=null,error=null;
 try{result=await client.request({method:'POST',path:'/api/v1/content/write',userId:controlUserId('gx-g13-1','packed-scale'),timeoutMs:60000,body:{uri:row.uri,content:row.items.map(i=>`- ${i.text}`).join('\n'),mode:'replace',wait:true,telemetry:true}});}catch(e){error=firstLine(e);}
 await appendFile(`${out}/repairs.jsonl`,JSON.stringify({index:row.index,uri:row.uri,at:new Date().toISOString(),ms:Date.now()-start,result,error})+'\n');
 console.log(JSON.stringify({index:row.index,repaired:!error}));if(error)throw Error('embedding_repair_failed');
}
