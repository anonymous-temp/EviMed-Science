/** Metadata-first private context authorization. Project labels only shortlist;
 * the injected verifier owns accepted-input, launch and derived-body receipts. */
import { createHash } from 'node:crypto';
import { methodContentDigest } from '@evimed/domain';
import { canonicalJson } from './geoStore.mjs';

export const CONTEXT_ITEM_FIELDS = Object.freeze(Object.fromEntries([
  'source','provenance','dependencies','contentDigest','frontmatter','recordType','status','binding','projectId','capsuleId',
  'origin','factKind','layer','curatedAt','createdAt','version','appliedAt','statusChangedAt','scientific','scope',
].map(key => [key, true])));
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const digest = value => typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const contextFactContentDigest = payload => `sha256:${hash({content:payload.content,factKind:payload.factKind,layer:payload.layer})}`;

/** The complete identity is frozen into resident/context/mount receipts. */
export function contextPolicyIdentity(policy) {
  if (!policy) return null;
  if (policy.kind === 'owned') return {kind:'owned',ownerId:policy.ownerId,controlProjectId:policy.controlProjectId};
  return {kind:policy.kind,ownerId:policy.ownerId,controlProjectId:policy.controlProjectId,ownerCreatedAt:policy.ownerCreatedAt,
    projectCreatedAt:policy.projectCreatedAt,policyVersion:policy.policyVersion,policyRevision:policy.revision,
    policyRef:policy.referenceId,namespaceId:policy.namespace?.id};
}
export const sameContextPolicy = (left, right) => canonicalJson(contextPolicyIdentity(left)) === canonicalJson(contextPolicyIdentity(right));

/** Root supplies one instance to all readers. The verifier must return a
 * canonical server-owned receipt binding documentId/documentRevision,
 * contentDigest, lineageDigest and each run to the full policy identity,
 * inputReceiptRefs and launchedContextRef/launchedContextDigest. No payload
 * flag, latest-run tag, bounded sourceProjectIds summary or public flag is proof.
 * A bounded traversal must observe its end; exhaustion fails closed.
 */
export class ContextItemAuthorization {
  constructor({documents,resolveSourceRun=null,verifyAcceptedContext=null,verifyMergedAncestor=null,contextPolicies=null,maxPages=100,maxDepth=32,maxWork=20000}) {
    this.documents=documents;this.resolveSourceRun=resolveSourceRun;this.verifyAcceptedContext=verifyAcceptedContext;this.verifyMergedAncestor=verifyMergedAncestor;
    this.contextPolicies=contextPolicies;this.maxPages=maxPages;this.maxDepth=maxDepth;
    this.maxWork=Number.isSafeInteger(maxWork)&&maxWork>=0?Math.min(maxWork,100000):0;
  }
  spend(traversal,amount=1) {
    if(!traversal)return true;
    traversal.remaining-=amount;
    return traversal.remaining>=0;
  }
  /** Reads belong to one bounded traversal. Final checks re-read proofs and
   * sources before the complete live-head comparison; no positive cache escapes. */
  async reuse(traversal,key,read) {
    if(!traversal)return read();
    const reads=traversal.reads??=new Map(),id=canonicalJson(key);
    if(!reads.has(id))reads.set(id,Promise.resolve().then(read));
    return reads.get(id);
  }
  /** @param {any} traversal */
  recheck(traversal,key,check) {
    if(traversal)(traversal.rechecks??=new Map()).set(canonicalJson(key),check);
  }
  /** @param {any} traversal */
  async finish(policy,traversal) {
    const snapshots=[...traversal.snapshots.values()];
    if(snapshots.length>512||!this.spend(traversal,snapshots.length)||typeof this.documents.matchesSnapshots!=='function')return false;
    for(const check of traversal.rechecks?.values()??[])if(!this.spend(traversal)||!await check())return false;
    return await this.documents.matchesSnapshots(policy.ownerId,snapshots,{fields:CONTEXT_ITEM_FIELDS})&&this.currentPolicy(policy);
  }
  async sourceRun(policy,id,traversal) {
    const key=['source-run',contextPolicyIdentity(policy),id];
    return this.reuse(traversal,key,async()=>{
      const run=await this.resolveSourceRun(policy.ownerId,policy.controlProjectId,id),identity=canonicalJson(run);
      this.recheck(traversal,key,async()=>canonicalJson(await this.resolveSourceRun(policy.ownerId,policy.controlProjectId,id))===identity);
      return run;
    });
  }
  async currentPolicy(policy) {
    if (policy?.kind !== 'geo-project') return policy?.kind === 'owned';
    const identity = contextPolicyIdentity(policy);
    if (Object.values(identity).some(value=>value === undefined || value === null || value === '') || policy.policyVersion !== 1) return false;
    if (!this.contextPolicies || !sameContextPolicy(policy,await this.contextPolicies.forProject({userId:policy.ownerId,id:policy.controlProjectId}))) return false;
    return true;
  }
  async metadata(policy,kind,filter,projectId=undefined,traversal=null) {
    return this.reuse(traversal,['metadata',contextPolicyIdentity(policy),kind,filter,projectId],()=>this.readMetadata(policy,kind,filter,projectId,traversal));
  }
  async readMetadata(policy,kind,filter,projectId,traversal) {
    const items=[]; let cursor=null; const cursors=new Set();
    for(let page=0;page<this.maxPages;page+=1) {
      if(!this.spend(traversal))return null;
      const result=await this.documents.list(policy.ownerId,kind,{limit:100,cursor,filter,projectId,fields:CONTEXT_ITEM_FIELDS});
      if(!this.spend(traversal,result.items.length))return null;
      items.push(...result.items); cursor=result.nextCursor;
      if(!cursor) return items;
      if(cursors.has(cursor)) return null;
      cursors.add(cursor);
    }
    return null;
  }
  async canonical(policy,kind,id,recordType=null,traversal=null) {
    const rows=await this.metadata(policy,kind,kind==='fact'?{}:recordType?{recordType}:{},kind==='fact'?policy.controlProjectId:undefined,traversal);
    return rows?.find(row=>row.id===id) ?? null;
  }
  async versions(policy,kind,row,traversal=null) {
    return this.reuse(traversal,['versions',contextPolicyIdentity(policy),kind,row],async()=>{
      const versions=await this.readVersions(policy,kind,row,traversal);
      if(versions)this.recheck(traversal,['versions',kind,row.id],async()=>canonicalJson(await this.readVersions(policy,kind,row,null))===canonicalJson(versions));
      return versions;
    });
  }
  async readVersions(policy,kind,row,traversal) {
    const versions=[row]; let before=null;
    for(let page=0;page<this.maxPages;page+=1) {
      if(!this.spend(traversal))return null;
      const saved=await this.documents.history(policy.ownerId,kind,row.id,{limit:100,beforeRevision:before,fields:CONTEXT_ITEM_FIELDS});
      if(!this.spend(traversal,saved.length))return null;
      for(const revision of saved) {
        if(!Number.isSafeInteger(revision.revision) || before!==null && revision.revision>=before) return null;
        if(revision.revision!==row.revision) versions.push({...row,...revision});
      }
      if(saved.length<100) return versions;
      const next=saved.at(-1).revision;
      if(before!==null && next>=before) return null;
      before=next;
    }
    return null;
  }
  async capsuleActive(policy,activation) {
    const active=await this.documents.get(policy.ownerId,'preferences','active-capsules:account');
    if(!(active?.payload?.items??[]).slice(0,8).some(item=>item.capsuleId===activation.capsuleId)) return false;
    const capsule=await this.documents.get(policy.ownerId,'capsule',activation.capsuleId);
    return Boolean(capsule) && !capsule.payload.takenDown;
  }
  async capsule(policy,activation,entry) {
    if(policy?.kind==='owned') return true;
    if(!await this.currentPolicy(policy) || !activation || activation.capsuleId!==entry?.payload?.capsuleId || !await this.capsuleActive(policy,activation)) return false;
    if(!await this.authorize(policy,'fact',entry,new Set())) return false;
    return this.capsuleActive(policy,activation);
  }
  async handbook(policy,document) { return policy?.kind==='owned' || this.authorize(policy,'method',document,new Set(),'handbook'); }
  async method(policy,document) { return policy?.kind==='owned' || this.authorize(policy,'method',document,new Set(),'learned'); }
  async authorize(policy,kind,document,seen,role=null,traversal={memo:new Map(),snapshots:new Map(),remaining:this.maxWork}) {
    if(!document?.id||seen.has(`${kind}:${document.id}`)||seen.size>=this.maxDepth||!this.spend(traversal))return false;
    const key=canonicalJson([kind,document.id,document.revision,document.payload?.contentDigest,role]);
    if(traversal.memo.has(key)) {
      if(!traversal.memo.get(key))return false;
      const current=await this.canonical(policy,kind,document.id,document.payload?.recordType,traversal);
      if(current?.revision!==document.revision||current?.payload.contentDigest!==document.payload.contentDigest||!await this.currentPolicy(policy))return false;
      if(typeof document.payload?.body==='string'&&methodContentDigest(document.payload,sha256)!==document.payload.contentDigest)return false;
      if(kind==='fact'&&typeof document.payload?.content==='string'&&contextFactContentDigest(document.payload)!==document.payload.contentDigest)return false;
      return seen.size===0?this.finish(policy,traversal):true;
    }
    const allowed=await this.authorizeFresh(policy,kind,document,seen,role,traversal);
    traversal.memo.set(key,allowed);
    if(allowed&&seen.size===0)return this.finish(policy,traversal);
    return allowed;
  }
  async verifyVersion(policy,kind,version,lineageDigest,traversal,role=null,headRevision=version.revision,compoundApplicationRef=null,frozen=false) {
    return this.reuse(traversal,['verified-version',contextPolicyIdentity(policy),kind,version,lineageDigest,role,headRevision,compoundApplicationRef,frozen],
      ()=>this.verifyVersionFresh(policy,kind,version,lineageDigest,traversal,role,headRevision,compoundApplicationRef,frozen));
  }
  async verifyVersionFresh(policy,kind,version,lineageDigest,traversal,role,headRevision,compoundApplicationRef,frozen) {
    if(role?.kind==='compound-current')compoundApplicationRef=role.referenceId;
    const p=version.payload, provenance=p.provenance, source=p.source;
      if(!digest(p.contentDigest)) return false;
      if(kind==='fact' && p.projectId!==policy.controlProjectId) return false;
      const projectIds=[...(kind==='fact'?[p.projectId]:[]),source?.projectId,provenance?.sourceProjectId,...(Array.isArray(provenance?.sourceProjectIds)?provenance.sourceProjectIds:[]),...(Array.isArray(provenance?.evidence)?provenance.evidence.flatMap(entry=>[entry.projectId,entry.sourceProjectId]):[])].filter(value=>value!=null);
      if(!projectIds.length || projectIds.some(value=>value!==policy.controlProjectId)) return false;
      const runIds=new Set([source?.runId,provenance?.runId,...(Array.isArray(provenance?.sourceRunIds)?provenance.sourceRunIds:[]),...(Array.isArray(provenance?.evidence)?provenance.evidence.map(entry=>entry.runId):[])].filter(Boolean));
      if(Array.isArray(provenance)) for(const ref of provenance) {
        if(ref.type!=='run' || !ref.id || ref.projectId!==policy.controlProjectId) return false;
        runIds.add(ref.id);
      }
      if(!runIds.size) return false;
      let producerParents=[];
      for(const runId of runIds) {
        if(!this.spend(traversal))return false;
        const run=await this.sourceRun(policy,runId,traversal);
        if(!run || run.id!==runId || run.userId!==policy.ownerId || run.projectId!==policy.controlProjectId || run.automated===true || run.trigger==='automated') return false;
        const receipt=await this.verifyAcceptedContext({policy,run,document:version,kind,lineageDigest,traversal,compoundApplicationRef,frozen,compoundCurrent:role?.kind==='compound-current',handbookHistoryRef:role?.kind==='handbook-history'?role.referenceId:null});
        const identity=contextPolicyIdentity(policy);
        if(!receipt || Object.entries(identity).some(([field,value])=>receipt[field]!==value)
          || receipt.documentId!==version.id || receipt.documentRevision!==version.revision || receipt.runId!==runId
          || receipt.contentDigest!==p.contentDigest || receipt.lineageDigest!==lineageDigest || receipt.complete!==true
          || !Array.isArray(receipt.inputReceiptRefs) || !receipt.inputReceiptRefs.length || receipt.inputReceiptRefs.some(ref=>typeof ref!=='string'||!ref)
          || typeof receipt.launchedContextRef!=='string' || !receipt.launchedContextRef || !digest(receipt.launchedContextDigest)) return false;
        if(role?.kind==='compound-current'&&!receipt.compoundCurrentVerified)return false;
        if(role?.parent&&version.revision===headRevision&&receipt.producerProofRef!==role.parent.proofRef)return false;
        producerParents=receipt.producerParents??[];
      }
    return {producerParents};
  }
  async authorizeFresh(policy,kind,document,seen,role,traversal) {
    if(!await this.currentPolicy(policy) || !this.verifyAcceptedContext || !this.resolveSourceRun || !document?.id || seen.size>=this.maxDepth) return false;
    const key=`${kind}:${document.id}`;
    if(seen.has(key)) return false;
    const next=new Set([...seen,key]);
    const current=await this.canonical(policy,kind,document.id,document.payload?.recordType,traversal);
    if(!current || current.deletedAt || current.revision!==document.revision || current.payload.contentDigest!==document.payload.contentDigest) return false;
    if(role==='learned' && (current.payload.recordType!=='learned-method' || current.payload.status!=='approved')) return false;
    if(role==='handbook' && (current.payload.recordType!=='capability-handbook' || current.payload.status!=='active')) return false;
    if(role==='candidate' && current.payload.recordType!=='handbook-candidate') return false;
    if(role?.kind==='merged-ancestor' && (current.payload.recordType!=='learned-method'||!['approved','retired'].includes(current.payload.status)))return false;
    if(kind==='fact' && (current.projectId!==policy.controlProjectId || current.payload.projectId!==policy.controlProjectId)) return false;
    const mergedAncestor=role?.kind==='merged-ancestor'&&current.payload.status==='retired'
      &&this.verifyMergedAncestor&&await this.verifyMergedAncestor({policy,document:current,target:role.target});
    if(kind==='fact' && current.payload.status!=='approved' || kind==='method' && !['approved','active','candidate'].includes(current.payload.status)&&!mergedAncestor) return false;
    const versions=await this.versions(policy,kind,current,traversal);
    if(!versions) return false;
    const lineageDigest=hash(versions.map(row=>({id:row.id,revision:row.revision,payload:row.payload,deletedAt:row.deletedAt??null})));
    for(const version of versions) {
      const p=version.payload,provenance=p.provenance,source=p.source;
      const verified=await this.verifyVersion(policy,kind,version,lineageDigest,traversal,role,document.revision);
      if(!verified)return false;
      if(role?.kind==='compound-current')continue;
      const {producerParents}=verified;
      let historicalCandidate=false;
      // Every body actually supplied to generation contributes, whether or not
      // the model declared a reuse dependency. Self-prior versions are already
      // checked by this history walk; only external parents recurse.
      for(const parent of producerParents) {
        if(parent.id===current.id)continue;
        if(parent.kind!=='method'||!parent.id||!Number.isSafeInteger(parent.revision)||!digest(parent.contentDigest)||!parent.proofRef)return false;
        const metadata=await this.canonical(policy,'method',parent.id,null,traversal);
        if(!metadata||!this.spend(traversal))return false;
        // An exact historical handbook edge can differ in generation even
        // when its bytes recur. Only its complete certificate grants that edge.
        const certified=metadata.payload.contentDigest!==parent.contentDigest
          ||source?.candidateId===parent.id&&source?.candidateGeneration!==metadata.payload.provenance?.candidateGeneration
          ?await this.verifyAcceptedContext({policy,document:version,kind,lineageDigest,consumedParent:parent,traversal}):null;
        if(certified?.historical||metadata.payload.contentDigest!==parent.contentDigest) {
          if(!certified?.historical)return false;
          if(certified.candidateId===source?.candidateId&&certified.candidateDigest===source?.candidateDigest)historicalCandidate=true;
          continue;
        }
        if(metadata.revision<parent.revision)return false;
        const candidate=await this.documents.get(policy.ownerId,'method',parent.id,{expectedRevision:metadata.revision});
        if(!candidate)return false;
        const merged=(provenance?.mergedFrom??[]).some(ancestor=>ancestor.methodId===parent.id&&ancestor.digest===parent.contentDigest);
        const parentRole=merged&&candidate.payload.status==='retired'?{kind:'merged-ancestor',target:version,parent}:{kind:'consumed-parent',parent};
        if(!await this.authorize(policy,'method',candidate,next,parentRole,traversal))return false;
      }
      if(source?.candidateId&&!historicalCandidate) {
        const candidate=await this.canonical(policy,'method',source.candidateId,null,traversal);
        if(!candidate || candidate.payload.contentDigest!==source.candidateDigest || !await this.authorize(policy,'method',candidate,next,'candidate',traversal)) return false;
      }
      for(const ancestor of provenance?.mergedFrom ?? []) {
        if(producerParents.some(parent=>parent.id===ancestor.methodId&&parent.contentDigest===ancestor.digest))continue;
        const candidate=await this.canonical(policy,'method',ancestor.methodId,null,traversal);
        if(!candidate || candidate.payload.contentDigest!==ancestor.digest || !await this.authorize(policy,'method',candidate,next,{kind:'merged-ancestor',target:version},traversal)) return false;
      }
      for(const dependency of p.dependencies ?? []) {
        if(!dependency?.name || !digest(dependency.digest) || dependency.projectId!=null && dependency.projectId!==policy.controlProjectId) return false;
        const rows=await this.metadata(policy,'method',{frontmatter:{name:dependency.name},contentDigest:dependency.digest},undefined,traversal);
        if(!rows || rows.length!==1 || !await this.authorize(policy,'method',rows[0],next,'learned',traversal)) return false;
      }
    }
    if(typeof document.payload?.body === 'string' && methodContentDigest(document.payload,sha256)!==document.payload.contentDigest) return false;
    if(kind==='fact' && typeof document.payload?.content === 'string' && contextFactContentDigest(document.payload)!==document.payload.contentDigest) return false;
    const after=await this.canonical(policy,kind,current.id,current.payload.recordType,traversal);
    if(after?.revision!==current.revision || after?.payload.contentDigest!==current.payload.contentDigest) return false;
    const snapshot={kind,id:current.id,revision:current.revision,projectId:current.projectId??null,
      payload:JSON.parse(canonicalJson(Object.fromEntries(Object.keys(CONTEXT_ITEM_FIELDS).map(field=>[field,current.payload[field]??null]))))};
    const previous=traversal.snapshots.get(key);
    if(previous&&canonicalJson(previous)!==canonicalJson(snapshot))return false;
    traversal.snapshots.set(key,snapshot);
    return this.currentPolicy(policy);
  }
}
