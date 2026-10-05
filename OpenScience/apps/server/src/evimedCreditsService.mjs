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
 * 6. **Two wallets, and the line between them is one explicit branch**
 *    (2026-10-05): `walletKind`. The platform's own wallet
 *    (`evimedCreditsWallet.mjs`, today the simulated one) holds exact amounts,
 *    lots and holds, so a charge there is the exact sum of the run's billable
 *    model calls, taken up to what is available in one atomic wallet operation,
 *    in the same database transaction as the settlement row (`#settlePlatform`,
 *    contract `precision-v1`). EviMed's wallet is integer-only and out of this
 *    repository's hands, so with it the module keeps its whole-credit behaviour
 *    (`#settleLive`, contract `legacy-integer-floor`, recorded on every charge as
 *    `walletContract`): a run is charged in whole credits rounded down, a
 *    cancellation is free, and the outbox below carries it. Before the exact rule
 *    can run against EviMed's wallet, that wallet has to support a decimal
 *    deduction, "take up to what is available and say how much", and lots with
 *    expiry (or a platform-side lot ledger in front of it). Nothing here carries a
 *    sub-credit remainder across charges: that would be a second ledger of the
 *    user's money.
 *
 * @module evimedCreditsService
 */

import { createHash } from "node:crypto";
import {
  CAPABILITY_DISPLAY, CREDIT_EXPIRY_REMINDER_DAYS, CREDIT_NOT_CHARGED_REASONS, CREDIT_SOURCE_LABELS, RESEARCH_BILLING_VERSION_WHOLE_CREDIT,
  SIMULATED_LOW_CREDITS, SIMULATED_WALLET_LABEL, WALLET_CONTRACT_EXACT, WALLET_CONTRACT_WHOLE_CREDIT,
  allowanceRefusalSentence, capabilityTitle, creditUnitsOrNull, estimateCost, estimateRunCostUnits, expiryReminderDue, expiryWords,
  formatCredits, isChargeableResearchRun, researchMoneyDecimal, researchMoneyUnits, researchTaskCharge, spendingPermission,
} from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { productId } from "./productPersistence.mjs";
import { EvimedCreditsError } from "./evimedCreditsClient.mjs";
import { SIMULATED_INCARNATION_SQL, SimulatedWalletRefusal, simulatedPayerId } from "./evimedCreditsSimulator.mjs";
import { runUsageKeys, autopilotUsageScope } from "./runUsage.mjs";
import { exactBillingPolicy, migrateEvimedCredits, researchBillingPolicy } from "./evimedCreditsPersistence.mjs";
import { OPEN_DOMAIN_ANSWER_AGENT_ID } from "./specialistRouting.mjs";
import { vcrRunUsageScope } from "./vcrUsageScope.mjs";

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
/** Reminders read and written per batch, and how many batches one sweep does: bounded, so a big backlog is worked through over a few ticks. */
const REMINDER_BATCH = 200;
const REMINDER_BATCHES_PER_SWEEP = 5;
/** How long a lot whose notice could not be written is left alone before it is tried again. */
const REMINDER_RETRY_MS = 3_600_000;
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

/**
 * Whether a finished run is charged, and if not why not (design 2026-10-05).
 *
 * - A run that **completed** is charged its exact cost.
 * - A run its **user stopped** is charged what had run when the stop arrived.
 *   The ledger tells the two kinds of stop apart: `canceledBy` is `"user"` when
 *   the researcher stopped it (the cancel route, the kernel window's stop, a
 *   conversation deleted while it worked) and `"platform"` when the platform did
 *   (a release or a runtime stopped for someone else's start). A cancel that
 *   carries neither — a stop the kernel reported itself, a superseded dispatch —
 *   cannot be attributed, and a charge that cannot be attributed is not made.
 * - Everything else — a failure, a timeout, a dead runtime, a provider outage, a
 *   platform budget — delivered nothing for a reason that is not the user's own
 *   stop, and is never charged.
 * - The platform's own work is never charged, whatever way it ended.
 * @param {{ status?: string | null, canceledBy?: string | null } & Record<string, any>} run
 * @returns {{ charges: boolean, basis: 'completed' | 'user_stop' | 'not_charged', reason: keyof typeof CREDIT_NOT_CHARGED_REASONS | null }}
 */
export function chargeDecision(run) {
  if (!isChargeableResearchRun(/** @type {any} */ (run))) return { charges: false, basis: "not_charged", reason: "platform_work" };
  const status = String(run?.status ?? "");
  if (status === "completed" || status === "succeeded") return { charges: true, basis: "completed", reason: null };
  if (status === "canceled") {
    if (run.canceledBy === "user") return { charges: true, basis: "user_stop", reason: null };
    return { charges: false, basis: "not_charged", reason: run.canceledBy === "platform" ? "platform_stop" : "stop_unattributed" };
  }
  return { charges: false, basis: "not_charged", reason: "not_delivered" };
}

/**
 * A stored amount as the exact 8-decimal string a statement carries. An amount
 * that is not one is drawn as nothing rather than guessed at.
 * @param {unknown} value @returns {string}
 */
function exactAmount(value) {
  const units = creditUnitsOrNull(typeof value === "number" ? String(value) : value);
  return researchMoneyDecimal(units !== null && units > 0n ? units : 0n);
}

/** Whether a database error is one a settlement should simply be tried again after. @param {any} error */
function transient(error) {
  return !(error instanceof HttpError) && !(error instanceof SimulatedWalletRefusal)
    && ["40001", "40P01", "55P03", "57P01", "57P03", "ECONNRESET", "ETIMEDOUT"].includes(String(error?.code ?? ""));
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
   *   notify?: ((userId: string, input: Record<string, any>) => Promise<any>) | null,
   *   now?: () => Date, report?: (code: string) => void }} dependencies
   */
  constructor({ config, database, client, usageLedger = null, evimedUserIdOf = null, simulator = null, refusal = null, notify = null, now = () => new Date(), report = () => {} }) {
    this.config = config;
    this.database = database;
    this.client = client;
    this.usageLedger = usageLedger;
    /** Who an account is to EviMed (decision 5). Absent means nobody is. */
    this.evimedUserIdOf = evimedUserIdOf;
    /** The platform's own wallet (`evimedCreditsWallet.mjs`, behind the simulated top-up); null where the wallet is EviMed's. */
    this.simulator = simulator;
    /** Whether the wallet is the platform's own: its rows are marked, and it reads and writes only rows of its own kind. */
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
    /** Where an inbox notice is written; absent, a reminder is not sent and nothing else changes. */
    this.notify = notify;
    this.rate = evimedCreditsRate(config);
    /** How long a hold lives if its run's process dies: the run's own timeout and a margin. */
    this.holdTtlMs = (Number.isFinite(Number(config?.agentRunMonitorTimeoutMs)) && Number(config.agentRunMonitorTimeoutMs) > 0
      ? Number(config.agentRunMonitorTimeoutMs) : 24 * 3_600_000) + 10 * 60_000;
    /** lot id -> the instant before which a reminder that failed is not tried again. @type {Map<string, number>} */
    this.reminderFailures = new Map();
    this.counters = {
      settled: 0, skipped: 0, duplicates: 0, pending: 0, refused: 0, abandoned: 0, refusedStarts: 0, balanceUnavailable: 0,
      unlinked: 0,
      // The platform wallet's: charges the user's stop made, charges the balance could not cover (the platform carried
      // the rest), holds placed, holds released by the sweep, lots expired, reminders written.
      userStops: 0, absorbed: 0, holds: 0, holdsSwept: 0, reminders: 0, expiryFailed: 0,
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
    return Boolean(this.config?.evimedCreditsEnabled) && Boolean(this.database) && this.rate > 0
      && (this.simulated ? Boolean(this.simulator) : Boolean(this.client?.configured));
  }

  status() {
    return {
      enabled: Boolean(this.config?.evimedCreditsEnabled),
      operating: this.enabled,
      simulated: this.simulated,
      walletContract: this.simulated ? WALLET_CONTRACT_EXACT : WALLET_CONTRACT_WHOLE_CREDIT,
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
      if (policy && (this.rate !== 1 || policy.pricing_version !== RESEARCH_BILLING_VERSION_WHOLE_CREDIT)) {
        throw new HttpError(503, 'evimed_credits_request_invalid', 'The active research billing policy requires its original one-credit-per-CNY contract.');
      }
      // The exact rule is the platform wallet's, and begins the first time that wallet runs with research billing on.
      if (this.simulated && policy) await exactBillingPolicy(this.database, { activate: true, now: this.now() });
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
   *   status?: string, canceledBy?: string | null, dispatchStatus?: string | null, errorCode?: string | null, effectiveRouteReason?: string | null,
   *   capabilityId?: string | null, subject?: string | null, effectiveAgentId?:string|null, automated?:boolean, startedAt?:string|null, finishedAt?:string|null, accountCreatedAt?:string|null }} run
   * @returns {Promise<{ status: string, credits?: number, reason?: string, duplicate?: boolean, errorCode?: string | null }>}
   */
  async settleRun(run) {
    try {
      return await this.#settleRun(run);
    } finally {
      // A hold can never outlive its run. Whatever happened above — a charge, a
      // run that is not charged, a module that went quiet — the run is over, so
      // its hold is let go (idempotent: a charge already released it).
      await this.#releaseHoldOf(run);
    }
  }

  /** @param {any} run */
  async #settleRun(run) {
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

  /**
   * Versioned accounting never guesses provider usage. One explicit branch by wallet
   * kind (header, decision 6): the platform's own wallet is charged exactly and
   * atomically, EviMed's in whole credits through the outbox.
   * @param {any} run @param {any} policy */
  async settleTask(run, policy) {
    if (!this.enabled) return { status: 'skipped', reason: 'not_configured' };
    try {
      if (this.rate !== 1) return { status: 'error', errorCode: 'evimed_credits_request_invalid' };
      productId(run.userId, 'user');
      if (typeof run.accountCreatedAt !== 'string' || !run.accountCreatedAt.trim()) return { status: 'skipped', reason: 'account_generation_missing' };
      if (policy?.pricing_version !== RESEARCH_BILLING_VERSION_WHOLE_CREDIT) throw new HttpError(409, 'evimed_credits_request_invalid', 'Unsupported research billing policy.');
      return this.simulated ? await this.#settlePlatform(run, policy) : await this.#settleLive(run, policy);
    } catch (error) {
      const code = /** @type {any} */ (error)?.code ?? 'evimed_credits_http_error';
      this.report(code);
      return { status: 'error', errorCode: code };
    }
  }

  /**
   * The live wallet: whole credits, rounded down, outbox and retry; a cancellation
   * is free. What EviMed's wallet would have to support before this can become the
   * exact rule is the header's decision 6, and it is not built here.
   * @param {any} run @param {any} policy */
  async #settleLive(run, policy) {
    const userId = productId(run.userId, 'user');
    const physicalId = productId(run.runId, 'run');
    const successful = ['completed', 'succeeded'].includes(run.status);
    const logical = successful ? autopilotUsageScope(run) : null;
    const runId = logical ? `research_${createHash('sha256').update(`${userId}\0${logical}`).digest('hex')}` : physicalId;
    await migrateEvimedCredits(this.database);
    // A 虚拟临研 module run also settles what its study's own model calls cost that no run asked for
    // (`vcrUsageScope.mjs`): each request is attributed once, to whichever of the study's runs settles first.
    const studyScope = successful ? vcrRunUsageScope(run) : null;
    const ids = successful ? [...runUsageKeys({ ...run, id: physicalId }), ...(studyScope ? [studyScope] : [])].map(id => productId(id, 'run')) : [physicalId];

    // Failed platform work retains its costs as evidence but is waived. A
    // cancellation is not evidence of an earned stage, so it is waived too.
    const researcherOwned = isChargeableResearchRun(run);
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
        `SELECT id,status,priced,currency,purpose,actual_cost,price_version,created_at,run_id,cache_hit_tokens,cache_miss_tokens,output_tokens
         FROM evimed_usage.model_requests WHERE user_id=$1 AND run_id=ANY($2::text[])
         AND NOT EXISTS (SELECT 1 FROM evimed_credits.research_task_requests a
           WHERE a.request_id=evimed_usage.model_requests.id) ORDER BY id`, [userId, ids]);
      const pricedRows = requests.rows.map((/** @type {any} */ request) => ({ ...request,
        billing_eligible: researcherOwned && Date.parse(request.created_at) >= Date.parse(policy.activated_at),
        not_billable_reason: !researcherOwned ? 'platform_task' : Date.parse(request.created_at) >= Date.parse(policy.activated_at) ? undefined : 'before_policy_activation' }));
      const evidence = { ...researchTaskCharge(pricedRows, { owned, mode: WALLET_CONTRACT_WHOLE_CREDIT }), physicalRunId: physicalId,
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
    return this.#charge(/** @type {any} */ (opened.row));
  }

  /**
   * The platform's own wallet: one run, one atomic settlement (design 2026-10-05).
   *
   * Under the exact rule the charge is the sum of the run's billable model calls
   * to the last 1e-8, no rounding and no minimum; under the whole-credit rule —
   * a run that began before the exact rule's activation, whose usage "stays under
   * the old rule" — it is that sum rounded down to a whole credit, taken from the
   * same wallet. Which rule is a fact of the run's start, never of when it ended.
   *
   * The wallet takes up to what is available, releases the run's hold and says
   * what it took and from which lots, in the same transaction that writes the
   * settlement row: there is no state in which the money has moved and the record
   * has not, so there is no outbox, no pending row and no retry on this path. A run
   * that cost more than the balance covers is delivered and charged what the
   * balance held; the rest is not owed, it is recorded on the charge as absorbed by
   * the platform and counted.
   *
   * @param {any} run @param {any} policy the whole-credit rule's activation
   */
  async #settlePlatform(run, policy) {
    return this.#retrying(async () => {
      const exactPolicy = await exactBillingPolicy(this.database, { activate: this.config?.researchBillingEnabled === true, now: this.now() });
      const started = Date.parse(String(run.startedAt ?? ''));
      const exact = Boolean(exactPolicy) && Number.isFinite(started) && started >= Date.parse(String(exactPolicy?.activated_at));
      const mode = exact ? WALLET_CONTRACT_EXACT : WALLET_CONTRACT_WHOLE_CREDIT;
      const userId = productId(run.userId, 'user');
      const physicalId = productId(run.runId, 'run');
      const decision = chargeDecision(run);
      const logical = decision.basis === 'completed' ? autopilotUsageScope(run) : null;
      const runId = logical ? `research_${createHash('sha256').update(`${userId}\0${logical}`).digest('hex')}` : physicalId;
      await migrateEvimedCredits(this.database);
      // What a run used: all of it for a run that completed (a bounded run's calls sit under its dispatch id, an
      // autopilot episode's under the logical task); only its own two ids for a stop, so a stopped attempt is never
      // charged for a sibling's spend; and only its own id where nothing is charged and the calls are kept as evidence.
      // A completed 虚拟临研 module run also settles what its study's own model calls cost that no run asked for
      // (`vcrUsageScope.mjs`): each request is attributed once, to whichever of the study's runs settles first.
      const studyScope = decision.basis === 'completed' ? vcrRunUsageScope(run) : null;
      const ids = decision.basis === 'completed' ? [...runUsageKeys({ ...run, id: physicalId }), ...(studyScope ? [studyScope] : [])].map(id => productId(id, 'run'))
        : decision.basis === 'user_stop' ? [...new Set([physicalId, run.dispatchId].filter(id => typeof id === 'string' && id))].map(id => productId(id, 'run'))
          : [physicalId];
      const researcherOwned = isChargeableResearchRun(run);
      const title = settlementMemo(run);
      const settled = await this.database.transaction(async (/** @type {any} */ client) => {
        // Serialize request attribution across tasks for this account.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evimed-user:${userId}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`research-billing-user:${userId}`]);
        const account = await this.#currentAccount(client, userId, run.startedAt ?? null, run.accountCreatedAt ?? null);
        if (!account) return { stale: true };
        const payer = this.#payerFor(userId, account);
        const prior = await client.query('SELECT * FROM evimed_credits.settlements WHERE run_id=$1', [runId]);
        if (prior.rows[0]?.user_id !== undefined && prior.rows[0].user_id !== userId) throw new HttpError(409, 'usage_settlement_conflict', 'Settlement owner differs.');
        if (prior.rows[0]) return { duplicate: settlement(prior.rows[0]) };
        const requests = await client.query(
          `SELECT id,status,priced,currency,purpose,actual_cost,price_version,created_at,run_id,cache_hit_tokens,cache_miss_tokens,output_tokens
           FROM evimed_usage.model_requests WHERE user_id=$1 AND run_id=ANY($2::text[])
           AND NOT EXISTS (SELECT 1 FROM evimed_credits.research_task_requests a
             WHERE a.request_id=evimed_usage.model_requests.id) ORDER BY id`, [userId, ids]);
        const activated = Date.parse(String(policy.activated_at));
        const pricedRows = requests.rows.map((/** @type {any} */ request) => ({ ...request,
          billing_eligible: researcherOwned && Date.parse(request.created_at) >= activated,
          not_billable_reason: !researcherOwned ? 'platform_task' : Date.parse(request.created_at) >= activated ? undefined : 'before_policy_activation' }));
        const evidence = { ...researchTaskCharge(pricedRows, { owned: decision.charges, mode }), physicalRunId: physicalId,
          logicalTaskId: logical, policyActivatedAt: new Date(policy.activated_at).toISOString() };
        const requested = researchMoneyUnits(evidence.creditsAmount);
        if (requested > 10_000_000n * 100_000_000n) throw new RangeError('Invalid task credit amount.');
        /** @type {{ taken: string, shortfall: string, lots: any[], balance: string | null, receiptId: string | null, at?: string }} */
        let outcome = { taken: researchMoneyDecimal(0n), shortfall: researchMoneyDecimal(0n), lots: [], balance: null, receiptId: null };
        if (requested > 0n) {
          if (!payer) throw new EvimedCreditsError('evimed_credits_account_unlinked', 'This account has no wallet to charge.', { final: true });
          outcome = await this.simulator.settle({ payer, requestId: runId, amount: researchMoneyDecimal(requested), holdRunId: physicalId,
            occurredAt: typeof run.finishedAt === 'string' ? run.finishedAt : null, client });
        } else if (payer) {
          // Nothing to take, but the run is over: its hold goes with it.
          await this.simulator.release({ runId: physicalId, client });
        }
        // The charge's line is stamped with the instant its deduct entry was written, under the wallet's lock, so it
        // reads after the expiry and the monthly gift the same operation wrote before it (review F9). A line with
        // no entry (nothing was taken) is stamped now.
        const at = outcome.at ? new Date(outcome.at) : this.now();
        // The reason a run that was charged nothing was charged nothing: why it was not charged at all, or that
        // there was nothing billable to charge.
        const notChargedReason = decision.reason ?? (requested === 0n ? 'no_usage' : null);
        const charged = { ...evidence, requestedCny: researchMoneyDecimal(requested), takenCredits: outcome.taken, absorbedCredits: outcome.shortfall,
          chargedCny: outcome.taken, creditsAmount: outcome.taken, lots: outcome.lots, balanceAfter: outcome.balance,
          chargeBasis: decision.basis, notChargedReason };
        const inserted = await client.query(
          `INSERT INTO evimed_credits.settlements
           (run_id,user_id,project_id,capability_id,memo,cost_cny,credits,credits_per_cny,status,attempts,next_attempt_at,settled_at,upstream_user_id,owner_created_at,wallet,
            requested,absorbed,wallet_contract,charge_basis,receipt_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,1,'settled',0,NULL,$8,$9,(SELECT created_at FROM evimed_control.users WHERE id=$2),$10,$11,$12,$13,$14,$15)
           ON CONFLICT(run_id) DO NOTHING RETURNING *`,
          [runId, userId, run.projectId ?? null, run.capabilityId ?? '', title, evidence.actualCny, outcome.taken, at.toISOString(), payer, this.walletKind,
            researchMoneyDecimal(requested), outcome.shortfall, mode, decision.basis, outcome.receiptId]);
        // The advisory lock above is held, so no other settlement of this run can be here; a conflict would mean
        // the wallet has already moved for a record that did not land, and the only safe answer is to undo both.
        if (!inserted.rows[0]) throw new HttpError(409, 'usage_settlement_conflict', 'The settlement row appeared while its charge was being taken.');
        await client.query(`INSERT INTO evimed_credits.research_tasks(run_id,user_id,title,evidence,created_at,status,settled_at,owner_created_at,wallet)
          VALUES($1,$2,$3,$4::jsonb,$5,'settled',$5,(SELECT created_at FROM evimed_control.users WHERE id=$2),$6)`, [runId, userId, title, JSON.stringify(charged), at.toISOString(), this.walletKind]);
        for (const request of pricedRows.filter((/** @type {any} */ row) => row.status === 'settled' && row.billing_eligible === true)) await client.query(
          'INSERT INTO evimed_credits.research_task_requests(request_id,run_id) VALUES($1,$2)', [request.id, runId]);
        return { row: settlement(inserted.rows[0]), outcome, decision, requested };
      });
      if (settled.stale) return { status: 'skipped', reason: 'account_changed' };
      if (settled.duplicate) {
        this.counters.duplicates += 1;
        return { status: settled.duplicate.status ?? 'unknown', duplicate: true, credits: settled.duplicate.credits };
      }
      this.counters.settled += 1;
      if (settled.decision.basis === 'user_stop') this.counters.userStops += 1;
      const absorbed = settled.outcome.shortfall;
      if (researchMoneyUnits(absorbed) > 0n) this.counters.absorbed += 1;
      return { status: 'settled', credits: settled.outcome.taken, requested: researchMoneyDecimal(settled.requested), absorbed,
        ...(settled.decision.reason ? { reason: settled.decision.reason } : settled.requested === 0n ? { reason: 'no_usage' } : {}) };
    });
  }

  /**
   * Run a settlement again, a few times, if the database turned it away for a
   * reason that goes away (a deadlock victim, a connection that dropped). Safe
   * because a settlement is idempotent by its run id and is one commit; bounded
   * because an unbounded retry is how one outage becomes a request loop.
   * @template T @param {() => Promise<T>} work @returns {Promise<T>}
   */
  async #retrying(work) {
    for (let attempt = 1; ; attempt += 1) {
      try { return await work(); } catch (error) {
        if (attempt >= 3 || !transient(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt * attempt));
      }
    }
  }

  /**
   * Freeze 灵豆 for a run that has just started: the smaller of its P90 estimate
   * and what is available. Only for a commissioned run — one with a capability that
   * has an estimate; a plain question takes no hold — and only under the exact
   * rule. Never throws and never refuses: admission was the start check's, and
   * billing failing never stops research.
   * @param {{ userId: string, runId: string, capabilityId?: string | null, startedAt?: string | null }} run
   * @returns {Promise<{ held: string } | null>} null where no hold applies
   */
  async holdForRun({ userId, runId, capabilityId = null, startedAt = null }) {
    try {
      if (!this.simulated || !this.enabled || !this.simulator) return null;
      const id = String(capabilityId ?? '').trim();
      if (!id || id === OPEN_DOMAIN_ANSWER_AGENT_ID) return null;
      const exactPolicy = await exactBillingPolicy(this.database, { activate: false });
      const started = Date.parse(String(startedAt ?? ''));
      if (!exactPolicy || !Number.isFinite(started) || started < Date.parse(String(exactPolicy.activated_at))) return null;
      const estimate = await this.#estimateUnits(id);
      if (estimate.p90 <= 0n) return null;
      const payer = await this.#payer(productId(userId, 'user'));
      if (!payer) return null;
      const held = await this.simulator.hold({ payer, runId: productId(runId, 'run'), amount: researchMoneyDecimal(estimate.p90), ttlMs: this.holdTtlMs });
      if (!held.replay && researchMoneyUnits(held.held) > 0n) this.counters.holds += 1;
      return { held: held.held };
    } catch (error) {
      this.report(typeof /** @type {any} */ (error)?.code === 'string' ? /** @type {any} */ (error).code : 'evimed_credits_hold_failed');
      return null;
    }
  }

  /** @param {any} run */
  async #releaseHoldOf(run) {
    if (!this.simulated || !this.simulator || !run?.runId) return;
    try { await this.simulator.release({ runId: productId(run.runId, 'run') }); }
    catch (error) { this.report(typeof /** @type {any} */ (error)?.code === 'string' ? /** @type {any} */ (error).code : 'evimed_credits_hold_release_failed'); }
  }

  /**
   * One statement line as the page reads it (design 11). Amounts are exact decimal
   * strings; the page draws them with `formatCredits`.
   *
   * A charge says what it was, what paid for it (gifted and purchased), what the
   * balance was after, and its status: settled, pending (EviMed's outbox only),
   * waived (not charged, with its reason in words), or absorbed (the balance could
   * not cover it, and the platform carried the rest). The other lines are 充值,
   * 赠送 (source, expiry date), 到期 and 调整. A hold is not a line; it shows on the
   * balance.
   * @param {any} row
   */
  #statementItem(row) {
    const evidence = row.evidence;
    const at = new Date(row.created_at).toISOString();
    const label = this.simulated ? SIMULATED_WALLET_LABEL : '';
    if (['topup', 'grant', 'expire', 'adjust'].includes(evidence.kind)) {
      const source = typeof evidence.source === 'string' ? evidence.source : null;
      const sourceLabel = source ? (/** @type {Record<string, string>} */ (CREDIT_SOURCE_LABELS)[source] ?? source) : null;
      const expiresAt = evidence.expiresAt ? new Date(evidence.expiresAt).toISOString() : null;
      const title = evidence.kind === 'topup' ? `${label}充值`
        : evidence.kind === 'grant' ? `${label}赠送 · ${sourceLabel ?? '赠送'}`
          : evidence.kind === 'expire' ? `${label}赠送到期${sourceLabel ? ` · ${sourceLabel}` : ''}` : `${label}调整`;
      return { id: row.run_id, runId: null, title, at, status: 'settled', kind: evidence.kind,
        amount: exactAmount(evidence.credits), requestedAmount: exactAmount(evidence.credits), waivedCny: '0.00000000',
        balanceAfter: evidence.balanceAfter == null ? null : exactAmount(evidence.balanceAfter),
        source, sourceLabel, expiresAt, note: typeof evidence.note === 'string' ? evidence.note : null, simulated: this.simulated };
    }
    const taken = exactAmount(evidence.takenCredits ?? evidence.chargedCny);
    const absorbed = exactAmount(evidence.absorbedCredits);
    const requested = exactAmount(evidence.requestedCny ?? evidence.chargedCny);
    const absorbedUnits = researchMoneyUnits(absorbed);
    const takenUnits = researchMoneyUnits(taken);
    const status = absorbedUnits > 0n ? 'absorbed' : takenUnits === 0n ? 'waived'
      : row.status === 'pending' ? 'pending' : row.status === 'settled' ? 'settled' : 'failed';
    const paid = { gifted: 0n, purchased: 0n };
    for (const lot of Array.isArray(evidence.lots) ? evidence.lots : []) {
      if (lot?.kind === 'gifted' || lot?.kind === 'purchased') paid[/** @type {'gifted' | 'purchased'} */ (lot.kind)] += researchMoneyUnits(String(lot.amount));
    }
    const code = typeof evidence.notChargedReason === 'string' ? evidence.notChargedReason : null;
    return { id: row.run_id, runId: evidence.physicalRunId ?? row.run_id, title: row.title, at, status,
      amount: ['failed', 'pending'].includes(status) ? null : taken, requestedAmount: requested,
      absorbed: absorbedUnits > 0n ? absorbed : null,
      paidBy: evidence.lots ? { gifted: researchMoneyDecimal(paid.gifted), purchased: researchMoneyDecimal(paid.purchased) } : null,
      balanceAfter: evidence.balanceAfter == null ? null : exactAmount(evidence.balanceAfter),
      notChargedCode: status === 'waived' ? code : null,
      notChargedReason: status === 'waived' && code ? (/** @type {Record<string, string>} */ (CREDIT_NOT_CHARGED_REASONS)[code] ?? null) : null,
      actualCny: evidence.actualCny, billableCny: evidence.billableCny,
      waivedCny: evidence.waivedCny, platformCostCny: evidence.platformCostCny ?? null, pricingVersion: evidence.pricingVersion, settlementPrecision: evidence.walletContract,
      kind: 'charge', simulated: this.simulated };
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
    // The wallet's own lines — what came in (充值, 赠送) and what went without a run (到期, 调整) — belong to the
    // platform's wallet alone: a real wallet's top-ups happen elsewhere, so its statements hold charges and nothing else.
    const credits = this.simulated ? `
        UNION ALL
        SELECT e.request_id,w.user_id,''::text,
          jsonb_build_object('kind',e.kind,'credits',e.credits::text,'balanceAfter',e.balance_after::text,
            'source',l.source,'expiresAt',l.expires_at,'note',l.note),e.created_at,'settled'::text,
          'e'||lpad(e.entry_id::text,20,'0')
        FROM evimed_credits.simulated_entries e
          JOIN evimed_credits.simulated_wallets w ON w.payer=e.payer
          JOIN evimed_control.users u ON u.id=w.user_id AND u.created_at=w.owner_created_at
          LEFT JOIN evimed_credits.simulated_lots l ON l.lot_id=e.lot_id
        WHERE w.user_id=$1 AND e.kind IN ('grant','topup','expire','adjust')` : "";
    // One order for every kind of line: when it was written, and then the wallet's own entry sequence — which
    // is monotonic under the wallet's lock — and never the spelling of an id. A charge takes the sequence of its
    // deduct entry; a line with no entry (a run that was not charged) sorts by its own id after them.
    const result = await this.database.query(`SELECT t.*
      FROM (
        SELECT t.run_id,t.user_id,t.title,t.evidence,t.created_at,t.status,
          coalesce('e'||lpad(d.entry_id::text,20,'0'),'r'||t.run_id) AS sort_key
        FROM evimed_credits.research_tasks t
          JOIN evimed_control.users u ON u.id=t.user_id AND u.created_at=t.owner_created_at
          LEFT JOIN evimed_credits.simulated_entries d ON d.request_id=t.run_id AND d.kind='deduct'
        WHERE t.user_id=$1 AND t.wallet=$5
        UNION ALL
        SELECT s.run_id,s.user_id,s.memo,jsonb_build_object(
          'actualCny',s.cost_cny::text,'billableCny',(s.credits/s.credits_per_cny)::numeric(20,8)::text,
          'chargedCny',(s.credits/s.credits_per_cny)::numeric(20,8)::text,'waivedCny','0.00000000',
          'takenCredits',(s.credits/s.credits_per_cny)::numeric(20,8)::text,'absorbedCredits',s.absorbed::text,
          'requestedCny',coalesce(s.requested,s.credits/s.credits_per_cny)::numeric(20,8)::text,
          'pricingVersion','legacy','walletContract','legacy-integer'),s.created_at,s.status,'r'||s.run_id
        FROM evimed_credits.settlements s JOIN evimed_control.users u ON u.id=s.user_id AND u.created_at=s.owner_created_at WHERE s.user_id=$1 AND s.wallet=$5
          AND NOT EXISTS(SELECT 1 FROM evimed_credits.research_tasks t WHERE t.run_id=s.run_id)${credits}
      ) t
      WHERE t.user_id=$1 AND ($2::timestamptz IS NULL OR (t.created_at,t.sort_key)<($2::timestamptz,$3::text))
      ORDER BY t.created_at DESC,t.sort_key DESC LIMIT $4`, [productId(userId,'user'),position?.[0] ?? null,position?.[1] ?? null,bound+1,this.walletKind]);
    const rows = result.rows.slice(0,bound);
    const items = rows.map((/** @type {any} */ row) => this.#statementItem(row));
    const last = rows.at(-1);
    const nextCursor = result.rows.length > bound && last ? Buffer.from(JSON.stringify([new Date(last.created_at).toISOString(),last.sort_key])).toString('base64url') : null;
    return { items, nextCursor };
  }

  /**
   * One charge in full, on request: the line, and what lies behind it — the
   * number of model calls, cache-hit, cache-miss and output tokens, the price
   * list it was priced under, the amount to 8 decimals and which lots paid. The
   * statement never carries this for every line; a reader who wants to check a
   * charge by multiplication asks for that one.
   * @param {string} userId @param {string} id the statement line's id
   */
  async statementDetail(userId, id) {
    await migrateEvimedCredits(this.database);
    const result = await this.database.query(`SELECT t.run_id,t.user_id,t.title,t.evidence,t.created_at,t.status FROM evimed_credits.research_tasks t
      JOIN evimed_control.users u ON u.id=t.user_id AND u.created_at=t.owner_created_at WHERE t.user_id=$1 AND t.run_id=$2 AND t.wallet=$3`,
    [productId(userId, 'user'), String(id).slice(0, 200), this.walletKind]);
    const row = result.rows[0];
    if (!row) throw new HttpError(404, 'credit_statement_not_found', 'No such statement line.');
    const item = this.#statementItem(row);
    const evidence = row.evidence;
    const usage = evidence.usage ?? null;
    return { ...item, detail: {
      calls: usage ? usage.calls : (Array.isArray(evidence.evidence) ? evidence.evidence.filter((/** @type {any} */ line) => line.billable).length : null),
      cacheHitTokens: usage?.cacheHitTokens ?? null, cacheMissTokens: usage?.cacheMissTokens ?? null, outputTokens: usage?.outputTokens ?? null,
      priceVersions: usage?.priceVersions ?? [], pricingVersion: evidence.pricingVersion ?? null, walletContract: evidence.walletContract ?? null,
      amount: exactAmount(evidence.takenCredits ?? evidence.chargedCny), requestedAmount: exactAmount(evidence.requestedCny ?? evidence.chargedCny),
      absorbed: exactAmount(evidence.absorbedCredits),
      lots: Array.isArray(evidence.lots) ? evidence.lots.map((/** @type {any} */ lot) => ({ kind: lot.kind, source: lot.source, expiresAt: lot.expiresAt ?? null, amount: String(lot.amount) })) : [],
    } };
  }

  /**
   * What an operator can read about the charges the platform carried because a
   * balance could not cover them: how many, and how much, since a date.
   * @param {{ since?: Date }} [options]
   * @returns {Promise<{ since: string, count: number, absorbed: string, charged: string, settlements: number }>}
   */
  async absorbedSummary({ since = new Date(0) } = {}) {
    await migrateEvimedCredits(this.database);
    const result = await this.database.query(`SELECT count(*) FILTER (WHERE absorbed>0)::int AS count,
        coalesce(sum(absorbed),0)::text AS absorbed, coalesce(sum(credits),0)::text AS charged, count(*)::int AS settlements
      FROM evimed_credits.settlements WHERE wallet=$1 AND created_at >= $2::timestamptz`, [this.walletKind, since.toISOString()]);
    const row = result.rows[0];
    return { since: since.toISOString(), count: Number(row.count), absorbed: String(row.absorbed), charged: String(row.charged), settlements: Number(row.settlements) };
  }

  /** The allowance is hydrated from the wallet; this ledger never owns it.
   * @param {string} userId @param {{since?:Date}} [options] */
  async allowanceSummary(userId, { since = new Date(0) } = {}) {
    // Where the allowance is simulated, it says so and says where low begins.
    const kind = { simulated: this.simulated, lowThreshold: this.simulated ? SIMULATED_LOW_CREDITS : null };
    // A module that is down reads as unavailable — unknown, never zero — and so
    // does one whose ledger cannot be read right now: the page still opens.
    const unreadable = (/** @type {string} */ status) => ({ balanceCny: null, wallet: null, status, currency: 'CNY', creditsPerCny: this.rate,
      spentCny: 0, pendingCny: 0, waivedCny: 0, settlementPrecision: WALLET_CONTRACT_WHOLE_CREDIT, ledgerReadable: false, ...kind });
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
    const month = { spentCny: Number(result.rows[0]?.spent ?? 0), pendingCny: Number(result.rows[0]?.pending ?? 0), waivedCny: Number(result.rows[0]?.waived ?? 0) };
    if (this.simulated) {
      // The platform's wallet answers in exact decimals: what is available, what is held in each kind, what is frozen,
      // and the next gift to end. `low` is decided here, in exact units, so no surface compares a float with a threshold.
      const wallet = balance.status === 'ok' ? {
        available: balance.available, purchased: balance.purchased, gifted: balance.gifted, frozen: balance.frozen, nextExpiry: balance.nextExpiry,
        low: researchMoneyUnits(balance.available) <= BigInt(SIMULATED_LOW_CREDITS) * 100_000_000n,
      } : null;
      return { balanceCny: wallet ? Number(wallet.available) : null, wallet, status: balance.status, currency: 'CNY', creditsPerCny: this.rate, ...month, settlementPrecision: WALLET_CONTRACT_EXACT };
    }
    return { balanceCny: balance.balance == null || this.rate <= 0 ? null : balance.balance / this.rate, wallet: null, status: balance.status, currency: 'CNY', creditsPerCny: this.rate,
      ...month, settlementPrecision: WALLET_CONTRACT_WHOLE_CREDIT };
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
    if (this.simulated) return this.#chargeOnPlatformWallet(row);
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

  /**
   * A settlement the one-number wallet left pending in its outbox (a run charged
   * through the simulated wire that never got its answer): it is taken from the
   * platform's wallet now, in whole credits as it was asked, up to what is
   * there — a charge that cannot be covered in full is not owed. Idempotent by the
   * run id, like every charge.
   * @param {{ runId: string, userId: string, credits: number, upstreamUserId?: string | null }} row
   */
  async #chargeOnPlatformWallet(row) {
    try {
      const payer = row.upstreamUserId ?? await this.#payer(row.userId);
      if (!payer) throw new EvimedCreditsError("evimed_credits_account_unlinked", "This account has no wallet to charge.", { final: true });
      const outcome = await this.simulator.settle({ payer, requestId: row.runId, amount: String(row.credits) });
      await this.#finish(row.runId, "settled", { receiptId: outcome.receiptId });
      this.counters.settled += 1;
      return { status: "settled", credits: outcome.taken };
    } catch (error) {
      const code = typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evimed_credits_settle_failed";
      if (error instanceof EvimedCreditsError || error instanceof SimulatedWalletRefusal) {
        await this.#finish(row.runId, "refused", { errorCode: code });
        this.counters.refused += 1;
      }
      this.report(code);
      return { status: "pending", errorCode: code };
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
    if (this.simulated) await this.sweepWallet();
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
   * What a capability's settled history says its runs cost, as exact units: the
   * charge each was made, newest first, the last {@link ESTIMATE_SAMPLES}. A run
   * the user stopped is left out (it is a part of a run, not a run), and so is one
   * that was not charged at all.
   * @param {string} id @returns {Promise<bigint[]>}
   */
  async #historyUnits(id) {
    const result = await this.database.query(
      `SELECT COALESCE(requested, cost_cny)::text AS sample FROM evimed_credits.settlements
         WHERE capability_id=$1 AND status='settled' AND wallet=$3 AND COALESCE(charge_basis,'completed')='completed'
           AND (requested IS NOT NULL OR credits > 0) AND COALESCE(requested, cost_cny) > 0
         ORDER BY created_at DESC LIMIT $2`, [id, ESTIMATE_SAMPLES, this.walletKind]);
    return result.rows.map((/** @type {any} */ row) => researchMoneyUnits(String(row.sample)));
  }

  /**
   * P50 and P90 of what a capability is likely to cost, in exact units: its own
   * settled history first, the manifest's own estimated minutes at the reference
   * price when there is not enough of it. A history read that failed is a worse
   * estimate, not a refused start: the manifest answers instead, and `basis` says which.
   * @param {string} id @returns {Promise<{ p50: bigint, p90: bigint, basis: string, samples: number }>}
   */
  async #estimateUnits(id) {
    /** @type {bigint[]} */
    let samples = [];
    if (this.enabled && id) {
      try {
        await migrateEvimedCredits(this.database);
        samples = await this.#historyUnits(id);
      } catch (error) {
        this.report(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evimed_credits_history_unavailable");
      }
    }
    const minutes = CAPABILITY_DISPLAY[id]?.estimatedMinutes;
    const estimated = estimateRunCostUnits({
      samples,
      ...(minutes && Number.isFinite(minutes.min) && Number.isFinite(minutes.max) ? { estimatedMinutes: [minutes.min, minutes.max] } : {}),
    });
    return { ...estimated, samples: samples.length };
  }

  /**
   * What a capability is likely to cost, as a range in 灵豆, before it starts.
   *
   * The capability's own settled history first (`estimateRunCostUnits`'s P50–P90 over
   * the last {@link ESTIMATE_SAMPLES} runs), the manifest's own estimated
   * minutes at the reference price when there is no history — and the basis is
   * returned, so a surface can say 「首次运行」 instead of presenting a guess as
   * a measurement.
   *
   * On the platform's wallet the range is exact (`low` is the P50 and `high` the P90,
   * with `lowDecimal` and `highDecimal` as the 8-decimal strings): an estimate of
   * ¥0.40 is 0.40, not a rounding to 0. On EviMed's it is whole credits, as before.
   * @param {string | null | undefined} capabilityId
   * @returns {Promise<{ capabilityId: string, unit: string, low: number, high: number, lowDecimal?: string, highDecimal?: string, basis: string, samples: number, creditsPerCny: number, simulated?: boolean }>}
   */
  async estimate(capabilityId) {
    const id = String(capabilityId ?? "").trim();
    if (this.simulated) {
      const estimated = await this.#estimateUnits(id);
      const [lowDecimal, highDecimal] = [researchMoneyDecimal(estimated.p50), researchMoneyDecimal(estimated.p90)];
      return { capabilityId: id, unit: "灵豆", low: Number(lowDecimal), high: Number(highDecimal), lowDecimal, highDecimal,
        basis: estimated.basis, samples: estimated.samples, creditsPerCny: this.rate, simulated: true };
    }
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
    };
  }

  /**
   * This account's balance, as a status rather than a throw: a credits service
   * that cannot be reached must not become an error on a page the user opened
   * to read a number.
   *
   * The platform's wallet answers `available` (what can be used), `balance` (what is
   * held), `purchased`, `gifted`, `frozen` and `nextExpiry`, all exact decimal strings;
   * EviMed's answers whole-credit numbers `balance` and `frozen`.
   * @param {string} userId
   * @returns {Promise<Record<string, any>>}
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
      if (this.simulated) {
        const wallet = await this.simulator.snapshot(evimedUserId);
        return { ...wallet, unit: "灵豆", status: "ok", ...kind };
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
   * On the platform's wallet the comparison is made in exact units. A run a person
   * starts needs what is available (the balance less what other runs have frozen) to
   * cover its P50 estimate; a run nobody is watching — a worker-started step, an
   * overnight episode — needs its P90 (`unattended`), because nobody is there to
   * decide. A plain question needs only something to spend. A started run is never
   * interrupted for money: that is settled afterwards, by taking what is there.
   *
   * @param {string} userId @param {string | null | undefined} capabilityId
   * @param {{ unattended?: boolean }} [options]
   * @returns {Promise<{ allowed: true, reason?: string, balance?: number, balanceDecimal?: string, estimate?: any }>}
   */
  async assertBalanceForStart(userId, capabilityId, { unattended = false } = {}) {
    if (!this.#wired()) return { allowed: true, reason: this.failure ? "billing_unavailable" : "not_enabled" };
    // The policy's activation is persisted before research is accepted. A module
    // that cannot do that is not a reason to refuse the research: the start is
    // admitted, nothing will be charged, and readiness carries the code.
    if ((this.config?.researchBillingEnabled || this.failure) && await this.ensureReady()) {
      return { allowed: true, reason: "billing_unavailable" };
    }
    const balance = await this.balanceFor(userId);
    if (balance.balance == null && balance.available == null) return { allowed: true, reason: balance.status };
    const estimate = await this.estimate(capabilityId);
    /** The amount short, as drawn in a refusal, and whether this start is refused. */
    let refused;
    let have;
    let need = null;
    if (this.simulated) {
      const available = researchMoneyUnits(balance.available);
      const plain = !capabilityId || capabilityId === OPEN_DOMAIN_ANSWER_AGENT_ID;
      const needed = plain ? 0n : researchMoneyUnits(unattended ? estimate.highDecimal : estimate.lowDecimal);
      refused = available <= 0n || (needed > 0n && available < needed);
      have = balance.available;
      need = needed > 0n ? researchMoneyDecimal(needed) : null;
    } else {
      const permission = spendingPermission({ balance: balance.balance, dailyLimit: 0, spentToday: 0 });
      refused = !permission.interactive || (estimate.low > 0 && balance.balance < estimate.low);
      have = balance.balance;
      need = estimate.low > 0 ? String(estimate.low) : null;
    }
    if (refused) {
      this.counters.refusedStarts += 1;
      const said = `This account holds ${have} credits and this work is estimated at ${need ?? "an unknown amount"}.`;
      // What a researcher reads where the code cannot be mapped to a sentence —
      // the kernel's own window, the one surface this refusal reaches as text —
      // in the allowance page's own amounts (a credit is `this.rate` per CNY).
      const readerMessage = allowanceRefusalSentence({
        simulated: this.simulated,
        balanceCny: this.rate > 0 ? (this.simulated ? have : balance.balance / this.rate) : null,
        estimateCny: this.rate > 0 && need ? (this.simulated ? need : estimate.low / this.rate) : null,
      });
      // Its own code where the allowance is simulated, so the sentence says so
      // and the top-up it offers is the simulated one.
      const refusal = this.simulated
        ? new HttpError(402, "simulated_credits_exhausted",
          `The simulated allowance is too low. ${said} Top up under Settings → Research allowance (simulated).`)
        : new HttpError(402, "credits_exhausted", said);
      refusal.readerMessage = readerMessage;
      throw refusal;
    }
    return this.simulated
      ? { allowed: true, balance: Number(balance.available), balanceDecimal: balance.available, estimate }
      : { allowed: true, balance: balance.balance, estimate };
  }

  /** The simulated wallet's own surface answers only a deployment whose wallet is simulated and working. */
  #requireSimulated() {
    if (!this.simulated || !this.simulator) throw new HttpError(404, "simulated_wallet_not_enabled", "This deployment has no simulated wallet.");
    if (!this.enabled) throw new HttpError(503, "evimed_credits_unreachable", "The simulated wallet is unavailable.");
  }

  /**
   * What the credits worker does for the platform's wallet each tick, each step on
   * its own so one failing never stops the next: let go of the holds whose run's
   * deadline has passed, expire the gifts whose date has, and remind the accounts
   * whose gifts are about to. Never throws.
   * @returns {Promise<{ holds: number, expired: number, reminded: number }>}
   */
  async sweepWallet() {
    const done = { holds: 0, expired: 0, reminded: 0 };
    if (!this.simulated || !this.simulator || !this.enabled) return done;
    /** @param {() => Promise<void>} step @param {string} code */
    const guarded = async (step, code) => {
      try { await step(); } catch (error) { this.report(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : code); }
    };
    await guarded(async () => { done.holds = await this.simulator.sweepHolds(); this.counters.holdsSwept += done.holds; }, "evimed_credits_hold_sweep_failed");
    await guarded(async () => {
      const swept = await this.simulator.sweepExpiry();
      done.expired = swept.wallets;
      // A wallet that failed is counted and said, once per sweep, and the rest of the batch has gone on without it.
      if (swept.failed > 0) { this.counters.expiryFailed += swept.failed; this.report("evimed_credits_expiry_wallet_failed"); }
    }, "evimed_credits_expiry_sweep_failed");
    await guarded(async () => { done.reminded = await this.remindExpiries(); }, "evimed_credits_reminder_failed");
    return done;
  }

  /**
   * Remind the account 7 days and 1 day before a gift that still has something in
   * it ends — in the inbox, once each per gift. The wallet says which lots are due a reminder and have
   * not had it (`lotsDueForReminder`, written down by `markReminded`), so a sweep reads only what needs
   * work: a thousand gifts that all end at one instant are read a batch at a time, each once, and a
   * second sweep, another process or a restart finds nothing left to do. The notice's own key names the
   * gift and the day count as well, so even a reminder sent and not yet written down is not sent twice.
   *
   * One lot whose notice cannot be written (its account is gone, the inbox failed) is reported and left
   * for a later sweep; it never stops the lots after it. Without an inbox there are no reminders and
   * nothing else changes.
   * @returns {Promise<number>} reminders written this sweep
   */
  async remindExpiries() {
    if (!this.simulated || !this.simulator || typeof this.notify !== "function") return 0;
    const at = this.now();
    let sent = 0;
    for (let batch = 0; batch < REMINDER_BATCHES_PER_SWEEP; batch += 1) {
      const skip = [...this.reminderFailures].filter(([, until]) => until > at.getTime()).map(([lotId]) => lotId);
      const lots = await this.simulator.lotsDueForReminder({ limit: REMINDER_BATCH, skip });
      if (lots.length === 0) break;
      for (const lot of lots) {
        // The database decides what is due; this is the rule's own statement of it, so the two cannot drift apart.
        const days = expiryReminderDue(lot, at);
        if (days !== lot.days) continue;
        const label = /** @type {Record<string, string>} */ (CREDIT_SOURCE_LABELS)[lot.source] ?? lot.source;
        try {
          await this.notify(lot.userId, {
            noticeType: "notify", severity: "info",
            title: `${SIMULATED_WALLET_LABEL}赠送额度将在 ${days === 1 ? "1 天" : `${days} 天`}内到期`,
            body: `你的${SIMULATED_WALLET_LABEL}${label}里还有 ${formatCredits(lot.remaining, { rounding: "down" })} 灵豆，将于 ${expiryWords(lot.expiresAt)}到期。到期后这部分会从额度中扣除；已充值的灵豆不会过期。`,
            source: { type: "system", id: `credit_lot_${lot.lotId}` },
            idempotencyKey: `credit-expiry:${lot.lotId}:${days}`,
          });
        } catch (error) {
          // The same reminder, already written with other words in it: it was sent, and is written down now.
          if (/** @type {any} */ (error)?.code !== "notification_idempotency_conflict") {
            this.reminderFailures.set(lot.lotId, at.getTime() + REMINDER_RETRY_MS);
            this.report(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evimed_credits_reminder_failed");
            continue;
          }
        }
        if (await this.simulator.markReminded(lot.lotId, days)) {
          sent += 1;
          this.counters.reminders += 1;
        }
      }
      if (lots.length < REMINDER_BATCH) break;
    }
    return sent;
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

  /**
   * An operator's grant to a named account — a compensation or a campaign: one
   * gifted lot with a source, an amount, an expiry date fixed now and a note,
   * once per request id, listed in that account's statement.
   *
   * Who may ask is the route's to decide; what this checks is that the grant is
   * well formed, that the account has a wallet, and that a request id is not
   * reused for a different grant.
   * @param {string} accountId the account to credit
   * @param {{ requestId?: unknown, source?: unknown, amount?: unknown, expiresOn?: unknown, days?: unknown, note?: unknown }} grant
   */
  async operatorGrant(accountId, { requestId, source, amount, expiresOn = null, days = null, note = null }) {
    this.#requireSimulated();
    const payer = await this.#payer(productId(accountId, "user"));
    if (!payer) throw new HttpError(404, "credit_grant_account_not_found", "No such account.");
    try {
      const granted = await this.simulator.grant({ payer, requestId, source, amount, expiresOn, days, note });
      return { lot: granted.lot, balance: granted.balance, duplicate: granted.duplicate };
    } catch (error) {
      if (error instanceof SimulatedWalletRefusal) {
        throw error.status === 409
          ? new HttpError(409, "credit_grant_conflict", "That request id already names a different grant.")
          : new HttpError(400, "credit_grant_invalid", "The grant is not well formed.");
      }
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
