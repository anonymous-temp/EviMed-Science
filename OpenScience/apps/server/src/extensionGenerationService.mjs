import fs from 'node:fs/promises';
import {assertExtensionAssessmentAdmission} from './extensionAssessmentAdmission.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson,canonicalExtensionCoordinate,extensionGenerationIdentity,qualifyExtensionProof,extensionProofAdapterRevision} from '@evimed/domain';
import {ProductDocuments,ProductJobs} from './productStore.mjs';
import {migrateProductStore,productInteger} from './productPersistence.mjs';
import {defaultConfiguration,exportPluginPayload} from './pluginService.mjs';
import {extensionRequestObject} from './extensionAccess.mjs';
import {HttpError,openScopedDirectoryNoFollow,openScopedFileNoFollow,readStableFileHandle,writeFileExclusiveNoFollow,directorySize} from './security.mjs';
/** @typedef {{extensionId:string,coordinate:any,integrity:string,artifactDigest:string,configRevision:number,configDigest:string,enabled:boolean,settings:Record<string,any>,connectionRefs:string[],compatibility?:string,sourceDocumentId?:string,adapterRevision?:string,receiptDigest?:string,assessmentAdmissionDigest?:string,executionClass?:string}} GenerationPlugin */
const sha=value=>createHash('sha256').update(value).digest('hex'),digest=value=>'sha256:'+sha(canonicalJson(value));
const HEX=/^[a-f0-9]{64}$/,DIGEST=/^sha256:[a-f0-9]{64}$/;
const invalid=()=>new HttpError(400,'extension_contract_invalid','The immutable extension generation is invalid.');
const stateId=project=>`extensions:generation-state:${project.id}`;
/** @param {any} project @param {any} value */
export function validateExtensionGenerationReference(project,value){
  extensionRequestObject(value,['ownerHash','projectHash','generationHash']);if(value.ownerHash!==sha(project.userId)||value.projectHash!==sha(project.id)||!HEX.test(value.generationHash))throw invalid();return{...value};
}
/** No request-provided paths participate. @param {any} config @param {any} reference */
export function extensionGenerationRoot(config,reference){if(!['ownerHash','projectHash','generationHash'].every(key=>HEX.test(reference?.[key])))throw invalid();return path.join(config.dataDir,'.openscience','extension-generations',reference.ownerHash,reference.projectHash,reference.generationHash);}
/** Domain identity is part of the complete immutable manifest bond, including epochs, proof receipts and settings. @param {any} manifest */
function generationHash(manifest){const {reference:_reference,...content}=manifest;return sha(canonicalJson({...content,domainIdentity:extensionGenerationIdentity(manifest.identity,{ownerId:manifest.scope.ownerId,projectId:manifest.scope.projectId},sha)}));}
/** Extract a private grant DTO from verified immutable state and already authenticated context. This function does not grant authorization. @param {any} manifest @param {any} context @param {string} descriptorId */
export function extractExtensionGenerationOperationIdentity(manifest,context,descriptorId){
  extensionRequestObject(context,['userId','ownerId','projectId','accountCreatedAt','projectCreatedAt','runtimeGeneration']);
  if(manifest.scope.ownerId!==context.ownerId||manifest.scope.projectId!==context.projectId||manifest.scope.projectCreatedAt!==context.projectCreatedAt||generationHash(manifest)!==manifest.reference.generationHash||typeof context.runtimeGeneration!=='string'||!context.runtimeGeneration)throw invalid();
  const selected=manifest.projection.plugins.find(plugin=>plugin.extensionId===descriptorId&&plugin.enabled),binding=manifest.bindings.installations.find(item=>item.extensionId===descriptorId&&item.artifactDigest===selected?.artifactDigest&&item.integrity===selected?.integrity&&item.configDigest===selected?.configDigest);
  if(!selected||!binding)throw new HttpError(404,'not_found','This generation has no admitted operation descriptor.');
  return{userId:context.userId,projectId:context.projectId,accountCreatedAt:context.accountCreatedAt,projectCreatedAt:context.projectCreatedAt,runtimeGeneration:context.runtimeGeneration,extensionGenerationHash:manifest.reference.generationHash,descriptorId,artifactDigest:selected.artifactDigest,installationId:binding.installationId,installationRevision:binding.installationRevision};
}
/** The existing citation document remains its only settings/history authority. @param {any} plugins @param {any} project @param {any} client @param {any} identities */
export async function legacyCitationProjection(plugins,project,client,identities){
  const entry=plugins.entry(),id=plugins.documentId(project.id,entry);
  const row=(await client.query("SELECT revision,payload FROM evimed_product.documents WHERE user_id=$1 AND kind='plugin' AND id=$2 AND deleted_at IS NULL",[project.userId,id])).rows[0];
  const value=row?exportPluginPayload(row.payload,plugins.registry):{binaryVersion:entry.version,...defaultConfiguration(entry,plugins.maxTimeoutMs)};
  if(!DIGEST.test(identities.legacyCitationArtifactDigest))throw invalid();
  return{extensionId:'dsh-cite',coordinate:{kind:'npm',name:'dsh-cite',version:value.binaryVersion},integrity:identities.legacyCitationArtifactDigest,artifactDigest:identities.legacyCitationArtifactDigest,
    configRevision:row?.revision??0,configDigest:digest({enabled:value.enabled,settings:value.settings}),enabled:value.enabled,settings:value.settings,connectionRefs:[],compatibility:'legacy-citation-v1',sourceDocumentId:id};
}
/** Independently verifies canonical, mode-bound manifest and readable projection; no code is loaded. @param {any} config @param {any} project @param {any} reference @param {any} [assessmentAdmission] */
export async function verifyExtensionGeneration(config,project,reference,assessmentAdmission=null){
  const checked=validateExtensionGenerationReference(project,reference),root=extensionGenerationRoot(config,checked);
  for(const directoryPath of [path.dirname(path.dirname(root)),path.dirname(root),root]){const directory=await openScopedDirectoryNoFollow(config.dataDir,directoryPath);try{if((directory.stat.mode&0o7777)!==0o700)throw invalid();}finally{await directory.handle.close();}}
  const read=async(filePath,mode)=>{const file=await openScopedFileNoFollow(config.dataDir,filePath);try{if(file.stat.size>1024*1024||(file.stat.mode&0o7777)!==mode)throw invalid();return await readStableFileHandle(file.handle,file.stat);}finally{await file.handle.close();}};
  const bytes=await read(path.join(root,'manifest.json'),0o400);let manifest;try{manifest=JSON.parse(bytes.toString());}catch{throw invalid();}
  extensionRequestObject(manifest,['schemaVersion','reference','identity','scope','bindings','projection','findings',...(assessmentAdmission?['assessmentAdmission']:[])]);
  if(assessmentAdmission)assertExtensionAssessmentAdmission(assessmentAdmission,config);
  else if(manifest.assessmentAdmission)throw invalid();
  if(manifest.schemaVersion!==1||canonicalJson(manifest.reference)!==canonicalJson(checked)||bytes.toString()!==canonicalJson(manifest)+'\n'||generationHash(manifest)!==checked.generationHash)throw invalid();
  extensionRequestObject(manifest.projection,['plugins','personal']);
  const selections=manifest.projection.plugins.map(plugin=>{extensionRequestObject(plugin,['extensionId','coordinate','integrity','artifactDigest','adapterRevision','configRevision','configDigest','enabled','settings','connectionRefs','receiptDigest',...(assessmentAdmission?['assessmentAdmissionDigest']:[]),'executionClass','compatibility','sourceDocumentId'],['extensionId','coordinate','integrity','artifactDigest','configRevision','configDigest','enabled','settings','connectionRefs']);canonicalExtensionCoordinate(plugin.coordinate);const expected=plugin.compatibility==='legacy-citation-v1'?digest({enabled:plugin.enabled,settings:plugin.settings}):digest({enabled:plugin.enabled,settings:plugin.settings,connectionRefs:plugin.connectionRefs});if(plugin.configDigest!==expected)throw invalid();return{extensionId:plugin.extensionId,artifactDigest:plugin.artifactDigest,configRevision:plugin.configRevision,configDigest:plugin.configDigest,connectionRefs:plugin.connectionRefs};}).sort((a,b)=>a.extensionId.localeCompare(b.extensionId));
  const expectedSkills=manifest.projection.personal.pins.map(pin=>({skillId:pin.skillId,revision:pin.revision,digest:pin.digest})).sort((a,b)=>a.skillId.localeCompare(b.skillId));
  if(canonicalJson(selections)!==canonicalJson([...manifest.identity.selections].sort((a,b)=>a.extensionId.localeCompare(b.extensionId)))||canonicalJson(expectedSkills)!==canonicalJson([...manifest.identity.skills].sort((a,b)=>a.skillId.localeCompare(b.skillId))))throw invalid();
  const projectionRoot=path.join(root,'selected'),directory=await openScopedDirectoryNoFollow(config.dataDir,projectionRoot);try{if((directory.stat.mode&0o7777)!==0o755)throw invalid();}finally{await directory.handle.close();}
  const projection=await read(path.join(projectionRoot,'projection.json'),0o444);if(projection.toString()!==canonicalJson(manifest.projection)+'\n')throw invalid();
  if((await fs.readdir(root)).sort().join(',')!=='manifest.json,selected'||(await fs.readdir(projectionRoot)).join(',')!=='projection.json')throw invalid();
  if(assessmentAdmission)await assessmentAdmission.verifyManifest(config,manifest);
  return manifest;
}
/** Metadata, immutable bytes and existing jobs ledger; no installer registry or serving package manager. */
export class ExtensionGenerationService{
  /** @param {any} database @param {{config:any,extensionService:any,pluginService:any,admittedArtifacts:any[],identities:any,proofAuthority:any,assessmentAdmission?:any}} options */
  constructor(database,{config,extensionService,pluginService,admittedArtifacts,identities,proofAuthority,assessmentAdmission=null}){
    this.database=database;this.config=config;this.extensions=extensionService;this.plugins=pluginService;this.identities=identities;this.proofAuthority=proofAuthority;this.assessmentAdmission=assessmentAdmission?assertExtensionAssessmentAdmission(assessmentAdmission,config):null;
    this.documents=new ProductDocuments(database);this.jobs=new ProductJobs(database);this.artifacts=new Map(admittedArtifacts.map(item=>[item.id,structuredClone(item)]));
    for(const key of ['maxGlobalBytes','maxOwnerBytes','minFreeBytes'])if(!Number.isSafeInteger(config[key])||config[key]<1)throw invalid();
  }
  /** Trusted constructor strategy; serving always requires the existing complete qualification proof. @param {any} input */
  async admission(input){
    if(this.assessmentAdmission)return this.assessmentAdmission.evaluate(input);
    const proof=this.proofAuthority?await this.proofAuthority(input):null;
    if(!proof)throw new HttpError(400,'extension_proof_untrusted','The extension has no trusted proof.');
    const qualified=qualifyExtensionProof(proof.receipt,input.identity,{...proof.authority,sha256Hex:sha});
    return {receiptDigest:qualified.receiptDigest};
  }
  /** @param {any} user @param {string} projectId @param {any} client */
  async snapshot(user,projectId,client){
    const actorAccountCreatedAt=await this.extensions.access.account(user,client),project=await this.extensions.access.project(user,projectId,{manage:true,client}),ownerScope=await this.plugins.scope(project.userId,project,client);
    const trusted=await this.identities(project);for(const key of ['baseRuntimeImageDigest','adapterRevision','permissionProfileRevision'])if(!DIGEST.test(trusted[key]))throw invalid();
    const scope={ownerId:project.userId,projectId:project.id,actorId:user.id,actorAccountCreatedAt,ownerAccountCreatedAt:ownerScope.accountCreatedAt,projectCreatedAt:ownerScope.projectCreatedAt};
    const desired=await this.documents.get(project.userId,'extension-defaults',this.extensions.projectDocumentId(project.id));
    const personal=await this.documents.get(project.userId,'extension-generation',`personal-skills:project:${project.id}`),effectivePersonal=personal?.payload.effective??null;
    const legacy=await legacyCitationProjection(this.plugins,project,client,trusted);
    /** @type {GenerationPlugin[]} */ const plugins=[legacy];const findings=[],bindings=[];
    for(const selected of desired?.payload.selections??[]){
      try{
        const entry=this.extensions.entries.get(selected.catalogueId),artifact=this.artifacts.get(selected.catalogueId);
        if(!entry||!artifact||entry.executionClass==='local-only'||entry.id==='dsh-cite'||entry.integrity!==selected.integrity||artifact.integrity!==selected.integrity||canonicalExtensionCoordinate(entry.coordinate)!==canonicalExtensionCoordinate(selected.coordinate)||canonicalExtensionCoordinate(artifact.coordinate)!==canonicalExtensionCoordinate(selected.coordinate))throw invalid();
        // A library update/removal does not migrate an already selected project pin.
        // Only matching historical revisions backed by a real successful owned preparation are considered.
        const row=(await client.query(`WITH candidates AS (
          SELECT revision,payload FROM evimed_product.documents WHERE user_id=$1 AND kind='extension-installation' AND id=$2 AND deleted_at IS NULL
          UNION SELECT revision,payload FROM evimed_product.revisions WHERE user_id=$1 AND kind='extension-installation' AND id=$2 AND deleted_at IS NULL
        ) SELECT c.revision,c.payload FROM candidates c JOIN evimed_product.jobs j ON j.user_id=$1 AND j.id=c.payload->>'prepareJobId'
          WHERE c.payload->'coordinate'=$3::jsonb AND c.payload->>'integrity'=$4 AND j.kind='extension-prepare' AND j.status='succeeded'
          AND j.payload->>'installationId'=$2 AND j.payload->>'installationRevision'=c.revision::text AND j.result->>'artifactDigest'=$5
          ORDER BY c.revision DESC LIMIT 1`,[selected.actorId,selected.installationId,JSON.stringify(selected.coordinate),selected.integrity,artifact.artifactDigest])).rows[0];
        if(row)row.id=selected.installationId;const prepared=row?.payload.prepareJobId?await this.jobs.get(selected.actorId,row.payload.prepareJobId):null;
        if(!row||row.payload.integrity!==selected.integrity||canonicalExtensionCoordinate(row.payload.coordinate)!==canonicalExtensionCoordinate(selected.coordinate)||prepared?.kind!=='extension-prepare'||prepared.status!=='succeeded'||prepared.payload.installationId!==row.id||prepared.payload.installationRevision!==row.revision||prepared.result?.artifactDigest!==artifact.artifactDigest||prepared.result.integrity!==selected.integrity||prepared.result.installationId!==row.id||prepared.result.installationRevision!==row.revision)throw invalid();
        const actor={id:selected.actorId,accountCreatedAt:prepared.payload.accountCreatedAt};await this.extensions.access.account(actor,client);await this.extensions.access.project(actor,project.id,{manage:true,client});
        const settings=this.extensions.settings(entry,selected.settings),connectionRefs=await this.extensions.access.connections(actor,selected.connectionRefs,{client,project,entry});
        const proofIdentity={packageIntegrity:entry.integrity,sourceCommit:entry.coordinate.kind==='github'?entry.coordinate.commit:null,adapterRevision:extensionProofAdapterRevision(artifact.adapterRevision,trusted.adapterRevision,sha),runtimeImageDigest:trusted.baseRuntimeImageDigest,dshVersion:'0.1.7-rc.2',executionClass:entry.executionClass,permissionProfileRevision:trusted.permissionProfileRevision,suiteRevision:artifact.suiteRevision};
        const qualification=await this.admission({project,actor,entry,artifact,identity:proofIdentity});
        const configDigest=digest({enabled:selected.enabled,settings,connectionRefs});
        bindings.push({extensionId:entry.id,installationId:row.id,actorId:selected.actorId,installationRevision:row.revision,prepareJobId:prepared.id,coordinate:canonicalExtensionCoordinate(selected.coordinate),integrity:selected.integrity,artifactDigest:artifact.artifactDigest,configDigest,...qualification});
        plugins.push({extensionId:entry.id,coordinate:selected.coordinate,integrity:entry.integrity,artifactDigest:artifact.artifactDigest,adapterRevision:proofIdentity.adapterRevision,configRevision:desired.revision,configDigest,enabled:selected.enabled,settings,connectionRefs,...qualification,executionClass:entry.executionClass});
      }catch(error){findings.push({extensionId:selected.catalogueId,code:['extension_proof_untrusted','extension_proof_stale','extension_proof_incomplete','extension_access_denied'].includes(error.code)?error.code:'extension_contract_invalid'});}
    }
    plugins.sort((a,b)=>a.extensionId.localeCompare(b.extensionId));bindings.sort((a,b)=>a.installationId.localeCompare(b.installationId));findings.sort((a,b)=>a.extensionId.localeCompare(b.extensionId));
    const pins=effectivePersonal?.pins??[];
    const identity={ownerId:project.userId,projectId:project.id,baseRuntimeImageDigest:trusted.baseRuntimeImageDigest,adapterRevision:trusted.adapterRevision,permissionProfileRevision:trusted.permissionProfileRevision,
      selections:plugins.map(plugin=>({extensionId:plugin.extensionId,artifactDigest:plugin.artifactDigest,configRevision:plugin.configRevision,configDigest:plugin.configDigest,connectionRefs:plugin.connectionRefs})),skills:pins.map(pin=>({skillId:pin.skillId,revision:pin.revision,digest:pin.digest}))};
    const manifest={schemaVersion:1,...(this.assessmentAdmission?{assessmentAdmission:this.assessmentAdmission.marker}:{}),reference:null,identity,scope,bindings:{desiredRevision:desired?.revision??0,legacyRevision:legacy.configRevision,personalRevision:personal?.revision??0,installations:bindings},projection:{plugins,personal:{reference:effectivePersonal?.reference??null,pins}},findings};
    const hash=generationHash(manifest);manifest.reference={ownerHash:sha(project.userId),projectHash:sha(project.id),generationHash:hash};return{project,manifest};
  }
  /** Idempotent compatibility projection, without editing old citation rows or settings history. @param {any} user @param {string} projectId */
  async projectLegacy(user,projectId){return this.database.transaction(client=>this.database.withTransactionClient(client,async()=>{
    const {project,manifest}=await this.snapshot(user,projectId,client),legacy=manifest.projection.plugins.find(item=>item.extensionId==='dsh-cite');
    const id=`extensions:legacy:${project.id}:dsh-cite`,payload={schemaVersion:1,sourceDocumentId:legacy.sourceDocumentId,sourceRevision:legacy.configRevision,binaryVersion:legacy.coordinate.version,compatibility:'legacy-citation-v1'};
    const old=await this.documents.get(project.userId,'extension-defaults',id);if(old&&canonicalJson(old.payload)===canonicalJson(payload))return old;
    return this.documents.put(project.userId,'extension-defaults',id,payload,{expectedRevision:old?.revision??0,projectId:project.id,transactionClient:client});
  }));}
  /** @param {any} project */
  current(project){return this.documents.get(project.userId,'extension-generation',stateId(project));}
  /** Atomic under the same global immutable-tree storage lock as personal skills. @param {any} project @param {any} manifest @param {any} client */
  async publish(project,manifest,client){
    const root=extensionGenerationRoot(this.config,manifest.reference),ownerRoot=path.dirname(path.dirname(root));
    const owner=await openScopedDirectoryNoFollow(this.config.dataDir,ownerRoot,{create:true});await owner.handle.close();await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['evimed-personal-skill-storage']);
    const files=[{name:'selected/projection.json',bytes:Buffer.from(canonicalJson(manifest.projection)+'\n'),mode:0o444},{name:'manifest.json',bytes:Buffer.from(canonicalJson(manifest)+'\n'),mode:0o400}];
    if(files.some(file=>file.bytes.length>1024*1024))throw invalid();
    let incoming=0;for(const file of files){try{const existing=await openScopedFileNoFollow(this.config.dataDir,path.join(root,file.name));try{if(!file.bytes.equals(await readStableFileHandle(existing.handle,existing.stat)))throw invalid();const actualMode=existing.stat.mode&0o7777;if(actualMode!==file.mode){if(file.mode!==0o444||actualMode!==0o400)throw invalid();await existing.handle.chmod(file.mode);}}finally{await existing.handle.close();}}catch(error){if(!['ENOENT','file_not_found'].includes(error.code))throw error;incoming+=file.bytes.length;}}
    const trees=[path.join(this.config.dataDir,'.openscience','extension-generations'),path.join(this.config.dataDir,'.openscience','personal-skill-generations'),this.config.skillArtifactsRoot];let used=0;for(const tree of trees){const directory=await openScopedDirectoryNoFollow(this.config.dataDir,tree,{create:true});await directory.handle.close();used+=await directorySize(tree,{maxEntries:50000});}
    const ownerUsed=await directorySize(ownerRoot,{maxEntries:20000}),disk=await fs.statfs(ownerRoot);if(incoming>0&&(used+incoming>this.config.maxGlobalBytes||ownerUsed+incoming>this.config.maxOwnerBytes||disk.bavail*disk.bsize<incoming+this.config.minFreeBytes))throw new HttpError(503,'extension_storage_capacity','Immutable generation storage is temporarily unavailable.');
    for(const file of files){try{await writeFileExclusiveNoFollow(this.config.dataDir,path.join(root,file.name),file.bytes,{mode:file.mode});}catch(error){if(error.code!=='EEXIST')throw error;}const published=await openScopedFileNoFollow(this.config.dataDir,path.join(root,file.name));try{if(!file.bytes.equals(await readStableFileHandle(published.handle,published.stat)))throw invalid();await published.handle.chmod(file.mode);}finally{await published.handle.close();}}
    for(const privateRoot of [ownerRoot,path.dirname(root),root]){const directory=await openScopedDirectoryNoFollow(this.config.dataDir,privateRoot);try{if((directory.stat.mode&0o7777)!==0o700)throw invalid();}finally{await directory.handle.close();}}
    const selected=await openScopedDirectoryNoFollow(this.config.dataDir,path.join(root,'selected'));try{await selected.handle.chmod(0o755);}finally{await selected.handle.close();}
    return verifyExtensionGeneration(this.config,project,manifest.reference,this.assessmentAdmission);
  }
  /** Public input controls CAS only. Qualification and deployment identities come exclusively from trusted constructor adapters. @param {any} user @param {string} projectId @param {any} input */
  async reconcile(user,projectId,input){extensionRequestObject(input,['expectedRevision']);productInteger(input.expectedRevision,0,2147483646);await migrateProductStore(this.database);
    const project=await this.extensions.access.project(user,projectId,{manage:true});
    return this.plugins.withAdmission(project,()=>this.database.transaction(client=>this.database.withTransactionClient(client,async()=>{
      const {manifest}=await this.snapshot(user,projectId,client);if(manifest.bindings.desiredRevision!==input.expectedRevision)throw new HttpError(409,'product_revision_conflict','The desired extension settings changed.');
      await this.publish(project,manifest,client);
      const immutableId=`extensions:generation:${manifest.reference.generationHash}`,immutable=await this.documents.get(project.userId,'extension-generation',immutableId);
      if(!immutable)await this.documents.put(project.userId,'extension-generation',immutableId,manifest,{expectedRevision:0,projectId:project.id,transactionClient:client});else if(canonicalJson(immutable.payload)!==canonicalJson(manifest))throw invalid();
      const prior=await this.current(project);if(prior?.payload.desired?.reference.generationHash===manifest.reference.generationHash)return prior;
      const state=await this.documents.put(project.userId,'extension-generation',stateId(project),{desired:manifest,effective:prior?.payload.effective??null,lastGood:prior?.payload.lastGood??null,phase:'waiting',findings:manifest.findings},{expectedRevision:prior?.revision??0,projectId:project.id,transactionClient:client});
      await this.jobs.enqueue(project.userId,'plugin-apply',{variant:'extension-generation-v1',stateRevision:state.revision,reference:manifest.reference,actorId:user.id,actorAccountCreatedAt:manifest.scope.actorAccountCreatedAt,accountCreatedAt:manifest.scope.ownerAccountCreatedAt,projectCreatedAt:manifest.scope.projectCreatedAt},
        {idempotencyKey:`extension-apply:${project.id}:${state.revision}`,projectId:project.id,maxAttempts:10,transactionClient:client});return state;
    })));
  }
  /** Recheck desired settings, grants, proof freshness and proven personal state inside the project fence. @param {any} job @param {any} candidate @param {any} client */
  async assertCurrent(job,candidate,client){const actor={id:job.payload.actorId,accountCreatedAt:job.payload.actorAccountCreatedAt};const {project,manifest}=await this.snapshot(actor,job.projectId,client);
    if(project.userId!==job.userId||manifest.scope.ownerAccountCreatedAt!==job.payload.accountCreatedAt||manifest.scope.projectCreatedAt!==job.payload.projectCreatedAt)throw new HttpError(409,'plugin_generation_changed','Project ownership changed.');
    const state=await this.current(project);if(state?.payload.desired?.reference.generationHash!==candidate.reference.generationHash||manifest.reference.generationHash!==candidate.reference.generationHash)throw new HttpError(409,'product_revision_conflict','The extension generation changed.');return project;}
  /** Only current proven runtime state supplies operation identity; the later gateway still authorizes each operation/resource. @param {any} user @param {string} projectId @param {string} descriptorId @param {string} actualRuntimeGeneration */
  async operationIdentity(user,projectId,descriptorId,actualRuntimeGeneration){return this.database.transaction(client=>this.database.withTransactionClient(client,async()=>{
    const accountCreatedAt=await this.extensions.access.account(user,client),project=await this.extensions.access.project(user,projectId,{client}),owner=await this.plugins.scope(project.userId,project,client),state=await this.current(project),manifest=state?.payload.effective;
    if(!manifest||!['effective','rolled-back'].includes(state.payload.phase)||state.payload.runtimeGeneration!==actualRuntimeGeneration||manifest.scope.ownerAccountCreatedAt!==owner.accountCreatedAt||manifest.scope.projectCreatedAt!==owner.projectCreatedAt)throw new HttpError(503,'product_state_unavailable','The current extension runtime identity is unavailable.');
    await verifyExtensionGeneration(this.config,project,manifest.reference,this.assessmentAdmission);
    const selected=manifest.projection.plugins.find(plugin=>plugin.extensionId===descriptorId&&plugin.enabled),binding=manifest.bindings.installations.find(item=>item.extensionId===descriptorId&&item.artifactDigest===selected?.artifactDigest&&item.configDigest===selected?.configDigest),artifact=this.artifacts.get(descriptorId),entry=this.extensions.entries.get(descriptorId);
    if(!selected||!binding||!artifact||!entry||artifact.artifactDigest!==selected.artifactDigest||entry.integrity!==selected.integrity)throw new HttpError(404,'not_found','The operation descriptor is unavailable.');
    const preparation=await this.jobs.get(binding.actorId,binding.prepareJobId);if(preparation?.kind!=='extension-prepare'||preparation.status!=='succeeded'||preparation.payload.installationId!==binding.installationId||preparation.payload.installationRevision!==binding.installationRevision||preparation.result?.artifactDigest!==selected.artifactDigest||preparation.result.installationId!==binding.installationId||preparation.result.installationRevision!==binding.installationRevision||preparation.result.integrity!==selected.integrity)throw invalid();
    const actor={id:binding.actorId,accountCreatedAt:preparation.payload.accountCreatedAt};await this.extensions.access.account(actor,client);await this.extensions.access.project(actor,project.id,{manage:true,client});await this.extensions.access.connections(actor,selected.connectionRefs,{client,project,entry});
    const proofIdentity={packageIntegrity:selected.integrity,sourceCommit:selected.coordinate.kind==='github'?selected.coordinate.commit:null,adapterRevision:extensionProofAdapterRevision(artifact.adapterRevision,manifest.identity.adapterRevision,sha),runtimeImageDigest:manifest.identity.baseRuntimeImageDigest,dshVersion:'0.1.7-rc.2',executionClass:entry.executionClass,permissionProfileRevision:manifest.identity.permissionProfileRevision,suiteRevision:artifact.suiteRevision};
    const qualified=await this.admission({project,actor,entry,artifact,identity:proofIdentity});
    if(this.assessmentAdmission?qualified.assessmentAdmissionDigest!==selected.assessmentAdmissionDigest:qualified.receiptDigest!==selected.receiptDigest)throw new HttpError(400,'extension_proof_stale','The operation proof changed.');
    return extractExtensionGenerationOperationIdentity(manifest,{userId:user.id,ownerId:project.userId,projectId:project.id,accountCreatedAt,projectCreatedAt:owner.projectCreatedAt,runtimeGeneration:actualRuntimeGeneration},descriptorId);
  }));}
  /** Current system/actor authority independent of changed desired intent; used only for safe rollback. @param {any} job @param {any} client */
  async assertAuthority(job,client){const actor={id:job.payload.actorId,accountCreatedAt:job.payload.actorAccountCreatedAt};await this.extensions.access.account(actor,client);const project=await this.extensions.access.project(actor,job.projectId,{manage:true,client});const owner=await this.plugins.scope(project.userId,project,client);if(project.userId!==job.userId||owner.accountCreatedAt!==job.payload.accountCreatedAt||owner.projectCreatedAt!==job.payload.projectCreatedAt)throw new HttpError(409,'plugin_generation_changed','Project ownership changed.');return project;}
  /** A prior generation must still have current grants, receipts, base identity and coherent personal pins. @param {any} job @param {any} previous @param {any} client */
  async canRestore(job,previous,client){const {manifest}=await this.snapshot({id:job.payload.actorId,accountCreatedAt:job.payload.actorAccountCreatedAt},job.projectId,client);return ['baseRuntimeImageDigest','adapterRevision','permissionProfileRevision'].every(key=>previous.identity[key]===manifest.identity[key])&&canonicalJson(previous.projection.personal)===canonicalJson(manifest.projection.personal)&&previous.projection.plugins.every(old=>manifest.projection.plugins.some(current=>current.extensionId===old.extensionId&&(!old.enabled||current.enabled)&&current.artifactDigest===old.artifactDigest&&canonicalJson(current.connectionRefs)===canonicalJson(old.connectionRefs)&&current.receiptDigest===old.receiptDigest&&current.assessmentAdmissionDigest===old.assessmentAdmissionDigest));}
  /** @param {any} project @param {any} candidate @param {any} proof @param {any} client */
  async markEffective(project,candidate,proof,client){const state=await this.current(project);if(state?.payload.desired?.reference.generationHash!==candidate.reference.generationHash)throw invalid();return this.documents.put(project.userId,'extension-generation',state.id,{...state.payload,effective:candidate,lastGood:candidate,phase:'effective',runtimeGeneration:proof.runtimeGeneration,findings:candidate.findings},{expectedRevision:state.revision,projectId:project.id,transactionClient:client});}
}
