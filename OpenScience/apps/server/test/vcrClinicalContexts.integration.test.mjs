// Which conversations of a project hold a clinical source dependency, asked for a whole list at once (2026-10-10 review D7).
// `hasClinicalContext` answers one conversation per statement; the learning loop's routine count used to ask it once per selected
// run, all at once, for every project of the account. `clinicalContextsHeld` is the same question for a list.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && "An isolated test PostgreSQL is required" };
/** @type {any} */ let database;
/** @type {any} */ let isolated;
/** @type {any} */ let vcr;
/** @type {string} */ let directory = "";

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(/** @type {string} */ (process.env.OPEN_SCIENCE_TEST_POSTGRES_URL), "clinctx");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-clinctx-"));
  vcr = composeVcr({ config: { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: directory, deepseekBaseUrl: "https://api.example.org" }, productDatabase: database });
  await vcr.store.ready();
});
after(async () => {
  await database?.close();
  await isolated?.drop();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test("a list of conversations is answered in one statement, and each answer is the one asked about it alone", options, async () => {
  const projectId = `prj_${Math.random().toString(16).slice(2)}`;
  const study = await vcr.store.createStudy({ userId: "owner", projectId, name: "Synthetic reuse test", question: "q", dataTier: "T0" });
  const projection = `prj_${"c".repeat(48)}`;
  await vcr.store.inheritCloudDependency(study.id, "session_a", "run_a", projection);
  await vcr.store.inheritCloudDependency(study.id, "session_c", "run_c", projection);
  await vcr.store.inheritCloudDependency(study.id, "session_d", "run_d", projection);
  const contexts = [
    { sessionId: "session_a", runId: "run_a" },
    { sessionId: "session_b", runId: "run_b" },
    { sessionId: "session_c" },
    { runId: "run_d" },
    { sessionId: "session_b", runId: "run_a" },
    { sessionId: "session_b", runId: "run_other" },
  ];
  const expected = [true, false, true, true, true, false];

  let transactions = 0;
  const transaction = database.transaction.bind(database);
  database.transaction = (/** @type {any} */ work) => { transactions += 1; return transaction(work); };
  const held = await vcr.store.clinicalContextsHeld("owner", projectId, contexts);
  database.transaction = transaction;
  assert.deepEqual(held, expected);
  assert.equal(transactions, 1, "one statement for the list, not one for each conversation");
  for (const [index, context] of contexts.entries()) {
    assert.equal(await vcr.store.hasClinicalContext("owner", projectId, [context]), expected[index], `asked alone: ${JSON.stringify(context)}`);
  }

  assert.deepEqual(await vcr.store.clinicalContextsHeld("owner", projectId, []), [], "an empty list is not a question");
  assert.deepEqual(await vcr.store.clinicalContextsHeld("stranger", projectId, contexts), contexts.map(() => false), "another account holds none in this project");
  assert.deepEqual(await vcr.store.clinicalContextsHeld("owner", `${projectId}_other`, contexts), contexts.map(() => false), "nor does the owner in a project with no study");
  // A conversation that cannot be attributed to anything is held when the project holds any clinical dependency, as
  // `hasClinicalContext` with no contexts says, and the attributed ones around it keep their own answers.
  assert.deepEqual(await vcr.store.clinicalContextsHeld("owner", projectId, [{}, { sessionId: "session_b" }]), [true, false]);
  assert.equal(await vcr.store.hasClinicalContext("owner", projectId), true);
});

test("a deployment that never created the VCR schema answers every conversation as holding none, and creates nothing", options, async () => {
  const empty = await createGeoTestDatabase(/** @type {string} */ (process.env.OPEN_SCIENCE_TEST_POSTGRES_URL), "clinctxempty");
  const bare = new ControlPlaneDatabase({ databaseUrl: empty.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 2000 });
  try {
    const store = new VcrStore({ database: bare });
    assert.deepEqual(await store.clinicalContextsHeld("owner", "ordinary", [{ sessionId: "s", runId: "r" }, {}]), [false, false]);
    assert.equal((await bare.query("SELECT to_regclass('evimed_vcr.studies') AS found")).rows[0].found, null);
  } finally {
    await bare.close();
    await empty.drop();
  }
});
