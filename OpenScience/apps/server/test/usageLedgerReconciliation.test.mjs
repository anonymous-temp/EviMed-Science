import assert from "node:assert/strict";
import test from "node:test";
import { UsageLedger, openCostPredicate, openCostWindows } from "../src/usageLedger.mjs";

// These tests run without PostgreSQL. They drive the real UsageLedger against a
// database double that records every statement, so what is asserted is the SQL
// the ledger actually issues, the parameters it binds, and the arithmetic it
// does on the rows it gets back — not that "a query happened". The PostgreSQL
// behaviour itself is covered by usageLedger.integration.test.mjs, which only
// runs with a live database.

const reservedRow = {
  id: "req-1", user_id: "owner", project_id: "default", run_id: null,
  model: "deepseek-v4-flash", price_version: "evimed-reference-2026-09-05", currency: "CNY",
  request_fingerprint: "a".repeat(64), status: "reserved", revision: 1,
  reserved_cost: "0.75000000", actual_cost: null, priced: null,
  cache_hit_tokens: null, cache_miss_tokens: null, output_tokens: null,
  provider_request_id: null, error_code: null,
  reservation_expires_at: "2026-09-06T00:30:00.000Z",
  created_at: "2026-09-06T00:00:00.000Z", settled_at: null,
};

/** A database double: one client, every statement recorded in order.
 *  @param {(text:string,params:any[])=>({rows:any[],rowCount:number}|undefined)} responder */
function fakeDatabase(responder = () => undefined) {
  /** @type {{text:string,params:any[],inTransaction:boolean}[]} */
  const calls = [];
  let depth = 0;
  const run = async (text, params) => {
    calls.push({ text, params, inTransaction: depth > 0 });
    return responder(text, params) ?? { rows: [], rowCount: 0 };
  };
  return {
    calls,
    query: (text, params = []) => run(text, params),
    async transaction(fn) {
      depth += 1;
      try { return await fn({ query: (text, params = []) => run(text, params) }); }
      finally { depth -= 1; }
    },
  };
}

// Every budget field is distinguishable and non-zero, so a ceiling computed from
// the wrong half of a pair produces a different number rather than the same
// zero. day = 1 + 2 = 3, week = 4 + 8 = 12, run = 16.
const budgetTotals = { day_settled: "1", week_settled: "4", day_open: "2", week_open: "8", run_committed: "16" };

function budgetResponder(text) {
  if (text.includes("day_settled")) return { rows: [{ ...budgetTotals }], rowCount: 1 };
  if (text.startsWith("INSERT INTO evimed_usage.model_requests")) return { rows: [reservedRow], rowCount: 1 };
  return undefined;
}

function reservation(values = {}) {
  return {
    id: "req-1", userId: "owner", projectId: "default", model: "deepseek-v4-flash",
    priceVersion: "evimed-reference-2026-09-05", currency: "CNY",
    requestFingerprint: "a".repeat(64), estimatedCost: 0.75,
    dailyLimit: 10, weeklyLimit: 40, now: new Date("2026-09-06T00:00:00.000Z"),
    ...values,
  };
}

/** A reservation of exactly 0.5 against the fixture totals above. */
function priced(values = {}) {
  return reservation({ estimatedCost: 0.5, dailyLimit: 0, weeklyLimit: 0, ...values });
}

function ledgerWithBudget() {
  return new UsageLedger(fakeDatabase(budgetResponder));
}

test("reserveModel and assertWithinLimits charge open cost through one shared predicate", async () => {
  const database = fakeDatabase(budgetResponder);
  const ledger = new UsageLedger(database);
  await ledger.reserveModel(reservation());
  await ledger.assertWithinLimits("owner", { dailyLimit: 10, weeklyLimit: 40, now: new Date("2026-09-06T00:00:00.000Z") });
  const budget = database.calls.filter((call) => call.text.includes("day_settled"));
  assert.equal(budget.length, 2, "both entry points must ask the same budget question");
  for (const call of budget) {
    assert.ok(call.text.includes(openCostPredicate(openCostWindows.day, "$2")), "the 24h open-cost predicate is not the shared one");
    assert.ok(call.text.includes(openCostPredicate(openCostWindows.week, "$2")), "the 7d open-cost predicate is not the shared one");
    assert.equal(call.params[1], "2026-09-06T00:00:00.000Z", "both bind the decision instant as $2");
  }
});

test("an uncertain row is charged only inside the rolling window, never forever", async () => {
  const database = fakeDatabase(budgetResponder);
  const ledger = new UsageLedger(database);
  await ledger.reserveModel(reservation({ runId: "run-1", runLimit: 0, dailyLimit: 0, weeklyLimit: 0 }));
  await ledger.assertWithinLimits("owner", { dailyLimit: 10, now: new Date("2026-09-06T00:00:00.000Z") });
  const budget = database.calls.filter((call) => call.text.includes("day_settled"));
  assert.equal(budget.length, 2);
  let mentions = 0;
  for (const call of budget) {
    const parts = call.text.split("status='uncertain'");
    assert.ok(parts.length > 1, "the budget query must still account for uncertain rows");
    for (const part of parts.slice(1)) {
      mentions += 1;
      assert.match(part, /^ AND created_at >= \$2::timestamptz - interval '(24 hours|7 days)'\)/,
        "an uncertain row must be windowed by created_at, not counted unconditionally");
    }
  }
  assert.ok(mentions >= 3, "the day, week and run-scoped terms must each be windowed");
  const reserve = budget[0].text;
  assert.ok(reserve.includes(`run_id=$3 AND ${openCostPredicate(openCostWindows.week, "$2")}`),
    "the run-scoped term must reuse the shared predicate");
});

test("the two rolling windows are a frozen, closed set", () => {
  assert.deepEqual(openCostWindows, { day: "24 hours", week: "7 days" });
  assert.throws(() => { openCostWindows.day = "1 hour"; }, TypeError);
  assert.throws(() => { openCostWindows.month = "30 days"; }, TypeError);
  assert.deepEqual(openCostWindows, { day: "24 hours", week: "7 days" });
});

test("openCostPredicate refuses anything it would splice into SQL unchecked", () => {
  assert.throws(() => openCostPredicate("1 hour", "$2"), { code: "usage_window_invalid" });
  assert.throws(() => openCostPredicate("24 hours' OR true --", "$2"), { code: "usage_window_invalid" });
  assert.throws(() => openCostPredicate(undefined, "$2"), { code: "usage_window_invalid" });
  assert.throws(() => openCostPredicate(openCostWindows.day, "now()"), { code: "usage_window_invalid" });
  assert.throws(() => openCostPredicate(openCostWindows.day, "$2::text||''"), { code: "usage_window_invalid" });
  assert.throws(() => openCostPredicate(openCostWindows.day, undefined), { code: "usage_window_invalid" });
  assert.equal(
    openCostPredicate(openCostWindows.day, "$4"),
    "((status='reserved' AND reservation_expires_at > $4::timestamptz)"
      + " OR (status='uncertain' AND created_at >= $4::timestamptz - interval '24 hours'))",
    "the placeholder the caller names is the one the predicate reads",
  );
});

test("the day ceiling is settled+open of the day pair alone", async () => {
  // day = day_settled 1 + day_open 2 = 3, so 0.5 more fits under 3.6 and not under 3.4.
  await assert.rejects(ledgerWithBudget().reserveModel(priced({ dailyLimit: 3.4 })),
    { code: "usage_budget_exceeded", status: 402 });
  assert.equal((await ledgerWithBudget().reserveModel(priced({ dailyLimit: 3.6 }))).status, "reserved",
    "a day ceiling computed from the week pair would refuse this");
});

test("the week ceiling is settled+open of the week pair alone", async () => {
  // week = week_settled 4 + week_open 8 = 12, so 0.5 more fits under 12.6 and not under 12.4.
  await assert.rejects(ledgerWithBudget().reserveModel(priced({ weeklyLimit: 12.4 })),
    { code: "usage_budget_exceeded", status: 402 });
  assert.equal((await ledgerWithBudget().reserveModel(priced({ weeklyLimit: 12.6 }))).status, "reserved",
    "a week ceiling computed from the day pair would accept 12.4");
});

test("the run ceiling is the run-scoped total alone", async () => {
  await assert.rejects(ledgerWithBudget().reserveModel(priced({ runId: "run-1", runLimit: 16.4 })),
    { code: "usage_budget_exceeded", status: 402 });
  assert.equal((await ledgerWithBudget().reserveModel(priced({ runId: "run-1", runLimit: 16.6 }))).status, "reserved");
});

test("admission measures each window against its own settled+open pair", async () => {
  const at = new Date("2026-09-06T00:00:00.000Z");
  const admit = (limits) => ledgerWithBudget().assertWithinLimits("owner", { ...limits, now: at });
  await assert.rejects(admit({ dailyLimit: 3 }), { code: "usage_budget_exceeded" });
  assert.deepEqual(await admit({ dailyLimit: 3.01 }), { allowed: true },
    "a day total taken from the week pair would be 12 and refuse this");
  await assert.rejects(admit({ weeklyLimit: 12 }), { code: "usage_budget_exceeded" });
  assert.deepEqual(await admit({ weeklyLimit: 12.01 }), { allowed: true });
  assert.deepEqual(await admit({ dailyLimit: 3.01, weeklyLimit: 12.01 }), { allowed: true });
});

test("expired reservations become uncertain under the account's own advisory lock", async () => {
  const now = new Date("2026-09-06T01:00:00.000Z");
  const database = fakeDatabase((text) => {
    if (text.startsWith("SELECT user_id,id FROM evimed_usage.model_requests")) {
      return { rows: [{ user_id: "owner", id: "req-1" }, { user_id: "owner", id: "req-2" }, { user_id: "other", id: "req-3" }], rowCount: 3 };
    }
    if (text.startsWith("UPDATE evimed_usage.model_requests")) {
      return { rows: [{ id: "req-1" }], rowCount: 1 };
    }
    if (text.includes("AS remaining")) return { rows: [{ remaining: 4 }], rowCount: 1 };
    return undefined;
  });
  const ledger = new UsageLedger(database);
  const result = await ledger.reconcileExpiredReservations({ now, limit: 50 });
  assert.deepEqual(result, { reconciled: 2, remaining: 4, failedAccounts: 0 });

  const candidates = database.calls.find((call) => call.text.startsWith("SELECT user_id,id FROM evimed_usage.model_requests"));
  assert.match(candidates.text, /status='reserved' AND reservation_expires_at <= coalesce\(\$1::timestamptz,clock_timestamp\(\)\)/);
  assert.match(candidates.text, /LIMIT \$2/);
  assert.deepEqual(candidates.params, ["2026-09-06T01:00:00.000Z", 50]);

  const locks = database.calls.filter((call) => call.text.includes("pg_advisory_xact_lock(hashtext($1))"));
  assert.deepEqual(locks.map((call) => call.params[0]), ["evimed-usage:owner", "evimed-usage:other"],
    "each account is swept under the same lock its settlements take");
  const timeouts = database.calls.filter((call) => call.text.startsWith("SET LOCAL lock_timeout"));
  assert.equal(timeouts.length, 2, "each account's transaction bounds how long it waits for that lock");
  for (const timeout of timeouts) assert.equal(timeout.inTransaction, true);
  const updates = database.calls.filter((call) => call.text.startsWith("UPDATE evimed_usage.model_requests"));
  assert.equal(updates.length, 2, "one bounded update per account, inside a transaction");
  for (const update of updates) assert.equal(update.inTransaction, true);
  assert.match(updates[0].text, /SET status='uncertain'/);
  assert.match(updates[0].text, /revision=revision\+1/);
  assert.match(updates[0].text, /error_code='reservation_expired'/);
  assert.match(updates[0].text, /settled_at=clock_timestamp\(\)/);
  assert.match(updates[0].text, /status='reserved'\n\s+AND reservation_expires_at <= coalesce\(\$3::timestamptz,clock_timestamp\(\)\)/);
  assert.ok(!/status='released'/.test(updates[0].text), "an expired reservation is never released — the provider may already have charged");
  assert.deepEqual(updates[0].params, ["owner", ["req-1", "req-2"], "2026-09-06T01:00:00.000Z"]);
  assert.deepEqual(updates[1].params, ["other", ["req-3"], "2026-09-06T01:00:00.000Z"]);
});

test("the sweep and health() decide expiry on one clock: the database's", async () => {
  const database = fakeDatabase((text) => {
    if (text.startsWith("SELECT user_id,id FROM")) return { rows: [{ user_id: "owner", id: "req-1" }], rowCount: 1 };
    if (text.startsWith("UPDATE evimed_usage.model_requests")) return { rows: [{ id: "req-1" }], rowCount: 1 };
    if (text.includes("AS remaining")) return { rows: [{ remaining: 0 }], rowCount: 1 };
    if (text.includes("expired_reservations")) return { rows: [{ uncertain: 0, expired_reservations: 0 }], rowCount: 1 };
    return undefined;
  });
  const ledger = new UsageLedger(database);
  await ledger.reconcileExpiredReservations({ limit: 10 });
  await ledger.health();
  const sweepStatements = database.calls.filter((call) => /reservation_expires_at <= /.test(call.text));
  assert.equal(sweepStatements.length, 4, "candidate select, update guard, remainder count and the health probe");
  for (const call of sweepStatements) {
    assert.match(call.text, /reservation_expires_at <= (coalesce\(\$\d::timestamptz,)?clock_timestamp\(\)/,
      "expiry is decided by the database clock, never by the Node process instant");
  }
  for (const call of sweepStatements.slice(0, 3)) {
    assert.equal(call.params[0] === null || call.params[2] === null, true,
      "with no test override the instant parameter is null, so clock_timestamp() decides");
  }
});

test("one failing account is skipped and the rest of the batch still runs", async () => {
  const database = fakeDatabase((text, params) => {
    if (text.startsWith("SELECT user_id,id FROM evimed_usage.model_requests")) {
      return { rows: [{ user_id: "stuck", id: "req-1" }, { user_id: "other", id: "req-2" }], rowCount: 2 };
    }
    if (text.startsWith("UPDATE evimed_usage.model_requests")) {
      if (params[0] === "stuck") throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      return { rows: [{ id: "req-2" }], rowCount: 1 };
    }
    if (text.includes("AS remaining")) return { rows: [{ remaining: 1 }], rowCount: 1 };
    return undefined;
  });
  const ledger = new UsageLedger(database);
  assert.deepEqual(await ledger.reconcileExpiredReservations({ limit: 10 }),
    { reconciled: 1, remaining: 1, failedAccounts: 1 });
  const updates = database.calls.filter((call) => call.text.startsWith("UPDATE evimed_usage.model_requests"));
  assert.deepEqual(updates.map((call) => call.params[0]), ["stuck", "other"],
    "the account behind the failing one must still be swept, not blocked by it forever");
  assert.ok(database.calls.some((call) => call.text.includes("AS remaining")),
    "the batch still reports what it left behind");
});

test("a sweep with nothing to reconcile writes nothing and stays idempotent", async () => {
  const database = fakeDatabase((text) => (text.includes("AS remaining") ? { rows: [{ remaining: 0 }], rowCount: 1 } : undefined));
  const ledger = new UsageLedger(database);
  const empty = { reconciled: 0, remaining: 0, failedAccounts: 0 };
  assert.deepEqual(await ledger.reconcileExpiredReservations({ now: new Date("2026-09-06T01:00:00.000Z") }), empty);
  assert.deepEqual(await ledger.reconcileExpiredReservations({ now: new Date("2026-09-06T01:00:00.000Z") }), empty,
    "a second sweep over the same empty candidate set repeats the same answer");
  assert.equal(database.calls.filter((call) => call.text.startsWith("UPDATE ")).length, 0);
  assert.equal(database.calls.filter((call) => call.text.includes("pg_advisory_xact_lock(hashtext($1))")).length, 0);
});

test("the sweep batch is bounded and the instant is validated", async () => {
  const ledger = new UsageLedger(fakeDatabase());
  await assert.rejects(ledger.reconcileExpiredReservations({ limit: 0 }), { code: "product_parameter_invalid" });
  await assert.rejects(ledger.reconcileExpiredReservations({ limit: 5_000 }), { code: "product_parameter_invalid" });
  await assert.rejects(ledger.reconcileExpiredReservations({ now: "2026-09-06" }), { code: "usage_payload_invalid" });
});

test("health reports stuck reservations without reading the whole ledger", async () => {
  const database = fakeDatabase((text) => (text.includes("expired_reservations")
    ? { rows: [{ uncertain: 3, expired_reservations: 2 }], rowCount: 1 } : undefined));
  const ledger = new UsageLedger(database);
  assert.deepEqual(await ledger.health(), { connected: true, uncertain: 3, expiredReservations: 2 });
  const health = database.calls.find((call) => call.text.includes("expired_reservations"));
  assert.match(health.text, /status='reserved' AND reservation_expires_at <= clock_timestamp\(\)/);
  assert.match(health.text, /FROM evimed_usage\.model_requests WHERE status IN \('reserved','uncertain'\)/,
    "readiness runs every 30s: it must not scan settled and released rows that contribute 0 to both counts");
});

/** A row the sweep already moved out of `reserved`. */
const sweptRow = { ...reservedRow, status: "uncertain", error_code: "reservation_expired", revision: 2, settled_at: "2026-09-06T01:00:00.000Z" };

function terminalDatabase(current) {
  return fakeDatabase((text, params) => {
    if (text.startsWith("SELECT * FROM evimed_usage.model_requests WHERE id=$1 AND user_id=$2")) {
      return { rows: [current], rowCount: 1 };
    }
    if (text.startsWith("UPDATE evimed_usage.model_requests SET status=$2")) {
      return { rows: [{ ...current, status: params[1], error_code: params[2], provider_request_id: params[3] }], rowCount: 1 };
    }
    return undefined;
  });
}

test("a late terminal call replaces the sweep's placeholder cause and keeps its money state", async () => {
  const database = terminalDatabase(sweptRow);
  const ledger = new UsageLedger(database);
  const marked = await ledger.markUncertain("owner", "req-1", "response_usage_missing", { providerRequestId: "provider-late" });
  assert.equal(marked.status, "uncertain");
  assert.equal(marked.errorCode, "response_usage_missing", "the real cause must not be lost behind the placeholder");
  const update = database.calls.find((call) => call.text.startsWith("UPDATE evimed_usage.model_requests SET status=$2"));
  assert.deepEqual(update.params, ["req-1", "uncertain", "response_usage_missing", "provider-late"]);

  const releasing = terminalDatabase(sweptRow);
  const released = await new UsageLedger(releasing).release("owner", "req-1", "provider_refused");
  assert.equal(released.status, "uncertain",
    "the sweep already reported this money as possibly charged — only the diagnosis is replaced");
  assert.equal(released.errorCode, "provider_refused");
});

test("only the sweep's own placeholder is overwritable", async () => {
  const ledger = (row) => new UsageLedger(terminalDatabase(row));
  await assert.rejects(ledger({ ...sweptRow, error_code: "response_usage_missing" }).release("owner", "req-1", "provider_refused"),
    { code: "usage_settlement_conflict" });
  await assert.rejects(ledger({ ...sweptRow, status: "released", error_code: "reservation_expired" }).markUncertain("owner", "req-1", "late"),
    { code: "usage_settlement_conflict" });
  await assert.rejects(ledger({ ...reservedRow, status: "settled", error_code: null }).release("owner", "req-1", "too_late"),
    { code: "usage_settlement_conflict" });
  const idempotent = terminalDatabase({ ...sweptRow, error_code: "response_usage_missing", provider_request_id: "provider-late" });
  const repeated = await new UsageLedger(idempotent).markUncertain("owner", "req-1", "response_usage_missing", { providerRequestId: "provider-late" });
  assert.equal(repeated.revision, 2, "an unchanged repeat still writes nothing");
  assert.equal(idempotent.calls.filter((call) => call.text.startsWith("UPDATE ")).length, 0);
});

test("a run receipt reports lifetime open cost, not the windowed budget term", async () => {
  const database = fakeDatabase((text) => (text.includes("AS open_cost")
    ? { rows: [{ calls: 1, settled_calls: 1, reserved_calls: 0, incomplete_usage_calls: 0, actual_cost: "0.5",
      open_cost: "0.25", uncertain: 1, input_tokens: "5", output_tokens: "5", models: ["deepseek-v4-flash"] }], rowCount: 1 }
    : undefined));
  const summary = await new UsageLedger(database).summaryRun("owner", "run-1");
  assert.equal(summary.openCost, 0.25);
  const query = database.calls.find((call) => call.text.includes("AS open_cost"));
  assert.match(query.text, /sum\(reserved_cost\) FILTER \(WHERE status IN \('reserved','uncertain'\)\),0\) AS open_cost/);
  assert.ok(!query.text.includes("interval '"),
    "a finished run's receipt must not change as its rows age out of a rolling window");
  assert.ok(!query.text.includes("reservation_expires_at"),
    "the receipt reports open cost, not the cost a new call would be charged");
});
