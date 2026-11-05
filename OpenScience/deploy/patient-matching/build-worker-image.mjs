/** Offline assembly from a locally verified Node/Python runtime; no source tree, provider settings or home enters the image. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
const [sourceImage,workerTar,tag,receiptPath]=process.argv.slice(2);
if(!sourceImage||!workerTar||!tag||!receiptPath)throw new Error('Usage: build-worker-image.mjs <local runtime image> <worker.tgz> <tag> <receipt.json>');
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:4*1024*1024}).trim();
const stage=await fs.mkdtemp(path.join(os.tmpdir(),'matching-worker-image-'));
let container;
try{
  const imageDigest=docker('image','inspect',sourceImage,'--format','{{.Id}}');
  if(!/^sha256:[a-f0-9]{64}$/.test(imageDigest))throw new Error('An immutable local runtime image is required.');
  const info=JSON.parse(docker('run','--rm','--network','none','--entrypoint','python3',sourceImage,'-c','import sys,sysconfig,json,os; print(json.dumps({"python":os.path.realpath(sys.executable),"stdlib":sysconfig.get_path("stdlib"),"version":sys.version.split()[0]}))'));
  if(!/^\/usr\/(?:local\/)?(?:bin|lib)\/[A-Za-z0-9./_-]+$/.test(info.python)||!/^\/usr\/(?:local\/)?lib\/python3\.\d+$/.test(info.stdlib))throw new Error('Unexpected system Python layout.');
  const nodeVersion=docker('run','--rm','--network','none','--entrypoint','/usr/local/bin/node',sourceImage,'--version');
  const linked=docker('run','--rm','--network','none','--entrypoint','/usr/bin/ldd',sourceImage,'/usr/local/bin/node',info.python);
  const libraries=[...new Set(linked.match(/\/(?:usr\/)?lib(?:64)?\/[A-Za-z0-9_./-]+/g)??[])];
  const libraryDirectories=[...new Set(libraries.filter(p=>/\/[^/]+-linux-gnu\//.test(p)).map(p=>path.dirname(p)))];
  const files=['/usr/local/bin/node',info.python,info.stdlib,...libraryDirectories,...libraries.filter(p=>!libraryDirectories.includes(path.dirname(p)))];
  container=docker('create','--network','none','--entrypoint','/bin/false',sourceImage);
  const rootfs=path.join(stage,'rootfs');await fs.mkdir(rootfs);
  for(const entry of files){const destination=path.join(rootfs,entry.slice(1));await fs.mkdir(path.dirname(destination),{recursive:true});docker('cp','-L',`${container}:${entry}`,destination);}
  const pythonLink=path.join(rootfs,'usr/bin/python3');await fs.mkdir(path.dirname(pythonLink),{recursive:true});if(pythonLink!==path.join(rootfs,info.python.slice(1)))await fs.symlink(info.python,pythonLink);
  for(const entry of ['tmp','run','etc'])await fs.mkdir(path.join(rootfs,entry),{recursive:true});await fs.chmod(path.join(rootfs,'tmp'),0o1777);
  await fs.writeFile(path.join(rootfs,'etc/passwd'),'worker:x:1000:1000:Matching worker:/nonexistent:/usr/sbin/nologin\n');
  await fs.copyFile(path.join(here,'Dockerfile'),path.join(stage,'Dockerfile'));
  // The worker tar is a first-party build artifact, never a user upload.
  execFileSync('tar',['-xzf',path.resolve(workerTar),'-C',stage]);await fs.rename(path.join(stage,'package'),path.join(stage,'worker'));
  execFileSync('docker',['build','--network=none','-t',tag,stage],{stdio:'inherit',env:{...process.env,DOCKER_BUILDKIT:'0'}});
  const workerImageDigest=docker('image','inspect',tag,'--format','{{.Id}}');
  await fs.writeFile(receiptPath,JSON.stringify({workerImageDigest,sourceRuntimeDigest:imageDigest,nodeVersion,pythonVersion:info.version,assembly:'public-system-runtime-only',network:'none'},null,2)+'\n');
  process.stdout.write(`${workerImageDigest}\n`);
}finally{if(container)docker('rm','-f',container);await fs.rm(stage,{recursive:true,force:true});}
