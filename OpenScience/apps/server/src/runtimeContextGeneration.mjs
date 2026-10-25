/** Deployment-owned shared context. A generation is sealed before launch and
 * never refreshed in place; the ordinary personal method path is separate. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '@evimed/domain';
import { contextPolicyIdentity } from './geoContextItems.mjs';
import { assertNoSymlinkPath, HttpError } from './security.mjs';

const fail = () => new HttpError(409, 'runtime_context_unverified', 'The shared runtime context is missing, changed or unverified.');
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const key = project => hash([project.userId, project.id]);
export const contextGenerationRoot = (config, project) => path.join(config.dataDir, '.openscience', 'project-contexts', key(project));
export function contextGenerationPaths(config, project, reference) {
  if (!reference || Object.keys(reference).sort().join(',') !== 'digest,policyDigest' || !hex(reference.digest) || !hex(reference.policyDigest)) throw fail();
  const root = contextGenerationRoot(config, project);
  return { root, directory:path.join(root, 'generations', reference.digest), stateDirectory:path.join(root, 'states', reference.policyDigest),
    pendingDirectory:`/runtime/xdg-state/openviking/pending/${reference.digest}`,
    pendingHostDirectory:path.join(root, 'states', reference.policyDigest, 'xdg-state', 'openviking', 'pending', reference.digest) };
}
function policyIdentity(project, policy) {
  const identity = contextPolicyIdentity(policy);
  if (policy?.kind !== 'geo-project' || identity.ownerId !== project.userId || identity.controlProjectId !== project.id
    || Object.values(identity).some(value => value == null || value === '') || policy.policyVersion !== 1) throw fail();
  return identity;
}
/** No symlinks, special files, unbounded trees, hidden roots or traversal. */
async function inventory(root) {
  const files = []; let bytes = 0;
  const walk = async (directory, depth) => {
    if (depth > 12) throw fail();
    await assertNoSymlinkPath(root, directory);
    for (const entry of (await fs.readdir(directory, {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name), relative = path.relative(root,full).split(path.sep).join('/');
      if (entry.isDirectory()) { await walk(full,depth+1); continue; }
      if (!entry.isFile() || files.length >= 4096) throw fail();
      const opened = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await opened.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8*1024*1024) throw fail();
        const content = await opened.readFile(); bytes += content.length;
        if (bytes > 32*1024*1024 || (await opened.stat()).size !== stat.size) throw fail();
        files.push({path:relative,bytes:content.length,digest:hash(content)});
      } finally { await opened.close(); }
    }
  };
  await walk(root,0); return files;
}
/** Materializer receives a fresh protected directory, never a user path. */
export async function prepareContextGeneration(config, project, policy, materialize) {
  const identity = policyIdentity(project,policy), root = contextGenerationRoot(config,project);
  await assertNoSymlinkPath(config.dataDir,root,{allowMissingTail:true});
  await fs.mkdir(path.join(root,'generations'),{recursive:true,mode:0o700});
  const stage = await fs.mkdtemp(path.join(root,'generations','.stage-'));
  try {
    const methods = path.join(stage,'methods');await fs.mkdir(methods,{mode:0o700});
    const mounted = await materialize(methods,stage);
    const files = await inventory(methods);
    const manifest = {version:1,policy:identity,identities:mounted.identities ?? [],files:files.map(file=>({...file,path:`methods/${file.path}`})),methodsVersion:mounted.version ?? null};
    const digest = hash(manifest), reference = {digest,policyDigest:hash(identity)}, paths = contextGenerationPaths(config,project,reference);
    await fs.writeFile(path.join(stage,'manifest.json'),canonicalJson(manifest)+'\n',{mode:0o444,flag:'wx'});
    for(const file of files) await fs.chmod(path.join(methods,file.path),0o444);
    try { await fs.rename(stage,paths.directory); }
    catch(error) { if(!['EEXIST','ENOTEMPTY'].includes(error?.code)) throw error; }
    const verified = await verifyContextGeneration(config,project,reference,policy);
    return {...verified,mounted:{...mounted,directory:path.join(verified.directory,'methods')}};
  } finally { await fs.rm(stage,{recursive:true,force:true}); }
}
/** Recomputed independently by the controller immediately before launch. */
export async function verifyContextGeneration(config,project,reference,policy=null) {
  try {
    const paths = contextGenerationPaths(config,project,reference);
    await assertNoSymlinkPath(config.dataDir,paths.directory);
    const opened = await fs.open(path.join(paths.directory,'manifest.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
    let manifest;
    try { const stat=await opened.stat();if(!stat.isFile() || stat.nlink!==1 || stat.size>2*1024*1024) throw fail();manifest=JSON.parse(await opened.readFile('utf8')); }
    finally {await opened.close();}
    if (manifest.version!==1 || manifest.policy?.kind!=='geo-project' || manifest.policy.ownerId!==project.userId || manifest.policy.controlProjectId!==project.id
      || Object.values(manifest.policy).some(value=>value==null || value==='') || hash(manifest)!==reference.digest || hash(manifest.policy)!==reference.policyDigest
      || policy && canonicalJson(manifest.policy)!==canonicalJson(policyIdentity(project,policy))) throw fail();
    const actual = (await inventory(paths.directory)).filter(file=>file.path!=='manifest.json');
    if(canonicalJson(actual)!==canonicalJson(manifest.files)) throw fail();
    return {...paths,reference:structuredClone(reference),digest:reference.digest,manifest};
  } catch { throw fail(); }
}
/** Only producer-owned startup paths are moved. Research files and transcripts
 * are never rewritten. Recovery is outside every runtime/workspace mount. */
export async function remediateStartupContext(config,project,policy) {
  const identity=policyIdentity(project,policy), root=contextGenerationRoot(config,project), result=[];
  const known=['.evimed-handbooks','.evimed-brief','.evimed-capsule/profile.md'];
  for(const relative of known) {
    const source=path.join(project.workspaceDir,relative);
    await assertNoSymlinkPath(project.workspaceDir,source,{allowMissingTail:true});
    const stat=await fs.lstat(source).catch(error=>{if(error?.code==='ENOENT') return null;throw error;});
    if(!stat) continue;
    // Inspect all actual producer bytes before moving a directory.
    if(stat.isDirectory()) await inventory(source);
    else if(!stat.isFile() || stat.nlink!==1) throw fail();
    const recoveryDirectory=path.join(root,'recovery',hash(identity),randomUUID(),path.basename(relative));
    await assertNoSymlinkPath(config.dataDir,recoveryDirectory,{allowMissingTail:true});
    await fs.mkdir(path.dirname(recoveryDirectory),{recursive:true,mode:0o700});
    await fs.rename(source,recoveryDirectory);
    const retained = {path:relative,recoveryDirectory,action:'retained-outside-runtime'};
    await fs.writeFile(path.join(path.dirname(recoveryDirectory),'inventory.json'),canonicalJson({version:1,policy:identity,...retained})+'\n',{flag:'wx',mode:0o600});
    result.push(retained);
  }
  return result;
}
