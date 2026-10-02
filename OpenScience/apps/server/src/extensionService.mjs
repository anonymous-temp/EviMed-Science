import { createHash } from 'node:crypto';
import { canonicalJson, canonicalExtensionCoordinate, validateExtensionInstallRequest, qualifyExtensionProof, EXTENSION_EXECUTION_CLASSES, ALL_ERROR_CODES } from '@evimed/domain';
import { ProductDocuments, ProductJobs } from './productStore.mjs';
import { migrateProductStore, productInteger } from './productPersistence.mjs';
import { HttpError } from './security.mjs';
import { ExtensionAccess, extensionRequestObject, extensionIdentifier, extensionArray } from './extensionAccess.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const missing=()=>new HttpError(404,'not_found','Extension record not found.');
const digest=value=>`sha256:${hash(canonicalJson(value))}`;
const RESERVED=/^(?:ownerid|userid|role|qualified|proof|apikey|token|secret|password|credentials|hostpath|env|cmd|command|url|baseurl|endpoint|path)$/i;
/** Persistent metadata only. Native installation, qualification authority and activation are separate trusted workers. */
export class ExtensionService {
  /** @param {any} database @param {{catalogue?:any[],access?:ExtensionAccess,proofAuthority?:any,cancelPreparation?:any,connectionList?:any,catalogueGeneratedAt?:string}} options */
  constructor(database,{catalogue=[],access=new ExtensionAccess(),proofAuthority=null,cancelPreparation=null,connectionList=null,catalogueGeneratedAt='1970-01-01T00:00:00.000Z'}={}) {
    this.database=database;this.documents=new ProductDocuments(database);this.jobs=new ProductJobs(database);this.access=access;
    this.proofAuthority=proofAuthority;this.cancelPreparation=cancelPreparation;this.catalogueGeneratedAt=catalogueGeneratedAt;
    this.connectionList=connectionList;
    this.entries=new Map();
    for(const source of catalogue) {
      const row=structuredClone(source);extensionIdentifier(row.id);canonicalExtensionCoordinate(row.coordinate);
      if(this.entries.has(row.id)||!EXTENSION_EXECUTION_CLASSES.includes(row.executionClass)||!/^sha256:[a-f0-9]{64}$/.test(row.integrity))throw new HttpError(400,'extension_contract_invalid','Invalid trusted catalogue descriptor.');
      row.settingsSchema??={};
      for(const [key,definition]of Object.entries(row.settingsSchema))if(RESERVED.test(key.replaceAll('_',''))||!['integer','number','boolean','string'].includes(/** @type {any} */(definition).type))throw new HttpError(400,'extension_contract_invalid','Unsupported extension settings schema.');
      this.entries.set(row.id,row);
    }
  }
  /** @param {any} coordinate */
  descriptor(coordinate) {
    const pin=canonicalExtensionCoordinate(coordinate);
    const entry=[...this.entries.values()].find(row=>canonicalExtensionCoordinate(row.coordinate)===pin);
    if(!entry)throw missing();return entry;
  }
  /** Never infer qualification from a catalogue flag or installation outcome. @param {any} entry */
  async evidence(entry) {
    if(!this.proofAuthority)return{evidenceState:'source-assessed',qualification:null};
    const trusted=await this.proofAuthority(entry);
    if(!trusted?.currentIdentity||trusted.currentIdentity.packageIntegrity!==entry.integrity||trusted.currentIdentity.executionClass!==entry.executionClass)return{evidenceState:'source-assessed',qualification:null};
    try { const result=qualifyExtensionProof(trusted.receipt,trusted.currentIdentity,{...trusted.authority,sha256Hex:hash});
      return{evidenceState:'saas-qualified',qualification:{receiptDigest:result.receiptDigest}};
    } catch(error) { if(error?.code?.startsWith('extension_'))return{evidenceState:'source-assessed',qualification:null};throw error; }
  }
  /** @param {{query?:string}} options */
  async catalogue({query=''}={}) {
    if(typeof query!=='string'||query.length>200)throw new HttpError(400,'extension_contract_invalid','Invalid catalogue query.');
    const items=[];
    for(const entry of this.entries.values())if(`${entry.title} ${entry.id}`.toLowerCase().includes(query.toLowerCase()))items.push({id:entry.id,title:entry.title,
      coordinate:entry.coordinate,executionClass:entry.executionClass,integrity:entry.integrity,settingsSchema:entry.settingsSchema,...await this.evidence(entry)});
    return{items,generatedAt:this.catalogueGeneratedAt};
  }
  /** Only current actor/project references are listed; never credential values. @param {any} user @param {any} input */
  async connections(user,input) {
    const request=extensionRequestObject(input,['catalogueId','projectId']);extensionIdentifier(request.catalogueId);extensionIdentifier(request.projectId);
    const entry=this.entries.get(request.catalogueId);if(!entry)throw missing();
    await this.access.project(user,request.projectId,{manage:true});
    return this.connectionList?this.connectionList(user,entry,request.projectId):{items:[],supportedKinds:[]};
  }
  /** @param {any} user @param {string} kind @param {string} id @param {any} client @param {boolean} [includeDeleted] */
  async read(user,kind,id,client,includeDeleted=false) {
    const result=await client.query(`SELECT id,payload,revision,deleted_at FROM evimed_product.documents WHERE user_id=$1 AND kind=$2 AND id=$3 ${includeDeleted?'':'AND deleted_at IS NULL'} FOR UPDATE`,[user.id,kind,extensionIdentifier(id)]);
    return result.rows[0]??null;
  }
  /** Safe preparation outcome; arbitrary worker logs, paths and lease credentials never leave the boundary. @param {any} job */
  publicPreparation(job) {
    if(!job)return null;
    const result=job.result,prepared=job.status==='succeeded'&&result&&result.installationId===job.payload.installationId
      &&result.installationRevision===job.payload.installationRevision&&result.integrity===job.payload.integrity&&/^sha256:[a-f0-9]{64}$/.test(result.artifactDigest);
    return{id:job.id,status:job.status,attempts:job.attempts,createdAt:job.createdAt,finishedAt:job.finishedAt,
      outcome:prepared?'prepared':job.status==='succeeded'?'unverified':job.status,
      ...(prepared?{artifactDigest:result.artifactDigest}:{}),
      ...(job.status==='failed'?{refusalCode:ALL_ERROR_CODES.includes(job.error?.code)?job.error.code:'extension_contract_invalid'}:{})};
  }
  /** @param {any} user @param {any} row */
  async installation(user,row) {
    const entry=this.entries.get(row.payload.catalogueId);
    const matches=entry&&canonicalExtensionCoordinate(entry.coordinate)===canonicalExtensionCoordinate(row.payload.coordinate)&&entry.integrity===row.payload.integrity;
    const evidence=matches?await this.evidence(entry):{evidenceState:'source-assessed',qualification:null};
    const job=row.payload.prepareJobId?await this.jobs.get(user.id,row.payload.prepareJobId):null;
    const bound=job?.kind==='extension-prepare'&&job.payload.installationId===row.id&&job.payload.installationRevision===row.revision
      &&job.payload.integrity===row.payload.integrity&&job.payload.coordinate===canonicalExtensionCoordinate(row.payload.coordinate);
    const preparation=bound?this.publicPreparation(job):null;
    const phase=row.deletedAt||row.deleted_at?'removed':!preparation?row.payload.phase:preparation.status==='succeeded'
      ?preparation.outcome==='prepared'?'waiting':'saved':preparation.status==='failed'?'failed':preparation.status==='canceled'?'saved':'preparing';
    return{id:row.id,revision:row.revision,coordinate:row.payload.coordinate,integrity:row.payload.integrity,catalogueId:row.payload.catalogueId,
      prepareJobId:row.payload.prepareJobId??null,preparation,phase,effective:false,...evidence};
  }
  /** @param {any} user @param {any} input */
  async install(user,input) {
    let request;try{request=validateExtensionInstallRequest(input);}catch{throw new HttpError(400,'extension_contract_invalid','Invalid extension installation request.');}
    const id=`extension:${hash(request.idempotencyKey)}`,fingerprint=digest(request);
    await migrateProductStore(this.database);
    const outcome=await this.database.transaction(async client=>{
      const accountCreatedAt=await this.access.account(user,client);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`extension-install:${user.id}:${id}`]);
      const project=request.scope==='project'?await this.access.project(user,request.projectId,{manage:true,client}):null;
      const prior=await this.read(user,'extension-installation',id,client,true);
      if(prior) {
        if(prior.payload.requestFingerprint!==fingerprint)throw new HttpError(409,'product_job_idempotency_conflict','This request key already names another installation.');
        return{row:prior,jobId:prior.payload.prepareJobId};
      }
      const entry=this.descriptor(request.coordinate);
      let job=null;
      if(entry.executionClass!=='local-only')job=await this.jobs.enqueue(user.id,'extension-prepare',{installationId:id,installationRevision:1,
        catalogueId:entry.id,coordinate:canonicalExtensionCoordinate(entry.coordinate),integrity:entry.integrity,accountCreatedAt,
        projectTarget:project?{ownerId:project.userId,projectId:project.id,projectCreatedAt:project.projectCreatedAt}:null},{idempotencyKey:`extension-prepare:${id}:1`,transactionClient:client});
      const row=await this.documents.put(user.id,'extension-installation',id,{schemaVersion:1,catalogueId:entry.id,coordinate:request.coordinate,integrity:entry.integrity,
        requestFingerprint:fingerprint,phase:entry.executionClass==='local-only'?'unsupported':'preparing',prepareJobId:job?.id??null},{expectedRevision:0,transactionClient:client});
      if(project) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`extension-project:${project.userId}:${project.id}`]);
        const previous=await this.read({id:project.userId},'extension-defaults',this.projectDocumentId(project.id),client);
        const selections=(previous?.payload.selections??[]).filter(item=>item.catalogueId!==entry.id);
        selections.push({installationId:id,catalogueId:entry.id,coordinate:request.coordinate,integrity:entry.integrity,enabled:true,settings:{},connectionRefs:[],actorId:user.id});
        await this.documents.put(project.userId,'extension-defaults',this.projectDocumentId(project.id),{schemaVersion:1,selections},{expectedRevision:previous?.revision??0,projectId:project.id,transactionClient:client});
      }
      return{row,jobId:job?.id??null};
    });
    return{installation:await this.installation(user,outcome.row),job:outcome.jobId?await this.getJob(user,outcome.jobId):null};
  }
  /** @param {any} user @param {any} options */
  async list(user,options={}) {
    const result=await this.documents.list(user.id,'extension-installation',options);
    return{items:await Promise.all(result.items.map(row=>this.installation(user,row))),nextCursor:result.nextCursor};
  }
  /** @param {any} user @param {string} id */
  async get(user,id) {const row=await this.documents.get(user.id,'extension-installation',extensionIdentifier(id));if(!row)throw missing();return this.installation(user,row);}
  /** @param {any} user @param {string} id */
  async history(user,id,options={}) {
    if(!await this.documents.get(user.id,'extension-installation',extensionIdentifier(id),{includeDeleted:true}))throw missing();
    const paging=this.historyPaging(options),rows=await this.documents.history(user.id,'extension-installation',id,paging);
    return{items:rows.map(row=>({revision:row.revision,removed:Boolean(row.deletedAt),coordinate:row.payload.coordinate,phase:row.payload.phase,recordedAt:row.recordedAt})),nextBeforeRevision:rows.length===paging.limit?rows.at(-1).revision:null};
  }
  /** @param {any} user @param {string} id */
  async getJob(user,id) {const job=await this.jobs.get(user.id,extensionIdentifier(id));if(!job||job.kind!=='extension-prepare')throw missing();return this.publicPreparation(job);}
  /** @param {any} user @param {string} id */
  async cancelJob(user,id) {
    extensionIdentifier(id);await migrateProductStore(this.database);
    const captured=await this.database.transaction(async client=>{
      const snapshot=await this.cancellationSnapshot(user,id,client);
      if(snapshot.job.status==='queued')await this.cancelLocked(user,id,client);
      return snapshot;
    });
    if(captured.job.status!=='running')return this.getJob(user,id);
    if(!this.cancelPreparation)throw new HttpError(503,'product_state_unavailable','Preparation stop cannot be confirmed without its executor.');
    let acknowledgment;
    try{acknowledgment=await this.cancelPreparation(structuredClone(captured.identity));}
    catch{throw new HttpError(503,'product_state_unavailable','Preparation stop could not be confirmed.');}
    if(acknowledgment?.settled!==true||acknowledgment.joined!==true||acknowledgment.physicallyAbsent!==true)throw new HttpError(503,'product_state_unavailable','Preparation execution is still unconfirmed.');
    const acknowledgedIdentity=acknowledgment.identity??acknowledgment;
    if(Object.keys(captured.identity).some(key=>!Object.hasOwn(acknowledgedIdentity,key)))throw new HttpError(409,'product_revision_conflict','The cancellation acknowledgment is incomplete.');
    const received=Object.fromEntries(Object.keys(captured.identity).map(key=>[key,acknowledgedIdentity[key]]));
    if(canonicalJson(received)!==canonicalJson(captured.identity))throw new HttpError(409,'product_revision_conflict','The cancellation acknowledgment names another attempt.');
    await this.database.transaction(async client=>{
      const current=await this.cancellationSnapshot(user,id,client);
      if(current.identity.accountCreatedAt!==captured.identity.accountCreatedAt)throw new HttpError(401,'unauthorized','The account generation changed.');
      if(['succeeded','failed','canceled'].includes(current.job.status))return;
      if(current.job.status!=='running'||current.identity.leaseToken!==captured.identity.leaseToken||current.identity.attempts!==captured.identity.attempts)
        throw new HttpError(409,'product_revision_conflict','The preparation attempt changed.');
      await this.cancelLocked(user,id,client);
    });
    return this.getJob(user,id);
  }
  /** Trusted cancellation capture takes only a job row lock; no inverse installation/project write lock is borrowed. @param {any} user @param {string} id @param {any} client */
  async cancellationSnapshot(user,id,client) {
    const accountCreatedAt=await this.access.account(user,client);
    const row=(await client.query("SELECT * FROM evimed_product.jobs WHERE user_id=$1 AND id=$2 AND kind='extension-prepare' FOR UPDATE",[user.id,id])).rows[0];
    if(!row)throw missing();
    const installation=(await client.query("SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind='extension-installation' AND id=$2",[user.id,row.payload.installationId])).rows[0];
    if(!installation)throw missing();
    if(row.payload.accountCreatedAt!==accountCreatedAt)throw new HttpError(401,'unauthorized','The preparation account generation changed.');
    const target=row.payload.projectTarget??null;
    if(target){const project=await this.access.project(user,target.projectId,{manage:true,client});if(project.userId!==target.ownerId
      || (target.projectCreatedAt&&target.projectCreatedAt!==project.projectCreatedAt))throw missing();}
    return{job:{status:row.status},identity:{jobId:row.id,leaseToken:row.lease_token,attempts:row.attempts,installationId:row.payload.installationId,
      installationRevision:row.payload.installationRevision,accountCreatedAt,projectTarget:target}};
  }
  /** Only queued work or a confirmed unchanged running attempt reaches this transaction. @param {any} user @param {string} id @param {any} client */
  async cancelLocked(user,id,client) {
    await client.query("UPDATE evimed_product.jobs SET status='canceled',finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2",[user.id,id]);
  }
  /** @param {any} user @param {string} id @param {any} input */
  async retry(user,id,input) {return this.prepareRevision(user,id,input,false);}
  /** Exact desired-version change; historical project generations stay pinned. @param {any} user @param {string} id @param {any} input */
  async update(user,id,input) {return this.prepareRevision(user,id,input,true);}
  /** @param {any} user @param {string} id @param {any} input @param {boolean} update */
  async prepareRevision(user,id,input,update) {
    const body=extensionRequestObject(input,update?['expectedRevision','coordinate']:['expectedRevision']);productInteger(body.expectedRevision,1,2147483646);
    await migrateProductStore(this.database);
    const outcome=await this.database.transaction(async client=>{
      const accountCreatedAt=await this.access.account(user,client),row=await this.read(user,'extension-installation',id,client);if(!row)throw missing();
      const entry=this.descriptor(update?body.coordinate:row.payload.coordinate);
      if(entry.executionClass==='local-only')throw new HttpError(400,'extension_contract_invalid','This package needs another environment.');
      if(row.revision!==body.expectedRevision)throw new HttpError(409,'product_revision_conflict','Reload before retrying.');
      const revision=row.revision+1;
      const job=await this.jobs.enqueue(user.id,'extension-prepare',{installationId:id,installationRevision:revision,catalogueId:entry.id,
        coordinate:canonicalExtensionCoordinate(entry.coordinate),integrity:entry.integrity,accountCreatedAt,projectTarget:null},{idempotencyKey:`extension-prepare:${id}:${revision}`,transactionClient:client});
      const next=await this.documents.put(user.id,'extension-installation',id,{...row.payload,catalogueId:entry.id,coordinate:entry.coordinate,integrity:entry.integrity,phase:'preparing',prepareJobId:job.id},{expectedRevision:body.expectedRevision,transactionClient:client});
      return{row:next,job};
    });
    return{installation:await this.installation(user,outcome.row),job:await this.getJob(user,outcome.job.id)};
  }
  /** Removal changes the personal library only; pinned project generations/results are untouched. @param {any} user @param {string} id @param {any} input */
  async remove(user,id,input) {
    const body=extensionRequestObject(input,['expectedRevision']);await this.get(user,id);
    return this.installation(user,await this.documents.remove(user.id,'extension-installation',id,body.expectedRevision));
  }
  /** @param {any} entry @param {any} value */
  settings(entry,value) {
    extensionRequestObject(value,Object.keys(entry.settingsSchema),[]);const settings={};
    for(const [key,item]of Object.entries(value)) {
      const field=entry.settingsSchema[key];let valid=false;
      if(field.type==='boolean')valid=typeof item==='boolean';
      if(field.type==='string')valid=typeof item==='string'&&item.length<=(field.maxLength??1000)&&(!field.enum||field.enum.includes(item));
      if(['integer','number'].includes(field.type))valid=typeof item==='number'&&Number.isFinite(item)&&(field.type!=='integer'||Number.isSafeInteger(item))&&(field.min===undefined||item>=field.min)&&(field.max===undefined||item<=field.max);
      if(!valid)throw new HttpError(400,'extension_contract_invalid','Invalid admitted extension setting.');settings[key]=item;
    }
    return settings;
  }
  /** @param {string} projectId */
  projectDocumentId(projectId) {return`extensions:project:${extensionIdentifier(projectId)}`;}
  /** @param {any} user @param {string} projectId */
  async project(user,projectId) {
    const project=await this.access.project(user,projectId);
    const row=await this.documents.get(project.userId,'extension-defaults',this.projectDocumentId(project.id));
    return this.projectView(user,row);
  }
  /** @param {any} user @param {any} row */
  async projectView(user,row) {
    const selections=[];
    for(const selected of row?.payload.selections??[]) {
      const entry=this.entries.get(selected.catalogueId),matches=entry&&entry.integrity===selected.integrity&&canonicalExtensionCoordinate(entry.coordinate)===canonicalExtensionCoordinate(selected.coordinate);
      const evidence=matches?await this.evidence(entry):{evidenceState:'source-assessed',qualification:null};
      selections.push({...selected,connectionRefs:selected.actorId===user.id?selected.connectionRefs:[],phase:!matches||entry.executionClass==='local-only'?'unsupported':selected.enabled?'waiting':'saved',effective:false,...evidence});
    }
    return{revision:row?.revision??0,selections,effectiveGeneration:null};
  }
  /** Project selected state is intent, never a native effective-generation claim. @param {any} user @param {string} projectId @param {any} input */
  async saveProject(user,projectId,input) {
    const body=extensionRequestObject(input,['expectedRevision','selections']);productInteger(body.expectedRevision,0,2147483646);
    const requested=extensionArray(body.selections).map(value=>extensionRequestObject(value,['installationId','enabled','settings','connectionRefs']));
    const ids=requested.map(selected=>extensionIdentifier(selected.installationId));
    if(new Set(ids).size!==ids.length)throw new HttpError(400,'extension_contract_invalid','Duplicate installation selection.');
    await migrateProductStore(this.database);
    const row=await this.database.transaction(async client=>{
      await this.access.account(user,client);const project=await this.access.project(user,projectId,{manage:true,client}),selections=[];
      const installations=new Map();
      for(const id of [...ids].sort()){const installation=await this.read(user,'extension-installation',id,client);if(!installation)throw missing();installations.set(id,installation);}
      // Install also takes this mutex only after its installation lock.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`extension-project:${project.userId}:${project.id}`]);
      const previous=await this.read({id:project.userId},'extension-defaults',this.projectDocumentId(project.id),client);
      if((previous?.revision??0)!==body.expectedRevision)throw new HttpError(409,'product_revision_conflict','Reload before changing project extensions.');
      for(const selected of requested) {
        if(typeof selected.enabled!=='boolean')throw new HttpError(400,'extension_contract_invalid','Invalid extension selection.');
        const installation=installations.get(selected.installationId);
        const prior=previous?.payload.selections?.find(item=>item.installationId===selected.installationId);
        const moved=prior&&(prior.integrity!==installation.payload.integrity||canonicalExtensionCoordinate(prior.coordinate)!==canonicalExtensionCoordinate(installation.payload.coordinate));
        if(moved){
          const sameSettings=canonicalJson(selected.settings)===canonicalJson(prior.settings);
          const refs=extensionArray(selected.connectionRefs,64).map(extensionIdentifier);
          const sameRefs=canonicalJson([...refs].sort())===canonicalJson([...prior.connectionRefs].sort());
          if(!sameSettings||!sameRefs||selected.enabled&&!prior.enabled)throw new HttpError(409,'product_revision_conflict','The project uses another extension version. Remove it before selecting the new version.');
          // Updating a library installation must never migrate another project's pinned configuration implicitly.
          selections.push({...prior,enabled:selected.enabled});continue;
        }
        const entry=this.descriptor(installation.payload.coordinate);const settings=this.settings(entry,selected.settings);
        const refs=await this.access.connections(user,selected.connectionRefs,{client,project,entry});
        selections.push({installationId:installation.id,catalogueId:entry.id,coordinate:installation.payload.coordinate,integrity:entry.integrity,enabled:selected.enabled,settings,connectionRefs:refs,actorId:user.id});
      }
      if(new Set(selections.map(item=>item.catalogueId)).size!==selections.length)throw new HttpError(400,'extension_contract_invalid','Duplicate selected extension.');
      return this.documents.put(project.userId,'extension-defaults',this.projectDocumentId(project.id),{schemaVersion:1,selections},{expectedRevision:body.expectedRevision,projectId:project.id,transactionClient:client});
    });return this.projectView(user,row);
  }
  /** @param {any} user @param {string} projectId */
  async projectHistory(user,projectId,options={}) {
    const project=await this.access.project(user,projectId),paging=this.historyPaging(options);
    const rows=await this.documents.history(project.userId,'extension-defaults',this.projectDocumentId(project.id),paging);
    return{items:await Promise.all(rows.map(async row=>({...await this.projectView(user,row),recordedAt:row.recordedAt}))),nextBeforeRevision:rows.length===paging.limit?rows.at(-1).revision:null};
  }
  /** @param {any} options */
  historyPaging(options) {
    extensionRequestObject(options,['beforeRevision','limit'],[]);const limit=options.limit??50,beforeRevision=options.beforeRevision??null;
    productInteger(limit,1,100);if(beforeRevision!==null)productInteger(beforeRevision,1,2147483647);return{limit,beforeRevision};
  }
}
