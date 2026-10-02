import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { test } from "node:test";
import { parsePersonalSkill } from "@evimed/harness-port/personal-skills";
import { createWebApiApp } from "../src/server.mjs";
import { HttpError } from "../src/security.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("actual hosted API binds library, native parsing, PostgreSQL CAS and CSRF without certifying a runtime installation", options, async () => {
  const isolated = `evimed_test_extension_http_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-extension-http-")));
  const database = new URL(url); database.pathname = `/${isolated}`;
  let app;
  try {
    await admin.query(`CREATE DATABASE "${isolated}"`);
    const validated = [];
    app = createWebApiApp({ dataDir: directory, stateStore: "postgres", databaseUrl: database.href, databasePoolMax: 1, databaseConnectionTimeoutMs: 500, port: 0,
      runtimeMode: "mock", devAuth: false, bootstrapUser: "extension-fixture", bootstrapPassword: "local fixture password only",
      learningEnabled: false, reviewEnabled: false, frontierEnabled: false, geoEnabled: false, vcrEnabled: false,
      extensionCatalogue: [{ id: "fixture-documents", title: "Fixture document tools", coordinate: { kind: "npm", name: "fixture-documents", version: "1.0.0" }, executionClass: "isolated-tool", integrity: `sha256:${"1".repeat(64)}` }],
      // This is an explicitly fake controller transport; the SDK parser and database are real. Docker containment has its own suite.
      skillValidationController: { async validatePersonalSkill(reference) {
        assert.deepEqual(Object.keys(reference).sort(), ["contentId", "expectedName", "kind", "ownerHash"]);
        assert.match(reference.ownerHash, /^[a-f0-9]{64}$/); assert.match(reference.contentId, /^[a-f0-9]{64}$/);
        assert(["imports", "packages"].includes(reference.kind)); validated.push(reference);
        return parsePersonalSkill(path.join(directory, ".openscience", "skill-library", reference.ownerHash, reference.kind, reference.contentId), {
          ...(reference.expectedName == null ? {} : { expectedName: reference.expectedName }),
        });
      } },
    });
    const address = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "extension-fixture", password: "local fixture password only" }) });
    assert.equal(login.status, 200);
    const session = await login.json();
    const auth = { Cookie: login.headers.get("set-cookie").split(";")[0], "X-Open-Science-CSRF": session.data.csrfToken };
    const request = async (route, method = "GET", body = undefined, expected = 200) => {
      const response = await fetch(base + route, { method, headers: { ...auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, expected, value.code); return value.data;
    };
    assert.equal((await fetch(`${base}/api/skills`)).status, 401);
    assert.equal((await fetch(`${base}/api/skills`, { method: "POST", headers: { Cookie: auth.Cookie, "content-type": "application/json" }, body: "{}" })).status, 403);
    const catalogue = await request("/api/extensions/catalogue"); assert.equal(catalogue.items[0].evidenceState, "source-assessed");
    const install = await request("/api/extensions/installations", "POST", { coordinate: catalogue.items[0].coordinate, scope: "library", idempotencyKey: "http-install1" }, 201);
    assert.equal(install.installation.effective, false); assert(install.job.id);
    const projectIntent = { coordinate: catalogue.items[0].coordinate, scope: "project", projectId: "default", idempotencyKey: "http-project-install" };
    const projectInstall = await request("/api/extensions/installations", "POST", projectIntent, 201);
    assert.equal(projectInstall.installation.effective, false);
    const retried = await request("/api/extensions/installations", "POST", projectIntent, 201);
    assert.equal(retried.job.id, projectInstall.job.id, "retry keeps the single project-scoped preparation job");
    const extensionSelection = await request("/api/projects/default/extensions");
    assert.equal(extensionSelection.selections[0].installationId, projectInstall.installation.id);
    const actorId = session.data.user.id, storedActor = await app.store.userById(actorId);
    await app.store.database.transaction(async client => {
      const partial = await app.extensionService.access.project({ id: actorId }, "default", { manage: true, client });
      assert.equal(partial.userRoot, storedActor.rootDir, "background jobs hydrate their actor inside the checked transaction");
      const forged = await app.extensionService.access.project({ id: actorId, rootDir: "/caller-supplied-root" }, "default", { client });
      assert.equal(forged.userRoot, storedActor.rootDir, "caller or job metadata cannot select a filesystem root");
    });
    const content = { expectedRevision: 0, title: "My method", description: "Check supplied material", instructions: "Preserve all source quotations." };
    const skill = await request("/api/skills", "POST", content, 201);
    assert.equal(validated.length, 1); assert.equal(skill.payload.prepared, true); assert.equal(skill.payload.instructions, content.instructions);
    await request(`/api/skills/${encodeURIComponent(skill.id)}`, "PUT", { ...content, expectedRevision: 0, instructions: "Stale data" }, 409);
    assert.equal(validated.length, 1, "stale requests must not invoke preparation");
    await request("/api/projects/default/skills", "PUT", { expectedRevision: 0, skills: [{ skillId: skill.id, revision: 1 }] });
    const selection = await request("/api/projects/default/skills"); assert.equal(selection.payload.skills[0].digest, skill.payload.digest);
    // No actual native session dispatcher is supplied here; do not turn the saved project intent into a fake invocation.
    await request(`/api/projects/default/skills/${encodeURIComponent(skill.id)}/invoke`, "POST", { revision: 1, sessionId: "fixture-session", idempotencyKey: "fixture-invoke" }, 503);
    const uploaded = await fetch(`${base}/api/skills/uploads?kind=skill`, { method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: "---\nname: imported-native\ndescription: Upload\n---\n\nRead this source.\n" });
    assert.equal(uploaded.status, 201); const resourceId = (await uploaded.json()).data.resourceId;
    const beforePreview = (await request("/api/skills")).items.length;
    const preview = await request("/api/skills/import-preview", "POST", { resourceId });
    assert.equal(preview.instructions, "Read this source.");
    assert.equal((await request("/api/skills")).items.length, beforePreview, "preview cannot create a library record or project activation");
    const imported = await request("/api/skills/import", "POST", { resourceId, title: "Imported method" }, 201);
    assert.equal(imported.payload.instructions, "Read this source.");
    await request(`/api/skills/uploads/${encodeURIComponent(resourceId)}`, "DELETE", {});
    assert.equal((await request(`/api/skills/${encodeURIComponent(imported.id)}`)).payload.instructions, "Read this source.");
    const service = app.skillLibraryService;
    service.onRemoved = async (user, id) => {
      assert(service.database.transactionScope(), "removal callbacks borrow the checked-out transaction at pool one");
      assert.equal(await service.documents.get(user.id, "skill", id), null);
      throw new HttpError(503, "product_state_unavailable", "Test-only generation outbox failure.");
    };
    await request(`/api/skills/${encodeURIComponent(imported.id)}`, "DELETE", { expectedRevision: 1 }, 503);
    assert.equal((await request(`/api/skills/${encodeURIComponent(imported.id)}`)).revision, 1, "failed reconciliation must retain the library record");
    service.onRemoved = async (user, id) => {
      await service.documents.put(user.id, "extension-generation", "fixture-removal", { skillId: id }, { expectedRevision: 0, projectId: "default" });
    };
    await request(`/api/skills/${encodeURIComponent(imported.id)}`, "DELETE", { expectedRevision: 1 });
    await request(`/api/skills/${encodeURIComponent(imported.id)}`, "GET", undefined, 404);
  } finally {
    await app?.close();
    await admin.query(`DROP DATABASE IF EXISTS "${isolated}" WITH (FORCE)`);
    await admin.end(); await fs.rm(directory, { recursive: true, force: true });
  }
});
