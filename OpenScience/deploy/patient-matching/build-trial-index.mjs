/** Operator-only public-registry build; provider billing stays in the control-plane ledger. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ControlPlaneDatabase } from '../../apps/server/src/controlPlaneDatabase.mjs';
import { UsageLedger, OPEN_COST_VALUE } from '../../apps/server/src/usageLedger.mjs';
import { patientMatchingConfiguration } from '../../apps/server/src/patientMatchingConfiguration.mjs';
import { createPatientMatchingModelPorts } from '../../apps/server/src/patientMatchingModels.mjs';
import { createPatientMatchingTrialResource } from '../../apps/server/src/patientMatchingTrialResource.mjs';
import { edgeFetch } from '../../apps/server/src/edgeProxy.mjs';

const fail = code => Object.assign(new Error('The operator trial-index build stopped.'), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,200}$/.test(value);
const money = value => Math.round(value * 100_000_000);
const validCap = value => typeof value === 'number' && Number.isSafeInteger(money(value)) && money(value) >= 1;

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Fixed operator capacity policy. The token estimate schedules work only; the usage ledger still prices measured provider tokens. */
export function createTrialIndexPacer({ fetchImpl = fetch, now = () => performance.now(), sleep = abortableDelay } = {}) {
  let tokenQueue = Promise.resolve(), requestQueue = Promise.resolve(), lastStart = -Infinity, dispatchedRequests = 0, admittedEstimatedTokens = 0;
  const admissions = [];
  const queued = (queue, operation, signal) => {
    const pending = queue.catch(() => {}).then(() => { signal?.throwIfAborted(); return operation(); });
    const observed = signal ? new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    }) : pending;
    return { pending, observed };
  };
  return {
    async beforeModel(envelope) {
      const signal = envelope.signal;
      const tokens = Math.ceil(envelope.input.texts.reduce((total, value) => total + Buffer.byteLength(value), 0) / 4) + 512;
      if (tokens > 800000) throw fail('trial_index_pacing_input_invalid');
      const { pending, observed } = queued(tokenQueue, async () => {
        while (!signal?.aborted) {
          signal?.throwIfAborted();
          const instant = now();
          while (admissions.length && admissions[0].at <= instant - 60000) admissions.shift();
          if (admissions.reduce((total, row) => total + row.tokens, 0) + tokens <= 800000) {
            admissions.push({ at: instant, tokens }); admittedEstimatedTokens += tokens; return;
          }
          await sleep(Math.max(1, admissions[0].at + 60000 - instant), signal);
        }
        signal?.throwIfAborted();
      }, signal);
      tokenQueue = pending.then(() => {}, () => {});
      return observed;
    },
    async fetch(input, init = {}) {
      const signal = init.signal;
      const { pending, observed } = queued(requestQueue, async () => {
        const delay = Math.max(0, lastStart + 500 - now());
        if (delay) await sleep(delay, signal);
        signal?.throwIfAborted();
        lastStart = now(); dispatchedRequests++;
        // The queue releases at dispatch, so provider latency does not serialize active requests.
        const response = Promise.resolve(fetchImpl(input, init));
        response.catch(() => {}); // An abort may reject the queue observer before the started fetch settles.
        return { response };
      }, signal);
      requestQueue = pending.then(() => {}, () => {});
      const result = await observed;
      return result.response;
    },
    snapshot: () => ({ requestsPerSecond: 2, estimatedInputTokensPerMinute: 800000, dispatchedRequests, admittedEstimatedTokens }),
  };
}
const usage = `Build/resume one protected public ClinicalTrials.gov index (a paid operator operation).

Required:
  --manifest PATH          Protected immutable trial-index manifest
  --postgres-config PATH   Private JSON with databaseUrl for the selected control-plane database
  --provider-config PATH   Private JSON with dashscope.key_file (absolute path)
  --actor-id ID            Existing billing account that owns the selected project
  --project-id ID          Existing, non-archived project
Optional:
  --max-cost-cny NUMBER    Cumulative cap for this account/project/resource/profile (default: 10)
  --account-max-cost-cny N Account daily/weekly cap shared with other kernel calls (default: 10)
  --campaign-budget PATH  Optional shared multi-provider campaign budget (CNY 500)
  --offset INTEGER         First NDJSON record offset (default: 0; stored vectors are reused)
  --concurrency INTEGER    Concurrent resource chunks, from 1 to 4 (default: 4)
  --embedding-endpoint URL Explicit HTTPS endpoint; default is the pinned Beijing endpoint
  --help                   Show this help without opening files, databases or providers
`;

/** No environment-derived model/credential/database selection. */
export function parseTrialIndexArguments(argv) {
  const names = new Set(['manifest', 'postgres-config', 'provider-config', 'actor-id', 'project-id', 'max-cost-cny', 'account-max-cost-cny', 'campaign-budget', 'offset', 'concurrency', 'embedding-endpoint']);
  const values = {};
  for (let at = 0; at < argv.length; at++) {
    const option = argv[at];
    if (option === '--help' && argv.length === 1) return { help: true };
    const name = option.startsWith('--') ? option.slice(2) : '';
    if (!names.has(name) || Object.hasOwn(values, name) || !argv[at + 1] || argv[at + 1].startsWith('--')) throw fail('trial_index_arguments_invalid');
    values[name] = argv[++at];
  }
  for (const name of ['manifest', 'postgres-config', 'provider-config', 'actor-id', 'project-id']) if (!values[name]) throw fail('trial_index_arguments_invalid');
  const maxCostCny = Number(values['max-cost-cny'] ?? 10), accountMaxCostCny = Number(values['account-max-cost-cny'] ?? 10), offset = Number(values.offset ?? 0), concurrency = Number(values.concurrency ?? 4);
  if (!identifier(values['actor-id']) || !identifier(values['project-id']) || !validCap(maxCostCny) || !validCap(accountMaxCostCny)
    || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw fail('trial_index_arguments_invalid');
  return { manifestPath: path.resolve(values.manifest), postgresConfigPath: path.resolve(values['postgres-config']), providerConfigPath: path.resolve(values['provider-config']),
    actorId: values['actor-id'], projectId: values['project-id'], maxCostCny, accountMaxCostCny, offset, concurrency, embeddingEndpoint: values['embedding-endpoint'],
    campaignBudgetPath: values['campaign-budget'] ? path.resolve(values['campaign-budget']) : null };
}

/** Refuse symlinks, writable shared configuration, and readable shared credentials. */
async function protectedText(filename, { secret = false, maxBytes = 65536 } = {}) {
  let handle;
  try {
    handle = await fsp.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes || (stat.mode & (secret ? 0o077 : 0o022)) !== 0) throw fail('trial_index_configuration_invalid');
    return await handle.readFile('utf8');
  } catch { throw fail('trial_index_configuration_invalid'); }
  finally { await handle?.close(); }
}

async function ownedProject(database, actorId, projectId) {
  const result = await database.query(`SELECT p.id FROM evimed_control.projects p
    JOIN evimed_control.users u ON u.id=p.user_id
    WHERE p.user_id=$1 AND p.id=$2 AND p.archived_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM evimed_control.deleted_users d WHERE d.id=u.id)`, [actorId, projectId]);
  if (result.rows.length !== 1) throw fail('trial_index_project_access_denied');
}

/** A reservation fence, not another billing store. Expired/unresolved calls remain conservatively counted.
 * The existing ledger reserves and settles on the same owned PostgreSQL transaction client.
 */
export function createTrialIndexBudgetLedger({ database, ledger, actorId, projectId, taskId, maxCostCny, signal, campaignBudget = null }) {
  if (!validCap(maxCostCny)) throw fail('trial_index_arguments_invalid');
  let exhausted = false;
  const committed = async client => {
    const result = await client.query(`SELECT coalesce(sum(CASE WHEN status='settled' THEN coalesce(actual_cost,reserved_cost)
      WHEN status IN ('reserved','uncertain') THEN ${OPEN_COST_VALUE} ELSE 0 END),0) AS committed
      FROM evimed_usage.model_requests WHERE user_id=$1 AND project_id=$2 AND task_id=$3 AND module='patient-matching'`, [actorId, projectId, taskId]);
    const amount = Number(result.rows[0]?.committed);
    if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(money(amount))) throw fail('trial_index_ledger_invalid');
    return amount;
  };
  return {
    exhausted: () => exhausted,
    committed: () => committed(database),
    async reserveModel(input) {
      signal?.throwIfAborted();
      if (input.userId !== actorId || input.projectId !== projectId || input.taskId !== taskId || input.module !== 'patient-matching'
        || input.purpose !== 'kernel' || input.operation !== 'patient-matching-embedding' || input.runId != null || input.currency !== 'CNY'
        || !Number.isFinite(input.estimatedCost) || input.estimatedCost < 0 || !Number.isSafeInteger(money(input.estimatedCost))) throw fail('trial_index_ledger_scope_invalid');
      return database.transaction(client => database.withTransactionClient(client, async () => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`trial-index-budget:${actorId}:${projectId}:${taskId}`]);
        signal?.throwIfAborted();
        await ownedProject(database, actorId, projectId);
        if (money(await committed(client)) + money(input.estimatedCost) > money(maxCostCny)) {
          exhausted = true;
          throw fail('trial_index_budget_exhausted');
        }
        if (campaignBudget) {
          try { await campaignBudget.reserve({ id: input.id, provider: 'dashscope', maxCostCny: input.estimatedCost, taskId, operation: input.operation }); }
          catch { exhausted = true; throw fail('trial_index_budget_exhausted'); }
        }
        try { return await ledger.reserveModel(input); }
        catch (error) { if (['usage_budget_exceeded', 'usage_module_budget_exceeded'].includes(error?.code)) exhausted = true;
          if (campaignBudget) await campaignBudget.settle({ id: input.id, costCny: 0 }); throw error; }
      }));
    },
    async settleModel(userId, id, input) {
      const result = await ledger.settleModel(userId, id, input);
      if (campaignBudget) await campaignBudget.settle({ id, costCny: input.actualCost });
      return result;
    },
    async release(userId, id, reason) {
      const result = await ledger.release(userId, id, reason);
      if (campaignBudget) await campaignBudget.settle({ id, costCny: 0 });
      return result;
    },
    async markUncertain(userId, id, reason, input) {
      const result = await ledger.markUncertain(userId, id, reason, input);
      if (campaignBudget) await campaignBudget.settle({ id, costCny: input?.estimatedCost ?? 0, uncertain: true });
      return result;
    },
  };
}

/** Inject factories to verify control flow without a paid call. The default factories are the SaaS ports. */
export async function runTrialIndexBuild({ database, ledger, manifestPath, actorId, projectId, config = {}, maxCostCny = 10, accountMaxCostCny = 10, offset = 0, concurrency = 1, signal, onProgress = () => {}, fetchImpl = fetch, campaignBudget = null },
  { createModels = createPatientMatchingModelPorts, createResource = createPatientMatchingTrialResource } = {}) {
  if (!identifier(actorId) || !identifier(projectId) || !validCap(maxCostCny) || !validCap(accountMaxCostCny) || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw fail('trial_index_arguments_invalid');
  signal?.throwIfAborted();
  const externalSignal = signal, controller = new AbortController();
  signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  await ownedProject(database, actorId, projectId);
  const manifestBytes = await protectedText(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const profile = patientMatchingConfiguration(config, {});
  if (profile.embeddingDimensions !== 1024) throw fail('trial_index_profile_invalid');
  const taskId = `trial-index:${hash(JSON.stringify({ actorId, projectId, collectionId: manifest.collectionId, source: manifest.recordsSha256, expected: manifest.expectedRecords,
    endpoint: profile.embeddingApiBase, model: profile.embeddingModel, dimensions: profile.embeddingDimensions, revision: profile.revision }))}`;
  await ledger.health();
  const budget = createTrialIndexBudgetLedger({ database, ledger, actorId, projectId, taskId, maxCostCny, signal, campaignBudget });
  const scope = Object.freeze({ tenantId: actorId, actorId, projectId });
  const origin = Object.freeze({ kind: 'operator-public-trial-index', actorId, projectId, taskId });
  const authorize = async envelope => {
    signal?.throwIfAborted();
    if (envelope.operatorBuild !== true || envelope.scope !== scope || envelope.origin !== origin || envelope.input.taskId !== taskId) throw fail('trial_index_project_access_denied');
    await ownedProject(database, actorId, projectId);
    return { userId: actorId, projectId, runId: null };
  };
  const pacer = createTrialIndexPacer({ fetchImpl });
  const models = createModels({ config: { ...config, patientMatchingProfile: profile, requireDurableUsageLedger: true, production: true,
    userDailySpendLimit: accountMaxCostCny, userWeeklySpendLimit: accountMaxCostCny }, usageLedger: budget,
    authorize: async (envelope, action) => {
      if (action.operation !== 'embedding' || action.destination !== new URL(profile.embeddingApiBase).origin) throw fail('trial_index_model_access_denied');
      return authorize(envelope);
    }, fetchImpl: pacer.fetch });
  const embed = models.embed.bind(models);
  models.embed = async envelope => { await pacer.beforeModel(envelope); return embed(envelope); };
  const resource = await createResource({ manifestPath, database, models, authorize });
  if (!resource) throw fail('trial_index_resource_unavailable');
  if (await protectedText(manifestPath) !== manifestBytes) throw fail('trial_index_resource_changed');
  let last = null, nextOffset = offset, stopped = null, ready = false;
  const completed = new Set();
  const resumeOffset = () => { let at = offset; while (completed.has(at)) at += 1000; return at; };
  const stop = code => { if (!stopped) { stopped = code; controller.abort(fail(code)); } };
  const finish = async (status, code = null) => ({ status, ...(code ? { code } : {}), taskId, offset: resumeOffset(),
    indexed: last?.indexed ?? null, expected: last?.expected ?? null, generation: last?.generation ?? null,
    embeddingProfileDigest: models.embeddingProfileDigest, dimensions: 1024, maxCostCny, accountMaxCostCny, concurrency, pacing: pacer.snapshot(), committedCny: await budget.committed() });
  async function worker() {
    while (!signal.aborted && !ready && nextOffset < manifest.expectedRecords) {
      const currentOffset = nextOffset, chunkStarted = performance.now(); nextOffset += 1000;
      try {
        const result = await resource.build({ scope, origin, operatorBuild: true, input: { offset: currentOffset, taskId }, signal });
        if (externalSignal?.aborted || stopped) return;
        if (!['complete', 'partial'].includes(result?.status)) { stop(budget.exhausted() ? 'trial_index_budget_exhausted' : 'trial_index_build_unsupported'); return; }
        const data = result.data;
        if (!data || !Number.isSafeInteger(data.indexed) || !Number.isSafeInteger(data.expected) || data.expected !== manifest.expectedRecords || data.indexed < 0 || data.indexed > data.expected
          || typeof data.generation !== 'string' || data.embeddingProfileDigest !== models.embeddingProfileDigest || data.dimensions !== 1024
          || last && last.generation !== data.generation
          || result.status === 'complete' && (data.state !== 'ready' || data.indexed !== data.expected)) { stop('trial_index_progress_invalid'); return; }
        if (!last || data.indexed >= last.indexed) last = data;
        completed.add(currentOffset);
        ready ||= result.status === 'complete';
        onProgress({ ...await finish(result.status), completedChunkOffset: currentOffset,
          chunkRecords: Math.min(1000, manifest.expectedRecords - currentOffset), chunkDurationMs: Math.round(performance.now() - chunkStarted) });
      } catch { if (!externalSignal?.aborted && !stopped) stop('trial_index_build_failed'); return; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (externalSignal?.aborted) return finish('interrupted', 'trial_index_interrupted');
  if (stopped) return finish('stopped', stopped);
  return ready ? finish('complete') : finish('stopped', 'trial_index_incomplete');
}

/** The shared database emits diagnostic error messages. This private operator pool must never echo a URL or server body. */
export function redactOperatorDatabaseErrors(database) {
  const redact = error => { error.code = 'trial_index_database_unavailable'; error.message = 'The selected database is unavailable.'; };
  database.pool.prependListener('error', redact);
  database.pool.on('connect', client => client.prependListener('error', redact));
}

async function main(argv) {
  const options = parseTrialIndexArguments(argv);
  if (options.help) { process.stdout.write(usage); return; }
  const [postgresText, providerText] = await Promise.all([
    protectedText(options.postgresConfigPath, { secret: true }), protectedText(options.providerConfigPath, { secret: true }),
  ]);
  const postgres = JSON.parse(postgresText), providers = JSON.parse(providerText), dashscope = providers.dashscope;
  if (typeof postgres.databaseUrl !== 'string' || !path.isAbsolute(dashscope?.key_file ?? '')) throw fail('trial_index_configuration_invalid');
  const databaseUrl = new URL(postgres.databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname || !databaseUrl.pathname.slice(1) || databaseUrl.hash) throw fail('trial_index_configuration_invalid');
  const dashscopeApiKey = (await protectedText(dashscope.key_file, { secret: true, maxBytes: 8192 })).trim();
  if (!dashscopeApiKey || /\s|\0/.test(dashscopeApiKey)) throw fail('trial_index_configuration_invalid');
  const config = { dashscopeApiKey, ...(options.embeddingEndpoint ? { vcrMatchEmbeddingApiBase: options.embeddingEndpoint } : {}) };
  const endpoint = new URL(patientMatchingConfiguration(config, {}).embeddingApiBase);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw fail('trial_index_configuration_invalid');
  let fetchImpl = fetch;
  const proxyValue = dashscope.fetchProxy ?? providers.fetchProxy;
  if (proxyValue !== undefined) {
    const proxy = new URL(proxyValue);
    if (!['https:', 'http:'].includes(proxy.protocol) || proxy.pathname !== '/' || proxy.search || proxy.hash) throw fail('trial_index_configuration_invalid');
    const credentials = proxy.username ? `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}` : '';
    proxy.username = ''; proxy.password = '';
    const edge = { url: proxy, authorization: credentials ? `Basic ${Buffer.from(credentials).toString('base64')}` : '', hosts: new Set([endpoint.hostname]), connectTimeoutMs: 10000 };
    fetchImpl = (url, init) => edgeFetch(edge, url, init);
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort(fail('trial_index_interrupted'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const database = new ControlPlaneDatabase({ databaseUrl: postgres.databaseUrl, databasePoolMax: 3, databaseConnectionTimeoutMs: 10000 });
  redactOperatorDatabaseErrors(database);
  try {
    const campaignBudget = options.campaignBudgetPath
      ? (await import('../../evals/patient-matching-plugin/campaign-budget.mjs')).createCampaignBudget({ path: options.campaignBudgetPath, limitCny: 500 }) : null;
    const result = await runTrialIndexBuild({ ...options, database, ledger: new UsageLedger(database), config, signal: controller.signal, fetchImpl, campaignBudget,
      onProgress: progress => process.stdout.write(`${JSON.stringify({ kind: 'trial-index-progress', ...progress })}\n`) });
    process.stdout.write(`${JSON.stringify({ kind: 'trial-index-result', ...result })}\n`);
    if (result.status !== 'complete') process.exitCode = result.status === 'interrupted' ? 130 : 2;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); await database.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('trial-index-result: trial_index_operator_failed (configuration, ownership, database or provider unavailable)\n');
    process.exitCode = 2;
  });
}
