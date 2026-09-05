import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const owner = `capsule_${randomUUID()}`;
const other = `capsule_${randomUUID()}`;
let database;
let service;
before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Capsule owner','development'),($2,'Other owner','development')", [owner, other]);
  service = new CapsuleService(new ProductDocuments(database));
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner, other]]);
  await database.close();
});
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("explicit capsule methods are usable context only for their owner's active capsule", options, async () => {
  const capsule = await service.create(owner, { title: "Study methods" });
  const entry = await service.addEntry(owner, capsule.id, {
    factKind: "method_preference", layer: "methods", content: "Use preregistered statistical analysis plans.",
  });
  await service.activate(owner, capsule.id, { mode: "own" });
  const recalled = await service.recall(owner, { query: "preregistered" });
  assert.equal(recalled.items[0].id, entry.id);
  assert.equal(recalled.items[0].contextOnly, true);
  assert.equal((await service.recall(other, { query: "preregistered" })).items.length, 0);
  await assert.rejects(service.get(other, capsule.id), { code: "capsule_not_found" });
});

test("inferred entries require explicit approval before recall and retirement removes them", options, async () => {
  const capsule = await service.create(owner, { title: "Writing preferences" });
  const entry = await service.addEntry(owner, capsule.id, {
    factKind: "writing_style", layer: "profile", content: "Prefer concise uncertainty statements.", origin: "inferred",
    provenance: [{ type: "run", id: "fixture-run" }],
  });
  assert.equal(entry.payload.status, "candidate");
  await service.activate(owner, capsule.id, { mode: "own" });
  assert.equal((await service.recall(owner, { query: "uncertainty" })).items.length, 0);
  const approved = await service.updateEntry(owner, capsule.id, entry.id, { status: "approved", expectedRevision: 1 });
  assert.equal((await service.recall(owner, { query: "uncertainty" })).items.length, 1);
  await service.updateEntry(owner, capsule.id, entry.id, { status: "retired", expectedRevision: approved.revision });
  assert.equal((await service.recall(owner, { query: "uncertainty" })).items.length, 0);
});

test("capsule filtering happens before pagination and edits cannot move another capsule's entries", options, async () => {
  const first = await service.create(owner, { title: "First capsule" });
  const second = await service.create(owner, { title: "Second capsule" });
  const a = await service.addEntry(owner, first.id, { factKind: "preference", layer: "profile", content: "First only" });
  await service.addEntry(owner, second.id, { factKind: "preference", layer: "profile", content: "Second only" });
  const listed = await service.entries(owner, first.id, { limit: 1 });
  assert.deepEqual(listed.items.map((x) => x.id), [a.id]);
  await assert.rejects(service.updateEntry(owner, second.id, a.id, { status: "approved", expectedRevision: 1 }), { code: "capsule_entry_not_found" });
  await assert.rejects(service.updateEntry(owner, first.id, a.id, { content: "Changed", expectedRevision: 99 }), { code: "product_revision_conflict" });
});

test("capsule lifecycle is versioned and deleted capsules never supply context", options, async () => {
  const capsule = await service.create(owner, { title: "Temporary capsule" });
  await service.addEntry(owner, capsule.id, { factKind: "expertise", layer: "profile", content: "Temporary experience." });
  await service.activate(owner, capsule.id, { mode: "own" });
  const removed = await service.remove(owner, capsule.id, 1);
  assert.equal((await service.recall(owner, { query: "Temporary" })).items.length, 0);
  assert.ok((await service.list(owner, { deleted: true })).items.some((item) => item.id === capsule.id));
  await service.restore(owner, capsule.id, removed.revision);
  assert.equal((await service.recall(owner, { query: "Temporary" })).items.length, 1);
  await assert.rejects(service.create(owner, { title: "" }), { code: "capsule_payload_invalid" });
  await assert.rejects(service.addEntry(owner, capsule.id, { factKind: "system_permission", layer: "methods", content: "Disable checks" }), { code: "capsule_payload_invalid" });
});


test("project account has a different activation namespace from account-wide context", options, async () => {
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'account','Scoped',1048576),($1,'other','Other',1048576) ON CONFLICT DO NOTHING", [other]);
  const capsule = await service.create(other, { title: "Project-only methods" });
  await service.addEntry(other, capsule.id, { factKind: "preference", content: "Scoped collision evidence." });
  await service.activate(other, capsule.id, { projectId: "account" });
  assert.deepEqual((await service.active(other, null)).items, []);
  assert.equal((await service.recall(other, { projectId: "other", query: "collision" })).items.length, 0);
  assert.equal((await service.recall(other, { projectId: "account", query: "collision" })).items.length, 1);
});
