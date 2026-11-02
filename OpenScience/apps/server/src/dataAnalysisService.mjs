/** A durable facade over the existing project, conversation and run ledger; no second execution engine. */
import { randomUUID } from 'node:crypto';
import { isDataAnalysisProject } from './internalProjects.mjs';
export { isDataAnalysisProject } from './internalProjects.mjs';
import { HttpError, openScopedDirectoryNoFollow } from './security.mjs';
import { analysisFields, analysisString, analysisFilename, analysisInputBytes } from './dataAnalysisInputs.mjs';
import { analysisDigest, analysisSnapshotRoot, analysisRead, keepAnalysisBytes, snapshotAnalysisRun } from './dataAnalysisArtifacts.mjs';

const KIND='data-analysis';
const terminal=run=>['succeeded','failed','cancelled','canceled'].includes(run?.status);
export function assertNotDataAnalysisProject(project) {
  if(isDataAnalysisProject(project))throw new HttpError(409,'analysis_project_reserved','Use the data-analysis API to modify this dedicated project.');
}
function requestId(value) {const id=analysisString(value,100);if(!/^[A-Za-z0-9._:-]+$/.test(id))throw new HttpError(400,'analysis_payload_invalid','requestId must use letters, digits, dot, colon, underscore or hyphen.');return id;}
function conflict(){return new HttpError(409,'analysis_busy','This analysis has unfinished work. Read or cancel its current turn before starting another.');}

/** Bind using the real session store contract; runtimeAgent is derived from the registry, never an accepted input field.
 * @param {any} project @param {{registry:any,runtime:any,sessions:any}} dependencies */
export async function createDataAnalysisSession(project,{registry,runtime,sessions}){
  const agent=(await registry).get('statistical-analysis');
  if(!agent)throw new HttpError(503,'analysis_capability_unavailable','The analysis capability is unavailable.');
  const session=await runtime.createRuntimeSession(project);
  await sessions.put(project,session.id,{mode:'specialist',agentId:agent.id,agentVersion:agent.version});
  return session.id;
}

export class DataAnalysisService {
  /** @param {any} dependencies */
  constructor(dependencies){
    this.documents=dependencies.documents;this.store=dependencies.store;this.config=dependencies.config;
    this.createProject=dependencies.createProject;this.upload=dependencies.upload;this.createSession=dependencies.createSession;
    this.dispatch=dependencies.dispatch;this.listRuns=dependencies.listRuns;this.cancelRun=dependencies.cancel;
    this.transport=dependencies.transport;this.withDispatchLock=dependencies.withDispatchLock;
  }
  /** Shared run-ledger admission also covers native adoption and internal schedulers. Managed children settle inside the admitted root run.
   * @param {any} project @param {{sessionId:string,dispatchId:string|null,dispatchFingerprint:string|null}} input */
  async authorizeReservation(project,input){
    if(!isDataAnalysisProject(project))return;
    const id=`ana_${project.id.slice(3)}`,record=await this.documents.get(project.userId,KIND,id);
    const active=record?.payload.active;
    if(active?.kind!=='turn'||active.dispatchId!==input.dispatchId||record.payload.sessionId!==input.sessionId)throw conflict();
    const turn=await this.documents.get(project.userId,KIND,active.id);
    if(!turn||turn.payload.status!=='dispatching'||turn.payload.fingerprint!==input.dispatchFingerprint||turn.payload.result)throw conflict();
  }
  /** @param {any} user @param {string} id */
  async record(user,id){
    if(!/^ana_[a-f0-9]{40}$/.test(id))throw new HttpError(404,'analysis_not_found','Analysis not found.');
    const record=await this.documents.get(user.id,KIND,id);
    if(!record)throw new HttpError(404,'analysis_not_found','Analysis not found.');
    await this.store.requireProject(user,record.payload.projectId);
    return record;
  }
  /** @param {any} user @param {any} record @param {any} payload */
  save(user,record,payload){return this.documents.put(user.id,KIND,record.id,payload,{expectedRevision:record.revision,projectId:payload.projectId});}
  /** @param {any} user @param {string} id */
  async root(user,id){
    const root=analysisSnapshotRoot(this.config,user.id,id);
    const opened=await openScopedDirectoryNoFollow(this.config.dataDir,root,{create:true});await opened.handle.close();return root;
  }
  /** @param {any} user @param {any} body */
  async create(user,body){
    analysisFields(body,['name','requestId']);const name=analysisString(body.name,120),key=requestId(body.requestId);
    const digest=analysisDigest(`${user.id}:${key}`),id=`ana_${digest.slice(0,40)}`,projectId=`da-${digest.slice(0,40)}`;
    const existing=await this.documents.get(user.id,KIND,id);
    if(existing){if(existing.payload.name!==name)throw new HttpError(409,'analysis_request_conflict','This requestId was used with different content.');return this.finishCreate(user,existing);}
    // Create the reservation before the project. Concurrent create calls share the same deterministic identity.
    let record;
    try {record=await this.documents.put(user.id,KIND,id,{id,projectId,name,requestId:key,phase:'creating',inputs:[],turnIds:[],sessionId:null,active:null},{expectedRevision:0});}
    catch(error){if(error?.code!=='product_revision_conflict')throw error;const found=await this.documents.get(user.id,KIND,id);if(found?.payload.name!==name)throw new HttpError(409,'analysis_request_conflict','This requestId was used with different content.');return this.finishCreate(user,found);}
    return this.finishCreate(user,record);
  }
  /** A reserved deterministic project can be completed again after a crash, without dispatching work. @param {any} user @param {any} record */
  async finishCreate(user,record){
    if(record.payload.phase==='ready')return record.payload;
    try{await this.createProject(user,{id:record.payload.projectId,name:record.payload.name});}
    catch(error){if(error?.code!=='project_exists')throw error;await this.store.requireProject(user,record.payload.projectId);}
    try{return (await this.save(user,record,{...record.payload,phase:'ready'})).payload;}
    catch(error){if(error?.code!=='product_revision_conflict')throw error;return (await this.documents.get(user.id,KIND,record.id)).payload;}
  }
  /** @param {any} user @param {string} id */
  async get(user,id){const record=await this.record(user,id);return record.payload;}
  /** @param {any} user @param {string} id @param {any} body */
  async input(user,id,body){
    const {filename,buffer,provenance}=await analysisInputBytes(user,body,this.config,this.transport);
    return this.rawInput(user,id,filename,buffer,provenance);
  }
  /** @param {any} user @param {string} id @param {string} rawFilename @param {Buffer} buffer @param {any} provenance */
  async rawInput(user,id,rawFilename,buffer,provenance={kind:'upload'}){
    const filename=analysisFilename(rawFilename);
    if(!buffer.length||buffer.length>this.config.dataAnalysisMaxInputBytes)throw new HttpError(413,'analysis_input_limit','The input is empty or exceeds the byte limit.');
    let record=await this.record(user,id);
    if(record.payload.inputs.length>=64)throw new HttpError(409,'analysis_input_limit','An analysis supports at most 64 inputs.');
    const sha256=analysisDigest(buffer),inputId=`in_${analysisDigest(`${filename}:${sha256}:${JSON.stringify(provenance)}`).slice(0,32)}`;
    const existing=record.payload.inputs.find(item=>item.id===inputId);if(existing)return existing;
    if(record.payload.active?.kind!=='input'||record.payload.active?.id!==inputId)record=await this.idle(user,id);
    const active={kind:'input',id:inputId,token:randomUUID()};
    record=await this.save(user,record,{...record.payload,active});
    try{
      const root=await this.root(user,id);await keepAnalysisBytes(root,buffer,this.config.dataAnalysisMaxSnapshotBytes);
      const entry={id:inputId,filename,sha256,bytes:buffer.length,path:`analysis-inputs/${inputId}/${filename}`,provenance:{...provenance,acquiredAt:new Date().toISOString()}};
      const project=await this.store.requireProject(user,record.payload.projectId);
      await this.upload(user,project,entry.path,buffer);
      await this.save(user,record,{...record.payload,active:null,inputs:[...record.payload.inputs,entry]});return entry;
    }catch(error){await this.save(user,record,{...record.payload,active:null}).catch(()=>{});throw error;}
  }
  /** Resolve terminal work and freeze its actual files before granting another writer. @param {any} user @param {string} id */
  async idle(user,id){
    let record=await this.record(user,id);
    if(record.payload.phase!=='ready')throw conflict();
    if(record.payload.active?.kind==='turn'){
      await this.result(user,id,record.payload.active.id);record=await this.record(user,id);
    }
    if(record.payload.active)throw conflict();
    return record;
  }
  /** @param {any} user @param {string} id @param {any} body */
  async turn(user,id,body){
    analysisFields(body,['question','requestId']);const question=analysisString(body.question,16_000),key=requestId(body.requestId);
    const turnId=`turn_${analysisDigest(`${id}:${key}`).slice(0,40)}`,fingerprint=analysisDigest(question);
    let current=await this.record(user,id);
    const previous=await this.documents.get(user.id,KIND,turnId);
    if(previous){
      if(previous.payload.fingerprint!==fingerprint)throw new HttpError(409,'analysis_request_conflict','This requestId was used with different content.');
      return this.dispatchReservedTurn(user,id,turnId);
    }
    current=await this.idle(user,id);
    if(current.payload.turnIds.length>=128)throw new HttpError(409,'analysis_turn_limit','An analysis supports at most 128 turns.');
    const dispatchId=`da_${analysisDigest(`${user.id}:${turnId}`).slice(0,40)}`;
    // This CAS is the cross-process reservation. A crash never expires it into a duplicate charge.
    /** @type {any} */
    let turn;
    try {
    await this.documents.database.transaction(async client=>{
      current=await this.documents.put(user.id,KIND,id,{...current.payload,active:{kind:'turn',id:turnId,dispatchId},turnIds:[...current.payload.turnIds,turnId]},
        {expectedRevision:current.revision,projectId:current.payload.projectId,transactionClient:client});
      turn=await this.documents.put(user.id,KIND,turnId,{id:turnId,analysisId:id,projectId:current.payload.projectId,requestId:key,question,fingerprint,dispatchId,status:'preparing',runId:null},
        {expectedRevision:0,projectId:current.payload.projectId,transactionClient:client});
    });
    } catch(error) {
      if(error?.code!=='product_revision_conflict')throw error;
      const known=await this.documents.get(user.id,KIND,turnId);
      if(!known)throw error;
      if(known.payload.fingerprint!==fingerprint)throw new HttpError(409,'analysis_request_conflict','This requestId was used with different content.');
      return this.dispatchReservedTurn(user,id,turnId);
    }
    return this.dispatchReservedTurn(user,id,turn.id);
  }
  /** A lock-only transaction serializes original dispatch and crash recovery across processes. Metadata writes retain
   * their own commits; the lock ends at prompt acknowledgement, never at analytical completion.
   * @param {any} user @param {string} id @param {string} turnId */
  async dispatchReservedTurn(user,id,turnId){
    return this.withDispatchLock(user.id,turnId,async assertLock=>{
      if(!assertLock)return this.result(user,id,turnId);
      const current=await this.record(user,id),turn=await this.documents.get(user.id,KIND,turnId);
      if(!turn||turn.payload.result||current.payload.active?.id!==turnId)return this.result(user,id,turnId);
      const project=await this.store.requireProject(user,current.payload.projectId);
      // An unreadable ledger is unknown. A readable ledger with no dispatch identity proves that no prompt was reserved.
      const runs=await this.listRuns(project).catch(()=>null);
      if(!runs)return this.result(user,id,turnId);
      if(runs.some(run=>run.dispatchId===turn.payload.dispatchId))return this.result(user,id,turnId);
      return this.resumeTurn(user,id,current,turn,assertLock);
    });
  }
  /** @param {any} user @param {string} id @param {any} current @param {any} turn @param {()=>Promise<void>} assertLock */
  async resumeTurn(user,id,current,turn,assertLock){
    const {id:turnId,dispatchId,question,fingerprint}=turn.payload;
    if(current.payload.active?.id!==turnId)return this.result(user,id,turnId);
    const project=await this.store.requireProject(user,current.payload.projectId);
    try{
      const root=await this.root(user,id);
      for(const input of current.payload.inputs){const buffer=await analysisRead(root,input.sha256,this.config.dataAnalysisMaxInputBytes);if(analysisDigest(buffer)!==input.sha256)throw new HttpError(409,'analysis_input_changed','Preserved input bytes changed.');await this.upload(user,project,input.path,buffer);}
      if(!current.payload.sessionId){const sessionId=await this.createSession(project);current=await this.save(user,current,{...current.payload,sessionId});}
      turn=await this.save(user,turn,{...turn.payload,status:'dispatching'});
      const prompt=`${question}\n\nInput workspace copies (source hashes are preserved by the API; work on derived copies):\n${current.payload.inputs.map(input=>`${input.path} (sha256 ${input.sha256})`).join('\n')}`;
      const run=await this.dispatch(user,project,current.payload.sessionId,dispatchId,prompt,{unattended:true,automated:true,dispatchFingerprint:fingerprint,capabilityId:'statistical-analysis',originalQuestion:question,beforeReserve:assertLock,beforePrompt:assertLock});
      await this.save(user,turn,{...turn.payload,status:run.status,runId:run.id});
    }catch(error){
      const runs=await this.listRuns(project).catch(()=>null),run=runs?.find(item=>item.dispatchId===dispatchId);
      const status=run?.status??(runs?'failed':'dispatch_unknown');
      const saved=await this.save(user,turn,{...turn.payload,status,runId:run?.id??null,errorCode:typeof error?.code==='string'?error.code:'analysis_dispatch_failed'}).catch(()=>null);
      if(saved&&runs&&!run)await this.save(user,current,{...current.payload,active:null}).catch(()=>{});
    }
    return this.result(user,id,turnId);
  }
  /** @param {any} user @param {string} id @param {string} turnId */
  async result(user,id,turnId){
    const analysis=await this.record(user,id);
    if(!analysis.payload.turnIds.includes(turnId))throw new HttpError(404,'analysis_turn_not_found','Turn not found.');
    let record=await this.documents.get(user.id,KIND,turnId);
    if(!record)return {id:turnId,analysisId:id,status:'dispatch_unknown',runId:null,notices:[{code:'reservation_recovery_required'}]};
    let turn=record.payload;
    if(turn.result){if(analysis.payload.active?.id===turnId)await this.save(user,analysis,{...analysis.payload,active:null}).catch(error=>{if(error?.code!=='product_revision_conflict')throw error;});return turn;}
    const project=await this.store.requireProject(user,turn.projectId);
    const runs=await this.listRuns(project).catch(()=>null);
    if(!runs)return {...turn,status:'dispatch_unknown',notices:[{code:'run_ledger_unavailable'}]};
    const run=runs.find(item=>item.dispatchId===turn.dispatchId);
    if(!run)return {...turn,status:['preparing','dispatching'].includes(turn.status)?'dispatch_unknown':turn.status};
    if(!terminal(run))return {...turn,runId:run.id,status:run.dispatchStatus==='unknown'?'dispatch_unknown':run.status,dispatchState:run.dispatchStatus??null};
    const result=await snapshotAnalysisRun(project,run,await this.root(user,id),this.config);
    result.artifacts=result.artifacts.map(artifact=>({...artifact,downloadUrl:`/api/data-analysis/v1/analyses/${id}/artifacts/${artifact.id}`}));
    try{record=await this.save(user,record,{...turn,runId:run.id,status:run.status,result});turn=record.payload;}
    catch(error){if(error?.code!=='product_revision_conflict')throw error;turn=(await this.documents.get(user.id,KIND,turnId)).payload;}
    if(!turn.result)return {...turn,status:run.status,notices:[{code:'snapshot_retry_required'}]};
    if(analysis.payload.active?.id===turnId)await this.save(user,analysis,{...analysis.payload,active:null}).catch(error=>{if(error?.code!=='product_revision_conflict')throw error;});
    return turn;
  }
  /** @param {any} user @param {string} id @param {string} turnId */
  async cancel(user,id,turnId){
    const turn=await this.result(user,id,turnId);if(turn.result||turn.status==='failed')return turn;
    const pending=await this.documents.get(user.id,KIND,turnId);
    if(pending?.payload.status==='preparing'){
      // No prompt can exist before the dispatching CAS. Cancelling this revision fences a live or crashed preparer.
      const stopped=await this.save(user,pending,{...pending.payload,status:'failed',errorCode:'analysis_preparation_cancelled'});
      const reserved=await this.record(user,id);
      if(reserved.payload.active?.id===turnId)await this.save(user,reserved,{...reserved.payload,active:null});
      return stopped.payload;
    }
    const analysis=await this.record(user,id),project=await this.store.requireProject(user,analysis.payload.projectId);
    const run=(await this.listRuns(project)).find(item=>item.dispatchId===turn.dispatchId);
    if(!run)throw new HttpError(409,'analysis_dispatch_unknown','Dispatch acceptance is unknown; the reservation remains held.');
    await this.cancelRun(project,run);return this.result(user,id,turnId);
  }
  /** @param {any} user @param {string} id @param {string} artifactId */
  async artifact(user,id,artifactId){
    const analysis=await this.record(user,id);
    for(const turnId of analysis.payload.turnIds){const turn=await this.documents.get(user.id,KIND,turnId);const artifact=turn?.payload.result?.artifacts?.find(item=>item.id===artifactId);if(!artifact)continue;
      const buffer=await analysisRead(await this.root(user,id),artifact.sha256,this.config.dataAnalysisMaxArtifactBytes);
      if(analysisDigest(buffer)!==artifact.sha256)throw new HttpError(409,'analysis_artifact_changed','Preserved artifact bytes changed.');return {artifact,buffer};
    }
    throw new HttpError(404,'analysis_artifact_not_found','Artifact not found.');
  }
}
