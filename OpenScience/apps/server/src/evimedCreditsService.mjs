/**
 * 灵豆 settlement: EviMed Science's usage, charged in EviMed's currency
 * (fusion plan §9.6).
 *
 * This is an outbound bridge, not a second ledger. `usageLedger.mjs` keeps
 * reserving before each model call and settling after it, per run, in CNY, and
 * nothing here changes that. What this adds is the step after a run ends: turn
 * that run's already-recorded cost into 灵豆 and charge it to EviMed once.
 *
 * Hidden knowledge — the four decisions that make this safe to run against real
 * money:
 *
 * 1. **Idempotent by run id, and the row is written first.** One row per run in
 *    `evimed_credits.settlements` (`run_id` is the primary key), inserted
 *    `pending` before the deduction leaves, and the same run id is EviMed's own
 *    idempotency key (「以运行编号幂等」). So a duplicate completion callback, a
 *    retry, or a crash between "charged" and "recorded" all converge on one
 *    charge: the row is either already there (nothing is sent) or it is there
 *    and pending (the retry is sent with the same key and EviMed answers with
 *    the original receipt).
 * 2. **Settle after, refuse before, never in the middle.** A verdict here can
 *    only refuse a start (`credits_exhausted`, before a run exists). A run that
 *    is under way is never interrupted for money: it has already been paid for
 *    at the provider, and stopping it would deliver nothing for it.
 * 3. **The upstream being down is a status, not a failure of the platform**
 *    (principles 14 and 19). A deduction that cannot be confirmed stays
 *    `pending` and is retried on a bounded backoff; it is never reported as
 *    charged, and it never blocks a conversation, a run, or a reply. A balance
 *    that cannot be read admits the start — refusing work because our own
 *    accounting is unreachable is the one outcome no user can act on.
 * 4. **The memo is for a person reading their own bill.** 「深度研究 · 司美格
 *    鲁肽减重 Meta 分析」 — the line and the subject, in Chinese. No run id, no
 *    model name, no tool name: a statement line is not a trace.
 * 5. **EviMed is told whom to charge in its own words.** Our account id is a
 *    one-way hash of the EviMed user (`evimedAuthService.mjs`), which EviMed
 *    cannot resolve, so a deduction and a balance read name the EviMed user id
 *    the account row keeps (`store.evimedUserIdOf`), pinned in the financial
 *    outbox before sending so account erasure cannot change a pending payer. An account with none —
 *    a password or OIDC account, or an EviMed one that has not signed in since
 *    the id was first kept — is never sent under our hash: its settlement is
 *    refused as `evimed_credits_account_unlinked` without a call, and its
 *    balance reads as unknown, which admits the start (decision 3).
 *
 * @module evimedCreditsService
 */

import { createHash } from "node:crypto";
import { CAPABILITY_DISPLAY, capabilityTitle, estimateCost, spendingPermission, researchTaskCharge, researchMoneyUnits, isResearcherOwnedWork, RESEARCH_BILLING_VERSION, SIMULATED_LOW_CREDITS } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { productId } from "./productPersistence.mjs";
import { EvimedCreditsError } from "./evimedCreditsClient.mjs";
import { SIMULATED_INCARNATION_SQL, SimulatedWalletRefusal, simulatedPayerId } from "./evimedCreditsSimulator.mjs";
import { runUsageKeys, autopilotUsageScope } from "./runUsage.mjs";
import { migrateEvimedCredits, researchBillingPolicy } from "./evimedCreditsPersistence.mjs";

/**
 * The waits between attempts, in milliseconds. Bounded on purpose: after the
 * last one the settlement is `abandoned` — recorded, visible to an operator,
 * and never retried again. An unbounded retry against a payment endpoint is how
 * one outage becomes a permanent request loop.
 */
export const EVIMED_CREDITS_BACKOFF_MS = Object.freeze([60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000]);
/** Attempts a settlement gets in total, the first one included. */
export const EVIMED_CREDITS_MAX_ATTEMPTS = EVIMED_CREDITS_BACKOFF_MS.length + 1;
/** Settled runs of one capability read for its estimate. */
const ESTIMATE_SAMPLES = 50;
/** Characters of a run's subject the memo carries. */
const MEMO_SUBJECT_CHARS = 40;
/** The line a run with no named capability is billed under. */
const DEFAULT_LINE = "深度研究";

/** @param {unknown} value */
const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

/**
 * What a settlement is called on a person's statement: the line, then the
 * subject of their own question.
 *
 * Nothing technical may reach it. A run id, a session id or a model name in a
 * billing memo is a support ticket waiting to happen, and the subject is
 * therefore scrubbed rather than trusted: control characters and runs of
 * whitespace collapse, and a subject that is only an identifier is dropped in
 * favour of the line alone.
 * @param {{ capabilityId?: string | null, subject?: string | null, effectiveAgentId?:string|null, automated?:boolean, startedAt?:string|null, finishedAt?:string|null, accountCreatedAt?:string|null }} run
 * @returns {string}
 */
export function settlementMemo({ capabilityId = null, subject = null } = {}) {
  const line = capabilityTitle(capabilityId) ?? DEFAULT_LINE;
  // eslint-disable-next-line no-control-regex -- a title can arrive with a stray control character
  const cleaned = String(subject ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const named = /^[A-Za-z0-9_.:-]+$/.test(cleaned) ? "" : cleaned;
  if (!named) return line;
  const characters = [...named];
  const cut = characters.length > MEMO_SUBJECT_CHARS ? `${characters.slice(0, MEMO_SUBJECT_CHARS - 1).join("")}…` : named;
  return `${line} · ${cut}`;
}

/** The rate is a deployment fact, and a guessed one would charge people wrongly.
 *  @param {Record<string, any> | null | undefined} config */
export function evimedCreditsRate(config) {
  const rate = Number(config?.evimedCreditsPerCny ?? 0);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/** CNY to 灵豆, rounded to the nearest whole bean. Rounding down a sub-bean run
 *  to zero is deliberate: it is a charge the platform waives, which is the side
 *  of the rounding a customer cannot be wronged by. @param {number} cny @param {number} rate */
export function creditsForCost(cny, rate) {
  return Math.max(0, Math.round(finite(cny) * finite(rate)));
}

/** @param {any} row */
function settlement(row) {
  return row ? {
    runId: row.run_id,
    userId: row.user_id,
    projectId: row.project_id ?? null,
    capabilityId: row.capability_id ?? "",
    memo: row.memo ?? "",
    costCny: Number(row.cost_cny),
    credits: Number(row.credits),
    creditsPerCny: Number(row.credits_per_cny),
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at == null ? null : new Date(row.next_attempt_at).toISOString(),
    receiptId: row.receipt_id ?? null,
    upstreamUserId: row.upstream_user_id ?? null,
    errorCode: row.error_code ?? null,
    wallet: row.wallet ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    settledAt: row.settled_at == null ? null : new Date(row.settled_at).toISOString(),
  } : null;
}

export class EvimedCreditsService {
  /**
   * @param {{ config: Record<string, any>, database: any, client: any, usageLedger?: any,
   *   evimedUserIdOf?: ((userId: string) => Promise<string | null>) | null,
   *   simulator?: any, refusal?: string | null,
   *   now?: () => Date, report?: (code: string) => void }} dependencies
   */
  constructor({ config, database, client, usageLedger = null, evimedUserIdOf = null, simulator = null, refusal = null, now = () => new Date(), report = () => {} }) {
    this.config = config;
    this.database = database;
    this.client = client;
    this.usageLedger = usageLedger;
    /** Who an account is to EviMed (decision 5). Absent means nobody is. */
    this.evimedUserIdOf = evimedUserIdOf;
    /** The simulated wallet's own surface (top-up, orders); null where the wallet is real. */
    this.simulator = simulator;
    /** Whether the wallet is simulated: its rows are marked, and it reads and writes only rows of its own kind. */
    this.simulated = config?.evimedCreditsSimulated === true;
    /** @type {"live" | "simulated"} */
    this.walletKind = this.simulated ? "simulated" : "live";
    /** A named code for a configuration this module will not run under; permanent for the process. */
    this.refusal = refusal;
    /**
     * Why the module cannot do its job right now — the refusal, or what boot or
     * the last readiness probe found. While it is set nothing is charged, no
     * start is refused and no balance is claimed: billing failing never stops
     * research (principles 14 and 19), and a probe that succeeds clears it.
     * @type {string | null}
     */
    this.failure = refusal;
    this.now = now;
    this.report = report;
    this.rate = evimedCreditsRate(config);
    this.counters = {
      settled: 0, skipped: 0, duplicates: 0, pending: 0, refused: 0, abandoned: 0, refusedStarts: 0, balanceUnavailable: 0,
      unlinked: 0,
    };
  }

  /** On only when the toggle, the database, the two addresses, the key and the
   *  rate are all there. Anything missing is named by `status()` and settles
   *  nothing — it never half-charges. */
  get enabled() {
    return this.#wired() && !this.failure;
  }

  /** Everything the module needs is there; whether it is working is `failure`'s. */
  #wired() {
    return Boolean(this.config?.evimedCreditsEnabled) && Boolean(this.database) && Boolean(this.client?.configured) && this.rate > 0;
  }

  status() {
    return {
      enabled: Boolean(this.config?.evimedCreditsEnabled),
      operating: this.enabled,
      simulated: this.simulated,
      failure: this.failure,
      creditsPerCny: this.rate,
      counters: { ...this.counters },
      upstream: this.client?.status?.() ?? null,
    };
  }

  /**
   * EviMed's own id for one account, read at the moment it is needed (decision
   * 5). A lookup that fails throws and is handled as an unknown outcome by the
   * caller; an account with no id is `null`.
   * @param {string} userId @returns {Promise<string | null>}
   */
  async #evimedUserId(userId) {
    if (typeof this.evimedUserIdOf !== "function") return null;
    const value = await this.evimedUserIdOf(userId);
    return typeof value === "string" && value.trim() ? value : null;
  }

  /**
   * Whom the wallet charges for one account. A real wallet knows the EviMed user
   * id (above); the simulated one knows every account, as `sim:` plus the
   * account's id and incarnation, so a replaced account never inherits a wallet.
   * @param {string} userId @returns {Promise<string | null>}
   */
  async #payer(userId) {
    if (!this.simulated) return this.#evimedUserId(userId);
    const result = await this.database.query(
      `SELECT ${SIMULATED_INCARNATION_SQL} AS incarnation FROM evimed_control.users u WHERE u.id=$1`, [userId]);
    const incarnation = result.rows[0]?.incarnation;
    return incarnation ? simulatedPayerId(userId, incarnation) : null;
  }

  /**
   * The same, for an account row already in hand (`#currentAccount`).
   * @param {string} userId @param {any} account @returns {string | null}
   */
  #payerFor(userId, account) {
    if (this.simulated) return account?.incarnation ? simulatedPayerId(userId, account.incarnation) : null;
    return account?.auth_type === "evimed" ? account.evimed_user_id : null;
  }

  /** Readiness: the schema exists and can be written. @returns {Promise<{ok: true}>} */
  async ready() {
    if (this.refusal) throw new HttpError(503, this.refusal, "The research billing module refused this configuration.");
    await migrateEvimedCredits(this.database);
    if (this.simulated) await this.simulator?.ready();
    if (this.config?.evimedCreditsEnabled) {
      const policy = await researchBillingPolicy(this.database, { activate: this.config?.researchBillingEnabled === true, now: this.now() });
      if (policy && (this.rate !== 1 || policy.pricing_version !== RESEARCH_BILLING_VERSION)) {
        throw new HttpError(503, 'evimed_credits_request_invalid', 'The active research billing policy requires its original one-credit-per-CNY contract.');
      }
    }
    return { ok: true };
  }

  /**
   * Bring the module up, or say why it cannot — never throwing. The policy's
   * activation is persisted here before research is accepted, and a module that
   * cannot do that is not allowed to take the platform down with it: it goes
   * quiet (`failure`), the platform boots, readiness reports the code, and the
   * next probe (readiness, the retry sweep, a start) tries again.
   * @returns {Promise<string | null>} the named code of what is wrong, or null
   */
  async ensureReady() {
    if (this.refusal) return this.#fail(this.refusal);
    try {
      await this.ready();
      this.failure = null;
      return null;
    } catch (error) {
      return this.#fail(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evimed_credits_unavailable");
    }
  }

  /** @param {string} code */
  #fail(code) {
    if (this.failure !== code) this.report(code);
    this.failure = code;
    return code;
  }

  /** @param {string} userId @param {string} runId */
  async settlementOf(userId, runId) {
    await migrateEvimedCredits(this.database);
    const result = await this.database.query(
      "SELECT s.* FROM evimed_credits.settlements s JOIN evimed_control.users u ON u.id=s.user_id AND u.created_at=s.owner_created_at WHERE s.run_id=$1 AND s.user_id=$2",
      [productId(runId, "run"), productId(userId, "user")],
    );
    return settlement(result.rows[0] ?? null);
  }

  /**
   * What one finished run cost in CNY, read from the usage ledger rather than
   * recomputed. A run's rows can be attributed to its own id or to the dispatch
   * id a bounded workflow gave it, so both are asked for.
   * @param {string} userId @param {string[]} runIds
   * @returns {Promise<number>}
   */
  async #costOf(userId, runIds) {
    if (!this.usageLedger) return 0;
    const summaries = await this.usageLedger.summaryRuns(userId, runIds);
    let total = 0;
    for (const id of runIds) total += finite(summaries?.get?.(id)?.costCny);
    return Math.round(total * 100_000_000) / 100_000_000;
  }

  /**
   * Charge one finished run, once.
   *
   * Never throws: a settlement problem is this module's, and the run-completion
   * path that calls it is also what writes the transcript and the researcher's
   * notice. The verdict is the returned status.
   *
   * @param {{ userId: string, projectId?: string | null, runId: string, dispatchId?: string | null,
   *   status?: string, dispatchStatus?: string | null, errorCode?: string | null, effectiveRouteReason?: string | null,
   *   capabilityId?: string | null, subject?: string | null, effectiveAgentId?:string|null, automated?:boolean, startedAt?:string|null, finishedAt?:string|null, accountCreatedAt?:string|null }} run
   * @returns {Promise<{ status: string, credits?: number, reason?: string, duplicate?: boolean, errorCode?: string | null }>}
   */
  async settleRun(run) {
    if (this.enabled) {
      try {
        const policy = await researchBillingPolicy(this.database, { activate: this.config?.researchBillingEnabled === true, now: this.now() });
        if (policy) return this.settleTask(run, policy);
        if (this.config?.researchBillingEnabled) throw new HttpError(503, 'evimed_credits_request_invalid', 'Research billing activation is unavailable.');
      } catch (error) {
        const code = /** @type {any} */ (error)?.code ?? 'evimed_credits_http_error';
        this.report(code);
        return { status: 'error', errorCode: code };
      }
    }
    if (!this.enabled) {
      this.counters.skipped += 1;
      const reason = !this.config?.evimedCreditsEnabled ? "not_enabled" : this.failure ? "billing_unavailable"
        : this.rate <= 0 ? "rate_unset" : "not_configured";
      return { status: "skipped", reason };
    }
    try {
      const userId = productId(run.userId, "user");
      const runId = productId(run.runId, "run");
      const ids = runUsageKeys({ ...run, id: runId }).map(id => productId(id, "run"));
      const costCny = await this.#costOf(userId, ids);
      const credits = creditsForCost(costCny, this.rate);
      const memo = settlementMemo({ capabilityId: run.capabilityId ?? null, subject: run.subject ?? null });
      const upstreamUserId = await this.#payer(userId);
      const opened = await this.#open({
        userId, runId, projectId: run.projectId ?? null, capabilityId: run.capabilityId ?? "",
        memo, costCny, credits, upstreamUserId, startedAt: run.startedAt ?? null, accountCreatedAt: run.accountCreatedAt ?? null,
      });
      if (opened.stale) return { status: 'skipped', reason: 'account_changed' };
      if (!opened.inserted) {
        this.counters.duplicates += 1;
        // A pending row of an earlier attempt is the retry sweep's, not this
        // caller's: attempting it here would race the worker on one charge.
        return { status: opened.row?.status ?? "unknown", duplicate: true, credits: opened.row?.credits };
      }
      if (opened.row?.status === "settled") {
        this.counters.settled += 1;
        return { status: "settled", credits: 0, reason: "no_charge" };
      }
      return await this.#charge(/** @type {any} */ (opened.row));
    } catch (error) {
      const code = typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evimed_credits_settle_failed";
      this.report(code);
      return { status: "error", errorCode: code };
    }
  }

  /** Versioned accounting never guesses provider usage and never sends fractional credits.
   * @param {any} run @param {any} policy */
  async settleTask(run, policy) {
    if (!this.enabled) return { status: 'skipped', reason: 'not_configured' };
    try {
      if (this.rate !== 1) return { status: 'error', errorCode: 'evimed_credits_request_invalid' };
      const userId = productId(run.userId, 'user');
      if (typeof run.accountCreatedAt !== 'string' || !run.accountCreatedAt.trim()) return { status: 'skipped', reason: 'account_generation_missing' };
      if (policy?.pricing_version !== RESEARCH_BILLING_VERSION) throw new HttpError(409, 'evimed_credits_request_invalid', 'Unsupported research billing policy.');
      const physicalId = productId(run.runId, 'run');
      const successful = ['completed', 'succeeded'].includes(run.status);
      const logical = successful ? autopilotUsageScope(run) : null;
      const runId = logical ? `research_${createHash('sha256').update(`${userId}\0${logical}`).digest('hex')}` : physicalId;
      await migrateEvimedCredits(this.database);
      const ids = successful ? runUsageKeys({ ...run, id: physicalId }).map(id => productId(id, 'run')) : [physicalId];

      // Failed platform work retains its costs as evidence but is waived. A
      // cancellation is not evidence of an earned stage, so it is waived too.
      const researcherOwned = isResearcherOwnedWork(run);
      const owned = researcherOwned && successful;
      const title = settlementMemo(run);
      const opened = await this.database.transaction(async (/** @type {any} */ client) => {
        // Serialize request attribution across tasks for this account.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evimed-user:${userId}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`research-billing-user:${userId}`]);
        const account = await this.#currentAccount(client,userId,run.startedAt ?? null,run.accountCreatedAt ?? null);
        if (!account) return { inserted: false, row: null, stale: true };
        const upstreamUserId = this.#payerFor(userId, account);
        const prior = await client.query('SELECT * FROM evimed_credits.settlements WHERE run_id=$1', [runId]);
        if (prior.rows[0]?.user_id !== undefined && prior.rows[0].user_id !== userId) throw new HttpError(409, 'usage_settlement_conflict', 'Settlement owner differs.');
        if (prior.rows[0]) return { inserted: false, row: settlement(prior.rows[0]) };
        const requests = await client.query(
          `SELECT id,status,priced,currency,purpose,actual_cost,price_version,created_at,run_id
           FROM evimed_usage.model_requests WHERE user_id=$1 AND run_id=ANY($2::text[])
           AND NOT EXISTS (SELECT 1 FROM evimed_credits.research_task_requests a
             WHERE a.request_id=evimed_usage.model_requests.id) ORDER BY id`, [userId, ids]);
        const pricedRows = requests.rows.map((/** @type {any} */ request) => ({ ...request,
          billing_eligible: researcherOwned && Date.parse(request.created_at) >= Date.parse(policy.activated_at),
          not_billable_reason: !researcherOwned ? 'platform_task' : Date.parse(request.created_at) >= Date.parse(policy.activated_at) ? undefined : 'before_policy_activation' }));
        const evidence = { ...researchTaskCharge(pricedRows, { owned }), physicalRunId: physicalId,
          logicalTaskId: logical, policyActivatedAt: new Date(policy.activated_at).toISOString() };
        const credits = Number(researchMoneyUnits(evidence.creditsAmount) / 100_000_000n);
        if (!Number.isSafeInteger(credits) || credits > 10_000_000) throw new RangeError('Invalid task credit amount.');
        const at = this.now();
        const free = credits === 0;
        const result = await client.query(
          `INSERT INTO evimed_credits.settlements
           (run_id,user_id,project_id,capability_id,memo,cost_cny,credits,credits_per_cny,status,attempts,next_attempt_at,settled_at,upstream_user_id,owner_created_at,wallet)
           VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,(SELECT created_at FROM evimed_control.users WHERE id=$2),$13) ON CONFLICT(run_id) DO NOTHING RETURNING *`,
          [runId,userId,run.projectId ?? null,run.capabilityId ?? '',title,evidence.actualCny,credits,
            free ? 'settled' : 'pending',free ? 0 : 1,free ? null : new Date(at.getTime()+EVIMED_CREDITS_BACKOFF_MS[0]).toISOString(),free ? at.toISOString() : null,upstreamUserId,this.walletKind]);
        if (!result.rows[0]) return { inserted: false, row: null };
        await client.query(`INSERT INTO evimed_credits.research_tasks(run_id,user_id,title,evidence,created_at,status,settled_at,owner_created_at,wallet)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,(SELECT created_at FROM evimed_control.users WHERE id=$2),$8)`, [runId,userId,title,JSON.stringify(evidence),at.toISOString(),free ? 'settled' : 'pending',free ? at.toISOString() : null,this.walletKind]);
        for (const request of pricedRows.filter((/** @type {any} */ row) => row.status === 'settled' && row.billing_eligible === true)) await client.query(
          'INSERT INTO evimed_credits.research_task_requests(request_id,run_id) VALUES($1,$2)', [request.id,runId]);
        return { inserted: true, row: settlement(result.rows[0]) };
      });
      if (opened.stale) return { status: 'skipped', reason: 'account_changed' };
      if (!opened.inserted) {
        this.counters.duplicates += 1;
        return { status: opened.row?.status ?? 'unknown', duplicate: true, credits: opened.row?.credits };
      }
      if (opened.row?.status === 'settled') {
        this.counters.settled += 1;
        return { status: 'settled', credits: 0, reason: 'waived' };
      }
      return await this.#charge(/** @type {any} */ (opened.row));
    } catch (error) {
      const code = /** @type {any} */ (error)?.code ?? 'evimed_credits_http_error';
      this.report(code);
      return { status: 'error', errorCode: code };
    }
  }

  /** User-scoped stable keyset pagination. Cursor is a position, never authorization.
   * @param {string} userId @param {{limit?:number,cursor?:string|null}} [options] */
  async statements(userId, { limit = 20, cursor = null } = {}) {
    await migrateEvimedCredits(this.database);
    let position = null;
    if (cursor) {
      try {
        if (cursor.length > 1024) throw new Error();
        position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(position) || position.length !== 2 || !Number.isFinite(Date.parse(position[0])) || typeof position[1] !== 'string') throw new Error();
      } catch { throw new HttpError(400, 'evimed_credits_request_invalid', 'Invalid statement cursor.'); }
    }
    const bound = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
    // Credits going in belong to the simulated wallet alone: a real wallet's
    // top-ups happen elsewhere, so its statements hold charges and nothing else.
    const credits = this.simulated ? `
        UNION ALL
        SELECT e.request_id,w.user_id,CASE e.kind WHEN 'grant' THEN '模拟初始额度' ELSE '模拟充值' END,
          jsonb_build_object('kind',e.kind,'credits',e.credits),e.created_at,'settled'::text
        FROM evimed_credits.simulated_entries e
          JOIN evimed_credits.simulated_wallets w ON w.payer=e.payer
          JOIN evimed_control.users u ON u.id=w.user_id AND u.created_at=w.owner_created_at
        WHERE w.user_id=$1 AND e.kind IN ('grant','topup')` : "";
    const result = await this.database.query(`SELECT t.*
      FROM (
        SELECT t.run_id,t.user_id,t.title,t.evidence,t.created_at,t.status FROM evimed_credits.research_tasks t
          JOIN evimed_control.users u ON u.id=t.user_id AND u.created_at=t.owner_created_at WHERE t.user_id=$1 AND t.wallet=$5
        UNION ALL
        SELECT s.run_id,s.user_id,s.memo,jsonb_build_object(
          'actualCny',s.cost_cny::text,'billableCny',(s.credits/s.credits_per_cny)::text,
          'chargedCny',(s.credits/s.credits_per_cny)::text,'waivedCny','0.00000000',
          'pricingVersion','legacy','walletContract','legacy-integer'),s.created_at,s.status
        FROM evimed_credits.settlements s JOIN evimed_control.users u ON u.id=s.user_id AND u.created_at=s.owner_created_at WHERE s.user_id=$1 AND s.wallet=$5
          AND NOT EXISTS(SELECT 1 FROM evimed_credits.research_tasks t WHERE t.run_id=s.run_id)${credits}
      ) t
      WHERE t.user_id=$1 AND ($2::timestamptz IS NULL OR (t.created_at,t.run_id)<($2::timestamptz,$3::text))
      ORDER BY t.created_at DESC,t.run_id DESC LIMIT $4`, [productId(userId,'user'),position?.[0] ?? null,position?.[1] ?? null,bound+1,this.walletKind]);
    const rows = result.rows.slice(0,bound);
    const items = rows.map((/** @type {any} */ row) => {
      const evidence = row.evidence;
      if (evidence.kind === 'topup' || evidence.kind === 'grant') {
        const added = Number(evidence.credits);
        return { id: row.run_id, runId: null, title: row.title, at: new Date(row.created_at).toISOString(), status: 'settled',
          amount: added, requestedAmount: added, waivedCny: '0.00000000', kind: evidence.kind, simulated: true };
      }
      const status = Number(evidence.chargedCny) === 0 ? 'waived'
        : row.status === 'pending' ? 'pending' : row.status === 'settled' ? 'settled' : 'failed';
      return { id: row.run_id, runId: evidence.physicalRunId ?? row.run_id, title: row.title, at: new Date(row.created_at).toISOString(), status,
        amount: ['failed','pending'].includes(status) ? null : Number(evidence.chargedCny), requestedAmount: Number(evidence.chargedCny), actualCny: evidence.actualCny, billableCny: evidence.billableCny,
        waivedCny: evidence.waivedCny, platformCostCny: evidence.platformCostCny ?? null, pricingVersion: evidence.pricingVersion, settlementPrecision: evidence.walletContract,
        kind: 'charge', simulated: this.simulated };
    });
    const last = rows.at(-1);
    const nextCursor = result.rows.length > bound && last ? Buffer.from(JSON.stringify([new Date(last.created_at).toISOString(),last.run_id])).toString('base64url') : null;
    return { items, nextCursor };
  }

  /** The allowance is hydrated from the upstream wallet; this ledger never owns it.
   * @param {string} userId @param {{since?:Date}} [options] */
  async allowanceSummary(userId, { since = new Date(0) } = {}) {
    // Where the allowance is simulated, it says so and says where low begins.
    const kind = { simulated: this.simulated, lowThreshold: this.simulated ? SIMULATED_LOW_CREDITS : null };
    // A module that is down reads as unavailable — unknown, never zero — and so
    // does one whose ledger cannot be read right now: the page still opens.
    const unreadable = (/** @type {string} */ status) => ({ balanceCny: null, status, currency: 'CNY', creditsPerCny: this.rate,
      spentCny: 0, pendingCny: 0, waivedCny: 0, settlementPrecision: 'legacy-integer-floor', ledgerReadable: false, ...kind });
    if (this.failure) return unreadable('billing_unavailable');
    try {
      return { ...(await this.#allowance(userId, since)), ledgerReadable: true, ...kind };
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) throw error;
      const code = typeof /** @type {any} */ (error)?.code === 'string' ? /** @type {any} */ (error).code : 'evimed_credits_unreachable';
      this.report(code);
      return unreadable(code);
    }
  }

  /** @param {string} userId @param {Date} since */
  async #allowance(userId, since) {
    await migrateEvimedCredits(this.database);
    const balance = await this.balanceFor(userId);
    const result = await this.database.query(`SELECT
      coalesce(sum(charged) FILTER(WHERE status='settled' AND settled_at >= $2::timestamptz),0)::text AS spent,
      coalesce(sum(charged) FILTER(WHERE status='pending' AND created_at >= $2::timestamptz),0)::text AS pending,
      coalesce(sum(waived) FILTER(WHERE created_at >= $2::timestamptz),0)::text AS waived
      FROM (
        SELECT t.status,t.created_at,t.settled_at,(t.evidence->>'chargedCny')::numeric AS charged,
          (t.evidence->>'waivedCny')::numeric AS waived FROM evimed_credits.research_tasks t
          JOIN evimed_control.users u ON u.id=t.user_id AND u.created_at=t.owner_created_at WHERE t.user_id=$1 AND t.wallet=$3
        UNION ALL
        SELECT s.status,s.created_at,s.settled_at,s.credits/s.credits_per_cny AS charged,0::numeric AS waived
        FROM evimed_credits.settlements s JOIN evimed_control.users u ON u.id=s.user_id AND u.created_at=s.owner_created_at WHERE s.user_id=$1 AND s.wallet=$3
          AND NOT EXISTS(SELECT 1 FROM evimed_credits.research_tasks t WHERE t.run_id=s.run_id)
      ) history`, [productId(userId,'user'),since.toISOString(),this.walletKind]);
    return { balanceCny: balance.balance == null || this.rate <= 0 ? null : balance.balance / this.rate, status: balance.status, currency: 'CNY', creditsPerCny: this.rate,
      spentCny: Number(result.rows[0]?.spent ?? 0), pendingCny: Number(result.rows[0]?.pending ?? 0),
      waivedCny: Number(result.rows[0]?.waived ?? 0), settlementPrecision: 'legacy-integer-floor' };
  }

  /** Match the exact database incarnation, never a JavaScript-rounded timestamp.
   * Missing run provenance is not permission to attach old work to a reused name.
   * @param {any} client @param {string} userId @param {string|null} startedAt @param {string|null} accountCreatedAt @param {boolean} [allowMissing] */
  async #currentAccount(client,userId,startedAt,accountCreatedAt,allowMissing = false) {
    if (!startedAt && !accountCreatedAt && !allowMissing) return null;
    const result = await client.query(`SELECT u.auth_type,u.evimed_user_id,u.created_at::text AS owner_created_at,${SIMULATED_INCARNATION_SQL} AS incarnation
      FROM evimed_control.users u WHERE u.id=$1
      AND ($3::timestamptz IS NULL OR u.created_at=$3::timestamptz)
      AND ($3::timestamptz IS NOT NULL OR $2::timestamptz IS NULL OR date_trunc('milliseconds',u.created_at) <= $2::timestamptz)`, [userId,startedAt,accountCreatedAt]);
    return result.rows[0] ?? null;
  }

  /**
   * Open the run's settlement row, or report that it already exists. A run that
   * cost nothing is opened `settled` with no charge and no upstream call — the
   * record that it was free is the point, not the zero.
   * @param {{ userId: string, runId: string, projectId: string | null, capabilityId: string,
   *   memo: string, costCny: number, credits: number, upstreamUserId?:string|null, startedAt?:string|null, accountCreatedAt?:string|null }} input
   */
  async #open(input) {
    await migrateEvimedCredits(this.database);
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evimed-user:${input.userId}`]);
      const account = await this.#currentAccount(client,input.userId,input.startedAt ?? null,input.accountCreatedAt ?? null,true);
      if (!account) return { inserted: false, row: null, stale: true };
      const at = this.now();
      const free = input.credits <= 0;
      const result = await client.query(
        `INSERT INTO evimed_credits.settlements
           (run_id,user_id,project_id,capability_id,memo,cost_cny,credits,credits_per_cny,status,attempts,next_attempt_at,settled_at,upstream_user_id,owner_created_at,wallet)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,(SELECT created_at FROM evimed_control.users WHERE id=$2),$14)
         ON CONFLICT (run_id) DO NOTHING RETURNING *`,
        [input.runId, input.userId, input.projectId, String(input.capabilityId ?? ""), input.memo,
          input.costCny, input.credits, this.rate,
          free ? "settled" : "pending", free ? 0 : 1,
          free ? null : new Date(at.getTime() + EVIMED_CREDITS_BACKOFF_MS[0]).toISOString(),
          free ? at.toISOString() : null, this.#payerFor(input.userId, account), this.walletKind],
      );
      if (result.rows[0]) return { inserted: true, row: settlement(result.rows[0]) };
      const existing = await client.query("SELECT * FROM evimed_credits.settlements WHERE run_id=$1", [input.runId]);
      return { inserted: false, row: settlement(existing.rows[0] ?? null) };
    });
  }

  /**
   * Send one claimed settlement and write down what happened.
   * @param {{ runId: string, userId: string, credits: number, memo: string, attempts: number, createdAt: string, upstreamUserId?:string|null, wallet?:string|null }} row
   */
  async #charge(row) {
    if (row.attempts > EVIMED_CREDITS_MAX_ATTEMPTS) {
      await this.#finish(row.runId, "abandoned", { errorCode: "evimed_credits_attempts_exhausted" });
      this.counters.abandoned += 1;
      return { status: "abandoned", credits: row.credits, errorCode: "evimed_credits_attempts_exhausted" };
    }
    // A row made against the other kind of wallet is not this wallet's to send:
    // a simulated row must never reach a real wallet, nor a real one a simulated
    // answer. The sweep already claims only its own kind; this is the second lock.
    if (row.wallet && row.wallet !== this.walletKind) {
      return { status: "pending", credits: row.credits, errorCode: "evimed_credits_wallet_mismatch" };
    }
    try {
      let evimedUserId = row.upstreamUserId ?? null;
      if (!evimedUserId) {
        const payer = this.simulated
          ? await this.database.query(`SELECT ${SIMULATED_INCARNATION_SQL} AS incarnation, u.id AS user_id FROM evimed_control.users u
              JOIN evimed_credits.settlements s ON s.user_id=u.id AND s.owner_created_at=u.created_at
              WHERE s.run_id=$1`, [row.runId])
          : await this.database.query(`SELECT u.evimed_user_id FROM evimed_control.users u
              JOIN evimed_credits.settlements s ON s.user_id=u.id AND s.owner_created_at=u.created_at
              WHERE s.run_id=$1 AND u.auth_type='evimed'`, [row.runId]);
        evimedUserId = this.simulated
          ? (payer.rows[0]?.incarnation ? simulatedPayerId(payer.rows[0].user_id, payer.rows[0].incarnation) : null)
          : payer.rows[0]?.evimed_user_id ?? null;
      }
      if (!evimedUserId) {
        // Final: no retry gives an account an EviMed id it does not have, and
        // our own hash is the one thing that must not be sent in its place.
        this.counters.unlinked += 1;
        throw new EvimedCreditsError("evimed_credits_account_unlinked", "This account has no EviMed user to charge.", { final: true });
      }
      await this.database.query('UPDATE evimed_credits.settlements SET upstream_user_id=COALESCE(upstream_user_id,$2) WHERE run_id=$1', [row.runId,evimedUserId]);
      const receipt = await this.client.deduct({
        requestId: row.runId, userId: evimedUserId, credits: row.credits, memo: row.memo, occurredAt: row.createdAt,
      });
      await this.#finish(row.runId, "settled", { receiptId: receipt.receiptId });
      this.counters.settled += 1;
      return { status: "settled", credits: row.credits };
    } catch (error) {
      const code = error instanceof EvimedCreditsError ? error.code
        : typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evimed_credits_http_error";
      // A refusal EviMed wrote down is final: asking again gets the same answer.
      if (error instanceof EvimedCreditsError && error.final) {
        await this.#finish(row.runId, "refused", { errorCode: code });
        this.counters.refused += 1;
        this.report(code);
        return { status: "refused", credits: row.credits, errorCode: code };
      }
      if (row.attempts >= EVIMED_CREDITS_MAX_ATTEMPTS) {
        await this.#finish(row.runId, "abandoned", { errorCode: code });
        this.counters.abandoned += 1;
        this.report(code);
        return { status: "abandoned", credits: row.credits, errorCode: code };
      }
      // Still pending, with the backoff the claim already set. Nothing is
      // charged, nothing is lost, and nothing upstream of here is blocked.
      await this.database.query("UPDATE evimed_credits.settlements SET error_code=$2 WHERE run_id=$1 AND status='pending'",
        [row.runId, code]);
      this.counters.pending += 1;
      this.report(code);
      return { status: "pending", credits: row.credits, errorCode: code };
    }
  }

  /** @param {string} runId @param {"settled"|"refused"|"abandoned"} status
   *  @param {{ receiptId?: string | null, errorCode?: string | null }} outcome */
  async #finish(runId, status, { receiptId = null, errorCode = null } = {}) {
    await this.database.transaction(async (/** @type {any} */ client) => {
      await client.query(
        `UPDATE evimed_credits.settlements
           SET status=$2, next_attempt_at=NULL, receipt_id=COALESCE($3,receipt_id), error_code=$4,
               settled_at=CASE WHEN $2='settled' THEN $5::timestamptz ELSE settled_at END
         WHERE run_id=$1 AND status='pending'`,
        [runId, status, receiptId, errorCode, this.now().toISOString()],
      );
      await client.query(`UPDATE evimed_credits.research_tasks SET status=$2,
        receipt_id=COALESCE($3,receipt_id),error_code=$4,
        settled_at=CASE WHEN $2='settled' THEN $5::timestamptz ELSE settled_at END WHERE run_id=$1 AND status='pending'`,
        [runId,status,receiptId,errorCode,this.now().toISOString()]);
    });
  }

  /**
   * One due pending settlement, claimed for this process: its attempt counter
   * goes up and its next attempt moves out before anything is sent, so two web
   * processes never charge one run and a crash cannot produce a tight retry
   * loop.
   * @returns {Promise<any | null>}
   */
  async #claimDue() {
    const at = this.now().toISOString();
    return this.database.transaction(async (/** @type {any} */ client) => {
      const due = await client.query(
        `SELECT run_id, attempts FROM evimed_credits.settlements
           WHERE status='pending' AND wallet=$2 AND next_attempt_at <= $1::timestamptz
           ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [at, this.walletKind]);
      const row = due.rows[0];
      if (!row) return null;
      const attempt = Number(row.attempts) + 1;
      const wait = EVIMED_CREDITS_BACKOFF_MS[Math.min(attempt, EVIMED_CREDITS_BACKOFF_MS.length) - 1];
      const claimed = await client.query(
        `UPDATE evimed_credits.settlements SET attempts=$2, next_attempt_at=$3::timestamptz
           WHERE run_id=$1 RETURNING *`,
        [row.run_id, attempt, new Date(Date.parse(at) + wait).toISOString()]);
      return settlement(claimed.rows[0] ?? null);
    });
  }

  /**
   * The worker's tick: send the settlements whose retry is due, at most `limit`
   * of them. Returns how many were attempted.
   * @param {number} [limit]
   */
  async retryDue(limit = 20) {
    // A module that came up broken tries again here, once a minute: the sweep is
    // also its recovery probe. Whatever it finds, the sweep itself never throws.
    if (!this.#wired() || await this.ensureReady()) return 0;
    const bound = Math.max(1, Math.min(200, Math.floor(Number(limit) || 20)));
    let attempted = 0;
    for (; attempted < bound;) {
      const row = await this.#claimDue();
      if (!row) break;
      attempted += 1;
      await this.#charge(row);
    }
    return attempted;
  }

  /**
   * What a capability is likely to cost, as a range in 灵豆, before it starts.
   *
   * The capability's own settled history first (`estimateCost`'s P50–P90 over
   * the last {@link ESTIMATE_SAMPLES} runs), the manifest's own estimated
   * minutes at the reference price when there is no history — and the basis is
   * returned, so a surface can say 「首次运行」 instead of presenting a guess as
   * a measurement.
   * @param {string | null | undefined} capabilityId
   * @returns {Promise<{ capabilityId: string, unit: string, low: number, high: number, basis: string, samples: number, creditsPerCny: number }>}
   */
  async estimate(capabilityId) {
    const id = String(capabilityId ?? "").trim();
    /** @type {number[]} */
    let samples = [];
    if (this.enabled && id) {
      try {
        await migrateEvimedCredits(this.database);
        const result = await this.database.query(
          `SELECT cost_cny FROM evimed_credits.settlements
             WHERE capability_id=$1 AND status='settled' AND credits > 0
             ORDER BY created_at DESC LIMIT $2`, [id, ESTIMATE_SAMPLES]);
        samples = result.rows.map((/** @type {any} */ row) => Number(row.cost_cny)).filter((value) => Number.isFinite(value));
      } catch (error) {
        // A history read that failed is a worse estimate, not a refused start:
        // the manifest's own minutes answer instead, and `basis` says which.
        this.report(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evimed_credits_history_unavailable");
      }
    }
    const minutes = CAPABILITY_DISPLAY[id]?.estimatedMinutes;
    const estimated = estimateCost({
      samples,
      ...(minutes && Number.isFinite(minutes.min) && Number.isFinite(minutes.max) ? { estimatedMinutes: [minutes.min, minutes.max] } : {}),
    });
    return {
      capabilityId: id,
      unit: "灵豆",
      low: creditsForCost(estimated.p50, this.rate),
      high: creditsForCost(estimated.p90, this.rate),
      basis: estimated.basis,
      samples: samples.length,
      creditsPerCny: this.rate,
      ...(this.simulated ? { simulated: true } : {}),
    };
  }

  /**
   * This account's balance, as a status rather than a throw: a credits service
   * that cannot be reached must not become an error on a page the user opened
   * to read a number.
   * @param {string} userId
   * @returns {Promise<{ balance: number | null, frozen: number | null, unit: string, status: string }>}
   */
  async balanceFor(userId) {
    const kind = this.simulated ? { simulated: true } : {};
    if (!this.enabled) {
      return { balance: null, frozen: null, unit: "灵豆", ...kind,
        status: this.failure ? "billing_unavailable" : this.config?.evimedCreditsEnabled ? "unconfigured" : "disabled" };
    }
    try {
      const evimedUserId = await this.#payer(productId(userId, "user"));
      if (!evimedUserId) {
        // Not a failure of anything: this account has no EviMed balance to
        // read, so it has no number, and the start is admitted (decision 3).
        this.counters.unlinked += 1;
        return { balance: null, frozen: null, unit: "灵豆", status: "evimed_credits_account_unlinked", ...kind };
      }
      const answer = await this.client.balance(evimedUserId);
      return { balance: answer.balance, frozen: answer.frozen, unit: "灵豆", status: "ok", ...kind };
    } catch (error) {
      this.counters.balanceUnavailable += 1;
      const code = typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evimed_credits_unreachable";
      this.report(code);
      return { balance: null, frozen: null, unit: "灵豆", status: code, ...kind };
    }
  }

  /**
   * Refuse a start this account cannot pay for — and only then.
   *
   * Three outcomes and no fourth: allowed, allowed-because-we-could-not-tell,
   * or a 402 naming `credits_exhausted`, which is the code the platform
   * reserved for exactly this moment (`usageMetering.mjs`: 「`credits_exhausted`
   * stays reserved for a balance, which this deployment does not have」 — it
   * does now). It is asked before a run exists and never again, so nothing it
   * does can interrupt work already under way.
   *
   * @param {string} userId @param {string | null | undefined} capabilityId
   * @returns {Promise<{ allowed: true, reason?: string, balance?: number, estimate?: any }>}
   */
  async assertBalanceForStart(userId, capabilityId) {
    if (!this.#wired()) return { allowed: true, reason: this.failure ? "billing_unavailable" : "not_enabled" };
    // The policy's activation is persisted before research is accepted. A module
    // that cannot do that is not a reason to refuse the research: the start is
    // admitted, nothing will be charged, and readiness carries the code.
    if ((this.config?.researchBillingEnabled || this.failure) && await this.ensureReady()) {
      return { allowed: true, reason: "billing_unavailable" };
    }
    const balance = await this.balanceFor(userId);
    if (balance.balance == null) return { allowed: true, reason: balance.status };
    const estimate = await this.estimate(capabilityId);
    const permission = spendingPermission({ balance: balance.balance, dailyLimit: 0, spentToday: 0 });
    const short = estimate.low > 0 && balance.balance < estimate.low;
    if (!permission.interactive || short) {
      this.counters.refusedStarts += 1;
      const said = `This account holds ${balance.balance} credits and this work is estimated at ${estimate.low}.`;
      // Its own code where the allowance is simulated, so the sentence says so
      // and the top-up it offers is the simulated one.
      if (this.simulated) {
        throw new HttpError(402, "simulated_credits_exhausted",
          `The simulated allowance is too low. ${said} Top up under Settings → Research allowance (simulated).`);
      }
      throw new HttpError(402, permission.code ?? "credits_exhausted", said);
    }
    return { allowed: true, balance: balance.balance, estimate };
  }

  /** The simulated wallet's own surface answers only a deployment whose wallet is simulated and working. */
  #requireSimulated() {
    if (!this.simulated || !this.simulator) throw new HttpError(404, "simulated_wallet_not_enabled", "This deployment has no simulated wallet.");
    if (!this.enabled) throw new HttpError(503, "evimed_credits_unreachable", "The simulated wallet is unavailable.");
  }

  /**
   * Add one package of simulated credits to this account, once per request id.
   * @param {string} userId @param {{ packageId?: unknown, requestId?: unknown }} request
   */
  async simulatedTopUp(userId, { packageId, requestId }) {
    this.#requireSimulated();
    const payer = await this.#payer(productId(userId, "user"));
    if (!payer) throw new HttpError(400, "simulated_wallet_request_invalid", "This account has no simulated wallet.");
    try {
      return await this.simulator.topUp({ payer, packageId, requestId });
    } catch (error) {
      if (error instanceof SimulatedWalletRefusal) throw new HttpError(400, "simulated_wallet_request_invalid", "The simulated top-up was refused.");
      throw error;
    }
  }

  /** This account's simulated top-ups, newest first. @param {string} userId @param {{ limit?: number, cursor?: string | null }} [options] */
  async simulatedOrders(userId, options = {}) {
    this.#requireSimulated();
    const payer = await this.#payer(productId(userId, "user"));
    if (!payer) return { items: [], nextCursor: null };
    try {
      return await this.simulator.orders(payer, options);
    } catch (error) {
      if (error instanceof SimulatedWalletRefusal) throw new HttpError(400, "simulated_wallet_request_invalid", "The order list request was refused.");
      throw error;
    }
  }
}

/** @param {string} code @param {Record<string, unknown> | null} [details] */
function readinessFailure(code, details = null) {
  /** @type {Error & Record<string, any>} */
  const error = new Error(code);
  error.code = code;
  if (details) error.details = details;
  return error;
}

/**
 * The module's line of `/api/ready`: red only for its own invariants — the
 * schema and the policy's activation (`ensureReady`), and a configuration it
 * refused — and each says what it is by a named code. A wallet that cannot be
 * reached, or is not wired yet, is a warning on a green check: it is outside
 * the platform, and nothing is charged until it answers. Asking is also what
 * lets a module that came up broken recover.
 * @param {{ config: Record<string, any>, credits: { service: EvimedCreditsService } | null, database: any }} dependencies
 */
export async function creditsReadiness({ config, credits, database }) {
  if (!config.evimedCreditsEnabled) return { required: false, enabled: false };
  if (!credits || !database) throw readinessFailure("evimed_credits_unavailable", { reason: database ? "not_composed" : "no_product_database" });
  const failure = await credits.service.ensureReady();
  if (failure) throw readinessFailure(failure, { simulated: credits.service.simulated });
  const status = credits.service.status();
  return {
    required: true, enabled: true, simulated: status.simulated, policy: config.researchBillingEnabled === true,
    ...(status.operating ? {} : { warning: "evimed_credits_wallet_not_wired" }),
  };
}
