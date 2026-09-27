/**
 * The M2 loop of the TCM CDSS plan on the real stores, with no runtime: a
 * doctor's repeated edits become a habit in the method ledger, the dashboard
 * counts it, recall hands it over, and a habit the doctor stops doing is
 * retired with the reason said. 「医生多次调整处方—看板出现相应习惯—后续候选方
 * 体现该习惯—医生停用后不再体现」.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { AgentApiKeyStore } from "../src/agentApiKeys.mjs";
import { memoryBoard } from "../src/agentMemoryBoard.mjs";
import { AgentObservations, HabitWriter, readObservation } from "../src/agentMemoryObservations.mjs";
import { recallForAgent } from "../src/agentMemoryRecall.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { LearningService } from "../src/learningService.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const hospital = `observe_hospital_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {any} */ let services;
/** @type {{ id: string }} */ let doctor;
/** @type {{ id: string }} */ let paused;
const wordings = [];

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Hospital','development')", [hospital]);
  const documents = new ProductDocuments(database);
  const learning = new LearningService({ documents });
  const researchMemory = new ResearchMemoryStore({}, { database });
  // The model's line, as the gateway would return it.
  const writer = new HabitWriter({ deepseekProviderEnabled: true, deepseekApiKey: "unit-test-key", deepseekModel: "deepseek-v4-flash" }, {
    callModel: async (_context, call) => {
      wordings.push(call);
      return { choices: [{ message: { content: JSON.stringify({ title: "脾胃气虚证多用太子参", summary: "脾胃气虚证的候选方里，你多以太子参代替党参。" }) } }] };
    },
  });
  services = { researchMemory, learning, observations: new AgentObservations({ database, learning, researchMemory, writer }) };
  const keys = new AgentApiKeyStore(database);
  doctor = { id: (await keys.subjectAccount(hospital, "doc-7")).userId };
  paused = { id: (await keys.subjectAccount(hospital, "doc-8")).userId };
  await researchMemory.updateSettings(paused.id, { learningPaused: true });
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[hospital, doctor?.id, paused?.id].filter(Boolean)]);
  await database.close();
});
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const edit = (id, changes) => readObservation({ observationId: id, syndrome: "脾胃气虚证", lineage: "经方思路", changes });
const swap = { type: "replace", from: "党参", to: "太子参" };

test("three edits make a habit that takes effect, the dashboard counts it and recall hands it over", options, async () => {
  const first = await services.observations.observe(doctor, edit("e1", [swap, { type: "add", herb: "制附子" }]));
  assert.deepEqual([first.recorded, first.habits], [true, []]);
  assert.deepEqual(first.neverLearned.map((change) => change.herb), ["制附子"]);
  await services.observations.observe(doctor, edit("e2", [swap]));
  const third = await services.observations.observe(doctor, edit("e3", [swap]));
  assert.deepEqual(third.habits.map((habit) => [habit.change, habit.title]), [["learned", "脾胃气虚证多用太子参"]]);
  assert.equal(wordings.length, 1, "one wording pass for one habit");
  assert.equal(wordings[0].purpose, "learning");

  const again = await services.observations.observe(doctor, edit("e3", [swap]));
  assert.deepEqual([again.recorded, again.reason], [false, "duplicate"], "the same edit twice is one edit");

  const board = await memoryBoard(services, doctor);
  assert.deepEqual(board.habits.map((habit) => [habit.title, habit.status, habit.isNew, habit.source, habit.basis?.observed, habit.basis?.related]),
    [["脾胃气虚证多用太子参", "approved", true, "observed", 3, 3]]);
  assert.deepEqual(board.neverLearned, [{ herb: "附子", count: 1 }], "「不学习」: seen, never learned from, and named as the herb it is");

  const recalled = await recallForAgent({ capsules: null, memorySubstrate: null, learning: services.learning }, { user: doctor }, { query: "脾胃气虚", methods: "own" });
  assert.deepEqual(recalled.methods.map((method) => method.title), ["脾胃气虚证多用太子参"]);
  assert.match(recalled.methods[0].content, /以太子参替代党参/);
});

test("a habit the doctor stops doing is retired, with the reason said, and leaves recall", options, async () => {
  let retired = [];
  for (let index = 4; index <= 30 && !retired.length; index += 1) {
    const outcome = await services.observations.observe(doctor, edit(`e${index}`, [{ type: "add", herb: "茯苓" }]));
    retired = outcome.habits.filter((habit) => habit.change === "retired");
  }
  assert.equal(retired.length, 1);
  const board = await memoryBoard(services, doctor);
  const habit = board.habits.find((item) => item.id === retired[0].id);
  assert.deepEqual([habit.status, habit.statusReason], ["retired", "最近的改方里不再这样做"]);
  const recalled = await recallForAgent({ capsules: null, memorySubstrate: null, learning: services.learning }, { user: doctor }, { query: "x", methods: "own" });
  assert.ok(!recalled.methods.some((method) => method.id === retired[0].id));
});

test("a doctor who paused learning is not observed at all", options, async () => {
  const outcome = await services.observations.observe(paused, edit("p1", [swap]));
  assert.deepEqual([outcome.recorded, outcome.reason], [false, "paused"]);
  const { rows } = await database.query("SELECT count(*)::integer AS count FROM evimed_agent.observations WHERE user_id=$1", [paused.id]);
  assert.equal(rows[0].count, 0);
});
