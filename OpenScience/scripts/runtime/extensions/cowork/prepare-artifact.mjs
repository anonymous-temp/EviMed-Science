/** Fix only pnpm legacy deploy's root self-reference inside disposable build state. No vendor source is patched. */
import fs from 'node:fs/promises';
import path from 'node:path';
const root='/work/deploy-publication',link=root+'/node_modules/.pnpm/node_modules/@dsh-cowork/mcp';
if((await fs.lstat(link)).isSymbolicLink()){
  const actual=await fs.realpath(link);
  if(actual!==root){
    if(actual!=='/work/packages/mcp')throw new Error('unexpected_deploy_self_reference');
    await fs.unlink(link);await fs.symlink(path.relative(path.dirname(link),root),link);
  }
}
const license=await fs.readFile('/work/LICENSE');
const existing=await fs.readFile(root+'/LICENSE').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
if(existing&&!existing.equals(license))throw new Error('deployed_license_differs');
if(!existing)await fs.copyFile('/work/LICENSE',root+'/LICENSE');
// Installation-cache timestamps have no runtime authority. Keep dependency
// locks/manifests, but omit this pnpm-only volatile management projection.
await fs.rm(root+'/node_modules/.modules.yaml',{force:true});
// The protected source cache arrives with 0600 manifests. Published public
// package bytes must be readable by the isolated uid, without writable state.
async function publicModes(directory){
  for(const name of await fs.readdir(directory)){
    const file=path.join(directory,name),stat=await fs.lstat(file);
    if(stat.isDirectory())await publicModes(file);
    else if(stat.isFile())await fs.chmod(file,0o444);
  }
  await fs.chmod(directory,0o555);
}
await publicModes(root);
