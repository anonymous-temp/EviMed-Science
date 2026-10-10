import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { issueModelGatewayRuntimeToken } from "../src/runtimeManager.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { projectionHash, vcrCloudDestinations } from "../src/vcrCloudProjection.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { streamOf } from "./helpers/vcrIntakeData.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

// The privacy hook on the model gateway, in the real application: the wiring `createWebApiApp` makes, with the production
// session resolver, the real run ledger and the real VCR store. Every unit test of the hook stubbed the resolver; this is
// the one that would have caught the first version of it resolving the project with the wrong identity (b4a4d7a5c), and
// the one that holds the two things the hook must do on every model call of every project (D2, 2026-10-10): cost a project
// that never touched clinical data nothing it can fail on, and still refuse a conversation that did.
test("the real application answers a project that holds no study whatever state its run ledger is in, and still refuses a conversation with a recorded clinical read", options, async (t) => {
  let sent = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    // The application probes its provider on its own schedule (a bare GET of the base address); only model calls are counted.
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) sent += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "provider-egress-fixture", choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 9, completion_tokens: 3, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 5 } }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const isolated = await createGeoTestDatabase(databaseUrl, "egress");
  const root = await mkdtemp(path.join("/tmp", "evimed-egress-app-"));
  const secret = randomBytes(32).toString("hex");
  const app = createWebApiApp({
    dataDir: root, databaseUrl: isolated.url, stateStore: "postgres", requireSharedStateStore: true,
    production: false, runtimeMode: "mock", authMode: "local", devAuth: false,
    bootstrapUser: "", bootstrapPassword: "", deepseekProviderEnabled: true,
    deepseekApiKey: "test-provider-key", deepseekBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    modelGatewaySigningSecret: secret,
    requireDurableUsageLedger: true, modelGatewayReservationMaxOutputTokens: 4096,
  });
  // Closed in the order that leaves no connection to a dropped database.
  t.after(async () => {
    await app.close();
    await isolated.drop();
    await rm(root, { recursive: true, force: true });
    await new Promise((resolve) => upstream.close(resolve));
  });
  const user = await app.store.createUser(`egress${randomUUID().slice(0, 8)}`, "test-only-egress-password", "Egress fixture");
  const project = await app.store.defaultProject(await app.store.userById(user.id));
  const jti = `fixture_${randomUUID()}`;
  const token = issueModelGatewayRuntimeToken({ secret, userId: user.id, projectId: project.id, jti });
  app.runtimeManager.activateModelGatewayRuntime(project, { modelGatewayToken: token, modelGatewayTokenJti: jti });
  const address = await app.listen(0, "127.0.0.1");
  const ask = async (sessionId) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/model/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-deepseek-harness-session-id": sessionId },
      body: JSON.stringify({ messages: [{ role: "user", content: "An ordinary question." }] }),
    });
    return { status: response.status, body: await response.text() };
  };
  const ledger = path.join(project.metaDir, "runs.jsonl");
  await mkdir(project.metaDir, { recursive: true });

  // A project that holds no study: answered, and answered with a ledger that cannot be read.
  assert.equal((await ask("session_plain")).status, 200);
  await writeFile(ledger, "this is not a run ledger\n");
  const damaged = await ask("session_plain");
  assert.equal(damaged.status, 200, damaged.body);
  assert.equal(sent, 2, "the provider was reached both times");

  // The same project, now holding a study whose conversation read a projection that no permission covers.
  const vcr = new VcrStore({ database: app.store.database });
  await vcr.ready();
  const study = await vcr.createStudy({ userId: user.id, projectId: project.id, name: "Synthetic egress fixture", question: "q", dataTier: "T0" });
  await vcr.inheritCloudDependency(study.id, "session_clinical", "run_clinical", `prj_${"b".repeat(48)}`);

  // For it an unreadable ledger is a conversation nobody can name: nothing is sent.
  const unreadable = await ask("session_unrelated");
  assert.equal(unreadable.status, 500);
  assert.match(unreadable.body, /agent_runs_corrupt/);
  assert.equal(sent, 2, "the provider saw nothing of it");

  // With the ledger readable again, a conversation of that project that read nothing goes through, and the one that did is refused.
  await rm(ledger);
  assert.equal((await ask("session_unrelated")).status, 200);
  assert.equal(sent, 3);
  const refused = await ask("session_clinical");
  assert.equal(refused.status, 403);
  assert.match(refused.body, /vcr_cloud_processing_not_authorized/);
  assert.equal(sent, 3, "and nothing of it was sent");
});

// The chain end to end, with nothing stubbed between the read and the refusal: the runtime reads a reviewed projection through the VCR
// gateway, which names the run from the run ledger (`attributeRun`, `readProducerRun`) and files the read under the conversation that
// run recorded; revoking the permission then refuses the next model call of that conversation, of its subagents (a child session is
// its parent's conversation, which only the production resolver knows), and not of an unrelated one in the same project. Every other
// test of the hook hands it `async caller => caller.sessionId`, which allows the subagent's call (E-22).
test("a projection read through the VCR gateway is filed under the conversation the run ledger names, and revoking the permission refuses that conversation and its subagents, not another's", options, async (t) => {
  const origin = "https://api.example.org";
  let sent = 0;
  const provider = async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    if (init.method === "POST" && String(url).endsWith("/chat/completions")) sent += 1;
    return new Response(JSON.stringify({ id: "provider-chain-fixture", choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 9, completion_tokens: 3, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 5 } }), { headers: { "content-type": "application/json" } });
  };
  const isolated = await createGeoTestDatabase(databaseUrl, "egresschain");
  const root = await mkdtemp(path.join("/tmp", "evimed-egress-chain-"));
  const plane = path.join(root, "plane");
  await mkdir(plane, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  const app = createWebApiApp({
    dataDir: root, databaseUrl: isolated.url, stateStore: "postgres", requireSharedStateStore: true,
    production: false, runtimeMode: "mock", authMode: "local", devAuth: false,
    bootstrapUser: "", bootstrapPassword: "", deepseekProviderEnabled: true,
    deepseekApiKey: "test-provider-key", deepseekBaseUrl: origin, modelGatewayFetch: provider,
    modelGatewaySigningSecret: secret, requireDurableUsageLedger: true, modelGatewayReservationMaxOutputTokens: 4096,
    vcrEnabled: true, vcrAudience: "all", vcrPollMs: 3_600_000, vcrDataPlaneDir: plane,
  });
  t.after(async () => {
    await app.close();
    await isolated.drop();
    await rm(root, { recursive: true, force: true });
  });
  const user = await app.store.createUser(`chain${randomUUID().slice(0, 8)}`, "test-only-chain-password", "Chain fixture");
  const project = await app.store.defaultProject(await app.store.userById(user.id));
  await mkdir(project.metaDir, { recursive: true });
  await mkdir(project.workspaceDir, { recursive: true });
  const jti = `fixture_${randomUUID()}`;
  const token = issueModelGatewayRuntimeToken({ secret, userId: user.id, projectId: project.id, jti });
  app.runtimeManager.activateModelGatewayRuntime(project, { modelGatewayToken: token, modelGatewayTokenJti: jti });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const post = async (/** @type {string} */ route, /** @type {any} */ body, /** @type {Record<string, string>} */ headers = {}) => {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.text() };
  };
  const ask = (/** @type {string} */ sessionId) => post("/internal/model/v1/chat/completions", { messages: [{ role: "user", content: "An ordinary question." }] }, { "x-deepseek-harness-session-id": sessionId });

  // A study in the project, a reviewed projection of one synthetic note, and the permission that covers the provider.
  const study = await app.vcr.store.createStudy({ userId: user.id, projectId: project.id, name: "Synthetic chain fixture", question: "q", dataTier: "T0" });
  const plan = app.vcr.dataPlane;
  const source = await plan.registerSource({ userId: user.id, studyId: study.id, name: "Synthetic notes" });
  const original = "测试姓名王小明，否认心梗史。肌酐 1.2 mg/dL。";
  const upload = await plan.storeUpload({ actor: user.id, studyId: study.id, sourceId: source.id, name: "note.txt", role: "document", subject: "CANARY-CHAIN-001", stream: streamOf(original) });
  await plan.setCloudPermission({ studyId: study.id, sourceId: source.id, actor: user.id, permission: {
    status: "approved", dataClass: "synthetic", purpose: "vcr", destinations: vcrCloudDestinations(app.config), reference: "Authored synthetic fixture", retention: "unknown", training: "unknown", humanReview: "unknown" } });
  const at = original.indexOf("王小明");
  const projection = await plan.createDocumentProjection({ studyId: study.id, documentId: upload.file.id, actor: user.id, sourceHash: projectionHash(original),
    spans: [{ start: at, end: at + 3, kind: "person" }], attestation: "Reviewed synthetic canary" });
  const read = () => post("/internal/vcr/v1/read", { what: "subject_document", filter: { subjectKey: upload.file.detail.subjectKey, documentId: projection.id } });

  // No run is running in the project: the read cannot be filed under any conversation, so it is refused and nothing was served.
  const orphan = await read();
  assert.equal(orphan.status, 403);
  assert.match(orphan.body, /vcr_cloud_run_unattributed/);
  assert.equal(JSON.parse(orphan.body).data, undefined);

  // A conversation runs in the project, as the run ledger records it, with a subagent the progress tracker knows.
  const run = (await app.agentRuns.reserveRun(project, { sessionId: "conversation-a", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null },
    { dispatchId: "dispatch-chain", baselineCursor: null })).run;
  app.agentRuns.progressTracker(run.id).children.add("child-session");

  const served = await read();
  assert.equal(served.status, 200, served.body);
  assert.equal(JSON.parse(served.body).data.available, true, served.body.slice(0, 600));
  assert.ok(!served.body.includes("王小明"), "the surrogate reached the runtime, not the name");
  const filed = await app.vcr.store.rows("SELECT session_id, run_id FROM evimed_vcr.cloud_reads WHERE study_id=$1", [study.id]);
  assert.deepEqual(filed.map((row) => [row.session_id, row.run_id]), [["conversation-a", run.id]], "filed under the conversation and the run the ledger names");

  // While the permission stands, the conversation and its subagent are answered.
  assert.equal((await ask("conversation-a")).status, 200);
  assert.equal((await ask("child-session")).status, 200);
  const answered = sent;

  // Revoked: the conversation that read it is refused, and so is the subagent working inside it; an unrelated conversation is not.
  await plan.setCloudPermission({ studyId: study.id, sourceId: source.id, actor: user.id, permission: { status: "revoked" } });
  for (const session of ["conversation-a", "child-session"]) {
    const refused = await ask(session);
    assert.equal(refused.status, 403, `${session}: ${refused.body}`);
    assert.match(refused.body, /vcr_cloud_processing_not_authorized/);
  }
  assert.equal(sent, answered, "and nothing of either was sent");
  assert.equal((await ask("unrelated-session")).status, 200);
  assert.equal(sent, answered + 1);
});
