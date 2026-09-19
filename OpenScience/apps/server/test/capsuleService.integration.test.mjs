import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { HttpError } from "../src/security.mjs";

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


test("runtime notes are idempotent and take effect at once, and a retirement takes them out", options, async () => {
  // Owner ruling 2026-09-19: no confirmation step anywhere. A note is in force
  // the moment it is written, as the assistant's wording, and one click undoes
  // it.
  const first = await service.note(other, "other", { factKind: "preference", content: "Retain analytic assumptions." });
  const again = await service.note(other, "other", { factKind: "preference", content: "Retain analytic assumptions." });
  assert.equal(first.id, again.id);
  assert.equal(first.payload.status, "approved");
  assert.equal(first.payload.origin, "inferred");
  assert.equal((await service.recall(other, { projectId: "other", query: "analytic" })).items.length, 1);
  const undone = await service.undoEntry(other, first.payload.capsuleId, first.id, { expectedRevision: first.revision });
  assert.equal(undone.undone, "removed");
  assert.equal((await service.recall(other, { projectId: "other", query: "analytic" })).items.length, 0);
});


/** An index whose recall does whatever the case needs. Nothing else is reached:
 *  the capsule service asks it for the account generation and for hits. */
function indexDouble(recall) {
  return { async accountGeneration() { return "2026-09-11 00:00:00+00"; }, recall };
}

test("capsule recall answers from PostgreSQL when the index cannot, including before it holds anything", options, async () => {
  const capsule = await service.create(owner, { title: "Fallback capsule" });
  await service.addEntry(owner, capsule.id, { factKind: "preference", content: "Fallback evidence sentence." });
  await service.activate(owner, capsule.id, { mode: "own" });
  const documents = new ProductDocuments(database);

  const unavailable = new CapsuleService(documents, {
    indexing: indexDouble(async () => { throw new HttpError(502, "memory_index_unavailable", "The memory index is unavailable."); }),
  });
  const afterFailure = await unavailable.recall(owner, { query: "Fallback" });
  assert.equal(afterFailure.mode, "lexical");
  assert.deepEqual(afterFailure.items.map((item) => item.content), ["Fallback evidence sentence."]);
  assert.equal(unavailable.lastIndexError, "memory_index_unavailable");

  // An index that holds nothing for this capsule yet is the ordinary state of
  // one the worker has not reached — and of every capsule on the day the
  // provider is turned on. Answering nothing there would be a regression
  // against the deployment that had no index at all.
  const cold = await new CapsuleService(documents, { indexing: indexDouble(async () => []) }).recall(owner, { query: "Fallback" });
  assert.equal(cold.mode, "lexical");
  assert.deepEqual(cold.items.map((item) => item.content), ["Fallback evidence sentence."]);

  const strict = new CapsuleService(documents, { indexing: indexDouble(async () => []), strictIndex: true });
  assert.deepEqual(await strict.recall(owner, { query: "Fallback" }), { items: [], mode: "semantic", contextOnly: true });
});

test("an account recreated under this request is reported, not answered from the lexical path", options, async () => {
  // The generation guard is not an index failure. It says the account was
  // deleted and made again while this recall ran, and a caller that asked about
  // one account must not be handed the other's answer without being told.
  const capsule = await service.create(owner, { title: "Generation capsule" });
  await service.addEntry(owner, capsule.id, { factKind: "preference", content: "Generation evidence sentence." });
  await service.activate(owner, capsule.id, { mode: "own" });
  const changed = new CapsuleService(new ProductDocuments(database), {
    indexing: indexDouble(async () => { throw new HttpError(409, "memory_account_changed", "The account changed during memory recall."); }),
  });

  await assert.rejects(changed.recall(owner, { query: "Generation" }), { code: "memory_account_changed" });
});

test("recall applies type and time filters before limiting the selected context", options, async () => {
  const capsule = await service.create(owner, { title: "Filtered recall" });
  const method = await service.addEntry(owner, capsule.id, { factKind: "method_preference", content: "Matching method" });
  await service.addEntry(owner, capsule.id, { factKind: "preference", content: "Matching style" });
  await service.activate(owner, capsule.id);
  assert.deepEqual((await service.recall(owner, { query: "Matching", limit: 1, factKinds: ["method_preference"] })).items.map((x) => x.id), [method.id]);
  assert.equal((await service.recall(owner, { query: "Matching", since: "2099-01-01" })).items.length, 0);
  await assert.rejects(service.recall(owner, { query: "Matching", factKinds: ["permission"] }), { code: "capsule_payload_invalid" });
  await assert.rejects(service.recall(owner, { query: "Matching", scope: "agenda" }), { code: "capsule_scope_unavailable" });
});

test("the resident profile reads approved person entries of the researcher's own capsules from PostgreSQL", options, async () => {
  // Its own account: activation is per account, and the cases above leave
  // theirs in whatever state they needed.
  const profileOwner = `capsule_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Profile owner','development')", [profileOwner]);
  try {
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'profile','Profile',1048576)", [profileOwner]);
    const own = await service.create(profileOwner, { title: "Own capsule" });
    await service.addEntry(profileOwner, own.id, { factKind: "profile", layer: "profile", content: "Cardiology pharmacist." });
    await service.addEntry(profileOwner, own.id, { factKind: "writing_style", layer: "profile", content: "Conclusion first." });
    await service.addEntry(profileOwner, own.id, { factKind: "preference", layer: "profile", content: "Inferred, not approved.", origin: "inferred" });
    await service.addEntry(profileOwner, own.id, { factKind: "project_fact", content: "Uses MIMIC-IV." });
    const guest = await service.create(profileOwner, { title: "Colleague's pack" });
    await service.addEntry(profileOwner, guest.id, { factKind: "profile", layer: "profile", content: "Oncologist." });
    await service.activate(profileOwner, own.id, { mode: "own", projectId: "profile" });
    await service.activate(profileOwner, guest.id, { mode: "guest", projectId: "profile" });
    const facts = await service.profileFacts(profileOwner, "profile", ["profile", "expertise", "preference", "stance", "writing_style"]);
    assert.deepEqual(facts.map((fact) => fact.content).sort(), ["Cardiology pharmacist.", "Conclusion first."]);
    assert.ok(facts.every((fact) => fact.capsuleId === own.id && typeof fact.updatedAt === "string"));
  } finally {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [profileOwner]);
  }
});
