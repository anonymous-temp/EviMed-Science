import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
/** Hash the copied source tree itself, not a live host checkout. Dependencies are bound by the image and lockfile. */
export async function snapshotSource(root) {
  const hash=createHash('sha256');
  async function walk(directory,relative='') {
    const entries=(await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'));
    for(const entry of entries){
      if(entry.name==='node_modules'||entry.name==='.git')continue;
      const name=path.posix.join(relative,entry.name),target=path.join(directory,entry.name);
      if(entry.isDirectory()){hash.update(`D\0${name}\0`);await walk(target,name);}
      else if(entry.isSymbolicLink())hash.update(`L\0${name}\0${await fs.readlink(target)}\0`);
      else if(entry.isFile()){const content=await fs.readFile(target);hash.update(`F\0${name}\0${content.length}\0`);hash.update(content);}
      else throw new Error('Unexpected source tree entry');
    }
  }
  await walk(root);return 'sha256:'+hash.digest('hex');
}
