/**
 * The doctor dashboard against the real stores: a proposal waits, the doctor
 * confirms it and it is theirs; forgetting and restoring and undoing are acts
 * the record's own history then shows; a habit is stopped and taken back to
 * the version that was in force; a note an outside agent proposed waits in the
 * same list and is confirmed there.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { METHOD_SKILL_SCHEMA } from "@evimed/domain";

import { AgentApiKeyStore } from "../src/agentApiKeys.mjs";
import { memoryBoard, methodAction, methodDetail, noteAction, recordAction } from "../src/agentMemoryBoard.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
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
    researchMemory: new ResearchMemoryStore({}, { database }),
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

test("a proposal waits for the doctor, and confirming it makes it theirs, with the evidence it came with", options, async () => {
  const proposal = await services.researchMemory.upsertRecord(doctor.id, {
    scope: "user", scopeId: "", kind: "preference", key: "preference.herb_count", value: "药味控制在 12 味以内", summary: "药味不超过 12 味",
    origin: "explicit", status: "pending", confidence: 1, importance: 0.8, sensitive: false,
  }, { sourceType: "conversation_message", sourceRef: "sessions/external-1/messages/0", quote: "我一般开 12 味以内", observedAt: "2026-09-26T00:00:00.000Z", weight: 1 },
  { reason: "conversation evidence created the memory; held for its owner: proposed by an agent outside the platform", by: "extraction" });

  let board = await memoryBoard(services, doctor);
  assert.deepEqual(board.pending.map((item) => item.id), [proposal.id]);
  assert.equal(board.records.length, 0, "nothing is in force yet");

  await recordAction(services, doctor, proposal.id, "confirm", { expectedVersion: proposal.version });
  board = await memoryBoard(services, doctor);
  const [row] = board.records;
  assert.equal(row.id, proposal.id);
  assert.equal(row.source, "self");
  assert.equal(row.basis.kind, "confirmed", "the record's own history says the owner confirmed it");
  assert.deepEqual(row.quotes.map((quote) => quote.quote), ["我一般开 12 味以内"]);
  assert.equal(board.pending.length, 0);
});

test("an edit leaves what it used to say as 曾经如此, forgetting and restoring move it, and undo takes the last act back", options, async () => {
  let record = (await services.researchMemory.listRecords(doctor.id, { statuses: ["active"] }))[0];
  record = (await recordAction(services, doctor, record.id, "edit", { expectedVersion: record.version, summary: "药味不超过 10 味", value: "药味控制在 10 味以内" })).record;
  let board = await memoryBoard(services, doctor);
  assert.deepEqual(board.records[0].wasTrue.map((item) => item.summary), ["药味不超过 12 味"]);
  assert.equal(board.records[0].source, "self");

  record = (await recordAction(services, doctor, record.id, "forget", { expectedVersion: record.version })).record;
  board = await memoryBoard(services, doctor);
  assert.deepEqual([board.records.length, board.forgotten.map((item) => item.id)], [0, [record.id]]);
  record = (await recordAction(services, doctor, record.id, "restore", { expectedVersion: record.version })).record;
  assert.equal(record.status, "active");
  const undone = await recordAction(services, doctor, record.id, "undo", { expectedVersion: record.version });
  assert.equal(undone.record.status, "archived", "undoing the restore forgets it again");
});

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
