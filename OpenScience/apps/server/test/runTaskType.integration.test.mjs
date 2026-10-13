// What kind of work a conversation was, against the real usage ledger (2026-10-13): the call is booked under its own purpose, which
// the ledger's CHECK must accept; the account's day is counted from what the ledger already holds, so a restart does not give it
// back; and a conversation older than the feature is judged when the map is read, through the same path.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { USAGE_PURPOSES } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { TaskTyper, TaskTypeScheduler } from "../src/runTaskType.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const owner = `tasktype_${randomUUID()}`;
let database;
let isolated;
let usage;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "tasktype");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Task type test','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'project-test','Task type project',1000000)", [owner]);
  usage = new UsageLedger(database);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
  await isolated.drop();
});

const config = {
  taskTypeEnabled: true, taskTypeDailyCalls: 2, deepseekProviderEnabled: true, deepseekApiKey: "provider-key", deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-flash", modelGatewayReservationMaxOutputTokens: 4096, userDailySpendLimit: 0, userWeeklySpendLimit: 0,
};
const reply = (type) => async () => Response.json({ id: `provider-${randomUUID()}`, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ type }) } }],
  usage: { prompt_tokens: 300, completion_tokens: 6, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 300 } });
const finished = (id) => ({ id, status: "succeeded", question: "把这份报告做成十页的幻灯片", finishedAt: new Date().toISOString(), effectiveAgentId: "open-domain-answer" });

test("the purpose is in the vocabulary, and the call is booked under it with the account's caps", options, async () => {
  assert.ok(USAGE_PURPOSES.includes("task-type"));
  const typer = new TaskTyper(config, { usageLedger: usage, fetchImpl: reply("documents") });
  assert.equal(await typer.typeOf({ question: "把这份报告做成幻灯片" }, { userId: owner, projectId: "project-test", runId: "run_1" }), "documents");
  const rows = await database.query("SELECT purpose, status, run_id FROM evimed_usage.model_requests WHERE user_id=$1", [owner]);
  assert.deepEqual(rows.rows.map((row) => [row.purpose, row.status, row.run_id]), [["task-type", "settled", "run_1"]]);
  assert.equal((await usage.summary(owner, { purposes: ["task-type"] })).totalCalls, 1);
  assert.equal((await usage.summary(owner, { purposes: ["title"] })).totalCalls, 0, "its own column of the cost report");
});

test("a restart does not give the account's day back: the ledger already holds one call, so one more is the bound", options, async () => {
  const asked = [];
  const fresh = new TaskTypeScheduler({
    typer: new TaskTyper(config, { usageLedger: usage, fetchImpl: async (...args) => { asked.push(args); return reply("code")(); } }),
    recordType: async () => {}, dailyCalls: () => config.taskTypeDailyCalls, usageLedger: usage,
  });
  const project = { id: "project-test", userId: owner };
  for (const id of ["r_a", "r_b", "r_c"]) { fresh.consider(project, finished(id)); await fresh.settle(); }
  assert.equal(asked.length, 1, "two a day, one already made before this process started");
  assert.equal((await usage.summary(owner, { purposes: ["task-type"] })).totalCalls, 2);
});
