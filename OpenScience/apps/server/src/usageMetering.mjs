import path from "node:path";
import { isPeak, priceUsage, REFERENCE_PRICE_LIST } from "@evimed/domain";
import { HttpError, appendJsonLineNoFollow, openScopedFileNoFollow } from "./security.mjs";

/**
 * What the deployment spent, per request, recorded where it happened.
 *
 * `@evimed/domain`'s `metering.mjs` has had the vocabulary and the price list
 * since it was written and no caller at all, which meant the platform could
 * price a request it never counted. This is the caller.
 *
 * Recording is append-only and never in the caller's way: a metering write
 * that can fail a model call would turn an accounting problem into an outage.
 * A write that fails is reported once, on stderr, and the request proceeds —
 * the alternative is silently dropping the record, and a ledger with invisible
 * holes is worse than one with a gap somebody noticed.
 */

/** Where the events go, one line each, rotated like the other ledgers. */
export const USAGE_EVENTS_FILE = "usage.jsonl";

/**
 * Read a usage object out of a model response, whatever shape it arrived in.
 *
 * Non-streaming responses carry `usage` as a top-level key. Streaming ones
 * carry it in a final `data:` frame, and only when the caller asked for it
 * (`stream_options.include_usage`) — a stream without that option reports no
 * usage at all, which is recorded as unpriced rather than guessed at.
 *
 * @param {string} text the response body, or its tail for a stream
 * @returns {{ promptTokens: number, completionTokens: number, cacheHitTokens: number, cacheMissTokens: number } | null}
 */
export function parseModelUsage(text) {
  if (typeof text !== "string" || !text) return null;
  // The last one wins: a stream repeats the field and only the final frame is
  // the whole turn, and in both shapes the provider puts it after the content.
  //
  // This reads the response as text rather than parsing it, which is what lets
  // it work on a tail instead of a whole body. The cost is that an answer
  // whose own text ended with a JSON object carrying numeric `prompt_tokens`
  // and `completion_tokens` would be read as the turn's usage. That requires
  // the model to emit the provider's exact field names as the last thing in
  // the response, and the harm is over-counting the person who asked for it —
  // which is the direction a billing mistake should err away from the reader,
  // not toward them. Worth revisiting if non-streaming answers ever become
  // common here; today the kernel streams every call.
  let found = null;
  for (const match of text.matchAll(/"usage"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/g)) {
    const parsed = safeJson(match[1]);
    if (parsed && typeof parsed === "object") found = parsed;
  }
  if (!found) return null;
  const promptTokens = Math.max(0, Number(found.prompt_tokens) || 0);
  const completionTokens = Math.max(0, Number(found.completion_tokens) || 0);
  // DeepSeek reports the split; when it does not, the whole prompt is charged
  // at the miss rate, which is the rate that cannot flatter the invoice.
  const cacheHitTokens = Math.max(0, Number(found.prompt_cache_hit_tokens) || 0);
  const cacheMissTokens = Number.isFinite(Number(found.prompt_cache_miss_tokens))
    ? Math.max(0, Number(found.prompt_cache_miss_tokens))
    : Math.max(0, promptTokens - cacheHitTokens);
  if (promptTokens === 0 && completionTokens === 0) return null;
  return { promptTokens, completionTokens, cacheHitTokens, cacheMissTokens };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Keeps the tail of a response body so its usage frame can be read once the
 * body has been forwarded.
 *
 * A tail rather than the whole body on purpose: a model response can be tens
 * of megabytes, the gateway streams it precisely so it never has to hold one,
 * and `usage` is the last thing in both shapes. The cap is bytes of tail, not
 * a fraction of the response, so a large answer costs the same memory as a
 * small one.
 */
export function createUsageTail(maxBytes = 16 * 1024) {
  let tail = "";
  return {
    /** @param {Uint8Array | string} chunk */
    observe(chunk) {
      tail += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (tail.length > maxBytes) tail = tail.slice(tail.length - maxBytes);
    },
    usage() {
      return parseModelUsage(tail);
    },
  };
}

/**
 * Record one metered model call.
 *
 * @param {object} input
 * @param {object} input.config
 * @param {string} input.userId
 * @param {string} input.projectId
 * @param {string} input.model the model the gateway actually called
 * @param {{ promptTokens: number, completionTokens: number, cacheHitTokens: number, cacheMissTokens: number } | null} input.usage
 * @param {Date} [input.at]
 * @returns {Promise<import("@evimed/domain").UsageEvent | null>} the recorded event, or null when there was nothing to record
 */
export async function recordModelUsage({ config, userId, projectId, model, usage, at = new Date() }) {
  if (!usage) return null;
  const peak = isPeak(at);
  const priced = priceUsage(
    {
      resourceType: "model",
      model,
      cacheHit: usage.cacheHitTokens,
      cacheMiss: usage.cacheMissTokens,
      output: usage.completionTokens,
      peak,
    },
    REFERENCE_PRICE_LIST,
  );
  /** @type {import("@evimed/domain").UsageEvent} */
  const record = {
    at: at.toISOString(),
    resourceType: "model",
    userId,
    projectId,
    model,
    peak,
    cacheHit: usage.cacheHitTokens,
    cacheMiss: usage.cacheMissTokens,
    output: usage.completionTokens,
    cost: priced.cost,
    currency: priced.currency,
    // False when the price list does not know this model. The event is kept
    // either way: an uncounted call is invisible, and an unpriced one is a
    // question about the price list, which is the answerable kind.
    priced: priced.priced,
  };
  const file = path.join(config.dataDir, ".openscience", USAGE_EVENTS_FILE);
  await appendJsonLineNoFollow(config.dataDir, file, record, { maxBytes: config.maxLogFileBytes }).catch((error) => {
    process.stderr.write(`usage metering write failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  return record;
}

/**
 * Totals for one account, from a set of recorded events.
 *
 * Kept as a pure function over rows so the caller decides how far back to
 * read: the account page wants this month, an operator wants everything, and
 * neither should mean a different aggregation.
 *
 * @param {readonly any[]} rows
 * @param {{ userId?: string, projectId?: string, since?: Date }} [filter]
 */
export function summarizeUsage(rows, filter = {}) {
  const sinceMs = filter.since ? filter.since.getTime() : null;
  let cost = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let calls = 0;
  let unpriced = 0;
  const byModel = new Map();
  for (const row of rows) {
    if (!row || row.resourceType !== "model") continue;
    if (filter.userId && row.userId !== filter.userId) continue;
    if (filter.projectId && row.projectId !== filter.projectId) continue;
    if (sinceMs != null && Date.parse(row.at) < sinceMs) continue;
    calls += 1;
    cost += Number(row.cost) || 0;
    promptTokens += (Number(row.cacheHit) || 0) + (Number(row.cacheMiss) || 0);
    completionTokens += Number(row.output) || 0;
    if (row.priced === false) unpriced += 1;
    const model = String(row.model ?? "unknown");
    const entry = byModel.get(model) ?? { model, calls: 0, cost: 0 };
    entry.calls += 1;
    entry.cost = Math.round((entry.cost + (Number(row.cost) || 0)) * 10_000) / 10_000;
    byModel.set(model, entry);
  }
  return {
    calls,
    cost: Math.round(cost * 10_000) / 10_000,
    currency: REFERENCE_PRICE_LIST.currency,
    promptTokens,
    completionTokens,
    // How many calls carried a model the price list does not know. Reported
    // rather than folded into the total, because a zero that means "free" and
    // a zero that means "we do not know" are different answers.
    unpricedCalls: unpriced,
    byModel: [...byModel.values()].sort((left, right) => right.cost - left.cost),
  };
}

/**
 * Whether this account may start another run, and why not when it may not.
 *
 * Checked at dispatch and nowhere else. A cap enforced mid-run would abandon
 * a run that had already spent most of what it was going to spend and deliver
 * nothing for it — the one outcome worse than going slightly over.
 *
 * Both windows are rolling rather than calendar. A calendar day resets at
 * midnight UTC, which for a researcher in Beijing is the middle of the working
 * afternoon; a rolling window spends the same budget without a cliff nobody
 * can see coming.
 *
 * @param {readonly any[]} rows recorded usage events
 * @param {{ userId: string, dailyLimit?: number, weeklyLimit?: number, now?: Date }} input
 * @returns {{ allowed: true } | { allowed: false, window: "day" | "week", limit: number, spent: number, currency: string, resetsAt: string }}
 */
export function spendAdmission(rows, { userId, dailyLimit = 0, weeklyLimit = 0, now = new Date() }) {
  const windows = [
    { name: /** @type {const} */ ("day"), limit: Number(dailyLimit) || 0, ms: 24 * 60 * 60 * 1000 },
    { name: /** @type {const} */ ("week"), limit: Number(weeklyLimit) || 0, ms: 7 * 24 * 60 * 60 * 1000 },
  ];
  for (const window of windows) {
    if (window.limit <= 0) continue;
    const since = new Date(now.getTime() - window.ms);
    const spent = summarizeUsage(rows, { userId, since }).cost;
    if (spent >= window.limit) {
      // When the oldest charge in the window ages out, which is the moment
      // this stops refusing. "Try again later" without a time is a dead end.
      const inWindow = rows
        .filter((row) => row?.userId === userId && Date.parse(row.at) >= since.getTime())
        .map((row) => Date.parse(row.at))
        .sort((left, right) => left - right);
      const resetsAt = new Date((inWindow[0] ?? now.getTime()) + window.ms).toISOString();
      return {
        allowed: false,
        window: window.name,
        limit: window.limit,
        spent,
        currency: REFERENCE_PRICE_LIST.currency,
        resetsAt,
      };
    }
  }
  return { allowed: true };
}

/**
 * Every usage line the retained log still holds.
 *
 * Bounded by bytes rather than rows. The row-capped reader the audit ledgers
 * use is right for "show me recent lines" and wrong for a total: the file
 * holds every account's events, so a hundred rows is a hundred calls across
 * the whole deployment and one account's month would come back understated by
 * however much traffic the others made.
 *
 * Missing older rows can only ever undercount, which for a spend cap errs
 * toward letting work happen — the right direction for a limit whose failure
 * mode is refusing a researcher mid-afternoon.
 */
export async function readUsageEvents(config) {
  const file = path.join(config.dataDir, ".openscience", USAGE_EVENTS_FILE);
  const maxBytes = Math.max(1024 * 1024, Number(config.maxLogReadBytes) || 0) * 4;
  const current = await readTail(config.dataDir, file, maxBytes);
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(current));
  const rotated = remaining > 0 ? await readTail(config.dataDir, `${file}.1`, remaining) : "";
  const joined = rotated && current && !rotated.endsWith("\n") ? `${rotated}\n${current}` : `${rotated}${current}`;
  const rows = [];
  for (const line of joined.split("\n")) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Reading a tail can cut the first line in half. Skipping it can only
      // undercount, which is the safe direction here.
    }
  }
  return rows;
}

async function readTail(rootDir, file, maxBytes) {
  const opened = await openScopedFileNoFollow(rootDir, file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!opened) return "";
  const { handle, stat } = opened;
  try {
    if (!stat.isFile()) return "";
    if (stat.size <= maxBytes) return await handle.readFile("utf8");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, stat.size - maxBytes);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Refuse an account that is over its cap, before whatever it asked for starts.
 *
 * Called at the two moments something begins: dispatching a run, and starting
 * a project's runtime. The second is not redundant — a run begun inside the
 * kernel's own browser application never passes through dispatch, and the
 * frame is the primary surface, so a cap that only guarded dispatch would be
 * one the product's main path walks around.
 *
 * Never mid-flight. A cap enforced against a running turn abandons work that
 * has already been paid for and delivers nothing for it.
 *
 * @param {object} config @param {string} userId
 */
export async function assertSpendWithinLimits(config, userId) {
  const dailyLimit = Number(config.userDailySpendLimit) || 0;
  const weeklyLimit = Number(config.userWeeklySpendLimit) || 0;
  if (dailyLimit <= 0 && weeklyLimit <= 0) return;
  const verdict = spendAdmission(await readUsageEvents(config), { userId, dailyLimit, weeklyLimit });
  if (verdict.allowed !== false) return;
  const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(verdict.resetsAt) - Date.now()) / 1000));
  // Which window, not just "no credits". The registry distinguishes them and
  // they lead to different actions: a daily cap frees up on its own, a weekly
  // one is a conversation with whoever set it. `credits_exhausted` stays
  // reserved for a balance, which this deployment does not have — its message
  // offers a top-up, and offering one that does not exist is worse than
  // saying nothing.
  throw new HttpError(
    402,
    verdict.window === "day" ? "credits_daily_limit_reached" : "credits_weekly_limit_reached",
    `This account reached its ${verdict.window === "day" ? "daily" : "weekly"} spending limit: ` +
      `${verdict.spent} of ${verdict.limit} ${verdict.currency} used; it frees up at ${verdict.resetsAt}.`,
    { retryAfterSeconds },
  );
}
