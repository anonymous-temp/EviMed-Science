/** The local forecast provider: a batch of people's own histories turned into one forecast per person by the engine, inside the deployment.
 *
 * Two built-in providers, `evimed-individualize-linear-mixed` (a linear mixed model of a continuous endpoint) and
 * `evimed-individualize-beta-logit` (the Alzheimer ADAS-cog 11 model's individual posterior). Both are the engine's `forecast.individualize` and
 * both declare `conditioning: history`, so the claim of the result is the individualized one, worded by what the frozen R33 evaluation found for
 * the method that ran (`individualizationMethod`).
 *
 * Hidden knowledge:
 *
 * - **Nothing leaves the deployment, so there is no cloud permission to hold.** The events the batch projected (study pseudonyms, the endpoint's
 *   unit, cut at the origin) are written under the data plane's `views` tree, the same place a snapshot's engine views live, and handed to an
 *   engine job; the grant of every history is still re-read before the job is queued (`permissions`), because a withdrawn grant stops the work.
 * - **The forecasts are a kept table of an ordinary engine job.** The job is filed out of every card's way (`experiment_candidate`, subject
 *   `individualize:<digest>`), keeps its lineage (`forecastLineage`: the sources and bindings of the history), so a withdrawn source makes its
 *   result unreadable, and its table `person-forecasts` is stored by the queue under `derived/`. What the provider reads back is that table,
 *   checked against the hash the result lists.
 * - **The wait is cancel-aware and bounded.** A cancel of the forecast job cancels the engine job; a spent time budget cancels it and says
 *   `forecast_time_budget`; a job that waits for a person to confirm CPU budget is cancelled and says so (`forecast_budget_unconfirmed`)
 *   rather than leave the forecast waiting on a confirmation nobody was asked for.
 * - **A person is accounted for whatever happened.** Persons the engine left out come back as rejected rows with its reason (`no_own_history`,
 *   `covariates_missing`, `score_out_of_range`); persons the projection rejected before are the projection's; persons a stopped job never
 *   reached are `unprocessed`; a failed job fails the batch with its error code.
 *
 * @module vcrLocalIndividualize
 */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { VCR_ENGINE_METHODS, validateForecast } from '@evimed/domain';
import { parseTable, studyRelative, toCsv, writeContentAddressed } from './vcrDataPlane.mjs';
import { HttpError } from './security.mjs';

const METHOD = 'forecast.individualize';
const DAY_MS = 86_400_000;
const POLL_MS = 400;
const QUANTILES = Object.freeze([{ p: 0.05, column: 'q05' }, { p: 0.25, column: 'q25' }, { p: 0.5, column: 'q50' }, { p: 0.75, column: 'q75' }, { p: 0.95, column: 'q95' }]);
/** The Alzheimer model's parameter set and the codes it reads about each person. */
const AD_PARAMETER_SET = Object.freeze({ id: 'camd-adas-cog-11', version: 'adsim-3.0' });
const AD_CODES = Object.freeze(['mmse', 'age', 'apoe4', 'female']);
/** @param {unknown} value @returns {Record<string,any>} */
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string,any>} */ (value) : {};
/** @param {unknown} value @returns {any[]} */
const list = value => Array.isArray(value) ? value : [];

/** The providers the deployment carries itself, with the engine method's version in them so a method change is a changed provider.
 * @returns {Record<string,any>[]} */
export function localForecastProviders() {
  const version = String(/** @type {Record<string,any>} */ (VCR_ENGINE_METHODS)[METHOD]?.version ?? '');
  return [
    { id: 'evimed-individualize-linear-mixed', name: 'Linear mixed model, updated by each person\'s own earlier values', local: true, enabled: true, family: 'linear_mixed',
      model: 'linear mixed model (empirical Bayes)', version, protocol: 'evimed-local-individualize-v1', conditioning: 'history', individualizationMethod: 'lmm_empirical_bayes',
      seedSupported: true, trainingOverlap: 'none', availability: 'local_engine' },
    { id: 'evimed-individualize-beta-logit', name: 'Alzheimer ADAS-cog 11 model, updated by each person\'s own earlier scores', local: true, enabled: true, family: 'beta_logit',
      model: 'ADAS-cog 11 beta-logit model (adsim 3.0, Laplace posterior)', version: `${version}+${AD_PARAMETER_SET.version}`, protocol: 'evimed-local-individualize-v1', conditioning: 'history',
      individualizationMethod: 'beta_logit_laplace', endpoints: ['adas_cog_11'], inputCodes: ['adas_cog_11', ...AD_CODES], seedSupported: true, trainingOverlap: 'unknown', availability: 'local_engine' },
  ];
}

/**
 * @param {{ jobs: any, store: any, dataPlane: any, sleep?: (ms:number) => Promise<void> }} deps
 */
export function createLocalIndividualizer({ jobs, store, dataPlane, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  return {
    /** Whether a batch can be computed here: the engine is wired and a data plane holds the tables. */
    available() { return Boolean(dataPlane && jobs?.engine?.configured?.()); },
    /**
     * @param {{ study: any, actor: string, jobId: string, requestDigest: string, provider: Record<string,any>, endpoint: {code:string,type:string,unit:string},
     *   horizonsDays: number[], origin: string, events: any[], keys: string[], seed: number|null, samples?: number|null, budgetMs: number,
     *   lineage: {snapshotIds:string[],sourceIds:string[],bindings:any[]}, valueSource: string, isCanceled: () => Promise<boolean> }} input
     * @returns {Promise<{ rows: any[], rejected: any[], receipt: Record<string,any>|null, failure: {code:string}|null, stopped: string|null,
     *   reached: Set<string>, diagnostics: Record<string,any> }>}
     */
    async run(input) {
      const { study, provider, endpoint } = input;
      const origin = Date.parse(input.origin);
      const lines = input.events.filter(event => Number.isFinite(Number(event.value)))
        .map(event => [event.subjectKey, event.code, Number(event.value), (Date.parse(event.occurredAt) - origin) / DAY_MS]);
      const root = dataPlane.root();
      const table = await writeContentAddressed(root, `${studyRelative(study.id)}/views/individualize`, 'csv', toCsv(['subject', 'code', 'value', 'day'], lines));
      const draws = Math.min(4000, Math.max(100, Number(input.samples) || 400));
      const scenario = { family: provider.family, inputId: `${input.jobId}:events`, endpoint: { type: 'continuous', code: endpoint.code, unit: endpoint.unit },
        horizonsDays: input.horizonsDays, ...(provider.family === 'beta_logit' ? { draws, parameterSet: { ...AD_PARAMETER_SET } } : {}) };
      const queued = await jobs.enqueue({ studyId: study.id, userId: study.userId, principal: input.actor, kind: 'individualize_forecast', scenario, internal: true,
        files: [{ kind: 'snapshot_file', id: scenario.inputId, location: table.location, hash: table.sha256, valueSource: input.valueSource }],
        seed: input.seed ?? null, cpuSecondsLimit: Math.min(600, Math.max(30, Math.ceil(input.budgetMs / 1000))), maxAttempts: 1,
        idempotencyKey: `individualize:${input.jobId}:${input.requestDigest}`,
        detail: { resultKind: 'experiment_candidate', subjectId: `individualize:${input.requestDigest.slice(0, 24)}`, keepTables: ['person-forecasts'],
          forecastLineage: { snapshotIds: input.lineage.snapshotIds, sourceIds: input.lineage.sourceIds, bindings: input.lineage.bindings }, forecastJobId: input.jobId } });
      const engineJob = queued.job;
      const started = Date.now();
      /** @type {any} */ let job = engineJob;
      /** @type {string|null} */ let stopped = null;
      while (!['succeeded', 'failed', 'canceled'].includes(job.state)) {
        if (job.state === 'awaiting_budget') { stopped = 'forecast_budget_unconfirmed'; break; }
        if (await input.isCanceled()) { stopped = 'canceled'; break; }
        if (Date.now() - started >= input.budgetMs) { stopped = 'forecast_time_budget'; break; }
        await sleep(POLL_MS);
        job = await jobs.get(study.id, engineJob.id) ?? job;
      }
      if (stopped) {
        await jobs.cancel(study.id, engineJob.id, { actor: input.actor }).catch(() => null);
        return { rows: [], rejected: [], receipt: null, failure: stopped === 'canceled' ? null : { code: stopped }, stopped, reached: new Set(), diagnostics: {} };
      }
      const fail = (/** @type {string} */ code) => ({ rows: [], rejected: [], receipt: null, failure: { code }, stopped: null, reached: new Set(), diagnostics: {} });
      if (job.state !== 'succeeded') return fail(String(object(job.error).code ?? 'forecast_engine_failed'));
      // a result that cannot be read (its lineage was withdrawn in the meantime) is not a forecast
      const result = await store.resultOfJob(study.id, engineJob.id);
      const kept = list(result?.tables).map(object).find(entry => entry.name === 'person-forecasts' && String(entry.location ?? '').startsWith('derived/') && /^[a-f0-9]{64}$/.test(String(entry.sha256 ?? '')));
      if (!result || !kept) return fail('forecast_result_unreadable');
      const bytes = await fs.readFile(dataPlane.resolve(String(kept.location))).catch(() => null);
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== kept.sha256) return fail('forecast_table_changed');
      const parsed = parseTable(bytes.toString('utf8'));
      const at = new Map(parsed.header.map((name, index) => [name, index]));
      const cell = (/** @type {string[]} */ row, /** @type {string} */ name) => String(row[/** @type {number} */ (at.get(name))] ?? '');
      /** @type {any[]} */ const candidates = [], rejected = [];
      const reached = new Set();
      for (const row of parsed.rows) {
        const subjectKey = cell(row, 'subject'), horizonDays = Number(cell(row, 'horizonDays')), status = cell(row, 'status');
        reached.add(subjectKey);
        if (status !== 'ok') { rejected.push({ subjectKey, horizonDays, codes: [status || 'no_forecast_returned'] }); continue; }
        candidates.push({ subjectKey, horizonDays, point: Number(cell(row, 'point')), sd: Number(cell(row, 'sd')),
          quantiles: QUANTILES.map(({ p, column }) => ({ p, value: Number(cell(row, column)) })), uncertainty: 'predictive', unit: endpoint.unit });
      }
      // a person the table never mentions (no event at all) has nothing of their own: the same reason, for every horizon
      const interrupted = object(object(result.diagnostics).individualize).interrupted ?? null;
      if (!interrupted) {
        for (const key of input.keys) if (!reached.has(key)) {
          reached.add(key);
          for (const horizonDays of input.horizonsDays) rejected.push({ subjectKey: key, horizonDays, codes: ['no_own_history'] });
        }
      }
      const checked = validateForecast({ origin: input.origin, endpoint, horizonsDays: input.horizonsDays, rows: candidates }, { subjects: new Set(input.keys), origin: input.origin });
      const diagnostics = object(object(result.diagnostics).individualize);
      const receipt = { offset: 0, subjects: input.keys.length, requestDigest: input.requestDigest, responseDigest: String(kept.sha256),
        provider: provider.id, requestedModel: provider.model, requestedVersion: provider.version, actualModel: provider.model, actualVersion: provider.version,
        seed: input.seed ?? null, seedSupported: true, durationMs: Date.now() - started, cost: null, costCurrency: null, usage: null,
        receivedRows: candidates.length, acceptedRows: checked.rows.length, invalidRows: candidates.length - checked.rows.length, rowIssues: checked.issues,
        engineJobId: engineJob.id, engineResultId: result.id ?? null, engineMethodVersion: String(job.methodVersion ?? ''), local: true };
      return { rows: checked.rows, rejected: [...rejected, ...(checked.rejected ?? [])], receipt, failure: null, stopped: interrupted ? String(interrupted) : null, reached,
        diagnostics: { forecastPeople: diagnostics.forecastPeople ?? null, laplaceNotTrusted: Number(diagnostics.laplaceNotTrusted ?? 0), fit: diagnostics.fit ?? null } };
    },
  };
}

/** Refuse a local batch the provider cannot run, by name. @param {Record<string,any>} provider @param {{code:string,type:string}} endpoint */
export function localEndpointIssue(provider, endpoint) {
  if (endpoint.type !== 'continuous') return new HttpError(422, 'vcr_forecast_endpoint_unsupported', 'This provider forecasts a continuous endpoint.');
  if (provider.family === 'beta_logit' && !list(provider.endpoints).includes(endpoint.code)) return new HttpError(422, 'vcr_forecast_endpoint_unsupported', 'This provider does not expose the requested endpoint.');
  return null;
}
