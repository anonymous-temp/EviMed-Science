/** Server-owned derivation receipts. Accepted input, launch and producer bytes
 * remain independent facts; no model output can manufacture any of them. */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { methodContentDigest } from '@evimed/domain';
import { nativeInputText } from '@evimed/harness-port';
import { canonicalJson } from './geoStore.mjs';
import { CONTEXT_ITEM_FIELDS, contextFactContentDigest, contextPolicyIdentity, sameContextPolicy } from './geoContextItems.mjs';
import {GeoHandbookApplications} from './geoHandbookApplications.mjs';
import { readRunTranscript } from './runTranscripts.mjs';
import { HttpError } from './security.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const hash = value => sha256(canonicalJson(value));
const fail = (code = 'geo_learning_source_unverified') => new HttpError(409,code,'The shared learning source cannot be verified.');
const proofFields = payload => ({contentDigest:payload.contentDigest,provenance:payload.provenance??null,source:payload.source??null,
  dependencies:payload.dependencies??[],frontmatter:payload.frontmatter??null,projectId:payload.projectId??null,recordType:payload.recordType??null});
const sourceIds = payload => [...new Set([payload.source?.runId,payload.provenance?.runId,
  ...(Array.isArray(payload.provenance?.sourceRunIds)?payload.provenance.sourceRunIds:[]),
  ...(Array.isArray(payload.provenance?.evidence)?payload.provenance.evidence.map(item=>item.runId):[]),
  ...(Array.isArray(payload.provenance)?payload.provenance.filter(item=>item.type==='run').map(item=>item.id):[])].filter(Boolean))];
const originOf = payload => payload?.source?.projectId ?? payload?.provenance?.sourceProjectId ?? payload?.projectId ?? null;
export const scopedMethodName = (name,policy) => `${String(name).slice(0,43).replace(/-+$/u,'')}-geo-${hash(contextPolicyIdentity(policy)).slice(0,16)}`;

export class GeoContextProvenance {
  /** @param {any} dependencies */
  constructor({documents,contextPolicies,nativeInputs,resolveSourceRun,resolveProject=null,readTranscript=(project,run)=>readRunTranscript(project,run.id),
    historicalContextReceipt,contextItems=null,maxPages=100}) {
    this.compounds=new AsyncLocalStorage();
    this.handbooks=new GeoHandbookApplications(this);
    this.documents=documents;this.contextPolicies=contextPolicies;this.nativeInputs=nativeInputs;this.resolveSourceRun=resolveSourceRun;
    this.resolveProject=resolveProject;this.readTranscript=readTranscript;this.historicalContextReceipt=historicalContextReceipt;
    this.contextItems=contextItems;this.maxPages=maxPages;
  }
  digest(value) {return hash(value);}
  async policyFor(project) { return this.contextPolicies.forProject(project); }
  async projectFor(userId,projectId) {
    const project=this.resolveProject?await this.resolveProject(userId,projectId):{userId,id:projectId};
    return project?.userId===userId&&project?.id===projectId?project:null;
  }
  async policyForJob(job) {
    const id=job.payload?.sourceProjectId??job.payload?.contextPolicy?.controlProjectId;
    return id?this.policyFor({userId:job.userId,id}):null;
  }
  async rows(userId,kind,filter={},fields=CONTEXT_ITEM_FIELDS) {
    const rows=[],seen=new Set();let cursor=null;
    for(let page=0;page<this.maxPages;page+=1) {
      const found=await this.documents.list(userId,kind,{filter,fields,limit:100,cursor});
      rows.push(...found.items);cursor=found.nextCursor;
      if(!cursor)return rows;
      if(seen.has(cursor))break;seen.add(cursor);
    }
    throw fail();
  }
  async observeRun(project,run) {
    const policy=await this.policyFor(project);
    if(policy.kind!=='geo-project')return null;
    const canonical=await this.resolveSourceRun(project.userId,project.id,run.id);
    if(!canonical||canonical.id!==run.id||canonical.userId!==project.userId||canonical.projectId!==project.id
      ||canonical.sessionId!==run.sessionId||canonical.automated===true||canonical.trigger==='automated')throw fail();
    const transcript=await this.readTranscript(project,canonical);
    if(!transcript||transcript.header&&transcript.header.completeness!=='complete'||transcript.exhausted===false)throw fail();
    const root={...transcript,messages:transcript.messages.filter(message=>!message.sessionId||message.sessionId===canonical.sessionId)};
    const attribution=await this.nativeInputs.forRun(project,canonical,root);
    if(!attribution?.complete||!attribution.inputs.length||attribution.inputs.some(input=>input.actor?.kind!=='human')
      ||attribution.namespaceId!==policy.namespace.id||attribution.policyRef!==policy.referenceId)throw fail();
    const inputs=[],words=[];
    for(const input of attribution.inputs) {
      const row=await this.documents.get(project.userId,'geo-plan-context',input.referenceId),receipt=row?.payload;
      const message=root.messages.find(item=>item.role==='user'&&item.seq===input.inputSeq&&item.sourceRequestId===input.sourceRequestId);
      if(row?.projectId!==project.id||receipt?.recordType!=='geo-native-input'||receipt.state!=='accepted'||receipt.actor?.kind!=='human'
        ||receipt.consumption?.runId!==canonical.id||receipt.rootSessionId!==canonical.sessionId||!message)throw fail();
      const text=nativeInputText(message.parts.slice(0,input.originalParts));
      if(hash(text)!==input.originalTextDigest||hash(receipt.actor)!==hash(input.actor))throw fail();
      const launched=await this.historicalContextReceipt(project,receipt.runtime?.launchedContextRef);
      if(!launched||launched.state!=='launched'||launched.referenceId!==receipt.runtime.launchedContextRef||launched.digest!==receipt.runtime.launchedContextDigest
        ||launched.generation!==receipt.runtime.generation||canonicalJson(launched.policy)!==canonicalJson(contextPolicyIdentity(policy)))throw fail();
      inputs.push({referenceId:row.id,actor:input.actor,inputSeq:input.inputSeq,sourceRequestId:input.sourceRequestId,originalTextDigest:input.originalTextDigest,
        launchedContextRef:launched.referenceId,launchedContextDigest:launched.digest,generation:launched.generation});
      words.push(text);
    }
    return {...contextPolicyIdentity(policy),runId:canonical.id,sessionId:canonical.sessionId,complete:true,inputs,
      actors:[...new Map(inputs.map(input=>[hash(input.actor),input.actor])).values()],inputReceiptRefs:inputs.map(input=>input.referenceId),
      humanText:words.join('\n'),humanMessages:attribution.inputs.map((input,index)=>({seq:input.inputSeq,text:words[index],referenceId:input.referenceId})),
      launchedContextRef:inputs[0].launchedContextRef,launchedContextDigest:inputs[0].launchedContextDigest};
  }
  proofId(userId,kind,id,payload) { return `gcp_${hash([userId,kind,id,proofFields(payload)])}`; }
  async ledger(userId,referenceId,traversal=null) {
    if(!this.contextItems?.reuse)return this.documents.get(userId,'geo-plan-context',referenceId);
    return this.contextItems.reuse(traversal,['ledger',userId,referenceId],async()=>{
      const row=await this.documents.get(userId,'geo-plan-context',referenceId);
      this.contextItems.recheck(traversal,['ledger',userId,referenceId],async()=>canonicalJson(await this.documents.get(userId,'geo-plan-context',referenceId))===canonicalJson(row));
      return row;
    });
  }
  async proofFor(userId,kind,document,traversal=null) {
    const referenceId=this.proofId(userId,kind,document.id,document.payload);
    const pending=this.handbooks.pending(userId,referenceId)??this.compounds.getStore()?.proofs.get(referenceId);if(pending)return pending;
    const row=await this.ledger(userId,referenceId,traversal);
    return row?.payload?.recordType==='geo-context-producer-proof'?row.payload:null;
  }
  async authorize(policy,kind,document) {
    if(!document)return false;
    if(policy?.kind==='owned')return this.ordinaryDocument(policy.ownerId,document);
    return this.contextItems?.authorize(policy,kind,document,new Set())??false;
  }
  async ordinaryDocument(userId,row) {
    const versions=[row];let beforeRevision=null;
    for(let page=0;page<this.maxPages;page+=1) {
      const saved=await this.documents.history(userId,'method',row.id,{limit:100,beforeRevision,fields:CONTEXT_ITEM_FIELDS});
      versions.push(...saved);
      if(saved.length<100)break;
      const next=saved.at(-1).revision;
      if(beforeRevision!==null&&next>=beforeRevision||page===this.maxPages-1)return false;
      beforeRevision=next;
    }
    for(const version of versions) {
      const ids=[version.payload?.source?.projectId,version.payload?.provenance?.sourceProjectId,...(version.payload?.provenance?.sourceProjectIds??[])].filter(Boolean);
      for(const id of ids)if((await this.policyFor({userId,id})).kind==='geo-project')return false;
    }
    return true;
  }
  async scopedMethods(userId,policy=null) {
    const rows=await this.rows(userId,'method',{recordType:'learned-method'}),allowed=[];
    for(const row of rows) {
      if(policy?.kind==='geo-project'?!await this.authorize(policy,'method',row):!await this.ordinaryDocument(userId,row))continue;
      const document=await this.documents.get(userId,'method',row.id,{expectedRevision:row.revision});
      if(document&&(policy?.kind!=='geo-project'||await this.authorize(policy,'method',document)))allowed.push(document);
    }
    return allowed;
  }
  async methodFor(userId,id,policy) {
    const row=(await this.rows(userId,'method',{recordType:'learned-method'})).find(item=>item.id===id);
    if(!row||!await this.authorize(policy,'method',row))return null;
    const document=await this.documents.get(userId,'method',id,{expectedRevision:row.revision});
    return document&&await this.authorize(policy,'method',document)?document:null;
  }
  /** Freeze the first request before dispatch. A resumed dispatch may reuse only
   * the same bytes and exact method versions, never recapture a different input. */
  async freezeInput(userId,policy,dispatchId,input,methods,observations=[]) {
    if(policy?.kind!=='geo-project')return null;
    const parents=[];
    for(const method of methods) {
      const current=await this.methodFor(userId,method.id,policy);
      if(!current||current.revision!==method.revision||canonicalJson(current.payload)!==canonicalJson(method.payload))throw fail('geo_learning_input_stale');
      parents.push({kind:'method',id:method.id,revision:method.revision,contentDigest:method.payload.contentDigest,
        proofRef:this.proofId(userId,'method',method.id,method.payload)});
    }
    const sources=observations.map(({humanText: _text,humanMessages: _messages,...source})=>source);
    const payload={recordType:'geo-context-generation-input',version:1,...contextPolicyIdentity(policy),dispatchId,inputDigest:hash(input),parents,sources};
    const referenceId=`gci_${hash([userId,dispatchId])}`;
    const persist=async()=> {
      const previous=await this.documents.get(userId,'geo-plan-context',referenceId);
      if(previous) {
        if(canonicalJson(previous.payload)!==canonicalJson(payload))throw fail('geo_learning_input_stale');
        return referenceId;
      }
      await this.documents.put(userId,'geo-plan-context',referenceId,payload,{expectedRevision:0,projectId:policy.controlProjectId});
      return referenceId;
    };
    try{return await persist();}catch(error){if(error?.code!=='product_revision_conflict')throw error;return persist();}
  }
  async generationInput(userId,policy,referenceId) {
    const row=await this.documents.get(userId,'geo-plan-context',referenceId),saved=row?.payload;
    if(saved?.recordType!=='geo-context-generation-input'||row.projectId!==policy.controlProjectId
      ||row.id!==`gci_${hash([userId,saved.dispatchId])}`
      ||!Object.entries(contextPolicyIdentity(policy)).every(([key,value])=>saved[key]===value))throw fail();
    return saved;
  }
  deferMountChange(callback) {
    const scope=this.compounds.getStore();
    if(!scope)return false;
    scope.mountChanged=callback;return true;
  }
  async compoundReceipt(policy,referenceId) {
    const scope=this.compounds.getStore();
    if(scope?.userId===policy.ownerId&&scope.referenceId===referenceId&&sameContextPolicy(scope.policy,policy))return scope.receipt;
    const row=await this.documents.get(policy.ownerId,'geo-plan-context',referenceId),receipt=row?.payload;
    if(receipt?.recordType!=='geo-context-compound-application'||!receipt.complete||row.projectId!==policy.controlProjectId
      ||referenceId!==`gca_${hash(receipt)}`||!Object.entries(contextPolicyIdentity(policy)).every(([key,value])=>receipt[key]===value))return null;
    return receipt;
  }
  compoundGroupIdentity(members) {
    return hash(members.map(row=>[row.kind??'method',row.id]).sort());
  }
  async completedCompound(userId,policy,jobId,members,assignments=null,jobOnly=false) {
    if(policy?.kind!=='geo-project')return null;
    // A sleep job owns several disjoint groups. Its server-supplied complete
    // member identity survives the exact same result's own body amendments.
    const identity=this.compoundGroupIdentity(members),ids=new Set(members.map(row=>row.id));
    if(ids.size!==members.length)throw fail('geo_learning_input_stale');
    const fields={inputs:true,outputs:true,groupIdentity:true,assignmentDigest:true};
    const found=await this.rows(userId,'geo-plan-context',{recordType:'geo-context-compound-application',producerJobId:jobId},fields);
    let matching=found.filter(row=>this.compoundGroupIdentity(row.payload.inputs)===identity);
    if(found.some(row=>this.compoundGroupIdentity(row.payload.inputs)!==identity&&row.payload.inputs.some(pin=>ids.has(pin.id))))throw fail('geo_learning_input_stale');
    const matchesInputs=receipt=>members.every(member=>{
      const referenceId=this.proofId(userId,'method',member.id,member.payload);
      const original=receipt.inputs.find(pin=>pin.id===member.id),successor=receipt.outputs.find(output=>output.id===member.id)?.after;
      return original&&[original,successor].filter(Boolean).some(pin=>pin.contentDigest===member.payload.contentDigest&&pin.proofRef===referenceId);
    });
    if(!matching.length&&!jobOnly&&assignments) {
      // A lost convenience stamp may outlive its job. Reuse only the exact
      // group/input/decision already paid for, never an arbitrary job result.
      const previous=await this.rows(userId,'geo-plan-context',{recordType:'geo-context-compound-application',...contextPolicyIdentity(policy),
        groupIdentity:identity,assignmentDigest:hash(assignments)},fields);
      matching=previous.filter(row=>matchesInputs(row.payload));
    }
    if(!matching.length)return null;
    if(matching.length!==1)throw fail('geo_learning_input_stale');
    const receipt=await this.compoundReceipt(policy,matching[0].id);
    if(!receipt||receipt.groupIdentity&&receipt.groupIdentity!==identity
      ||assignments&&receipt.assignmentDigest!==hash(assignments)
      ||receipt.assignments&&receipt.assignmentDigest!==hash(receipt.assignments)||!matchesInputs(receipt)
      ||members.some(row=>methodContentDigest(row.payload,sha256)!==row.payload.contentDigest))throw fail('geo_learning_input_stale');
    const generation=await this.generationInput(userId,policy,receipt.generationInputRef);
    if(generation.dispatchId!==receipt.dispatchId||receipt.inputDigest!==generation.inputDigest||canonicalJson(generation.parents)!==canonicalJson(receipt.inputs))throw fail('geo_learning_input_stale');
    await this.validateCompoundOutputs(policy,receipt);
    return receipt.result;
  }
  async validateCompoundOutputs(policy,receipt) {
    const traversal={memo:new Map(),snapshots:new Map(),remaining:this.contextItems.maxWork};
    for(const output of receipt.outputs) {
      const row=await this.documents.get(policy.ownerId,output.kind,output.id);
      if(!row||hash(proofFields(row.payload))!==output.after.structureDigest
        ||this.proofId(policy.ownerId,output.kind,row.id,row.payload)!==output.after.proofRef
        ||!await this.contextItems.authorize(policy,output.kind,row,new Set(),row.payload.status==='approved'?'learned':null,traversal))throw fail('geo_learning_compound_invalid');
    }
    if(!await this.documents.matchesSnapshots(policy.ownerId,[...traversal.snapshots.values()],{fields:CONTEXT_ITEM_FIELDS})||!await this.contextItems.currentPolicy(policy))throw fail('geo_learning_compound_invalid');
  }
  async applyCompound(userId,policy,binding,apply) {
    const result=await this.documents.database.transaction(client=>this.documents.database.withTransactionClient(client,async()=>{
      const generation=await this.generationInput(userId,policy,binding.generationInputRef);
      if(generation.dispatchId!==binding.dispatchId||binding.groupIdentity!==this.compoundGroupIdentity(generation.parents)
        ||binding.assignmentDigest!==hash(binding.assignments))throw fail('geo_learning_input_stale');
      const traversal={memo:new Map(),snapshots:new Map(),remaining:this.contextItems.maxWork};
      for(const pin of generation.parents) {
        const row=await this.methodFor(userId,pin.id,policy);
        if(!row||row.revision!==pin.revision||this.proofId(userId,'method',row.id,row.payload)!==pin.proofRef
          ||!await this.contextItems.authorize(policy,'method',row,new Set(),null,traversal))throw fail('geo_learning_input_stale');
      }
      const snapshots=[...traversal.snapshots.values()];
      if(snapshots.length>512)throw fail();
      if(snapshots.length)await client.query(`SELECT documents.id FROM evimed_product.documents
        JOIN jsonb_to_recordset($2::jsonb) AS wanted(kind text,id text) ON documents.kind=wanted.kind AND documents.id=wanted.id
        WHERE documents.user_id=$1 ORDER BY documents.kind,documents.id FOR UPDATE OF documents`,[userId,JSON.stringify(snapshots.map(row=>({kind:row.kind,id:row.id})))]);
      if(!await this.documents.matchesSnapshots(userId,snapshots,{fields:CONTEXT_ITEM_FIELDS}))throw fail('geo_learning_input_stale');
      const inputClosure=[];
      for(const snapshot of snapshots) {
        const row={...snapshot,userId},versions=await this.contextItems.versions(policy,row.kind,row,traversal);
        if(!versions)throw fail();
        const saved=[];
        for(const version of versions) {
          if(!this.contextItems.spend(traversal))throw fail();
          const proof=await this.proofFor(userId,row.kind,version);if(!proof)throw fail();
          saved.push({...version,payload:version.payload,proofRef:this.proofId(userId,row.kind,version.id,version.payload)});
        }
        inputClosure.push({...snapshot,proofRef:this.proofId(userId,row.kind,row.id,row.payload),versions:saved});
      }
      const receipt={recordType:'geo-context-compound-application',version:1,...contextPolicyIdentity(policy),...binding,
        inputDigest:generation.inputDigest,inputs:generation.parents,inputClosure,outputs:[],complete:true};
      const scope={userId,policy,receipt,referenceId:'pending-compound',proofs:new Map(),mountChanged:null};
      return this.compounds.run(scope,async()=>{
        receipt.result=await apply();
        scope.referenceId=`gca_${hash(receipt)}`;
        for(const proof of scope.proofs.values())proof.compoundApplicationRef=scope.referenceId;
        for(const [referenceId,proof] of scope.proofs)await this.documents.put(userId,'geo-plan-context',referenceId,proof,{projectId:policy.controlProjectId,expectedRevision:0,transactionClient:client});
        await this.documents.put(userId,'geo-plan-context',scope.referenceId,receipt,{projectId:policy.controlProjectId,expectedRevision:0,transactionClient:client});
        await this.validateCompoundOutputs(policy,receipt);
        return {result:receipt.result,mountChanged:scope.mountChanged};
      });
    }));
    result.mountChanged?.();return result.result;
  }
  async certifyConsumedParent({policy,document,kind,consumedParent,traversal}) {
    const proof=await this.proofFor(policy.ownerId,kind,document),referenceId=proof?.compoundApplicationRef;
    if(!referenceId||!this.contextItems.spend(traversal))return null;
    const receipt=await this.compoundReceipt(policy,referenceId);
    if(!receipt||!receipt.outputs.some(output=>output.id===document.id&&output.after.proofRef===this.proofId(policy.ownerId,kind,document.id,document.payload))
      ||!receipt.inputs.some(pin=>canonicalJson(pin)===canonicalJson(consumedParent)))return null;
    const memoKey=canonicalJson(['compound-certificate',contextPolicyIdentity(policy),referenceId,consumedParent,this.proofId(policy.ownerId,kind,document.id,document.payload)]);
    if(traversal.memo.has(memoKey))return traversal.memo.get(memoKey)?{historical:true}:null;
    traversal.memo.set(memoKey,false);
    if(!await this.verifyCompoundClosure(policy,referenceId,receipt,traversal))return null;
    traversal.memo.set(memoKey,true);return {historical:true};
  }
  async verifyCompoundClosure(policy,referenceId,receipt,traversal) {
    if(receipt.inputClosure.length>512||!this.contextItems.spend(traversal,receipt.inputClosure.length))return false;
    for(const frozen of receipt.inputClosure) {
      const head=await this.documents.get(policy.ownerId,frozen.kind,frozen.id);
      if(!head)return false;
      const output=receipt.outputs.find(item=>item.kind===frozen.kind&&item.id===frozen.id);
      const expected=output?.after??{...frozen,contentDigest:frozen.payload.contentDigest};
      if(head.revision<expected.revision||head.payload.contentDigest!==expected.contentDigest
        ||this.proofId(policy.ownerId,frozen.kind,head.id,head.payload)!==expected.proofRef
        ||output&&hash(proofFields(head.payload))!==output.after.structureDigest)return false;
      // Scalar/current-history/source validation is mandatory; the new head's
      // reuse edges are not retroactive edges of the frozen original input.
      if(!await this.contextItems.authorize(policy,frozen.kind,head,new Set(),{kind:'compound-current',referenceId},traversal))return false;
      const lineageDigest=hash(frozen.versions.map(row=>({id:row.id,revision:row.revision,payload:row.payload,deletedAt:row.deletedAt??null})));
      for(const version of frozen.versions) {
        if(!this.contextItems.spend(traversal)||!await this.contextItems.verifyVersion(policy,frozen.kind,version,lineageDigest,traversal,null,version.revision,referenceId,true))return false;
      }
    }
    return this.contextItems.currentPolicy(policy);
  }
  async prepare(userId,kind,id,payload,{expectedRevision=0}={}) {
    const projectId=originOf(payload);
    const policy=projectId?await this.policyFor({userId,id:projectId}):null;
    if(policy?.kind!=='geo-project')return null;
    const project=await this.projectFor(userId,projectId);if(!project)throw fail();
    const contributingProjects=[payload.projectId,payload.source?.projectId,payload.provenance?.sourceProjectId,
      ...(payload.provenance?.sourceProjectIds??[]),...(Array.isArray(payload.provenance)?payload.provenance.map(item=>item.projectId):[])].filter(Boolean);
    if(contributingProjects.some(contributor=>contributor!==projectId))throw fail();
    const parents=[];
    let prior=null;
    if(expectedRevision) {
      prior=(await this.rows(userId,kind,kind==='method'?{recordType:payload.recordType}:{})).find(row=>row.id===id);
      if(!prior||prior.revision!==expectedRevision||!await this.authorize(policy,kind,prior)&&!await this.handbooks.allowsPrior(policy,prior))throw fail('geo_learning_target_unverified');
      parents.push(prior);
    }
    // A carried reference is historical ancestry, already checked through the
    // self-prior proof. Only a newly adopted result revalidates a dispatch input.
    const generation=payload.provenance?.generationInputRef&&payload.provenance.generationInputRef!==prior?.payload.provenance?.generationInputRef
      ?await this.generationInput(userId,policy,payload.provenance.generationInputRef):null;
    for(const frozen of generation?.parents??[]) {
      const scope=this.compounds.getStore();
      const captured=scope?.receipt.inputClosure.find(row=>row.id===frozen.id&&row.kind===frozen.kind&&row.revision===frozen.revision);
      const current=captured?{...captured,payload:captured.payload}:await this.methodFor(userId,frozen.id,policy);
      if(!current||current.revision!==frozen.revision||current.payload.contentDigest!==frozen.contentDigest
        ||this.proofId(userId,'method',current.id,current.payload)!==frozen.proofRef)throw fail('geo_learning_input_stale');
      parents.push(current);
    }
    for(const source of [payload.source?.candidateId,...(payload.provenance?.mergedFrom??[]).map(item=>item.methodId)].filter(Boolean)) {
      const parent=(await this.rows(userId,'method')).find(row=>row.id===source);
      const expected=source===payload.source?.candidateId?payload.source.candidateDigest:payload.provenance.mergedFrom.find(item=>item.methodId===source).digest;
      const allowed=parent&&(parent.payload.status==='retired'&&parents[0]?.id===id
        ? await this.contextItems.authorize(policy,'method',parent,new Set(),{kind:'merged-ancestor',target:parents[0]})
        : await this.authorize(policy,'method',parent));
      if(!parent||parent.payload.contentDigest!==expected||!allowed)throw fail();parents.push(parent);
    }
    for(const dependency of payload.dependencies??[]) {
      const matching=await this.rows(userId,'method',{recordType:'learned-method',frontmatter:{name:dependency.name},contentDigest:dependency.digest});
      if(matching.length!==1||!await this.authorize(policy,'method',matching[0]))throw fail();parents.push(matching[0]);
    }
    const sources=new Map();
    const addSource=source=>{
      const priorSource=sources.get(source.runId);
      if(priorSource&&canonicalJson(priorSource)!==canonicalJson(source))throw fail('geo_learning_input_stale');
      sources.set(source.runId,source);
    };
    for(const source of generation?.sources??[]) {
      const canonical=await this.resolveSourceRun(userId,projectId,source.runId);
      if(!canonical)throw fail();
      const {humanText: _text,humanMessages: _messages,...current}=await this.observeRun(project,canonical);
      if(canonicalJson(current)!==canonicalJson(source))throw fail('geo_learning_input_stale');
      addSource(source);
    }
    for(const parent of parents) {
      const proof=await this.proofFor(userId,parent.kind??'method',parent);if(!proof)throw fail();
      for(const source of proof.sources)addSource(source);
    }
    for(const runId of sourceIds(payload)) {
      const run=await this.resolveSourceRun(userId,projectId,runId);if(!run)throw fail();
      const observation=await this.observeRun(project,run);const {humanText: _text,humanMessages: _messages,...saved}=observation;
      addSource(saved);
    }
    if(!sources.size)throw fail();
    const traversal={memo:new Map(),snapshots:new Map(),remaining:this.contextItems.maxWork};
    for(const parent of parents) {
      const scope=this.compounds.getStore();
      const captured=scope?.receipt.inputClosure.find(row=>row.id===parent.id&&row.revision===parent.revision&&row.proofRef===this.proofId(userId,parent.kind??'method',parent.id,parent.payload));
      if(captured)continue;
      const hydrated=await this.documents.get(userId,parent.kind??'method',parent.id,{expectedRevision:parent.revision});
      if(hydrated&&await this.handbooks.allowsPrior(policy,hydrated,traversal))continue;
      const role=hydrated?.payload.status==='retired'?{kind:'merged-ancestor',target:parents.find(row=>row.id===id)}:null;
      if(!hydrated||!await this.contextItems.authorize(policy,parent.kind??'method',hydrated,new Set(),role,traversal))throw fail('geo_learning_input_stale');
    }
    const snapshots=[...traversal.snapshots.values()];
    if(snapshots.length>512||!await this.documents.matchesSnapshots(userId,snapshots,{fields:CONTEXT_ITEM_FIELDS}))throw fail('geo_learning_input_stale');
    return {snapshots,policy,project,parents:[...new Map(parents.map(row=>[`${row.kind??'method'}:${row.id}:${row.revision}`,row])).values()].map(row=>({kind:row.kind??'method',id:row.id,revision:row.revision,contentDigest:row.payload.contentDigest,proofRef:this.proofId(userId,row.kind??'method',row.id,row.payload)})),sources:[...sources.values()]};
  }
  async write(userId,kind,id,payload,options) {
    const projectId=originOf(payload);
    if(!projectId||(await this.policyFor({userId,id:projectId})).kind!=='geo-project')return this.documents.put(userId,kind,id,payload,options);
    const actual=kind==='fact'?contextFactContentDigest(payload):methodContentDigest(payload,sha256);
    if(actual!==payload.contentDigest)throw fail();
    const operation=async client=>{
      const prepared=await this.prepare(userId,kind,id,payload,options);
      if(!prepared)throw fail();
      // Hold the same bounded product heads until the body/proof commit. The
      // shared closure comparison catches a change while the locks were taken.
      if(prepared.snapshots.length) {
        await client.query(`SELECT documents.id FROM evimed_product.documents
          JOIN jsonb_to_recordset($2::jsonb) AS wanted(kind text,id text)
            ON documents.kind=wanted.kind AND documents.id=wanted.id
          WHERE documents.user_id=$1 ORDER BY documents.kind,documents.id FOR SHARE OF documents`,
          [userId,JSON.stringify(prepared.snapshots.map(snapshot=>({kind:snapshot.kind,id:snapshot.id})))]);
        if(!await this.documents.matchesSnapshots(userId,prepared.snapshots,{fields:CONTEXT_ITEM_FIELDS}))throw fail('geo_learning_input_stale');
      }
      if(!sameContextPolicy(prepared.policy,await this.policyFor(prepared.project)))throw fail();
      const document=await this.documents.put(userId,kind,id,payload,{...options,transactionClient:client});
      /** @type {any} */
      const proof={recordType:'geo-context-producer-proof',version:1,...contextPolicyIdentity(prepared.policy),documentId:id,documentKind:kind,
        producerRevision:document.revision,contentDigest:actual,structureDigest:hash(proofFields(payload)),sources:prepared.sources,parents:prepared.parents,complete:true};
      if(this.handbooks.register(userId,document,proof))return document;
      const scope=this.compounds.getStore();
      if(scope) {
        const proofId=this.proofId(userId,kind,id,payload);
        proof.compoundApplicationRef=scope.referenceId;
        scope.proofs.set(proofId,proof);
        const prior=scope.receipt.inputClosure.find(row=>row.kind===kind&&row.id===id);
        scope.receipt.outputs.push({kind,id,before:prior?{kind,id,revision:prior.revision,contentDigest:prior.payload.contentDigest,proofRef:prior.proofRef}:null,
          after:{revision:document.revision,contentDigest:actual,structureDigest:proof.structureDigest,proofRef:proofId}});
        return document;
      }
      const proofId=this.proofId(userId,kind,id,payload),existing=await this.documents.get(userId,'geo-plan-context',proofId);
      if(!existing)await this.documents.put(userId,'geo-plan-context',proofId,proof,{expectedRevision:0,projectId:prepared.project.id,transactionClient:client});
      else if(existing.payload.structureDigest!==proof.structureDigest||existing.payload.producerRevision>document.revision)throw fail();
      return document;
    };
    return options.transactionClient?operation(options.transactionClient):this.documents.database.transaction(client=>this.documents.database.withTransactionClient(client,()=>operation(client)));
  }
  async retireMerged(userId, source, target, {proposedBy,reason}) {
    const projectId=originOf(target.payload),policy=await this.policyFor({userId,id:projectId});
    if(policy.kind!=='geo-project'||source.payload.status!=='approved'||target.payload.status!=='approved'
      ||!await this.authorize(policy,'method',source)||!await this.authorize(policy,'method',target))throw fail();
    const targetProof=await this.proofFor(userId,'method',target),sourceProof=await this.proofFor(userId,'method',source);
    if(!targetProof||!sourceProof||target.payload.provenance?.consolidatedBy!==proposedBy
      ||!target.payload.provenance?.mergedFrom?.some(parent=>parent.methodId===source.id&&parent.digest===source.payload.contentDigest)
      ||!targetProof.parents.some(parent=>parent.id===source.id&&parent.contentDigest===source.payload.contentDigest))throw fail();
    return this.documents.database.transaction(client=>this.documents.database.withTransactionClient(client,async()=>{
      const retired=await this.documents.put(userId,'method',source.id,{...source.payload,status:'retired',statusReason:reason,statusChangedAt:new Date().toISOString()},
        {expectedRevision:source.revision,transactionClient:client});
      const receipt={recordType:'geo-context-merge-retirement',version:1,...contextPolicyIdentity(policy),proposedBy,
        source:{id:source.id,previousRevision:source.revision,revision:retired.revision,contentDigest:source.payload.contentDigest},
        target:{id:target.id,revision:target.revision,contentDigest:target.payload.contentDigest},
        sourceProofRef:this.proofId(userId,'method',source.id,source.payload),targetProofRef:this.proofId(userId,'method',target.id,target.payload)};
      const referenceId=`gcm_${hash(receipt)}`;
      await this.documents.put(userId,'geo-plan-context',referenceId,receipt,{projectId,expectedRevision:0,transactionClient:client});
      return retired;
    }));
  }
  async descendsFromProof(policy,document,referenceId,traversal=null) {
    const initial=await this.proofFor(policy.ownerId,'method',document,traversal),queue=initial?[initial]:[],seen=new Set();
    for(let work=0;queue.length&&work<512;work+=1) {
      const current=queue.shift();
      if(current.documentId!==document.id||!Object.entries(contextPolicyIdentity(policy)).every(([key,value])=>current[key]===value))continue;
      for(const parent of current.parents??[]) {
        if(parent.id!==document.id||!parent.proofRef||seen.has(parent.proofRef))continue;
        const proof=await this.ledger(policy.ownerId,parent.proofRef,traversal);
        if(proof?.payload?.recordType!=='geo-context-producer-proof'||proof.payload.documentId!==parent.id
          ||proof.payload.contentDigest!==parent.contentDigest||proof.payload.producerRevision>parent.revision)continue;
        if(parent.proofRef===referenceId)return true;
        seen.add(parent.proofRef);queue.push(proof.payload);
      }
    }
    return false;
  }
  async verifyMergedAncestor({policy,document,target}) {
    if(document.payload.status!=='retired')return false;
    const receipts=await this.rows(policy.ownerId,'geo-plan-context',{recordType:'geo-context-merge-retirement',
      source:{id:document.id,revision:document.revision,contentDigest:document.payload.contentDigest},target:{id:target.id}},null);
    for(const row of receipts) {
      const receipt=row.payload;
      if(row.projectId!==policy.controlProjectId||row.id!==`gcm_${hash(receipt)}`
        ||!Object.entries(contextPolicyIdentity(policy)).every(([key,value])=>receipt[key]===value)
        ||receipt.target.revision>target.revision)continue;
      const proof=await this.documents.get(policy.ownerId,'geo-plan-context',receipt.targetProofRef);
      const sourceProof=await this.documents.get(policy.ownerId,'geo-plan-context',receipt.sourceProofRef);
      if(proof?.payload?.recordType!=='geo-context-producer-proof'||sourceProof?.payload?.recordType!=='geo-context-producer-proof'
        ||proof.payload.documentId!==target.id||proof.payload.contentDigest!==receipt.target.contentDigest
        ||!(proof.payload.structureDigest===hash(proofFields(target.payload))||await this.descendsFromProof(policy,target,receipt.targetProofRef))
        ||!proof.payload.parents.some(parent=>parent.id===document.id&&parent.contentDigest===document.payload.contentDigest)
        ||sourceProof.payload.documentId!==document.id||sourceProof.payload.contentDigest!==document.payload.contentDigest
        ||sourceProof.payload.structureDigest!==hash(proofFields(document.payload)))continue;
      return true;
    }
    return false;
  }
  async verifyAcceptedContext({policy,run,document,kind,lineageDigest,consumedParent=null,traversal=null,compoundApplicationRef=null,frozen=false,compoundCurrent=false,handbookHistoryRef=null}) {
    if(consumedParent)return await this.handbooks.certifyParent({policy,document,consumedParent,traversal})??this.certifyConsumedParent({policy,document,kind,consumedParent,traversal});
    if(!this.contextItems)return null;
    if(compoundCurrent) {
      const receipt=await this.compoundReceipt(policy,compoundApplicationRef),headNow=await this.documents.get(policy.ownerId,kind,document.id);
      const captured=receipt?.inputClosure.find(row=>row.kind===kind&&row.id===document.id);
      const output=receipt?.outputs.find(row=>row.kind===kind&&row.id===document.id);
      const expected=output?.after??captured;
      if(!captured||!headNow||!expected||headNow.revision<expected.revision
        ||this.proofId(policy.ownerId,kind,headNow.id,headNow.payload)!==expected.proofRef)return null;
    }
    const head=await this.contextItems.canonical(policy,kind,document.id,document.payload.recordType,traversal);
    let versions=head?await this.contextItems.versions(policy,kind,head,traversal):null;
    if(handbookHistoryRef){
      versions=await this.handbooks.historyVersions(policy,handbookHistoryRef,document,traversal);
    }
    if(frozen) {
      const receipt=await this.compoundReceipt(policy,compoundApplicationRef);
      const certificate=receipt?.inputClosure.find(row=>row.kind===kind&&row.id===document.id);
      if(!certificate||!certificate.versions.some(row=>canonicalJson(row.payload)===canonicalJson(document.payload)&&row.revision===document.revision))return null;
      versions=certificate.versions;
    }
    if(!versions || hash(versions.map(row=>({id:row.id,revision:row.revision,payload:row.payload,deletedAt:row.deletedAt??null})))!==lineageDigest
      || !versions.some(row=>row.revision===document.revision&&hash(proofFields(row.payload))===hash(proofFields(document.payload))))return null;
    const proof=await this.proofFor(policy.ownerId,kind,document,traversal);
    if(!proof||proof.documentId!==document.id||proof.documentKind!==kind||proof.producerRevision>document.revision
      ||proof.contentDigest!==document.payload.contentDigest||proof.structureDigest!==hash(proofFields(document.payload))
      ||!proof.complete||!proof.sources?.length||!Object.entries(contextPolicyIdentity(policy)).every(([key,value])=>proof[key]===value))return null;
    if(!await this.handbooks.applicationProof(policy,document,proof,traversal))return null;
    const project=await this.projectFor(policy.ownerId,policy.controlProjectId);if(!project)return null;
    for(const source of proof.sources) {
      const canonical=await this.contextItems.sourceRun(policy,source.runId,traversal);
      if(!canonical)return null;
      let observation;try{observation=await this.contextItems.reuse(traversal,['source-observation',contextPolicyIdentity(policy),source.runId],async()=>{
        const observed=await this.observeRun(project,canonical);
        this.contextItems.recheck(traversal,['source-observation',source.runId],async()=>{
          try{return canonicalJson(await this.observeRun(project,canonical))===canonicalJson(observed);}catch{return false;}
        });
        return observed;
      });}catch{return null;}
      const {humanText: _text,humanMessages: _messages,...saved}=observation;
      if(canonicalJson(saved)!==canonicalJson(source))return null;
    }
    for(const parent of proof.parents??[]) {
      const saved=await this.ledger(policy.ownerId,parent.proofRef,traversal),p=this.compounds.getStore()?.proofs.get(parent.proofRef)??saved?.payload;
      if(p?.recordType!=='geo-context-producer-proof'||p.documentId!==parent.id||p.documentKind!==parent.kind
        ||p.contentDigest!==parent.contentDigest||p.producerRevision>parent.revision
        ||!Object.entries(contextPolicyIdentity(policy)).every(([key,value])=>p[key]===value))return null;
      if(parent.id===document.id) {
        if(parent.revision>=document.revision)return null;
        let prior=versions.find(row=>row.revision===parent.revision&&row.revision<document.revision);
        if(!prior)prior=await this.handbooks.selfPrior(policy,document,proof,parent,traversal);
        if(!prior&&proof.compoundApplicationRef) {
          const receipt=await this.compoundReceipt(policy,proof.compoundApplicationRef);
          prior=receipt?.inputClosure.find(row=>row.id===document.id&&row.kind===kind&&row.revision===parent.revision);
        }
        if(!prior||parent.contentDigest!==prior.payload.contentDigest||parent.proofRef!==this.proofId(policy.ownerId,kind,prior.id,prior.payload))return null;
      }
    }
    const source=proof.sources.find(item=>item.runId===run.id);if(!source)return null;
    if(!sameContextPolicy(policy,await this.policyFor(project)))return null;
    return {...contextPolicyIdentity(policy),documentId:document.id,documentRevision:document.revision,runId:run.id,contentDigest:proof.contentDigest,
      lineageDigest,complete:true,compoundCurrentVerified:compoundCurrent,producerProofRef:this.proofId(policy.ownerId,kind,document.id,document.payload),producerParents:proof.parents??[],inputReceiptRefs:[...new Set(proof.sources.flatMap(item=>item.inputReceiptRefs))],
      launchedContextRef:source.launchedContextRef,launchedContextDigest:source.launchedContextDigest};
  }
}
