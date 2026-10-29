/** Exact old-handbook replacement inputs and their immutable application proof.
 * This helper never admits a historical body as an ordinary context root. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {methodContentDigest,usagePurposeOfRun} from '@evimed/domain';
import {CONTEXT_ITEM_FIELDS,contextPolicyIdentity,sameContextPolicy} from './geoContextItems.mjs';
import {canonicalJson} from './geoStore.mjs';
import {HttpError} from './security.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=()=>new HttpError(409,'geo_handbook_baseline_unverified','The exact handbook replacement input is unavailable.');
const lineage=rows=>sha(canonicalJson(rows.map(row=>({id:row.id,revision:row.revision,payload:row.payload,deletedAt:row.deletedAt??null}))));
export class GeoHandbookApplications {
  constructor(provenance){this.p=provenance;this.active=new AsyncLocalStorage();}
  metadata(row){return {...row,payload:JSON.parse(canonicalJson(Object.fromEntries(Object.keys(CONTEXT_ITEM_FIELDS).map(key=>[key,row.payload[key]??null]))))};}
  pin(userId,row){return {kind:row.kind??'method',id:row.id,revision:row.revision,contentDigest:row.payload.contentDigest,proofRef:this.p.proofId(userId,row.kind??'method',row.id,row.payload)};}
  pending(userId,referenceId){const scope=this.active.getStore();return scope?.userId===userId&&scope.proofId===referenceId?scope.proof:null;}
  async receipt(policy,referenceId,traversal=null){
    const scope=this.active.getStore();
    if(scope?.referenceId===referenceId&&sameContextPolicy(scope.policy,policy))return scope.receipt;
    const row=await this.p.ledger(policy.ownerId,referenceId,traversal),saved=row?.payload;
    return saved?.recordType==='geo-context-handbook-application'&&saved.complete===true&&row.projectId===policy.controlProjectId
      &&referenceId===`gha_${this.p.digest(saved)}`&&Object.entries(contextPolicyIdentity(policy)).every(([key,value])=>saved[key]===value)?saved:null;
  }
  async applicationProof(policy,document,proof,traversal){
    if(!proof.handbookApplicationRef)return true;
    const saved=await this.receipt(policy,proof.handbookApplicationRef,traversal);
    return saved?.output?.id===document.id&&saved.output.proofRef===this.p.proofId(policy.ownerId,'method',document.id,document.payload);
  }
  async selfPrior(policy,document,proof,parent,traversal){
    const saved=proof.handbookApplicationRef?await this.receipt(policy,proof.handbookApplicationRef,traversal):null;
    if(saved?.output?.proofRef!==this.p.proofId(policy.ownerId,'method',document.id,document.payload))return null;
    return saved.baselineVersions.find(row=>row.id===parent.id&&row.revision===parent.revision&&this.p.proofId(policy.ownerId,'method',row.id,row.payload)===parent.proofRef)??null;
  }
  async historyVersions(policy,referenceId,document,traversal){
    const saved=await this.receipt(policy,referenceId,traversal);
    const rows=document.id===saved?.baseline?.id?saved.baselineVersions:document.id===saved?.candidate?.id?saved.candidateVersions:null;
    return rows?.some(row=>row.revision===document.revision&&canonicalJson(row.payload)===canonicalJson(document.payload))?rows:null;
  }
  async capabilities(userId,id,versions,capabilityId,traversal){
    const key=['handbook-capabilities',userId,id];
    const found=await this.p.contextItems.reuse(traversal,key,async()=>{
      const values=await this.readCapabilities(userId,id,traversal);
      this.p.contextItems.recheck(traversal,key,async()=>{
        try{return canonicalJson(await this.readCapabilities(userId,id,null))===canonicalJson(values);}
        catch(error){if(error?.code==='geo_handbook_baseline_unverified')return false;throw error;}
      });
      return values;
    });
    if(versions.some(row=>found.find(([revision])=>revision===row.revision)?.[1]!==capabilityId))throw fail();
  }
  async readCapabilities(userId,id,traversal){
    const current=(await this.p.rows(userId,'method',{}, {capabilityId:true})).find(row=>row.id===id);
    if(!current)throw fail();
    const found=new Map([[current.revision,current.payload.capabilityId]]);let before=null;
    for(let page=0;page<this.p.maxPages;page++){
      const rows=await this.p.documents.history(userId,'method',id,{limit:100,beforeRevision:before,fields:{capabilityId:true}});
      if(!this.p.contextItems.spend(traversal,rows.length+1))throw fail();
      for(const row of rows)found.set(row.revision,row.payload.capabilityId);
      if(rows.length<100)break;
      const next=rows.at(-1).revision;if(next===before||page===this.p.maxPages-1)throw fail();before=next;
    }
    return [...found];
  }
  async bodies(userId,head,versions,traversal){
    const key=['handbook-bodies',userId,head.id,head.revision];
    const rows=await this.p.contextItems.reuse(traversal,key,async()=>{
      const values=await this.readBodies(userId,head,traversal);
      this.p.contextItems.recheck(traversal,key,async()=>{
        const current=await this.p.documents.get(userId,'method',head.id,{expectedRevision:head.revision});
        return Boolean(current)&&canonicalJson(current.payload)===canonicalJson(head.payload)
          &&canonicalJson(await this.readBodies(userId,head,null))===canonicalJson(values);
      });
      return values;
    });
    const found=new Map(rows);
    for(const version of versions){
      const body=found.get(version.revision);
      if(!body||this.p.proofId(userId,'method',body.id,body.payload)!==this.p.proofId(userId,'method',version.id,version.payload)
        ||body.payload.capabilityId!==head.payload.capabilityId||methodContentDigest(body.payload,sha)!==version.payload.contentDigest)throw fail();
    }
  }
  async readBodies(userId,head,traversal){
    const found=new Map([[head.revision,head]]);let before=null;
    for(let page=0;page<this.p.maxPages;page++){
      if(!this.p.contextItems.spend(traversal))throw fail();
      const rows=await this.p.documents.history(userId,'method',head.id,{limit:100,beforeRevision:before,fields:null});
      if(!this.p.contextItems.spend(traversal,rows.length))throw fail();
      for(const row of rows)found.set(row.revision,{...head,...row});
      if(rows.length<100)break;
      const next=rows.at(-1).revision;if(next===before||page===this.p.maxPages-1)throw fail();before=next;
    }
    return [...found];
  }
  async validRun(policy,id,capabilityId,traversal=null){
    const run=id?await this.p.contextItems.sourceRun(policy,id,traversal):null;
    return run?.id===id&&run.effectiveAgentId===capabilityId&&usagePurposeOfRun(run)==='kernel';
  }
  async capture(policy,candidate,baselineMetadata){
    const p=this.p,userId=policy.ownerId,traversal={memo:new Map(),snapshots:new Map(),remaining:p.contextItems.maxWork};
    if(candidate?.payload.recordType!=='handbook-candidate'||candidate.payload.status!=='candidate'||!candidate.payload.capabilityId
      ||!await this.validRun(policy,candidate.payload.provenance?.runId,candidate.payload.capabilityId,traversal)
      ||!await p.contextItems.authorize(policy,'method',candidate,new Set(),null,traversal))throw fail();
    const candidateVersions=await p.contextItems.versions(policy,'method',this.metadata(candidate),traversal);if(!candidateVersions)throw fail();
    const baselineVersions=baselineMetadata?await p.contextItems.versions(policy,'method',baselineMetadata,traversal):[];if(!baselineVersions)throw fail();
    for(const version of candidateVersions)if(!await this.validRun(policy,version.payload.provenance?.runId,candidate.payload.capabilityId,traversal))throw fail();
    const extraParents=new Map();
    for(const version of baselineVersions){
      if(version.payload.recordType!=='capability-handbook'||version.payload.source?.candidateId!==candidate.id||version.payload.contentDigest!==version.payload.source.candidateDigest||!await this.validRun(policy,version.payload.source?.runId,candidate.payload.capabilityId,traversal)
        ||!await p.contextItems.verifyVersion(policy,'method',version,lineage(baselineVersions),traversal))throw fail();
      const proof=await p.proofFor(userId,'method',version,traversal);
      const source=proof.parents.find(pin=>pin.id===candidate.id&&pin.contentDigest===version.payload.source.candidateDigest);
      const original=source&&candidateVersions.find(row=>row.revision===source.revision&&row.payload.contentDigest===source.contentDigest
        &&p.proofId(userId,'method',row.id,row.payload)===source.proofRef);
      if(!original||original.payload.recordType!=='handbook-candidate'
        ||version.payload.source.candidateProofRef&&version.payload.source.candidateProofRef!==source.proofRef
        ||version.payload.source.candidateGeneration&&version.payload.source.candidateGeneration!==original.payload.provenance?.candidateGeneration||!await p.contextItems.verifyVersion(policy,'method',original,lineage(candidateVersions),traversal)
        ||source.proofRef!==p.proofId(userId,'method',candidate.id,candidate.payload)&&!await p.descendsFromProof(policy,candidate,source.proofRef,traversal))throw fail();
      for(const parent of proof.parents){
        if(parent.id===candidate.id||parent.id===version.id)continue;
        const row=await p.methodFor(userId,parent.id,policy);
        if(!row||row.payload.status!=='approved'||p.proofId(userId,'method',row.id,row.payload)!==parent.proofRef
          ||!await p.contextItems.authorize(policy,'method',row,new Set(),'learned',traversal))throw fail();
        extraParents.set(parent.id,this.pin(userId,row));
      }
    }
    await this.capabilities(userId,candidate.id,candidateVersions,candidate.payload.capabilityId,traversal);
    if(baselineMetadata)await this.capabilities(userId,baselineMetadata.id,baselineVersions,candidate.payload.capabilityId,traversal);
    // Only after complete metadata/source admission may old body bytes enter
    // the replacement input. History hydration never uses get(oldRevision).
    let baseline=null;
    if(baselineMetadata){
      if(baselineMetadata.payload.status!=='active')throw fail();
      baseline=await p.documents.get(userId,'method',baselineMetadata.id,{expectedRevision:baselineMetadata.revision});
      if(!baseline||this.p.proofId(userId,'method',baseline.id,baseline.payload)!==this.p.proofId(userId,'method',baselineMetadata.id,baselineMetadata.payload)
        ||methodContentDigest(baseline.payload,sha)!==baseline.payload.contentDigest)throw fail();
      await this.bodies(userId,baseline,baselineVersions,traversal);
      traversal.snapshots.set(`method:${baseline.id}`,this.snapshot(baseline));
    }
    await this.bodies(userId,candidate,candidateVersions,traversal);
    if(!await p.contextItems.finish(policy,traversal))throw fail();
    return {baseline,baselineVersions,candidateVersions,candidate:this.pin(userId,candidate),extraParents:[...extraParents.values()],
      heads:[...traversal.snapshots.values()].map(row=>this.pin(userId,row))};
  }
  snapshot(row){return {kind:row.kind??'method',id:row.id,revision:row.revision,projectId:row.projectId??null,payload:this.metadata(row).payload};}
  async deleted(userId,id){
    let cursor=null;
    for(let page=0;page<this.p.maxPages;page++){
      const rows=await this.p.documents.list(userId,'method',{deleted:true,fields:{recordType:true},limit:100,cursor});
      if(rows.items.some(row=>row.id===id))return true;
      if(!rows.nextCursor)return false;
      if(rows.nextCursor===cursor)throw fail();cursor=rows.nextCursor;
    }
    throw fail();
  }
  async admit(policy,candidate,baselineMetadata){return this.capture(policy,candidate,baselineMetadata);}
  async allowsPrior(policy,prior,traversal={memo:new Map(),snapshots:new Map(),remaining:this.p.contextItems.maxWork}){
    const scope=this.active.getStore();
    if(!scope||!sameContextPolicy(scope.policy,policy)||scope.receipt.baseline?.id!==prior.id||scope.receipt.baseline.revision!==prior.revision
      ||scope.receipt.baseline.proofRef!==this.p.proofId(policy.ownerId,'method',prior.id,prior.payload))return false;
    const current=await this.currentCandidate(policy,scope.receipt.candidate,traversal,scope.receipt.capabilityId,scope.receipt.candidateGeneration);
    if(!await this.verifyCertificate(policy,scope.receipt,current,traversal))throw fail();
    if(typeof prior.payload.body==='string'&&methodContentDigest(prior.payload,sha)!==prior.payload.contentDigest)throw fail();
    traversal.snapshots.set(`method:${prior.id}`,this.snapshot(prior));return true;
  }
  async currentCandidate(policy,pin,traversal,capabilityId,generation){
    const metadata=await this.p.contextItems.canonical(policy,'method',pin.id,'handbook-candidate',traversal);
    if(!metadata||this.p.proofId(policy.ownerId,'method',metadata.id,metadata.payload)!==pin.proofRef
      ||!await this.p.contextItems.authorize(policy,'method',metadata,new Set(),null,traversal))return null;
    const attributes=(await this.p.rows(policy.ownerId,'method',{recordType:'handbook-candidate'},{capabilityId:true,candidateRevision:true})).find(row=>row.id===pin.id);
    if(!attributes||attributes.revision!==metadata.revision||attributes.payload.capabilityId!==capabilityId||attributes.payload.candidateRevision!==generation)return null;
    return this.p.documents.get(policy.ownerId,'method',pin.id,{expectedRevision:metadata.revision});
  }
  async verifyCertificate(policy,saved,currentCandidate,traversal){
    const p=this.p;
    if(!currentCandidate||!await this.validRun(policy,currentCandidate.payload.provenance?.runId,saved.capabilityId,traversal)||currentCandidate.payload.candidateRevision!==saved.candidateGeneration||currentCandidate.payload.capabilityId!==saved.capabilityId
      ||p.proofId(policy.ownerId,'method',currentCandidate.id,currentCandidate.payload)!==saved.candidate.proofRef
      ||!await p.contextItems.authorize(policy,'method',currentCandidate,new Set(),null,traversal))return false;
    const currentVersions=await p.contextItems.versions(policy,'method',this.metadata(currentCandidate),traversal);
    if(!currentVersions)return false;
    try{
      await this.capabilities(policy.ownerId,currentCandidate.id,currentVersions,saved.capabilityId,traversal);
      await this.bodies(policy.ownerId,currentCandidate,currentVersions,traversal);
    }catch(error){if(error?.code==='geo_handbook_baseline_unverified')return false;throw error;}
    for(const parent of saved.extraParents){
      const row=await p.methodFor(policy.ownerId,parent.id,policy);
      if(!row||p.proofId(policy.ownerId,'method',row.id,row.payload)!==parent.proofRef
        ||!await p.contextItems.authorize(policy,'method',row,new Set(),'learned',traversal))return false;
    }
    if(!p.contextItems.spend(traversal,saved.heads.length)||saved.heads.length>512)return false;
    for(const pin of saved.heads){
      if(pin.id===saved.baseline?.id)continue;
      const head=await p.contextItems.canonical(policy,pin.kind,pin.id,null,traversal);
      if(!head||head.revision<pin.revision||p.proofId(policy.ownerId,pin.kind,head.id,head.payload)!==pin.proofRef)return false;
    }
    return true;
  }
  async certifyParent({policy,document,consumedParent,traversal}){
    if(document.payload.recordType!=='capability-handbook'||document.payload.source?.candidateId!==consumedParent.id)return null;
    const p=this.p,head=await p.contextItems.canonical(policy,'method',document.id,'capability-handbook',traversal);
    if(!head||document.payload.source?.candidateId!==consumedParent.id||document.payload.source.candidateDigest!==consumedParent.contentDigest)return null;
    const proof=await p.proofFor(policy.ownerId,'method',head,traversal),ref=proof?.handbookApplicationRef,saved=ref?await this.receipt(policy,ref,traversal):null;
    if(!saved||saved.output?.proofRef!==p.proofId(policy.ownerId,'method',head.id,head.payload)
      ||!saved.baselineVersions.some(row=>row.revision===document.revision&&canonicalJson(row.payload)===canonicalJson(document.payload))
      ||!saved.candidateVersions.some(row=>row.revision===consumedParent.revision&&p.proofId(policy.ownerId,'method',row.id,row.payload)===consumedParent.proofRef))return null;
    const key=canonicalJson(['handbook-history',contextPolicyIdentity(policy),ref,head.revision,saved.output.proofRef]);
    if(!traversal.memo.has(key)){
      traversal.memo.set(key,false);
      const current=await this.currentCandidate(policy,saved.candidate,traversal,saved.capabilityId,saved.candidateGeneration);
      if(!await this.verifyCertificate(policy,saved,current,traversal))return null;
      for(const rows of [saved.baselineVersions,saved.candidateVersions])for(const row of rows){
        if(!p.contextItems.spend(traversal)||!await this.validRun(policy,row.payload.source?.runId??row.payload.provenance?.runId,saved.capabilityId,traversal)
          ||!await p.contextItems.verifyVersion(policy,'method',row,lineage(rows),traversal,{kind:'handbook-history',referenceId:ref}))return null;
      }
      traversal.memo.set(key,true);
    }
    return traversal.memo.get(key)?{historical:true,candidateId:consumedParent.id,candidateDigest:consumedParent.contentDigest}:null;
  }
  register(userId,document,proof){
    const scope=this.active.getStore();if(!scope||scope.userId!==userId||document.id!==scope.handbookId)return false;
    scope.proof=proof;scope.proofId=this.p.proofId(userId,'method',document.id,document.payload);proof.handbookApplicationRef=scope.referenceId;
    scope.receipt.output={...this.pin(userId,document)};return true;
  }
  async apply(userId,client,{candidate,baselineMetadata,handbookId,jobId},publish){
    const p=this.p;
    return p.documents.database.withTransactionClient(client,async()=>{
      const policy=await p.policyFor({userId,id:candidate.payload.provenance.sourceProjectId});
      const captured=await this.capture(policy,candidate,baselineMetadata);
      const heads=captured.heads;
      if(heads.length)await client.query(`SELECT documents.id FROM evimed_product.documents
        JOIN jsonb_to_recordset($2::jsonb) AS wanted(kind text,id text) ON documents.kind=wanted.kind AND documents.id=wanted.id
        WHERE documents.user_id=$1 ORDER BY documents.kind,documents.id FOR UPDATE OF documents`,[userId,JSON.stringify(heads.map(({kind,id})=>({kind,id})))]);
      const locked=await this.capture(policy,candidate,baselineMetadata);
      if(canonicalJson(captured.heads)!==canonicalJson(locked.heads))throw fail();
      const receipt={recordType:'geo-context-handbook-application',version:1,...contextPolicyIdentity(policy),jobId,capabilityId:candidate.payload.capabilityId,
        candidate:captured.candidate,candidateGeneration:candidate.payload.candidateRevision,baseline:captured.baseline?this.pin(userId,captured.baseline):null,
        baselineVersions:captured.baselineVersions,candidateVersions:captured.candidateVersions,extraParents:captured.extraParents,heads:captured.heads,output:null,complete:true};
      const scope={userId,policy,receipt,handbookId,referenceId:'pending-handbook-application',proofId:null,proof:null};
      return this.active.run(scope,async()=>{
        await publish();
        const current=await p.documents.get(userId,'method',candidate.id);
        receipt.candidate=this.pin(userId,current);
        if(!scope.proof||!receipt.output)throw fail();
        scope.referenceId=`gha_${p.digest(receipt)}`;scope.proof.handbookApplicationRef=scope.referenceId;
        await p.documents.put(userId,'geo-plan-context',scope.proofId,scope.proof,{expectedRevision:0,projectId:policy.controlProjectId,transactionClient:client});
        await p.documents.put(userId,'geo-plan-context',scope.referenceId,receipt,{expectedRevision:0,projectId:policy.controlProjectId,transactionClient:client});
        const applied=await p.documents.get(userId,'method',handbookId);
        if(!await p.contextItems.handbook(policy,applied))throw fail();
      });
    });
  }
}
