import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import pg from "pg";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { SkillLibraryService } from "../src/skillLibraryService.mjs";
import { SkillLibraryArtifacts } from "../src/skillLibraryArtifacts.mjs";
import { createSkillLibraryRoutes } from "../src/skillLibraryRoutes.mjs";
import { removePrivateExtensionFiles } from "../src/extensionPrivateCleanup.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/);
}
test("a delayed authenticated upload and old account epoch cannot recreate purged private state", {
  skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const name = `evimed_test_skill_lifetime_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-skill-lifetime-")));
  const isolated = new URL(url); isolated.pathname = `/${name}`;
  let database;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    database = new ControlPlaneDatabase({ databaseUrl: isolated.href, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 });
    await migrateProductStore(database);
    const owner = { id: `lifetime_${randomUUID()}`, accountCreatedAt: "2026-01-01 00:00:00+00" };
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type,created_at) VALUES($1,'Lifetime fixture','development',$2)", [owner.id, owner.accountCreatedAt]);
    const library = path.join(root, ".openscience", "skill-library"), generations = path.join(root, ".openscience", "personal-skill-generations");
    await fs.mkdir(library, { recursive: true });
    const artifacts = new SkillLibraryArtifacts({ root: library, sharedStorageRoot: generations, parseSkill: null, minFreeBytes: 0,
      withStorageAdmission: (work, client) => {
        const admit = async held => { await held.query("SELECT pg_advisory_xact_lock(hashtext('evimed-personal-skill-storage'))"); return work(); };
        return client ? admit(client) : database.transaction(admit);
      },
    });
    const service = new SkillLibraryService(database, { artifacts });
    const first = await service.upload(owner, "skill", Buffer.from("original raw input"));
    assert(first.resourceId, "the absent generation namespace is zero usage on first upload");
    let authenticated;
    const entered = new Promise(resolve => { authenticated = resolve; });
    const routes = createSkillLibraryRoutes({ store: {
      ensureSessionUser: async () => { authenticated(); return { user: owner }; }, assertCsrf: async () => {},
    }, service, maxJsonBytes: 65536 });
    const req = Object.assign(new PassThrough(), { method: "POST", url: "/api/skills/uploads?kind=skill", headers: { "content-type": "application/octet-stream" } });
    const response = { setHeader() {}, writeHead() {}, end() { assert.fail("a removed account must not receive an accepted upload"); } };
    const pending = routes(req, response);
    // Observe rejection immediately to avoid an unhandled-rejection race.
    const refused = assert.rejects(pending, { status: 401, code: "unauthorized" });
    await entered;
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner.id]);
    await removePrivateExtensionFiles(root, owner.id);
    req.end("delayed private bytes"); await refused;
    const ownerRoot = path.join(library, createHash("sha256").update(owner.id).digest("hex"));
    await assert.rejects(fs.stat(ownerRoot), { code: "ENOENT" });
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Recreated fixture','development')", [owner.id]);
    for (const operation of [
      () => service.upload(owner, "skill", Buffer.from("stale bytes")),
      () => service.import(owner, { resourceId: first.resourceId, title: "Stale import" }),
      () => service.create(owner, { expectedRevision: 0, title: "Stale skill", description: "Fixture", instructions: "Stale instruction" }),
      () => service.saveDefaults(owner, { expectedRevision: 0, skills: [] }),
      () => service.list(owner),
    ]) await assert.rejects(operation(), { status: 401, code: "unauthorized" });
    await assert.rejects(fs.stat(ownerRoot), { code: "ENOENT" });
    const current = (await database.query('SELECT id,created_at::text AS "accountCreatedAt" FROM evimed_control.users WHERE id=$1', [owner.id])).rows[0];
    assert((await service.upload(current, "skill", Buffer.from("new account input"))).resourceId);
  } finally {
    await database?.close(); await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end();
    await fs.rm(root, { recursive: true, force: true });
  }
});
