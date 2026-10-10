import {policyPriority} from './evolutionPolicy.mjs';
import {evolutionOpportunitySource} from './evolutionGrowth.mjs';
import { createHash } from 'node:crypto';
import { canonicalJson, selectEvolutionCandidate, evolutionNoiseBand, evolutionProposalIssues, selectEvolutionParent } from '@evimed/domain';
import { evolutionKey, evolutionToolArchiveId } from './evolutionService.mjs';
import { evolutionPriorityBreakdown } from './evolutionScout.mjs';
import { EVOLUTION_MODULE_IDS } from './evolutionUsage.mjs';
import { validateModuleEvolutionPolicy } from './moduleEvolutionPolicies.mjs';
import { evolutionAccountFloors } from './evolutionAccountClasses.mjs';

export const EVOLUTION_OPPORTUNITY_SOURCES = Object.freeze(['demand', 'method', 'data', 'success', 'combination', 'contradiction', 'self-research', 'repair']);
/** `deferred`: parked on a resource that did not come within its window. Terminal, so the module goes on; the opportunity keeps its
 * wake conditions (`defer`) and comes back when one of them is met (`wake`). `failed`: the job a mission was opened for did not succeed
 * (`recordJob`). */
const TERMINAL = new Set(['complete', 'rejected', 'impossible', 'cancelled', 'deferred', 'failed']);
/** What a mission waits for, named in the mission's vocabulary, and the event that meets it. */
const WAKE_EVENT_TYPES = Object.freeze({ 'new-data': 'dataset-ready', 'new-tool': 'tool-ready', 'new-method': 'method-ready', 'new-model': 'environment-changed' });
const DEFERRED_WAKE_CONDITIONS = Object.freeze(['new-data', 'new-method', 'new-tool', 'new-model']);
const metBy = (/** @type {string[]|undefined} */ conditions, /** @type {any} */ event) => (conditions ?? []).some(type => type === event.type || WAKE_EVENT_TYPES[type] === event.type);
/** The states of an engine proposal's opportunity that new evidence does not reopen: the proposal waits for an operator's answer (`review`), or the operator
 * adopted it and it is work to implement (`adopted`). A declined one is closed, and reopens like any other when what it rests on changes. */
const ENGINE_REVIEW_KEPT = new Set(['review', 'adopted']);
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const localDay = date => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
export const evolutionReplayHeldOut = id => parseInt(digest(`heldout:${id}`).slice(0,8),16)%5===0;
/** The dossier's measured score (`evolutionPriority` of its ranking features: papers, failures, waiting agendas, reference code,
 * reachable data, examples, coverage, dependencies) is the base; until 2026-10-10 it was 0 here, so every opportunity of a
 * module ranked alike and ties broke on the id string (review D-E1). */
export const evolutionPriorityFeatures = (row) => {
  const p=row.payload ?? row,f=p.features ?? {};
  return {id:row.id,baseScore:Number.isFinite(Number(p.score))?Number(p.score):0,accountCount:Number(f.distinctAccounts??0),unlockedFamilies:Number(f.unlockedFamilies??Number(f.coverageGap===true)),otherModules:Number(f.otherModules??0),progressPoints:Number(f.progressPoints??f.developmentGain??0),totalResearch:Number(f.totalResearch??1),objectResearch:Number(f.objectResearch??0),estimatedCostCny:Number(f.estimatedCostCny??0)};
};
const sameFamily=(left,right)=>digest(left??null)===digest(right??null);
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/** Only a trusted execution receipt can establish a repair's observed baseline failure. @param {any} payload */
export function evolutionFailureReproductionHash(payload){
  return digest(Object.fromEntries(Object.entries(payload).filter(([key])=>!['recordType','receiptHash'].includes(key))));
}
/** @param {any} payload @param {any} identity */
export function validEvolutionFailureReproduction(payload,identity){
  return payload?.recordType==='evolution-failure-reproduction'&&payload.missionId===identity.missionId&&payload.moduleId===identity.moduleId&&payload.baselineHash===digest(identity.baseline??{})&&['public','generated'].includes(payload.scope)&&payload.independent===true&&payload.executed===true&&payload.baselineFailed===true&&payload.referenceVerified===true&&typeof payload.taskId==='string'&&typeof payload.sourceRoot==='string'&&/^[a-f0-9]{64}$/.test(payload.sourceHash??'')&&/^[a-f0-9]{64}$/.test(payload.executionReceiptHash??'')&&payload.receiptHash===evolutionFailureReproductionHash(payload);
}
/** Exact frozen unit identities, source versions and equivalent variants must all be measured once. @param {any[]} batch @param {any} measurement */
export function validateEvolutionMeasurements(batch,measurement){
  const expected=new Map(batch.flatMap(item=>[{id:item.id,sourceHash:item.sourceHash,groupId:item.id},...(item.equivalentVariant?[{id:`${item.id}:equivalent`,sourceHash:item.sourceHash,groupId:item.id}]:[])].map(unit=>[unit.id,unit])));
  const issues=[],seen=new Set();
  if(!Array.isArray(measurement.units))return['units-missing'];
  for(const unit of measurement.units){
    const reference=expected.get(unit.id);
    if(!reference||seen.has(unit.id))issues.push('unexpected-or-duplicate-unit');
    else if(unit.sourceHash!==reference.sourceHash||(unit.groupId??unit.id)!==reference.groupId)issues.push('source-or-group-mismatch');
    if(!Number.isFinite(unit.score)||unit.score<0||unit.score>1)issues.push('score-outside-full-scale');
    seen.add(unit.id);
  }
  if([...expected.keys()].some(id=>!seen.has(id)))issues.push('frozen-batch-incomplete');
  return[...new Set(issues)];
}
/** Stateful coordinator on the existing document/job ledger. Domain-specific evaluators remain in their modules.
 * @param {{service:any,policy:any,map:any,taskPool:any,signals:any,config:any,adapters?:Record<string,any>,screen?:(input:any)=>Promise<any>,cost?:(id:string)=>Promise<number>,epoch?:()=>Promise<any>}} input */
export function createEvolutionMissions({ service, policy, map, taskPool, signals, config, adapters = {}, screen, cost = async () => 0, epoch = async () => ({ id: 'unknown', modelReleasedAt: null }) }) {
  const adapterRegistry = { ...adapters };
  const update = async (row, patch) => service.save('mission', row.id, { ...row.payload,
    ...(Number.isFinite(row.payload.regressions)||row.payload.publication?.status==='published'||row.payload.confirmedPromotions>0?{}:{regressions:0,regressionBasis:'no-activated-candidate-or-observed-regression',regressionObservations:row.payload.regressionObservations??[]}),
    ...patch,...(patch.completed===true&&!patch.completedAt&&!row.payload.completedAt?{completedAt:service.now().toISOString()}:{}),updatedAt: service.now().toISOString() }, row);
  function register(next) { Object.assign(adapterRegistry, next); }

  async function opportunity(input) {
    if (!EVOLUTION_MODULE_IDS.includes(input.moduleId) || !Array.isArray(input.sources) || !input.sources.length || input.sources.some(source => !EVOLUTION_OPPORTUNITY_SOURCES.includes(source))) throw new Error('Invalid evolution opportunity.');
    const id = input.id ?? `evolution-dossier-${evolutionKey([input.moduleId, input.taskFamily, input.mechanismFamily, input.evidenceRoots])}`;
    return service.withLock(`opportunity:${id}`, async () => {
      const previous = await service.get(id), P = (await policy.current()).policy;
      const features = input.features ?? {};
      const breakdown = evolutionPriorityBreakdown(features, P.weights);
      const signature = digest([input.evidenceRoots ?? [], input.prerequisites ?? [], features]);
      if (previous?.payload.resourceSignature === signature) return previous;
      // A new signature reopens a dossier, and ends a deferral (`defer`); a review input waiting for a person, or work a person adopted, is not made void by new evidence.
      return service.save('dossier', id, { ...previous?.payload, ...input, resourceSignature: signature, opportunity: true,
        priorityBreakdown: breakdown, score: Object.values(breakdown).reduce((sum, x) => sum + x, 0),
        ...(previous?.payload.deferred ? { deferred: false, deferredAt: null, wakeConditions: [] } : {}),
        createdAt: previous?.payload.createdAt ?? service.now().toISOString(), status: ENGINE_REVIEW_KEPT.has(previous?.payload.status) ? previous.payload.status : input.prerequisites?.length ? 'waiting_resource' : 'planned',
        cheapestNextStep: input.cheapestNextStep ?? 'measure-current-version', failureHypotheses: input.failureHypotheses ?? [],
        evidenceRoots: [...new Set(input.evidenceRoots ?? [])] }, previous);
    });
  }

  const tranches = row => row.payload.budget?.tranches ?? [{day:row.payload.budget?.day,reservedCny:row.payload.budget?.reservedCny??0,spentBefore:0}];
  const dailyCharge = (row,day) => tranches(row).filter(t=>t.day===day).reduce((sum,t)=>sum+(TERMINAL.has(row.payload.status)?Math.min(t.reservedCny,Math.max(0,Number(row.payload.researchCostCny??0)-t.spentBefore)):t.reservedCny),0);
  async function fund(row) {
    if(!row?.payload.budget||TERMINAL.has(row.payload.status))return row;
    return service.withLock('mission-allocation',async()=>{
      row=await service.get(row.id);
      const day=localDay(service.now()),spent=await cost(row.id);
      if(tranches(row).some(t=>t.day===day))return row;
      const all=await service.list('mission'),P=row.payload.policySnapshot??(await policy.current()).policy,category=row.payload.budget.category;
      const committed=all.reduce((sum,item)=>sum+dailyCharge(item,day),0);
      const categoryCommitted=all.filter(item=>item.payload.budget?.category===category).reduce((sum,item)=>sum+dailyCharge(item,day),0);
      const amount=Math.min(config.evolutionRunBudgetCny,Math.max(0,config.evolutionDailyBudgetCny-committed),Math.max(0,config.evolutionDailyBudgetCny*P.budgetShares[category]-categoryCommitted));
      if(amount<=0)return update(row,{status:'waiting_budget',reason:'daily-funding-unavailable',researchCostCny:spent});
      return update(row,{budget:{...row.payload.budget,day,reservedCny:spent+amount,fundedCny:Number(row.payload.budget.fundedCny??row.payload.budget.reservedCny)+amount,tranches:[...tranches(row).map(t=>({...t,releasedCny:t.releasedCny??Math.max(0,Number(row.payload.budget.reservedCny)-spent)})),{day,reservedCny:amount,spentBefore:spent,fundedAt:service.now().toISOString()}]},researchCostCny:spent,status:row.payload.status==='waiting_budget'?'ready':row.payload.status});
    });
  }
  async function create(input) {
    const id = input.id ?? `evolution-mission-${evolutionKey([input.opportunityId, input.moduleId, input.cycle ?? localDay(service.now()), input.kind ?? 'research'])}`;
    return service.withLock('mission-allocation', async () => {
      const previous = await service.get(id);
      if (previous) return previous;
      if (!EVOLUTION_MODULE_IDS.includes(input.moduleId)) throw new Error('Unknown evolution mission module.');
      const P = await policy.assignedPolicy(id), environment = await epoch();
      const day = localDay(service.now()), all = await service.list('mission');
      const today = all.filter(row => tranches(row).some(t=>t.day===day));
      const reserved = today.reduce((sum, row) => sum + dailyCharge(row,day), 0);
      const category = Object.hasOwn(P.policy.budgetShares, input.category) ? input.category : 'research';
      const share = config.evolutionDailyBudgetCny * P.policy.budgetShares[category];
      const categoryReserved = today.filter(row => row.payload.budget.category === category).reduce((sum, row) => sum + dailyCharge(row,day), 0);
      const remaining = Math.max(0, config.evolutionDailyBudgetCny - reserved);
      // Unused shares can be borrowed by the ready queue head, never carried to another day.
      const nominal = Math.max(0, share - categoryReserved);
      const amount = Math.min(input.budgetCny ?? config.evolutionRunBudgetCny, config.evolutionRunBudgetCny, remaining,
        input.borrowUnused === true ? remaining : nominal);
      if (amount <= 0) return { id: null, payload: { status: 'waiting_budget', moduleId: input.moduleId } };
      return service.save('mission', id, { ...input, moduleId: input.moduleId, status: input.wakeConditions?.length ? 'waiting_resource' : 'ready',
        budget: { category, day, reservedCny: amount, tranches:[{day,reservedCny:amount,spentBefore:0,fundedAt:service.now().toISOString()}] }, policyId: P.id, policyVersion: P.policy.version, policySnapshot:structuredClone(P.policy), replayIndependent:evolutionReplayHeldOut(id), usedForProposal:false,
        mechanismSchedule:P.policy.mechanismSchedule??[3,2,1],stagnationRounds:P.policy.stagnationRounds??3,resourceStop:P.policy.resourceStop??{attempts:3,days:14},epoch: environment.id, modelReleasedAt: environment.modelReleasedAt, month: service.now().toISOString().slice(0, 7),
        regressions:0,regressionBasis:'no-activated-candidate-or-observed-regression',regressionObservations:[],round: 1, maxRounds: 10, consecutiveStalls: 0, baseline: input.baseline ?? null, successConditions: input.successConditions ?? { selectionVersion: 'evolution-selection-2' },
        dependencies: input.dependencies ?? [], wakeConditions: input.wakeConditions ?? [], results: [], decisions: [...(input.decisions ?? []),...['budgetShares','mechanismSchedule','stagnationRounds','resourceStop'].map(field=>({id:`${id}:${field}`,policyField:field,choice:JSON.stringify(P.policy[field]),at:service.now().toISOString()}))], components: [],
        createdAt: service.now().toISOString() });
    });
  }

  async function queue(row) {
    if (!row?.id || TERMINAL.has(row.payload.status) || config.evolutionSearchPaused) return null;
    return service.enqueue(['tools','runtime'].includes(row.payload.moduleId) ? 'mission-heavy' : 'mission', { missionId: row.id, moduleId: row.payload.moduleId }, `mission:${row.id}:${row.revision}`);
  }
  /** Whether a mission parked on a resource has had its window: the policy's attempts and days, which can only tighten the bounds the
   * plan sets (`resourceStop`, three attempts and fourteen days). @param {any} payload */
  const resourceWindowPassed = payload => {
    const bounds = payload.resourceStop ?? { attempts: 3, days: 14 };
    return Number(payload.resourceAttempts ?? 0) >= Math.min(3, bounds.attempts)
      || service.now().getTime() - Date.parse(payload.resourceWindowStartedAt ?? payload.createdAt) > Math.min(14, bounds.days) * 86400000;
  };
  /** The research plan's stop rule (6.3): what cannot be had is written down with what it waits for, and the module goes on to something
   * else. The mission ends `deferred`, which frees its module; the opportunity keeps the wake conditions and is not offered again until
   * one is met (`wake`) or what it rests on changes (`opportunity`). @param {any} row */
  async function defer(row) {
    const wakeConditions = row.payload.wakeConditions?.length ? row.payload.wakeConditions : [...DEFERRED_WAKE_CONDITIONS];
    const deferredAt = service.now().toISOString();
    const deferred = await update(row, { status: 'deferred', deferredAt, wakeConditions });
    const dossier = row.payload.opportunityId ? await service.get(row.payload.opportunityId) : null;
    if (dossier?.payload.opportunity === true) await service.save('dossier', dossier.id, { ...dossier.payload, deferred: true, deferredAt, deferredMissionId: row.id, wakeConditions }, dossier);
    return deferred;
  }
  async function deferExpired() {
    for (const listed of await service.list('mission', null, { status: 'waiting_resource' })) {
      if (listed.payload.status !== 'waiting_resource' || !(listed.payload.resourceStopped === true || resourceWindowPassed(listed.payload))) continue;
      // Read again: the list is a moment old and the mission may have moved since.
      const row = await service.get(listed.id);
      if (row?.payload.status === 'waiting_resource') await defer(row);
    }
  }
  async function plan({ week }) {
    if (config.evolutionSearchPaused) return { paused: true };
    for (const signal of await signals.aggregate()) {
      const p = signal.payload;
      await opportunity({ moduleId: p.moduleId, sources: [evolutionOpportunitySource(p.kind)],
        taskFamily: p.codes, mechanismFamily: p.kind, evidenceRoots: [signal.id], features: { distinctAccounts: p.distinctAccounts, runtimeFailures: p.occurrences,
          ...(p.accountClass === 'operator' ? { accountClass: 'operator', demandFloor: (signals.floors ?? evolutionAccountFloors(config)).operator } : {}),
          coverageGap: p.kind === 'unmet-demand' }, cheapestNextStep: 'reproduce-on-public-analogue', failureHypotheses: ['private-demand-may-not-transfer'] });
    }
    const capabilityMap = await map.rebuild();
    const enabled = Object.entries(adapterRegistry).filter(([,adapter]) => adapter.enabled).map(([id]) => id);
    await deferExpired();
    const all = await service.list('mission');
    const thisWeek = all.filter(row => row.payload.week === week);
    const current = (await policy.current()).policy;
    // Published, impossible and answered-by-a-review-input (`run`) opportunities are done, whether the operator has answered the input or not
    // (`adopted` is work to implement, `declined` is closed until what it rests on changes); a deferred one waits for its wake conditions.
    const dossiers = (await service.dossiers())
      .filter(row => row.payload.opportunity === true && !['published', 'impossible', 'review', 'adopted', 'declined'].includes(row.payload.status) && !row.payload.deferred);
    const created = [];
    const busy = new Set(all.filter(row => !TERMINAL.has(row.payload.status)).map(row => `${row.payload.moduleId}:${row.payload.opportunityId}`));
    // Modules missing their weekly allocation go first; measured priority orders opportunities inside a module.
    enabled.sort((a,b) => Number(thisWeek.some(row => row.payload.moduleId === a)) - Number(thisWeek.some(row => row.payload.moduleId === b)));
    for (const moduleId of enabled) {
      const othersReady = enabled.some(id => id !== moduleId && dossiers.some(row => row.payload.moduleId === id && row.payload.status === 'planned'));
      const spent = thisWeek.filter(row => row.payload.moduleId === moduleId && row.payload.budget.category === 'research').reduce((sum,row) => sum + Number(row.payload.researchCostCny ?? row.payload.budget.reservedCny),0);
      if (othersReady && spent >= config.evolutionDailyBudgetCny * 7 * current.budgetShares.research * current.moduleMaximumShare) continue;
      // The mission id below is the module's and the week's: a module that has had its mission this week waits for the next.
      if (thisWeek.some(row => row.payload.moduleId === moduleId)) continue;
      const missionId=`evolution-mission-${evolutionKey(['weekly',moduleId,week])}`;
      const assigned=await policy.assignedPolicy(missionId);
      const own=dossiers.filter(row=>row.payload.moduleId===moduleId);
      // An opportunity whose mission is still open (running, or parked on a resource inside its window) is not offered again and does not hold the
      // module: it takes the next-ranked one (research plan 6.3, 「转去做别的」). A module whose every opportunity is open waits; with none it audits its baseline.
      const open=own.filter(row=>!busy.has(`${moduleId}:${row.id}`));
      if(own.length&&!open.length)continue;
      const choices=open.map(evolutionPriorityFeatures);
      const ranked=choices.sort((a,b)=>policyPriority(b,assigned.policy)-policyPriority(a,assigned.policy)||String(a.id).localeCompare(String(b.id)));
      const selected=open.find(row=>row.id===ranked[0]?.id);
      const pending = selected?.payload.prerequisites?.length > 0;
      const row = await create({ id:missionId, decisions:[{id:`${missionId}:priority`,policyField:'weights',opportunities:structuredClone(choices),choice:selected?.id ?? `baseline-${moduleId}`,at:service.now().toISOString()}], opportunityId: selected?.id ?? `baseline-${moduleId}`, moduleId, week,
        cycle: `${week}:${selected?.revision ?? 0}`, kind: pending ? 'acquire-resource' : selected ? 'research' : 'baseline-audit',
        category: pending ? 'exploration' : selected ? 'research' : 'maintenance', borrowUnused: true,
        taskFamily: selected?.payload.taskFamily ?? null, mechanismFamily:selected?.payload.mechanismFamily??null,sources: selected?.payload.sources ?? [],
        wakeConditions: pending ? [] : selected?.payload.wakeConditions ?? [], prerequisites: selected?.payload.prerequisites ?? [],
        cheapestNextStep: selected?.payload.cheapestNextStep, baseline: await service.get(`evolution-module-policy-${moduleId}`) });
      if (row.id) { created.push(row.id); await queue(row); }
    }
    return { week, missions: created, capabilityMap: capabilityMap.counts };
  }

  async function ensureJob(job) {
    if(['evolution-event','evolution-digest','evolution-plan'].includes(job.kind))return null;
    if (job.payload.missionId) return fund(await service.get(job.payload.missionId));
    const categories = { scout: 'exploration', build: 'research', evaluate: 'confirmation', audit:'confirmation', 'self-check': 'confirmation', decision: 'maintenance', maintain: 'maintenance', meta: 'meta', research: 'exploration', plan: 'maintenance' };
    const kind = job.kind.replace('evolution-', '');
    const dossier = job.payload.dossierId ? await service.get(job.payload.dossierId) : null;
    if (dossier?.payload.missionId) return fund(await service.get(dossier.payload.missionId));
    const row = await create({ id: `evolution-mission-${evolutionKey(job.id)}`, opportunityId: dossier?.id ?? null, moduleId: job.payload.moduleId ?? 'tools',
      kind, category: categories[kind] ?? 'maintenance', borrowUnused: true, jobId: job.id });
    if (row.id && dossier) await service.save('dossier', dossier.id, { ...dossier.payload, missionId: row.id }, dossier);
    return row;
  }

  async function recordJob(row, result) {
    if (!row?.id) return;
    const fresh = await service.get(row.id);
    const status = result?.status ?? result?.payload?.status;
    // A mission opened for a job (`ensureJob` names the job) ends with it, whatever the job's kind is called: the self-research job's kind is
    // `research`, which is also the kind of an opportunity's weekly mission, and that one concludes itself (`run`, `finalizeMission`). Review D-E9.
    const forJob = typeof fresh.payload.jobId === 'string';
    // `jobFailed` is the worker's word that the job will not be tried again; a `status: 'failed'` in a result is the job's own finding (a self-check
    // that measured a failure) and the job succeeded. The mission opened for the job fails with it; a research mission is never ended by it.
    if (result?.jobFailed === true) return update(fresh, { researchCostCny: await cost(row.id), lastResult: 'failed', ...(forJob ? { status: 'failed', reason: result.code ?? 'job-failed', failedAt: service.now().toISOString() } : {}) });
    return update(fresh, { researchCostCny: await cost(row.id), ...(Number.isFinite(fresh.payload.regressions)?{}:!fresh.payload.candidate&&!fresh.payload.verdictId&&!fresh.payload.publication?{regressions:0,regressionBasis:'no-activated-candidate-administrative-job',regressionObservations:[]}:{}), lastResult: status ?? 'completed',
      ...((!forJob && ['research','transfer','transfer-audit','combination','prune'].includes(fresh.payload.kind)) || ['waiting_resource','waiting_confirmation','waiting_budget','frozen','ready'].includes(status) ? {} : { completed: true, status: 'complete', completedAt: service.now().toISOString() }) });
  }

  async function publish(moduleId, candidate, result) {
    if (!validateModuleEvolutionPolicy(moduleId, candidate.policy)) return { status: 'review', reason: 'code-change-requires-release-pr' };
    return service.withLock(`module-policy-activation:${moduleId}`,async()=>{
      const verdict=await service.get(result.verdictId);
      if(verdict?.payload.promote!==true||verdict.payload.auditOnly===true||verdict.payload.confirmatory!==true||verdict.payload.receiptValid!==true||verdict.payload.firstAttempt!==true||verdict.payload.moduleId!==moduleId||verdict.payload.candidateId!==candidate.id||verdict.payload.candidateHash!==digest(candidate))throw new Error('Activation requires the immutable matching verdict.');
      const id=`evolution-module-policy-${moduleId}`,previous=await service.get(id);
      if(previous?.payload.candidateId===candidate.id&&previous.payload.verdictId===verdict.id)return{status:'published',revisionId:`${previous.id}:${previous.revision}`};
      const mission=await service.get(verdict.payload.missionId);
      const baselineRevision=mission?.payload.baseline?.revisionId;
      if(previous&&baselineRevision!==previous.payload.revisionId||!previous&&baselineRevision&&!baselineRevision.startsWith('default:')&&baselineRevision!=='code-default')return{status:'review',reason:'baseline-changed-reconfirmation-required'};
      const row=await service.save('module-policy',id,{policy:candidate.policy,candidateId:candidate.id,revisionId:candidate.id,verdictId:verdict.id,status:'active',previousRevision:previous?.revision??null,activatedAt:service.now().toISOString()},previous);
      return{status:'published',revisionId:`${row.id}:${row.revision}`};
    });
  }

  async function finalizeMission(mission,candidate,verdict,adapter){
    const p=verdict.payload,auditOnly=p.auditOnly===true;
    const selection={outcome:p.outcome,reason:p.reason,promote:p.promote,scope:p.scope??null};
    const publication=p.promote&&!auditOnly?await adapter.publish(candidate,{...p.measured,accepted:true,verdictId:verdict.id}):null;
    if(p.promote&&!auditOnly&&publication?.status!=='published')return update(await service.get(mission.id),{status:'waiting_resource',reason:publication?.reason??'publication-not-complete',verdictId:verdict.id,publication,researchCostCny:await cost(mission.id),confirmedPromotions:0});
    const stored=await service.get(candidate.id);
    if(stored.payload.verdictId!==verdict.id)await service.save('archive',stored.id,{...stored.payload,status:auditOnly?'audited':p.promote?'promoted':'stepping-stone',verdictId:verdict.id,effect:p.score-p.baseline,...(p.promote&&!auditOnly?{activatedAt:service.now().toISOString()}:{})},stored);
    if(stored.payload.parentId&&!auditOnly){
      await service.withLock(`archive-parent:${stored.payload.parentId}`,async()=>{
        const parent=await service.get(stored.payload.parentId);
        if(parent&&!parent.payload.evaluatedVerdictIds?.includes(verdict.id))await service.save('archive',parent.id,{...parent.payload,evaluatedDescendants:(parent.payload.evaluatedDescendants??0)+1,promotedDescendants:(parent.payload.promotedDescendants??0)+Number(p.promote),evaluatedVerdictIds:[...(parent.payload.evaluatedVerdictIds??[]),verdict.id]},parent);
      });
    }
    const newSupportedFamilies=await service.callbacks.recordConfirmedFamilies?.({mission,candidate,verdict}) ?? 0;
    const stalls=Number(mission.payload.consecutiveStalls??0)+Number(!p.promote);
    const continueSearch=!auditOnly&&!p.promote&&Number(mission.payload.round??1)<Math.min(10,mission.payload.maxRounds??10)&&stalls<Math.min(3,mission.payload.stagnationRounds??3);
    const row=await update(await service.get(mission.id),{status:continueSearch?'ready':auditOnly||p.promote?'complete':'rejected',completed:!continueSearch,completedAt:continueSearch?null:service.now().toISOString(),result:selection,verdictId:verdict.id,publication,researchCostCny:await cost(mission.id),components:p.confirmatory&&p.receiptValid&&!auditOnly ? [...(mission.payload.components??[]),{...(mission.payload.decisions?.[0]?.opportunities??[]).find(item=>item.id===mission.payload.opportunityId),id:candidate.id,opportunityId:mission.payload.opportunityId,candidateId:candidate.id,verdictId:verdict.id,confirmedGain:p.score-p.baseline,costCny:await cost(mission.id)}] : mission.payload.components??[],confirmedOnNewTasks:true,confirmedPromotions:Number(p.promote&&!auditOnly),newSupportedFamilies,regressions:Number(mission.payload.regressions??0)+Number(p.outcome==='regressed'&&!(mission.payload.regressionObservations??[]).some(item=>item.verdictId===verdict.id)),regressionBasis:'independent-confirmation-verdicts',regressionObservations:[...(mission.payload.regressionObservations??[]).filter(item=>item.verdictId!==verdict.id),{verdictId:verdict.id,outcome:p.outcome,regressed:p.outcome==='regressed',at:p.at}],consecutiveStalls:stalls,
      ...(continueSearch?{round:Number(mission.payload.round??1)+1,candidate:null,candidateHash:null,proposalAttempts:0,results:[...(mission.payload.results??[]),{verdictId:verdict.id,outcome:p.outcome,round:mission.payload.round??1}]}:{})});
    if(continueSearch)await queue(row);
    return row;
  }
  async function retryProposal(mission,candidate,reason,detail){
    const attempt=Number(mission.payload.proposalAttempts??0)+1;
    const id=`evolution-proposal-rejection-${evolutionKey([mission.id,attempt,digest(candidate??{})])}`;
    if(!await service.get(id))await service.save('proposal-rejection',id,{missionId:mission.id,candidateHash:digest(candidate??{}),attempt,reason,detail,at:service.now().toISOString()});
    const row=await update(await service.get(mission.id),{preparedCandidateState:null,smokeCaseIds:null,proposalAttempts:attempt,status:attempt>=5?'rejected':'ready',completed:attempt>=5,proposalFeedback:{reason,detail},result:attempt>=5?{outcome:'invalid-evidence',reason:'five-screen-repairs-exhausted'}:null});
    if(attempt<5)await queue(row);
    return row;
  }
  async function run({ missionId }, context = {}) {
    let mission = await service.get(missionId);
    if (!mission || TERMINAL.has(mission.payload.status)) return mission;
    if(config.evolutionSearchPaused)return update(mission,{status:'paused',resumeStatus:mission.payload.status});
    if(mission.payload.status==='paused')mission=await update(mission,{status:mission.payload.resumeStatus??'ready'});
    mission=await fund(mission);
    if(mission.payload.status==='waiting_budget')return mission;
    const adapter = adapterRegistry[mission.payload.moduleId];
    if (!adapter?.enabled) return update(mission, { status: 'waiting_resource', reason: 'module-disabled' });
    if (mission.payload.dependencies.length) {
      const dependencies = await Promise.all(mission.payload.dependencies.map(id => service.get(id)));
      if(dependencies.some(row=>row&&['rejected','impossible','cancelled'].includes(row.payload.status)))return update(mission,{status:'rejected',completed:true,reason:'mission-dependency-failed'});
      if (dependencies.some(row => row?.payload.status !== 'complete')) return update(mission, { status: 'waiting_resource', reason: 'mission-dependency' });
    }
    if (mission.payload.kind === 'acquire-resource') {
      if(resourceWindowPassed(mission.payload))return update(mission,{status:'waiting_resource',reason:'resource-attempt-window-exhausted',resourceStopped:true,wakeConditions:['new-data','new-method','new-tool','new-model']});
      mission=await update(mission,{resourceAttempts:Number(mission.payload.resourceAttempts??0)+1});
      const result = await service.callbacks.acquireResource?.(mission.payload, context);
      return update(mission, { status: result?.ready ? 'complete' : 'waiting_resource', resourceResult: result ?? { reason: 'resource-unavailable' },
        wakeConditions: result?.wakeConditions ?? ['new-data', 'new-method', 'new-tool'], completed: result?.ready === true, researchCostCny: await cost(mission.id) });
    }
    if(mission.payload.kind==='curriculum'){const result=await service.callbacks.runEvolutionCurriculum?.({...mission.payload,missionId},context);return update(mission,{status:result?.status??'waiting_resource',completed:result?.status==='complete',completedAt:result?.status==='complete'?service.now().toISOString():null,result,researchCostCny:await cost(missionId)});}
    if (mission.payload.kind === 'baseline-audit') {
      const prepared=await service.callbacks.prepareModuleTasks?.({...mission.payload,missionId,phase:'development'},context);
      if(prepared&&prepared.status!=='ready')return update(mission,{status:'waiting_resource',reason:prepared.reason??'baseline-task-preparation'});
      const tasks=(await service.list('task')).filter(row=>row.payload.moduleId===mission.payload.moduleId&&row.payload.pool==='development').slice(0,30).map(row=>({...row.payload,id:row.id}));
      const result = await adapter.evaluate({ missionId, pool: 'development', ...(tasks.length?{batch:tasks}:{}), userId: await service.owner(), projectId: mission.projectId, ...context });
      return update(mission, { status: result.status === 'measured' ? 'complete' : 'waiting_resource', baseline: result, completed: result.status === 'measured', researchCostCny: await cost(mission.id) });
    }
    if(mission.payload.moduleId==='tools'&&service.callbacks?.runToolMission){
      const result=await service.callbacks.runToolMission({...mission.payload,id:mission.id,missionId:mission.id},context);
      const status=result?.status??result?.payload?.status??'waiting_resource';
      const summary={status,digest:result?.digest??null,publicationId:result?.publication?.id??result?.toolId??null,evaluationReceiptHash:result?.evaluationReceiptHash??null};
      const results=[...(mission.payload.results??[])];
      if(!results.some(item=>digest(item)===digest(summary)))results.push(summary);
      if(result?.candidate?.id){const archiveId=evolutionToolArchiveId(result.candidate);if(!await service.get(archiveId))await service.save('archive',archiveId,{candidate:result.candidate,candidateHash:digest(result.candidate),moduleId:'tools',missionId:mission.id,status:status==='published'?'promoted':'stepping-stone',parentId:result.candidate.lineage?.parents?.[0]??null,evaluatedDescendants:0,promotedDescendants:0});}
      const toolVerdicts=(await service.list('candidate-verdict')).filter(row=>row.payload.moduleId==='tools'&&row.payload.candidateId===result?.candidate?.id&&row.payload.receiptValid===true&&row.payload.confirmatory===true);
      const observations=toolVerdicts.map(row=>({verdictId:row.id,outcome:row.payload.outcome,regressed:row.payload.outcome==='regressed',at:row.payload.at}));
      const previousObservations=(await service.get(mission.id)).payload.regressionObservations??[];
      const mergedObservations=[...previousObservations,...observations.filter(item=>!previousObservations.some(previous=>previous.verdictId===item.verdictId))];
      return update(await service.get(mission.id),{status:status==='published'?'complete':status==='impossible'?'impossible':status==='repair'?'ready':'waiting_resource',completed:['published','impossible'].includes(status),results,regressions:status==='published'&&!mergedObservations.length?null:mergedObservations.filter(item=>item.regressed).length,regressionBasis:mergedObservations.length?'independent-tool-confirmation-verdicts':status==='published'?'missing-tool-regression-verdict':'no-activated-candidate',regressionObservations:mergedObservations,lastResult:summary,researchCostCny:await cost(mission.id),...(status==='published'?{confirmedPromotions:1,confirmedOnNewTasks:true}:{} )});
    }
    if(['sources','evidence','memory','runtime'].includes(mission.payload.moduleId)&&service.callbacks.runModuleEngineMission){
      const result=await service.callbacks.runModuleEngineMission({...mission.payload,id:mission.id,missionId},context);
      const status=result?.status??'waiting_resource';
      if(status==='review'){
        // The review input is this mission's whole product: a reviewed release PR is a person's step (`open-evolution-pr.mjs`), and a mission that
        // waited for it never ended, so its module never worked on anything else (review D-E3). The opportunity is answered until what it rests on changes.
        const reviewId=result.review?.identity??null;
        const done=await update(await service.get(mission.id),{status:'complete',completed:true,result:{outcome:'review-prepared',reviewId},reason:'reviewed-release-pr-required',engineReview:result.review??null,lastResult:status,researchCostCny:await cost(missionId),confirmedPromotions:0});
        const dossier=mission.payload.opportunityId?await service.get(mission.payload.opportunityId):null;
        // A proposal an operator has already answered (this mission ran again after its end was lost) keeps its answer.
        if(dossier?.payload.opportunity===true&&!['adopted','declined'].includes(dossier.payload.status))await service.save('dossier',dossier.id,{...dossier.payload,status:'review',review:{missionId,reviewId,at:service.now().toISOString()}},dossier);
        // The operators are told of the proposal. The mission is over either way: a pass that fails here is made up by the worker's next
        // housekeeping, which announces every prepared proposal nobody has been told of.
        if(dossier?.payload.opportunity===true)await service.callbacks.engineReviewPrepared?.(dossier.id);
        return done;
      }
      return update(await service.get(mission.id),{status:status==='impossible'?'impossible':'waiting_resource',completed:status==='impossible',reason:result?.reason??'module-engine-resource',engineReview:result?.review??null,lastResult:status,researchCostCny:await cost(missionId),confirmedPromotions:0});
    }
    let candidate = mission.payload.candidate;
    if (!candidate) {
      let preparedState=mission.payload.preparedCandidateState;
      if(!preparedState){
      const verdictHistory=(await service.list('candidate-verdict')).filter(row=>row.payload.moduleId===mission.payload.moduleId&&sameFamily(row.payload.taskFamily,mission.payload.taskFamily)&&row.payload.epoch===mission.payload.epoch).sort((a,b)=>String(a.payload.at).localeCompare(String(b.payload.at))).slice(-40);
      const unmeasured=(await service.list('archive')).filter(row=>row.payload.moduleId===mission.payload.moduleId&&sameFamily(row.payload.taskFamily,mission.payload.taskFamily)&&!row.payload.verdictId).slice(-4);
      const history=[...verdictHistory.slice(-(40-unmeasured.length)),...unmeasured];
      const archive = await service.list('archive');
      const parent = selectEvolutionParent(archive.filter(row=>row.payload.moduleId===mission.payload.moduleId&&sameFamily(row.payload.taskFamily,mission.payload.taskFamily)).map(row => ({ id: row.id, ...row.payload })));
      candidate = await adapter.propose({ ...mission.payload, id: mission.id, history: history.map(row => row.payload), parent });
      if (candidate?.status === 'unavailable') return update(mission, { status: 'waiting_resource', reason: candidate.reason });
      const schedule=mission.payload.mechanismSchedule??[3,2,1],stage=mission.payload.round<=Math.ceil(mission.payload.maxRounds/3)?0:mission.payload.round<=Math.ceil(2*mission.payload.maxRounds/3)?1:2;
      const issues = evolutionProposalIssues({ ...candidate.proposal, round: mission.payload.round, rounds: mission.payload.maxRounds });
      if(candidate.proposal?.mechanisms?.length>Math.min([3,2,1][stage],schedule[stage]??1))issues.push('assigned-policy-mechanism-limit');
      if(issues.length)return retryProposal(mission,candidate,'proposal-metadata',issues);
      const previous = (await service.list('archive')).find(row => row.payload.candidateHash === digest(candidate.policy ?? candidate.files));
      if (previous) return update(mission, { status: 'rejected', completed: true, result: { outcome: 'insufficient-evidence', reason: 'duplicate-candidate', previousId: previous.id } });
      const reviewed = await screen?.({ candidate, mission: mission.payload });
      if(reviewed?.passed!==true)return retryProposal(mission,candidate,'candidate-screen',reviewed??null);
      const prepared = await adapter.prepare(candidate);
      if(prepared.status!=='prepared')return retryProposal(mission,candidate,'preparation',prepared);
      candidate=prepared.candidate??candidate;
      const finalScreen=await screen?.({candidate,mission:mission.payload,prepared:true});
      if(finalScreen?.passed!==true)return retryProposal(mission,candidate,'prepared-candidate-screen',finalScreen??null);
      preparedState={candidate,baseline:prepared.baseline,parentId:parent?.id??null,screen:finalScreen,preparedAt:service.now().toISOString()};
      mission=await update(mission,{preparedCandidateState:preparedState});
      }
      candidate=preparedState.candidate;
      const repair=mission.payload.sources?.includes('repair')||mission.payload.kind==='repair'||candidate.proposal?.opportunityKind==='repair';
      if(repair){
        let receipt=mission.payload.failureReproductionReceiptId?await service.get(mission.payload.failureReproductionReceiptId):null;
        if(!validEvolutionFailureReproduction(receipt?.payload,{missionId,moduleId:mission.payload.moduleId,baseline:preparedState.baseline})){
          const reproduced=await service.callbacks.reproduceEvolutionFailure?.({missionId,moduleId:mission.payload.moduleId,candidate,baseline:preparedState.baseline,taskFamily:mission.payload.taskFamily,opportunityId:mission.payload.opportunityId},context);
          receipt=reproduced?.status==='reproduced'&&reproduced.receiptId?await service.get(reproduced.receiptId):null;
          if(!validEvolutionFailureReproduction(receipt?.payload,{missionId,moduleId:mission.payload.moduleId,baseline:preparedState.baseline}))return update(mission,{status:'waiting_resource',reason:'repair-failure-reproduction-required'});
          mission=await update(mission,{failureReproductionReceiptId:receipt.id});
        }
      }
      const tasksPrepared=await service.callbacks.prepareModuleTasks?.({...mission.payload,moduleId:mission.payload.moduleId,missionId,candidate,phase:'development'},context);
      if(tasksPrepared&&tasksPrepared.status!=='ready')return update(mission,{status:'waiting_resource',reason:tasksPrepared.reason??'development-task-preparation'});
      const anchors=mission.payload.smokeCaseIds?await Promise.all(mission.payload.smokeCaseIds.map(id=>service.get(id))):(await service.list('task')).filter(row=>row.payload.moduleId===mission.payload.moduleId&&row.payload.pool==='development'&&(row.payload.baselineKnownCorrect===true||row.payload.curriculum?.destination==='regression-anchor')).slice(0,4);
      if(anchors.length<2||anchors.some(row=>!row)||!adapter.smoke)return update(mission,{status:'waiting_resource',reason:'known-correct-smoke-cases-incomplete'});
      const smokeInput={missionId,userId:await service.owner(),projectId:mission.projectId,batch:anchors.map(row=>({...row.payload,id:row.id,equivalentVariant:null})),...context};
      if(!mission.payload.smokeCaseIds)mission=await update(mission,{smokeCaseIds:anchors.map(row=>row.id)});
      const smokeBatch={id:`evolution-smoke-${evolutionKey([mission.id,digest(candidate)])}`};
      const runSmoke=arm=>adapter.smoke({...smokeInput,arm,candidate:arm==='baseline'?preparedState.baseline:candidate,checkpointUnit:(key,operation)=>taskPool.executeUnit(smokeBatch,`${arm}:${key}`,operation)});
      let baselineSmoke,candidateSmoke;
      try{baselineSmoke=await runSmoke('baseline');}catch(error){
        if(error.code==='usage_budget_exceeded'&&(error.status??error.statusCode)===402)return update(mission,{status:'waiting_resource',reason:'development-budget',researchCostCny:await cost(missionId)});
        if(error.code==='evolution_first_answer_reconciliation')return update(mission,{status:'waiting_resource',reason:'development-first-answer-reconciliation'});
        throw error;
      }
      if(baselineSmoke.passed!==true)return update(mission,{status:'waiting_resource',reason:'baseline-smoke-not-known-correct'});
      try{candidateSmoke=await runSmoke('candidate');}catch(error){
        if(error.code==='usage_budget_exceeded'&&(error.status??error.statusCode)===402)return update(mission,{status:'waiting_resource',reason:'development-budget',researchCostCny:await cost(missionId)});
        if(error.code==='evolution_first_answer_reconciliation')return update(mission,{status:'waiting_resource',reason:'development-first-answer-reconciliation'});
        throw error;
      }
      if(candidateSmoke.passed!==true)return retryProposal(mission,candidate,'candidate-smoke',candidateSmoke);
      mission=await update(mission,{smoke:{baseline:baselineSmoke,candidate:candidateSmoke,caseIds:anchors.map(row=>row.id)}});
      candidate = { ...candidate, id: `evolution-candidate-${digest(candidate).slice(0,32)}`, frozenAt: service.now().toISOString() };
      mission = await update(mission, { candidate, candidateHash: digest(candidate), baseline: preparedState.baseline, status: 'frozen', screen: preparedState.screen,preparedCandidateState:null });
      await service.save('archive', candidate.id, { candidateHash: digest(candidate.policy ?? candidate.files), candidate, moduleId: mission.payload.moduleId,
        taskFamily:mission.payload.taskFamily??null,epoch:mission.payload.epoch,parentId: preparedState.parentId, missionId: mission.id, status: 'frozen', evaluatedDescendants: 0, promotedDescendants: 0 });
    }
    const tasksPrepared=await service.callbacks.prepareModuleTasks?.({...mission.payload,moduleId:mission.payload.moduleId,missionId,candidate,phase:'confirmation',freezeAt:candidate.frozenAt},context);
    if(tasksPrepared&&tasksPrepared.status!=='ready')return update(mission,{status:'waiting_confirmation',reason:tasksPrepared.reason??'confirmation-task-preparation'});
    const evaluatorCompatibility=digest([mission.payload.moduleId,mission.payload.taskFamily??null,mission.payload.epoch,adapter.evaluatorVersion??'unversioned',mission.payload.successConditions]);
    const minimum = { frontier: 30, geo: 30, autopilot: 20, runtime: 10 }[mission.payload.moduleId] ?? 2;
    const batch = await taskPool.assemble({ candidateId: candidate.id, lineageId: candidate.lineageId ?? mission.id, moduleId: mission.payload.moduleId,
      frozenAt: candidate.frozenAt, modelReleasedAt: mission.payload.modelReleasedAt, epoch: mission.payload.epoch, minimum, slices: mission.payload.successConditions.slices ?? [] });
    if (!batch.id) return update(mission, { status: 'waiting_confirmation', waiting: batch.payload });
    const previousVerdict=await service.get(`evolution-verdict-${evolutionKey([candidate.id,batch.id])}`);
    if(previousVerdict){
      if(previousVerdict.payload.candidateHash!==digest(candidate)||previousVerdict.payload.missionId!==missionId)throw new Error('Sealed verdict belongs to another candidate.');
      const p=previousVerdict.payload;
      if(batch.payload.status!=='complete')await taskPool.finish(batch,{verdictId:previousVerdict.id,outcome:p.outcome,reason:p.reason,promote:p.promote,scope:p.scope??null});
      return finalizeMission(mission,candidate,previousVerdict,adapter);
    }
    const begun = await taskPool.begin(batch);
    if (!['started','resumed'].includes(begun.status)) return update(mission, { status: 'waiting_confirmation', reason: 'previous-attempt-needs-reconciliation' });
    const common = { missionId, userId: await service.owner(), projectId: mission.projectId, pool: 'confirmation', batch: begun.tasks.map(row => ({ id: row.id, ...row.payload })), ...context };
    const baselines = [], measurements = [];
    // Fixed predeclared sequence alternates the candidate's one attempt with the unchanged baseline's three repeats.
    for (const [repeat,role] of ['baseline', 'candidate', 'baseline', 'baseline'].entries()) {
      let evaluated;
      try{
        evaluated = await adapter.evaluate({ ...common, candidate: role === 'candidate' ? candidate : { policy: mission.payload.baseline?.policy ?? {}, revisionId: mission.payload.baseline?.revisionId }, role, arm:role, repeat,
          checkpointUnit:(key,operation)=>taskPool.executeUnit(batch,`${role}:${repeat}:${key}`,operation) });
      }catch(error){
        if(error.code==='usage_budget_exceeded'&&(error.status??error.statusCode)===402)return update(await service.get(missionId),{status:'waiting_confirmation',reason:'confirmation-budget',researchCostCny:await cost(missionId)});
        if(error.code==='evolution_first_answer_reconciliation')return update(await service.get(missionId),{status:'waiting_confirmation',reason:'first-answer-reconciliation'});
        throw error;
      }
      if (evaluated.status !== 'measured') {
        return update(await service.get(missionId), { status: 'waiting_confirmation', reason: evaluated.reason ?? 'measurement-unavailable', researchCostCny:await cost(missionId) });
      }
      const measurementIssues=validateEvolutionMeasurements(common.batch,evaluated);
      if(measurementIssues.length)return update(await service.get(missionId),{status:'waiting_confirmation',reason:'frozen-measurement-integrity',measurementIssues});
      if (role === 'candidate') measurements.push(evaluated); else baselines.push(evaluated);
    }
    const measured = measurements[0];
    const grouped=measurement=>{const groups=new Map();for(const unit of measurement.units){const key=unit.groupId??unit.id;const values=groups.get(key)??[];values.push(unit.score);groups.set(key,values);}return new Map([...groups].map(([key,values])=>[key,average(values)]));};
    const candidateGroups=grouped(measured),baselineGroups=baselines.map(grouped),groupIds=[...candidateGroups.keys()].sort();
    if(!groupIds.length||baselineGroups.some(groups=>groups.size!==groupIds.length||groupIds.some(key=>!groups.has(key))))return update(mission,{status:'waiting_confirmation',reason:'paired-group-mismatch'});
    const scores=baselineGroups.map(groups=>groupIds.map(key=>groups.get(key)));
    const score = average([...candidateGroups.values()]), baseline = average(scores.flat());
    const delta = evolutionNoiseBand(scores);
    const historical = (await service.list('candidate-verdict')).filter(row => row.payload.moduleId === mission.payload.moduleId && row.payload.evaluatorCompatibility === evaluatorCompatibility && row.payload.promote);
    const historicalBest = Math.max(baseline, ...historical.map(row => Number(row.payload.score ?? baseline)));
    let selection = selectEvolutionCandidate({ receiptValid: true, confirmatory: true, firstAttempt: true,
      evidenceTier: measured.evidenceTier ?? 'model', anchorCalibrated: measured.anchorCalibrated === true,
      deterministicChecksPassed: measured.deterministicChecksPassed === true, modelScoredLabel: true,
      baseline, score, historicalBest, delta, baselineCost: average(baselines.map(measurement => measurement.costCny)), cost: measured.costCny,
      baselineContext: average(baselines.map(measurement => measurement.contextBytes)), context: measured.contextBytes,
      removedMechanisms: candidate.proposal.removedMechanisms ?? 0 });
    const variantScores=measurement=>measurement.units.filter(unit=>unit.id.endsWith(':equivalent')).map(unit=>unit.score);
    const equivalentScore=average(variantScores(measured)),equivalentBaseline=average(baselines.flatMap(variantScores));
    if(selection.promote&&(equivalentScore==null||equivalentBaseline==null||equivalentScore<equivalentBaseline-delta||selection.outcome==='improved'&&equivalentScore-equivalentBaseline<=delta))selection={outcome:'insufficient-evidence',reason:'equivalent-variant-gain-not-confirmed',promote:false,scope:null};
    const auditOnly=mission.payload.auditOnly===true;
    const evaluationReceiptHash=digest({candidateHash:digest(candidate),batch:batch.payload,measured,baselines,evaluatorCompatibility});
    const verdictId = `evolution-verdict-${evolutionKey([candidate.id,batch.id])}`;
    await service.save('candidate-verdict', verdictId, { ...selection, moduleId: mission.payload.moduleId, candidateId: candidate.id, candidateHash: digest(candidate), missionId,
      evaluatorCompatibility,taskFamily:mission.payload.taskFamily??null,auditOnly,parentId:candidate.parentId??mission.payload.sourceCandidateIds?.[0]??null,sourceCandidateIds:mission.payload.sourceCandidateIds??[],epoch: mission.payload.epoch, score, baseline, delta, historicalBest, evidenceTier: measured.evidenceTier ?? 'model', batchId: batch.id,
      evaluationReceiptHash,modelScoredLabel:measured.evidenceTier==='model',receiptValid: true, confirmatory: true, firstAttempt: true, mechanismContributions:candidate.proposal.mechanisms?.length===1?{[candidate.proposal.mechanisms[0]]:score-baseline}:{},equivalentScore,equivalentBaseline,passed: selection.promote, measured, baselines, at: service.now().toISOString() });
    await taskPool.finish(batch, { verdictId, ...selection });
    return finalizeMission(mission,candidate,await service.get(verdictId),adapter);
  }

  async function wake(event) {
    const rows = await service.list('mission'), woken = [];
    // A dataset counts as a new resource only when its semantics matched: Integration.resolveWaiters decides that, never just an event name.
    const dataMatched = event.type !== 'dataset-ready' || event.semanticsMatched === true;
    for (const dossier of await service.list('dossier', null, { deferred: true })) {
      if (dossier.payload.deferred === true && dataMatched && metBy(dossier.payload.wakeConditions, event)) await service.save('dossier', dossier.id, { ...dossier.payload, deferred: false, deferredAt: null, wakeConditions: [], reopenedBy: event.type, reopenedAt: service.now().toISOString() }, dossier);
    }
    for (const row of rows) {
      if (!['waiting_resource', 'waiting_confirmation','waiting_budget','paused'].includes(row.payload.status)) continue;
      if (row.payload.ownerId && (event.userId !== row.payload.ownerId || event.projectId !== row.payload.ownerProjectId)) continue;
      const ready = ['waiting_budget','paused'].includes(row.payload.status)?['budget-window','search-resumed'].includes(event.type):row.payload.status === 'waiting_confirmation' ? ['frontier-publication', 'task-ready'].includes(event.type)
        : metBy(row.payload.wakeConditions, event);
      if (!ready) continue;
      if (!dataMatched) continue;
      const resumed=row.payload.resourceStopped&&['dataset-ready','method-ready','tool-ready','environment-changed'].includes(event.type)?await update(row,{resourceAttempts:0,resourceStopped:false,resourceWindowStartedAt:service.now().toISOString(),status:'ready'}):row;
      await queue(resumed); woken.push(row.id);
    }
    return woken;
  }
  return { fund, register, opportunity, create, plan, queue, ensureJob, recordJob, run, wake, publish, adapters: adapterRegistry };
}
