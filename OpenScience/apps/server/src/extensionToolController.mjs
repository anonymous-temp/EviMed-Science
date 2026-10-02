import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {canonicalJson,canonicalExtensionCoordinate} from '@evimed/domain';
import {HttpError,assertNoSymlinkPath} from './security.mjs';
import {extensionRequestObject,extensionIdentifier} from './extensionAccess.mjs';
const exec=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const refusal=()=>new HttpError(400,'extension_contract_invalid','The isolated extension operation was refused.');
const unavailable=()=>new HttpError(503,'product_state_unavailable','Isolated execution could not be confirmed.');
const HEX=/^[a-f0-9]{64}$/,DIGEST=/^sha256:[a-f0-9]{64}$/;
/** @param {any} value */
function jsonBytes(value){
  const inspect=(item,depth=0)=>{if(depth>16)throw refusal();if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return;
    if(typeof item!=='object')throw refusal();const descriptors=Object.getOwnPropertyDescriptors(item);
    if(Array.isArray(item)){if(Object.getPrototypeOf(item)!==Array.prototype||Reflect.ownKeys(item).length!==item.length+1)throw refusal();}
    else if(![Object.prototype,null].includes(Object.getPrototypeOf(item)))throw refusal();
    for(const [key,field]of Object.entries(descriptors)){if(Array.isArray(item)&&key==='length')continue;if(!Object.hasOwn(field,'value')||!field.enumerable)throw refusal();inspect(field.value,depth+1);}
    if(Reflect.ownKeys(item).some(key=>typeof key!=='string'))throw refusal();};
  inspect(value);const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>65536)throw refusal();return bytes;
}
/** Trusted descriptor identity binds image, complete closure and platform adapter bytes. @param {any} descriptor */
export function extensionToolArtifactDigest(descriptor){return`sha256:${hash(canonicalJson({imageId:descriptor.imageId,closureExpectedSHA:descriptor.closureExpectedSHA,adapterDigest:descriptor.adapterDigest,coordinate:canonicalExtensionCoordinate(descriptor.coordinate),integrity:descriptor.integrity}))}`;}
/** Exact worker cancellation identity; no path, command, image or credential selection. @param {any} identity */
export function extensionPreparationIdentity(identity){
  extensionRequestObject(identity,['jobId','leaseToken','attempts','installationId','installationRevision','accountCreatedAt','projectTarget']);
  for(const key of ['jobId','leaseToken','installationId'])extensionIdentifier(identity[key]);
  if(!Number.isSafeInteger(identity.attempts)||identity.attempts<1||!Number.isSafeInteger(identity.installationRevision)||identity.installationRevision<1||typeof identity.accountCreatedAt!=='string')throw refusal();
  if(identity.projectTarget!==null){extensionRequestObject(identity.projectTarget,['ownerId','projectId','projectCreatedAt']);extensionIdentifier(identity.projectTarget.ownerId);extensionIdentifier(identity.projectTarget.projectId);if(typeof identity.projectTarget.projectCreatedAt!=='string')throw refusal();}
  return JSON.parse(jsonBytes(identity).toString());
}
/** Durable lease and signed operation scope; no execution authority comes from this DTO. @param {any} identity */
export function extensionExecutionIdentity(identity){
  extensionRequestObject(identity,['jobId','leaseToken','attempts','operationId','userId','projectId','accountCreatedAt','projectCreatedAt','runtimeGeneration','extensionGenerationHash','descriptorId','artifactDigest','installationId','installationRevision']);
  for(const key of ['jobId','leaseToken','operationId','userId','projectId','descriptorId','installationId'])extensionIdentifier(identity[key]);
  if(!Number.isSafeInteger(identity.attempts)||identity.attempts<1||!Number.isSafeInteger(identity.installationRevision)||identity.installationRevision<1
    ||!['accountCreatedAt','projectCreatedAt','runtimeGeneration'].every(key=>typeof identity[key]==='string'&&identity[key].length>0&&identity[key].length<=256)
    ||!HEX.test(identity.extensionGenerationHash)||!DIGEST.test(identity.artifactDigest))throw refusal();
  return JSON.parse(jsonBytes(identity).toString());
}
/** Fixed controller adapter. The injected resolver authorizes opaque operations and returns only trusted public/aggregate snapshots. */
export class ExtensionToolController{
  /** @param {{admittedDescriptors:any[],stateRoot:string,adapterRoot:string,inputRoot:string,resolveOperation?:any,resolveInputSnapshot?:any,resolvePreparation?:any,canRetireAttempt?:any,dockerBin?:string,maxConcurrent?:number,timeoutMs?:number}} options */
  constructor({admittedDescriptors,stateRoot,adapterRoot,inputRoot,resolveOperation=null,resolveInputSnapshot=null,resolvePreparation=null,canRetireAttempt=null,dockerBin='docker',maxConcurrent=2,timeoutMs=15000}){
    this.stateRoot=path.resolve(stateRoot);this.adapterRoot=path.resolve(adapterRoot);this.inputRoot=path.resolve(inputRoot);this.resolveOperation=resolveOperation;this.resolveInputSnapshot=resolveInputSnapshot;
    this.dockerBin=dockerBin;this.maxConcurrent=maxConcurrent;this.timeoutMs=timeoutMs;this.active=new Map();this.blocked=false;this.admitted=new Map();this.descriptors=new Map();
    this.closed=false;
    this.resolvePreparation=resolvePreparation;this.canRetireAttempt=canRetireAttempt;this.receiptCursor=0;
    if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>4||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)throw refusal();
    for(const item of admittedDescriptors){const descriptor=structuredClone(item);extensionIdentifier(descriptor.id);canonicalExtensionCoordinate(descriptor.coordinate);
      if(this.descriptors.has(descriptor.id)||!DIGEST.test(descriptor.imageId)||!DIGEST.test(descriptor.integrity)||!HEX.test(descriptor.closureExpectedSHA)||!HEX.test(descriptor.runnerSHA)||!HEX.test(descriptor.policySHA)||!HEX.test(descriptor.inventorySHA))throw refusal();
      const adapter=`sha256:${hash(canonicalJson({runnerSHA:descriptor.runnerSHA,policySHA:descriptor.policySHA,inventorySHA:descriptor.inventorySHA}))}`;
      if(descriptor.adapterDigest!==adapter||descriptor.artifactDigest!==extensionToolArtifactDigest(descriptor))throw refusal();this.descriptors.set(descriptor.id,Object.freeze(descriptor));}
  }
  /** @param {string} id */
  descriptor(id){const descriptor=this.descriptors.get(extensionIdentifier(id));if(!descriptor)throw refusal();return descriptor;}
  /** @param {string[]} args @param {number} [timeout] */
  async command(args,timeout=5000){try{return await exec(this.dockerBin,args,{timeout,maxBuffer:128*1024,env:{PATH:process.env.PATH}});}catch(error){throw Object.assign(unavailable(),{uncertain:Boolean(error?.killed),missing:/No such (?:object|container)/i.test(error?.stderr??'')});}}
  /** Controller state is bounded no-follow metadata, never candidate-supplied files. @param {string} target */
  async readRecord(target){
    await assertNoSymlinkPath(this.stateRoot,path.dirname(target));const file=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>4096)throw unavailable();const buffer=Buffer.alloc(4097),read=await file.read(buffer,0,buffer.length,0);if(read.bytesRead!==stat.size)throw unavailable();return JSON.parse(buffer.subarray(0,read.bytesRead).toString());}finally{await file.close();}
  }
  /** Capacity markers survive restart. Any unknown marker consumes a slot until independently reconciled. @param {any} identity @returns {Promise<{name:string,directory:string,marker:string,containerId?:string,artifactDigest?:string,identity:any}>} */
  async reserve(identity){
    if(this.blocked||this.closed)throw unavailable();
    await fs.mkdir(this.stateRoot,{recursive:true,mode:0o750});await assertNoSymlinkPath(path.join(path.parse(this.stateRoot).root,this.stateRoot.slice(path.parse(this.stateRoot).root.length).split(path.sep)[0]),this.stateRoot);const stat=await fs.lstat(this.stateRoot);if(!stat.isDirectory()||stat.isSymbolicLink())throw unavailable();
    let lock;try{lock=await fs.open(path.join(this.stateRoot,'admission.lock'),'wx',0o600);}catch{throw unavailable();}
    try{await this.pruneSettledLocked();if(await this.receipt(identity))throw unavailable();const records=(await fs.readdir(this.stateRoot)).filter(name=>name.endsWith('.json'));if(records.length>=this.maxConcurrent)throw unavailable();
      for(const record of records){let existing;try{existing=await this.readRecord(path.join(this.stateRoot,record));}catch{throw unavailable();}if(existing.state==='unknown'||existing.state==='reserved'&&![...this.active.values()].some(active=>active.scope.name===existing.name)||identity?.jobId&&existing.identity?.jobId===identity.jobId)throw unavailable();}
      const name=`evimed-extension-tool-${randomUUID()}`,directory=path.join(this.stateRoot,name),marker=path.join(this.stateRoot,name+'.json');
      await fs.mkdir(directory,{mode:0o755});await fs.writeFile(marker,JSON.stringify({name,identity,state:'reserved'}),{flag:'wx',mode:0o600});return{name,directory,marker,identity};
    }finally{await lock.close();await fs.unlink(path.join(this.stateRoot,'admission.lock'));}
  }
  /** A bounded exact-identity tombstone prevents late dispatch after an acknowledged cancel. @param {any} identity */
  receiptPath(identity){return path.join(this.stateRoot,'settled',hash(canonicalJson(identity))+'.json');}
  /** @param {any} identity */
  async receipt(identity){
    const target=this.receiptPath(identity);let file;
    try{file=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if(error.code==='ENOENT')return null;throw unavailable();}
    try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>4096)throw unavailable();const value=JSON.parse(await file.readFile('utf8'));
      if(canonicalJson(value.identity)!==canonicalJson(identity)||value.physicallyAbsent!==true||value.joined!==true)throw unavailable();return value;
    }finally{await file.close();}
  }
  /** Never silently evict a cancellation identity that a late request could reuse. @param {any} identity @param {string|null} containerId */
  async recordSettled(identity,containerId=null){
    const directory=path.dirname(this.receiptPath(identity));await fs.mkdir(directory,{recursive:true,mode:0o700});
    const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw unavailable();
    if(await this.receipt(identity))return;
    if((await fs.readdir(directory)).length>=1024)throw unavailable();
    await fs.writeFile(this.receiptPath(identity),JSON.stringify({identity,containerId,joined:true,physicallyAbsent:true,settled:true}),{flag:'wx',mode:0o600}).catch(async error=>{if(error.code!=='EEXIST'||!await this.receipt(identity))throw error;});
  }
  /** At most sixteen receipts per pass. Only trusted terminal-job/retired-epoch facts permit deletion.
   * The admission lock is already held; no age or caller reset is accepted. */
  async pruneSettledLocked(){
    if(!this.canRetireAttempt)return{retired:0};let names;
    try{names=await fs.readdir(path.join(this.stateRoot,'settled'));}catch(error){if(error.code==='ENOENT')return{retired:0};throw unavailable();}
    if(names.length>1024||names.some(name=>!HEX.test(name.slice(0,-5))||!name.endsWith('.json')))throw unavailable();
    names.sort();let retired=0;const start=this.receiptCursor%Math.max(1,names.length),batch=Array.from({length:Math.min(16,names.length)},(_,index)=>names[(start+index)%names.length]);this.receiptCursor=start+batch.length;
    for(const name of batch){const record=await this.readRecord(path.join(this.stateRoot,'settled',name));
      const identity=record.identity?.operationId?extensionExecutionIdentity(record.identity):extensionPreparationIdentity(record.identity);
      if(this.receiptPath(identity)!==path.join(this.stateRoot,'settled',name)||record.joined!==true||record.physicallyAbsent!==true)throw unavailable();
      if(this.active.has(identity.jobId)||(await this.markers(identity)).length||await this.canRetireAttempt(identity)!==true)continue;
      if(record.containerId!==null){if(!HEX.test(record.containerId??''))throw unavailable();try{await this.command(['inspect','--format','{{.Id}}',record.containerId]);continue;}catch(error){if(!error.missing)throw error;}}
      if(await this.canRetireAttempt(identity)!==true)continue;await fs.unlink(this.receiptPath(identity));retired++;
    }
    return{retired};
  }
  /** Protected maintenance hook; composition may call periodically. No API route exposes it. */
  async gcSettled(){
    if(!this.canRetireAttempt||this.closed)return{retired:0};try{await fs.access(this.stateRoot);}catch(error){if(error.code==='ENOENT')return{retired:0};throw unavailable();}
    let lock;try{lock=await fs.open(path.join(this.stateRoot,'admission.lock'),'wx',0o600);}catch{return{retired:0};}
    try{return await this.pruneSettledLocked();}finally{await lock.close();await fs.unlink(path.join(this.stateRoot,'admission.lock'));}
  }
  /** Cleanup addresses immutable Docker IDs and independently checks fixed ownership labels. @param {any} scope */
  async stopPhysical(scope){
    if(!/^[a-f0-9]{64}$/.test(scope.containerId??''))throw unavailable();let inspected;
    try{inspected=await this.command(['inspect','--format','{{json .Config.Labels}}',scope.containerId]);}catch(error){if(error.missing)return;throw error;}
    const labels=JSON.parse(inspected.stdout);
    if(labels?.['com.evimed.extension-tool']!=='owned'||labels?.['com.evimed.extension-scope']!==scope.name||labels?.['com.evimed.extension-artifact']!==scope.artifactDigest||labels?.['com.evimed.extension-attempt']!==hash(canonicalJson(scope.identity)))throw unavailable();
    try{await this.command(['rm','-f',scope.containerId]);}catch(error){if(!error.missing)throw error;}
  }
  /** No slot is released until the start client joined and Docker confirms that exact ID is absent. @param {any} scope */
  async provePhysicalAbsence(scope){await this.stopPhysical(scope);
    try{await this.command(['inspect','--format','{{.Id}}',scope.containerId]);throw unavailable();}catch(error){if(!error.missing)throw error;}
  }
  /** @param {any} scope */
  async remove(scope){await this.provePhysicalAbsence(scope);await fs.rm(scope.directory,{recursive:true,force:true});await fs.unlink(scope.marker);}
  /** @param {any} scope @param {Buffer|null} input @param {AbortSignal} signal */
  async startContainer(scope,input,signal){
    return new Promise((resolve,reject)=>{
      const child=spawn(this.dockerBin,['start','-ai',scope.containerId],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});let bytes=0;const stdout=[];let overflow=false;
      let killTimer,removal=null;const terminate=()=>{if(removal)return;removal=this.stopPhysical(scope).catch(()=>null);killTimer=setTimeout(()=>child.kill('SIGKILL'),5500);killTimer.unref();};signal.addEventListener('abort',terminate,{once:true});if(signal.aborted)terminate();
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>12*1024*1024){overflow=true;terminate();}else stdout.push(chunk);});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.stdin.end(input??undefined);
      let spawnFailure=false;child.once('error',()=>{spawnFailure=true;});
      child.once('close',async code=>{clearTimeout(killTimer);if(removal)await removal;signal.removeEventListener('abort',terminate);if(signal.aborted)reject(Object.assign(unavailable(),{canceled:signal.reason!=='timeout'}));else if(spawnFailure)reject(unavailable());else if(code!==0||overflow)reject(refusal());else resolve(Buffer.concat(stdout).toString('utf8'));});
    });
  }
  /** @param {any} descriptor @param {any} identity @param {any} args @param {Buffer|null} input @param {AbortSignal|null} signal @param {any} [snapshot] */
  async run(descriptor,identity,args,input,signal=null,snapshot=null,persist=true){
    const scope=await this.reserve(identity);scope.artifactDigest=descriptor.artifactDigest;const abort=new AbortController();let created=false,uncertain=false,physicallyAbsent=false,result,failure;
    const relay=()=>abort.abort();signal?.addEventListener('abort',relay,{once:true});if(signal?.aborted)relay();
    const key=identity?.jobId??scope.name;let settle=(_value)=>{};const settled=new Promise(resolve=>{settle=resolve;});
    this.active.set(key,{identity,abort,settled,scope});const timer=setTimeout(()=>abort.abort('timeout'),this.timeoutMs);timer.unref();
    try{
      if(snapshot){await fs.chmod(scope.directory,0o755);await fs.writeFile(path.join(scope.directory,'input.'+snapshot.format),snapshot.bytes,{mode:0o444});await fs.writeFile(path.join(scope.directory,'manifest.json'),JSON.stringify({resources:{[snapshot.resourceId]:{file:'input.'+snapshot.format,format:snapshot.format,bytes:snapshot.bytes.length,sha256:snapshot.sha256,dataClass:snapshot.dataClass}}}),{mode:0o444});for(const name of ['input.'+snapshot.format,'manifest.json'])await fs.chmod(path.join(scope.directory,name),0o444);}
      if(abort.signal.aborted)throw Object.assign(unavailable(),{canceled:abort.signal.reason!=='timeout'});
      try{const createdContainer=await this.command(['create','--pull','never','-i','--name',scope.name,'--label','com.evimed.extension-tool=owned','--label',`com.evimed.extension-scope=${scope.name}`,'--label',`com.evimed.extension-artifact=${scope.artifactDigest}`,'--label',`com.evimed.extension-attempt=${hash(canonicalJson(identity))}`,'--network','none','--read-only','--user','10001:10001','--cpus','1','--memory','512m','--pids-limit','64','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,nodev,size=64m',...args.mounts,...(snapshot?['--mount',`type=bind,source=${scope.directory},target=/input,readonly`]:[]),...args.entrypoint,descriptor.imageId,...args.command]);scope.containerId=createdContainer.stdout.trim();if(!/^[a-f0-9]{64}$/.test(scope.containerId))throw unavailable();created=true;await fs.writeFile(scope.marker,JSON.stringify({name:scope.name,containerId:scope.containerId,artifactDigest:scope.artifactDigest,identity,state:'reserved'}),{mode:0o600});}catch(error){uncertain=true;throw error;}
      if(abort.signal.aborted)throw Object.assign(unavailable(),{canceled:abort.signal.reason!=='timeout'});
      result=await this.startContainer(scope,input,abort.signal);
    }catch(error){failure=error;}finally{
      clearTimeout(timer);signal?.removeEventListener('abort',relay);
      try{if(!uncertain){if(created)await this.provePhysicalAbsence(scope);await fs.rm(scope.directory,{recursive:true,force:true});if(persist)await this.recordSettled(identity,scope.containerId??null);await fs.unlink(scope.marker);physicallyAbsent=true;}}catch{ /* Keep the durable marker and refuse capacity reuse. */ }
      if(!physicallyAbsent){this.blocked=true;try{await fs.writeFile(scope.marker,JSON.stringify({name:scope.name,containerId:scope.containerId??null,artifactDigest:scope.artifactDigest,identity,state:'unknown'}),{mode:0o600});}catch{ /* The initial durable marker remains; restarted admission treats orphan reservations as unknown. */ }}
      this.active.delete(key);settle({physicallyAbsent});
    }
    if(!physicallyAbsent)throw Object.assign(unavailable(),{joined:false});if(failure)throw Object.assign(failure,{joined:true});return result;
  }
  /** @param {any} body @param {{signal?:AbortSignal}} options */
  async prepare(body,{signal}={}){
    extensionRequestObject(body,['descriptorId','identity']);const descriptor=this.descriptor(body.descriptorId),identity=extensionPreparationIdentity(body.identity);
    await this.authorizePreparation(identity,descriptor);const result=await this.inspectArtifact(descriptor,identity,signal);await this.authorizePreparation(identity,descriptor);return result;
  }
  /** The privileged resolver supplies current leased ProductJobs identity, never customer metadata. @param {any} identity @param {any} descriptor */
  async authorizePreparation(identity,descriptor){
    if(!this.resolvePreparation)throw unavailable();const actual=await this.resolvePreparation(identity,descriptor);
    if(!actual||actual.descriptorId!==descriptor.id||actual.artifactDigest!==descriptor.artifactDigest||canonicalJson(actual.identity)!==canonicalJson(identity))throw refusal();
  }
  /** Cold admission uses the same bounded physical inventory, before candidate execution. @param {any} descriptor @param {any} identity @param {AbortSignal} [signal] @param {boolean} [persist] */
  async inspectArtifact(descriptor,identity,signal,persist=true){
    const script=path.join(this.adapterRoot,'image-inventory.mjs'),file=await fs.open(script,constants.O_RDONLY|constants.O_NOFOLLOW);let content;
    try{if(!(await file.stat()).isFile())throw refusal();content=await file.readFile();}finally{await file.close();}
    if(hash(content)!==descriptor.inventorySHA)throw refusal();
    const output=await this.run(descriptor,identity,{mounts:['--mount',`type=bind,source=${script},target=/proof/inventory.mjs,readonly`,'--env',`COWORK_EXPECTED_CLOSURE_SHA256=${descriptor.closureExpectedSHA}`],entrypoint:['--entrypoint','sh'],command:['-ec','node /proof/inventory.mjs; sha256sum /opt/cowork/runner.mjs /opt/cowork/policy.mjs']},null,signal,null,persist);
    const lines=String(output).trim().split('\n');if(JSON.parse(lines[0])?.allBytesModesAndDirectoriesMatch!==true||lines[1]?.split(/\s+/)[0]!==descriptor.runnerSHA||lines[2]?.split(/\s+/)[0]!==descriptor.policySHA)throw refusal();
    this.admitted.set(descriptor.id,descriptor.artifactDigest);return{artifactDigest:descriptor.artifactDigest,integrity:descriptor.integrity,coordinate:canonicalExtensionCoordinate(descriptor.coordinate),qualified:false,joined:true};
  }
  /** The trusted resolver returns signed scope, not a boolean that can be
   * reused for another admitted descriptor. @param {any} descriptor @param {string} operationId @param {any} request */
  async authorizeOperation(descriptor,operationId,request,identity=null){
    if(!this.resolveOperation)throw refusal();
    const scope=await this.resolveOperation(operationId,request,{descriptorId:descriptor.id,artifactDigest:descriptor.artifactDigest},identity);
    if(!scope||scope.descriptorId!==descriptor.id||scope.artifactDigest!==descriptor.artifactDigest)throw refusal();
    if(identity&&Object.entries(scope).some(([key,value])=>identity[key]!==value))throw refusal();
    return scope;
  }
  /** @param {any} body @param {{signal?:AbortSignal}} options */
  async execute(body,{signal}={}){
    extensionRequestObject(body,['descriptorId','operationId','request','identity']);const descriptor=this.descriptor(body.descriptorId),identity=extensionExecutionIdentity(body.identity);extensionIdentifier(body.operationId);
    if(identity.descriptorId!==descriptor.id||identity.artifactDigest!==descriptor.artifactDigest||identity.operationId!==body.operationId)throw refusal();
    const request=body.request;extensionRequestObject(request,request?.operation==='doc_read'?['operation','resourceId','options']:['operation','targetId','format','spec'],request?.operation==='doc_read'?['operation','resourceId']:['operation','targetId','format','spec']);
    if(!['doc_read','doc_write'].includes(request.operation))throw refusal();
    await this.authorizeOperation(descriptor,body.operationId,request,identity);
    if(this.admitted.get(descriptor.id)!==descriptor.artifactDigest){await this.inspectArtifact(descriptor,identity,signal,false);await this.authorizeOperation(descriptor,body.operationId,request,identity);}const bytes=jsonBytes(request);let snapshot=null;
    if(request.operation==='doc_read'){
      if(typeof request.resourceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(request.resourceId)||!this.resolveInputSnapshot)throw refusal();
      const selected=await this.resolveInputSnapshot(body.operationId,request.resourceId,identity);
      if(!selected||!['public','aggregate'].includes(selected.dataClass)||!['docx','pdf','xlsx','ipynb'].includes(selected.format)||!HEX.test(selected.sha256)||!Number.isSafeInteger(selected.bytes)||selected.bytes<1||selected.bytes>8*1024*1024)throw refusal();
      const filePath=path.resolve(selected.filePath),parent=await fs.realpath(path.dirname(filePath));if(!parent.startsWith(this.inputRoot+path.sep)&&parent!==this.inputRoot)throw refusal();
      const file=await fs.open(filePath,constants.O_RDONLY|constants.O_NOFOLLOW);let data;try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size!==selected.bytes)throw refusal();const buffer=Buffer.alloc(selected.bytes+1);const read=await file.read(buffer,0,buffer.length,0);if(read.bytesRead!==selected.bytes)throw refusal();data=buffer.subarray(0,read.bytesRead);}finally{await file.close();}
      if(hash(data)!==selected.sha256)throw refusal();snapshot={...selected,bytes:data,resourceId:request.resourceId};
    }
    const output=await this.run(descriptor,identity,{mounts:[],entrypoint:[],command:[]},bytes,signal,snapshot);const result=JSON.parse(String(output));if(result?.ok!==true)throw refusal();
    await this.authorizeOperation(descriptor,body.operationId,request,identity);return{ok:true,data:result.data,identity,joined:true,physicallyAbsent:true};
  }
  /** Matching private attempt identity only. Unknown, restarted or mismatched scopes never receive a joined acknowledgment. @param {any} identity */
  async cancelPreparation(identity){return this.cancelIdentity(extensionPreparationIdentity(identity));}
  /** @param {any} identity */
  async cancelExecution(identity){return this.cancelIdentity(extensionExecutionIdentity(identity));}
  /** Reads only controller-owned, bounded ordinary marker files. @param {any} identity */
  async markers(identity){
    let names;try{names=await fs.readdir(this.stateRoot);}catch(error){if(error.code==='ENOENT')return[];throw unavailable();}
    if(names.length>2*this.maxConcurrent+4)throw unavailable();const found=[];
    for(const name of names.filter(entry=>entry.endsWith('.json'))){const marker=path.join(this.stateRoot,name),value=await this.readRecord(marker);
      if(value.identity?.jobId===identity.jobId&&canonicalJson(value.identity)!==canonicalJson(identity))throw unavailable();
      if(canonicalJson(value.identity)===canonicalJson(identity)){if(!/^evimed-extension-tool-[a-f0-9-]{36}$/.test(value.name)||name!==value.name+'.json')throw unavailable();found.push({...value,marker,directory:path.join(this.stateRoot,value.name)});}}
    return found;
  }
  /** Restart cancellation requires the immutable create ID. Unknown creation never receives an ACK. @param {any} identity */
  async cancelIdentity(identity){
    const active=this.active.get(identity.jobId);
    if(active){if(canonicalJson(active.identity)!==canonicalJson(identity))throw unavailable();active.abort.abort('cancel');const outcome=await active.settled;if(!outcome.physicallyAbsent)throw unavailable();await this.recordSettled(identity,active.scope.containerId??null);return{identity,settled:true,joined:true,physicallyAbsent:true};}
    const receipt=await this.receipt(identity);if(receipt&&(await this.markers(identity)).length===0)return receipt;
    // The same admission lock serializes early cancellation against reservation.
    await fs.mkdir(this.stateRoot,{recursive:true,mode:0o750});await assertNoSymlinkPath(path.join(path.parse(this.stateRoot).root,this.stateRoot.slice(path.parse(this.stateRoot).root.length).split(path.sep)[0]),this.stateRoot);let lock;try{lock=await fs.open(path.join(this.stateRoot,'admission.lock'),'wx',0o600);}catch{throw unavailable();}
    try{const records=await this.markers(identity);for(const scope of records){if(!HEX.test(scope.containerId??'')||!DIGEST.test(scope.artifactDigest??''))throw unavailable();await this.stopPhysical(scope);try{await this.command(['inspect','--format','{{.Id}}',scope.containerId]);throw unavailable();}catch(error){if(!error.missing)throw error;}}
      for(const scope of records)await fs.rm(scope.directory,{recursive:true,force:true});await this.recordSettled(identity,records[0]?.containerId??null);for(const scope of records)await fs.unlink(scope.marker);this.blocked=false;return{identity,settled:true,joined:true,physicallyAbsent:true};
    }finally{await lock.close();await fs.unlink(path.join(this.stateRoot,'admission.lock'));}
  }
  /** A missing name alone is never treated as proof of a completed owned attempt. @param {any} input */
  async executionStatus(input){const identity=extensionExecutionIdentity(input);
    const active=this.active.get(identity.jobId);if(active&&canonicalJson(active.identity)===canonicalJson(identity))return{identity,state:'active',joined:false,physicallyAbsent:false};
    if((await this.markers(identity)).length===0){const receipt=await this.receipt(identity);if(receipt)return{...receipt,state:'absent'};}
    return{identity,state:'unknown',joined:false,physicallyAbsent:false};}
  async close(){this.closed=true;const active=[...this.active.values()];for(const item of active)item.abort.abort('cancel');for(const item of active){const result=await item.settled;if(!result.physicallyAbsent)throw unavailable();}}
  async admissionAvailable(){if(this.blocked||this.closed)return false;try{await this.gcSettled();const directory=path.join(this.stateRoot,'settled');let receipts=[];try{receipts=await fs.readdir(directory);}catch(error){if(error.code!=='ENOENT')throw error;}if(receipts.length>=1024)return false;const records=(await fs.readdir(this.stateRoot)).filter(name=>name.endsWith('.json'));if(records.length>=this.maxConcurrent)return false;for(const name of records){const marker=await this.readRecord(path.join(this.stateRoot,name));if(marker.state==='unknown'||marker.state==='reserved'&&![...this.active.values()].some(active=>active.scope.name===marker.name))return false;}return true;}catch(error){return error.code==='ENOENT';}}
  handlers(){return{'extension/tool/admission':async body=>{extensionRequestObject(body,[]);return{available:await this.admissionAvailable()};},'extension/tool/prepare':body=>this.prepare(body),'extension/tool/execute':body=>this.execute(body),'extension/tool/cancel':body=>{extensionRequestObject(body,['kind','identity']);if(body.kind==='execute')return this.cancelExecution(body.identity);if(body.kind==='prepare')return this.cancelPreparation(body.identity);throw refusal();},'extension/tool/status':body=>{extensionRequestObject(body,['identity']);return this.executionStatus(body.identity);}};}
}
