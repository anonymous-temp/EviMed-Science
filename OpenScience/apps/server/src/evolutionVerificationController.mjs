import {createEvolutionDependencyPreparer} from "./evolutionDependencyPreparation.mjs";
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {ExtensionToolController} from './extensionToolController.mjs';
import {HttpError} from './security.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const refused=()=>new HttpError(400,'extension_contract_invalid','Invalid isolated verification input.');
/** Candidate bytes only: no path, credential, image, workspace or socket selections. @param {any} body */
export function verificationRequest(body){
  if(!body||Object.keys(body).some(key=>!['files','code','input','dependencyIds'].includes(key))||typeof body.code!=='string'||Buffer.byteLength(body.code)>262144||!body.files||typeof body.files!=='object'||Array.isArray(body.files))throw refused();
  let bytes=0;const files={};
  if(Object.keys(body.files).length>128)throw refused();
  for(const [name,value]of Object.entries(body.files)){
    if(!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(name)||name.split('/').some(part=>part==='.'||part==='..')||typeof value!=='string'||(bytes+=Buffer.byteLength(value))>4*1024*1024)throw refused();
    files[name]=value;
  }
  const input=canonicalJson(body.input??null);if(Buffer.byteLength(input)>1024*1024)throw refused();
  if(body.dependencyIds!==undefined&&(!Array.isArray(body.dependencyIds)||body.dependencyIds.length>16))throw refused();
  return{files,code:body.code,input,dependencyIds:body.dependencyIds??[]};
}
/** Reuses the extension controller's durable physical reservations and cleanup proof.
 * Both operation families share the same root and one slot; uncertain cleanup remains occupied.
 * @param {any} config @param {{tools?:any,imageId?:()=>Promise<string>}} [hooks] */
export function createEvolutionVerificationController(config,hooks={}){
  const tools=hooks.tools??new ExtensionToolController({admittedDescriptors:[],stateRoot:path.join(config.dataDir,'.openscience','extension-controller'),dataDir:config.dataDir,runtimeDataVolume:config.runtimeDataVolume,adapterRoot:config.dataDir,inputRoot:config.dataDir,dockerBin:config.runtimeContainerBin,maxConcurrent:1,timeoutMs:30000});
  const imageId=hooks.imageId??(async()=>String((await tools.command(['image','inspect','--format','{{.Id}}',config.runtimeContainerImage])).stdout).trim());
  const preparer=createEvolutionDependencyPreparer(config,{tools,imageId});
  return{
    prepareDependencies:(body,options={})=>preparer.prepare(body.requests,options),
    async execute(body,{signal=undefined}={}){
      if(config.evolutionEnabled!==true)throw new HttpError(503,'product_state_unavailable','Evolution verification is disabled.');
      const request=verificationRequest(body);await tools.reconcileEvolutionAttempts?.();const image=await preparer.selectedImage(request.dependencyIds);if(!/^sha256:[a-f0-9]{64}$/.test(image))throw refused();
      const descriptor={imageId:image,artifactDigest:`sha256:${sha(canonicalJson(request))}`};
      const dependencyFiles=await preparer.executionFiles(request.dependencyIds);
      const install=Object.keys(dependencyFiles).length ? String.raw`
import subprocess,glob,zipfile,tarfile,pathlib
wheels=glob.glob('/dependencies/*.whl')
if wheels:
 subprocess.run(['python3','-m','pip','install','--disable-pip-version-check','--no-index','--no-deps','--target','/tmp/dependencies',*wheels],check=True,stdout=subprocess.DEVNULL)
 sys.path.insert(0,'/tmp/dependencies')
for source in glob.glob('/dependencies/*.zip')+glob.glob('/dependencies/*.tar.gz'):
 root=pathlib.Path('/tmp/sources')/pathlib.Path(source).name;root.mkdir(parents=True)
 iszip=source.endswith('.zip');archive=zipfile.ZipFile(source) if iszip else tarfile.open(source,'r:gz')
 members=archive.infolist() if iszip else archive.getmembers()
 assert len(members)<=1000
 total=0
 for member in members:
  name=member.filename if iszip else member.name
  parts=pathlib.PurePosixPath(name)
  assert not parts.is_absolute() and '..' not in parts.parts and not name.startswith('.')
  directory=member.is_dir() if iszip else member.isdir()
  if directory: continue
  assert (iszip and (member.external_attr>>16)&0o170000!=0o120000) or (not iszip and member.isfile())
  size=member.file_size if iszip else member.size;total+=size
  assert size<=4*1024*1024 and total<=16*1024*1024
  data=archive.read(member) if iszip else archive.extractfile(member).read()
  target=root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
 sys.path.insert(0,str(root))
 for child in root.iterdir():
  if child.is_dir(): sys.path.insert(0,str(child))
` : '';
      const code="import json,sys\nsys.path.insert(0,'/candidate')\n"+install+request.code;
      let output;
      try { output=await tools.run(descriptor,{jobId:randomUUID(),evolution:true}, {candidateFiles:request.files,dependencyFiles,mounts:['--tmpfs','/workspace:ro,noexec,nosuid,nodev,size=1m','--tmpfs','/runtime:ro,noexec,nosuid,nodev,size=1m','--env','HOME=/tmp','--env','PYTHONDONTWRITEBYTECODE=1','--workdir','/candidate'],entrypoint:['--entrypoint','python3'],command:['-c',code]},Buffer.from(request.input),signal??null,null,false); } catch(error) { if(error.joined===true&&error.code==='extension_contract_invalid')return{ok:false,status:'error',output:'Candidate execution failed.',joined:true,executionStarted:error.executionStarted===true};throw error; }
      return{ok:true,status:'ok',output:String(output).slice(-65536),joined:true,executionStarted:true};
    },
    admissionAvailable:()=>tools.admissionAvailable(),
    close:()=>hooks.tools?Promise.resolve():tools.close(),
  };
}
