/**
 * Recall for an integrator, against the real capsule and method stores: the
 * methods it returns, whose they are and in what order, and the capsules a
 * request may name.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { METHOD_SKILL_SCHEMA } from "@evimed/domain";

import { AgentApiKeyStore } from "../src/agentApiKeys.mjs";
import { recallForAgent } from "../src/agentMemoryRecall.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { LearningService } from "../src/learningService.mjs";
import { ProductDocuments } from "../src/productStore.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const hospital = `recall_hospital_${randomUUID()}`;
const stranger = `recall_stranger_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {CapsuleService} */ let capsules;
/** @type {LearningService} */ let learning;
/** @type {{ id: string }} */ let doctor;
/** @type {string} */ let school;
/** @type {string} */ let foreign;

const BODY = [
  "## Purpose", "脾胃气虚证的候选方中以太子参替代党参。", "",
  "## When to Use", "主证为脾胃气虚证时。", "",
  "## Inputs", "候选方与证候。", "",
  "## Workflow", "1. 核对证候。", "2. 以太子参替代党参。", "",
  "## Verification", "- 替换后的方仍经安全审核。", "",
  "## Constraints", "- 不涉及剂量与毒性药。", "",
  "## Output", "调整后的候选方排序与加减建议。",
].join("\n");

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Hospital','development'),($2,'Stranger','development')", [hospital, stranger]);
  const documents = new ProductDocuments(database);
  capsules = new CapsuleService(documents);
  learning = new LearningService({ documents });
  const account = await new AgentApiKeyStore(database).subjectAccount(hospital, "doc-7");
  doctor = { id: account.userId };

  // The institution's shelf: one school, with a method and a fact.
  school = (await capsules.create(hospital, { title: "经方思路" })).id;
  await capsules.addEntry(hospital, school, { factKind: "method_preference", layer: "methods", origin: "explicit",
    content: "先核对方证眼目，不吻合时不得套用经方名。" });
  await capsules.addEntry(hospital, school, { factKind: "expertise", layer: "profile", origin: "explicit",
    content: "代表方示例：桂枝汤、小柴胡汤。" });
  foreign = (await capsules.create(stranger, { title: "别人的胶囊" })).id;

  // The doctor's own habit, learned.
  await learning.createCandidate(doctor.id, {
    frontmatter: {
      name: "habit-taizishen-for-dangshen",
      description: "In spleen-stomach qi deficiency, prefer Taizishen over Dangshen when ranking candidate formulas.",
      whenToUse: "When the principal pattern is spleen-stomach qi deficiency.",
      metadata: { role: "atomic", applies_when: "脾胃气虚证", not_when: "证候不符", derived_from: "observations:12", evimed_schema: METHOD_SKILL_SCHEMA },
    },
    body: BODY,
    provenance: { origin: "inferred" },
    display: { title: "脾胃气虚证：太子参易党参", summary: "脾胃气虚证的候选方中，你常以太子参替代党参。" },
  });
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[hospital, stranger, doctor?.id].filter(Boolean)]);
  await database.close();
});
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("a doctor's recall hands over their own habits first, then the named school's methods and facts", options, async () => {
  const result = await recallForAgent({ capsules, memorySubstrate: null, learning },
    { user: doctor, institution: { id: hospital } }, { query: "桂枝汤", capsuleIds: [school] });
  assert.deepEqual(result.methods.map((method) => method.source), ["learned", "capsule"], "the person's own come first");
  const [own, borrowed] = result.methods;
  assert.equal(own.title, "脾胃气虚证：太子参易党参", "the line a person reads, not the model's name");
  assert.match(own.content, /## Workflow/);
  assert.match(own.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(borrowed.capsuleId, school);
  assert.equal(borrowed.title, "经方思路");
  assert.equal(borrowed.content, "先核对方证眼目，不吻合时不得套用经方名。");
  assert.ok(result.methods.every((method) => method.contextOnly === true));
  assert.deepEqual(result.capsules, [{ id: school, title: "经方思路", owner: "institution" }]);
  assert.ok(result.items.some((item) => item.source === "capsule" && /桂枝汤/.test(item.content)), "the school's facts answer the query");
});

test("without capsuleIds a doctor reads the capsules in force, and the institution's shelf only when named", options, async () => {
  const result = await recallForAgent({ capsules, memorySubstrate: null, learning }, { user: doctor, institution: { id: hospital } }, { query: "桂枝汤" });
  assert.deepEqual(result.methods.map((method) => method.source), ["learned"]);
  assert.equal(result.items.length, 0, "nothing is in force for this doctor");
  assert.equal(result.capsules, undefined);
});

test("methods can be asked for by half, or not at all", options, async () => {
  const ask = (methods) => recallForAgent({ capsules, memorySubstrate: null, learning },
    { user: doctor, institution: { id: hospital } }, { query: "x", capsuleIds: [school], methods });
  assert.deepEqual((await ask("own")).methods.map((method) => method.source), ["learned"]);
  assert.deepEqual((await ask("capsules")).methods.map((method) => method.source), ["capsule"]);
  assert.deepEqual((await ask("none")).methods, []);
});

test("a capsule nobody on this key may read is refused, and says nothing about whether it exists", options, async () => {
  await assert.rejects(
    () => recallForAgent({ capsules, memorySubstrate: null, learning }, { user: doctor, institution: { id: hospital } }, { query: "x", capsuleIds: [foreign] }),
    (error) => error.status === 404 && error.code === "capsule_not_found",
  );
  await assert.rejects(
    () => recallForAgent({ capsules, memorySubstrate: null, learning }, { user: doctor, institution: { id: hospital } }, { query: "x", capsuleIds: [randomUUID()] }),
    (error) => error.status === 404 && error.code === "capsule_not_found",
  );
});

test("the budget is spent in the mount's order: the doctor's own capsule methods, then their habits, then a school's", options, async () => {
  const own = (await capsules.create(doctor.id, { title: "我的记忆胶囊" })).id;
  await capsules.addEntry(doctor.id, own, { factKind: "method_preference", layer: "methods", origin: "explicit", content: "复诊先问睡眠。" });
  await capsules.activate(doctor.id, own, { mode: "own" });
  const result = await recallForAgent({ capsules, memorySubstrate: null, learning }, { user: doctor, institution: { id: hospital } }, { query: "x" });
  assert.deepEqual(result.methods.map((method) => [method.source, method.capsuleId ?? null]), [["capsule", own], ["learned", null]]);
  const withSchool = await recallForAgent({ capsules, memorySubstrate: null, learning }, { user: doctor, institution: { id: hospital } },
    { query: "x", capsuleIds: [own, school] });
  assert.deepEqual(withSchool.methods.map((method) => [method.source, method.capsuleId ?? null]), [["capsule", own], ["learned", null], ["capsule", school]],
    "the institution's school is the doctor's to borrow, and borrowed methods come last");
});

test("a doctor with no memory yet still reads the named school, and nothing of anyone else's", options, async () => {
  const result = await recallForAgent({ capsules, memorySubstrate: null, learning },
    { user: null, institution: { id: hospital } }, { query: "桂枝汤", capsuleIds: [school] });
  assert.deepEqual(result.methods.map((method) => method.source), ["capsule"]);
  assert.equal(result.sources.memory, 0);
  assert.ok(result.items.every((item) => item.source === "capsule"));
});
