/** Source acquisition verification inside the isolated builder, before any dependency command executes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root='/work',manifest=JSON.parse(await fs.readFile('/adapter/source-manifest.json','utf8'));
const allowed=new Set(manifest.files.map(file=>file.path));
async function checkTree(directory){
  for(const name of await fs.readdir(directory)){
    const full=path.join(directory,name),stat=await fs.lstat(full);
    if(stat.isSymbolicLink())throw new Error('source_unexpected_link');
    if(stat.isDirectory())await checkTree(full);
    else if(!stat.isFile()||!allowed.has(path.relative(root,full)))throw new Error('source_unexpected_entry');
  }
}
await checkTree(root);
for(const expected of manifest.files){
  const file=path.join(root,expected.path),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==expected.bytes)throw new Error('source_identity_differs');
  if(createHash('sha256').update(await fs.readFile(file)).digest('hex')!==expected.sha256)throw new Error('source_identity_differs');
}
console.log(JSON.stringify({sourceCommit:manifest.commit,verifiedFiles:manifest.files.length}));
