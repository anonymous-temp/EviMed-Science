/** Build-time inventory, executed only inside the disposable container. No package code is loaded. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root='/work/deploy-publication',files=[],directories=[],packages=[];
async function walk(directory){
  const dir=await fs.lstat(directory);if((dir.mode&0o7777)!==0o555)throw new Error('artifact_directory_mode');directories.push({path:path.relative(root,directory)||'.',mode:dir.mode&0o7777});
  for(const name of (await fs.readdir(directory)).sort()){
    const full=path.join(directory,name),relative=path.relative(root,full),stat=await fs.lstat(full);
    if(stat.isDirectory()){await walk(full);continue;}
    if(stat.isSymbolicLink()){
      const target=await fs.readlink(full),resolved=await fs.realpath(full);
      if(path.isAbsolute(target)||(resolved!==root&&!resolved.startsWith(root+'/')))throw new Error('artifact_link_outside_closure');
      files.push({path:relative,link:target,mode:stat.mode&0o7777});continue;
    }
    if(!stat.isFile()||(stat.mode&0o7777)!==0o444)throw new Error('artifact_special_entry');
    const bytes=await fs.readFile(full);files.push({path:relative,mode:stat.mode&0o7777,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    if(name==='package.json'){
      const item=JSON.parse(bytes);if(item.name)packages.push({name:item.name,version:item.version,license:item.license??item.licenses??null,manifest:relative});
    }
  }
}
await walk(root);
if(packages.some(item=>item.name.startsWith('@deepseek-ai/')))throw new Error('unexpected_kernel_dependency');
const record={schemaVersion:2,sourceCommit:'2ae5cf755c4294a1e988eebf3b12dd062425d84c',packages,files,directories,
  contentDigest:'sha256:'+createHash('sha256').update(JSON.stringify({files,directories})).digest('hex')};
await fs.writeFile('/work/dependency-closure.json',JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({packages:packages.length,files:files.length,contentDigest:record.contentDigest}));
