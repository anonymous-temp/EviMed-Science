// The settings page's usage 明细: one row per research run of the month, and
// one 「其他」 sum for the rest (2026-09-23 plan §5.9).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { accountUsageRuns } from "../src/accountUsageRuns.mjs";
import { createWebApiApp } from "../src/server.mjs";

const run = (id, extra = {}) => ({
  id, dispatchId: null, title: null, question: null, startedAt: "2026-09-20T02:00:00.000Z", createdAt: "2026-09-20T02:00:00.000Z", ...extra,
});

test("a run's calls under its own id and its dispatch id are one row, titled as the conversation is", () => {
  const { items, other } = accountUsageRuns([
    { runId: "run-1", calls: 60, cost: 3.2, inputTokens: 900_000, outputTokens: 20_000, firstAt: "2026-09-22T01:00:00.000Z" },
    { runId: "turn-1", calls: 2, cost: 0.05, inputTokens: 1_000, outputTokens: 100, firstAt: "2026-09-22T01:05:00.000Z" },
    { runId: "run-2", calls: 10, cost: 1.5, inputTokens: 10_000, outputTokens: 900, firstAt: "2026-09-23T01:00:00.000Z" },
  ], [
    { run: run("run-1", { dispatchId: "turn-1", question: "中医药治疗儿童疳证的 Meta 分析检索", startedAt: "2026-09-22T01:00:00.000Z" }), projectId: "default" },
    { run: run("run-2", { title: "  GLP-1 与心衰  ", question: "别的问题", startedAt: "2026-09-23T01:00:00.000Z" }), projectId: "paper" },
  ]);
  assert.deepEqual(items.map((item) => [item.runId, item.title, item.calls, item.cost, item.projectId]), [
    ["run-2", "GLP-1 与心衰", 10, 1.5, "paper"],
    ["run-1", "中医药治疗儿童疳证的 Meta 分析检索", 62, 3.25, "default"],
  ], "newest first, the typed title over the question, the dispatch id's calls added to the run's");
  assert.equal(items[1].inputTokens, 901_000, "tokens travel with the row, for an operator");
  assert.deepEqual(other, { calls: 0, cost: 0 });
});

test("what no conversation can show is summed into 其他, so the rows and 其他 are the whole month", () => {
  const groups = [
    { runId: null, calls: 40, cost: 1.23 },
    { runId: "run-gone", calls: 3, cost: 0.4 },
    { runId: "run-deleted", calls: 5, cost: 0.6 },
    { runId: "run-internal", calls: 7, cost: 0.9 },
    { runId: "run-kept", calls: 1, cost: 0.01 },
    { runId: "run-unsettled", calls: 0, cost: 0 },
  ];
  const { items, other } = accountUsageRuns(groups, [
    { run: run("run-deleted", { deleted: true }), projectId: "default" },
    { run: run("run-internal"), projectId: "default", internal: true },
    { run: run("run-kept"), projectId: "default" },
    { run: run("run-unsettled"), projectId: "default" },
  ]);
  assert.deepEqual(items.map((item) => item.runId), ["run-kept"], "a run with nothing settled has no money to show");
  assert.equal(items[0].title, null, "an untitled run is the page's to name");
  assert.deepEqual(other, { calls: 55, cost: 3.13 });
  const total = items.reduce((sum, item) => sum + item.cost, 0) + other.cost;
  assert.equal(Math.round(total * 100) / 100, 3.14);
});

async function withAccount(fn, ledger) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-usage-runs-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false,
    bootstrapUser: "alice", bootstrapPassword: "correct horse battery staple",
    ...(ledger ? { usageLedger: ledger } : {}),
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "correct horse battery staple" }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    await fn({ app, base, cookie });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("GET /api/account/usage/runs answers this month from the ledger, titled from the account's own runs", async () => {
  const asked = [];
  const ledger = {
    health: async () => ({ ok: true }),
    reconcileExpiredReservations: async () => ({ reconciled: 0, remaining: 0, failedAccounts: 0 }),
    summaryRuns: async () => new Map(),
    assertWithinLimits: async () => ({ allowed: true }),
    runsSince: async (userId, options) => {
      asked.push({ userId, since: options.since.toISOString() });
      return [
        { runId: null, calls: 4, cost: 0.2, inputTokens: 0, outputTokens: 0, firstAt: null },
        { runId: "run-1", calls: 60, cost: 3.2, inputTokens: 900_000, outputTokens: 20_000, firstAt: "2026-09-22T01:00:00.000Z" },
        { runId: "turn-1", calls: 2, cost: 0.05, inputTokens: 1_000, outputTokens: 100, firstAt: "2026-09-22T01:05:00.000Z" },
        { runId: "run-elsewhere", calls: 1, cost: 0.1, inputTokens: 10, outputTokens: 1, firstAt: "2026-09-21T01:00:00.000Z" },
      ];
    },
  };
  await withAccount(async ({ app, base, cookie }) => {
    const refused = await fetch(`${base}/api/account/usage/runs`);
    assert.equal(refused.status, 401, "an account's spend is its own");

    const user = await app.store.userById("alice");
    const project = await app.store.requireProject(user, "default");
    await mkdir(project.metaDir, { recursive: true });
    await writeFile(path.join(project.metaDir, "runs.jsonl"), `${JSON.stringify({
      event: "started", id: "run-1", dispatchId: "turn-1", sessionId: "session-1", mode: "open-domain",
      agentId: null, agentVersion: null, runtimeAgent: null, model: "deepseek/deepseek-v4-pro",
      question: "中医药治疗儿童疳证的 Meta 分析检索",
      createdAt: "2026-09-22T01:00:00.000Z", startedAt: "2026-09-22T01:00:00.000Z",
    })}\n`, "utf8");

    const response = await fetch(`${base}/api/account/usage/runs`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    assert.deepEqual(asked, [{ userId: "alice", since: monthStart }], "the month the summary covers, and nobody else's rows");
    assert.equal(data.since, monthStart);
    assert.equal(data.currency, "CNY");
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].runId, "run-1");
    assert.equal(data.items[0].title, "中医药治疗儿童疳证的 Meta 分析检索");
    assert.equal(data.items[0].cost, 3.25);
    assert.equal(data.items[0].calls, 62);
    assert.deepEqual(data.other, { calls: 5, cost: 0.3 });
  }, ledger);
});

test("without the durable ledger there is no run attribution, and the month is all 其他", async () => {
  await withAccount(async ({ base, cookie }) => {
    const response = await fetch(`${base}/api/account/usage/runs`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.items, []);
    assert.deepEqual(data.other, { calls: 0, cost: 0 });
    assert.ok(Date.parse(data.since) > 0);
  });
});
