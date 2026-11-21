import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { isPeak, priceListAt, priceUsage, REFERENCE_PRICE_LIST } from '@evimed/domain';
import { HttpError } from './security.mjs';

// The bearer has already been resolved. This context never comes from the request body or the engine's model prompt.
const active = new AsyncLocalStorage();
export const withMemoryPayer = (payer, work) => active.run(payer, work);
export const memoryPayer = () => active.getStore() ?? null;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createMemoryBilling({ config, ledger, wallet, store }) {
  async function admit(payer) {
    if (!ledger) throw new HttpError(503, 'usage_ledger_unavailable', 'Memory usage accounting is unavailable.');
    const owner = await store.userById(payer.ownerId);
    if (!owner || owner.accountCreatedAt !== payer.generation) throw new HttpError(403, 'memory_scope_denied', 'The paying account changed.');
    await store.requireProject(owner, payer.projectId);
    await ledger.assertWithinLimits(owner.id, { dailyLimit: config.userDailySpendLimit, weeklyLimit: config.userWeeklySpendLimit });
    const credits = wallet();
    if (payer.chargeWallet && !credits) throw new HttpError(503, 'agent_memory_billing_unavailable', 'The account balance could not be verified.');
    if (payer.chargeWallet) {
      const allowed = await credits.assertBalanceForStart(owner.id, null);
      if (allowed.reason) throw new HttpError(503, 'agent_memory_billing_unavailable', 'The account balance could not be verified.');
    }
  }
  const nativeId = (payer, session) => (payer.chargeWallet ? 'amc_' : 'amu_') + hash([payer.ownerId, payer.generation, session, 'native']);
  async function reserveExtraction(payer, admission) {
    const id = nativeId(payer, admission.engineSession);
    const existing = await ledger.memoryReservation(payer.ownerId, payer.keyId, id);
    if (existing) return;
    await admit(payer);
    const at = new Date();
    const tokens = Buffer.byteLength(admission.text ?? '');
    const model = priceUsage({ resourceType: 'model', model: payer.model, cacheMiss: tokens,
      output: config.modelGatewayReservationMaxOutputTokens ?? 65536, peak: true });
    const embeddingEstimate = priceUsage({ resourceType: 'embedding', tokens, peak: true });
    await ledger.reserveModel({ id, runId: id, userId: payer.ownerId, projectId: payer.projectId, model: payer.model,
      priceVersion: REFERENCE_PRICE_LIST.version, currency: model.currency, requestFingerprint: hash([id, payer.keyId]),
      estimatedCost: model.cost + embeddingEstimate.cost, dailyLimit: config.userDailySpendLimit, weeklyLimit: config.userWeeklySpendLimit,
      module: 'agent-memory', taskId: payer.keyId, purpose: 'memory-extraction', operation: payer.operation, now: at });
  }
  // Each extracting admission owns one engine session with exactly one commit. Its cumulative counters therefore
  // belong to that admission alone. For a replay, read the session that actually produced the completed archive.
  async function extraction(payer, { userId, sessions, commit, createdAt, engineSession }) {
    const result = (await sessions.readSession(userId, commit.engineSession))?.result;
    if (Number(result?.commit_count) !== 1 || result.session_id !== commit.engineSession) throw new HttpError(503, 'agent_memory_usage_pending', 'Extraction usage is not available yet.');
    const llm = result.llm_token_usage;
    const id = nativeId(payer, engineSession ?? commit.engineSession);
    const reserved = await ledger.memoryReservation?.(payer.ownerId, payer.keyId, id);
    const at = new Date(reserved?.created_at ?? createdAt);
    const prices = priceListAt(at) ?? REFERENCE_PRICE_LIST;
    if (![llm?.prompt_tokens, llm?.completion_tokens, llm?.cached_tokens, result.embedding_token_usage?.total_tokens]
      .every(n => Number.isSafeInteger(n) && n >= 0) || llm.cached_tokens > llm.prompt_tokens) {
      throw new HttpError(503, 'agent_memory_usage_pending', 'Incomplete extraction usage.');
    }
    const usage = {cacheHitTokens:llm.cached_tokens, cacheMissTokens:llm.prompt_tokens - llm.cached_tokens, completionTokens:llm.completion_tokens};
    const actual = priceUsage({resourceType:'model',model:payer.model,cacheHit:usage.cacheHitTokens,cacheMiss:usage.cacheMissTokens,output:usage.completionTokens,peak:isPeak(at)}, prices);
    if (reserved) {
      await ledger.settleModel(payer.ownerId, id, { usage, actualCost: actual.cost, priced: actual.priced, providerRequestId: 'openviking-account-allocation' });
    } else await book(payer, commit.archiveUri, 'llm', payer.model, usage, actual, at, prices);
    await embedding(payer, commit.archiveUri, result.embedding_token_usage.total_tokens, at, prices);
  }
  async function embedding(payer, receipt, tokens, at, prices) {
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new HttpError(503, 'agent_memory_usage_pending', 'Embedding usage unavailable.');
    if (tokens === 0) return;
    await book(payer, receipt, 'embedding', 'openviking-embedding', {cacheHitTokens:0,cacheMissTokens:tokens,completionTokens:0},
      priceUsage({resourceType:'embedding',tokens,peak:true}, prices), at, prices);
  }
  async function book(payer, receipt, kind, model, usage, price, at, prices) {
    const id = `${payer.chargeWallet ? 'amc' : 'amu'}_${hash([payer.ownerId, payer.generation, receipt, kind])}`;
    await ledger.recordSettled({id,runId:id,userId:payer.ownerId,projectId:payer.projectId,model,usage,actualCost:price.cost,
      priceVersion:prices.version,currency:price.currency,priced:price.priced,now:at,
      providerRequestId:kind === 'llm' ? 'openviking-account-allocation' : null, purpose:'memory-extraction', module:'agent-memory', operation:payer.operation, taskId:payer.keyId,requestFingerprint:hash([id,usage])});
  }
  // A find response without a measured count stays uncertain. It must never become a charge based on query length.
  async function search(payer, query, fetch) {
    await admit(payer);
    const id = randomUUID(), at = new Date();
    const model = 'openviking-embedding';
    const estimate = priceUsage({ resourceType:'embedding', tokens:Buffer.byteLength(query), peak:true });
    const { runId } = memoryModelAttribution(payer);
    await ledger.reserveModel({ id, userId:payer.ownerId, projectId:payer.projectId, runId, module:'agent-memory',
      operation:payer.operation, taskId:payer.keyId, purpose:'memory-extraction', model, priceVersion:REFERENCE_PRICE_LIST.version,
      currency:'CNY', requestFingerprint:hash([id, model]), estimatedCost:estimate.cost, dailyLimit:config.userDailySpendLimit, weeklyLimit:config.userWeeklySpendLimit, now:at });
    let settled = false;
    try {
      const response = await fetch();
      const tokens = response?.usage?.tokens?.embedding?.total ?? response?.telemetry?.summary?.tokens?.embedding?.total
        ?? response?.result?.telemetry?.summary?.tokens?.embedding?.total;
      if (Number.isSafeInteger(tokens) && tokens >= 0) {
        const cost = priceUsage({resourceType:'embedding', tokens, peak:true});
        await ledger.settleModel(payer.ownerId, id, {usage:{cacheHitTokens:0,cacheMissTokens:tokens,completionTokens:0},actualCost:cost.cost,priced:cost.priced});
        settled = true;
      }
      return response;
    } finally {
      if (!settled) await ledger.markUncertain(payer.ownerId, id, 'response_usage_missing', {estimatedCost:estimate.cost});
    }
  }
  return { admit, reserveExtraction, extraction, search };
}

/** Each control-plane model reservation gets one settleable wallet identity. */
export function memoryModelAttribution(payer) {
  return { userId:payer.ownerId, projectId:payer.projectId, taskId:payer.keyId, module:'agent-memory', operation:payer.operation, runId:`${payer.chargeWallet ? 'amc' : 'amu'}_${randomUUID()}` };
}
