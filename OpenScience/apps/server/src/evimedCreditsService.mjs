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
 *
 * @module evimedCreditsService
 */

import { CAPABILITY_DISPLAY, capabilityTitle, estimateCost, spendingPermission } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { productId } from "./productPersistence.mjs";
import { EvimedCreditsError } from "./evimedCreditsClient.mjs";
import { migrateEvimedCredits } from "./evimedCreditsPersistence.mjs";

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
 * @param {{ capabilityId?: string | null, subject?: string | null }} run
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
    errorCode: row.error_code ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    settledAt: row.settled_at == null ? null : new Date(row.settled_at).toISOString(),
  } : null;
}

export class EvimedCreditsService {
  /**
   * @param {{ config: Record<string, any>, database: any, client: any, usageLedger?: any,
   *   now?: () => Date, report?: (code: string) => void }} dependencies
   */
  constructor({ config, database, client, usageLedger = null, now = () => new Date(), report = () => {} }) {
    this.config = config;
    this.database = database;
    this.client = client;
    this.usageLedger = usageLedger;
    this.now = now;
    this.report = report;
    this.rate = evimedCreditsRate(config);
    this.counters = { settled: 0, skipped: 0, duplicates: 0, pending: 0, refused: 0, abandoned: 0, refusedStarts: 0, balanceUnavailable: 0 };
  }

  /** On only when the toggle, the database, the two addresses, the key and the
   *  rate are all there. Anything missing is named by `status()` and settles
   *  nothing — it never half-charges. */
  get enabled() {
    return Boolean(this.config?.evimedCreditsEnabled) && Boolean(this.database) && Boolean(this.client?.configured) && this.rate > 0;
  }

  status() {
    return {
      enabled: Boolean(this.config?.evimedCreditsEnabled),
      operating: this.enabled,
      creditsPerCny: this.rate,
      counters: { ...this.counters },
      upstream: this.client?.status?.() ?? null,
    };
  }

  /** Readiness: the schema exists and can be written. @returns {Promise<{ok: true}>} */
  async ready() {
    await migrateEvimedCredits(this.database);
    return { ok: true };
  }

  /** @param {string} userId @param {string} runId */
  async settlementOf(userId, runId) {
    await migrateEvimedCredits(this.database);
    const result = await this.database.query(
      "SELECT * FROM evimed_credits.settlements WHERE run_id=$1 AND user_id=$2",
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
   *   capabilityId?: string | null, subject?: string | null }} run
   * @returns {Promise<{ status: string, credits?: number, reason?: string, duplicate?: boolean, errorCode?: string | null }>}
   */
  async settleRun(run) {
    if (!this.enabled) {
      this.counters.skipped += 1;
      const reason = !this.config?.evimedCreditsEnabled ? "not_enabled" : this.rate <= 0 ? "rate_unset" : "not_configured";
      return { status: "skipped", reason };
    }
    try {
      const userId = productId(run.userId, "user");
      const runId = productId(run.runId, "run");
      const ids = [runId, run.dispatchId ? productId(run.dispatchId, "run") : null].filter(
        (/** @type {string | null} */ id) => typeof id === "string",
      );
      const costCny = await this.#costOf(userId, /** @type {string[]} */ ([...new Set(ids)]));
      const credits = creditsForCost(costCny, this.rate);
      const memo = settlementMemo({ capabilityId: run.capabilityId ?? null, subject: run.subject ?? null });
      const opened = await this.#open({
        userId, runId, projectId: run.projectId ?? null, capabilityId: run.capabilityId ?? "",
        memo, costCny, credits,
      });
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
   * Open the run's settlement row, or report that it already exists. A run that
   * cost nothing is opened `settled` with no charge and no upstream call — the
   * record that it was free is the point, not the zero.
   * @param {{ userId: string, runId: string, projectId: string | null, capabilityId: string,
   *   memo: string, costCny: number, credits: number }} input
   */
  async #open(input) {
    await migrateEvimedCredits(this.database);
    const at = this.now();
    const free = input.credits <= 0;
    const result = await this.database.query(
      `INSERT INTO evimed_credits.settlements
         (run_id,user_id,project_id,capability_id,memo,cost_cny,credits,credits_per_cny,status,attempts,next_attempt_at,settled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (run_id) DO NOTHING RETURNING *`,
      [input.runId, input.userId, input.projectId, String(input.capabilityId ?? ""), input.memo,
        input.costCny, input.credits, this.rate,
        free ? "settled" : "pending", free ? 0 : 1,
        free ? null : new Date(at.getTime() + EVIMED_CREDITS_BACKOFF_MS[0]).toISOString(),
        free ? at.toISOString() : null],
    );
    if (result.rows[0]) return { inserted: true, row: settlement(result.rows[0]) };
    const existing = await this.database.query("SELECT * FROM evimed_credits.settlements WHERE run_id=$1", [input.runId]);
    return { inserted: false, row: settlement(existing.rows[0] ?? null) };
  }

  /**
   * Send one claimed settlement and write down what happened.
   * @param {{ runId: string, userId: string, credits: number, memo: string, attempts: number, createdAt: string }} row
   */
  async #charge(row) {
    if (row.attempts > EVIMED_CREDITS_MAX_ATTEMPTS) {
      await this.#finish(row.runId, "abandoned", { errorCode: "evimed_credits_attempts_exhausted" });
      this.counters.abandoned += 1;
      return { status: "abandoned", credits: row.credits, errorCode: "evimed_credits_attempts_exhausted" };
    }
    try {
      const receipt = await this.client.deduct({
        requestId: row.runId, userId: row.userId, credits: row.credits, memo: row.memo, occurredAt: row.createdAt,
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
    await this.database.query(
      `UPDATE evimed_credits.settlements
         SET status=$2, next_attempt_at=NULL, receipt_id=COALESCE($3,receipt_id), error_code=$4,
             settled_at=CASE WHEN $2='settled' THEN $5::timestamptz ELSE settled_at END
       WHERE run_id=$1 AND status='pending'`,
      [runId, status, receiptId, errorCode, this.now().toISOString()],
    );
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
           WHERE status='pending' AND next_attempt_at <= $1::timestamptz
           ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [at]);
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
    if (!this.enabled) return 0;
    await migrateEvimedCredits(this.database);
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
    if (!this.enabled) {
      return { balance: null, frozen: null, unit: "灵豆", status: this.config?.evimedCreditsEnabled ? "unconfigured" : "disabled" };
    }
    try {
      const answer = await this.client.balance(productId(userId, "user"));
      return { balance: answer.balance, frozen: answer.frozen, unit: "灵豆", status: "ok" };
    } catch (error) {
      this.counters.balanceUnavailable += 1;
      const code = typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evimed_credits_unreachable";
      this.report(code);
      return { balance: null, frozen: null, unit: "灵豆", status: code };
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
    if (!this.enabled) return { allowed: true, reason: "not_enabled" };
    const balance = await this.balanceFor(userId);
    if (balance.balance == null) return { allowed: true, reason: balance.status };
    const estimate = await this.estimate(capabilityId);
    const permission = spendingPermission({ balance: balance.balance, dailyLimit: 0, spentToday: 0 });
    const short = estimate.low > 0 && balance.balance < estimate.low;
    if (!permission.interactive || short) {
      this.counters.refusedStarts += 1;
      throw new HttpError(402, permission.code ?? "credits_exhausted",
        `This account holds ${balance.balance} credits and this work is estimated at ${estimate.low}.`);
    }
    return { allowed: true, balance: balance.balance, estimate };
  }
}

