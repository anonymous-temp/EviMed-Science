// A native run's cost is the ledger's sum for its session.
//
// 2026-10-04, live: for a run started from the kernel's own window (a native
// turn, not POST /api/agent-runs/dispatch) the run's cost was lower than the
// usage ledger's sum for the same session and window. The gateway attributes a
// call to a run when it arrives, and a native turn has no run until the control
// plane adopts it, nor does a subagent's session until the progress tracker hears
// of it — so the first calls of each were booked with no run. Each such call now
// keeps its kernel session, and the run is named for it once it is known.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { LATE_ATTRIBUTION_LEAD_MS, createLateUsageAttribution } from "../src/lateUsageAttribution.mjs";
import { createModelGatewayHandler } from "../src/modelGateway.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";

// ——— The gateway books the session of a call that has no run ———

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

const config = (baseUrl) => ({
  deepseekApiKey: "test-provider-key", deepseekBaseUrl: baseUrl, deepseekModel: "deepseek-v4-flash",
  modelGatewayMaxBodyBytes: 64 * 1024, modelGatewayMaxResponseBytes: 1024 * 1024, modelGatewayTimeoutMs: 2_000,
  modelGatewayReservationMaxOutputTokens: 4096, userDailySpendLimit: 2, userWeeklySpendLimit: 5,
  modelGatewaySigningSecret: "test-only-model-gateway-signing-secret-32-bytes",
});

/** One runtime call through the gateway with the kernel's session header; returns what the ledger was asked to reserve. */
async function reservedFor(t, { attributeRun, session = "session-native-1" }) {
  const reserved = [];
  const usageLedger = {
    async reserveModel(input) { reserved.push(input); return { id: input.id }; },
    async settleModel() {}, async markUncertain() {}, async release() {},
  };
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 5, completion_tokens: 2 } }));
  });
  const upstreamBase = await listen(upstream);
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const manager = { assertActiveModelGatewayToken: () => ({ userId: "u1", projectId: "default" }) };
  const gateway = createServer(createModelGatewayHandler(config(upstreamBase), manager, { usageLedger, attributeRun }));
  const gatewayBase = await listen(gateway);
  t.after(() => new Promise((resolve) => { gateway.closeAllConnections(); gateway.close(resolve); }));
  const response = await fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime", "content-type": "application/json", ...(session ? { "x-deepseek-harness-session-id": session } : {}) },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 200);
  await response.text();
  return reserved;
}

test("a runtime call that has no run yet keeps the session it came from", async (t) => {
  const [reservation] = await reservedFor(t, { attributeRun: async () => null });
  assert.equal(reservation.runId, null);
  assert.equal(reservation.sessionId, "session-native-1");
});

test("a call whose run is known keeps no session: there is nothing left to name", async (t) => {
  const [reservation] = await reservedFor(t, { attributeRun: async () => "run_known" });
  assert.equal(reservation.runId, "run_known");
  assert.equal(reservation.sessionId, null);
});

test("a call that carries no session books none", async (t) => {
  const [reservation] = await reservedFor(t, { attributeRun: async () => null, session: null });
  assert.equal(reservation.runId, null);
  assert.equal(reservation.sessionId, null, "an auxiliary call with no session stays unattributed, and is counted as such");
});

// ——— The ledger stores it and fills the run, and nothing else ———

/** A database that records every statement and answers the few the ledger reads. */
function recordingDatabase({ updated = 0 } = {}) {
  /** @type {{ sql: string, params: any[] }[]} */
  const statements = [];
  return {
    statements,
    async query(sql, params) { statements.push({ sql, params }); return { rows: [], rowCount: 0 }; },
    async transaction(work) {
      return work({
        async query(sql, params = []) {
          statements.push({ sql: String(sql), params });
          if (/^\s*UPDATE evimed_usage\.model_requests/.test(String(sql))) return { rows: [], rowCount: updated };
          if (/FROM evimed_usage\.model_requests WHERE id=/.test(String(sql))) return { rows: [], rowCount: 0 };
          if (/day_settled/.test(String(sql))) return { rows: [{ day_settled: 0, week_settled: 0, day_open: 0, week_open: 0, run_committed: 0 }], rowCount: 1 };
          if (/^\s*INSERT INTO evimed_usage\.model_requests/.test(String(sql))) {
            return { rows: [{ id: params[0], user_id: params[1], project_id: params[2], run_id: params[3], model: params[4], price_version: params[5], currency: params[6],
              request_fingerprint: params[7], status: "reserved", reserved_cost: params[8], reservation_expires_at: params[9], created_at: params[10], purpose: params[11] }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      });
    },
  };
}

const reservation = (over = {}) => ({
  id: "req-1", userId: "u1", projectId: "default", model: "deepseek-v4-flash", priceVersion: "v1", currency: "CNY",
  requestFingerprint: "a".repeat(64), estimatedCost: 0.01, purpose: "kernel", ...over,
});

test("a reservation with no run stores its session, and one with a run stores none", async () => {
  for (const [input, expected] of [[{ runId: null, sessionId: "session-1" }, "session-1"], [{ runId: "run_1", sessionId: "session-1" }, null], [{ runId: null }, null]]) {
    const database = recordingDatabase();
    await new UsageLedger(database).reserveModel(reservation(input));
    const insert = database.statements.find((statement) => /^\s*INSERT INTO evimed_usage\.model_requests/.test(statement.sql));
    assert.match(insert.sql, /session_id,evolution_mission_id,evolution_module\)/);
    assert.equal(insert.params[12], expected, JSON.stringify(input));
  }
});

test("attributing a session fills the run on exactly the unattributed calls of that session since the run began", async () => {
  const database = recordingDatabase({ updated: 3 });
  const ledger = new UsageLedger(database);
  const since = new Date("2026-10-04T09:00:00.000Z");
  assert.equal(await ledger.attributeSession({ userId: "u1", projectId: "default", sessionId: "session-1", runId: "run_native", since }), 3);
  const update = database.statements.find((statement) => /^\s*UPDATE evimed_usage\.model_requests/.test(statement.sql));
  // Only the run column is written: never an amount, never a status.
  assert.match(update.sql, /SET run_id=\$4\s+WHERE/);
  assert.match(update.sql, /user_id=\$1 AND project_id=\$2 AND session_id=\$3 AND run_id IS NULL/);
  assert.match(update.sql, /purpose='kernel'/);
  assert.match(update.sql, /created_at >= \$5::timestamptz/);
  assert.doesNotMatch(update.sql, /actual_cost|reserved_cost|status\s*=/);
  assert.deepEqual(update.params, ["u1", "default", "session-1", "run_native", since.toISOString()]);
  // Serialized with reservations by the account's lock, taken first.
  const lock = database.statements.findIndex((statement) => /pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(statement.sql) && statement.params[0] === "evimed-usage:u1");
  assert.ok(lock >= 0 && lock < database.statements.indexOf(update));
  assert.deepEqual(ledger.lateAttribution, { sweeps: 1, calls: 3 });
});

test("a malformed identity is refused before anything is written", async () => {
  const database = recordingDatabase();
  const ledger = new UsageLedger(database);
  const base = { userId: "u1", projectId: "default", sessionId: "s", runId: "run_1", since: new Date() };
  for (const bad of [{ sessionId: "" }, { sessionId: "line\nbreak" }, { runId: "" }, { since: "yesterday" }, { userId: "" }]) {
    await assert.rejects(ledger.attributeSession({ ...base, ...bad }), { code: /usage_payload_invalid|product_identifier_invalid/ }, JSON.stringify(bad));
  }
  assert.equal(database.statements.some((statement) => /UPDATE evimed_usage/.test(statement.sql)), false);
});

// ——— The sweep ———

test("the sweep names the run for the conversation's session and each subagent's, since a moment before the run began", async () => {
  const asked = [];
  const attribute = createLateUsageAttribution({
    usageLedger: { attributeSession: async (input) => { asked.push(input); return 2; } },
    agentRuns: { childSessionsOf: async () => [{ sessionId: "child-a" }, { sessionId: "child-b" }, { sessionId: "child-a" }] },
  });
  const project = { userId: "u1", id: "default" };
  const run = { id: "run_native", sessionId: "session-1", startedAt: "2026-10-04T09:00:10.000Z" };
  assert.equal(await attribute(project, run), 6, "three sessions, two calls each");
  assert.deepEqual(asked.map((input) => input.sessionId), ["session-1", "child-a", "child-b"], "each session once");
  for (const input of asked) {
    assert.equal(input.runId, "run_native");
    assert.equal(input.userId, "u1");
    assert.equal(input.projectId, "default");
    assert.equal(input.since.toISOString(), new Date(Date.parse(run.startedAt) - LATE_ATTRIBUTION_LEAD_MS).toISOString());
  }
});

test("the sweep never fails the run: an unreadable child list, a ledger error or a run without a start name nothing and throw nothing", async () => {
  const project = { userId: "u1", id: "default" };
  const run = { id: "run_native", sessionId: "session-1", startedAt: "2026-10-04T09:00:10.000Z" };
  const asked = [];
  const noChildren = createLateUsageAttribution({
    usageLedger: { attributeSession: async (input) => { asked.push(input.sessionId); return 1; } },
    agentRuns: { childSessionsOf: async () => { throw new Error("projection unreadable"); } },
  });
  assert.equal(await noChildren(project, run), 1, "the conversation's own session is still swept");
  assert.deepEqual(asked, ["session-1"]);
  const failing = createLateUsageAttribution({
    usageLedger: { attributeSession: async () => { throw new Error("database down"); } },
    agentRuns: { childSessionsOf: async () => [] },
  });
  assert.equal(await failing(project, run), 0);
  const quiet = createLateUsageAttribution({ usageLedger: null, agentRuns: { childSessionsOf: async () => [] } });
  assert.equal(await quiet(project, run), 0, "no ledger, nothing to attribute");
  for (const incomplete of [{ ...run, startedAt: undefined }, { ...run, sessionId: undefined }, { sessionId: "s" }]) {
    assert.equal(await createLateUsageAttribution({ usageLedger: { attributeSession: async () => { throw new Error("must not be asked"); } }, agentRuns: { childSessionsOf: async () => [] } })(project, incomplete), 0);
  }
});

test("the run store the sweep reads is the one assigned after it was built", async () => {
  const dependencies = { usageLedger: { attributeSession: async () => 1 }, agentRuns: /** @type {any} */ (null) };
  const attribute = createLateUsageAttribution(dependencies);
  assert.equal(await attribute({ userId: "u1", id: "default" }, { id: "run_1", sessionId: "s1", startedAt: "2026-10-04T09:00:00.000Z" }), 0, "not yet assigned: nothing, no throw");
  dependencies.agentRuns = { childSessionsOf: async () => [] };
  assert.equal(await attribute({ userId: "u1", id: "default" }, { id: "run_1", sessionId: "s1", startedAt: "2026-10-04T09:00:00.000Z" }), 1);
});
