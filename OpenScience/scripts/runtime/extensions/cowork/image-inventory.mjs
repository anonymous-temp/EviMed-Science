/** Offline image proof only. Read all artifact bytes/modes without loading vendor code. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root='/opt/cowork/vendor',files=[],directories=[];
const bytes=await fs.readFile('/opt/cowork/dependency-closure.json');
const hash=value=>createHash('sha256').update(value).digest('hex');
assert.equal(hash(bytes),process.env.COWORK_EXPECTED_CLOSURE_SHA256,'image closure must equal external immutable record');
const expected=JSON.parse(bytes);
async function walk(directory){
  const stat=await fs.lstat(directory);directories.push({path:path.relative(root,directory)||'.',mode:stat.mode&0o7777});
  for(const name of (await fs.readdir(directory)).sort()){
    const full=path.join(directory,name),relative=path.relative(root,full),item=await fs.lstat(full);
    if(item.isDirectory()){await walk(full);continue;}
    if(item.isSymbolicLink()){
      const link=await fs.readlink(full),target=await fs.realpath(full);assert(!path.isAbsolute(link)&&(target.startsWith(root+'/')||target===root));
      files.push({path:relative,link,mode:item.mode&0o7777});continue;
    }
    assert(item.isFile(),'artifact cannot contain special files');const data=await fs.readFile(full);
    files.push({path:relative,mode:item.mode&0o7777,bytes:data.length,sha256:hash(data)});
  }
}
await walk(root);
const sorted=items=>[...items].sort((a,b)=>a.path.localeCompare(b.path));
assert.deepEqual(sorted(directories),sorted(expected.directories),'all directories including artifact root must match inventory');
assert.deepEqual(sorted(files),sorted(expected.files),'all files, link targets, bytes and modes must match inventory');
console.log(JSON.stringify({artifactRootMode:directories[0].mode,files:files.length,directoriesIncludingRoot:directories.length,allBytesModesAndDirectoriesMatch:true}));
