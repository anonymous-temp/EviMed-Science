/** Event-history research inside VCR: the existing plane, queue, permissions and
 * DeepSeek/DSH tools. No second agent or locally deployed prediction model. */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  vcrResultOutputPayload, eventsFromMappedTable, replayClinicalEvents, longitudinalReadiness,
  validateForecast, validateLongitudinalScenario, VCR_LONGITUDINAL_JOBS, VCR_LONGITUDINAL_LIMITS, VCR_LONGITUDINAL_SCHEMAS,
  compareForecasts, forecastDesignInputs, longitudinalSubjects, strictestDataClass, VCR_MIN_CELL_SIZE,
} from '@evimed/domain';
import { parseTable, studyPseudonymKey, pseudonymOf } from './vcrDataPlane.mjs';
import { VcrLongitudinalStore, longitudinalHash, longitudinalArtifactView } from './vcrLongitudinalStore.mjs';
import { createForecastProviders } from './vcrForecastProvider.mjs';
import { HttpError } from './security.mjs';
import { runForecastCalculation } from './vcrForecastCalculation.mjs';
import { actionContext, loggedActionSchedule, reasonCounts, reconcileSubjects, trajectoryPremises, uncertaintyProvenance } from './vcrTrajectoryBatch.mjs';
const forecastCandidates = JSON.parse(readFileSync(new URL('../../../packages/contracts/healthflux/candidates.json',import.meta.url),'utf8'));

/** @param {string} code @param {string} message */
const invalid = (code,message) => new HttpError(422,code,message);
/** @param {unknown} value @returns {Record<string,any>} */
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** @param {any} study @param {any} input @param {any[]} events */
export function frozenHistorySplit(study,input,events) {
  if (!input) return null;
  const mode = input.mode ?? 'patient', seed = String(input.seed ?? 'vcr-1');
  if (!['patient','site','temporal'].includes(mode)) throw invalid('vcr_split_invalid','Use patient, site or temporal splitting.');
  /** @type {Record<string,string>} */ const assignments = {};
  /** @type {Map<string,any[]>} */ const bySubject = new Map();
  for (const event of events) {if (!bySubject.has(event.subjectKey)) bySubject.set(event.subjectKey,[]);bySubject.get(event.subjectKey)?.push(event);}
  for (const [subject,own] of bySubject) {
    const hash = longitudinalHash({studyId:study.id,subject,seed});
    const fraction = Number.parseInt(hash.slice(0,8),16)/0x100000000;
    let role = fraction < .6 ? 'train' : fraction < .8 ? 'calibration' : 'test';
    if (mode === 'site') {
      const sites = [...new Set(own.map(e => e.site).filter(Boolean))];
      role = sites.length !== 1 ? 'unknown' : input.testSites?.includes(sites[0]) ? 'test'
        : input.calibrationSites?.includes(sites[0]) ? 'calibration' : 'train';
    }
    if (mode === 'temporal') {
      const first = own.map(e => e.occurredAt).filter(Boolean).sort()[0];
      if (!input.testFrom || !input.calibrationFrom || !Number.isFinite(Date.parse(input.testFrom))
        || !Number.isFinite(Date.parse(input.calibrationFrom)) || Date.parse(input.testFrom) <= Date.parse(input.calibrationFrom)) throw invalid('vcr_split_invalid','Temporal splitting requires ordered calibrationFrom and testFrom dates.');
      role = !first ? 'unknown' : Date.parse(first) >= Date.parse(input.testFrom) ? 'test' : Date.parse(first) >= Date.parse(input.calibrationFrom) ? 'calibration' : 'train';
    }
    assignments[subject] = role;
  }
  return {schema:1,mode,seed,rule:input,assignments,hash:longitudinalHash(assignments),
    counts:Object.fromEntries(['train','calibration','test','unknown'].map(role => [role,Object.values(assignments).filter(r => r === role).length]))};
}

/** What the accuracy of an evaluation or a comparison of these predictions is the accuracy of: a forecast's, or, when any of them
 * replayed actions recorded after its origin, a logged-action replay's, which no reader may take for forecast accuracy (review stats
 * P1-6). The weakest context is carried, with each prediction's own. @param {any[]} predictions saved prediction artifacts */
function accuracyOf(predictions) {
  const contexts = predictions.map(held => held.row.summary?.actionContext ?? held.content?.actionContext ?? null);
  const replay = contexts.find(context => context && context.deployable === false) ?? null;
  return {actionContext:replay ?? contexts[0] ?? {mode:'factual_forecast',actionSource:'none',deployable:true,label:'factual_forecast'},
    actionContexts:contexts,accuracyKind:replay ? 'logged_action_replay' : 'forecast'};
}

/** The lineage of an artifact made from several saved ones: every snapshot, source and binding of each, so a grant withdrawn from any
 * of them reaches it (review eng P0-4). @param {any[]} rows @param {string | null} parentId */
function lineageOf(rows,parentId) {
  return {snapshotIds:[...new Set(rows.flatMap(row => row.snapshot_ids ?? []))],sourceIds:[...new Set(rows.flatMap(row => row.source_ids ?? []))],
    bindings:rows.flatMap(row => row.bindings ?? []),parentId};
}

/** @param {any} input */
export function createVcrLongitudinal({store,dataStore,dataPlane,matchStore,access,jobs,config = {},fetchImpl,now = () => new Date()}) {
  if (!dataPlane) return null;
  const artifacts = new VcrLongitudinalStore({store,plane:dataPlane,access});
  // every list, report model and run read of an artifact goes through the store's index; this is the lineage judgement it applies
  store.longitudinalGuard = async (/** @type {string} */ studyId,/** @type {any[]} */ rows,/** @type {string | null | undefined} */ actor) => {
    const study = await store.studyById(studyId);
    return study ? artifacts.permitted(study,rows,actor) : new Set();
  };
  const providers = createForecastProviders({file:config.vcrForecastProvidersFile,fetchImpl,now});
  /** @param {any} study @param {string} actor @param {string} ability */
  const authorize = (study,actor,ability) => access.require({studyId:study.id,actor,ability,purpose:'vcr',note:'longitudinal research'});
  /** @param {any} study @param {any} input @param {string} actor */
  async function freezeHistory(study,input,actor) {
    await authorize(study,actor,'run');
    const resolved = await dataPlane.resolveSnapshotInputs({studyId:study.id,snapshotId:input.snapshotId,
      principal:actor,purpose:'vcr',include:['files']});
    const profile = await dataPlane.snapshotProfileForModel({studyId:study.id,snapshotId:input.snapshotId,principal:actor});
    const source = await dataStore.sourceInStudy(study.id,profile.sourceId);
    const mappings = Array.isArray(input.mappings) ? input.mappings : [];
    if (!mappings.length || mappings.length > 500) throw invalid('vcr_history_mapping_missing','Map at least one event type from the granted snapshot.');
    /** @type {any[]} */ const events = [], issues = [];
    const factSources = new Set();
    for (const mapping of mappings) {
      const file = resolved.inputs.find((/** @type {any} */ entry) => entry.id === mapping.inputId);
      if (!file) { issues.push({code:'mapped_input_unavailable',inputId:mapping.inputId});continue; }
      const sourceFile = profile.files.find((/** @type {any} */ entry) => entry.inputId === mapping.inputId);
      const declaredSubject = profile.fieldMap.some((/** @type {any} */ field) => field.role === 'subject_key'
        && field.column === mapping.subjectColumn && field.table === sourceFile?.name);
      if (mapping.subjectColumn !== 'USUBJID' && !declaredSubject) throw invalid('vcr_history_subject_mapping','Use USUBJID or the source column declared as this table\'s subject key.');
      const bytes = await fs.readFile(dataPlane.resolve(file.location));
      if (createHash('sha256').update(bytes).digest('hex') !== file.hash) throw invalid('vcr_history_input_changed','Snapshot bytes differ from their recorded hash.');
      const converted = eventsFromMappedTable(parseTable(bytes.toString('utf8')),{...mapping,subjectColumn:'USUBJID'},{inputId:file.id,inputHash:file.hash,
        valueSource:profile.fieldMap.find((/** @type {any} */ f) => f.table === sourceFile?.name && (f.alias ?? f.column) === mapping.valueColumn)?.valueSource ?? profile.valueSource,ingestedAt:profile.frozenAt});
      events.push(...converted.events.map(event => ({...event,source:{...event.source,inputNamespace:`${profile.sourceId}:${mapping.namespace ?? mapping.inputId.split(':').at(-1)}`}})));
      issues.push(...converted.issues);
      if (events.length > VCR_LONGITUDINAL_LIMITS.events) throw invalid('vcr_history_too_large','This history exceeds the bounded job size; select a smaller snapshot.');
    }
    if (input.includeClinicalFacts === true && matchStore) {
      const subjects = new Set(events.map(e => e.subjectKey));
      for (const fact of await matchStore.listFacts({studyId:study.id,visibleBy:input.asOf})) {
        if (!subjects.has(fact.subjectKey) || !fact.clinical || !fact.source?.documentId) continue;
        try {
          const projection = await dataStore.documentProjection(study.id,fact.source.documentId);
          const document = projection ? await dataPlane.projectionText({studyId:study.id,documentId:fact.source.documentId,principal:actor})
            : await dataPlane.documentText({studyId:study.id,documentId:fact.source.documentId,principal:actor});
          if (document.subjectKey !== fact.subjectKey || document.text.slice(fact.source.start,fact.source.end) !== fact.source.quote) {
            issues.push({code:'clinical_fact_source_changed'});continue;
          }
          const original = await dataStore.getSourceFile(study.id,projection?.document_id ?? fact.source.documentId);
          if (!original) continue;
          factSources.add(original.sourceId);
          events.push({subjectKey:fact.subjectKey,code:fact.variable,kind:fact.clinical.medication ? 'medication' : 'clinical_fact',
            value:Number.isFinite(fact.value) ? fact.value : null,originalValue:fact.value,unit:fact.unit ?? null,originalUnit:fact.unit ?? null,
            valueSource:'extracted',occurredAt:fact.occurredAt,recordedAt:fact.recordedAt,availableAt:fact.visibleAt,
            ingestedAt:fact.createdAt,availabilityBasis:'platform_visible',sourceEventId:fact.id,revision:null,
            assertion:fact.clinical.assertion,experiencer:fact.clinical.experiencer,medicationState:fact.clinical.medication?.state ?? 'unknown',
            source:fact.source,clinical:fact.clinical,transformation:{kind:'source_anchored_clinical_fact',version:fact.clinical.schema ?? 1}});
        } catch {issues.push({code:'clinical_fact_source_unavailable'});}
      }
    }
    const prior = input.priorHistoryId ? await artifacts.read(study,input.priorHistoryId,actor) : null;
    if (prior && prior.row.kind !== 'history') throw invalid('vcr_history_required','The preceding record must be a history.');
    const replay = replayClinicalEvents([...(prior?.content.evaluationEvents ?? prior?.content.events ?? []),...events],input.asOf);
    const perturbation = input.perturbation ?? null;
    if (perturbation && (Object.keys(perturbation).some(k => !['omitCodes','omitModalities','historyFrom'].includes(k))
      || perturbation.omitCodes && !Array.isArray(perturbation.omitCodes)
      || perturbation.omitModalities && !Array.isArray(perturbation.omitModalities)
      || perturbation.historyFrom && !Number.isFinite(Date.parse(perturbation.historyFrom)))) throw invalid('vcr_history_perturbation_invalid','Use omitted codes or a dated history window.');
    const selectedEvents = replay.events.filter(e => !perturbation?.omitCodes?.includes(e.code)
      && !perturbation?.omitModalities?.includes(e.modality ?? 'unspecified')
      && (!perturbation?.historyFrom || Date.parse(e.occurredAt) >= Date.parse(perturbation.historyFrom)));
    const subjects = [...new Set([...(prior ? longitudinalSubjects(prior.content) : []),...replay.events.map(e => e.subjectKey)])].sort();
    const content = {schema:1,snapshotId:input.snapshotId,snapshotHash:profile.sha256,sourceId:profile.sourceId,
      asOf:replay.asOf,mappings,events:selectedEvents,subjects,coverage:replay.coverage,issues:[...issues,...replay.issues],perturbation,
      // Protected evaluation context keeps cohort membership independent of
      // model input ablation. Provider projection reads only selected events.
      ...(perturbation ? {evaluationEvents:replay.events} : {}),
      dataClass:source?.valueSource === 'synthetic' && (!prior || prior.content.dataClass === 'synthetic') && !factSources.size
        ? 'synthetic' : 'patient',
      split:frozenHistorySplit(study,prior?.content.split?.rule ?? input.split,replay.events),priorHistoryId:input.priorHistoryId ?? null};
    if (prior?.content.split && content.split) {
      content.split.assignments = {...content.split.assignments,...prior.content.split.assignments};
      content.split.hash = longitudinalHash(content.split.assignments);
      content.split.counts = Object.fromEntries(['train','calibration','test','unknown'].map(role => [role,Object.values(content.split.assignments).filter(r => r === role).length]));
    }
    const summary = {...longitudinalReadiness(selectedEvents,replay.coverage,subjects),origin:replay.asOf,dataClass:content.dataClass,
      priorHistoryId:input.priorHistoryId ?? null,
      perturbation,excludedByPerturbation:replay.events.length-selectedEvents.length,
      split:content.split ? {mode:content.split.mode,hash:content.split.hash,counts:content.split.counts} : null,issues:content.issues};
    const fields = [...new Set(mappings.flatMap((/** @type {any} */ mapping) => Object.entries(mapping)
      .filter(([key]) => key.endsWith('Column') && key !== 'subjectColumn').map(([,value]) => {
        const entry = profile.fieldMap.find((/** @type {any} */ field) => field.alias === value || field.column === value);
        return entry?.column ?? value;
      })))];
    const saved = await artifacts.save(study,'history',content,summary,{snapshotIds:[...new Set([...(prior?.row.snapshot_ids ?? []),input.snapshotId])],
      sourceIds:[...new Set([...(prior?.row.source_ids ?? []),profile.sourceId,...factSources])],parentId:input.priorHistoryId,
      bindings:[...(prior?.row.bindings ?? []),{snapshotId:input.snapshotId,fields}]});
    return longitudinalArtifactView(saved);
  }
  /** @param {any} study @param {any} input @param {string} actor @param {any} [provenance] @returns {Promise<any>} */
  async function importPrediction(study,input,actor,provenance = {}) {
    await authorize(study,actor,'run');
    const history = await artifacts.read(study,input.historyId,actor);
    if (history.row.kind !== 'history') throw invalid('vcr_history_required','Select a frozen history.');
    if (Object.hasOwn(input,'predictions')) {
      if (!Array.isArray(input.predictions) || !input.predictions.length || input.predictions.length > 32
        || input.predictions.reduce((n,p) => n+(Array.isArray(p?.rows) ? p.rows.length : 0),0) > VCR_LONGITUDINAL_LIMITS.forecasts) {
        throw invalid('vcr_prediction_rows_missing','Supply up to 32 endpoint predictions and 100000 total rows.');
      }
      const {predictions,...header} = input;
      /** @type {any[]} */ const components = [], issues = [];
      for (const [index,part] of predictions.entries()) {
        if (!part || typeof part !== 'object' || Array.isArray(part) || Object.hasOwn(part,'predictions')) {
          issues.push({index,code:'forecast_component_invalid'});continue;
        }
        try {
          // All components share the explicitly selected history. Each endpoint
          // remains independently addressable, evaluable and usable for design.
          const saved = await importPrediction(study,{...header,...part,historyId:input.historyId},actor,provenance);
          components.push({index,id:saved.id,endpoint:saved.summary.endpoint,accepted:saved.summary.accepted,invalidRows:saved.summary.invalidRows});
        } catch (error) {
          if (!(error instanceof HttpError) || !['vcr_forecast_unavailable','vcr_prediction_rows_missing'].includes(error.code)) throw error;
          issues.push({index,code:error.code});
        }
      }
      const content = {schema:1,contract:'endpoint_prediction_set',historyId:history.row.id,input,components,issues};
      return longitudinalArtifactView(await artifacts.save(study,'prediction_set',content,
        {historyId:history.row.id,origin:history.content.asOf,dataClass:history.content.dataClass,components,issues,
          requestedComponents:predictions.length,acceptedComponents:components.length,invalidComponents:issues.length,
          accepted:components.reduce((n,c) => n+c.accepted,0),invalidRows:components.reduce((n,c) => n+c.invalidRows,0),
          interpretation:'marginal_endpoints_not_joint_event_paths'},
        {snapshotIds:history.row.snapshot_ids,sourceIds:history.row.source_ids,bindings:history.row.bindings,parentId:history.row.id}));
    }
    const prior = input.priorPredictionId ? await artifacts.read(study,input.priorPredictionId,actor) : null;
    if (prior && prior.row.kind !== 'prediction') throw invalid('vcr_forecast_unavailable','The preceding record must be a prediction.');
    let rows = input.rows;
    if (!Array.isArray(rows)) throw invalid('vcr_prediction_rows_missing','Supply an array of prediction rows.');
    if (input.subjectKeyMode === 'source_identifier') {
      const key = await studyPseudonymKey(dataPlane.root(),study.id);
      rows = rows.map((/** @type {any} */ r) => r && typeof r === 'object' ? ({...r,subjectKey:pseudonymOf(key,String(r.subjectKey))}) : r);
    }
    // what the prediction was made from: its history, a later history whose actions it replayed, and the version it continues (review eng P0-4);
    // its class is the strictest of them, so real actions or a real earlier version never leave a prediction labelled synthetic
    const from = [history.row,...(Array.isArray(provenance.lineageRows) ? provenance.lineageRows : []),...(prior ? [prior.row] : [])];
    const dataClass = strictestDataClass(history.content,...from.slice(1).map(row => row.summary));
    const checked = validateForecast({...input,rows},{subjects:new Set(longitudinalSubjects(history.content)),origin:history.content.asOf});
    if (checked.issues.some(issue => issue.code === 'forecast_header_invalid')) {
      throw invalid('vcr_forecast_unavailable','The prediction header needs an endpoint with type and unit, the history origin, and an ordered list of positive horizons.');
    }
    const content = {schema:1,historyId:input.historyId,origin:history.content.asOf,endpoint:input.endpoint,horizonsDays:input.horizonsDays,
      model:input.model ?? {name:'unknown',version:'unknown'},scenario:input.scenario ?? null,rows:checked.rows,
      issues:checked.issues,rejected:[...(checked.rejected ?? []),...(provenance.rejected ?? [])],dataClass,
      received:checked.received,valueSource:'predicted',originKind:provenance.originKind ?? 'external_file',
      provenance:/** @type {Record<string,any>} */ ({...Object.fromEntries(Object.entries(provenance).filter(([key]) => !['accounting','premises','uncertainty','lineageRows','actionSchedule'].includes(key))),importDigest:longitudinalHash(input)}),priorPredictionId:input.priorPredictionId ?? null,
      // the schedule a conditional forecast or a replay was made on, so a comparison of two versions can name it as what changed (stats P2-14)
      actionSchedule:Array.isArray(provenance.actionSchedule) ? provenance.actionSchedule : null};
    const original = await artifacts.save(study,'prediction_import',input,{historyId:input.historyId,received:rows.length},lineageOf(from,input.historyId));
    content.provenance.importArtifactId = original.id;
    // A cloud batch brings its own ledger; an imported file is accounted the same way (every person of the history, one batch).
    const subjectsOfHistory = longitudinalSubjects(history.content);
    const accounting = provenance.accounting ?? reconcileSubjects({subjects:subjectsOfHistory,horizonsDays:content.horizonsDays,rows:checked.rows,
      validationRejected:content.rejected,batches:[{keys:subjectsOfHistory,outcome:'done'}]});
    content.accounting = accounting.lines;
    const context = provenance.actionContext ?? {mode:'factual_forecast',actionSource:'none',deployable:true,label:'factual_forecast'};
    const versionNumber = (prior?.row.summary?.versionNumber ?? (prior ? 1 : 0))+1;
    const summary = {accounting:accounting.counts,accountingReasons:reasonCounts(accounting.lines),actionContext:context,versionNumber,
      uncertainty:provenance.uncertainty ?? uncertaintyProvenance(checked.rows),leakageDropped:provenance.leakageDropped ?? 0,unitDropped:provenance.unitDropped ?? 0,
      useFindings:provenance.premises ?? [],origin:content.origin,endpoint:content.endpoint,horizonsDays:content.horizonsDays,model:content.model,scenario:content.scenario,
      historyId:content.historyId,priorPredictionId:content.priorPredictionId,jobId:provenance.jobId ?? null,
      received:provenance.receipts?.reduce((/** @type {number} */ total,/** @type {any} */ r) => total+(r.receivedRows ?? 0),0) ?? checked.received,
      accepted:checked.rows.length,invalidRows:checked.received-checked.rows.length
        +(provenance.receipts?.reduce((/** @type {number} */ total,/** @type {any} */ r) => total+(r.invalidRows ?? 0),0) ?? 0),
      issues:checked.issues.slice(0,100),originKind:content.originKind,dataClass,
      designInputs:content.horizonsDays?.length && checked.rows.length ? forecastDesignInputs(content) : [],
      trajectories:aggregateForecastCurve(content),actualProvider:provenance.receipts?.map((/** @type {any} */ r) => ({provider:r.provider,model:r.actualModel,version:r.actualVersion})),
      cost:provenance.receipts?.map((/** @type {any} */ r) => ({value:r.cost,currency:r.costCurrency})),failures:provenance.failures ?? []};
    summary.premises = trajectoryPremises({findings:summary.useFindings,actionContext:context,uncertainty:summary.uncertainty});
    const saved = await artifacts.save(study,'prediction',content,summary,lineageOf(from,input.priorPredictionId ?? input.historyId));
    return longitudinalArtifactView(saved);
  }
  /** `extra` is the orchestrator's own (never a caller's: the gateway and the routes name neither): the idempotency key of the stage it
   * queues for and the detail its marks and results are read by.
   * @param {any} study @param {any} request @param {string} actor @param {{ idempotencyKey?: string, detail?: Record<string, any> }} [extra] */
  async function prepare(study,request,actor,extra = {}) {
    await authorize(study,actor,'run');
    const method = VCR_LONGITUDINAL_JOBS[/** @type {keyof typeof VCR_LONGITUDINAL_JOBS} */ (request.kind)];
    const scenario = obj(request.scenario);
    const problems = validateLongitudinalScenario(method,scenario);
    // a replay's schedule is read from its later history when the job runs, so an explicit mode with no supplied schedule is not one left out (review stats P2-15)
    if (method === 'forecast.trajectories') for (const issue of actionContext(scenario).issues) {
      if (scenario.actionHistoryId && issue.code === 'intervention_input_unavailable') continue;
      problems.push({code:issue.code,field:`scenario.${issue.field}`,detail:issue.detail});
    }
    if (problems.length) throw invalid('vcr_job_scenario_invalid',problems.map(p => p.field).join(', '));
    /** @type {any[]} */ const inputs = [];
    for (const key of ['historyId','predictionId','outcomeHistoryId','otherPredictionId','benchmarkId','actionHistoryId','priorPredictionId']) if (scenario[key]) {
      const held = await artifacts.read(study,scenario[key],actor);
      // the actions a replay reads come from a frozen history, never another kind of record (review eng P0-4)
      if (key === 'actionHistoryId' && held.row.kind !== 'history') throw invalid('vcr_history_required','The actions to replay come from a frozen history.');
      inputs.push({kind:'source',id:held.row.id,hash:held.row.sha256});
    }
    if (method === 'forecast.trajectories') {
      const provider = await providers.require(scenario.providerId);
      if (scenario.modelVersion && provider.version !== scenario.modelVersion) throw invalid('vcr_forecast_request_changed','The configured model version differs from the requested version.');
      // Provider configuration participates in the job's idempotency identity.
      // A rollout cannot return an older model's cached prediction as new work.
      inputs.push({kind:'provider',id:provider.id,hash:longitudinalHash(provider)});
    }
    return jobs.enqueue({studyId:study.id,userId:study.userId,principal:actor,kind:request.kind,scenario,inputs,internal:true,
      runId:extra.detail?.conversationOrigin?.runId ?? null,
      seed:request.seed ?? null,cpuSecondsLimit:Math.min(600,request.cpuSecondsLimit ?? 120),maxAttempts:1,
      ...(extra.idempotencyKey ? {idempotencyKey:extra.idempotencyKey} : {}),
      detail:{...(extra.detail ?? {}),longitudinal:true,principal:actor}});
  }
  /** @param {any} input */
  async function execute({job,onProgress,isCanceled = async () => false}) {
    const started = now(), cpuStarted = process.cpuUsage(), study = await store.studyById(job.studyId), actor = job.principal ?? study?.userId;
    if (!study) throw new HttpError(404,'vcr_study_not_found','Study not found.');
    const scenario = job.scenario;
    /** @param {string} id */
    const read = async id => {
      const held = await artifacts.read(study,id,actor), input = job.inputs.find((/** @type {any} */ i) => i.id === id);
      if (!input || input.hash !== held.row.sha256) throw invalid('vcr_longitudinal_changed','The job references different preserved bytes.');
      return held;
    };
    /** @type {any} */ let saved = null;
    if (job.method === 'forecast.trajectories') {
      const history = await read(scenario.historyId);
      const pinnedProvider = job.inputs.find((/** @type {any} */ entry) => entry.kind === 'provider');
      if (!pinnedProvider || pinnedProvider.hash !== longitudinalHash(await providers.require(scenario.providerId))) {
        throw invalid('vcr_forecast_request_changed','The provider configuration changed after enqueue; start a new prediction version.');
      }
      // A logged replay reads its actions from a LATER history (what happened after the origin), never from the one the forecast is
      // made from, and says so on the result; a supplied schedule is a hypothesis stated at the origin.
      let prediction = {predictionMode:scenario.predictionMode,actions:scenario.actions,actionSource:scenario.actionSource};
      // A replay sends the later history's medication events to the provider too: its sources' cloud permission is judged before every
      // batch with the forecast history's, its grant is read again each time, and everything saved carries both lineages (review eng P0-4).
      const later = scenario.actionHistoryId ? await read(scenario.actionHistoryId) : null;
      if (later && later.row.kind !== 'history') throw invalid('vcr_history_required','The actions to replay come from a frozen history.');
      const lineage = lineageOf([history.row,...(later ? [later.row] : [])],history.row.id);
      if (later) {
        const provider = await providers.require(scenario.providerId);
        prediction = {predictionMode:scenario.predictionMode ?? 'conditional_forecast',actionSource:'logged_replay',
          actions:loggedActionSchedule(later.content.events,history.content.asOf,(provider.actionCodes ?? []).map(String))};
      }
      /** @param {any} batch */
      const saveBatch = async batch => {
        // Preserve raw exchanges inside the plane. Only aggregate metadata reaches a run.
        if (batch.rawRequest) await artifacts.save(study,'exchange',{jobId:job.jobId,offset:batch.offset,
          request:batch.rawRequest,response:batch.rawResponse},{jobId:job.jobId,offset:batch.offset},lineage);
        saved = await importPrediction(study,{historyId:history.row.id,origin:history.content.asOf,endpoint:scenario.endpoint,
          horizonsDays:scenario.horizonsDays,rows:batch.rows,model:{name:batch.receipts?.[0]?.actualModel ?? scenario.providerId,
            version:batch.receipts?.[0]?.actualVersion ?? 'unknown'},
          scenario:scenario.scenario,...(scenario.priorPredictionId ? {priorPredictionId:scenario.priorPredictionId} : {})},actor,
        {originKind:'cloud_api',jobId:job.jobId,receipts:batch.receipts,failures:batch.failures,rejected:batch.rejected,
          accounting:batch.accounting,premises:batch.premises,uncertainty:batch.uncertainty,actionContext:batch.actionContext,leakageDropped:batch.leakageDropped,unitDropped:batch.unitDropped,
          actionSchedule:Array.isArray(prediction.actions) ? prediction.actions : [],
          lineageRows:later ? [later.row] : []});
        await onProgress({done:batch.rows.length,total:history.content.events.length});
      };
      try {
        const result = await providers.predict({providerId:scenario.providerId,history:history.content,endpoint:scenario.endpoint,
          horizonsDays:scenario.horizonsDays,scenario:scenario.scenario,prediction,seed:job.seed,samples:scenario.samples,jobId:job.jobId,
          budgetMs:Math.min(job.cpuSecondsLimit*1000,600_000),
          beginBatch:async batch => {
            const existing = await store.one(`SELECT id FROM evimed_vcr.longitudinal_artifacts WHERE study_id=$1
              AND kind='provider_batch' AND summary->>'jobId'=$2 AND summary->>'offset'=$3 ORDER BY created_at DESC LIMIT 1`,[study.id,job.jobId,String(batch.offset)]);
            if (existing) {
              const held = await artifacts.read(study,existing.id,actor);
              if (held.content.requestDigest !== batch.requestDigest) throw invalid('vcr_forecast_request_changed','A retry must preserve its exact request.');
              return held.content;
            }
            await artifacts.save(study,'provider_batch',{...batch,pending:true}, {jobId:job.jobId,offset:batch.offset},lineage);
            return null;
          },
          finishBatch:async batch => {
            await artifacts.save(study,'provider_batch',{...batch,pending:false}, {jobId:job.jobId,offset:batch.offset},lineage);
          },
          permissions:async () => {
            // Recheck the grant as well as the cloud permission before every batch, of every history whose rows the request carries.
            await artifacts.read(study,history.row.id,actor);
            if (later) await artifacts.read(study,later.row.id,actor);
            return Promise.all(lineage.sourceIds.map(async (/** @type {string} */ id) => (await dataStore.sourceInStudy(study.id,id))?.cloudPermission));
          },onBatch:saveBatch,isCanceled});
        await saveBatch(result);
      } catch (error) {
        if (!saved) throw error;
        // A grant withdrawn between batches stops egress but never erases work
        // already computed. Its interruption remains visible in the ledger.
        const interruption = String(/** @type {any} */ (error)?.code ?? 'prediction_unavailable');
        await artifacts.save(study,'prediction_interruption',{predictionId:saved.id,jobId:job.jobId,code:interruption},
          {predictionId:saved.id,jobId:job.jobId,code:interruption},{parentId:saved.id});
        saved = {...saved,summary:{...saved.summary,failures:[...(saved.summary.failures ?? []),{code:interruption}]}};
      }
    } else if (job.method === 'forecast.evaluate') {
      const prediction = await read(scenario.predictionId), outcomes = await read(scenario.outcomeHistoryId);
      const history = await artifacts.read(study,prediction.content.historyId,actor);
      const computed = await runForecastCalculation(job.method,[prediction.content,history.content,outcomes.content,{...scenario,seed:job.seed}],{timeoutMs:job.cpuSecondsLimit*1000,isCanceled});
      // a replay's accuracy is the model's given what really happened after the origin, never a forecast's accuracy (review stats P1-6)
      const evaluation = {...computed,...accuracyOf([prediction])};
      saved = longitudinalArtifactView(await artifacts.save(study,'evaluation',evaluation,evaluation,
        {snapshotIds:[...new Set([...prediction.row.snapshot_ids,...outcomes.row.snapshot_ids])],
          sourceIds:[...new Set([...prediction.row.source_ids,...outcomes.row.source_ids])],bindings:[...(prediction.row.bindings ?? []),...(outcomes.row.bindings ?? [])],parentId:prediction.row.id}));
    } else if (job.method === 'forecast.compare') {
      const first = await read(scenario.predictionId), second = await read(scenario.otherPredictionId);
      // the outcome history is read once: its values, its class and its lineage all reach the saved comparison
      const outcomes = scenario.outcomeHistoryId ? await read(scenario.outcomeHistoryId) : null;
      const computed = await runForecastCalculation(job.method,[first.content,second.content,{seed:job.seed,bootstrap:scenario.bootstrap,mode:scenario.mode}],{timeoutMs:job.cpuSecondsLimit*1000,isCanceled});
      // Old version, new version and what was observed afterwards, on the people and dates all three share.
      const observed = outcomes
        ? await runForecastCalculation('forecast.compare_observed',[first.content,second.content,outcomes.content,{seed:job.seed,
          dataClass:strictestDataClass(first.content,second.content),windowDays:scenario.windowDays,
          // the deployment's small-cell threshold, not the domain default: these groups reach the model's reads of the comparison
          ...(Number.isInteger(Number(config.vcrMinCellSize)) && Number(config.vcrMinCellSize) >= 2 ? {minCell:Number(config.vcrMinCellSize)} : {})}],{timeoutMs:job.cpuSecondsLimit*1000,isCanceled}) : null;
      // the page, the model's reads and the report take the synthetic exemption from the OUTER class, so it is the strictest of
      // both forecasts and the outcome history, never the forecasts' alone
      const comparison = {...computed,predictionIds:[first.row.id,second.row.id],...(observed ? {observed,dataClass:strictestDataClass(computed,observed)} : {}),...accuracyOf([first,second])};
      saved = longitudinalArtifactView(await artifacts.save(study,'comparison',comparison,comparison,
        lineageOf([first.row,second.row,...(outcomes ? [outcomes.row] : [])],first.row.id)));
    } else if (job.method === 'forecast.trial_benchmark') {
      const benchmark = await read(scenario.benchmarkId);
      const evaluation = await runForecastCalculation(job.method,[benchmark.content,{bootstrap:scenario.bootstrap,seed:job.seed}],{timeoutMs:job.cpuSecondsLimit*1000,isCanceled});
      saved = longitudinalArtifactView(await artifacts.save(study,'trial_evaluation',evaluation,evaluation,lineageOf([benchmark.row],benchmark.row.id)));
    }
    if (!saved) throw invalid('vcr_forecast_unavailable','No forecast result is available.');
    const result = {jobId:job.jobId,protocolVersion:1,status:await isCanceled() ? 'canceled' : 'succeeded',method:job.method,
      methodVersion:job.methodVersion,scenarioHash:job.scenarioHash,seed:job.seed,replicates:null,
      conclusion:'limited',counts:{realPatients:null,events:null,effectiveSampleSize:null,generatedRecords:0},
      measures:[],diagnostics:{longitudinal:saved,methodology:'research_forecast',clinicalValidationClaim:false},tables:[],
      manifest:{engineVersion:'control-plane-longitudinal-1',rVersion:`node ${process.version}`,
        packageLockHash:longitudinalHash({method:job.method,version:job.methodVersion}),startedAt:started.toISOString(),
        finishedAt:now().toISOString(),cpuSeconds:(process.cpuUsage(cpuStarted).user+process.cpuUsage(cpuStarted).system)/1_000_000,outputHash:''}};
    result.manifest.outputHash = createHash('sha256').update(vcrResultOutputPayload(result)).digest('hex');
    return result;
  }
  return {artifacts,providers,freezeHistory,importPrediction,prepare,execute,
    /** Translate saved model outputs into the existing analytic design engine.
     * Each job retains the prediction references and the variance semantics.
     * @param {any} study @param {any} input @param {string} actor */
    async enqueueDesign(study,input,actor) {
      const first = await artifacts.read(study,input.predictionId,actor), second = await artifacts.read(study,input.controlPredictionId,actor);
      // a replay used actions recorded after the origin: it is no forecast a trial could be designed on (review stats P1-6)
      if (accuracyOf([first,second]).accuracyKind === 'logged_action_replay') return {available:false,code:'logged_replay_not_deployable'};
      const paired = compareForecasts(first.content,second.content,{bootstrap:0});
      if (!paired.available) return {available:false,code:paired.code};
      const controlSubjects = new Set(second.content.rows.filter((/** @type {any} */ r) => r.horizonDays === input.horizonDays).map((/** @type {any} */ r) => r.subjectKey));
      const treatmentRows = first.content.rows.filter((/** @type {any} */ r) => r.horizonDays === input.horizonDays && controlSubjects.has(r.subjectKey));
      const pairedSubjects = new Set(treatmentRows.map((/** @type {any} */ r) => r.subjectKey));
      const controlRows = second.content.rows.filter((/** @type {any} */ r) => r.horizonDays === input.horizonDays && pairedSubjects.has(r.subjectKey));
      const a = forecastDesignInputs({...first.content,rows:treatmentRows}).find((/** @type {any} */ r) => r.horizonDays === input.horizonDays);
      const b = forecastDesignInputs({...second.content,rows:controlRows}).find((/** @type {any} */ r) => r.horizonDays === input.horizonDays);
      if (!a || !b || a.mean == null || b.mean == null) return {available:false,code:'forecast_horizon_missing'};
      // People below the deployment's small-cell threshold are not a design a reader may take from patient-derived forecasts: refused with
      // its reason, every other result kept. A synthetic class is not a patient disclosure and keeps its small designs.
      const configured = Number(config.vcrMinCellSize);
      const minCell = Number.isInteger(configured) && configured > VCR_MIN_CELL_SIZE ? configured : VCR_MIN_CELL_SIZE;
      if (strictestDataClass(first.content,second.content) !== 'synthetic' && pairedSubjects.size < minCell) return {available:false,code:'forecast_design_below_small_cell'};
      const binary = ['risk','survival_probability'].includes(a.type);
      if (!binary && a.type !== 'continuous') return {available:false,code:'forecast_rate_not_binary_risk'};
      if (!binary && (a.outcomeVariance == null || b.outcomeVariance == null)) return {available:false,code:'predictive_outcome_variance_missing'};
      const truth = binary ? {controlRate:b.type === 'risk' ? b.mean : 1-b.mean,treatmentRate:a.type === 'risk' ? a.mean : 1-a.mean}
        : {effect:a.mean-b.mean,sd:Math.sqrt((Number(a.outcomeVariance)+Number(b.outcomeVariance))/2)};
      let prognostic = null, validation = null, validatedPrediction = null;
      if (input.prognosticEvaluationId) {
        validation = await artifacts.read(study,input.prognosticEvaluationId,actor);
        validatedPrediction = validation.row.parent_id ? await artifacts.read(study,validation.row.parent_id,actor) : null;
        const group = validation.content.groups?.find((/** @type {any} */ r) => r.horizonDays === input.horizonDays);
        const correlation = group?.metrics?.correlation?.value;
        if (validation.row.kind !== 'evaluation' || !validatedPrediction || longitudinalHash(validatedPrediction.content.model) !== longitudinalHash(first.content.model)
          || validation.content.endpoint?.code !== first.content.endpoint.code
          || validation.content.endpoint?.unit !== first.content.endpoint.unit || binary || validation.content.split !== 'test') return {available:false,code:'heldout_prognostic_validation_missing'};
        if (!Number.isFinite(Date.parse(input.randomizationAt)) || Date.parse(first.content.origin) >= Date.parse(input.randomizationAt)) return {available:false,code:'prerandomization_origin_required'};
        if (!Number.isFinite(correlation) || Math.abs(correlation) >= 1) return {available:false,code:'prognostic_correlation_not_estimable'};
        prognostic = {rho:Math.abs(correlation),lambda:input.lambda ?? 1,gamma:input.gamma ?? 1};
      }
      const queued = await jobs.enqueue({studyId:study.id,userId:study.userId,principal:actor,kind:prognostic ? 'procova' : 'design_analytic',
        idempotencyKey:`forecast-design:${longitudinalHash({forecasts:[first.row.id,second.row.id],
          horizonDays:input.horizonDays,validation:validation?.row.id ?? null,randomizationAt:input.randomizationAt ?? null})}`,
        scenario:{design:{...(prognostic ? {} : {kind:'two_arm_fixed'}),allocation:input.allocation ?? .5},endpoint:{type:binary ? 'binary' : 'continuous'},truth,
          analysis:{alpha:input.alpha ?? .05,power:input.power ?? .9,sided:2},...(prognostic ? {prognostic} : {})},
        // Analytic design reads the frozen truth in its scenario, not a patient file, so the engine is given no input. What the truth was
        // made from is the job's lineage (every snapshot, source and field binding of the predictions, the history and the validation it
        // read): it rides in the checkpoint and the store judges it again on every read of this job's result (`resultLineageGuard`).
        inputs:[],
        detail:{forecastLineage:(({snapshotIds,sourceIds,bindings}) => ({snapshotIds,sourceIds,bindings,
            dataClass:strictestDataClass(first.content,second.content)}))(lineageOf([first.row,second.row,...(validation ? [validation.row] : []),
            ...(validatedPrediction ? [validatedPrediction.row] : [])],null)),
          forecastInputs:[{id:first.row.id,hash:first.row.sha256},{id:second.row.id,hash:second.row.sha256}],
          variance:{treatment:a,control:b},
          interpretation:'model_scenario_design',horizonDays:input.horizonDays,pairedSubjects:pairedSubjects.size,parameterUncertainty:'not_estimated',
          ...(validation ? {validation:{id:validation.row.id,hash:validation.row.sha256,dataClass:validation.content.dataClass,
            randomizationAt:input.randomizationAt,correlationMeaning:'heldout_predictive_correlation',clinicalQualification:false}} : {})}});
      return {available:true,jobId:queued.job.id,state:queued.job.state};
    },
    /** The per-person lines of one prediction, from its protected artifact: the grant is rejudged by the read, a page is bounded and
     * filtered by status, and a prediction from before the ledger existed is accounted from its rows on the way out.
     * @param {any} study @param {string} id @param {string} actor @param {{status?:string|null,reason?:string|null,offset?:number,limit?:number}} [filter] */
    async subjectPage(study,id,actor,filter = {}) {
      const held = await artifacts.read(study,id,actor);
      if (held.row.kind !== 'prediction') throw invalid('vcr_forecast_unavailable','Select a prediction.');
      // a prediction from before the ledger existed is accounted over every person of its history, so a person with no accepted row
      // is still a line and the total is the history's (review stats P2-18); its history is read under the same grant
      let lines = held.content.accounting;
      if (!lines) {
        const history = held.content.historyId ? await artifacts.read(study,held.content.historyId,actor).catch(() => null) : null;
        const subjects = history ? longitudinalSubjects(history.content) : [...new Set(held.content.rows.map((/** @type {any} */ r) => r.subjectKey))];
        lines = reconcileSubjects({subjects,horizonsDays:held.content.horizonsDays,rows:held.content.rows,validationRejected:held.content.rejected ?? [],
          batches:[{keys:subjects,outcome:'done'}]}).lines;
      }
      // each line keeps its place in submission order, so a person reads as the same 「患者 N」 under every filter and page
      const shown = lines.map((/** @type {any} */ l, /** @type {number} */ i) => ({...l,ordinal:i + 1}))
        .filter((/** @type {any} */ l) => (!filter.status || l.status === filter.status) && (!filter.reason || l.reason === filter.reason));
      const limit = Math.min(200,Math.max(1,Math.floor(Number(filter.limit) || 50))), offset = Math.max(0,Math.floor(Number(filter.offset) || 0));
      const page = shown.slice(offset,offset+limit);
      const keys = new Set(page.map((/** @type {any} */ l) => l.subjectKey));
      return {id,total:lines.length,matching:shown.length,offset,limit,more:offset+limit < shown.length,lines:page,
        // one person's own trajectory: their rows, never an aggregate of another person's
        trajectories:Object.fromEntries([...keys].map(key => [key,held.content.rows.filter((/** @type {any} */ r) => r.subjectKey === key)
          .map((/** @type {any} */ r) => ({horizonDays:r.horizonDays,point:r.point,sd:r.sd ?? null,quantiles:r.quantiles ?? [],draws:(r.samples ?? []).length,uncertainty:r.uncertainty}))])),
        actionContext:held.content.actionContext ?? held.row.summary?.actionContext ?? null};
    },
    /** @param {any} study @param {any} [filter] @param {any} [readStore] */
    async view(study,filter = {},readStore = store,actor = null) {
      return {...await artifacts.list(study.id,filter,readStore,actor),providers:await providers.list().catch(() => []),
        candidates:forecastCandidates.candidates,jobSchemas:VCR_LONGITUDINAL_SCHEMAS,
        available:true,templates:LONGITUDINAL_TEMPLATES,interfaces:['event_history_to_trajectories','external_prediction_file'],
        alternatives:['literature_scenario','sensitivity_analysis','trial_design']};
    },
    /** Trial effects are separate from patient trajectories. Only preserved
     * evidence supplies actual effects; a file supplies external predictions.
     * @param {any} study @param {any} input @param {string} actor */
    async importBenchmark(study,input,actor) {
      await authorize(study,actor,'run');
      if (!Array.isArray(input.comparisons) || input.comparisons.length > 10_000) throw invalid('vcr_benchmark_invalid','Supply trial comparisons.');
      const comparisons = [];
      for (const row of input.comparisons) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {comparisons.push({actual:null,predicted:null,issue:'comparison_invalid'});continue;}
        const evidence = await store.one('SELECT * FROM evimed_vcr.evidence_items WHERE study_id=$1 AND id=$2',[study.id,row.evidenceId]);
        if (!evidence) {comparisons.push({...row,actual:null,issue:'preserved_evidence_missing'});continue;}
        const verified = ['observed','extracted'].includes(evidence.value_source) && evidence.locator?.verification === 'verified';
        const target = evidence.detail?.target ?? {};
        const horizon = target.verification === 'verified' ? target.horizonDays : null;
        const unknown = !evidence.arm || evidence.arm_role === 'unknown' || !Number.isFinite(horizon)
          || !row.arm || !row.armRole || !Number.isFinite(row.horizonDays) || !row.endpoint || !row.scale || !row.unit || !row.trialId;
        const mismatch = row.scale !== evidence.parameter || row.endpoint !== evidence.endpoint_key
          || row.unit !== evidence.unit || row.trialId !== evidence.precedent_id || row.arm !== evidence.arm
          || row.armRole !== evidence.arm_role || row.horizonDays !== horizon;
        comparisons.push({...row,trialId:evidence.precedent_id,endpoint:evidence.endpoint_key,scale:evidence.parameter,unit:evidence.unit,
          evidence:{id:evidence.id,sourceHash:longitudinalHash(evidence),record:evidence},
          issue:!verified ? 'actual_evidence_unverified' : unknown ? 'target_identity_unknown' : mismatch ? 'target_identity_mismatch' : null,
          actual:verified && !unknown && !mismatch && evidence.value != null && Number.isFinite(Number(evidence.value)) ? Number(evidence.value) : null});
      }
      const content = {schema:1,model:input.model ?? {},contract:'trial_effect_prediction',comparisons,
        split:input.split ?? {},trainingOverlap:input.trainingOverlap ?? 'unknown',sourceFile:input.sourceFile ?? null,
        importDigest:longitudinalHash(input)};
      return longitudinalArtifactView(await artifacts.save(study,'trial_benchmark',content,
        {comparisons:comparisons.length,model:content.model,contract:content.contract,
          matched:comparisons.filter(r => r.actual != null).length,issues:comparisons.filter(r => r.issue).map(r => ({code:r.issue})),
          trainingOverlap:content.trainingOverlap}));
    },
  };
}

/** Cohort mean only; aggregate predictive quantiles are not computed by averaging
 * individual quantiles. The band below is labelled between-subject dispersion.
 * @param {any} prediction */
export function aggregateForecastCurve(prediction) {
  return (prediction.horizonsDays ?? []).map((/** @type {number} */ day) => {
    const values = prediction.rows.filter((/** @type {any} */ r) => r.horizonDays === day).map((/** @type {any} */ r) => r.point).sort((/** @type {number} */ a,/** @type {number} */ b) => a-b);
    return {day,subjects:values.length,mean:values.length ? values.reduce((/** @type {number} */ a,/** @type {number} */ b) => a+b,0)/values.length : null,
      lower:values.length ? values[Math.floor((values.length-1)*.1)] : null,upper:values.length ? values[Math.ceil((values.length-1)*.9)] : null,
      band:'between_subject_forecast_10_90_percentiles',valueSource:'predicted'};
  });
}

export const LONGITUDINAL_TEMPLATES = Object.freeze({
  predictionSet:{format:'json',schema:1,historyId:'<history id>',origin:'2026-01-02T00:00:00.000Z',subjectKeyMode:'source_identifier',
    model:{name:'external-model',version:'unknown'},horizonsDays:[90],predictions:[
      {endpoint:{code:'HbA1c',type:'continuous',unit:'%'},rows:[{subjectKey:'synthetic-001',horizonDays:90,point:7}]},
      {endpoint:{code:'LDL',type:'continuous',unit:'mmol/L'},rows:[{subjectKey:'synthetic-001',horizonDays:90,point:2.5}]}]},
  benchmark:{model:{name:'external-trial-model',version:'1'},trainingOverlap:'unknown',comparisons:[
    {evidenceId:'<preserved evidence id>',trialId:'<precedent id>',familyId:'<trial family>',split:'test',
      endpoint:'HbA1c',scale:'mean_difference',unit:'%',arm:'Treatment versus control',armRole:'contrast',horizonDays:84,predicted:-.4}]},
  events:{format:'csv',columns:['subject_id','event_id','revision','code','value','unit','occurred_at','recorded_at','available_at','kind','assertion','experiencer','medication_state','site','modality'],
    example:['synthetic-001','lab-001','1','HbA1c','7.2','%','2026-01-01','2026-01-02','2026-01-02','measurement','affirmed','patient','unknown','synthetic-site','laboratory']},
  prediction:{format:'json',schema:1,historyId:'<history id>',origin:'2026-01-02T00:00:00.000Z',subjectKeyMode:'source_identifier',
    endpoint:{code:'HbA1c',type:'continuous',unit:'%'},horizonsDays:[90],model:{name:'external-model',version:'unknown'},
    rows:[{subjectKey:'synthetic-001',horizonDays:90,point:7,sd:.5,uncertainty:'predictive',quantiles:[{p:.05,value:6.2},{p:.95,value:7.8}]}]},
});
