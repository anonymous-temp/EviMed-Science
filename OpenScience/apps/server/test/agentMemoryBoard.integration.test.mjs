/**
 * The doctor dashboard against the real stores: a habit is stopped and taken back to the version that was in force; a note an outside
 * agent proposed waits in the same list and is confirmed there (admitted to the engine, which is the one double here: the memory files
 * themselves are the engine's and are read where its store is tested, `nativeMemory*.test.mjs` and `agentMemoryNative.integration.test.mjs`).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { METHOD_SKILL_SCHEMA } from "@evimed/domain";

import { AgentApiKeyStore } from "../src/agentApiKeys.mjs";
import { memoryBoard, methodAction, methodDetail, noteAction } from "../src/agentMemoryBoard.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { LearningService } from "../src/learningService.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { MemorySettingsStore } from "../src/memorySettings.mjs";

/** The engine's store as the board reads it: no files, and an admission that settles at once. */
function engineDouble() {
  const admissions = new Map();
  return {
    configured: true,
    async listRecords() { return []; },
    async changes() { return []; },
    async admitCandidate(userId, input) {
      const state = { state: "completed", taskId: "task-1", recordIds: [] };
      admissions.set(`${userId}/${input.candidateId}/${input.revision}`, state);
      return state;
    },
    overlay: { async admission(userId, id, revision) { return admissions.get(`${userId}/${id}/${revision}`) ?? null; } },
  };
}

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const hospital = `board_hospital_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {any} */ let services;
/** @type {{ id: string }} */ let doctor;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Hospital','development')", [hospital]);
  const documents = new ProductDocuments(database);
  services = {
    memorySettings: new MemorySettingsStore({}, { database }),
    nativeMemory: engineDouble(),
    learning: new LearningService({ documents }),
    capsules: new CapsuleService(documents),
    documents,
  };
  doctor = { id: (await new AgentApiKeyStore(database).subjectAccount(hospital, "doc-7")).userId };
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','默认',1048576) ON CONFLICT DO NOTHING", [doctor.id]);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[hospital, doctor?.id].filter(Boolean)]);
  await database.close();
});
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("a habit is stopped, and taking the stop back restores the version that was in force", options, async () => {
  const created = await services.learning.createCandidate(doctor.id, {
    frontmatter: {
      name: "habit-taizishen", description: "Prefer Taizishen over Dangshen in spleen-stomach qi deficiency.",
      whenToUse: "Spleen-stomach qi deficiency.",
      metadata: { role: "atomic", applies_when: "脾胃气虚证", not_when: "证候不符", derived_from: "observations:9", evimed_schema: METHOD_SKILL_SCHEMA },
    },
    body: ["## Purpose", "以太子参易党参。", "", "## When to Use", "脾胃气虚证。", "", "## Inputs", "候选方。", "", "## Workflow", "1. 替换。", "",
      "## Verification", "- 仍经审方。", "", "## Constraints", "- 不涉及剂量。", "", "## Output", "候选方。"].join("\n"),
    provenance: { origin: "inferred", source: "observations" },
    display: { title: "脾胃气虚证：太子参易党参", summary: "你常以太子参替代党参。" },
  });
  let board = await memoryBoard(services, doctor);
  assert.deepEqual(board.habits.map((habit) => [habit.title, habit.status, habit.isNew, habit.source]),
    [["脾胃气虚证：太子参易党参", "approved", true, "observed"]]);
  const retired = await methodAction(services, doctor, created.id, "retire", { expectedRevision: created.revision });
  assert.equal(retired.payload.status, "retired");
  board = await memoryBoard(services, doctor);
  const change = board.recentChanges.find((item) => item.methodId === created.id);
  assert.equal(change.undo.action, "restore");
  const restored = await methodAction(services, doctor, created.id, "restore", { expectedRevision: change.undo.expectedRevision });
  assert.equal(restored.payload.status, "approved");
  const detail = await methodDetail(services, doctor, created.id);
  assert.equal(detail.status, "approved");
  assert.deepEqual(detail.versions.map((version) => [version.version, version.current, version.wasTrue]), [[1, true, false]],
    "a stop and its undo are not versions: the method has held one body");
});

test("a note an outside agent proposed waits in the same list, and is confirmed there", options, async () => {
  const note = await services.capsules.note(doctor.id, "default", { factKind: "preference", content: "复诊间隔一周", origin: "inferred", review: true });
  let board = await memoryBoard(services, doctor);
  const waiting = board.pending.find((item) => item.type === "note");
  assert.equal(waiting.id, note.id);
  await noteAction(services, doctor, note.id, "confirm", { expectedRevision: waiting.revision });
  board = await memoryBoard(services, doctor);
  assert.ok(!board.pending.some((item) => item.id === note.id));
});
