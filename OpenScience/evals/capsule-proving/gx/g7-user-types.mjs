/** Retain each user's per-type denominator, in addition to the aggregate G7 table. */
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {ControlPlaneDatabase} from '../../../apps/server/src/controlPlaneDatabase.mjs';
import {NativeMemoryOverlay,memoryLines,lineFingerprint} from '../../../apps/server/src/nativeMemoryOverlay.mjs';
import {nativeMemoryFile} from '../../../apps/server/src/openVikingSessions.mjs';
import {nativeMemoryRoot} from '../../../apps/server/src/openVikingLayout.mjs';
import {controlUserId} from '../run/lab.mjs';
const out='/srv/evimed/runs/gx-g7-1',summary=JSON.parse(await readFile(`${out}/summary.json`,'utf8'));
const db=new ControlPlaneDatabase({databaseUrl:(await readFile('/srv/evimed/ovlab/database.url','utf8')).trim(),databasePoolMax:2,databaseConnectionTimeoutMs:10000});
const overlay=new NativeMemoryOverlay({database:db});
try{
 for(const user of summary.users){
  const id=controlUserId(summary.sourceRun,user.userKey),root=nativeMemoryRoot(id),dir=`/srv/evimed/runs/${summary.sourceRun}/cases/${user.userKey}/snapshots`;
  const name=(await readdir(dir)).filter(n=>/^\d+\.json$/.test(n)).sort((a,b)=>parseInt(a)-parseInt(b)).at(-1);
  const snap=JSON.parse(await readFile(`${dir}/${name}`,'utf8')),origins=await overlay.originsOf(id,Object.keys(snap.files).map(rel=>`${root}/${rel}`));
  const byType={};
  for(const [rel,body]of Object.entries(snap.files)){
   const uri=`${root}/${rel}`,type=nativeMemoryFile(uri,root)?.type??(rel==='profile.md'?'profile':rel.split('/')[0]);
   const count=byType[type]??={n:0,withOrigin:0};
   for(const text of memoryLines(body).filter(t=>!/^#|^>\s*来源变更：/.test(t))){count.n++;count.withOrigin+=origins.get(uri)?.has(lineFingerprint(text))?1:0;}
  }
  user.byType=Object.fromEntries(Object.entries(byType).map(([type,v])=>[type,{...v,share:v.n?v.withOrigin/v.n:null}]));
  if(Object.values(byType).reduce((n,v)=>n+v.n,0)!==user.n)throw Error('user_denominator_changed');
 }
 await writeFile(`${out}/summary.json`,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({users:summary.users.length,total:summary.n}));
}finally{await db.close();}
