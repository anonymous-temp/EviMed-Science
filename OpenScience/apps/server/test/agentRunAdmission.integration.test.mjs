import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}

test("a run monitor continues with independent database admission after its dispatch transaction closes", {
  skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let observed;
  const completed = new Promise(resolve => { observed = resolve; });
  const runs = new AgentRunStore({}, {
    model: "deepseek/deepseek-v4-flash",
    independentWork: work => database.withoutTransactionClient(work),
    monitorMaxPolls: 1,
  });
  runs.list = async () => {
    await gate;
    assert.equal(database.transactionScope(), null, "the closed dispatch client must never be borrowed");
    const result = await database.query("SELECT 1 AS independent");
    observed(result.rows[0].independent);
    return [];
  };
  try {
    await database.transaction(client => database.withTransactionClient(client, async () => {
      assert(database.transactionScope());
      runs.scheduleMonitor({ userId: "fixture-owner", id: "fixture-project" }, "fixture-run");
    }));
    release();
    assert.equal(await completed, 1);
  } finally {
    release();
    await runs.closeAll();
    await database.close();
  }
});
