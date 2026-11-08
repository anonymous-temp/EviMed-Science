/** First-party production host. The native plugin owns reasoning; this adapter owns
 * identity, current grants, preserved inputs and erasure-aware persistence. */
import { KERNEL_DEEPSEEK_PROVIDER } from './dshProfilePatch.mjs';
import { randomUUID } from 'node:crypto';
import { HOST_ABI, assertScope, canonicalJson, contentDigest, profileIdentity, pairIdentity, projectMatchingResult, validateMatchingTask, validatePairDecision, validateEvidenceBundle, validateClinicalContext, validateTrialProfile, validateComputationReceipt, validateToolResponse } from '@evimed/patient-matching-core';
import { calculateClinicalScore, calculatorLibraryIdentity } from '@evimed/patient-matching-worker';
import { judgmentTargets, readSubjectNote, tableFieldsOf, planMatchJudge } from './vcrMatchJudge.mjs';
import { PatientMatchingRepository } from './patientMatchingRepository.mjs';
import { patientMatchingConfiguration } from './patientMatchingConfiguration.mjs';
import { HttpError } from './security.mjs';
import { nativeDecisionProjection } from './patientMatchingProjection.mjs';
import { renderPatientMatchingReport } from './patientMatchingReport.mjs';
import { patientMatchingOutputSchema } from './patientMatchingOutputSchema.mjs';
import { segmentCriteria } from '@evimed/domain';

const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const deny = (code = 'patient_matching_scope_mismatch', message = 'The operation is outside the current matching task.') => { throw new HttpError(403, code, message); };
const response = (data, summary = 'Matching operation completed.', status = 'complete', artifacts = []) => ({ status, summary, data, artifacts });
const unsupported = operation => response({ code: 'patient_matching_resource_unavailable', operation }, 'This resource is not connected in this deployment.', 'unsupported');
const uniqSources = sources => [...new Map(sources.map(source => [source.sourceId, source])).values()];
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const registryOf = value => /^ChiCTR/i.test(String(value)) ? 'chictr' : /^\d{4}-\d{6}-\d{2}(?:-\d{2})?$/.test(String(value)) ? 'ctis' : 'clinicaltrials.gov';
export const patientMatchingScope = origin => ({ tenantId: origin.userId, actorId: origin.userId, projectId: origin.projectId, conversationId: origin.rootSessionId });

/** The most concurrent executions one match_assess call may hold (the plugin runs ASSESS_LANES of them). */
export const MATCHING_LANES_MAX = 16;

/** @param {{vcr:any,documents:any,config?:any,modelPorts?:any,indexPorts?:any,calculate?:any,writeArtifact?:any,onPending?:any,onCancel?:any,knowledge?:any,discover?:any}} dependencies */
export function createPatientMatchingHostAdapter({ vcr, documents, config = {}, modelPorts = null, indexPorts = null, calculate = calculateClinicalScore, writeArtifact = null, onPending = null, onCancel = null, knowledge = null, discover = null }) {
  const repository = new PatientMatchingRepository(documents);
  const targets = judgmentTargets({ evidence: vcr.evidence, matchStore: vcr.matchStore, pages: vcr.registryPages });
  const modelProfile = config.patientMatchingProfile ?? patientMatchingConfiguration(config);
  if(modelProfile.reasoningModel!=='deepseek-flash'||modelProfile.proEscalation!==false)throw new HttpError(503,'patient_matching_flash_required','Patient matching requires DeepSeek V4.1 Flash.');
  // The managed child names the provider the production kernel mounts; `deepseek` had no adapter there (replay, 2026-11-08: NO_ADAPTER).
  const reasoning = Object.freeze({ provider: KERNEL_DEEPSEEK_PROVIDER, model: modelProfile.reasoningModel, reasoningEffort: 'high', maxTokens: 16000 });
  const profileDigest = profileIdentity({ modelProfile, reasoning });
  const evidenceLedgers=new Map();
  function ledger(taskId) {
    if(!evidenceLedgers.has(taskId)) {
      while(evidenceLedgers.size>=128)evidenceLedgers.delete(evidenceLedgers.keys().next().value);
      evidenceLedgers.set(taskId,{evidenceIds:new Set(),computations:new Map(),knowledgePassages:new Map()});
    }
    return evidenceLedgers.get(taskId);
  }

  async function newTask(origin, selectedPairs = [], extra = {}) {
    const scope = patientMatchingScope(origin), study = await studyFor(origin, true), taskId = id('matchTask');
    return repository.put(scope, taskId, { taskId, scope, studyId: study.id, pluginGeneration: origin.pluginGeneration,
      direction: 'patient-to-trials', selectedPairs, protocolVersionId: null, collection: null, collectionRevision: null,
      rowIds: [], executions: [], state: 'pending',continuationEpoch:0, profileDigest, origin: { userId: origin.userId, projectId: origin.projectId, rootSessionId: origin.rootSessionId, runId: origin.runId,pluginGeneration:origin.pluginGeneration }, ...extra });
  }

  async function studyFor(origin, create = false) {
    const study = await vcr.store.taskContext(origin, { create });
    if (!study || study.userId !== origin.userId || study.projectId !== origin.projectId || study.conversationSessionId !== origin.rootSessionId) deny();
    await vcr.access.require({ actor: origin.userId, studyId: study.id, ability: 'read_patient_level' });
    return { ...study, executionOrigin: origin, completionOrigin: origin, cloudContext: { runId: origin.runId, sessionId: origin.rootSessionId } };
  }
  async function owned(origin, taskId) {
    const scope = patientMatchingScope(origin), row = await repository.get(scope, taskId), study = await studyFor(origin);
    if (row.payload.studyId !== study.id) deny();
    if (origin.child && !row.payload.executions.some(item => item.rootCallId === origin.rootCallId && item.state === 'prepared')) deny('patient_matching_child_unbound');
    return { scope, row, study, meta: row.payload };
  }
  async function patient(study, subjectKey, scope) {
    if ((await vcr.matchStore.withdrawnSubjects(study.id)).has(subjectKey)) deny('vcr_document_withdrawn', 'This patient has withdrawn.');
    const roster = (await vcr.documents.roster(study)).filter(row => row.subjectKey === subjectKey);
    const note = await readSubjectNote({ study, subjectKey, documents: vcr.documents, roster, table: await tableFieldsOf(vcr.subjectTable, study), long: await vcr.documents.longTables?.(study) ?? null });
    const sources = [], passages = [];
    for (const [index, record] of note.records.entries()) {
      const source = { sourceId: record.documentId ?? `table:${subjectKey}:${index}`, revision: note.hash, digest: contentDigest(record.text), kind: 'patient' };
      sources.push(source);
      for (const sentence of record.sentences) {
        const evidenceId = `e:${profileIdentity([source, sentence.start, sentence.end]).slice(7)}`;
        passages.push({ evidenceId, subjectKey, source, text: sentence.text, span: { start: sentence.start, end: sentence.end } });
      }
    }
    const context = { schemaVersion: '1', scope, contextId: `context:${subjectKey}`, subjectKey, revision: note.hash, sources, observations: [], coverage: { state: note.unreadable ? 'partial' : 'complete', limitations: note.unreadable ? ['Some patient documents cannot currently be read.'] : [] } };
    validateClinicalContext(context);
    return { context, sources, passages, note };
  }
  async function trial(study, pair, meta, scope) {
    /** @type {any} */
    const target = meta.protocolVersionId
      ? await targets.protocol({ study, protocolVersionId: meta.protocolVersionId })
      : await targets.trial({ userId: study.userId, registry: registryOf(pair.trialId), registryId: pair.trialId, ...(meta.collection ? { collection: meta.collection, collectionRevision: meta.collectionRevision } : {}) });
    const prefix = `${JSON.stringify({title:target.title,summary:target.summary,demographics:target.takes??'',conditions:target.conditions,interventions:target.interventions})}\n\n`;
    const text = `${prefix}${target.eligibility}`;
    const source = { sourceId: `${meta.protocolVersionId ? 'protocol' : 'registry'}:${pair.trialId}`, revision: target.hash, digest: contentDigest(text), kind: meta.protocolVersionId ? 'protocol' : 'registry' };
    const profile = { schemaVersion: '1', scope, trialId: pair.trialId, source, profileDigest: profileIdentity({ source, targetHash: target.hash }), title: target.title, summary: target.summary, demographics: target.takes ?? '', conditions:target.conditions,interventions:target.interventions,preservedText: text,
      criteria: target.clauses.map(clause => ({ criterionId: clause.criterionId ?? `criterion:${clause.number}`, kind: ['inclusion','exclusion'].includes(clause.kind) ? clause.kind : 'unclassified', text: clause.text, span: { start: prefix.length + clause.start, end: prefix.length + clause.end } })), arms: [] };
    validateTrialProfile(profile);
    return { target, profile, source };
  }
  async function materials(study, pairs, meta, scope,origin=meta.origin) {
    const people = new Map(), trials = new Map(), bundles = [];
    const heldKnowledge=[...ledger(meta.taskId).knowledgePassages.values()];
    if(heldKnowledge.length){if(typeof knowledge?.refresh!=='function')deny('patient_matching_knowledge_unavailable');await knowledge.refresh({origin,scope,passages:heldKnowledge});}
    for (const pair of pairs) {
      if (!people.has(pair.subjectKey)) people.set(pair.subjectKey, await patient(study, pair.subjectKey, scope));
      if (!trials.has(pair.trialId)) trials.set(pair.trialId, await trial(study, pair, meta, scope));
      const person = people.get(pair.subjectKey), target = trials.get(pair.trialId);
      let characters=0;
      const initial=person.passages.filter(passage=>{if(characters+passage.text.length>18000)return false;characters+=passage.text.length;return true;});
      const held=ledger(meta.taskId),ids=new Set(initial.map(passage=>passage.evidenceId));
      const passages=person.passages.filter(passage=>ids.has(passage.evidenceId)||held.evidenceIds.has(passage.evidenceId));
      const limitations=[...person.context.coverage.limitations,...(passages.length<person.passages.length?['Only an initial evidence window is shown; use match_evidence for other relevant passages.']:[])];
      for(const passage of passages){const record=person.note.records.find(item=>item.documentId===passage.source.sourceId);if(record)await vcr.documents.recordWindow?.(study,record.documentId,record.text,passage.span.start,passage.span.end);}
      const bundle = { schemaVersion: '1', scope, bundleId: `bundle:${profileIdentity([pair, person.sources, target.source]).slice(7)}`, sources: uniqSources([...person.sources, target.source,...heldKnowledge.map(passage=>passage.source)]), patientPassages: passages, knowledgePassages: heldKnowledge, limitations,
        computations:[...held.computations.values()].filter(item=>item.subjectKey===pair.subjectKey&&item.receipt.operands.every(operand=>person.sources.some(source=>same(source,operand.source)))).map(item=>item.receipt) };
      validateEvidenceBundle(bundle); bundles.push(bundle);
    }
    return { people, trials, bundles, sources: uniqSources([...people.values()].flatMap(person => person.sources).concat([...trials.values()].map(target => target.source))) };
  }
  function taskOf(meta, pairs, sources) {
    const task = { schemaVersion: '1', taskId: meta.taskId, scope: meta.scope, direction: meta.direction === 'specified-pair' && pairs.length !== 1 ? 'patient-to-trials' : meta.direction,
      objective: 'Assess the selected patient and trial pairs from their preserved sources.', pluginGeneration: meta.pluginGeneration, selectedPairs: pairs, sources,
      budgets: { maxPairs: Math.max(1, pairs.length), maxEvidenceReads: 32, maxModelCalls: 16 } };
    validateMatchingTask(task); return task;
  }
  async function rowsOf(meta, study) {
    const rows = await vcr.matchJudgments.byIds(study.id, meta.rowIds ?? []);
    const selected=rows.filter(row => row.answer?.matchingTaskId === meta.taskId && row.answer?.coreDecision);
    for(const row of selected)for(const passage of row.answer.knowledgePassages??[])ledger(meta.taskId).knowledgePassages.set(passage.evidenceId,passage);
    return selected;
  }
  async function resultOf(origin, taskId, resultId = null) {
    const { meta, study, scope } = await owned(origin, taskId);
    const rows = await rowsOf(meta, study);
    const version = resultId ? (meta.results ?? []).find(item => item.resultId === resultId) : null;
    if (resultId && !version) throw new HttpError(404, 'patient_matching_result_not_found', 'Saved matching result was not found.');
    const chosen = version ? rows.filter(row => version.rowIds.includes(row.id)) : rows.filter(row => !row.answer.failureCheckpoint || row.answer.failureCheckpoint.epoch === (meta.continuationEpoch ?? 0));
    const newest = new Map();
    for (const row of chosen.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))) newest.set(pairIdentity(row.answer.coreDecision), row);
    const decisions = [], sources = [], selectedPairs = [], affectedPairs=[];
    for (const pair of meta.selectedPairs) {
      // Every read repeats cloud permission and withdrawal checks. Nothing in product metadata can reopen a record.
      const withdrawn = (await vcr.matchStore.withdrawnSubjects(study.id)).has(pair.subjectKey);
      if (withdrawn) continue;
      const row = newest.get(pairIdentity(pair));
      if (row) {
        const read = { documentIds: row.documentIds, snapshots: row.answer.readFrom?.snapshots ?? [] };
        const permission = await vcr.documents.judgeReads?.(study, { id: origin.userId }, [read]);
        const refusal = await vcr.documents.recordStands?.(study, { subjectKey: pair.subjectKey, documentIds: row.documentIds, snapshotIds: (row.answer.readFrom?.snapshots ?? []).map(item => item.id) });
        if (!permission?.patientLevel || permission.permitted[0] !== true || refusal) {
          selectedPairs.push(pair);
          decisions.push({...row.answer.coreDecision,revision:'withheld',state:'unsupported',clinicalEligibility:'not-assessed',recommendation:{priority:null,rationale:''},criteria:[],sourceRefs:[],unresolvedFacts:[],assumptions:[]});
          continue;
        }
      }
      const material = await materials(study, [pair], meta, scope,origin);
      const pairSources=uniqSources(material.bundles.flatMap(bundle=>bundle.sources));
      sources.push(...pairSources); selectedPairs.push(pair);
      if (row) {
        decisions.push(row.answer.coreDecision);
        if(pairSources.some(source=>!row.answer.coreDecision.sourceRefs.some(saved=>saved.sourceId===source.sourceId)))affectedPairs.push(pair);
      }
    }
    const frozenSources = uniqSources(decisions.flatMap(decision=>decision.sourceRefs));
    const task = taskOf(meta, selectedPairs, frozenSources.length ? frozenSources : uniqSources(sources));
    const selectedIds=new Set(selectedPairs.map(pairIdentity)),stageOrders=Object.fromEntries(Object.entries(meta.stageOrders??{}).map(([stage,ids])=>[stage,ids.filter(key=>selectedIds.has(key))]));
    return projectMatchingResult({ task, resultId: resultId ?? meta.resultId ?? `result:${meta.taskId}`, revision: String(version?.revision ?? meta.resultRevision ?? 0), decisions, currentSources: uniqSources(sources), profileDigest, ranking: { order: 'input' },stageOrders, affectedPairs });
  }
  async function prepare(origin, input) {
    const scope = patientMatchingScope(origin), study = await studyFor(origin, true);
    // A lane is one of the concurrent executions a single match_assess call runs (plugin ASSESS_LANES): it names the task the call's
    // first preparation opened and takes pairs no other lane of the same call holds.
    const lane = Object.hasOwn(input, 'lane') ? input.lane : null;
    if (lane !== null && (!Number.isSafeInteger(lane) || lane < 0 || lane >= MATCHING_LANES_MAX || !input.taskId)) deny('patient_matching_lane_invalid');
    let row;
    if (input.taskId) row = (await owned(origin, input.taskId)).row;
    if (lane !== null && (!row?.payload.selectedPairs.length || !row.payload.executions.some(item => item.rootCallId === origin.callId))) deny('patient_matching_lane_invalid');
    if (!row || !row.payload.selectedPairs.length) {
      const protocolVersionId=input.protocolVersionId??row?.payload.protocolVersionId;
      let registryIds = input.registryIds ?? [], collection = null, collectionRevision = null, searchReceipt=null;
      if (input.searchId) {
        const selection = await vcr.candidateSearches.resolveSelection(study, input.searchId);
        if (!selection) deny('patient_matching_search_not_found');
        ({ registryIds, collection, collectionRevision } = selection);
        searchReceipt=await vcr.candidateSearches.get(study,input.searchId);
      }
      const subjectKeys=input.subjectKeys??(protocolVersionId?[...new Set((await vcr.documents.roster(study)).map(item=>item.subjectKey))]:[]);
      const selectedPairs = protocolVersionId
        ? subjectKeys.map(subjectKey => ({ subjectKey, trialId: protocolVersionId }))
        : registryIds.map(trialId => ({ subjectKey: input.subjectKey??row?.payload.contextSubjectKey, trialId }));
      if (!selectedPairs.length || selectedPairs.length > 10000 || selectedPairs.some(pair => !pair.subjectKey) || new Set(selectedPairs.map(pairIdentity)).size !== selectedPairs.length) deny('patient_matching_selection_invalid');
      const subjectKey=input.subjectKey??row?.payload.contextSubjectKey,selectedIds=new Set(registryIds);
      const stageOrders=Object.fromEntries(Object.entries({incoming:searchReceipt?.rerank?.incomingOrder,rerank:searchReceipt?.rerank?.rerankOrder??searchReceipt?.rerank?.finalOrder,jev:searchReceipt?.rerank?.jev?.order,final:searchReceipt?.rerank?.rerankOrder?searchReceipt?.rerank?.finalOrder:undefined})
        .filter(([,ids])=>Array.isArray(ids)).map(([stage,ids])=>[stage,ids.filter(registryId=>selectedIds.has(registryId)).map(trialId=>pairIdentity({subjectKey,trialId}))]));
      const selection = { direction: protocolVersionId ? 'protocol-to-patients' : selectedPairs.length === 1 ? 'specified-pair' : 'patient-to-trials', selectedPairs,
        protocolVersionId: protocolVersionId ?? null, collection, collectionRevision,stageOrders };
      row = row ? await repository.put(scope, row.id, { ...row.payload, ...selection }, row.revision) : await newTask(origin, selectedPairs, selection);
    }
    const meta = row.payload;
    if (meta.state === 'cancelled') return response({ taskId: meta.taskId }, 'The matching task is cancelled; continue it explicitly to resume.', 'cancelled');
    if (meta.pluginGeneration !== origin.pluginGeneration) deny('patient_matching_generation_changed', 'This task belongs to a different admitted plugin generation.');
    const previous = input.phase === 'refresh' ? meta.executions.find(item => item.executionId === input.executionId) : null;
    if (input.phase === 'refresh' && !previous) deny('patient_matching_execution_not_found');
    if (previous && (previous.rootCallId !== origin.callId || (previous.epoch ?? 0) !== (meta.continuationEpoch ?? 0))) deny('patient_matching_execution_superseded');
    const saved = await rowsOf(meta, study), current = saved.length ? await resultOf(origin, meta.taskId) : null;
    const done = current ? attemptedPairs(meta,current,saved) : new Set();
    const laneOf = (/** @type {any} */ item) => item.lane ?? 0, ownLane = lane ?? 0, epoch = meta.continuationEpoch ?? 0;
    const busy = new Set(meta.executions.filter(item => item.state === 'prepared' && item.rootCallId === origin.callId && (item.epoch ?? 0) === epoch && laneOf(item) !== ownLane)
      .flatMap(item => item.pairs.map(pairIdentity)));
    // A lane that still holds an unsaved prepared execution is handed that execution again, never a second selection beside it.
    const heldByLane = previous ? null : meta.executions.find(item => item.rootCallId === origin.callId && item.state === 'prepared' && (item.epoch ?? 0) === epoch && laneOf(item) === ownLane) ?? null;
    let pairs = previous?.pairs ?? heldByLane?.pairs ?? meta.selectedPairs.filter(pair => !done.has(pairIdentity(pair)) && !busy.has(pairIdentity(pair))).slice(0, 100);
    if (!pairs.length && busy.size) return response({ kind: 'busy', taskId: meta.taskId }, 'Every remaining pair is being assessed by another lane of this call.');
    if (!pairs.length) return response({kind:'saved-result',result:await resultOf(origin,meta.taskId)}, 'All selected matching pairs have been saved.');
    if(!previous&&!heldByLane){
      // The structured child response has a token bound too. Partition work by source
      // clause count, never by a clinical label or a retrieval score.
      const selected=[],profiles=new Map();let clauses=0;
      for(const pair of pairs){
        if(!profiles.has(pair.trialId))profiles.set(pair.trialId,await trial(study,pair,meta,scope));
        const count=Math.max(1,profiles.get(pair.trialId).profile.criteria.length);
        if(selected.length&&clauses+count>24)break;
        selected.push(pair);clauses+=count;
      }
      pairs=selected;
    }
    let material = await materials(study, pairs, meta, scope,origin);
    if(!previous&&!heldByLane)while(pairs.length>1&&Buffer.byteLength(JSON.stringify({context:[...material.people.values()].map(person=>person.context),trialProfiles:[...material.trials.values()].map(item=>item.profile),evidenceBundles:material.bundles}))>6*1024*1024){
      pairs=pairs.slice(0,Math.max(1,Math.floor(pairs.length/2)));material=await materials(study,pairs,meta,scope,origin);
    }
    const task = taskOf(meta, pairs, material.sources);
    if (previous && (!same(task.sources, previous.sources) || previous.profileDigest !== profileDigest)) deny('patient_matching_source_changed', 'A preserved input changed during assessment; start a new assessment.');
    const execution = previous ?? { executionId: id('pm_exec'), pairs, sources: task.sources, profileDigest, state: 'prepared', rootCallId: origin.callId, epoch:meta.continuationEpoch??0, lane: ownLane };
    if (!previous) {
      const held = meta.executions.find(item => item.rootCallId === origin.callId && item.state === 'prepared' && (item.epoch??0)===(meta.continuationEpoch??0) && laneOf(item) === ownLane);
      if (held) { if (!same(held.sources, execution.sources)) deny('patient_matching_source_changed'); execution.executionId = held.executionId; }
      else await repository.put(scope, meta.taskId, { ...meta, executions: [...meta.executions, execution] }, row.revision);
    }
    return response({ kind:'prepared',task, context: [...material.people.values()].map(person => person.context), trialProfiles: [...material.trials.values()].map(item => item.profile), evidenceBundles: material.bundles,
      executionId: execution.executionId, profileDigest, outputSchema:patientMatchingOutputSchema({scope,profileDigest,executionId:execution.executionId,maxPairs:pairs.length,criterionIds:[...material.trials.values()].flatMap(item=>item.profile.criteria.map(criterion=>criterion.criterionId))}), reasoning, remaining: meta.selectedPairs.length - done.size });
  }
  function attemptedPairs(meta, projection, rows) {
    const failures = new Map(rows.filter(row => row.answer.failureCheckpoint).map(row => [row.answer.coreDecision.decisionId, row.answer.failureCheckpoint]));
    return new Set(projection.rows.filter(item => item.current || item.state === 'failed' && item.producer?.kind === 'runtime'
      && item.staleReasons.length === 0 && failures.get(item.decisionId)?.epoch === (meta.continuationEpoch ?? 0)).map(pairIdentity));
  }
  async function progress(origin, taskId) {
    const { meta, study, row } = await owned(origin, taskId);
    if (meta.state === 'cancelled') return { pending:false,taskId,revision:row.revision,continuationEpoch:meta.continuationEpoch??0,cursor:0,remaining:meta.selectedPairs.length,rootSessionId:origin.rootSessionId,state:'cancelled',jobId:taskId };
    const projection = await resultOf(origin, taskId), attempted = attemptedPairs(meta, projection, await rowsOf(meta, study));
    const withdrawn = await vcr.matchStore.withdrawnSubjects(study.id);
    const remaining = meta.selectedPairs.filter(pair => !attempted.has(pairIdentity(pair)) && !withdrawn.has(pair.subjectKey)).length;
    return { pending: remaining > 0, taskId, revision: row.revision,continuationEpoch:meta.continuationEpoch??0, cursor: meta.selectedPairs.length - remaining, remaining,
      rootSessionId: origin.rootSessionId, state: remaining ? 'pending' : projection.state, jobId: taskId };
  }
  async function commit(origin, input) {
    return vcr.store.transaction(client => vcr.store.database.withTransactionClient(client, async () => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`patient-matching-commit:${origin.userId}:${input.taskId}`]);
      return commitInside(origin, input);
    }));
  }
  async function commitInside(origin, input) {
    origin.signal?.throwIfAborted();
    const { meta, study, scope, row } = await owned(origin, input.taskId);
    if (meta.state === 'cancelled') return response({ taskId: meta.taskId }, 'Matching task was cancelled; previous results remain available.', 'cancelled');
    if (meta.pluginGeneration !== origin.pluginGeneration) deny('patient_matching_generation_changed');
    const execution = meta.executions.find(item => item.executionId === input.executionId);
    if (!execution || execution.profileDigest !== input.profileDigest || input.profileDigest !== profileDigest || execution.rootCallId !== origin.callId) deny('patient_matching_execution_mismatch');
    if (execution.state === 'committed') { const saved = await resultOf(origin,meta.taskId); return response({...saved,...(input.phase==='failure'&&execution.failureCount>0?{failureCheckpoint:{saved:true,executionId:execution.executionId}}:{})},'The native result was already saved.',saved.state==='complete'?'complete':saved.state==='failed'?'failed':'partial'); }
    if ((execution.epoch ?? 0) !== (meta.continuationEpoch ?? 0)) deny('patient_matching_execution_superseded');
    if (!['commit','failure'].includes(input.phase) || !input.native?.childId || !input.native?.messageId) deny('patient_matching_native_result_invalid');
    if (input.phase === 'failure' ? Object.hasOwn(input,'decisions') : !Array.isArray(input.decisions) || input.decisions.length > 1000) deny('patient_matching_native_result_invalid');
    // These are live host authorization/source checks, outside model-error isolation. A denial writes nothing.
    const material = await materials(study, execution.pairs, meta, scope,origin);
    if (!same(execution.sources, material.sources)) deny('patient_matching_source_changed');
    for (const person of material.people.values()) {
      const read = { documentIds: person.note.documentIds, snapshots: person.note.snapshots ?? [] };
      const permission = await vcr.documents.judgeReads?.(study, { id: origin.userId }, [read]);
      const refusal = await vcr.documents.recordStands?.(study, { subjectKey: person.context.subjectKey, documentIds: read.documentIds, snapshotIds: read.snapshots.map(item=>item.id) });
      if (!permission?.patientLevel || permission.permitted[0] !== true || refusal) deny('patient_matching_model_access_denied');
    }
    const task = taskOf(meta, execution.pairs, execution.sources), accepted = new Map(), resultId = id('pm_result'), rowIds = [...meta.rowIds];
    const diagnostics = (Array.isArray(input.diagnostics) ? input.diagnostics : []).filter(value=>typeof value==='string').slice(0,20).map(value=>value.slice(0,2000));
    const bundlesByPair = new Map(execution.pairs.map((pair,index)=>[pairIdentity(pair),material.bundles[index]]));
    for (const decision of input.phase === 'failure' ? [] : input.decisions) {
      try {
        const key = pairIdentity(decision), target = material.trials.get(decision.trialId), bundle = bundlesByPair.get(key);
        if (!bundle || decision.evidenceBundleId !== bundle.bundleId) throw new TypeError('Native decision evidence differs from its authorized pair');
        validatePairDecision(decision, { task, trialProfile: target?.profile, evidenceBundle: bundle });
        if (!target || !material.people.has(decision.subjectKey) || !bundle || decision.state !== 'complete' || decision.producer.kind !== 'model'
          || decision.producer.executionId !== execution.executionId || decision.producer.modelProfileDigest !== profileDigest || decision.profileDigest !== profileDigest) throw new TypeError('Native decision metadata does not match the authorized execution');
        if (decision.sourceRefs.some(source=>!bundle.sources.some(bound=>same(bound,source)))) throw new TypeError('Native decision cited an unbound source');
        if (!accepted.has(key)) accepted.set(key, decision);
        else diagnostics.push('duplicate_native_decision');
      } catch (error) {
        // Only validation of the untrusted model value happens here. No host I/O or permission checks are caught.
        if (!(error instanceof TypeError)) throw error;
        diagnostics.push(String(Reflect.get(error,'code') ?? 'invalid_native_decision'));
      }
    }
    let failureCount = 0;
    for (const [pairIndex,pair] of execution.pairs.entries()) {
      origin.signal?.throwIfAborted();
      const target = material.trials.get(pair.trialId), person = material.people.get(pair.subjectKey);
      const bundle = material.bundles[pairIndex];
      if (!bundle) deny('patient_matching_evidence_unavailable');
      const decision = accepted.get(pairIdentity(pair)) ?? { schemaVersion:'1',decisionId:`failure:${execution.executionId}:${profileIdentity(pair).slice(7,31)}`,revision:'1',scope,...pair,
        state:'failed',clinicalEligibility:'not-assessed',recommendation:{priority:null,rationale:''},criteria:[],sourceRefs:bundle.sources,profileDigest,
        producer:{kind:'runtime',modelProfileDigest:profileDigest,executionId:execution.executionId},evidenceBundleId:bundle.bundleId,unresolvedFacts:[],assumptions:[] };
      validatePairDecision(decision,{task,trialProfile:target.profile,evidenceBundle:bundle});
      const failed = decision.producer.kind === 'runtime'; if (failed) failureCount++;
      const legacyRows = decision.criteria.map(criterion => ({ number: target.profile.criteria.findIndex(item => item.criterionId === criterion.criterionId) + 1, kind: criterion.kind,
        label: criterion.verdict === 'unknown' ? 'not_enough_information' : criterion.verdict === 'not-applicable' ? 'not_applicable' : criterion.kind === 'inclusion' ? criterion.verdict === 'satisfied' ? 'included' : 'not_included' : criterion.verdict === 'satisfied' ? 'excluded' : 'not_excluded',
        basis: criterion.basis, reason: criterion.reason, evidence: criterion.evidenceIds.map(evidenceId => {
          const passage = bundle.patientPassages.find(item => item.evidenceId === evidenceId);
          const sentence = passage && person.note.sentences.find(item => item.text === passage.text && item.start === passage.span.start);
          return sentence ? { sentenceId: sentence.id, text: sentence.text, documentId: sentence.documentId } : null;
        }).filter(Boolean) }));
      const saved = await vcr.matchJudgments.save({ studyId: study.id, userId: study.userId, subjectKey: decision.subjectKey,
        targetKind: target.target.kind, targetId: target.target.id, targetHash: target.target.hash, documentHash: person.note.hash,
        mode: 'criteria', promptVersion: `patient-matching-v1:${execution.executionId}`, producer: 'conversation', model: failed ? 'runtime' : reasoning.model, thinking: failed ? '' : reasoning.reasoningEffort,
        status: failed ? 'failed' : 'done', errorCode: failed ? 'patient_matching_native_decision_failed' : null, documentIds: person.note.documentIds, liveDocuments: true,
        fit: decision.recommendation.priority === null ? null : Math.round(decision.recommendation.priority * 100),
        verdict: failed ? null : decision.clinicalEligibility === 'uncertain' || decision.clinicalEligibility === 'not-assessed' ? 'insufficient' : decision.clinicalEligibility,
        answer: { target: target.target.summaryOfTarget, eligibilitySource: target.target.eligibilitySource, rows: legacyRows, missing: [],
          matchingTaskId: meta.taskId, matchingInputIndex:meta.selectedPairs.findIndex(item=>pairIdentity(item)===pairIdentity(pair)), resultId, coreDecision: decision, matchingProjection: nativeDecisionProjection(decision, meta.taskId),
          ...(failed ? { failureCheckpoint:{epoch:execution.epoch??0,executionId:execution.executionId,diagnostics:diagnostics.slice(0,20)} } : {}),
          computations:failed?[]:bundle.computations, knowledgePassages:bundle.knowledgePassages,native: input.native,
          modelProfile: failed ? {digest:profileDigest} : { ...reasoning, digest: profileDigest }, readFrom: { snapshots: person.note.snapshots }, reasons: { rationale: decision.recommendation.rationale, eligible: [], ineligible: [], missing: decision.unresolvedFacts } } });
      if (!saved) deny('patient_matching_source_withdrawn');
      rowIds.push(saved.id);
    }
    origin.signal?.throwIfAborted();
    const resultRevision = (meta.resultRevision ?? 0) + 1;
    await repository.put(scope, meta.taskId, { ...meta, rowIds:[...new Set(rowIds)],resultId,resultRevision,
      results:[...(meta.results??[]),{resultId,revision:resultRevision,rowIds:[...new Set(rowIds)]}],
      executions:meta.executions.map(item=>item.executionId===execution.executionId?{...item,state:'committed',resultId,failureCount}:item) },row.revision);
    const result = await resultOf(origin,meta.taskId), remaining = await progress(origin,meta.taskId);
    if (onPending && remaining.pending) await onPending(origin,meta.taskId);
    return response({ ...result,...(input.phase==='failure'?{failureCheckpoint:{saved:true,executionId:execution.executionId}}:{}) },
      failureCount ? 'Validated results and non-clinical failed attempts were saved.' : 'Native matching decisions were saved.', result.state==='complete'?'complete':result.state==='failed'?'failed':'partial');
  }
  /** @param {{port:string,operation:string,input?:any,origin:any}} request */
  async function dispatch({ port, operation, input = {}, origin }) {
    const scope = patientMatchingScope(origin);
    if (input.scope) assertScope(scope, input.scope);
    if (port === 'IdentityPort') return operation === 'resolve' ? scope : { allowed: true, scope };
    if (port === 'PatientDataPort' && operation === 'context') {
      const study = await studyFor(origin, true);
      if (input.patientText) deny('patient_matching_original_required', 'Select the original authenticated user message or owned source.');
      if(input.protocolText){
        if(!vcr.patientContext.original)deny('patient_matching_original_required');
        const original=await vcr.patientContext.original(origin,{...(input.messageSeq!=null?{messageSeq:input.messageSeq}:{}),...(input.sourceId?{sourceId:input.sourceId}:{})});
        if(!original.text.includes(input.protocolText))deny('patient_matching_original_mismatch','Protocol text must be an exact passage of the selected original input.');
        const clauses=segmentCriteria(input.protocolText);
        if(!clauses.length)throw new HttpError(400,'patient_matching_protocol_empty','The selected protocol passage contains no eligibility clauses.');
        const sourceRef=`native-original:${profileIdentity({original:original.provenance,text:input.protocolText}).slice(7)}`;
        const existingTask=input.taskId?(await owned(origin,input.taskId)).row:null;
        if(existingTask?.payload.selectedPairs.length){
          if(!existingTask.payload.protocolVersionId)deny('patient_matching_task_frozen','A selected registry task keeps its frozen targets; start a new task for a protocol.');
          const bound=(await vcr.matchStore.protocols(study.id,existingTask.payload.protocolVersionId))[0];
          if(bound?.sourceRef!==sourceRef)deny('patient_matching_task_frozen','A selected task keeps its frozen protocol; start a new task for another protocol.');
        }
        const version=await vcr.store.transaction(client=>vcr.store.database.withTransactionClient(client,async()=>{
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`vcr-protocol:${study.id}`]);
          const existing=(await vcr.matchStore.protocols(study.id)).find(row=>row.sourceRef===sourceRef);
          if(existing)return existing;
          return vcr.matchStore.saveProtocolVersion({studyId:study.id,userId:study.userId,title:input.title??'Eligibility protocol',sourceRef,
            usdm:{originalEligibilityText:input.protocolText,originalEligibilityProvenance:original.provenance},
            criteria:clauses.map(clause=>({kind:clause.kind==='unsectioned'?'unclassified':clause.kind,sourceText:clause.text,sourceLocator:{start:clause.start,end:clause.end,sectionKind:clause.kind}}))});
        }));
        const taskRow=existingTask?(existingTask.payload.selectedPairs.length?existingTask:await repository.put(scope,existingTask.id,{...existingTask.payload,direction:'protocol-to-patients',protocolVersionId:version.id},existingTask.revision)):await newTask(origin,[],{direction:'protocol-to-patients',protocolVersionId:version.id});
        return response({taskId:taskRow.id,jobId:taskRow.id,protocolVersionId:version.id,clauses:{inclusion:clauses.filter(row=>row.kind==='inclusion').length,exclusion:clauses.filter(row=>row.kind==='exclusion').length,unclassified:clauses.filter(row=>row.kind==='unsectioned').length},inputs:await vcr.patientContext.candidates(origin,{},study)});
      }
      const taken = input.messageSeq != null || input.sourceId ? await vcr.patientContext(study, { ...(input.messageSeq != null ? { messageSeq: input.messageSeq } : {}), ...(input.sourceId ? { sourceId: input.sourceId } : {}), ...(input.subjectKey ? { subjectKey: input.subjectKey } : {}) }, origin) : null;
      const subjectKey = taken?.subjectKey ?? input.subjectKey;
      const selectedPairs = subjectKey ? (input.trialIds ?? []).map(trialId => ({ subjectKey, trialId })) : [];
      const taskRow = input.taskId ? (await owned(origin, input.taskId)).row : await newTask(origin, selectedPairs, { contextSubjectKey:subjectKey ?? null, direction: selectedPairs.length === 1 ? 'specified-pair' : input.direction ?? 'patient-to-trials' });
      return response({ ...(taken ?? {}), taskId: taskRow.id, jobId: taskRow.id, inputs: await vcr.patientContext.candidates(origin, {}, study) });
    }
    if (port === 'ExecutionPort' && operation === 'assess') return prepare(origin, input);
    if (port === 'ResultPort' && operation === 'save') return commit(origin, input);
    const context = await owned(origin, input.taskId);
    const { meta, study } = context;
    if (meta.state === 'cancelled' && !['get','history','report','cancel','continue'].includes(operation)) return response({taskId:meta.taskId},'The matching task is cancelled.','cancelled');
    if (port === 'ResultPort') {
      if (operation === 'get') return response(await resultOf(origin, input.taskId, input.resultId));
      if (operation === 'history') return response({ revisions: await Promise.all([...new Set((await rowsOf(meta, study)).map(row => row.answer.resultId))].map(resultId => resultOf(origin, meta.taskId, resultId))) });
    }
    if (port === 'PatientDataPort' && operation === 'correct') {
      // The current tool's model-written correction is a pointer, not an authenticated patient fact.
      const candidates = await vcr.patientContext.candidates(origin, {}, study);
      const messageSeq = candidates.candidates?.[0]?.messageSeq;
      if (!messageSeq || !input.subjectKey || !meta.selectedPairs.some(pair => pair.subjectKey === input.subjectKey)) deny('patient_matching_original_required');
      const updated = await vcr.patientContext(study, { messageSeq, subjectKey: input.subjectKey }, origin);
      return response({ ...updated, reassessment: { taskId: meta.taskId, subjectKey: input.subjectKey, required: true } });
    }
    if (port === 'RegistryPort') {
      if (operation === 'search') {
        const subjectKey=meta.contextSubjectKey ?? meta.selectedPairs[0]?.subjectKey;
        const person=subjectKey?await patient(study,subjectKey,scope):null;
        if(discover)return discover({scope,origin,study,meta,input,patient:person});
        return response(await vcr.service.runtimeRead(study, 'candidates', { condition: input.query, ...(subjectKey?{subjectKey}:{}), limit: input.limit ?? 20 }, { ownerView: true }));
      }
      if (operation === 'read') {
        if (!meta.selectedPairs.some(pair => pair.trialId === input.registryId)) deny();
        return response((await trial(study, { trialId: input.registryId }, meta, scope)).profile);
      }
    }
    if (port === 'PatientDataPort' && operation === 'read' || port === 'KnowledgePort') {
      const pairs = meta.selectedPairs.filter(pair => !input.subjectKey || pair.subjectKey === input.subjectKey);
      if (input.subjectKey && !pairs.length) deny();
      if (port === 'KnowledgePort' && input.source !== 'patient' && knowledge) {
        const result=await knowledge({...context,origin,input,operation});validateToolResponse(result);
        const passages=result.data?.passages??[];
        validateEvidenceBundle({schemaVersion:'1',scope,bundleId:`knowledge:${meta.taskId}`,sources:uniqSources(passages.map(passage=>passage.source)),patientPassages:[],knowledgePassages:passages,limitations:result.data?.limitations??[]});
        if(passages.length){if(typeof knowledge.refresh!=='function')deny('patient_matching_knowledge_unavailable');await knowledge.refresh({origin,scope,passages});}
        for(const passage of passages)ledger(meta.taskId).knowledgePassages.set(passage.evidenceId,passage);
        return result;
      }
      if (port === 'KnowledgePort' && input.source !== 'patient') return unsupported('knowledge');
      const material = await materials(study, pairs.slice(0, 100), meta, scope,origin);
      let passages = [...material.people.values()].flatMap(person=>person.passages);
      passages = [...new Map(passages.map(passage => [passage.evidenceId, passage])).values()].filter(passage => (!input.evidenceId || passage.evidenceId === input.evidenceId) && (!input.sourceId || passage.source.sourceId === input.sourceId));
      if (input.query) passages.sort((a, b) => Number(b.text.toLowerCase().includes(input.query.toLowerCase())) - Number(a.text.toLowerCase().includes(input.query.toLowerCase())));
      const selected=passages.slice(0,input.limit??20),held=ledger(meta.taskId);
      for(const passage of selected)held.evidenceIds.add(passage.evidenceId);
      return response({ passages:selected });
    }
    if (port === 'ExecutionPort' && operation === 'compute') {
      if (!meta.selectedPairs.some(pair => pair.subjectKey === input.subjectKey)) deny();
      const person = await patient(study, input.subjectKey, scope), operands = [];
      for (const operand of input.operands ?? []) {
        const passage = person.passages.find(item => item.evidenceId === operand.evidenceId);
        if (!passage) deny('patient_matching_operand_source_mismatch');
        operands.push({ ...operand, source: passage.source });
      }
      const calculated = await calculate({ action: 'compute', id: input.calculatorId, inputs: Object.fromEntries(operands.map(operand => [operand.name, { value: operand.value, unit: operand.unit }])) },{signal:origin.signal});
      const library=await calculatorLibraryIdentity(),cacheIdentity=profileIdentity({scope,sources:person.sources,calculator:library,calculatorId:input.calculatorId,operands,profileDigest});
      const complete=calculated.status==='success'&&calculated.data?.result&&['number','boolean'].includes(typeof calculated.data.result.value);
      const receipt={schemaVersion:'1',scope,receiptId:`computation:${cacheIdentity.slice(7)}`,calculator:{id:input.calculatorId,...library},state:complete?'complete':'missing',operands,
        missingInputs:complete?[]:(calculated.data?.missing??[]).map(item=>typeof item==='string'?item:String(item.name??item.item??'input')),exactCheck:complete?'verified':'not-run',cacheIdentity,
        result:complete?{value:calculated.data.result.value,unit:calculated.data.result.unit}:null};
      validateComputationReceipt(receipt);
      ledger(meta.taskId).computations.set(receipt.receiptId,{subjectKey:input.subjectKey,receipt});
      return response({ ...calculated, receipt }, 'The registered clinical calculator returned its result.',complete?'complete':'partial');
    }
    if (port === 'ExecutionPort' && operation === 'report') {
      const result = await resultOf(origin, meta.taskId, input.resultId);
      if (writeArtifact) return writeArtifact({ origin, study, result, format: input.format ?? 'markdown' });
      const format = input.format ?? 'markdown', rendered = renderPatientMatchingReport(result, format);
      const artifact = `/api/vcr/studies/${encodeURIComponent(study.id)}/matching/native/${encodeURIComponent(meta.taskId)}/reports/${encodeURIComponent(input.resultId)}.${rendered.extension}`;
      const artifactId=`matching-report:${meta.taskId}:${input.resultId}:${rendered.extension}`;
      return response({ resultId: result.resultId, revision: result.revision, format, artifactId,artifact, filename: `matching-${result.resultId}.${rendered.extension}` }, 'The report is available from its authenticated saved-result resource.', 'complete', [artifactId]);
    }
    if (port === 'JobPort' || port === 'ExecutionPort' && operation === 'cancel') {
      if (input.jobId && input.jobId !== meta.taskId) deny();
      if (operation === 'cancel' || operation === 'continue') await repository.put(scope, meta.taskId, { ...meta, state: operation === 'cancel' ? 'cancelled' : 'pending',continuationEpoch:(meta.continuationEpoch??0)+(operation==='continue'?1:0) }, context.row.revision);
      if(operation==='cancel')evidenceLedgers.delete(meta.taskId);
      let cancelNotice = null;
      if(operation==='cancel'&&onCancel){
        try{await onCancel(origin,meta.taskId);}
        catch{cancelNotice={code:'patient_matching_runtime_cancel_unconfirmed',message:'Cancellation was saved; stopping the active assessment could not be confirmed.'};}
      }
      if (operation === 'continue' && onPending) await onPending(origin, meta.taskId);
      const result = await resultOf(origin, meta.taskId), advancement = await progress(origin,meta.taskId);
      return response({ taskId: meta.taskId, jobId: meta.taskId, state: operation === 'cancel' ? 'cancelled' : advancement.state, result, ...(cancelNotice?{notices:[cancelNotice]}:{}), next: advancement.pending ? { tool: 'match_assess', arguments: { taskId: meta.taskId } } : null }, cancelNotice?cancelNotice.message:'Matching progress is preserved.', operation === 'cancel' ? 'cancelled' : advancement.pending ? 'pending' : result.state === 'complete' ? 'complete' : result.state === 'failed' ? 'failed' : 'partial');
    }
    if (port === 'ModelPort' && modelPorts?.[operation]) return modelPorts[operation]({ scope, input, origin, signal:origin.signal });
    if (port === 'IndexPort' && indexPorts?.[operation]) return indexPorts[operation]({ scope, input, origin, signal:origin.signal });
    if (port === 'ExtensionPort') return response({ abi: HOST_ABI, generation: origin.pluginGeneration, reasoning, optionalResources: { model: Boolean(modelPorts), index: Boolean(indexPorts), knowledge: Boolean(knowledge) } });
    return unsupported(`${port}.${operation}`);
  }
  return { abi: HOST_ABI, dispatch, repository, resultOf, profileDigest, reasoning,
    async startSelection(origin, selection) {
      const study = await studyFor(origin, true);
      let resolved = selection;
      if (selection.searchId) {
        const saved = await vcr.candidateSearches.resolveSelection(study, selection.searchId, selection.candidateLimit);
        if (!saved) deny('patient_matching_search_not_found');
        const { searchId: _searchId, candidateLimit: _limit, ...rest } = selection;
        resolved = { ...rest, registryIds: saved.registryIds, ...(saved.collection ? { collection: saved.collection, collectionRevision: saved.collectionRevision } : {}) };
      }
      const built = await planMatchJudge({ study, selection: resolved, matchStore: vcr.matchStore, documents: vcr.documents, subjectTable: vcr.subjectTable, config });
      if (built.ok !== true) throw new HttpError(409, 'vcr_match_judge_nothing_to_read', built.message);
      const scenario = built.scenario;
      const selectedPairs = scenario.protocolVersionId ? scenario.subjects.map(subjectKey => ({ subjectKey, trialId: scenario.protocolVersionId }))
        : scenario.subjects.flatMap(subjectKey => scenario.trials.map(target => ({ subjectKey, trialId: target.registryId })));
      const row = await newTask(origin, selectedPairs, { direction: scenario.protocolVersionId ? 'protocol-to-patients' : selectedPairs.length === 1 ? 'specified-pair' : 'patient-to-trials',
        protocolVersionId: scenario.protocolVersionId ?? null, collection: scenario.collection ?? null, collectionRevision: scenario.collectionRevision ?? null });
      if (onPending) await onPending(origin, row.id);
      return { action: 'start', kind: 'match_judge', jobId: row.id, taskId: row.id, state: 'queued', direction: scenario.direction,
        statement: 'Matching is queued in this conversation; validated partial results remain available as assessment proceeds.' };
    },
    async pageResult(study, actorId, taskId, resultId = null) {
      const origin = { userId: actorId, projectId: study.projectId, rootSessionId: study.conversationSessionId, runId: 'matching-report-read' };
      const { meta } = await owned(origin, taskId);
      return resultOf({ ...origin, runId: meta.origin?.runId ?? origin.runId }, taskId, resultId);
    },
    pending: progress,
    async authorizeModel(envelope) {
      const {study,meta,scope}=await owned(envelope.origin,envelope.input.taskId);
      if(meta.state==='cancelled')deny('patient_matching_task_cancelled');assertScope(scope,envelope.scope);
      const people=meta.contextSubjectKey?[await patient(study,meta.contextSubjectKey,scope)]:[...(await materials(study,meta.selectedPairs.slice(0,100),meta,scope,envelope.origin)).people.values()];
      for(const person of people){
        const record={documentIds:person.note.documentIds,snapshots:person.note.snapshots??[]};
        const allowed=await vcr.documents.judgeReads?.(study,{id:envelope.origin.userId},[record]);
        const refusal=await vcr.documents.recordStands?.(study,{subjectKey:person.context.subjectKey,documentIds:record.documentIds,snapshotIds:record.snapshots.map(item=>item.id)});
        if(!allowed?.patientLevel||allowed.permitted[0]!==true||refusal)deny('patient_matching_model_access_denied','Current patient-source permissions do not authorize this model request.');
      }
      const current=uniqSources(people.flatMap(person=>person.sources)).sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
      const requested=envelope.input.patientSources;
      if(current.length||requested!==undefined){
        if(!Array.isArray(requested)||!same([...requested].sort((a,b)=>String(a?.sourceId).localeCompare(String(b?.sourceId))),current))deny('patient_matching_model_sources_changed','The model request must name exactly the current authorized patient sources.');
      }
      return {userId:envelope.origin.userId,projectId:envelope.origin.projectId,runId:envelope.origin.runId};
    } };
}
