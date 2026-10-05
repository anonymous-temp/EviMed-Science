import {createEvolutionDependencyPreparer} from "./evolutionDependencyPreparation.mjs";
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {ExtensionToolController} from './extensionToolController.mjs';
import {HttpError} from './security.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const refused=()=>new HttpError(400,'extension_contract_invalid','Invalid isolated verification input.');
/** The longest program one execution can carry. It travels as a single `python3 -c <program>` argument, and Linux refuses
 * one argv string over 131,072 bytes (`E2BIG`) — a failed `docker create`, which an executor counts as an uncertain
 * attempt. The program is the caller's code plus a fixed preamble of a few KiB, so the bound sits well inside the OS limit. */
export const EVOLUTION_EXECUTION_CODE_MAX_BYTES=100000;
/** Candidate bytes only: no path, credential, image, workspace or socket selections. @param {any} body */
export function verificationRequest(body){
  if(!body||Object.keys(body).some(key=>!['files','code','input','dependencyIds'].includes(key))||typeof body.code!=='string'||Buffer.byteLength(body.code)>EVOLUTION_EXECUTION_CODE_MAX_BYTES||!body.files||typeof body.files!=='object'||Array.isArray(body.files))throw refused();
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
/** Candidate execution runs on an executor of its own: the same durable physical reservations and cleanup proof as the
 * extension tools, but a separate instance, state root, slot count and timeout (`evolutionExecutionMaxConcurrency`,
 * `evolutionExecutionTimeoutMs`). It used to be handed the very controller that serves tenants' document tools, so
 * every static check, self test and hidden-case replicate took one of its two slots and its fail-fast admission lock,
 * and any failed or timed-out `docker create` of an attempt latched its sticky `blocked` flag — until the runtime
 * controller was restarted, every tenant's document read and write answered 503. `hooks.tools` is for tests.
 * Uncertain cleanup of its own attempts still holds its own slot.
 * @param {any} config @param {{tools?:any,imageId?:()=>Promise<string>}} [hooks] */
export function createEvolutionVerificationController(config,hooks={}){
  const tools=hooks.tools??new ExtensionToolController({admittedDescriptors:[],stateRoot:path.join(config.dataDir,'.openscience','evolution-controller'),dataDir:config.dataDir,runtimeDataVolume:config.runtimeDataVolume,adapterRoot:config.dataDir,inputRoot:config.dataDir,dockerBin:config.runtimeContainerBin,maxConcurrent:config.evolutionExecutionMaxConcurrency??1,timeoutMs:config.evolutionExecutionTimeoutMs??30000});
  const imageId=hooks.imageId??(async()=>String((await tools.command(['image','inspect','--format','{{.Id}}',config.runtimeContainerImage])).stdout).trim());
  const preparer=createEvolutionDependencyPreparer(config,{tools,imageId});
  return{
    prepareDependencies:(body,options={})=>preparer.prepare(body.requests,options),
    async execute(body,{signal=undefined}={}){
      if(config.evolutionEnabled!==true)throw new HttpError(503,'product_state_unavailable','Evolution verification is disabled.');
      const request=verificationRequest(body);await tools.reconcileEvolutionAttempts?.();
      /** @type {string} */
      let image;
      try{image=await preparer.selectedImage(request.dependencyIds);}
      catch(error){
        if(error?.code!=='ENOENT')throw error;
        // The prepared set is keyed by the runtime image's identity, so every release that changes the image leaves
        // each published tool with dependencies unprepared — and only the build path ever prepared. Prepare once here:
        // the allowlist and exact digests already bound what can be fetched, and concurrent callers join one acquisition.
        // An acquisition that cannot be done now is a named, retryable refusal, never a raw ENOENT.
        try{await preparer.prepare(request.dependencyIds,{signal});image=await preparer.selectedImage(request.dependencyIds);}
        catch(failure){throw failure instanceof HttpError?failure:new HttpError(503,'evolution_execution_unavailable','The tool\'s dependencies could not be prepared now; the call can be retried.');}
      }
      if(!/^sha256:[a-f0-9]{64}$/.test(image))throw refused();
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
