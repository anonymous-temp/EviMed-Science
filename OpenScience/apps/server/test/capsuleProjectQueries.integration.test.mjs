import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PostgresStore } from "../src/store.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { loadConfig } from "../src/config.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { makeCapsule } from "./helpers/capsuleFixtures.mjs";

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && "Disposable PostgreSQL required" };
async function fixture(t) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, "capsuleprojectqueries");
  let accounts, directory;
  t.after(async () => { await accounts?.database.close(); await isolated.drop(); if (directory) await rm(directory, { recursive: true, force: true }); });
  directory = await mkdtemp(path.join(os.tmpdir(), "capsule-project-queries-"));
  accounts = new PostgresStore(loadConfig({ dataDir: directory, databaseUrl: isolated.url, stateStore: "postgres" }));
  await accounts.createUser("owner", "test-only-password", "Owner");
  await accounts.createUser("other", "test-only-password", "Other");
  const owner = await accounts.userById("owner");
  await accounts.defaultProject(owner);
  await accounts.defaultProject(await accounts.userById("other"));
  await accounts.createProject(owner, "other-project", "Other project");
  const documents = new ProductDocuments(accounts.database), service = new CapsuleService(documents);
  // A hand-made source capsule (main's `makeCapsule`: `CapsuleService.create` left the service with no production caller).
  const capsule = await makeCapsule(service, owner.id, { title: "Scoped fixtures" });
  const ids = { project: [], other: [], account: [] };
  for (const [name, projectId, count] of [["project", "default", 2], ["other", "other-project", 15], ["account", null, 15]]) {
    for (let n = 0; n < count; n += 1) {
      const id = `${name}-${n}`;
      await documents.put(owner.id, "fact", id, { capsuleId: capsule.id, content: `Shared query ${name} ${n}`, factKind: "preference", status: "approved",
        provenance: [{ type: "user", id: owner.id }] }, { expectedRevision: 0, projectId });
      ids[name].push(id);
    }
  }
  return { accounts, owner, documents, service, capsule, ids };
}

test("lexical project selection precedes result limits and distinguishes omitted scope from account scope", options, async t => {
  const { owner, documents, ids, capsule } = await fixture(t);
  const filter = { capsuleId: capsule.id };
  assert.deepEqual(new Set((await documents.search(owner.id, "fact", "Shared query", { projectId: "default", limit: 2, filter })).map(row => row.id)), new Set(ids.project));
  const account = await documents.search(owner.id, "fact", "Shared query", { projectId: null, limit: 2, filter });
  assert.equal(account.length, 2); assert.ok(account.every(row => row.projectId === null));
  const all = await documents.search(owner.id, "fact", "Shared query", { limit: 100, filter });
  assert.equal(all.length, 32);
  assert.equal((await documents.search(owner.id, "fact", "Shared query", { projectId: "missing", filter })).length, 0);
  assert.equal((await documents.search("other", "fact", "Shared query", { projectId: "default", filter })).length, 0);
  assert.equal((await documents.search(owner.id, "fact", "Shared query", { projectId: "default", filter,
    any: { field: "factKind", values: ["constraint"] } })).length, 0);
  assert.equal((await documents.search(owner.id, "fact", "Shared query", { projectId: "default", filter, since: "2099-01-01T00:00:00Z" })).length, 0);
  await assert.rejects(documents.search(owner.id, "fact", "Shared query", { projectId: "bad\nproject" }), { code: "product_identifier_invalid" });
});

test("capsule entry project and metadata projection are applied inside the paged ledger query", options, async t => {
  const { owner, documents, service, capsule, ids } = await fixture(t);
  const fields = { status: true, provenance: true };
  const first = await service.entries(owner.id, capsule.id, { projectId: "default", limit: 1, fields });
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  const second = await service.entries(owner.id, capsule.id, { projectId: "default", limit: 1, fields, cursor: first.nextCursor });
  assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
  assert.deepEqual(new Set([...first.items, ...second.items].map(row => row.id)), new Set(ids.project));
  for (const row of [...first.items, ...second.items]) {
    assert.equal(row.projectId, "default");
    assert.deepEqual(Object.keys(row.payload).sort(), ["provenance", "status"]);
    assert.equal(row.payload.content, undefined, "metadata nomination does not hydrate a body");
  }
  const account = await service.entries(owner.id, capsule.id, { projectId: null, limit: 100 });
  assert.equal(account.items.length, 15); assert.ok(account.items.every(row => row.projectId === null));
  assert.equal((await service.entries(owner.id, capsule.id, { limit: 100 })).items.length, 32);
  await assert.rejects(service.entries("other", capsule.id, { projectId: "default", fields }), { code: "capsule_not_found" });
  const different = await makeCapsule(service, owner.id, { title: "Another capsule" });
  await documents.put(owner.id, "fact", "other-capsule", { capsuleId: different.id, content: "Shared query", status: "approved" }, { expectedRevision: 0, projectId: "default" });
  assert.equal((await service.entries(owner.id, capsule.id, { projectId: "default", limit: 100 })).items.length, 2);
});
