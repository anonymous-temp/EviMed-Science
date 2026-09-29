import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { frontmatter, BODY } from "./helpers/handbookFixture.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
test("actual application consumes a reviewed lesson and sends its exact receipt through authenticated dispatch", { skip: !databaseUrl }, async () => {
  const database = await createGeoTestDatabase(databaseUrl, "hbapp");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-handbook-app-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl: database.url,
    learningEnabled: true, learningWindow: "", evimedWorkloadSigningSecret: randomBytes(32).toString("hex"),
    researchMemory: { configured: false, async status() { return { configured: false }; } } });
  try {
    const address = await app.listen(0, "127.0.0.1");
    await app.learningWorker.close();
    const user = await app.store.createUser("handbook-owner", "test-password", "Handbook owner");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "handbook-owner", password: "test-password" }) });
    assert.equal(login.status, 200);
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken };
    const agents = (await (await fetch(`${base}/api/agents`, { headers })).json()).data;
    const selected = agents.find((agent) => agent.id === "statistical-analysis");
    assert.ok(selected, "the actual generated registry loads the new optional-output capability");
    await app.researchSessions.put(project, "source-session", { mode: "specialist", agentId: selected.id, agentVersion: selected.version });
    const source = await app.agentRuns.dispatch(project, { sessionId: "source-session", dispatchId: "source-dispatch", question: "Test source" }, async () => {});
    const learning = app.runtimeManager.learningService;
    const candidate = await learning.recordHandbookCandidate(user.id, { frontmatter, body: BODY, capabilityId: selected.id,
      provenance: { runId: source.id, sourceProjectId: project.id, derivedFrom: "reviewer" } });
    const db = app.store.database;
    const jobRow = await db.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'candidateId'=$2", [user.id, candidate.id]);
    await db.query("UPDATE evimed_product.jobs SET status='running', lease_token='test-lease', lease_expires_at=clock_timestamp()+interval '1 minute' WHERE user_id=$1 AND id=$2", [user.id, jobRow.rows[0].id]);
    const job = await learning.jobs.get(user.id, jobRow.rows[0].id);
    const applied = await app.learningWorker.consolidation.run({ job });
    assert.equal(applied.disposition, "applied");
    assert.equal(applied.verification, "unmeasured");
    const bind = await fetch(`${base}/api/research-sessions/next-session`, { method: "PUT", headers,
      body: JSON.stringify({ mode: "specialist", agentId: selected.id, agentVersion: selected.version }) });
    assert.equal(bind.status, 200);
    app.memorySubstrate.recall = async () => [];
    await app.runtimeManager.start(project);
    let prompt;
    app.runtimeManager.dispatchPrompt = async (_project, _session, input) => { prompt = input; return { accepted: true }; };
    const response = await fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers,
      body: JSON.stringify({ sessionId: "next-session", dispatchId: "next-dispatch", text: "Analyze the supplied data and preserve its denominators." }) });
    assert.equal(response.status, 202, await response.text());
    const run = (await app.agentRuns.list(project)).find((item) => item.dispatchId === "next-dispatch");
    assert.equal(run.capabilityHandbooks.length, 1);
    assert.equal(run.capabilityHandbooks[0].contentDigest, candidate.payload.contentDigest);
    assert.match(prompt.system, /Keep denominators tied/);
    assert.match(await readFile(path.join(project.workspaceDir, run.capabilityHandbooks[0].path), "utf8"), /## Workflow/);
    await app.learningWorker.maintain();
    assert.equal((await learning.documents.get(user.id, "method", applied.handbookId)).payload.verification, "unmeasured");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await database.drop();
  }
});

test("native HTTP inputs consume their frozen handbook revision through the socket and enter the adopted run ledger", { skip: !databaseUrl }, async () => {
  const { apply: applyCapsule } = await import("../../../packages/socket/plugins/capsule.mjs");
  const { normalizeTranscript, transcriptToLedgerMessages } = await import("../src/dshRuntimeAdapter.mjs");
  const database = await createGeoTestDatabase(databaseUrl, "hbnative");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-handbook-native-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl: database.url,
    learningEnabled: true, learningWindow: "", evimedWorkloadSigningSecret: randomBytes(32).toString("hex"),
    runtimeUiProxyEnabled: true, runtimeUiPort: 0, publicUrl: "https://science.example", runtimeUiPublicOrigin: "https://science.example:8443",
    researchMemory: { configured: false, async status() { return { configured: false }; } } });
  try {
    const address = await app.listen(0, "127.0.0.1"); await app.learningWorker.close(); app.agentRuns.scheduleMonitor = () => {};
    const user = await app.store.createUser("native-owner", "test-password", "Native owner");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "native-owner", password: "test-password" }) });
    const auth = await login.json(); const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", cookie, "x-open-science-csrf": auth.data.csrfToken };
    const selected = (await app.agentRegistry).get("statistical-analysis");
    await app.researchSessions.put(project, "source-session", { mode: "specialist", agentId: selected.id, agentVersion: selected.version });
    await app.researchSessions.put(project, "native-session", { mode: "specialist", agentId: selected.id, agentVersion: selected.version });
    const source = await app.agentRuns.dispatch(project, { sessionId: "source-session", dispatchId: "source-dispatch", question: "Source" }, async () => {});
    const learning = app.runtimeManager.learningService;
    const applyLesson = async body => {
      const candidate = await learning.recordHandbookCandidate(user.id, { frontmatter, body, capabilityId: selected.id, provenance: { runId: source.id, sourceProjectId: project.id } });
      const row = await app.store.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'candidateDigest'=$2", [user.id,candidate.payload.contentDigest]);
      await app.store.database.query("UPDATE evimed_product.jobs SET status='running',lease_token='fixture-lease',lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1", [row.rows[0].id]);
      await app.learningWorker.consolidation.run({ job: await learning.jobs.get(user.id,row.rows[0].id) });
      return candidate.payload.contentDigest;
    };
    const digestA = await applyLesson(BODY);
    await app.runtimeManager.start(project);
    const runtime = app.runtimeManager.runtimes.get(app.runtimeManager.key(project));
    const frameResponse = await fetch(`${base}/api/runtime-ui/frames`, { method: "POST", headers, body: JSON.stringify({ projectId: project.id }) });
    assert.equal(frameResponse.status, 201);
    const frame = (await frameResponse.json()).data;
    const framePath = new URL(frame.frameUrl).pathname.replace(/\/$/, "");
    const nativeBase = `http://127.0.0.1:${app.runtimeUi.address().port}${framePath}`;
    const browserHeaders = { "content-type": "application/json", cookie: `${cookie}; ${frameResponse.headers.get("set-cookie").split(";")[0]}`, origin: app.config.runtimeUiPublicOrigin };
    const forwarded = [];
    app.runtimeManager.proxy = async (req,res) => { forwarded.push(req.__openScienceProxyBody.toString("utf8")); res.writeHead(200); res.end("{}"); };
    const prompt = id => ({ type: "client-request", rpcId: `transport-${id}`, method: "session/prompt", payload: { args: { request: {
      requestId: id, sessionId: "native-session", mode: "queue", content: [{ type: "text", text: `Analyze data for ${id}` }],
    } } } });
    const send = async id => { const body = JSON.stringify(prompt(id)); assert.equal((await fetch(`${nativeBase}/api/session/prompt`, { method: "POST", headers: browserHeaders, body })).status, 200); assert.equal(forwarded.at(-1), body); };
    await send("A"); const digestB = await applyLesson(`${BODY}\nRevision B only.`); await send("B");
    const hooks = new Map();
    const ctx = { effect: fn => fn(), on: (event,handler) => { const previous = hooks.get(event); hooks.set(event, previous ? (payload,next) => handler(payload,()=>previous(payload,next)) : handler); return ()=>{}; },
      provide: ()=>{}, get: key => key === "fs" ? { resolve: async (relative,{cwd}) => path.resolve(cwd,relative), readText: file => readFile(file,"utf8") } : undefined,
      tools: { register: ()=>()=>{} }, systemPrompt: { section: ()=>()=>{} } };
    await applyCapsule(ctx, { methodsDir: "", recallUrl: `${base}/internal/capsules/v1`, tokenFile: runtime.workloadTokenFile, recallTimeoutMs: 1000 });
    const input = id => ({ role: "user", source: { kind: "user", rpcId: id }, content: prompt(id).payload.args.request.content });
    const enter = async (id,turn) => { const payload = { agent: { id: "agent", session: { id: "native-session", header: {} }, inject: ()=>assert.fail("must enter this step") }, turn,step:1,messages:[input(id)] };
      return hooks.get("agent/pre-step")(payload,async()=>({kind:"enter",messages:payload.messages})); };
    const decisionA = await enter("A",1);
    const textA = decisionA.messages.map(message=>message.content?.map(part=>part.text??"").join(" ")).join("\n");
    assert.match(textA,/Keep denominators tied/); assert.doesNotMatch(textA,/Revision B only/);
    const now = Date.now(); let events = [{ type:"turn/start",seq:1,time:now,data:{turn:1} },{type:"user/message",seq:2,time:now+1,data:input("A")}];
    app.runtimeManager.sessionTranscript = async()=>normalizeTranscript("native-session",events);
    app.agentRuns.readSessionHistory = async()=>transcriptToLedgerMessages(normalizeTranscript("native-session",events));
    app.agentRuns.readSessionStatus = async()=>"busy";
    await app.runtimeEventPump.adoptSession(project,"native-session");
    const runA = (await app.agentRuns.list(project)).find(run=>run.kernelRequestIds?.includes("A"));
    assert.equal(runA.capabilityHandbooks[0].contentDigest,digestA);
    assert.equal(runA.capabilityHandbooks[0].requestId,"A");
    const decisionB = await enter("B",2);
    assert.match(decisionB.messages.at(-1).content[0].text,/Revision B only/);
    events = [...events,{type:"turn/end",seq:3,time:now+2,data:{turn:1,reason:{kind:"succeeded"}}}, {type:"turn/start",seq:4,time:now+3,data:{turn:2}}, {type:"user/message",seq:5,time:now+4,data:input("B")}];
    await app.runtimeEventPump.adoptSession(project,"native-session");
    const runB = (await app.agentRuns.list(project)).find(run=>run.kernelRequestIds?.includes("B"));
    assert.notEqual(runA.id,runB.id); assert.equal(runB.capabilityHandbooks[0].contentDigest,digestB);
    assert.equal((await app.agentRuns.list(project)).find(run=>run.id===runA.id).capabilityHandbooks[0].contentDigest,digestA);
  } finally { await app.close(); await rm(dataDir,{recursive:true,force:true}); await database.drop(); }
});
