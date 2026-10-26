import { createHash } from 'node:crypto'
import { ProductDocuments } from './productStore.mjs'
import { migrateProductStore } from './productPersistence.mjs'
import { HttpError } from './security.mjs'
import { rsiDigest, verifyRsiCampaignBundle } from './rsiCampaignBundle.mjs'
import { RSI_CAMPAIGN_SURFACES, rsiCompatibilityIssues } from '../../../packages/domain/src/rsiCampaign.mjs'
import { rsiActivationReceipt, rsiCampaignSelection, rsiCampaignFuse } from './rsiCampaignActivation.mjs'

/** @param {string} code */
function conflict(code) { throw new HttpError(409,code,'Campaign activation refused.') }
/** @param {string} id */
const key = id => `rsi-import:${createHash('sha256').update(id).digest('hex')}`

/** Deployment callbacks are authority, never manifest-supplied attestations.
 * publish/inspect/rollback must be idempotent under operationId and return installed identity.
 * All publishers of these surfaces MUST use pg_advisory_xact_lock(hashtext(`rsi-activation:${owner}`)).
 * currentTarget must read the authoritative generation through the supplied transaction client.
 * select is admission for new executions only: existing immutable run records are never rewritten.
 * A trusted runPin may retain an admitted revision only while this generation is compatible.
 * verificationOptions must authenticate issuer/evaluator and supply expectedIdentity, qualification and trustStore.
 */
export class RsiCampaignImporter {
  /** @param {{database:any,owner:string,verificationOptions:(envelope:any)=>Promise<any>,currentTarget:(surface:string,client:any)=>Promise<any>,adapters:any,activationPolicy:(manifest:any)=>Promise<any>,isBound?:()=>boolean,validateAdmission?:(row:any)=>Promise<boolean>,verifyObservation?:(proof:any,row:any,options?:{transactionClient:any})=>Promise<any>,now?:()=>string}} options */
  constructor({database,owner,verificationOptions,currentTarget,adapters,activationPolicy,isBound=()=>false,validateAdmission=async()=>false,verifyObservation=async()=>null,now=()=>new Date().toISOString()}) {
    this.database=database;this.documents=new ProductDocuments(database);this.owner=owner;this.verificationOptions=verificationOptions;this.currentTarget=currentTarget;this.adapters=adapters;this.activationPolicy=activationPolicy;this.isBound=isBound;this.validateAdmission=validateAdmission;this.verifyObservation=verifyObservation;this.now=now
  }
  /** Every publisher sharing this surface must take this fence; journals survive process loss. @param {(client:any)=>Promise<any>} operation */
  async transaction(operation) {
    await migrateProductStore(this.database)
    return this.database.transaction(async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`rsi-activation:${this.owner}`]);return operation(client)})
  }
  /** @param {any} client @param {string} id */
  async read(client,id) {
    const result=await client.query("SELECT payload,revision,deleted_at FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND id=$2 FOR UPDATE",[this.owner,key(id)])
    if(result.rows[0]?.deleted_at) conflict('campaign_journal_deleted')
    return result.rows[0]??null
  }
  /** @param {any} client @param {any} payload @param {number} revision */
  async write(client,payload,revision) {await this.documents.put(this.owner,'knowledge',key(payload.id),payload,{expectedRevision:revision,transactionClient:client});return payload}
  /** Live deployment trust is required at each new-effect boundary, including after awaits.
   * @param {any} row */
  async admitted(row) { try { return await this.validateAdmission(row) === true; } catch { return false; } }
  /** Verify before migration, journal writes, or adapter calls. Same ID/same bytes is a read; different bytes conflicts.
   * @param {any} envelope */
  async importBundle(envelope) {
    if(!this.isBound()) return {state:'waiting',reason:'campaign_binding_unavailable'}
    let options
    try { options=await this.verificationOptions(envelope) } catch { return {state:'rejected',issues:['campaign_trust_unavailable']} }
    const verified=await verifyRsiCampaignBundle(envelope,{...options,now:this.now()})
    if(!verified.ok) return {state:'rejected',issues:verified.issues}
    const m=verified.manifest, envelopeDigest=rsiDigest(envelope)
    let policy
    try { policy=await this.activationPolicy(m) } catch { return {state:'rejected',issues:['campaign_trust_unavailable']} }
    const defaultMode=RSI_CAMPAIGN_SURFACES[/** @type {keyof typeof RSI_CAMPAIGN_SURFACES} */(m.surface)].activation
    if(!policy || !['shadow','cohort','global'].includes(policy.mode) || defaultMode==='shadow' && policy.mode==='cohort' || policy.mode==='global' && policy.allowGlobal!==true || policy.mode==='cohort' && !(policy.cohortPercent>0 && policy.cohortPercent<=100)) return {state:'rejected',issues:['campaign_activation_policy_unqualified']}
    const steps=policy.cohortSteps
    if(steps!==undefined && (!Array.isArray(steps) || steps.length<1 || steps.length>10 || steps[0]!==policy.cohortPercent || steps.some((value,index)=>!Number.isFinite(value) || value<=0 || value>100 || index>0 && value<=steps[index-1])))return {state:'rejected',issues:['campaign_activation_policy_unqualified']}
    if(policy.afterShadow!==undefined && (policy.mode!=='shadow' || policy.afterShadow!=='global'))return {state:'rejected',issues:['campaign_activation_policy_unqualified']}
    const staged=await this.transaction(async client=>{
      const existing=await this.read(client,m.id)
      if(existing){if(existing.payload.envelopeDigest!==envelopeDigest)conflict('campaign_bundle_identity_conflict');return !await this.admitted(existing.payload) && !['stopped','rolled-back'].includes(existing.payload.state)?this.stop(client,existing,'campaign_trust_revoked'):existing.payload}
      const current=await this.currentTarget(m.surface,client)
      if(rsiCompatibilityIssues(m.target,current).length) conflict('campaign_target_changed')
      const siblings=await client.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND payload->>'recordType'='rsi-campaign-import' AND deleted_at IS NULL",[this.owner])
      if(siblings.rows.some(({payload})=>payload.campaignId===m.campaignId || payload.surface===m.surface && !['stopped','rolled-back','rejected'].includes(payload.state))) conflict('campaign_replay_or_surface_busy')
      const admissionRow={surface:m.surface,evidenceReferences:{procedureDigest:m.verdict.procedureDigest,consumerDigest:m.verdict.consumerDigest},authenticatedAdmissionIdentity:options.authenticatedAdmissionIdentity??null}
      if(!await this.admitted(admissionRow))return {state:'rejected',issues:['campaign_trust_revoked']}
      return this.write(client,{authenticatedAdmissionIdentity:options.authenticatedAdmissionIdentity??null,recordType:'rsi-campaign-import',id:m.id,campaignId:m.campaignId,envelopeDigest,bundleDigest:verified.bundleDigest,candidateDigest:m.verdict.candidateDigest,qualificationDigest:m.verdict.qualificationDigest,evidenceReferences:Object.fromEntries(['registrationDigest','datasetDigest','measurementDigest','consumerDigest','evaluatorDigest','procedureDigest','corpusDigest'].map(name=>[name,m.verdict[name]])),surface:m.surface,kind:m.kind,target:m.target,expiresAt:m.expiresAt,previousRevision:m.target.baselineRevision,operationId:`rsi-${rsiDigest([this.owner,m.id,verified.bundleDigest])}`,phase:policy.mode==='shadow'?'stage':'activate',mode:policy.mode,cohortPercent:policy.cohortPercent??0,policy:{minExecutions:policy.minExecutions??null,minDays:policy.minDays??null,maxErrors:policy.maxErrors??null,allowExpansion:policy.allowExpansion===true,afterShadow:policy.afterShadow??null,cohortSteps:steps??null},stageIndex:0,stageHistory:[],state:'staged',observations:{candidateExecutions:0,controlExecutions:0,errors:0,days:[],witnessIds:[]},stagedAt:this.now()},0)
    })
    if(staged.state==='stopped')return this.rollback(staged.id)
    if(staged.state!=='staged')return staged
    return this.resume(m.id,verified.files)
  }
  /** Stop is committed before any external compensation. @param {any} client @param {any} stored @param {string} reason @param {string|undefined} [revision] */
  async stop(client,stored,reason,revision=stored.payload.revision) {
    return this.write(client,{...stored.payload,...(revision?{revision}:{}),state:'stopped',stopReason:reason,stoppedAt:this.now(),rollbackOperationId:`${stored.payload.operationId}-rollback`},stored.revision)
  }
  /** Own active generation may be the live baseline; any third generation is stale. @param {any} row @param {any} current */
  compatible(row,current) {
    return rsiCompatibilityIssues({...row.target,baselineRevision:row.phase==='activate' && current?.baselineRevision===row.revision?row.revision:row.previousRevision},current).length===0
  }
  /** @param {any} row */
  expired(row) {return !(Date.parse(row.expiresAt)>Date.parse(this.now()))}
  /** A restart inspects the same operation before publishing. Files are reloaded only through a verified import.
   * @param {string} id @param {any} [files] */
  async resume(id,files) {
    return this.transaction(async client=>{
      const stored=await this.read(client,id);if(!stored)conflict('campaign_journal_missing')
      const row=stored.payload
      if(row.state!=='staged')return !['stopped','rolled-back'].includes(row.state) && !await this.admitted(row)?this.stop(client,stored,'campaign_trust_revoked'):row
      const adapter=this.adapters[row.kind];if(!adapter?.inspect || !adapter?.publish)return {...row,reason:'campaign_adapter_unavailable'}
      const installed=await adapter.inspect({operationId:row.operationId,surface:row.surface,phase:row.phase,transactionClient:client})
      const current=await this.currentTarget(row.surface,client)
      const expected={...row.target,baselineRevision:row.phase==='activate' && rsiActivationReceipt(installed,row)?installed.revision:row.target.baselineRevision}
      // Inspect first: expiry disallows new effects, but cannot hide an already activated effect.
      const trusted=await this.admitted(row)
      if(!trusted || !this.isBound() || this.expired(row) || rsiCompatibilityIssues(expected,current).length) {
        return this.stop(client,stored,!trusted?'campaign_trust_revoked':!this.isBound()?'campaign_binding_unavailable':this.expired(row)?'campaign_bundle_expired':'campaign_target_changed',rsiActivationReceipt(installed,row)?installed.revision:undefined)
      }
      let proof=installed
      if(!rsiActivationReceipt(proof,row)) {
        if(installed?.installed)conflict('campaign_installed_identity_conflict')
        const staging={...row,phase:'stage'}
        let staged=await adapter.inspect({operationId:row.operationId,surface:row.surface,phase:'stage',transactionClient:client})
        if(!rsiActivationReceipt(staged,staging)) {
          if(staged?.installed)conflict('campaign_installed_identity_conflict')
          if(!files)return {...row,reason:'campaign_verified_bytes_required'}
          if(rsiDigest(files)!==row.candidateDigest)conflict('campaign_candidate_digest_changed')
          if(!await this.admitted(row))return this.stop(client,stored,'campaign_trust_revoked')
          await adapter.publish({operationId:row.operationId,surface:row.surface,files,phase:'stage',mode:row.mode,expectedTarget:row.target,transactionClient:client})
          staged=await adapter.inspect({operationId:row.operationId,surface:row.surface,phase:'stage',transactionClient:client})
          if(!rsiActivationReceipt(staged,staging))conflict('campaign_stage_unwitnessed')
        }
        if(row.phase==='activate') {
          if(!await this.admitted(row))return this.stop(client,stored,'campaign_trust_revoked',staged.revision)
          if(rsiCompatibilityIssues(row.target,await this.currentTarget(row.surface,client)).length)conflict('campaign_target_changed')
          await adapter.publish({operationId:row.operationId,surface:row.surface,phase:'activate',revision:staged.revision,mode:row.mode,expectedTarget:row.target,transactionClient:client})
          proof=await adapter.inspect({operationId:row.operationId,surface:row.surface,phase:'activate',transactionClient:client})
        }else proof=staged
      }
      if(!rsiActivationReceipt(proof,row))conflict('campaign_publication_unwitnessed')
      if(!await this.admitted(row))return this.stop(client,stored,'campaign_trust_revoked',proof.revision)
      return this.write(client,{...row,state:'exposed',revision:proof.revision,publishedAt:this.now()},stored.revision)
    }).then(async row=>row.state==='stopped'?this.rollback(id):row)
  }
  /** Proof verifier returns bounded execution identities from the actual consumer, never raw user data.
   * @param {string} id @param {any} proof */
  async observe(id,proof) {
    return this.transaction(async client=>{
      const stored=await this.read(client,id);if(!stored)conflict('campaign_journal_missing')
      const row=stored.payload;if(!['exposed','consumer-observed','broadly-active'].includes(row.state))return row
      const current=await this.currentTarget(row.surface,client)
      if(!await this.admitted(row))return this.stop(client,stored,'campaign_trust_revoked')
      if(!this.isBound())return this.stop(client,stored,'campaign_binding_unavailable')
      if(this.expired(row) || !this.compatible(row,current))return this.stop(client,stored,'campaign_target_changed')
      const witness=await this.verifyObservation(proof,row,{transactionClient:client})
      if(!witness || witness.operationId!==row.operationId || witness.candidateDigest!==row.candidateDigest || !['candidate','control','shadow'].includes(witness.arm) || witness.revision!==(witness.arm==='control'?row.previousRevision:row.revision) || typeof witness.id!=='string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(witness.id) || !/^\d{4}-\d{2}-\d{2}$/.test(witness.day) || !['ok','error','critical'].includes(witness.outcome))conflict('campaign_consumer_witness_invalid')
      if(witness.outcome!=='critical' && witness.arm!=='control' && (row.mode==='shadow'?witness.arm!=='shadow':witness.arm!=='candidate'))conflict('campaign_consumer_witness_invalid')
      if(witness.outcome==='critical' ? !Number.isSafeInteger(witness.stageIndex??0) || (witness.stageIndex??0)<0 || (witness.stageIndex??0)>(row.stageIndex??0) : (witness.stageIndex??0)!==(row.stageIndex??0))conflict('campaign_consumer_witness_stage_changed')
      if(witness.consumerDigest!==undefined && witness.consumerDigest!==row.evidenceReferences.consumerDigest)conflict('campaign_consumer_witness_invalid')
      if(witness.outcome==='critical' && !['corrupt-bytes','unauthorized-behavior','incompatible-generation','deterministic-regression'].includes(witness.criticalCode))conflict('campaign_consumer_witness_invalid')
      const o=structuredClone(row.observations)
      if(o.witnessIds.includes(witness.id))return row
      if(o.witnessIds.length>=10000 && witness.outcome!=='critical')conflict('campaign_observation_capacity')
      // Evidence bounds never disable the deterministic emergency fuse.
      if(o.witnessIds.length<10000)o.witnessIds.push(witness.id)
      const candidate=witness.arm!=='control'
      if(candidate){o.candidateExecutions++;o.errors+=witness.outcome==='ok'?0:1;if(!o.days.includes(witness.day))o.days.push(witness.day)}else o.controlExecutions++
      if(candidate && witness.outcome==='critical')o.criticalCode=witness.criticalCode
      const fuse=rsiCampaignFuse(o,row.policy)
      let next={...row,observations:o,fuse,state:candidate?'consumer-observed':row.state}
      if(fuse.state==='stop') {
        // Stop selection durably before attempting the external rollback; a failure remains stopped.
        next={...next,state:'stopped',stoppedAt:this.now(),rollbackOperationId:`${row.operationId}-rollback`}
      }else if(candidate && fuse.state==='sufficient' && row.policy.allowExpansion) {
        // These are registered exposure thresholds, not evidence of a statistical benefit.
        const target=await this.currentTarget(row.surface,client)
        if(!await this.admitted(row))return this.stop(client,stored,'campaign_trust_revoked')
        if(!this.isBound() || this.expired(row) || !this.compatible(row,target))return this.stop(client,stored,'campaign_target_changed')
        const history=[...(row.stageHistory??[]),{stageIndex:row.stageIndex??0,mode:row.mode,cohortPercent:row.cohortPercent,candidateExecutions:o.candidateExecutions,controlExecutions:o.controlExecutions,errors:o.errors,days:o.days,completedAt:this.now()}]
        const fresh={candidateExecutions:0,controlExecutions:0,errors:0,days:[],witnessIds:o.witnessIds}
        if(row.mode==='shadow' && row.policy.afterShadow==='global') {
          // Commit activation intent before the external effect; resume reuses operation identity.
          next={...next,mode:'global',phase:'activate',state:'staged',stageIndex:(row.stageIndex??0)+1,stageHistory:history,observations:fresh,activationRequestedAt:this.now()}
        }else if(row.mode==='cohort' && Array.isArray(row.policy.cohortSteps)) {
          const index=row.policy.cohortSteps.indexOf(row.cohortPercent),percent=row.policy.cohortSteps[index+1]
          if(index>=0 && percent!==undefined)next={...next,cohortPercent:percent,state:'exposed',stageIndex:(row.stageIndex??0)+1,stageHistory:history,observations:fresh}
          else if(row.cohortPercent===100)next={...next,state:'broadly-active'}
        }else if(row.mode==='global')next={...next,state:'broadly-active'}
      }
      return this.write(client,next,stored.revision)
    }).then(async row=>row.state==='stopped'?this.rollback(id):row.state==='staged' && row.phase==='activate'?this.resume(id):row)
  }
  /** Exact prior compatible generation only; customer outputs and history are untouched. @param {string} id */
  async rollback(id) {
    return this.transaction(async client=>{
      const stored=await this.read(client,id);if(!stored)conflict('campaign_journal_missing')
      const row=stored.payload;if(row.state!=='stopped')return row
      const current=await this.currentTarget(row.surface,client)
      if(!row.revision)return {...row,reason:'campaign_no_external_generation'}
      if(current.dependencyDigest!==row.target.dependencyDigest || ![row.revision,row.previousRevision].includes(current.baselineRevision))return {...row,reason:'campaign_rollback_incompatible'}
      const adapter=this.adapters[row.kind]
      if(!adapter?.rollback)return {...row,reason:'campaign_rollback_unavailable'}
      const receipt=await adapter.rollback({operationId:row.rollbackOperationId,surface:row.surface,revision:row.previousRevision,expectedRevision:row.revision,dependencyDigest:row.target.dependencyDigest,transactionClient:client})
      if(receipt?.operationId!==row.rollbackOperationId || receipt.revision!==row.previousRevision || receipt.dependencyDigest!==row.target.dependencyDigest || receipt.installed!==true)conflict('campaign_rollback_unwitnessed')
      return this.write(client,{...row,state:'rolled-back',rolledBackAt:this.now()},stored.revision)
    })
  }
  /** Registry supplies both revisions and selection; consumer reports chosen revision including controls.
   * @param {string} surface @param {any} context */
  async select(surface,context={}) {
    const result=await this.transaction(async client=>{
      const current=await this.currentTarget(surface,client)
      const records=await client.query("SELECT payload,revision FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND payload->>'recordType'='rsi-campaign-import' AND payload->>'surface'=$2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[this.owner,surface])
      const stored=records.rows[0],row=stored?.payload
      if(!row)return {selection:{revision:current.baselineRevision,arm:'control'}}
      const trusted=await this.admitted(row)
      if(!trusted || !this.isBound() || this.expired(row) || !this.compatible(row,current)) {
        const stopped=['stopped','rolled-back'].includes(row.state)?row:await this.stop(client,stored,!trusted?'campaign_trust_revoked':!this.isBound()?'campaign_binding_unavailable':this.expired(row)?'campaign_bundle_expired':'campaign_target_changed')
        return {stopped,selection:{revision:current.baselineRevision===row.revision?null:current.baselineRevision,arm:'control',reason:stopped.stopReason??'campaign_generation_stopped'}}
      }
      if(['stopped','rolled-back'].includes(row.state))return {selection:{revision:current.baselineRevision===row.revision?null:current.baselineRevision,arm:'control'}}
      return {selection:rsiCampaignSelection(row,context)}
    })
    if(result.stopped?.state==='stopped') {
      await this.rollback(result.stopped.id)
      // Re-read after compensation; never return a historical baseline over a newer incumbent.
      return this.transaction(async client=>{
        const current=await this.currentTarget(surface,client)
        return {revision:current.baselineRevision===result.stopped.revision?null:current.baselineRevision,arm:'control',reason:result.selection.reason}
      })
    }
    return result.selection
  }
  /** Cheap absence check preserves the native policy path when no bundle was ever admitted.
   * This ignores configuration intentionally: an existing revoked journal must still reconcile.
   * @param {string} surface */
  async hasCampaign(surface) {
    const result=await this.database.query("SELECT 1 FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND payload->>'recordType'='rsi-campaign-import' AND payload->>'surface'=$2 AND deleted_at IS NULL LIMIT 1",[this.owner,surface])
    return result.rows.length > 0
  }
}
