import { HttpError } from "./security.mjs";
import { productId, productInteger } from "./productPersistence.mjs";
import { migrateUsageLedger } from "./usagePersistence.mjs";

const fingerprintPattern = /^[0-9a-f]{64}$/;
const moneyScale = 100_000_000;

/** The rolling windows settled spend is measured over. Open cost is windowed the
 *  same way, so the two halves of one limit answer to the same clock. Frozen
 *  because it is spliced into SQL: the members are the only interval literals
 *  this module will ever interpolate. */
export const openCostWindows = Object.freeze({ day: "24 hours", week: "7 days" });

/** @type {Set<string>} */
const openCostWindowValues = new Set(Object.values(openCostWindows));
const placeholderPattern = /^\$[1-9][0-9]*$/;

/** Cost a new call must respect on top of settled spend: a reservation counts
 *  until it expires, and an `uncertain` row counts while it is still inside the
 *  rolling window. `uncertain` used to count forever, so one truncated provider
 *  response removed that budget from the account permanently.
 *  Written once because `reserveModel` and `assertWithinLimits` both ask this
 *  question and a divergence between them is invisible until it costs money.
 *
 *  Both fragments it splices are checked rather than trusted: an interval
 *  literal cannot be parameterized, so the only safe inputs are the frozen
 *  window members and a bound-parameter name.
 *
 *  @param {string} window one of `openCostWindows`' values
 *  @param {string} instantPlaceholder the bound parameter holding the decision
 *    instant, e.g. `"$2"` — every caller must actually bind it there
 */
export function openCostPredicate(window, instantPlaceholder) {
  if (!openCostWindowValues.has(window)) {
    throw new HttpError(500, "usage_window_invalid", "Unknown open-cost window.");
  }
  if (!placeholderPattern.test(instantPlaceholder)) {
    throw new HttpError(500, "usage_window_invalid", "Invalid open-cost instant placeholder.");
  }
  const at = `${instantPlaceholder}::timestamptz`;
  return `((status='reserved' AND reservation_expires_at > ${at})`
    + ` OR (status='uncertain' AND created_at >= ${at} - interval '${window}'))`;
}

/** @param {unknown} value @param {string} name @param {number} max */
function text(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
    throw new HttpError(400, "usage_payload_invalid", `Invalid ${name}.`);
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function money(value, name) {
  if (typeof value !== "number") throw new HttpError(400, "usage_payload_invalid", `Invalid ${name}.`);
  const number = value;
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000_000) {
    throw new HttpError(400, "usage_payload_invalid", `Invalid ${name}.`);
  }
  return Math.round(number * moneyScale) / moneyScale;
}

/** @param {unknown} value @param {string} name */
function instant(value, name) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new HttpError(400, "usage_payload_invalid", `Invalid ${name}.`);
  }
  return value.toISOString();
}

/** @param {unknown} value */
function tokenCount(value) {
  return productInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

/** @param {any} row */
function record(row) {
  return row ? {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    runId: row.run_id,
    model: row.model,
    priceVersion: row.price_version,
    currency: row.currency,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    revision: Number(row.revision),
    reservedCost: Number(row.reserved_cost),
    actualCost: row.actual_cost == null ? null : Number(row.actual_cost),
    priced: row.priced,
    providerRequestId: row.provider_request_id,
    errorCode: row.error_code,
    usage: row.cache_hit_tokens == null ? null : {
      cacheHitTokens: Number(row.cache_hit_tokens),
      cacheMissTokens: Number(row.cache_miss_tokens),
      completionTokens: Number(row.output_tokens),
    },
    reservationExpiresAt: new Date(row.reservation_expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    settledAt: row.settled_at == null ? null : new Date(row.settled_at).toISOString(),
  } : null;
}

/** Durable, concurrency-safe model request reservations and settlement. */
export class UsageLedger {
  /** @param {any} database */
  constructor(database) { this.database = database; }

  async health() {
    await migrateUsageLedger(this.database);
    // Expired reservations are reported next to the uncertain count so a
    // reconciler that stopped running is visible on /api/ready instead of
    // looking exactly like an account that simply spent nothing. Readiness runs
    // this every 30 seconds, so it reads only the rows it can count: settled and
    // released rows contribute 0 to both filters, and excluding them is what
    // lets the status-partial index answer this instead of the whole table.
    const result = await this.database.query(`SELECT
      count(*) FILTER (WHERE status='uncertain')::integer AS uncertain,
      count(*) FILTER (WHERE status='reserved' AND reservation_expires_at <= clock_timestamp())::integer AS expired_reservations
      FROM evimed_usage.model_requests WHERE status IN ('reserved','uncertain')`);
    return {
      connected: true,
      uncertain: Number(result.rows[0]?.uncertain ?? 0),
      expiredReservations: Number(result.rows[0]?.expired_reservations ?? 0),
    };
  }

  /** @param {{id:string,userId:string,projectId:string,runId?:string|null,model:string,priceVersion:string,currency:string,requestFingerprint:string,estimatedCost:number,dailyLimit?:number,weeklyLimit?:number,runLimit?:number,now?:Date,ttlMs?:number}} input */
  async reserveModel(input) {
    const now = input.now ?? new Date();
    const ttlMs = input.ttlMs ?? 30 * 60_000;
    productInteger(ttlMs, 60_000, 24 * 60 * 60_000);
    const values = {
      id: productId(input.id), userId: productId(input.userId, "user"), projectId: productId(input.projectId, "project"),
      runId: input.runId == null ? null : productId(input.runId, "run"),
      model: text(input.model, "model"), priceVersion: text(input.priceVersion, "price version"), currency: text(input.currency, "currency", 12),
      requestFingerprint: text(input.requestFingerprint, "request fingerprint", 64), estimatedCost: money(input.estimatedCost, "estimated cost"),
      dailyLimit: money(input.dailyLimit ?? 0, "daily limit"), weeklyLimit: money(input.weeklyLimit ?? 0, "weekly limit"),
      runLimit: money(input.runLimit ?? 0, "run limit"),
      now: instant(now, "reservation time"), expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    if (values.currency !== "CNY") throw new HttpError(400, "usage_payload_invalid", "Unsupported usage currency.");
    if (!fingerprintPattern.test(values.requestFingerprint)) throw new HttpError(400, "usage_payload_invalid", "Invalid request fingerprint.");
    await migrateUsageLedger(this.database);
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-usage:${values.userId}`]);
      const existing = await client.query("SELECT *,reservation_expires_at>clock_timestamp() AS reservation_active FROM evimed_usage.model_requests WHERE id=$1 FOR UPDATE", [values.id]);
      if (existing.rowCount) {
        const same = existing.rows[0].user_id === values.userId && existing.rows[0].project_id === values.projectId
          && existing.rows[0].model === values.model && existing.rows[0].request_fingerprint === values.requestFingerprint
          && existing.rows[0].run_id === values.runId
          && existing.rows[0].price_version === values.priceVersion && existing.rows[0].currency === values.currency
          && Number(existing.rows[0].reserved_cost) === values.estimatedCost
          && existing.rows[0].status === "reserved"
          && new Date(existing.rows[0].reservation_expires_at).toISOString() === values.expiresAt
          && existing.rows[0].reservation_active === true;
        if (!same) throw new HttpError(409, "usage_reservation_conflict", "The request id already names another reservation.");
        return record(existing.rows[0]);
      }
      const totals = await client.query(`SELECT
        coalesce(sum(CASE WHEN status='settled' AND created_at >= $2::timestamptz - interval '${openCostWindows.day}' THEN actual_cost ELSE 0 END),0) AS day_settled,
        coalesce(sum(CASE WHEN status='settled' AND created_at >= $2::timestamptz - interval '${openCostWindows.week}' THEN actual_cost ELSE 0 END),0) AS week_settled,
        coalesce(sum(CASE WHEN ${openCostPredicate(openCostWindows.day, "$2")} THEN reserved_cost ELSE 0 END),0) AS day_open,
        coalesce(sum(CASE WHEN ${openCostPredicate(openCostWindows.week, "$2")} THEN reserved_cost ELSE 0 END),0) AS week_open,
        coalesce(sum(CASE WHEN run_id=$3 AND status='settled' THEN actual_cost
          WHEN run_id=$3 AND ${openCostPredicate(openCostWindows.week, "$2")} THEN reserved_cost ELSE 0 END),0) AS run_committed
        FROM evimed_usage.model_requests WHERE user_id=$1`, [values.userId, values.now, values.runId]);
      const day = Number(totals.rows[0].day_settled) + Number(totals.rows[0].day_open);
      const week = Number(totals.rows[0].week_settled) + Number(totals.rows[0].week_open);
      const overDay = values.dailyLimit > 0 && day + values.estimatedCost > values.dailyLimit;
      const overWeek = values.weeklyLimit > 0 && week + values.estimatedCost > values.weeklyLimit;
      const runCommitted = Number(totals.rows[0].run_committed);
      const overRun = values.runLimit > 0 && values.runId != null && runCommitted + values.estimatedCost > values.runLimit;
      if (overRun || overDay || overWeek) {
        throw new HttpError(402, "usage_budget_exceeded", "This request exceeds the account spending limit.", {
          window: overRun ? "run" : overDay ? "day" : "week",
          limit: overRun ? values.runLimit : overDay ? values.dailyLimit : values.weeklyLimit,
          committed: overRun ? runCommitted : overDay ? day : week,
          requested: values.estimatedCost, currency: values.currency,
        });
      }
      const inserted = await client.query(`INSERT INTO evimed_usage.model_requests
        (id,user_id,project_id,run_id,model,price_version,currency,request_fingerprint,status,reserved_cost,reservation_expires_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9,$10,$11) RETURNING *`,
      [values.id, values.userId, values.projectId, values.runId, values.model, values.priceVersion, values.currency,
        values.requestFingerprint, values.estimatedCost, values.expiresAt, values.now]);
      return record(inserted.rows[0]);
    });
  }

  /** @param {string} id @param {{usage:{cacheHitTokens:number,cacheMissTokens:number,completionTokens:number},actualCost:number,priced:boolean,providerRequestId?:string|null}} input */
  async settleModel(userId, id, input) {
    const usage = {
      cacheHitTokens: tokenCount(input.usage?.cacheHitTokens),
      cacheMissTokens: tokenCount(input.usage?.cacheMissTokens),
      completionTokens: tokenCount(input.usage?.completionTokens),
    };
    const actualCost = money(input.actualCost, "actual cost");
    if (typeof input.priced !== "boolean") throw new HttpError(400, "usage_payload_invalid", "Invalid price status.");
    const providerRequestId = input.providerRequestId == null ? null : text(input.providerRequestId, "provider request id", 512);
    await migrateUsageLedger(this.database);
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-usage:${productId(userId, "user")}`]);
      const current = await this.#locked(client, userId, id);
      if (current.status === "settled") {
        const same = Number(current.actual_cost) === actualCost && current.priced === input.priced
          && Number(current.cache_hit_tokens) === usage.cacheHitTokens && Number(current.cache_miss_tokens) === usage.cacheMissTokens
          && Number(current.output_tokens) === usage.completionTokens && current.provider_request_id === providerRequestId;
        if (same) return record(current);
        throw new HttpError(409, "usage_settlement_conflict", "The request already has another settlement.");
      }
      if (!['reserved', 'uncertain'].includes(current.status)) throw new HttpError(409, "usage_settlement_conflict", "The request is no longer settleable.");
      const result = await client.query(`UPDATE evimed_usage.model_requests SET status='settled',revision=revision+1,
        actual_cost=$2,priced=$3,cache_hit_tokens=$4,cache_miss_tokens=$5,output_tokens=$6,provider_request_id=$7,
        error_code=NULL,settled_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [current.id, actualCost, input.priced, usage.cacheHitTokens, usage.cacheMissTokens, usage.completionTokens, providerRequestId]);
      return record(result.rows[0]);
    });
  }

  /** @param {string} userId @param {string} id @param {string} errorCode */
  async release(userId, id, errorCode) { return this.#terminal(userId, id, "released", errorCode, null); }

  /** @param {string} userId @param {string} id @param {string} errorCode @param {{providerRequestId?:string|null}} options */
  async markUncertain(userId, id, errorCode, { providerRequestId = null } = {}) {
    return this.#terminal(userId, id, "uncertain", errorCode, providerRequestId);
  }

  async #terminal(userId, id, status, errorCode, providerRequestId) {
    const code = text(errorCode, "error code", 120);
    const provider = providerRequestId == null ? null : text(providerRequestId, "provider request id", 512);
    await migrateUsageLedger(this.database);
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-usage:${productId(userId, "user")}`]);
      const current = await this.#locked(client, userId, id);
      if (current.status === status && current.error_code === code && current.provider_request_id === provider) return record(current);
      // `reservation_expired` is the sweep's placeholder cause, not a verdict:
      // it means "the settle call never arrived", so a late call that finally
      // names the real reason must be allowed to replace it. The money state
      // the sweep already reported is kept — only the diagnosis is written,
      // because the sweep decided `uncertain` for a reason that has not changed.
      const sweptPlaceholder = current.status === "uncertain" && current.error_code === "reservation_expired";
      if (current.status !== "reserved" && !sweptPlaceholder) {
        throw new HttpError(409, "usage_settlement_conflict", "The request already reached another state.");
      }
      const result = await client.query(`UPDATE evimed_usage.model_requests SET status=$2,revision=revision+1,
        error_code=$3,provider_request_id=$4,settled_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [current.id, sweptPlaceholder ? current.status : status, code, provider]);
      return record(result.rows[0]);
    });
  }

  /** Move reservations whose settlement never arrived out of `reserved`.
   *
   *  A reservation whose settle call failed stays `reserved` forever: once its
   *  expiry passes the budget predicate stops counting it, so the row is
   *  stranded with no transition and no audit line. It becomes `uncertain`, not
   *  `released`, because the provider may already have charged for the call —
   *  `uncertain` is the honest state and is the one `health()` surfaces.
   *
   *  The database's `clock_timestamp()` is the authoritative clock here, the
   *  same one `health()`'s `expiredReservations` counts against. Binding the
   *  Node process instant instead would let the metric that exists to reveal a
   *  stuck sweeper disagree with the sweeper itself. `now` overrides it for
   *  tests only and is null in production.
   *
   *  @param {{now?:Date|null,limit?:number}} options
   *  @returns {Promise<{reconciled:number,remaining:number,failedAccounts:number}>}
   *    rows transitioned by this batch, rows still expired after it (a non-zero
   *    remainder is the signal to run again, not an error), and accounts whose
   *    own transaction failed and were skipped.
   */
  async reconcileExpiredReservations({ now = null, limit = 200 } = {}) {
    const at = now == null ? null : instant(now, "reconciliation time");
    const batch = productInteger(limit, 1, 1_000);
    await migrateUsageLedger(this.database);
    const candidates = await this.database.query(`SELECT user_id,id FROM evimed_usage.model_requests
      WHERE status='reserved' AND reservation_expires_at <= coalesce($1::timestamptz,clock_timestamp())
      ORDER BY reservation_expires_at,id LIMIT $2`, [at, batch]);
    /** @type {Map<string,string[]>} */
    const byAccount = new Map();
    for (const row of candidates.rows) {
      const ids = byAccount.get(row.user_id) ?? [];
      ids.push(row.id);
      byAccount.set(row.user_id, ids);
    }
    let reconciled = 0;
    let failedAccounts = 0;
    for (const [userId, ids] of byAccount) {
      try {
        const updated = await this.database.transaction(async (client) => {
          // Bounded, because candidates always arrive in the same order: an
          // account holding its advisory lock indefinitely would otherwise stall
          // this batch and every batch after it at the same head of the queue.
          await client.query("SET LOCAL lock_timeout = '5s'");
          // The same per-account advisory lock every other mutation takes, so a
          // sweep can never interleave with the settlement it is giving up on.
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-usage:${productId(userId, "user")}`]);
          return client.query(`UPDATE evimed_usage.model_requests SET status='uncertain',revision=revision+1,
            error_code='reservation_expired',settled_at=clock_timestamp()
            WHERE user_id=$1 AND id=ANY($2::text[]) AND status='reserved'
              AND reservation_expires_at <= coalesce($3::timestamptz,clock_timestamp())
            RETURNING id`, [userId, ids, at]);
        });
        reconciled += updated.rowCount ?? updated.rows.length;
      } catch {
        // One account's deadlock, lock wait or dropped connection must not end
        // the batch: the next account's expired rows are independent, and an
        // abort here would strand them behind the same failing account on every
        // later run. Counted and returned so a persistent failure is visible.
        failedAccounts += 1;
      }
    }
    const rest = await this.database.query(`SELECT count(*)::integer AS remaining FROM evimed_usage.model_requests
      WHERE status='reserved' AND reservation_expires_at <= coalesce($1::timestamptz,clock_timestamp())`, [at]);
    return { reconciled, remaining: Number(rest.rows[0]?.remaining ?? 0), failedAccounts };
  }

  /** @param {string} userId @param {{since?:Date}} options */
  async summary(userId, { since = new Date(0) } = {}) {
    const at = instant(since, "summary start");
    await migrateUsageLedger(this.database);
    const result = await this.database.query(`WITH filtered AS MATERIALIZED (
        SELECT * FROM evimed_usage.model_requests WHERE user_id=$1 AND created_at >= $2
      ), models AS (
        SELECT model,count(*)::integer AS calls,coalesce(sum(actual_cost),0) AS cost
        FROM filtered WHERE status='settled' GROUP BY model
      ) SELECT
      count(*)::integer AS total_calls,
      count(*) FILTER (WHERE status='reserved')::integer AS reserved_calls,
      count(*) FILTER (WHERE status='settled')::integer AS settled_calls,
      count(*) FILTER (WHERE status='released')::integer AS released_calls,
      count(*) FILTER (WHERE status='uncertain')::integer AS uncertain_calls,
      coalesce(sum(actual_cost) FILTER (WHERE status='settled'),0) AS actual_cost,
      coalesce(sum(reserved_cost) FILTER (WHERE status IN ('reserved','uncertain')),0) AS reserved_cost,
      coalesce(sum(cache_hit_tokens) FILTER (WHERE status='settled'),0) AS cache_hit_tokens,
      coalesce(sum(cache_miss_tokens) FILTER (WHERE status='settled'),0) AS cache_miss_tokens,
      coalesce(sum(output_tokens) FILTER (WHERE status='settled'),0) AS output_tokens,
      count(*) FILTER (WHERE status='settled' AND priced=false)::integer AS unpriced_calls,
      coalesce((SELECT jsonb_agg(jsonb_build_object('model',model,'calls',calls,'cost',cost)
        ORDER BY cost DESC,model) FROM models),'[]'::jsonb) AS by_model,
      coalesce(array_agg(DISTINCT price_version) FILTER (WHERE price_version IS NOT NULL),ARRAY[]::text[]) AS price_versions
      FROM filtered`, [productId(userId, "user"), at]);
    const row = result.rows[0];
    return {
      since: at, totalCalls: row.total_calls, reservedCalls: row.reserved_calls, settledCalls: row.settled_calls,
      releasedCalls: row.released_calls, uncertainCalls: row.uncertain_calls,
      actualCost: Number(row.actual_cost), reservedCost: Number(row.reserved_cost), currency: "CNY",
      cacheHitTokens: Number(row.cache_hit_tokens), cacheMissTokens: Number(row.cache_miss_tokens),
      completionTokens: Number(row.output_tokens), unpricedCalls: row.unpriced_calls,
      byModel: row.by_model.map((item) => ({ model: item.model, calls: item.calls, cost: Number(item.cost) })),
      priceVersions: row.price_versions,
    };
  }

  async summaryRun(userId, runId) {
    await migrateUsageLedger(this.database);
    const result = await this.database.query(`SELECT count(*)::integer AS calls,
      count(*) FILTER (WHERE status='settled')::integer AS settled_calls,
      count(*) FILTER (WHERE status='reserved')::integer AS reserved_calls,
      count(*) FILTER (WHERE status='settled' AND (cache_hit_tokens IS NULL OR cache_miss_tokens IS NULL
        OR output_tokens IS NULL OR actual_cost IS NULL))::integer AS incomplete_usage_calls,
      coalesce(sum(actual_cost) FILTER (WHERE status='settled'),0) AS actual_cost,
      -- Lifetime by design, not the windowed budget predicate reserveModel uses:
      -- a finished run's receipt must not change as its rows age out of a
      -- rolling window. This reports open cost, never charged cost.
      coalesce(sum(reserved_cost) FILTER (WHERE status IN ('reserved','uncertain')),0) AS open_cost,
      count(*) FILTER (WHERE status='uncertain')::integer AS uncertain,
      coalesce(sum(cache_hit_tokens + cache_miss_tokens) FILTER (WHERE status='settled'),0) AS input_tokens,
      coalesce(sum(output_tokens) FILTER (WHERE status='settled'),0) AS output_tokens,
      coalesce(array_agg(DISTINCT model) FILTER (WHERE status='settled'),ARRAY[]::text[]) AS models
      FROM evimed_usage.model_requests WHERE user_id=$1 AND run_id=$2`,
    [productId(userId, "user"), productId(runId, "run")]);
    const row = result.rows[0];
    return { calls: row.calls, settledCalls: row.settled_calls, reservedCalls: row.reserved_calls,
      incompleteUsageCalls: row.incomplete_usage_calls,
      actualCost: Number(row.actual_cost), openCost: Number(row.open_cost), uncertain: row.uncertain,
      currency: "CNY", inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
      // This ledger is settled by the existing DeepSeek gateway. Report the
      // actually billed model only when the run has one unambiguous identity.
      providerId: "deepseek", modelId: row.models.length === 1 ? row.models[0] : null,
    };
  }

  /** Refuse a new interactive entry point that is already at its configured limit. */
  async assertWithinLimits(userId, { dailyLimit = 0, weeklyLimit = 0, now = new Date() } = {}) {
    const user = productId(userId, "user");
    const dayLimit = money(dailyLimit, "daily limit");
    const weekLimit = money(weeklyLimit, "weekly limit");
    if (dayLimit <= 0 && weekLimit <= 0) return { allowed: true };
    const at = instant(now, "admission time");
    await migrateUsageLedger(this.database);
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-usage:${user}`]);
      const result = await client.query(`SELECT
        coalesce(sum(CASE WHEN status='settled' AND created_at >= $2::timestamptz - interval '${openCostWindows.day}' THEN actual_cost ELSE 0 END),0) AS day_settled,
        coalesce(sum(CASE WHEN status='settled' AND created_at >= $2::timestamptz - interval '${openCostWindows.week}' THEN actual_cost ELSE 0 END),0) AS week_settled,
        coalesce(sum(CASE WHEN ${openCostPredicate(openCostWindows.day, "$2")} THEN reserved_cost ELSE 0 END),0) AS day_open,
        coalesce(sum(CASE WHEN ${openCostPredicate(openCostWindows.week, "$2")} THEN reserved_cost ELSE 0 END),0) AS week_open
        FROM evimed_usage.model_requests WHERE user_id=$1`, [user, at]);
      const day = Number(result.rows[0].day_settled) + Number(result.rows[0].day_open);
      const week = Number(result.rows[0].week_settled) + Number(result.rows[0].week_open);
      const exceeded = dayLimit > 0 && day >= dayLimit ? { window: "day", limit: dayLimit, committed: day }
        : weekLimit > 0 && week >= weekLimit ? { window: "week", limit: weekLimit, committed: week } : null;
      if (exceeded) throw new HttpError(402, "usage_budget_exceeded", "This account reached its spending limit.", { ...exceeded, currency: "CNY" });
      return { allowed: true };
    });
  }

  /** @param {any} client @param {string} userId @param {string} id */
  async #locked(client, userId, id) {
    const result = await client.query("SELECT * FROM evimed_usage.model_requests WHERE id=$1 AND user_id=$2 FOR UPDATE", [productId(id), productId(userId, "user")]);
    if (result.rowCount !== 1) throw new HttpError(404, "usage_request_not_found", "Usage request not found.");
    return result.rows[0];
  }
}
