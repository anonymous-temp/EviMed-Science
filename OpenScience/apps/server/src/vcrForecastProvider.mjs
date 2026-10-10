/** Deployment-owned cloud prediction adapters. A model card cannot supply a URL
 * or credentials. Requests are minimally projected, bounded and idempotent by
 * batch where the provider supports it; unknown versions remain unknown. */
import fs from 'node:fs/promises';
import { longitudinalHash } from './vcrLongitudinalStore.mjs';
import { requireCloudPermission, cloudOrigin } from './vcrCloudProjection.mjs';
import { HttpError } from './security.mjs';

/** @param {any} value */
const positive = value => Number.isFinite(value) && value > 0;
/** @param {{file?:string,fetchImpl?:typeof fetch,now?:()=>Date}} [options] */
export function createForecastProviders({file = '',fetchImpl = fetch,now = () => new Date()} = {}) {
  /** Configuration is reread for every batch so disable/rollback takes effect on
   * queued work as well. Existing results keep their actual version. */
  async function configured() {
    if (!file) return [];
    const value = JSON.parse(await fs.readFile(file,'utf8'));
    if (!Array.isArray(value.providers)) throw new TypeError('Forecast providers must be a list.');
    return value.providers.filter((/** @type {any} */ p) => p && typeof p.id === 'string' && cloudOrigin(p.url)
      && p.protocol === 'evimed-event-history-v1' && p.enabled === true);
  }
  return {
    async list() {
      return (await configured()).map((/** @type {any} */ p) => ({id:p.id,name:p.name ?? p.id,model:p.model ?? 'unknown',
        version:p.version ?? 'unknown',availability:'configured_api',destination:cloudOrigin(p.url),
        endpoints:p.endpoints ?? [],maxHorizonDays:p.maxHorizonDays ?? null,termsReference:p.termsReference ?? null,
        trainingOverlap:p.trainingOverlap ?? 'unknown',apiEvidence:p.apiEvidence ?? null,seedSupported:p.seedSupported === true}));
    },
    /** @param {string} id */
    async require(id) {
      const provider = (await configured()).find((/** @type {any} */ p) => p.id === id);
      if (!provider) throw new HttpError(409,'vcr_forecast_provider_unavailable','No callable cloud model is configured for this prediction. Imported predictions and other research remain available.');
      return provider;
    },
    /** @param {{providerId:string,history:any,endpoint:any,horizonsDays:number[],scenario?:any,seed:number,samples?:number,
     * jobId:string,budgetMs?:number,permissions:()=>Promise<any[]>,onBatch:(content:any)=>Promise<void>,isCanceled:()=>Promise<boolean>,
     * beginBatch?:(batch:any)=>Promise<any>,finishBatch?:(batch:any)=>Promise<void>}} input */
    async predict(input) {
      const selected = await this.require(input.providerId);
      if (selected.endpoints?.length && !selected.endpoints.includes(input.endpoint.code)) throw new HttpError(422,'vcr_forecast_endpoint_unsupported','This provider does not expose the requested endpoint.');
      if (!input.horizonsDays?.length || input.horizonsDays.some(h => !positive(h) || positive(selected.maxHorizonDays) && h > selected.maxHorizonDays)) throw new HttpError(422,'vcr_forecast_horizon_unsupported','The requested horizon is not supported by this provider.');
      const subjects = [...new Set(input.history.events.map((/** @type {any} */ e) => e.subjectKey))];
      const batchSize = Math.min(1000,Math.max(1,Number(selected.batchSize) || 100));
      const timeoutMs = Math.min(60_000,Math.max(1000,Number(selected.timeoutMs) || 30_000));
      /** @type {any[]} */ const rows = [], receipts = [], failures = [];
      const operationStarted = Date.now();
      for (let offset=0;offset<subjects.length;offset+=batchSize) {
        if (await input.isCanceled()) break;
        if (Date.now()-operationStarted >= (input.budgetMs ?? 120_000)) {failures.push({offset,code:'forecast_time_budget'});break;}
        const provider = await this.require(input.providerId);
        const reportedSpend = receipts.reduce((sum,r) => sum+(r.costCurrency === provider.costCurrency && Number.isFinite(r.cost) ? r.cost : 0),0);
        if (positive(provider.maxJobCost) && reportedSpend + (Number(provider.estimatedBatchCost) || 0) > provider.maxJobCost) {failures.push({offset,code:'forecast_cost_budget',reportedSpend});break;}
        if (longitudinalHash(provider) !== longitudinalHash(selected)) { failures.push({offset,code:'provider_configuration_changed'}); break; }
        const permissions = await input.permissions();
        for (const permission of permissions) requireCloudPermission(permission,[String(cloudOrigin(provider.url))],now().toISOString());
        const keys = new Set(subjects.slice(offset,offset+batchSize));
        // No source text, row addresses, original identifiers, medication prose or
        // inferred concept labels leave through a numerical prediction adapter.
        const events = input.history.events.filter((/** @type {any} */ e) => keys.has(e.subjectKey) && !e.conflict
          && (provider.inputCodes?.length ? provider.inputCodes.includes(e.code) : e.code === input.endpoint.code))
          .map((/** @type {any} */ e) => ({subjectKey:e.subjectKey,code:e.code,value:e.value,unit:e.unit,occurredAt:e.occurredAt,
            availableAt:e.availableAt,kind:e.kind,assertion:e.assertion,experiencer:e.experiencer,medicationState:e.medicationState}));
        const body = {schema:1,origin:input.history.asOf,model:provider.model,version:provider.version ?? null,
          endpoint:input.endpoint,horizonsDays:input.horizonsDays,events,scenario:input.scenario ?? null,
          ...(provider.seedSupported ? {seed:input.seed} : {}),samples:input.samples ?? null};
        const requestDigest = longitudinalHash(body), started = Date.now();
        if (Buffer.byteLength(JSON.stringify(body)) > 8*1024*1024) {failures.push({offset,code:'provider_request_too_large'});continue;}
        const previous = await input.beginBatch?.({offset,requestDigest,body,providerDigest:longitudinalHash(provider)});
        if (previous?.response) {rows.push(...previous.response.rows);receipts.push(previous.receipt);continue;}
        if (previous?.pending && provider.idempotencySupported !== true) {failures.push({offset,code:'provider_outcome_unknown_no_replay'});continue;}
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
          if (response.body) for await (const chunk of /** @type {any} */ (response.body)) { length += chunk.length; if (length > limit) {controller.abort();throw Object.assign(new Error('Prediction response too large.'),{code:'provider_response_too_large'});} chunks.push(chunk); }
          const answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (answer.schema !== 1 || answer.origin !== body.origin || longitudinalHash(answer.endpoint) !== longitudinalHash(body.endpoint)
            || !Array.isArray(answer.rows) || answer.rows.some((/** @type {any} */ r) => !r || !keys.has(r.subjectKey))) throw Object.assign(new Error('Prediction identity mismatch.'),{code:'provider_response_invalid'});
          const receipt = {offset,subjects:keys.size,requestDigest,responseDigest:longitudinalHash(answer),
            provider:provider.id,requestedModel:provider.model,requestedVersion:provider.version ?? 'unknown',
            actualModel:answer.model ?? 'unknown',actualVersion:answer.version ?? 'unknown',
            seed:provider.seedSupported ? input.seed : null,seedSupported:provider.seedSupported === true,
            durationMs:Date.now()-started,cost:typeof answer.cost === 'number' && answer.cost >= 0 ? answer.cost : null,
            costCurrency:answer.costCurrency ?? null,usage:answer.usage ?? null};
          const changed = provider.version && answer.version && provider.version !== answer.version ? 'provider_version_mismatch'
            : provider.model && answer.model && provider.model !== answer.model ? 'provider_model_mismatch'
              : receipts.some(r => answer.version && r.actualVersion !== 'unknown' && r.actualVersion !== answer.version) ? 'provider_version_changed' : null;
          if (changed) {
            receipts.push({...receipt,accepted:false});failures.push({offset,code:changed});
            await input.onBatch({rows:[...rows],receipts:[...receipts],failures:[...failures],rawRequest:body,rawResponse:answer,offset});
            break;
          }
          await input.finishBatch?.({offset,requestDigest,response:answer,receipt});
          rows.push(...answer.rows); receipts.push(receipt);
          await input.onBatch({rows:[...rows],receipts:[...receipts],failures:[...failures],rawRequest:body,rawResponse:answer,offset});
        } catch (error) {
          failures.push({offset,code:await input.isCanceled() ? 'canceled' : String(/** @type {any} */ (error)?.code ?? 'provider_request_failed')});
          // A transport failure cannot prove the provider did not charge. Automatic
          // replay is supported only by a provider's stable idempotency contract.
          await input.onBatch({rows:[...rows],receipts:[...receipts],failures:[...failures],offset});
        } finally { clearTimeout(deadline); clearInterval(poll); }
      }
      return {rows,receipts,failures,provider:{id:selected.id,model:selected.model,version:selected.version ?? 'unknown'}};
    },
  };
}
