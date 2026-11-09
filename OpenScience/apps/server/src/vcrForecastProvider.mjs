/** Deployment-owned cloud prediction adapters. A model card cannot supply a URL
 * or credentials. Requests are minimally projected, bounded and idempotent by
 * batch where the provider supports it; unknown versions remain unknown. */
import fs from 'node:fs/promises';
import { validateForecast, longitudinalSubjects } from '@evimed/domain';
import { longitudinalHash } from './vcrLongitudinalStore.mjs';
import { requireCloudPermission, cloudOrigin } from './vcrCloudProjection.mjs';
import { HttpError } from './security.mjs';
import { actionContext, assessProviderUse, projectBatch, providerInputSpec, reconcileSubjects, uncertaintyProvenance } from './vcrTrajectoryBatch.mjs';
import { localEndpointIssue, localForecastProviders } from './vcrLocalIndividualize.mjs';

/** @param {any} value */
const positive = value => Number.isFinite(value) && value > 0;
/** `local` is the deployment's own individualizer (`createLocalIndividualizer`): with it the built-in local providers exist beside the configured
 * cloud ones, and a configuration entry with one of their ids and `enabled: false` switches that one off.
 * @param {{file?:string,fetchImpl?:typeof fetch,now?:()=>Date,local?:ReturnType<typeof import('./vcrLocalIndividualize.mjs').createLocalIndividualizer>|null}} [options] */
export function createForecastProviders({file = '',fetchImpl = fetch,now = () => new Date(),local = null} = {}) {
  /** Configuration is reread for every batch so disable/rollback takes effect on
   * queued work as well. Existing results keep their actual version. */
  async function configured() {
    const value = file ? JSON.parse(await fs.readFile(file,'utf8')) : {providers:[]};
    if (!Array.isArray(value.providers)) throw new TypeError('Forecast providers must be a list.');
    const switchedOff = new Set(value.providers.filter((/** @type {any} */ p) => p && p.enabled === false).map((/** @type {any} */ p) => p.id));
    const own = local?.available() ? localForecastProviders().filter(p => !switchedOff.has(p.id)) : [];
    return [...value.providers.filter((/** @type {any} */ p) => p && typeof p.id === 'string' && cloudOrigin(p.url)
      && p.protocol === 'evimed-event-history-v1' && p.enabled === true),...own];
  }
  return {
    async list() {
      return (await configured()).map((/** @type {any} */ p) => ({id:p.id,name:p.name ?? p.id,model:p.model ?? 'unknown',
        version:p.version ?? 'unknown',availability:p.local === true ? 'local_engine' : 'configured_api',destination:p.local === true ? null : cloudOrigin(p.url),
        endpoints:p.endpoints ?? [],maxHorizonDays:p.maxHorizonDays ?? null,termsReference:p.termsReference ?? null,
        trainingOverlap:p.trainingOverlap ?? 'unknown',apiEvidence:p.apiEvidence ?? null,seedSupported:p.seedSupported === true,
        conditioning:p.conditioning === 'history' || p.conditioning === 'baseline' ? p.conditioning : null,individualizationMethod:p.conditioning === 'history' ? p.individualizationMethod ?? null : null}));
    },
    /** @param {string} id */
    async require(id) {
      const provider = (await configured()).find((/** @type {any} */ p) => p.id === id);
      if (!provider) throw new HttpError(409,'vcr_forecast_provider_unavailable','No callable cloud model is configured for this prediction. Imported predictions and other research remain available.');
      return provider;
    },
    /** @param {{providerId:string,history:any,endpoint:any,horizonsDays:number[],scenario?:any,seed:number,samples?:number,
     * jobId:string,budgetMs?:number,permissions:()=>Promise<any[]>,onBatch:(content:any)=>Promise<void>,isCanceled:()=>Promise<boolean>,
     * beginBatch?:(batch:any)=>Promise<any>,finishBatch?:(batch:any)=>Promise<void>,
     * prediction?:{predictionMode?:string,actions?:any[],actionSource?:string},
     * local?:{study:any,actor:string,lineage:any,valueSource:string}}} input */
    async predict(input) {
      const selected = await this.require(input.providerId);
      if (selected.local === true) {const issue = localEndpointIssue(selected,input.endpoint);if (issue) throw issue;}
      if (selected.endpoints?.length && !selected.endpoints.includes(input.endpoint.code)) throw new HttpError(422,'vcr_forecast_endpoint_unsupported','This provider does not expose the requested endpoint.');
      if (!input.horizonsDays?.length || input.horizonsDays.some(h => !positive(h) || positive(selected.maxHorizonDays) && h > selected.maxHorizonDays)) throw new HttpError(422,'vcr_forecast_horizon_unsupported','The requested horizon is not supported by this provider.');
      const subjects = longitudinalSubjects(input.history);
      // The use check is the domain's one function: an execution issue refuses this prediction (a mode the provider cannot run, a
      // schedule that does not convert, a limit); what is only unvalidated is a premise of the result, never a refusal.
      const context = actionContext(input.prediction ?? {});
      const use = assessProviderUse(selected,{mode:context.mode,endpoint:input.endpoint,horizonsDays:input.horizonsDays,subjects:subjects.length});
      const refused = [...context.issues,...use.executionIssues.filter(i => i.field !== 'horizonHours')][0];
      if (refused) throw new HttpError(422,'vcr_forecast_unavailable',`This provider cannot run this prediction (${refused.code}); other research remains available.`);
      const spec = providerInputSpec(selected,input.endpoint);
      // Projection happens once for the whole batch so the list of people sent, and with it every offset, is stable across a restart.
      const projected = projectBatch({events:input.history.events,keys:subjects,origin:input.history.asOf,spec,endpoint:input.endpoint,context});
      /** @type {Map<string,any[]>} */ const eventsBy = new Map(), actionsBy = new Map();
      for (const e of projected.events) {if (!eventsBy.has(e.subjectKey)) eventsBy.set(e.subjectKey,[]);eventsBy.get(e.subjectKey)?.push(e);}
      for (const a of projected.actions) {if (!actionsBy.has(a.subjectKey)) actionsBy.set(a.subjectKey,[]);actionsBy.get(a.subjectKey)?.push(a);}
      const sendKeys = projected.sendKeys;
      const batchSize = Math.min(1000,Math.max(1,Number(selected.batchSize) || 100));
      const timeoutMs = Math.min(60_000,Math.max(1000,Number(selected.timeoutMs) || 30_000));
      /** @type {any[]} */ const rows = [], receipts = [], failures = [], rejected = [];
      /** @type {Array<{keys:string[],outcome:'done'|'failed',code?:string}>} */ const batches = [];
      /** @type {string|null} */ let stopped = null;
      const account = () => reconcileSubjects({subjects,horizonsDays:input.horizonsDays,preRejected:projected.rejected,rows,validationRejected:rejected,batches,unprocessedReason:stopped});
      /** @type {any[]} */ let premises = use.premises;
      const ctxLabel = {mode:context.mode,actionSource:context.actionSource,deployable:context.deployable,label:context.label};
      const extras = () => ({accounting:account(),premises,uncertainty:uncertaintyProvenance(rows),actionContext:ctxLabel,usesOwnHistory:spec.usesOwnHistory,
        // the method a history-conditioned provider names, so the claim's sentence can follow the evaluation that was run for it (R33)
        individualizationMethod:spec.usesOwnHistory === true ? selected.individualizationMethod ?? null : null,leakageDropped:projected.leakageDropped,unitDropped:projected.unitDropped ?? 0});
      const operationStarted = Date.now();
      if (selected.local === true) {
        // Nothing leaves the deployment: the batch is one engine job over the projected events, no cloud permission, no per-chunk request.
        if (!local || !input.local) throw new HttpError(409,'vcr_forecast_provider_unavailable','This prediction is computed by the platform\'s engine, which is not available here. Imported predictions and other research remain available.');
        await input.permissions();    // the grant of every history is read again; its cloud answer is not needed
        const requestDigest = longitudinalHash({events:projected.events,keys:sendKeys,endpoint:input.endpoint,horizonsDays:input.horizonsDays,provider:longitudinalHash(selected),seed:input.seed,samples:input.samples ?? null});
        const ran = sendKeys.length ? await local.run({study:input.local.study,actor:input.local.actor,jobId:input.jobId,requestDigest,provider:selected,endpoint:input.endpoint,
          horizonsDays:input.horizonsDays,origin:input.history.asOf,events:projected.events,keys:sendKeys,seed:input.seed,samples:input.samples,budgetMs:input.budgetMs ?? 120_000,
          lineage:input.local.lineage,valueSource:input.local.valueSource,isCanceled:input.isCanceled}) : null;
        if (ran?.failure) {failures.push({offset:0,code:ran.failure.code});batches.push({keys:sendKeys,outcome:'failed',code:ran.failure.code});}
        else if (ran) {
          stopped = ran.stopped;
          if (ran.receipt) {rows.push(...ran.rows);rejected.push(...ran.rejected);receipts.push(ran.receipt);batches.push({keys:sendKeys.filter(key => ran.reached.has(key)),outcome:'done'});}
          if (ran.stopped && ran.stopped !== 'canceled') failures.push({offset:0,code:ran.stopped});
          if (ran.receipt?.invalidRows) failures.push({offset:0,code:'provider_rows_invalid',rows:ran.receipt.invalidRows});
          // what a person reads beside the claim: how the model was fitted, where its time starts, and how many posteriors were approximated badly
          premises = [...premises,{code:selected.family === 'beta_logit' ? 'individual_week_zero' : 'individual_fit_on_batch'},
            ...(ran.diagnostics.laplaceNotTrusted > 0 ? [{code:'individual_laplace_untrusted',people:ran.diagnostics.laplaceNotTrusted}] : [])];
        }
        return {rows,rejected,receipts,failures,provider:{id:selected.id,model:selected.model,version:selected.version ?? 'unknown'},...extras()};
      }
      for (let offset=0;offset<sendKeys.length;offset+=batchSize) {
        if (await input.isCanceled()) {stopped = 'canceled';break;}
        if (Date.now()-operationStarted >= (input.budgetMs ?? 120_000)) {failures.push({offset,code:'forecast_time_budget'});stopped = 'forecast_time_budget';break;}
        const provider = await this.require(input.providerId);
        const reportedSpend = receipts.reduce((sum,r) => sum+(r.costCurrency === provider.costCurrency && Number.isFinite(r.cost) ? r.cost : 0),0);
        if (positive(provider.maxJobCost) && reportedSpend + (Number(provider.estimatedBatchCost) || 0) > provider.maxJobCost) {failures.push({offset,code:'forecast_cost_budget',reportedSpend});stopped = 'forecast_cost_budget';break;}
        if (longitudinalHash(provider) !== longitudinalHash(selected)) { failures.push({offset,code:'provider_configuration_changed'}); stopped = 'provider_configuration_changed'; break; }
        const permissions = await input.permissions();
        for (const permission of permissions) requireCloudPermission(permission,[String(cloudOrigin(provider.url))],now().toISOString());
        const chunk = sendKeys.slice(offset,offset+batchSize), keys = new Set(chunk);
        // No source text, row addresses, original identifiers, medication prose or inferred concept labels leave through a numerical
        // prediction adapter. What does leave is what the provider named (observation and action codes), cut at the origin.
        const events = chunk.flatMap(key => eventsBy.get(key) ?? []);
        const actions = chunk.flatMap(key => actionsBy.get(key) ?? []);
        const conditional = context.mode !== 'factual_forecast';
        const body = {schema:1,origin:input.history.asOf,model:provider.model,version:provider.version ?? null,
          endpoint:input.endpoint,horizonsDays:input.horizonsDays,subjects:[...keys],events,scenario:input.scenario ?? null,
          ...(conditional ? {predictionMode:context.mode,actions} : {}),
          ...(provider.seedSupported ? {seed:input.seed} : {}),samples:input.samples ?? null};
        const requestDigest = longitudinalHash(body), started = Date.now();
        if (Buffer.byteLength(JSON.stringify(body)) > 8*1024*1024) {failures.push({offset,code:'provider_request_too_large'});batches.push({keys:chunk,outcome:'failed',code:'provider_request_too_large'});continue;}
        const previous = await input.beginBatch?.({offset,requestDigest,body,providerDigest:longitudinalHash(provider)});
        if (previous?.response) {
          const checked = validateForecast({...body,rows:previous.response.rows},{subjects:keys,origin:body.origin});
          rows.push(...checked.rows);rejected.push(...(previous.rejected ?? checked.rejected ?? []));receipts.push(previous.receipt);batches.push({keys:chunk,outcome:'done'});
          if (previous.receipt?.invalidRows) failures.push({offset,code:'provider_rows_invalid',rows:previous.receipt.invalidRows});
          continue;
        }
        if (previous?.pending && provider.idempotencySupported !== true) {failures.push({offset,code:'provider_outcome_unknown_no_replay'});batches.push({keys:chunk,outcome:'failed',code:'provider_outcome_unknown_no_replay'});continue;}
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(),Math.min(timeoutMs,Math.max(1,(input.budgetMs ?? 120_000)-(Date.now()-operationStarted))));
        const poll = setInterval(() => { void input.isCanceled().then(cancel => { if (cancel) controller.abort(); }).catch(() => controller.abort()); },250);
        try {
          const token = provider.tokenFile ? (await fs.readFile(provider.tokenFile,'utf8')).trim() : '';
          const response = await fetchImpl(provider.url,{method:'POST',redirect:'error',signal:controller.signal,
            headers:{'content-type':'application/json',...(token ? {authorization:`Bearer ${token}`} : {}),
              ...(provider.idempotencySupported ? {'idempotency-key':`${input.jobId}:${offset}:${requestDigest}`} : {})},body:JSON.stringify(body)});
          if (!response.ok) throw Object.assign(new Error('Prediction request failed.'),{code:`provider_http_${response.status}`});
          const limit = Math.min(32*1024*1024,Math.max(1024,Number(provider.maxResponseBytes) || 8*1024*1024));
          if (Number(response.headers.get('content-length')) > limit) throw Object.assign(new Error('Prediction response too large.'),{code:'provider_response_too_large'});
          const chunks = []; let length = 0;
          if (response.body) for await (const part of /** @type {any} */ (response.body)) { length += part.length; if (length > limit) {controller.abort();throw Object.assign(new Error('Prediction response too large.'),{code:'provider_response_too_large'});} chunks.push(part); }
          const answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (answer.schema !== 1 || answer.origin !== body.origin || longitudinalHash(answer.endpoint) !== longitudinalHash(body.endpoint)
            || !Array.isArray(answer.rows)) throw Object.assign(new Error('Prediction identity mismatch.'),{code:'provider_response_invalid'});
          const checked = validateForecast({...body,rows:answer.rows},{subjects:keys,origin:body.origin});
          const receipt = {offset,subjects:keys.size,requestDigest,responseDigest:longitudinalHash(answer),
            provider:provider.id,requestedModel:provider.model,requestedVersion:provider.version ?? 'unknown',
            actualModel:answer.model ?? 'unknown',actualVersion:answer.version ?? 'unknown',
            seed:provider.seedSupported ? input.seed : null,seedSupported:provider.seedSupported === true,
            durationMs:Date.now()-started,cost:typeof answer.cost === 'number' && answer.cost >= 0 ? answer.cost : null,
            costCurrency:answer.costCurrency ?? null,usage:answer.usage ?? null,
            receivedRows:answer.rows.length,acceptedRows:checked.rows.length,invalidRows:answer.rows.length-checked.rows.length,
            rowIssues:checked.issues};
          const changed = provider.version && answer.version && provider.version !== answer.version ? 'provider_version_mismatch'
            : provider.model && answer.model && provider.model !== answer.model ? 'provider_model_mismatch'
              : receipts.some(r => answer.version && r.actualVersion !== 'unknown' && r.actualVersion !== answer.version) ? 'provider_version_changed' : null;
          if (changed) {
            receipts.push({...receipt,accepted:false});failures.push({offset,code:changed});batches.push({keys:chunk,outcome:'failed',code:changed});stopped = changed;
            await input.onBatch({rows:[...rows],rejected:[...rejected],receipts:[...receipts],failures:[...failures],...extras(),rawRequest:body,rawResponse:answer,offset});
            break;
          }
          await input.finishBatch?.({offset,requestDigest,response:{...answer,rows:checked.rows},rawResponse:answer,rejected:checked.rejected ?? [],receipt});
          rows.push(...checked.rows); rejected.push(...(checked.rejected ?? [])); receipts.push(receipt); batches.push({keys:chunk,outcome:'done'});
          if (receipt.invalidRows) failures.push({offset,code:'provider_rows_invalid',rows:receipt.invalidRows});
          await input.onBatch({rows:[...rows],rejected:[...rejected],receipts:[...receipts],failures:[...failures],...extras(),rawRequest:body,rawResponse:answer,offset});
        } catch (error) {
          const code = await input.isCanceled() ? 'canceled' : String(/** @type {any} */ (error)?.code ?? 'provider_request_failed');
          failures.push({offset,code});batches.push({keys:chunk,outcome:'failed',code});
          // A transport failure cannot prove the provider did not charge. Automatic
          // replay is supported only by a provider's stable idempotency contract.
          await input.onBatch({rows:[...rows],rejected:[...rejected],receipts:[...receipts],failures:[...failures],...extras(),offset});
        } finally { clearTimeout(deadline); clearInterval(poll); }
      }
      return {rows,rejected,receipts,failures,provider:{id:selected.id,model:selected.model,version:selected.version ?? 'unknown'},
        ...extras()};
    },
  };
}
