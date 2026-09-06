import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { withAccountExportSnapshot } from "../src/accountExport.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 15000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

function tarEntries(compressed) {
  const buffer = gunzipSync(compressed);
  const entries = new Map();
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, "").trim() || "0", 8);
    entries.set(prefix ? `${prefix}/${name}` : name, buffer.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function fixture(t) {
  const dataDir = await mkdtemp("/tmp/evimed-account-export-");
  const app = createWebApiApp({ dataDir, stateStore: "postgres", databaseUrl, runtimeMode: "mock", authMode: "local", devAuth: false,
    bootstrapUser: "", bootstrapPassword: "", requireMemos: false, requireMemoryIndex: false, memOsEngineUrl: "" });
  const users = [];
  t.after(async () => {
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [users]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const documents = new ProductDocuments(app.store.database);
  const notifications = new NotificationService(app.store.database);
  for (const label of ["owner", "other"]) {
    const id = `export${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await app.store.createUser(id, "test-only-export-password", label);
    users.push(id);
    const user = await app.store.userById(id);
    const project = await app.store.defaultProject(user);
    await writeFile(path.join(project.workspaceDir, "customer.md"), `${label} workspace content`);
    await app.store.putResearchSession(project, { sessionId: `session-${label}`, mode: "open-domain", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await documents.put(id, "capsule", "capsule-one", { title: `${label} capsule`, imported: false }, { expectedRevision: 0 });
    await documents.put(id, "fact", "fact-one", { capsuleId: "capsule-one", content: `${label} original fact`, status: "approved" }, { expectedRevision: 0 });
    await documents.put(id, "fact", "fact-one", { capsuleId: "capsule-one", content: `${label} corrected fact`, status: "approved" }, { expectedRevision: 1 });
    await documents.put(id, "source", "source-one", { title: `${label} paper`, paths: ["customer.md"], fingerprint: { sha256: "a".repeat(64), size: 10 } }, { expectedRevision: 0, projectId: "default" });
    await documents.put(id, "source-unit", "unit-one", { sourceId: "source-one", content: `${label} preserved excerpt` }, { expectedRevision: 0, projectId: "default" });
    await documents.put(id, "agenda", "agenda-one", { title: `${label} agenda`, enabled: false }, { expectedRevision: 0, projectId: "default" });
    await documents.put(id, "digest", "digest-one", { agendaId: "agenda-one", claims: [{ statement: `${label} digest finding` }], openedAt: null }, { expectedRevision: 0, projectId: "default" });
    await documents.put(id, "preferences", "active-capsules:account", { items: [{ capsuleId: "capsule-one", mode: "own" }] }, { expectedRevision: 0 });
    await documents.put(id, "price-list", "operator-price", { providerSecret: "excluded-operator-provider-secret" }, { expectedRevision: 0 });
    await notifications.create(id, { id: `notice-${id}`, projectId: "default", noticeType: "notify", priority: 1, title: `${label} notice`, body: `${label} inbox body`, actions: [] });
    await notifications.preferences(id);
    await app.store.database.query(`INSERT INTO evimed_product.jobs(id,user_id,project_id,kind,payload,idempotency_key,worker_id,lease_token,run_after)
      VALUES ($1,$2,'default','notify','{"credential":"excluded-job-credential"}'::jsonb,$1,'excluded-worker','excluded-lease', '2100-01-01')`, [`job-${id}`, id]);
  }
  await migrateUsageLedger(app.store.database);
  for (const id of users) await app.store.database.query(`INSERT INTO evimed_usage.model_requests
    (id,user_id,project_id,run_id,model,price_version,currency,request_fingerprint,status,reserved_cost,actual_cost,priced,
     cache_hit_tokens,cache_miss_tokens,output_tokens,provider_request_id,reservation_expires_at,created_at,settled_at)
    VALUES ($1,$2,'default','run-one','test-model','price-v1','CNY',$3,'settled',1,0.25,true,5,7,9,'excluded-provider-request-id',now(),now(),now())`,
  [`usage-${id}`, id, "b".repeat(64)]);
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: users[0], password: "test-only-export-password" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const auth = await login.json();
  return { app, base, owner: users[0], other: users[1], documents, cookie, csrf: auth.data.csrfToken };
}

test("account export includes the owner's PostgreSQL customer state and revisions without other accounts or credentials", options, async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/api/account/export`, { headers: { cookie: f.cookie } });
  assert.equal(response.status, 200);
  const entries = tarEntries(Buffer.from(await response.arrayBuffer()));
  const data = entries.get("account/customer-state.json");
  assert.ok(data, "PostgreSQL customer state must be part of the actual account archive");
  const state = JSON.parse(data.toString());
  assert.equal(state.version, 1);
  assert.equal(state.account.id, f.owner);
  assert.equal(state.documents.find(row => row.kind === "fact").payload.content, "owner corrected fact");
  assert.ok(state.revisions.some(row => row.kind === "fact" && row.revision === 1 && row.payload.content === "owner original fact"));
  for (const kind of ["capsule", "source", "source-unit", "agenda", "digest", "preferences"]) assert.ok(state.documents.some(row => row.kind === kind), kind);
  assert.equal(state.researchSessions[0].sessionId, "session-owner");
  assert.equal(state.inbox.notifications[0].body, "owner inbox body");
  assert.deepEqual(state.inbox.preferences.channels, ["in-app"]);
  assert.equal(state.usage[0].actualCost, "0.25000000");
  assert.equal(entries.get("projects/default/workspace/customer.md").toString(), "owner workspace content");
  const serialized = [...entries.values()].map(value => value.toString()).join("\n");
  for (const forbidden of [f.other, "other original fact", "excluded-operator-provider-secret", "excluded-provider-request-id", "excluded-job-credential", "excluded-lease", "excluded-worker", f.cookie, f.csrf,
    "password_hash", "passwordHash", "csrf_token", "request_fingerprint", "lease_token", "worker_id"]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

async function authenticatedGeneration(f) {
  const row = (await f.app.store.database.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [f.owner])).rows[0];
  return { id: f.owner, accountCreatedAt: row.generation };
}

test("an old authenticated account cannot export a same-id replacement's state", options, async t => {
  const f = await fixture(t);
  const db = f.app.store.database;
  const ensureUser = f.app.store.ensureUser.bind(f.app.store);
  f.app.store.ensureUser = async (...args) => {
    const user = await ensureUser(...args);
    await db.query("DELETE FROM evimed_control.users WHERE id=$1", [f.owner]);
    await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Replacement','development')", [f.owner]);
    await f.documents.put(f.owner, "capsule", "replacement-private", { title: "new account private data" }, { expectedRevision: 0 });
    return user;
  };
  const response = await fetch(`${f.base}/api/account/export`, { headers: { cookie: f.cookie } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "account_export_account_changed");
});

test("documents, revisions and usage share one PostgreSQL snapshot while the account deletion row stays locked", options, async t => {
  const f = await fixture(t);
  const db = f.app.store.database;
  const user = await authenticatedGeneration(f);
  let changed = false;
  const observed = Object.create(db);
  observed.transaction = operation => db.transaction(client => operation({ query: async (sql, values) => {
    const result = await client.query(sql, values);
    if (!changed && sql.startsWith("SELECT count(*)") && sql.includes("FROM evimed_product.documents")) {
      changed = true;
      await f.documents.put(f.owner, "fact", "fact-one", { capsuleId: "capsule-one", content: "concurrently changed", status: "approved" }, { expectedRevision: 2 });
      await db.query("UPDATE evimed_usage.model_requests SET actual_cost=0.5 WHERE user_id=$1", [f.owner]);
    }
    return result;
  } }));
  let state;
  await withAccountExportSnapshot(observed, user, f.app.config, async snapshot => {
    state = JSON.parse(snapshot.data.toString());
    await assert.rejects(db.transaction(client => client.query("SELECT id FROM evimed_control.users WHERE id=$1 FOR UPDATE NOWAIT", [f.owner])), { code: "55P03" });
  });
  assert.equal(changed, true);
  assert.equal(state.documents.find(row => row.kind === "fact").payload.content, "owner corrected fact");
  assert.equal(state.revisions.filter(row => row.kind === "fact").length, 2);
  assert.equal(state.usage[0].actualCost, "0.25000000");
  assert.equal((await f.documents.get(f.owner, "fact", "fact-one")).payload.content, "concurrently changed");
  await db.transaction(client => client.query("SELECT id FROM evimed_control.users WHERE id=$1 FOR UPDATE NOWAIT", [f.owner]));
});

test("customer-state row and byte caps reject complete exports instead of returning truncated pages", options, async t => {
  const f = await fixture(t);
  const user = await authenticatedGeneration(f);
  for (const limits of [{ maxRows: 2 }, { maxBytes: 512 }]) {
    let collected = false;
    await assert.rejects(withAccountExportSnapshot(f.app.store.database, user, f.app.config, async () => { collected = true; }, limits), { code: "archive_too_large" });
    assert.equal(collected, false);
  }
  const response = await fetch(`${f.base}/api/account/export`, { headers: { cookie: f.cookie } });
  assert.equal(response.status, 200);
  const entries = tarEntries(Buffer.from(await response.arrayBuffer()));
  const total = [...entries.values()].reduce((sum, value) => sum + value.length, 0);
  f.app.config.maxArchiveBytes = total - 1;
  const exceeded = await fetch(`${f.base}/api/account/export`, { headers: { cookie: f.cookie } });
  assert.equal(exceeded.status, 413);
  assert.equal((await exceeded.json()).code, "archive_too_large");
  f.app.config.maxArchiveBytes = 1024 * 1024;
  f.app.config.maxArchiveEntries = entries.size - 1;
  assert.equal((await fetch(`${f.base}/api/account/export`, { headers: { cookie: f.cookie } })).status, 413);
});

test("reserved plugin data is neither silently discarded nor exported without a customer settings contract", options, async t => {
  const f = await fixture(t);
  await f.documents.put(f.owner, "plugin", "unknown-settings", { label: "Unspecified settings", privateKey: "must-not-leak" }, { expectedRevision: 0 });
  const response = await fetch(`${f.base}/api/account/export`, { headers: { cookie: f.cookie } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "account_export_unsupported_state");
});

test("account export includes only approved plugin config history and excludes runtime observations", options, async t => {
  const f = await fixture(t);
  const user = await f.app.store.userById(f.owner);
  const project = await f.app.store.requireProject(user, "default");
  await f.app.pluginService.save(user, project, { expectedRevision: 0, enabled: true, settings: { timeoutMs: 4000 } });
  await f.app.pluginService.save(user, project, { expectedRevision: 1, enabled: false, settings: { timeoutMs: 5000 } });
  const response = await fetch(`${f.base}/api/account/export`, { headers: { cookie: f.cookie } });
  assert.equal(response.status, 200);
  const state = JSON.parse(tarEntries(Buffer.from(await response.arrayBuffer())).get("account/customer-state.json").toString());
  assert.deepEqual(state.documents.find(row => row.kind === "plugin").payload, {
    schemaVersion: 1, pluginId: "dsh-cite", binaryVersion: "0.3.2", enabled: false, settings: { timeoutMs: 5000 },
  });
  assert.deepEqual(state.revisions.filter(row => row.kind === "plugin").map(row => row.payload.settings.timeoutMs), [4000, 5000]);
  assert.ok(!JSON.stringify(state).includes("runtime_generation"));
});

test("source understanding, captures and method history export through their public projections", options, async t => {
  const f = await fixture(t);
  const run = { id: "run-source", sessionId: "session-source", dispatchId: "dispatch-source",
    workspaceName: "private-source-workspace", artifactDirectory: "private-source-directory" };
  const source = await f.documents.get(f.owner, "source", "source-one");
  await f.documents.put(f.owner, "source", source.id, { ...source.payload, generation: 1,
    analysis: { generation: 1, phase: "complete", run }, pendingRunCancellations: [run],
  }, { expectedRevision: source.revision, projectId: "default" });
  const unit = { id: "unit-source", unitType: "chunk", start: 0, end: 8, text: "Evidence", status: "extracted", privatePath: "private-unit-file" };
  const method = { id: "method-one", title: "Record evidence", description: "Retain source evidence.", whenToUse: "When indexing.",
    steps: ["Record evidence"], checks: [], pitfalls: [], evidence: [], status: "draft", privatePath: "private-method-file" };
  const output = { schemaVersion: 1, sourceId: source.id, generation: 1, docType: "note-memo", depth: "deep",
    summary: "Evidence is preserved.", slots: {}, claims: [], methods: [method],
    omissionAudit: { status: "not_run", reason: "Not audited", omissionRate: null }, privatePath: "private-output-file" };
  const knowledge = { recordType: "source-understanding", sourceId: source.id, generation: 1, output, run,
    usage: { currency: "CNY", providerId: "deepseek", modelId: "deepseek-v4-pro", actualCost: 0.12, inputTokens: 13, outputTokens: 17, providerRequestId: "private-provider-request" },
    units: [unit] };
  await f.documents.put(f.owner, "knowledge", "understanding-one", knowledge, { expectedRevision: 0, projectId: "default" });
  await f.documents.put(f.owner, "knowledge", "understanding-one", { ...knowledge, output: { ...output, summary: "Revised evidence." } }, { expectedRevision: 1, projectId: "default" });
  await f.documents.put(f.owner, "knowledge", "capture-one", { recordType: "source-capture", sourceId: source.id, generation: 1, unit, privateLease: "private-capture-lease" }, { expectedRevision: 0, projectId: "default" });
  await f.documents.put(f.owner, "source-unit", "unit-source", { sourceId: source.id, generation: 1, unit }, { expectedRevision: 0, projectId: "default" });
  await f.documents.put(f.owner, "method", "source-method", { recordType: "source-method", sourceId: source.id, generation: 1, method, run }, { expectedRevision: 0, projectId: "default" });
  const response = await fetch(`${f.base}/api/account/export`, { headers: { cookie: f.cookie } });
  assert.equal(response.status, 200);
  const state = JSON.parse(tarEntries(Buffer.from(await response.arrayBuffer())).get("account/customer-state.json").toString());
  const result = state.documents.find(row => row.id === "understanding-one").payload;
  assert.equal(result.summary, "Revised evidence.");
  assert.equal(result.usage.inputTokens, 13);
  assert.equal(result.run.id, "run-source");
  assert.equal(state.documents.find(row => row.id === "unit-source").payload.unit.text, "Evidence");
  assert.deepEqual(state.revisions.filter(row => row.id === "understanding-one").map(row => row.payload.summary), ["Evidence is preserved.", "Revised evidence."]);
  assert.equal(state.documents.find(row => row.id === "source-method").payload.method.status, "draft");
  assert.equal(JSON.stringify(state).includes("private-"), false);
});
