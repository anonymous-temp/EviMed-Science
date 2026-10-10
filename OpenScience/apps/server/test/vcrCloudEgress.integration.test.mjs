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
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

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
