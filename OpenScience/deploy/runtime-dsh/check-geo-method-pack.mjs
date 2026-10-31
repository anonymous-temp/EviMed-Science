/** Verify the private method bytes against the public, review-bound release receipt.
 * This ships metadata only: no proprietary method text or provider credentials.
 */
import {createHash} from 'node:crypto';
import {lstat,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const hash=value=>createHash('sha256').update(value).digest('hex');

export async function verifyGeoMethodPack(root, expected, {allowMissing=false}={}) {
  const entries=await readdir(root,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return[];throw error;});
  if (!entries.length || entries.every(entry=>entry.isFile()&&entry.name==='README.md')) {
    if(allowMissing)return{configured:false,reason:'private_method_pack_missing'};
    throw new Error('The reviewed private GEO method pack is required.');
  }
  const stampPath=path.join(root,'VENDORED.json');
  const stat=await lstat(stampPath);
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Invalid private GEO receipt.');
  const stamp=JSON.parse(await readFile(stampPath,'utf8'));
  if(!expected||stamp.package!=='geo-skills'||stamp.version!==expected.version||stamp.sha256!==expected.archiveSha256
    ||stamp.tree!==expected.treeSha256||!Array.isArray(expected.skills)||expected.skills.length!==new Set(expected.skills).size)
    throw new Error('The private GEO method pack does not match the reviewed platform release; supply the matching private archive.');
  const files=[];
  const walk=async(relative)=>{
    const dir=path.join(root,relative);const stat=await lstat(dir);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Invalid private GEO directory.');
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const inside=path.posix.join(relative,entry.name),full=path.join(root,inside);
      if(entry.isDirectory())await walk(inside);
      else if(entry.isFile())files.push({path:inside,data:await readFile(full)});
      else throw new Error('Private GEO methods cannot contain links or special files.');
    }
  };
  await walk('skills');await walk('shared');files.sort((a,b)=>a.path.localeCompare(b.path));
  const tree=hash(files.map(file=>`${file.path}\0${hash(file.data)}\n`).join(''));
  const names=files.map(file=>/^skills\/([^/]+)\/SKILL\.md$/.exec(file.path)?.[1]).filter(Boolean).sort();
  if(tree!==expected.treeSha256||stamp.files!==files.length||JSON.stringify(names)!==JSON.stringify([...expected.skills].sort()))
    throw new Error('Private GEO contents or skill inventory changed after review.');
  return{configured:true,version:stamp.version,skills:names.length,files:files.length,archiveSha256:stamp.sha256,treeSha256:tree};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=process.argv[2];if(!root)throw new Error('Usage: check-geo-method-pack.mjs ROOT [--allow-missing]');
  const expected=JSON.parse(await readFile(new URL('./geo-method-pack-release.json',import.meta.url),'utf8'));
  console.log(JSON.stringify(await verifyGeoMethodPack(root,expected,{allowMissing:process.argv.includes('--allow-missing')})));
}
