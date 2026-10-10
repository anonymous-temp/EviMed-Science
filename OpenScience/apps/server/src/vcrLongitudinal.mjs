/** Event-history research inside VCR: the existing plane, queue, permissions and
 * DeepSeek/DSH tools. No second agent or locally deployed prediction model. */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  vcrResultOutputPayload, eventsFromMappedTable, replayClinicalEvents, longitudinalReadiness,
  validateForecast, validateLongitudinalScenario, VCR_LONGITUDINAL_JOBS, VCR_LONGITUDINAL_LIMITS, VCR_LONGITUDINAL_SCHEMAS,
  compareForecasts, forecastDesignInputs,
} from '@evimed/domain';
import { parseTable, studyPseudonymKey, pseudonymOf } from './vcrDataPlane.mjs';
import { VcrLongitudinalStore, longitudinalHash, longitudinalArtifactView } from './vcrLongitudinalStore.mjs';
import { createForecastProviders } from './vcrForecastProvider.mjs';
import { HttpError } from './security.mjs';
import { runForecastCalculation } from './vcrForecastCalculation.mjs';
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

/** @param {any} input */
export function createVcrLongitudinal({store,dataStore,dataPlane,matchStore,access,jobs,config = {},fetchImpl,now = () => new Date()}) {
  if (!dataPlane) return null;
  const artifacts = new VcrLongitudinalStore({store,plane:dataPlane,access});
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
    const replay = replayClinicalEvents([...(prior?.content.events ?? []),...events],input.asOf);
    const perturbation = input.perturbation ?? null;
    if (perturbation && (Object.keys(perturbation).some(k => !['omitCodes','historyFrom'].includes(k))
      || perturbation.omitCodes && !Array.isArray(perturbation.omitCodes)
      || perturbation.historyFrom && !Number.isFinite(Date.parse(perturbation.historyFrom)))) throw invalid('vcr_history_perturbation_invalid','Use omitted codes or a dated history window.');
    const selectedEvents = replay.events.filter(e => !perturbation?.omitCodes?.includes(e.code)
      && (!perturbation?.historyFrom || Date.parse(e.occurredAt) >= Date.parse(perturbation.historyFrom)));
    const content = {schema:1,snapshotId:input.snapshotId,snapshotHash:profile.sha256,sourceId:profile.sourceId,
      asOf:replay.asOf,mappings,events:selectedEvents,coverage:replay.coverage,issues:[...issues,...replay.issues],perturbation,
      dataClass:source?.valueSource === 'synthetic' ? 'synthetic' : 'patient',
      split:frozenHistorySplit(study,prior?.content.split?.rule ?? input.split,replay.events),priorHistoryId:input.priorHistoryId ?? null};
    if (prior?.content.split && content.split) {
      content.split.assignments = {...content.split.assignments,...prior.content.split.assignments};
      content.split.hash = longitudinalHash(content.split.assignments);
      content.split.counts = Object.fromEntries(['train','calibration','test','unknown'].map(role => [role,Object.values(content.split.assignments).filter(r => r === role).length]));
    }
    const summary = {...longitudinalReadiness(selectedEvents,replay.coverage),origin:replay.asOf,dataClass:content.dataClass,
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
  /** @param {any} study @param {any} input @param {string} actor @param {any} [provenance] */
  async function importPrediction(study,input,actor,provenance = {}) {
    await authorize(study,actor,'run');
    const history = await artifacts.read(study,input.historyId,actor);
    if (history.row.kind !== 'history') throw invalid('vcr_history_required','Select a frozen history.');
    let rows = input.rows;
    if (!Array.isArray(rows)) throw invalid('vcr_prediction_rows_missing','Supply an array of prediction rows.');
    if (input.subjectKeyMode === 'source_identifier') {
      const key = await studyPseudonymKey(dataPlane.root(),study.id);
      rows = rows.map((/** @type {any} */ r) => r && typeof r === 'object' ? ({...r,subjectKey:pseudonymOf(key,String(r.subjectKey))}) : r);
    }
    const checked = validateForecast({...input,rows},{subjects:new Set(history.content.events.map((/** @type {any} */ e) => e.subjectKey)),origin:history.content.asOf});
    if (checked.issues.some(issue => issue.code === 'forecast_header_invalid')) {
      throw invalid('vcr_forecast_unavailable','The prediction header needs an endpoint with type and unit, the history origin, and an ordered list of positive horizons.');
    }
    const content = {schema:1,historyId:input.historyId,origin:history.content.asOf,endpoint:input.endpoint,horizonsDays:input.horizonsDays,
      model:input.model ?? {name:'unknown',version:'unknown'},scenario:input.scenario ?? null,rows:checked.rows,
      issues:checked.issues,received:checked.received,valueSource:'predicted',originKind:provenance.originKind ?? 'external_file',
      provenance:{...provenance,importDigest:longitudinalHash(input)},priorPredictionId:input.priorPredictionId ?? null};
    const original = await artifacts.save(study,'prediction_import',input,{historyId:input.historyId,received:rows.length},
      {snapshotIds:history.row.snapshot_ids,sourceIds:history.row.source_ids,bindings:history.row.bindings,parentId:input.historyId});
    content.provenance.importArtifactId = original.id;
    if (input.priorPredictionId) await artifacts.read(study,input.priorPredictionId,actor);
    const summary = {origin:content.origin,endpoint:content.endpoint,horizonsDays:content.horizonsDays,model:content.model,scenario:content.scenario,
      historyId:content.historyId,received:checked.received,accepted:checked.rows.length,invalidRows:checked.issues.length,
      issues:checked.issues.slice(0,100),originKind:content.originKind,dataClass:history.content.dataClass,
      designInputs:content.horizonsDays?.length && checked.rows.length ? forecastDesignInputs(content) : [],
      trajectories:aggregateForecastCurve(content),actualProvider:provenance.receipts?.map((/** @type {any} */ r) => ({provider:r.provider,model:r.actualModel,version:r.actualVersion})),
      cost:provenance.receipts?.map((/** @type {any} */ r) => ({value:r.cost,currency:r.costCurrency})),failures:provenance.failures ?? []};
    const saved = await artifacts.save(study,'prediction',content,summary,{snapshotIds:history.row.snapshot_ids,sourceIds:history.row.source_ids,bindings:history.row.bindings,parentId:input.priorPredictionId ?? input.historyId});
    return longitudinalArtifactView(saved);
  }
  /** @param {any} study @param {any} request @param {string} actor */
  async function prepare(study,request,actor) {
    await authorize(study,actor,'run');
    const method = VCR_LONGITUDINAL_JOBS[/** @type {keyof typeof VCR_LONGITUDINAL_JOBS} */ (request.kind)];
    const scenario = obj(request.scenario);
    const problems = validateLongitudinalScenario(method,scenario);
    if (problems.length) throw invalid('vcr_job_scenario_invalid',problems.map(p => p.field).join(', '));
    /** @type {any[]} */ const inputs = [];
    for (const key of ['historyId','predictionId','outcomeHistoryId','otherPredictionId','benchmarkId']) if (scenario[key]) {
      const held = await artifacts.read(study,scenario[key],actor);
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
      seed:request.seed ?? null,cpuSecondsLimit:Math.min(600,request.cpuSecondsLimit ?? 120),maxAttempts:1,
      detail:{longitudinal:true,principal:actor}});
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
      /** @param {any} batch */
      const saveBatch = async batch => {
        // Preserve raw exchanges inside the plane. Only aggregate metadata reaches a run.
        if (batch.rawRequest) await artifacts.save(study,'exchange',{jobId:job.jobId,offset:batch.offset,
          request:batch.rawRequest,response:batch.rawResponse},{jobId:job.jobId,offset:batch.offset},
        {snapshotIds:history.row.snapshot_ids,sourceIds:history.row.source_ids,bindings:history.row.bindings,parentId:history.row.id});
        saved = await importPrediction(study,{historyId:history.row.id,origin:history.content.asOf,endpoint:scenario.endpoint,
          horizonsDays:scenario.horizonsDays,rows:batch.rows,model:{name:batch.receipts?.[0]?.actualModel ?? scenario.providerId,
            version:batch.receipts?.[0]?.actualVersion ?? 'unknown'},
          scenario:scenario.scenario},actor,{originKind:'cloud_api',jobId:job.jobId,receipts:batch.receipts,failures:batch.failures});
        await onProgress({done:batch.rows.length,total:history.content.events.length});
      };
      try {
        const result = await providers.predict({providerId:scenario.providerId,history:history.content,endpoint:scenario.endpoint,
          horizonsDays:scenario.horizonsDays,scenario:scenario.scenario,seed:job.seed,samples:scenario.samples,jobId:job.jobId,
          budgetMs:Math.min(job.cpuSecondsLimit*1000,600_000),
          beginBatch:async batch => {
            const existing = await store.one(`SELECT id FROM evimed_vcr.longitudinal_artifacts WHERE study_id=$1
              AND kind='provider_batch' AND summary->>'jobId'=$2 AND summary->>'offset'=$3 ORDER BY created_at DESC LIMIT 1`,[study.id,job.jobId,String(batch.offset)]);
            if (existing) {
              const held = await artifacts.read(study,existing.id,actor);
              if (held.content.requestDigest !== batch.requestDigest) throw invalid('vcr_forecast_request_changed','A retry must preserve its exact request.');
              return held.content;
            }
            await artifacts.save(study,'provider_batch',{...batch,pending:true}, {jobId:job.jobId,offset:batch.offset},
              {snapshotIds:history.row.snapshot_ids,sourceIds:history.row.source_ids,bindings:history.row.bindings,parentId:history.row.id});
            return null;
          },
          finishBatch:async batch => {
            await artifacts.save(study,'provider_batch',{...batch,pending:false}, {jobId:job.jobId,offset:batch.offset},
              {snapshotIds:history.row.snapshot_ids,sourceIds:history.row.source_ids,bindings:history.row.bindings,parentId:history.row.id});
          },
          permissions:async () => {
            // Recheck the grant as well as the cloud permission before every batch.
            await artifacts.read(study,history.row.id,actor);
            return Promise.all(history.row.source_ids.map(async (/** @type {string} */ id) => (await dataStore.sourceInStudy(study.id,id))?.cloudPermission));
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
      const evaluation = await runForecastCalculation(job.method,[prediction.content,history.content,outcomes.content,{...scenario,seed:job.seed}],{timeoutMs:job.cpuSecondsLimit*1000,isCanceled});
      saved = longitudinalArtifactView(await artifacts.save(study,'evaluation',evaluation,evaluation,
        {snapshotIds:[...new Set([...prediction.row.snapshot_ids,...outcomes.row.snapshot_ids])],
          sourceIds:[...new Set([...prediction.row.source_ids,...outcomes.row.source_ids])],bindings:[...(prediction.row.bindings ?? []),...(outcomes.row.bindings ?? [])],parentId:prediction.row.id}));
    } else if (job.method === 'forecast.compare') {
      const first = await read(scenario.predictionId), second = await read(scenario.otherPredictionId);
      const comparison = await runForecastCalculation(job.method,[first.content,second.content,{seed:job.seed,bootstrap:scenario.bootstrap}],{timeoutMs:job.cpuSecondsLimit*1000,isCanceled});
      saved = longitudinalArtifactView(await artifacts.save(study,'comparison',comparison,comparison,
        {snapshotIds:first.row.snapshot_ids,sourceIds:[...new Set([...first.row.source_ids,...second.row.source_ids])],bindings:[...(first.row.bindings ?? []),...(second.row.bindings ?? [])],parentId:first.row.id}));
    } else if (job.method === 'forecast.trial_benchmark') {
      const benchmark = await read(scenario.benchmarkId);
      const evaluation = await runForecastCalculation(job.method,[benchmark.content,{bootstrap:scenario.bootstrap,seed:job.seed}],{timeoutMs:job.cpuSecondsLimit*1000,isCanceled});
      saved = longitudinalArtifactView(await artifacts.save(study,'trial_evaluation',evaluation,evaluation,{parentId:benchmark.row.id}));
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
      const paired = compareForecasts(first.content,second.content,{bootstrap:0});
      if (!paired.available) return {available:false,code:paired.code};
      const controlSubjects = new Set(second.content.rows.filter((/** @type {any} */ r) => r.horizonDays === input.horizonDays).map((/** @type {any} */ r) => r.subjectKey));
      const treatmentRows = first.content.rows.filter((/** @type {any} */ r) => r.horizonDays === input.horizonDays && controlSubjects.has(r.subjectKey));
      const pairedSubjects = new Set(treatmentRows.map((/** @type {any} */ r) => r.subjectKey));
      const controlRows = second.content.rows.filter((/** @type {any} */ r) => r.horizonDays === input.horizonDays && pairedSubjects.has(r.subjectKey));
      const a = forecastDesignInputs({...first.content,rows:treatmentRows}).find((/** @type {any} */ r) => r.horizonDays === input.horizonDays);
      const b = forecastDesignInputs({...second.content,rows:controlRows}).find((/** @type {any} */ r) => r.horizonDays === input.horizonDays);
      if (!a || !b || a.mean == null || b.mean == null) return {available:false,code:'forecast_horizon_missing'};
      const binary = ['risk','survival_probability'].includes(a.type);
      if (!binary && a.type !== 'continuous') return {available:false,code:'forecast_rate_not_binary_risk'};
      if (!binary && (a.outcomeVariance == null || b.outcomeVariance == null)) return {available:false,code:'predictive_outcome_variance_missing'};
      const truth = binary ? {controlRate:b.type === 'risk' ? b.mean : 1-b.mean,treatmentRate:a.type === 'risk' ? a.mean : 1-a.mean}
        : {effect:a.mean-b.mean,sd:Math.sqrt((Number(a.outcomeVariance)+Number(b.outcomeVariance))/2)};
      let prognostic = null, validation = null;
      if (input.prognosticEvaluationId) {
        validation = await artifacts.read(study,input.prognosticEvaluationId,actor);
        const validatedPrediction = validation.row.parent_id ? await artifacts.read(study,validation.row.parent_id,actor) : null;
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
        scenario:{design:{...(prognostic ? {} : {kind:'two_arm_fixed'}),allocation:input.allocation ?? .5},endpoint:{type:binary ? 'binary' : 'continuous'},truth,
          analysis:{alpha:input.alpha ?? .05,power:input.power ?? .9,sided:2},...(prognostic ? {prognostic} : {})},
        // Analytic design reads the frozen truth in its scenario, not a patient
        // file. The source forecasts and hashes remain in the job's checkpoint.
        inputs:[],
        detail:{forecastInputs:[{id:first.row.id,hash:first.row.sha256},{id:second.row.id,hash:second.row.sha256}],
          interpretation:'model_scenario_design',horizonDays:input.horizonDays,pairedSubjects:pairedSubjects.size,parameterUncertainty:'not_estimated',
          ...(validation ? {validation:{id:validation.row.id,hash:validation.row.sha256,dataClass:validation.content.dataClass,
            randomizationAt:input.randomizationAt,correlationMeaning:'heldout_predictive_correlation',clinicalQualification:false}} : {})}});
      return {available:true,jobId:queued.job.id,state:queued.job.state};
    },
    /** @param {any} study */
    async view(study) {
      return {records:await artifacts.list(study.id),providers:await providers.list().catch(() => []),
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
        const mismatch = row.scale && row.scale !== evidence.parameter || row.endpoint && row.endpoint !== evidence.endpoint_key
          || row.unit && row.unit !== evidence.unit || row.trialId && row.trialId !== evidence.precedent_id;
        comparisons.push({...row,trialId:evidence.precedent_id,endpoint:evidence.endpoint_key,scale:evidence.parameter,unit:evidence.unit,
          evidence:{id:evidence.id,sourceHash:longitudinalHash(evidence),record:evidence},
          issue:!verified ? 'actual_evidence_unverified' : mismatch ? 'target_identity_mismatch' : null,
          actual:verified && !mismatch && evidence.value != null && Number.isFinite(Number(evidence.value)) ? Number(evidence.value) : null});
      }
      const content = {schema:1,model:input.model ?? {},contract:'trial_effect_prediction',comparisons,
        split:input.split ?? {},trainingOverlap:input.trainingOverlap ?? 'unknown'};
      return longitudinalArtifactView(await artifacts.save(study,'trial_benchmark',content,
        {comparisons:comparisons.length,model:content.model,contract:content.contract}));
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
  events:{format:'csv',columns:['subject_id','event_id','revision','code','value','unit','occurred_at','recorded_at','available_at','kind','assertion','experiencer','medication_state','site'],
    example:['synthetic-001','lab-001','1','HbA1c','7.2','%','2026-01-01','2026-01-02','2026-01-02','measurement','affirmed','patient','unknown','synthetic-site']},
  prediction:{format:'json',schema:1,historyId:'<history id>',origin:'2026-01-02T00:00:00.000Z',subjectKeyMode:'source_identifier',
    endpoint:{code:'HbA1c',type:'continuous',unit:'%'},horizonsDays:[90],model:{name:'external-model',version:'unknown'},
    rows:[{subjectKey:'synthetic-001',horizonDays:90,point:7,sd:.5,uncertainty:'predictive',quantiles:[{p:.05,value:6.2},{p:.95,value:7.8}]}]},
});
