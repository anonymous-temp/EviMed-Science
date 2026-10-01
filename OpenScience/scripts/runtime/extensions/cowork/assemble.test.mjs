import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
function tar(name,data,link=null,mode=0o444,directory=false){
  const header=Buffer.alloc(512),bytes=Buffer.from(data);header.write(name,0,100);header.write(mode.toString(8).padStart(7,'0')+'\0',100,8);header.write('0000000\0',108,8);header.write('0000000\0',116,8);
  header.write((link?0:bytes.length).toString(8).padStart(11,'0')+'\0',124,12);header.fill(32,148,156);header[156]=directory?53:link?50:48;if(link)header.write(link,157,100);header.write('ustar\0',257,6);
  const checksum=[...header].reduce((a,b)=>a+b,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);
  return Buffer.concat([header,...(link?[]:[bytes,Buffer.alloc((512-bytes.length%512)%512)]),Buffer.alloc(1024)]);
}
for(const attack of ['valid','traversal','outside-link','changed-bytes','writable-file','uninventoried-directory','writable-directory'])test(`artifact extraction ${attack} is inventory-bound without executing package code`,async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cowork-archive-')),output=path.join(root,'output'),source=path.join(root,'source');
  await fs.mkdir(path.join(output,'context'),{recursive:true});await fs.mkdir(source);await fs.writeFile(path.join(source,'LICENSE'),'MIT fixture');
  const name=attack==='traversal'?'../escape':attack==='outside-link'?'safe-link':'safe.txt',link=attack==='outside-link'?'../../escape':null;
  const entry=link?{path:name,link,mode:0o777}:{path:attack==='traversal'?'safe.txt':name,mode:0o444,bytes:2,sha256:createHash('sha256').update('ok').digest('hex')};
  await fs.writeFile(path.join(output,'context/dependency-closure.json'),JSON.stringify({files:[entry],directories:[{path:'.',mode:0o555}]}));
  await fs.writeFile(path.join(output,'vendor.tar'),attack.includes('directory')?Buffer.concat([tar(attack==='writable-directory'?'.':'extra','',null,0o777,true).subarray(0,512),tar(name,'ok')]):Buffer.concat([tar('.','',null,0o555,true).subarray(0,512),tar(name,attack==='changed-bytes'?'bad':'ok',link,attack==='writable-file'?0o777:link?0o777:0o444)]));
  try{
    const result=spawnSync('python3',[path.join(here,'assemble.py'),output,here,source],{encoding:'utf8'});
    if(attack==='valid'){assert.equal(result.status,0,result.stderr);assert.equal(await fs.readFile(path.join(output,'context/vendor/safe.txt'),'utf8'),'ok');}
    else{assert.notEqual(result.status,0);assert.equal(await fs.stat(path.join(root,'escape')).catch(()=>null),null);}
  }finally{await fs.chmod(path.join(output,'context/vendor'),0o755).catch(()=>{});await fs.rm(root,{recursive:true});}
});
