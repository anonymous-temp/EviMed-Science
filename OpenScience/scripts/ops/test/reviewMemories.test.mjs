import assert from "node:assert/strict";
import test from "node:test";

import { chargedProject, parseArguments, reviewAccount } from "../review-memories.mjs";

test("the arguments name the account, and optionally the project the reading is charged to; --apply is the only way to change anything", () => {
  assert.deepEqual(parseArguments(["--user", "u1", "--project", "p1"]), { apply: false, user: "u1", project: "p1", maxBatches: 10 });
  assert.deepEqual(parseArguments(["--user", "u1"]), { apply: false, user: "u1", project: "", maxBatches: 10 });
  assert.equal(parseArguments(["--user", "u1", "--project", "p1", "--apply", "--max-batches", "3"]).maxBatches, 3);
  assert.throws(() => parseArguments(["--project", "p1"]), /--user/);
  assert.throws(() => parseArguments(["--user", "u1", "--project", "p1", "--max-batches", "0"]), /max-batches/);
  assert.throws(() => parseArguments(["--user", "u1", "--project", "p1", "--force"]), /unknown argument/);
});

const records = Array.from({ length: 30 }, (_, index) => ({ id: `rec_${index}`, kind: "project_fact", scope: "project", text: "x" }));

test("a report reads every unread memory in batches and changes nothing", async () => {
  const judged = [];
  const review = {
    available: true,
    async verdicts(/** @type {string} */ _user, /** @type {any[]} */ batch) {
      judged.push(batch.length);
      return new Map(batch.filter((item) => item.id === "rec_3" || item.id === "rec_27").map((item) => [item.id, item.id === "rec_3" ? "platform" : "dispatched_instruction"]));
    },
    async review() { throw new Error("a report must not apply"); },
  };
  const memory = { async unreviewedRecords() { return records; } };
  const result = await reviewAccount(/** @type {any} */ (review), memory, { ...parseArguments(["--user", "u1"]), project: "p1" });
  assert.deepEqual(judged, [24, 6]);
  assert.equal(result.applied, false);
  assert.equal(result.read, 30);
  assert.deepEqual(result.byReason, { platform: 1, dispatched_instruction: 1 });
  assert.deepEqual([result.forgotten, result.decidedInCode, result.decidedByModel], [2, 1, 1], "how many were decided from whose words they rest on, and how many by the model");
  assert.deepEqual(result.items.map((item) => item.id), ["rec_3", "rec_27"]);
  assert.ok(!JSON.stringify(result).includes("\"text\""), "never a memory's text");
});

test("applying reads batch after batch until nothing is left to read", async () => {
  const answers = [{ read: 24, forgotten: [{ id: "rec_1", kind: "follow_up", scope: "project", reason: "run_state" }] }, { read: 6, forgotten: [] }, { read: 0, forgotten: [] }];
  const review = { available: true, async review() { return answers.shift(); } };
  const result = await reviewAccount(/** @type {any} */ (review), {}, { ...parseArguments(["--user", "u1", "--apply"]), project: "p1" });
  assert.equal(result.read, 30);
  assert.equal(result.forgotten, 1);
  assert.equal(answers.length, 0);
});

test("without --project the reading is charged to the account's default project, else its first", async () => {
  const store = (/** @type {string[]} */ ids) => ({ userById: async () => ({ id: "u1" }), listProjects: async () => ids.map((id) => ({ id })) });
  assert.equal(await chargedProject(store(["alpha", "default"]), "u1"), "default");
  assert.equal(await chargedProject(store(["alpha", "beta"]), "u1"), "alpha");
  assert.equal(await chargedProject(store([]), "u1"), "default");
  await assert.rejects(() => chargedProject({ userById: async () => null }, "nobody"), /no such user/);
});
