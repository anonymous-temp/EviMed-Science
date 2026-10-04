import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { test } from "node:test";
import { parsePersonalSkill } from "@evimed/harness-port/personal-skills";
import { canonicalJson } from "@evimed/domain";
import { createWebApiApp } from "../src/server.mjs";
import { HttpError } from "../src/security.mjs";
import { extensionToolArtifactDigest } from "../src/extensionToolController.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

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

/** A valid deployment file for one contained package. `policy` is the source policy the file claims to have been assessed under. */
async function writeDeployment(directory, policy) {
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const coordinate = { kind: "github", repository: "Jesse-njx/dsh-cowork", commit: "2ae5cf755c4294a1e988eebf3b12dd062425d84c" };
  const integrity = `sha256:${"a".repeat(64)}`, id = "cowork-portable";
  const descriptor = { id, coordinate, integrity, imageId: `sha256:${"b".repeat(64)}`, closureExpectedSHA: "c".repeat(64), runnerSHA: "d".repeat(64), policySHA: "e".repeat(64), inventorySHA: "f".repeat(64) };
  descriptor.adapterDigest = `sha256:${sha(canonicalJson({ runnerSHA: descriptor.runnerSHA, policySHA: descriptor.policySHA, inventorySHA: descriptor.inventorySHA }))}`;
  descriptor.artifactDigest = extensionToolArtifactDigest(descriptor);
  const manifest = { schemaVersion: 1, dshVersion: JSON.parse(await fs.readFile(new URL("../../../deps-version.json", import.meta.url), "utf8")).dsh.version,
    generatedAt: "2026-10-02T00:00:00.000Z", policy,
    catalogue: [{ id, title: "Fixture documents", coordinate, executionClass: "isolated-tool", integrity, settingsSchema: {} }],
    admittedDescriptors: [descriptor],
    admittedArtifacts: [{ id, coordinate, integrity, artifactDigest: descriptor.artifactDigest, adapterRevision: descriptor.adapterDigest, suiteRevision: `sha256:${"1".repeat(64)}` }],
    surfaces: [{ id, client: false, browser: false, externalActions: false, descriptorDigest: `sha256:${"2".repeat(64)}` }] };
  await fs.mkdir(path.join(directory, ".openscience"), { mode: 0o700 });
  await fs.writeFile(path.join(directory, ".openscience", "extensions-deployment.json"), JSON.stringify(manifest), { mode: 0o400 });
  return { id, coordinate };
}
const staleSourcePolicy = { adapterRevision: `sha256:${"3".repeat(64)}`, permissionProfileRevision: `sha256:${"4".repeat(64)}` };

test("a deployment written under other source still serves its whole catalogue, labelled stale", options, async () => {
  // Owner ruling 2026-10-04. The deployment file's policy digest covers ~90 source files, so every release made the
  // file stale, and a stale file used to be refused whole: the catalogue read 「暂无可添加的插件」. Everything that makes the
  // file an allow-list is unchanged; only the policy it was written under became a label.
  const isolated = await createGeoTestDatabase(url, "extstale");
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-extension-stale-")));
  let app;
  try {
    const { id, coordinate } = await writeDeployment(directory, staleSourcePolicy);
    app = createWebApiApp({ dataDir: directory, stateStore: "postgres", databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 500, port: 0,
      runtimeMode: "mock", devAuth: false, bootstrapUser: "extension-stale", bootstrapPassword: "local fixture password only",
      learningEnabled: false, reviewEnabled: false, frontierEnabled: false, geoEnabled: false, vcrEnabled: false,
      // A qualification record that cannot be read as a record: the reader used to answer 503 on every extension route.
      extensionProofAuthority: async () => { throw new HttpError(503, "extension_proof_untrusted", "The extension qualification record is unavailable."); } });
    const address = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "extension-stale", password: "local fixture password only" }) });
    assert.equal(login.status, 200);
    const session = await login.json();
    const auth = { Cookie: login.headers.get("set-cookie").split(";")[0], "X-Open-Science-CSRF": session.data.csrfToken, "content-type": "application/json" };
    const catalogue = await fetch(`${base}/api/extensions/catalogue`, { headers: auth });
    assert.equal(catalogue.status, 200);
    const body = (await catalogue.json()).data;
    assert.equal(body.policyState, "stale");
    assert.equal(body.items.length, 1, "the file's catalogue is served whole");
    assert.equal(body.items[0].id, id);
    assert.equal(body.items[0].evidenceState, "source-assessed");
    // And it can be used: the allow-list still admits the package, so installing it works.
    const install = await fetch(`${base}/api/extensions/installations`, { method: "POST", headers: auth, body: JSON.stringify({ coordinate, scope: "library", idempotencyKey: "stale-policy-install" }) });
    assert.equal(install.status, 201, JSON.stringify(await install.clone().json()));
    const listed = await fetch(`${base}/api/extensions/installations`, { headers: auth });
    assert.equal(listed.status, 200);
    const library = (await listed.json()).data.items[0];
    assert.equal(library.catalogueId, id);
    assert.equal(library.evidenceState, "source-assessed");
    // The unreadable record is for an operator, once: the researcher got labels above, the security ledger gets a line.
    let ledger = [];
    for (let attempt = 0; attempt < 40 && !ledger.length; attempt++) {
      const text = await fs.readFile(path.join(directory, ".openscience", "security.jsonl"), "utf8").catch(() => "");
      ledger = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.action === "extension.qualification.record");
      if (!ledger.length) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ledger.length, 1, "three reads of one unreadable record are one line, not three");
    assert.deepEqual([ledger[0].status, ledger[0].code, ledger[0].detail], ["unreadable", "extension_proof_untrusted", id]);
  } finally {
    await app?.close();
    await isolated.drop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a stale deployment composes the extension tool gateway; only a missing file leaves it unavailable", options, async () => {
  // The gateway is the runtime's way to an installed, pinned extension. It answered 503 `product_state_unavailable`
  // whenever the deployment file did not validate, a stale policy included, because the hosted integration was only
  // composed for a file that did. A stale file composes it; no file at all has no allow-list and still cannot.
  for (const scenario of [
    { name: "stale", policy: staleSourcePolicy, composed: true },
    { name: "missing", policy: null, composed: false },
  ]) {
    const isolated = await createGeoTestDatabase(url, "extgate");
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-extension-gateway-")));
    let app;
    try {
      if (scenario.policy) await writeDeployment(directory, scenario.policy);
      app = createWebApiApp({ dataDir: directory, stateStore: "postgres", databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 500, port: 0,
        modelGatewaySigningSecret: "fixture-only-model-gateway-signing-secret", runtimeMode: "kernel", devAuth: false,
        bootstrapUser: "extension-gateway", bootstrapPassword: "local fixture password only",
        learningEnabled: false, reviewEnabled: false, frontierEnabled: false, geoEnabled: false, vcrEnabled: false });
      const address = await app.listen(0, "127.0.0.1");
      assert.equal(Boolean(app.hostedExtensions), scenario.composed, scenario.name);
      const response = await fetch(`http://127.0.0.1:${address.port}/internal/extensions/v1/status`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await response.json();
      if (scenario.composed) {
        assert.equal(response.status, 401, `${scenario.name}: ${JSON.stringify(body)}`);
        assert.equal(body.code, "unauthorized", "the gateway is there and asks for the runtime's workload token");
      } else {
        assert.equal(response.status, 503, scenario.name);
        assert.equal(body.code, "product_state_unavailable");
      }
    } finally {
      await app?.close();
      await isolated.drop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});
