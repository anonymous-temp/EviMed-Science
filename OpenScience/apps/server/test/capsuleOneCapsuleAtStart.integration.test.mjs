// A database that comes from the release before holds a 「项目笔记」 capsule for every project a person's runs worked in and a list of
// packs for each project that had one. The composed app folds them into the person's one capsule when it starts (2026-10-24): once, a
// line on stderr per account, no manual step — the composition is what this holds, `capsuleOneCapsule*.test.mjs` hold the rules.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const owner = `owner${randomUUID().slice(0, 8)}`;
/** @type {any} */ let isolated, dataDir;
before(async () => { if (!databaseUrl) return; isolated = await createGeoTestDatabase(databaseUrl, "onecapstart"); dataDir = await mkdtemp(path.join(tmpdir(), "evimed-onecap-start-")); });
after(async () => { await isolated?.drop(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

test("the app folds the per-project notes capsules and lists of packs into the one capsule when it starts, once, and says so", options, async () => {
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true,
    databaseUrl: isolated.url,
  });
  const said = /** @type {string[]} */ ([]);
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = /** @type {any} */ ((chunk) => { said.push(String(chunk)); return true; });
  try {
    const user = await app.store.createUser(owner, "test-only-owner-password", "Owner");
    const db = app.store.database;
    const documents = app.capsuleService.documents;
    await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'trial-one','One',1048576),($1,'trial-two','Two',1048576) ON CONFLICT DO NOTHING", [user.id]);
    // What the release before left: a notes capsule with a note in it and a list naming it, for each of two projects, and a pack enabled for one.
    const notes = [];
    for (const [projectId, content] of [["trial-one", "回答先给结论"], ["trial-two", "表格优先"]]) {
      const capsuleId = `runtime-notes:${createHash("sha256").update(projectId).digest("hex")}`;
      await documents.put(user.id, "capsule", capsuleId, { title: "项目笔记", description: "", imported: false, activationMode: "own" }, { expectedRevision: 0, projectId });
      notes.push(await documents.put(user.id, "fact", `runtime-note:${createHash("sha256").update(JSON.stringify([capsuleId, "preference", content])).digest("hex")}`,
        { capsuleId, factKind: "preference", layer: "knowledge", content, origin: "inferred", status: "approved", provenance: [{ type: "source", id: `runtime-project:${projectId}` }], contextOnly: true },
        { expectedRevision: 0, projectId }));
      await documents.put(user.id, "preferences", `active-capsules:project:${projectId}`, { items: [{ capsuleId, mode: "own" }] }, { expectedRevision: 0, projectId });
    }
    const pack = await documents.put(user.id, "capsule", "pack-start", { title: "收到的包", description: "", imported: true, activationMode: "guest", transfer: {} }, { expectedRevision: 0 });
    const list = await documents.get(user.id, "preferences", "active-capsules:project:trial-one");
    await documents.put(user.id, "preferences", list.id, { items: [...list.payload.items, { capsuleId: pack.id, mode: "guest" }] }, { expectedRevision: list.revision });

    await app.listen(0, "127.0.0.1");
    const left = () => db.query("SELECT count(*)::int AS n FROM evimed_product.documents WHERE user_id=$1 AND deleted_at IS NULL AND ((kind='capsule' AND id LIKE 'runtime-notes:%') OR (kind='preferences' AND id LIKE 'active-capsules:project:%'))", [user.id]);
    for (let waited = 0; waited < 100 && (await left()).rows[0].n > 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await left()).rows[0].n, 0, "no per-project capsule or list is left in force");
    const own = await app.capsuleService.ownCapsule(user.id);
    assert.ok(own && String(own.id).startsWith("account-capsule:"));
    for (const [index, projectId] of ["trial-one", "trial-two"].entries()) {
      const moved = await documents.get(user.id, "fact", notes[index].id);
      assert.equal(moved.payload.capsuleId, own.id);
      assert.equal(moved.projectId, projectId);
    }
    assert.deepEqual((await app.capsuleService.active(user.id)).items.map((item) => [item.capsuleId === own.id ? "own" : item.capsuleId, item.mode]), [["own", "own"], [pack.id, "guest"]]);
    assert.ok(said.some((line) => new RegExp(`capsule one-capsule: user=${user.id} notes_capsules=2 entries=2 lists=2 left=0`).test(line)), `said on stderr: ${said.join("|")}`);
  } finally {
    process.stderr.write = write;
    await app.close();
  }
});
