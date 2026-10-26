import { AGENDA_DEFAULT_BUDGETS } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { EVOLUTION_PROJECT_ID, isInternalProject } from './internalProjects.mjs';
import { createEvolutionService, evolutionKey } from './evolutionService.mjs';
import { EvolutionIntegration, evolutionRunGap } from './evolutionIntegration.mjs';
import { createPlatformSkillSupply } from './platformSkillSupply.mjs';
import { createEvolutionSignals } from './evolutionSignals.mjs';
import { evolutionAccountFloors } from './evolutionAccountClasses.mjs';
import { createEvolutionPolicyBasis } from './evolutionPolicyBasis.mjs';
import { readGeoCalibrationCases, validEvolutionFailureReproduction } from './evolutionServingEvidence.mjs';
import { createEvolutionMaintenance } from './evolutionMaintenance.mjs';
import { createEvolutionDecisions, evolutionExecutableOperation, evolutionRetirementNotice } from './evolutionDecisions.mjs';
import { createEvolutionFeedback } from './evolutionFeedback.mjs';
import { createEvolutionServingWorker } from './evolutionServingWorker.mjs';
import { createEvolutionRoutes } from './evolutionRoutes.mjs';
import { createEvolutionGatewayHandler } from './evolutionGateway.mjs';
import { createEvolutionToolAdmission } from './evolutionToolAdmission.mjs';
import { heavyWorkAdmission } from './heavyWorkAdmission.mjs';
import { OPEN_COST_VALUE, openCostPredicate } from './usageLedger.mjs';
import { evolutionScientificUse } from './evolutionScientificUse.mjs';
import { evolutionCompletedResult } from './evolutionUsage.mjs';
import { readRunTranscript } from './runTranscripts.mjs';
import { quarantineRetiredEvolutionJobs } from './evolutionRetiredJobs.mjs';

/** Published tools, account-local feedback and existing product continuation only.
 * Experimental composition is reachable exclusively from the offline campaign entry.
 * @param {any} dependencies */
export function createEvolutionServing({config,store,documents,jobs,database,notifications,registry,runtimeManager,agentRuns,controller,autopilot,evaluationIsolation,sourceChanges=null,canRun=async()=>true,resolvePositiveEvidence=null,report=()=>{}}) {
 if(!config.evolutionEnabled||!database||!documents||!jobs)return null;
 // Serving mode is a composition role, independent of the historical search pause switch.
 const servingConfig={...config,evolutionSearchPaused:true,evolutionServingOnly:true};
 const ensureOwner=async()=>{const owner=config.operatorUsers[0],user=owner&&await store.userById(owner);if(!user)throw new HttpError(503,'evolution_owner_missing','Evolution requires a configured platform operator.');await store.projectFor(user,EVOLUTION_PROJECT_ID,'EviMed 循证进化');return owner;};
 const service=createEvolutionService({documents,jobs,config:servingConfig,notifications,ensureOwner,callbacks:{
  waiterOwners:async()=>(await database.query("SELECT DISTINCT user_id FROM evimed_product.documents WHERE kind='knowledge' AND payload->>'recordType'='evolution-waiter' AND deleted_at IS NULL")).rows.map(row=>row.user_id),
  waitingAgendaCount:async capabilityIds=>Number((await database.query("SELECT count(*)::integer AS count FROM evimed_product.documents WHERE kind='knowledge' AND payload->>'recordType'='evolution-waiter' AND payload->>'status'='waiting' AND payload->>'capabilityId'=ANY($1::text[]) AND deleted_at IS NULL",[capabilityIds])).rows[0]?.count??0),
  wakeAgenda:input=>integration.wakeAgenda(input)
 }});
 const integration=new EvolutionIntegration({service,autopilot,report});
 const supply=createPlatformSkillSupply(config,{report});
 const signals=createEvolutionSignals({service,capabilityIds:async()=>(await registry).list({includeInternal:false}).map(item=>item.id),operatorIds:()=>config.operatorUsers??[],floors:evolutionAccountFloors(config)});
 const policyBasis=createEvolutionPolicyBasis({service,sourceChanges:()=>sourceChanges,calibrationCases:readGeoCalibrationCases,verifyReproduction:validEvolutionFailureReproduction});
 service.callbacks.policyBasis=policyBasis;
 service.callbacks.observeSignal=input=>signals.record(input);
 service.callbacks.reconcileModulePolicyBasis=()=>policyBasis.reconcile();
 const offline=()=>{throw new HttpError(409,'evolution_offline_only','Platform experiments run only in offline campaigns.');};
 const decisions=createEvolutionDecisions({service,notifications,config:servingConfig,callbacks:{execute:async action=>service.executeDecisionAction(action,async()=>{
  const operation=evolutionExecutableOperation(action);
  if(operation==='keep'&&(await service.get(action.subjectId))?.payload.recordType==='evolution-maintenance-review')return maintenance.executeReview(action);
  if(['wait','defer','keep'].includes(operation))return {state:'waiting'};
  if(operation==='maintenance-retire')return maintenance.executeReview(action);
  return offline();
 })}});
 const maintenance=createEvolutionMaintenance({service,callbacks:{
  // Harm evidence opens a review. Serving never promotes it into an automatic retirement.
  proposeReview:async input=>{const id=`evolution-decision-${evolutionKey([input.category,input.subjectId,input.materialVersion??1])}`;const known=await service.get(id);const row=known??await service.save('decision',id,{...input,decisionClass:'C',status:'pending',createdAt:service.now().toISOString(),history:[],overridden:false});return decisions.deliver(row);},
  restorePin:pin=>supply.activate(pin),retirePin:id=>supply.retire(id),
  notifyAffected:async({toolId,reason})=>{await supply.retire(toolId);const uses=await database.query("SELECT user_id,project_id,id FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='evolution-use' AND payload->>'toolId'=$1",[toolId]);const retired=await service.get(toolId),wording=evolutionRetirementNotice({name:retired?.payload.name??retired?.payload.description,toolId,reason});for(const row of uses.rows)await notifications.create(row.user_id,{noticeType:'notify',...wording,source:{type:'system',id:row.id},projectId:row.project_id,idempotencyKey:`evolution-retired:${row.id}:${toolId}`});}
 }});
 const feedback=createEvolutionFeedback({service,maintenance,resolvePositiveEvidence});
 service.callbacks.observeFeedback=feedback.observeFeedback;
 const worker=createEvolutionServingWorker({service,integration,decisions,config:servingConfig,canRun,
  quarantine: () => quarantineRetiredEvolutionJobs(database, config.operatorUsers[0])});
  const routes = createEvolutionRoutes({ store, service, decisions, worker, config: servingConfig, evidenceRegistration: null, capabilityMap: async () => (await service.get('evolution-capability-map'))?.payload ?? null, isOperator: user => config.operatorUsers.includes(user.id),
    registerEvaluationPolicy: async (user, { projectId, policy }) => { await store.requireProject(user, projectId); return evaluationIsolation.registerPending({ userId: user.id, projectId }, policy); },
    evaluationAudit: async (user, { projectId }) => { const project = await store.requireProject(user, projectId); return Promise.all((await agentRuns.list(project)).map(run => evaluationIsolation.audit(run.id))); },
    adoptOpportunity: async (user, { opportunityId, projectId }) => {
      const opportunity = await service.get(opportunityId, user.id);
      if (!opportunity || opportunity.projectId !== projectId || opportunity.payload.recordType !== "evolution-opportunity") throw new HttpError(404, "evolution_opportunity_missing", "The research opportunity is unavailable.");
      if (opportunity.payload.agendaId) return autopilot.get(user.id, opportunity.payload.agendaId);
      const agenda = await autopilot.create(user.id, { projectId, title: opportunity.payload.title, prompt: opportunity.payload.prompt ?? opportunity.payload.title,
        taskTypes: opportunity.payload.taskTypes ?? ["literature-sentinel"], ...AGENDA_DEFAULT_BUDGETS,
        schedule: { kind: "daily", timeZone: "Asia/Shanghai", time: "08:00" } });
      await service.save("opportunity", opportunity.id, { ...opportunity.payload, agendaId: agenda.id }, opportunity, user.id);
      return agenda;
    }, maxJsonBytes: config.maxJsonBytes });
  const dailyCost = async client => Number((await client.query(`SELECT coalesce(sum(CASE WHEN status='settled' THEN actual_cost WHEN ${openCostPredicate("24 hours", "$1")} THEN ${OPEN_COST_VALUE} ELSE 0 END),0) AS cost FROM evimed_usage.model_requests WHERE purpose='evolution' AND created_at>=$1::timestamptz-interval '24 hours'`, [new Date().toISOString()])).rows[0]?.cost ?? 0);
  const scientificUseScope = async event => {
    const user=await store.userById(event.userId), project=await store.requireProject(user,event.projectId);
    const run=(await agentRuns.list(project)).find(row=>row.id===event.runId);
    return evolutionScientificUse(event.projectId,run);
  };
  const onExecution = async event => {
    const scientific=await scientificUseScope(event);
    const id = `evolution-use-${evolutionKey([event.userId, event.projectId, event.runId, event.toolId, event.callId ?? event.runId])}`;
    const tool = await service.get(event.toolId);
    await service.save("use", id, { ...event, track: tool?.payload.track ?? null, ...scientific, supported: null, resultState: "pending", at: service.now().toISOString() }, null, event.userId);
    if (scientific.researcherOwned === true) await maintenance.observe(event.toolId, { runId: event.runId, userId: event.userId, callId: event.callId, invoked: true, executionOk: event.result.ok, outcome: "pending" });
  };
  const onRetrieval = async event => {
    if ((await scientificUseScope(event)).researcherOwned !== true) return;
    await maintenance.observe(event.toolId, { runId: event.runId, userId: event.userId, retrievalId: event.retrievalId, retrieved: true, outcome: "pending" });
  };
  const toolAdmission = createEvolutionToolAdmission({ config, database, canRun, heavyWorkAdmission, isInternalProject, dailyCost });
  const gateway = createEvolutionGatewayHandler({ config, authenticateWorkload: token => runtimeManager.assertActiveEviMedWorkloadToken(token), runtimeManager, controller, supply,
    resolveRun: async principal => { const user = await store.userById(principal.userId), project = await store.requireProject(user, principal.projectId);
      const active = (await agentRuns.list(project)).filter(run => run.status === "running");
      if (active.length !== 1) return null;
      return { project, runId: active[0].id, capabilityId: active[0].effectiveAgentId ?? active[0].agentId }; },
    // Decided in a short transaction and bounded per project; neither the heavy-work lock nor a pooled connection is held while the tool runs.
    admit: toolAdmission.admit,
    onExecution });
  const finishRun = async (project, run) => {
    if (!isInternalProject(project.id)) {
      const route = String(run.effectiveRouteReason ?? '');
      if (route.includes(':classifier:')) await signals.record({userId:project.userId,projectId:project.id,eventId:run.id,moduleId:'runtime',kind:'classifier-failure',
        capability:run.effectiveAgentId??'open-domain-answer',operation:'route',dataShape:'none',reason:'unsupported'});
      if (run.connectorNeeds?.length) await signals.record({userId:project.userId,projectId:project.id,eventId:`connector:${run.id}`,moduleId:'tools',kind:'unmet-demand',
        capability:run.effectiveAgentId??'open-domain-answer',operation:'search',dataShape:'unknown',reason:'missing-data'});
      if (route.startsWith('choice:')) await signals.record({userId:project.userId,projectId:project.id,eventId:run.id,moduleId:'runtime',kind:'route-override',
        capability:run.effectiveAgentId ?? 'open-domain-answer',fromCapability:run.suggestedAgentId ?? 'unknown',operation:'route',dataShape:'none',reason:'unsupported'});
      const toolUnavailable=(run.qualityNotices??[]).some(notice=>notice?.code==='run_tool_unavailable');
      if (toolUnavailable || ['method-missing','method-implementation','connector'].includes(evolutionRunGap(run))) await signals.record({userId:project.userId,projectId:project.id,eventId:run.id,
        moduleId:'tools',kind:'unmet-demand',capability:run.effectiveAgentId,operation:'unknown',dataShape:'unknown',reason:'missing-tool'});
    }
    // Only this run's calls of platform tools: a run that made none (nearly every run of every researcher) has nothing to
    // complete and nothing to observe, and neither the account's whole record of uses nor its transcript is read for it.
    const uses = (await service.list("use", project.userId, { runId: run.id })).filter(row => row.projectId === project.id);
    if (!uses.length) return;
    const transcript = await readRunTranscript(project, run.id).catch(() => null);
    if (isInternalProject(project.id)) return;
    const scientific=evolutionScientificUse(project.id,run);
    for (const row of uses) await service.save("use", row.id, { ...row.payload, ...scientific, ...evolutionCompletedResult(row.payload, run, transcript),
      completedAt: run.finishedAt ?? service.now().toISOString() }, row, project.userId);
    if (scientific.researcherOwned !== true) return;
    await feedback.observeVerifiedRun?.({...run,userId:project.userId,projectId:project.id});
    for (const toolId of new Set(uses.map(row => row.payload.toolId))) {
      await maintenance.observe(toolId, { runId: run.id, userId: project.userId, outcome: "pending", at: run.finishedAt ?? service.now().toISOString() });
    }
  };

 /** @param {any} event */
 const observe=async event=>{
  if(!['frontier','geo','autopilot','sources','evidence','memory','runtime','tools'].includes(event.moduleId))return null;
  if(event.userId)return signals.record(event);
  if(!['screened-out','edit-verification'].includes(event.kind))return null;
  const id=`evolution-module-observation-${evolutionKey([event.moduleId,event.eventId,event.kind])}`;
  if(await service.get(id))return null;
  const counts=Object.fromEntries(Object.entries(event.counts??{}).filter(([key,value])=>/^[a-zA-Z]{1,48}$/.test(key)&&Number.isFinite(value)&&Number(value)>=0));
  return service.save('module-observation',id,{moduleId:event.moduleId,kind:event.kind,counts,policyRevisionId:event.policyRevisionId??null,at:service.now().toISOString()});
 };
 service.callbacks.moduleObservation=observe;
 /** @param {any} input */
 const recordResumedResearchCompleted=async({userId,projectId,agendaId,runId,status})=>{
  if(!userId||!projectId||!agendaId||!runId||!['delivered','succeeded'].includes(status))return 0;
  let recorded=0;for(const row of await service.list('waiter',userId)){if(row.payload.projectId!==projectId||row.payload.agendaId!==agendaId||row.payload.status!=='resolved'||row.payload.completedResearchAt)continue;await service.save('waiter',row.id,{...row.payload,completedResearchAt:service.now().toISOString(),completionRunId:runId},row,userId);recorded++;}return recorded;
 };
 service.callbacks.recordResumedResearchCompleted=recordResumedResearchCompleted;
 return {service,integration,supply,signals,policyBasis,observe,onExecution,onRetrieval,finishRun,observeVerifiedRun:feedback.observeVerifiedRun,observeFeedback:feedback.observeFeedback,gateway,routes,toolAdmission,worker,decisions,maintenance,recordResumedResearchCompleted,
  executorCounters:async()=>(await controller.evolutionAdmissionAvailable())?.executor??null,
  limitCounters:()=>({signals:signals.counters,resourceWaits:decisions.counters,serving:worker.counters,experimentScheduling:false})};
}
