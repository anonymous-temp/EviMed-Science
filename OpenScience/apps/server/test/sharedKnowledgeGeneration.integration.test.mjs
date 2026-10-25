import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { createOpenVikingStub } from "./helpers/openVikingResourcesStub.mjs";
import { createSharedKnowledgeContext } from "../src/sharedKnowledgeContext.mjs";
import { GeoSharedContext } from "../src/geoSharedContext.mjs";
import { unzipSync, strFromU8 } from "fflate";
import { ProductJobs } from "../src/productJobs.mjs";
import { OpenVikingCompileExecution, COMPILE_SCOPE_PROOF, compileProofDigest } from "../src/openVikingCompileExecution.mjs";
import { PINNED } from "../src/pinnedVersions.mjs";
import { ensureOpenVikingProject } from "../src/internalProjects.mjs";
import { knowledgeGenerationRoots } from "../src/knowledgeGeneration.mjs";
import { ProductDocuments } from "../src/productStore.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const hash = text => createHash("sha256").update(text).digest("hex");


test("shared sources, fresh compile targets, exact mirrors, lease publication and project read surfaces use one selected generation", {
  skip: !databaseUrl && "Disposable local PostgreSQL required", timeout: 180000,
}, async t => {
  const isolated = await createGeoTestDatabase(databaseUrl, "sharedkb");
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-shared-kb-"));
  const executionAuthority = { calls: [], offline: false, setOffline(value) { this.offline = value; } };
  let executionService = null;
  const qualification = async (policy, request, options = {}) => {
    const mode = options.mode ?? "live";
    executionAuthority.calls.push({ mode, transactionClient: Boolean(options.transactionClient), tree: request.tree });
    if (options.transactionClient && mode !== "completed-read") throw new Error("A live observation cannot run inside publication.");
    assert.ok(executionService, "the actual producer must be initialized before any qualification");
    return executionService.forRequest(policy, request, options);
  };
  const content = JSON.stringify({ bot: { sandbox: { backend: "direct", backends: { direct: { allow_exec: false, allow_compile_exec: false } } } } });
  const configuration = { content, revision: hash(content), file_path: "/run/openviking-secrets/ov.conf", restart_required: false };
  const observation = { version: 1, instance: hash("scripted-instance"), configDigest: hash(content), imageDigest: PINNED.openviking.imageDigest,
    codeDigest: compileProofDigest(COMPILE_SCOPE_PROOF.files.map(file => ({ path: file.installedPath, sha256: file.sha256 }))),
    processDigest: hash("scripted-process"), configPath: configuration.file_path, backend: "direct", allowExec: false, allowCompileExec: false };
  const observedApiCalls = [];
  const controller = { observeOpenVikingCompile: async () => { if (executionAuthority.offline) throw new Error("scripted controller outage"); return structuredClone(observation); } };
  const submissions = [];
  let wikiCalls = 0, failCompiles = false;
  const engine = createOpenVikingStub({ compile: (request, stub) => {
    submissions.push(request);
    if (failCompiles) throw new Error("Fixture terminal compile failure");
    const source = stub.list(request.from[0]).find(uri => uri.endsWith(".md"));
    if (request.skill.includes("knowledge-graph")) {
      stub.put(`${request.to}/entities/project.md`, `---\nentity_type: concept\ntitle: Project\n---\nProject fact [source](${source}).\n`);
      stub.put(`${request.to}/relations.jsonl`, "");
    } else {
      if (++wikiCalls === 1) { stub.put(`${request.to}/index.md`, "---\ntype: index\ntitle: First partial index\n---\nIndex only\n"); return; }
      stub.put(`${request.to}/index.md`, "---\ntype: index\ntitle: Project index\n---\n[Fact](concept/fact.md)\n");
      stub.put(`${request.to}/concept/fact.md`, `---\ntype: concept\ntitle: Project fact\n---\nProject fact [source](${source} \"Shared canonical fact.\").\n`);
      stub.put(`${request.to}/concept/zz-duplicate.md`, stub.text(`${request.to}/concept/fact.md`));
    }
  } });
  const taskView = engine.taskView;
  engine.taskView = task => { const result = taskView(task); if (result.status === "completed") result.result.warnings = ["Partial output retained"]; return result; };
  const client = new OpenVikingClient({ openVikingUrl: "http://evimed-openviking:1933", openVikingApiKey: "stub-key", openVikingAccount: "evimed" }, { fetchImpl: async (input, init) => {
    const url = new URL(input), name = url.pathname.split("/").at(-1);
    if (url.pathname === "/api/v1/admin/configuration" || url.pathname.startsWith("/api/v1/skills/")) {
      if (executionAuthority.offline) throw new Error("scripted engine outage");
      observedApiCalls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method ?? "GET" });
      if (url.pathname === "/api/v1/admin/configuration") return new Response(JSON.stringify({status:"ok",result:configuration}),{status:200,headers:{"content-type":"application/json"}});
      const uri = `viking://agent/skills/${name}`, sha = PINNED.openviking.skills[name]?.installedSha256;
      assert.ok(sha);
      const files = [{ path: "SKILL.md", uri: `${uri}/SKILL.md`, size: 200, is_dir: false, sha256: sha },
        { path: ".abstract.md", uri: `${uri}/.abstract.md`, size: 8, kind: "summary", is_dir: false, sha256: hash("abstract") },
        { path: ".overview.md", uri: `${uri}/.overview.md`, size: 8, kind: "summary", is_dir: false, sha256: hash("overview") }];
      const revision = compileProofDigest(files.map(file=>({path:file.path,is_dir:file.is_dir,size:file.size,sha256:file.sha256})).sort((a,b)=>a.path<b.path?-1:1));
      return new Response(JSON.stringify({status:"ok",result:{uri,content_sha256:sha,revision,files}}),{status:200,headers:{"content-type":"application/json"}});
    }
    return engine.fetch(input,init);
  } });
  const app = createWebApiApp({ dataDir, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, sourceIngestionEnabled: true, sourceIngestionPollMs: 100,
    memoryIndexProvider: "builtin", ovKnowledgeEnabled: true, openVikingClient: client, knowledgePagesDebounceMs: 0, knowledgePagesMinSources: 1,
    knowledgePagesPollMs: 100, kbSearchEnabled: false, sharedKnowledgeCompileExecutionFor: qualification });
  t.after(async () => { await app.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  const username = `sharedkb${randomUUID().slice(0, 8)}`;
  const user = await app.store.createUser(username, "fixture-password", "Shared KB fixture");
  const project = await app.store.defaultProject(await app.store.userById(user.id));
  const geoStore = new GeoStore({ database: app.store.database }); await geoStore.ready();
  await geoStore.createProject({ userId: user.id, projectId: project.id, engines: ["deepseek"], coverageDays: 30 });
  const docs = new ProductDocuments(app.store.database);
  const executionDependencies = { client, controller, documents: docs, ensureOwner: () => ensureOpenVikingProject(app.store), readConfigurationDigest: async () => hash(configuration.content) };
  executionService = new OpenVikingCompileExecution(executionDependencies);
  const address = await app.listen(0, "127.0.0.1");
  await app.sourceWorker.close(); await app.knowledgePagesWorker.close(); await app.sourceSyncWorker.close();
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "fixture-password" }) });
  const auth = await login.json(), headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken, "x-open-science-project": project.id };
  const api = async (route, body) => { const response = await fetch(`${base}${route}`, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; };
  const upload = await api("/api/files/upload", { root: "base", path: "knowledge-base/fact.md", data: "# Project\n\nShared canonical fact.\n", encoding: "utf8" });
  assert.equal(upload.status, 200, JSON.stringify(upload.body));
  const sourceId = upload.body.data.source.id;
  let source = await app.sourceService.get(user.id, sourceId);
  await app.sourceService.override(user.id, sourceId, { expectedRevision: source.revision, docType: source.payload.docType, depth: "index_only", reason: "Fixture capture only" });
  const ingest = async () => {
    for (let n = 0; n < 100; n += 1) {
      await app.sourceWorker.tick();
      const open = await app.store.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND kind='ingest' AND status IN ('queued','running')", [user.id]);
      if (!open.rows.length) return;
      await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='ingest' AND status='queued'", [user.id]);
    }
    assert.fail("capture jobs did not finish");
  };
  const legacy = await api("/api/files/upload", { root: "base", path: "knowledge-base/wiki/legacy.md", data: "PRIVATE_OLD_MIXED_CANONICAL", encoding: "utf8" });
  assert.equal(legacy.status, 200);
  await ingest();
  const policies = new GeoSharedContext({ database: app.store.database, documents: docs });
  const contexts = createSharedKnowledgeContext({ contextPolicies: policies, store: app.store, sources: app.sourceService, documents: docs, resources: app.openVikingResources, compileExecutionFor: qualification });
  const roots = app.openVikingResources.roots(user.id, project.id);
  engine.put(`${roots.wiki}/private.md`, "PRIVATE_OLD_MIXED");
  engine.put(`${roots.library}/src_${"f".repeat(32)}.md`, "PRIVATE_LIBRARY");
  const before = await contexts.forProject(project);
  assert.equal(before.selected, null); assert.equal(await before.acceptSource({ id: sourceId }), true);
  assert.deepEqual((await app.knowledgePages.list(user.id, project.id)).pages, []);
  await app.knowledgePages.requestRound(user.id, project.id);
  let result;
  for (let step = 0; step < 80; step += 1) {
    await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
    const outcome = await app.knowledgePagesWorker.tick();
    await ingest();
    if (outcome && "result" in outcome) { result = outcome.result; break; }
  }
  assert.ok(result?.generationId, JSON.stringify({ result, status: app.knowledgePagesWorker.status(), sources: (await docs.list(user.id, "source", {projectId:project.id,limit:100})).items.map(row=>({id:row.id,status:row.payload.status,analysis:row.payload.analysis?.generation,paths:row.payload.paths,depth:row.payload.depth})), jobs:(await app.store.database.query("SELECT kind,status,error FROM evimed_product.jobs WHERE user_id=$1",[user.id])).rows, summary: await app.knowledgePages.summary(user.id, project.id) }));
  assert.equal(submissions.length, 3, "an index-only result is retried exactly once");
  assert.notEqual(submissions[0].to, submissions[1].to, "the retry uses a fresh empty target");
  assert.ok(result.warnings.includes("Partial output retained"));
  assert.ok(observedApiCalls.some(call=>call.path==="/api/v1/admin/configuration"));
  assert.ok(observedApiCalls.some(call=>call.path==="/api/v1/skills/llm-wiki"));
  assert.ok(observedApiCalls.some(call=>call.path==="/api/v1/skills/knowledge-graph"));
  assert.ok(observedApiCalls.every(call=>call.method==="GET"));
  assert.ok(submissions.every(request => request.from.length === 1 && request.from[0].includes(`/generations/${result.generationId}/sources`) && request.to.includes(`/generations/${result.generationId}/`)));
  assert.equal(engine.text(`${roots.wiki}/private.md`), "PRIVATE_OLD_MIXED");
  const selected = await contexts.forProject(project);
  assert.equal(selected.selected.receipt.generationId, result.generationId);
  const listing = await app.knowledgePages.list(user.id, project.id);
  assert.equal(listing.pages.length, 5); assert.doesNotMatch(JSON.stringify(listing), /PRIVATE|private\.md/);
  const view = await app.knowledgePages.pageView(user.id, project, await app.sourceService.get(user.id, listing.pages.find(page => page.tree === "wiki" && page.path === "concept/fact.md").sourceId));
  assert.match(view.markdown, /Project fact/);
  assert.ok((await app.knowledgePages.graph(user.id, project, "wiki")).nodes.length);
  assert.ok((await app.knowledgePages.fetchProducts({ user, projectId: project.id })).pages.length);
  assert.equal((await app.knowledgePages.vaultFiles(user.id, project)).roots.library, null);
  const vaultResponse = await fetch(`${base}/api/sources/export/vault?projectId=${project.id}`, { headers });
  assert.equal(vaultResponse.status, 200);
  const vault = unzipSync(new Uint8Array(await vaultResponse.arrayBuffer()));
  assert.ok(Object.keys(vault).some(file => file.endsWith("/wiki/concept/fact.md")));
  assert.ok(Object.keys(vault).some(file => file.endsWith("/wiki/concept/zz-duplicate.md")), "content-addressed duplicate bytes retain both selected logical paths");
  assert.equal(Object.keys(vault).filter(file => /\/(?:wiki|kg)\//.test(file)).length, selected.selected.outputs.length);
  const vaultText = Object.values(vault).map(strFromU8).join("\n");
  assert.match(vaultText, /Project fact/); assert.doesNotMatch(vaultText, /PRIVATE_OLD_MIXED|PRIVATE_LIBRARY|generations\//);
  executionAuthority.setOffline(true); engine.setDown(true);
  executionService = new OpenVikingCompileExecution(executionDependencies);
  const offlineStart = executionAuthority.calls.length;
  for (const route of [`/api/knowledge-pages/tree?projectId=${project.id}`, `/api/knowledge-pages/page?${new URLSearchParams({projectId:project.id,tree:"wiki",path:"concept/zz-duplicate.md"})}`,
    `/api/knowledge-pages/graph?projectId=${project.id}&kind=wiki`]) {
    const response = await api(route); assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const offlineVault = await fetch(`${base}/api/sources/export/vault?projectId=${project.id}`, {headers});
  assert.equal(offlineVault.status,200); assert.ok((await offlineVault.arrayBuffer()).byteLength);
  assert.ok(executionAuthority.calls.slice(offlineStart).every(call=>call.mode==="completed-read"), "offline mirrors never call live qualification");
  executionAuthority.setOffline(false); engine.setDown(false);
  const originalTokenCheck = app.runtimeManager.assertActiveModelGatewayToken;
  app.runtimeManager.assertActiveModelGatewayToken = token => { if (token !== "shared-fixture") throw new Error("inactive"); return { userId: user.id, projectId: project.id }; };
  const browse = async request => {
    const response = await fetch(`${base}/internal/kb/v1/browse`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer shared-fixture" }, body: JSON.stringify(request) });
    return { status: response.status, body: await response.json() };
  };
  for (const request of [{op:"overview",root:"sources"},{op:"tree",root:"wiki"},{op:"read",root:"wiki",path:"concept/fact.md"},{op:"grep",root:"wiki",pattern:"Project"},{op:"overview",root:"kg"}]) {
    const response = await browse(request); assert.equal(response.status, 200, JSON.stringify(response.body)); assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE|viking:\/\//);
  }
  assert.equal((await browse({op:"list",root:"library"})).status, 403);
  assert.equal((await browse({op:"read",root:"wiki",path:"private.md"})).status, 400);
  app.runtimeManager.assertActiveModelGatewayToken = originalTokenCheck;
  const aliasRead = await api(`/api/knowledge-pages/page?${new URLSearchParams({ projectId: project.id, tree: "wiki", path: "concept/zz-duplicate.md" })}`);
  assert.equal(aliasRead.status, 200); assert.equal(aliasRead.body.data.path, "concept/zz-duplicate.md");
  const aliasBase = aliasRead.body.data;
  const saveAlias = async payload => {
    const response = await fetch(`${base}/api/knowledge-pages/page`, { method: "PUT", headers, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  };
  const aliasSaved = await saveAlias({ sourceId: aliasBase.sourceId, markdown: `${aliasBase.markdown}\nOnly the addressed alias changed.\n`, baseSha256: aliasBase.sha256, address: aliasBase.address });
  assert.equal(aliasSaved.status, 200, JSON.stringify(aliasSaved.body));
  assert.equal(aliasSaved.body.data.page.path, "concept/zz-duplicate.md");
  for (let step = 0; step < 40; step += 1) {
    await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
    await app.knowledgePagesWorker.tick(); await ingest();
    if (!(await docs.get(user.id, "knowledge", `wiki:state:${project.id}`)).payload.sharedEdit) break;
  }
  const aliasAfter = await api(`/api/knowledge-pages/page?${new URLSearchParams({ projectId: project.id, tree: "wiki", path: "concept/zz-duplicate.md" })}`);
  assert.match(aliasAfter.body.data.markdown, /Only the addressed alias changed/);
  const factAfterAlias = await api(`/api/knowledge-pages/page?${new URLSearchParams({ projectId: project.id, tree: "wiki", path: "concept/fact.md" })}`);
  assert.equal(factAfterAlias.body.data.markdown, view.markdown, "the equal-byte sibling keeps its own bytes and binding");
  assert.equal((await saveAlias({ sourceId: aliasAfter.body.data.sourceId, markdown: `${aliasAfter.body.data.markdown}stale`, baseSha256: aliasAfter.body.data.sha256, address: aliasBase.address })).status, 409);
  const editedSource = await app.sourceService.get(user.id, view.sourceId);
  const editedText = `${view.markdown}\nA human correction.\n`;
  const edited = await app.knowledgePages.saveEdit({ user, project, source: editedSource, markdown: editedText, baseSha256: view.sha256 });
  assert.equal(edited.writeBack, "queued");
  for (let step = 0; step < 40; step += 1) {
    await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
    await app.knowledgePagesWorker.tick(); await ingest();
    const state = await docs.get(user.id, "knowledge", `wiki:state:${project.id}`);
    if (!state.payload.sharedEdit) break;
  }
  const afterEdit = await contexts.forProject(project);
  assert.ok(afterEdit.selected, JSON.stringify({ worker: app.knowledgePagesWorker.status(), outputs: await Promise.all(selected.selected.outputs.map(async output => {
    const current = await docs.get(user.id, "source", output.source.sourceId, { includeDeleted: true });
    return { path: output.path, expectedSha: output.displayedBytesSha256, status: current?.payload.status,
      paths: current?.payload.paths, sha: current?.payload.fingerprint?.sha256, generation: current?.payload.generation,
      capture: current?.payload.analysis?.generation, original: current?.payload.original, outputs: current?.payload.outputs };
  })) }));
  const editedPage = afterEdit.selected.pages.find(page => page.payload.path === "concept/fact.md");
  assert.ok(editedPage.payload.editReceipt);
  assert.match((await app.knowledgePages.pageView(user.id, project, await app.sourceService.get(user.id, editedPage.payload.pageSourceId))).markdown, /A human correction/);
  const jobs = new ProductJobs(app.store.database);
  const candidate = async () => {
    await app.knowledgePages.requestRound(user.id, project.id);
    await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
    const leased = await jobs.claim(["wiki-compile"], "lease-negative", { leaseMs: 10000 });
    assert.ok(leased, "the requested wiki round must be claimable after its one-second-past-due fixture update");
    let settlement;
    for (let step = 0; step < 30; step += 1) {
      const outcome = await app.knowledgePages.runJob(leased); await ingest();
      if (outcome.sharedSettlement) { settlement = await app.knowledgePages.prepareSharedSettlement(leased, outcome.sharedSettlement); break; }
    }
    assert.ok(settlement); return { leased, settlement };
  };
  const carried = await candidate();
  await jobs.finishWithLease(user.id, carried.leased.id, carried.leased.leaseToken, {}, client => app.knowledgePages.finishSharedJob(carried.leased, carried.settlement, client));
  const carriedContext = await contexts.forProject(project);
  assert.ok(carriedContext.selected);
  const carriedPage = carriedContext.selected.pages.find(page => page.payload.path === "concept/fact.md");
  assert.ok(carriedPage.payload.carriedEditReceipt);
  assert.match((await app.knowledgePages.pageView(user.id, project, await app.sourceService.get(user.id, carriedPage.payload.pageSourceId))).markdown, /A human correction/);
  const staleAddressRead = await api(`/api/knowledge-pages/page?${new URLSearchParams({projectId:project.id,tree:aliasBase.address.tree,path:aliasBase.address.path,
    generationId:aliasBase.address.generationId,pageId:aliasBase.address.pageId,pageRevision:String(aliasBase.address.pageRevision)})}`);
  assert.equal(staleAddressRead.status,409,"an old addressed generation cannot retarget its new equal-byte path");
  const currentView = await app.knowledgePages.pageView(user.id, project, await app.sourceService.get(user.id, carriedPage.payload.pageSourceId));
  await app.knowledgePages.saveEdit({ user, project, source: await app.sourceService.get(user.id, currentView.sourceId),
    markdown: `${currentView.markdown}\nQueued correction requiring its old base.\n`, baseSha256: currentView.sha256 });
  const queuedEdit = (await docs.get(user.id, "knowledge", `wiki:state:${project.id}`)).payload.sharedEdit;
  const changedOriginal = await app.sourceService.get(user.id, sourceId);
  await docs.put(user.id, "source", sourceId, { ...changedOriginal.payload, metadata: { ...changedOriginal.payload.metadata, title: "Changed after queued edit" } },
    { projectId: project.id, expectedRevision: changedOriginal.revision });
  const beforeStaleEdit = submissions.length;
  for (let step = 0; step < 80; step += 1) {
    await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
    await app.knowledgePagesWorker.tick(); await ingest();
    if ((await contexts.forProject(project)).selected && !(await docs.get(user.id, "knowledge", `wiki:state:${project.id}`)).payload.sharedEdit) break;
  }
  assert.equal((await docs.get(user.id, "knowledge", `wiki:state:${project.id}`)).payload.sharedEdit, null);
  assert.match((await docs.get(user.id, "knowledge", queuedEdit.id)).payload.text, /Queued correction requiring its old base/);
  assert.ok(submissions.length > beforeStaleEdit, "a stale edit cannot block the new source generation");
  assert.ok((await contexts.forProject(project)).selected);
  const beforeWithdrawal = (await contexts.forProject(project)).selected;
  const withdrawalPage = beforeWithdrawal.pages.find(page => page.payload.path === "concept/fact.md");
  const withdrawalView = await app.knowledgePages.pageView(user.id, project, await app.sourceService.get(user.id, withdrawalPage.payload.pageSourceId));
  await app.knowledgePages.saveEdit({ user, project, source: await app.sourceService.get(user.id, withdrawalView.sourceId),
    markdown: `${withdrawalView.markdown}\nQueued edit before another output is removed.\n`, baseSha256: withdrawalView.sha256 });
  const withdrawalEdit = (await docs.get(user.id, "knowledge", `wiki:state:${project.id}`)).payload.sharedEdit;
  const indexSourceId = beforeWithdrawal.pages.find(page => page.payload.tree === "wiki" && page.payload.path === "index.md").payload.pageSourceId;
  const indexSource = await app.sourceService.get(user.id, indexSourceId);
  const withdrawn = await fetch(`${base}/api/sources/${indexSourceId}`, { method: "DELETE", headers,
    body: JSON.stringify({ expectedRevision: indexSource.revision }) });
  assert.equal(withdrawn.status, 200);
  const beforeWithdrawalSubmissions = submissions.length;
  for (let step = 0; step < 80; step += 1) {
    await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
    await app.knowledgePagesWorker.tick(); await ingest();
    if ((await contexts.forProject(project)).selected && !(await docs.get(user.id, "knowledge", `wiki:state:${project.id}`)).payload.sharedEdit) break;
  }
  assert.equal((await docs.get(user.id, "knowledge", `wiki:state:${project.id}`)).payload.sharedEdit, null);
  assert.match((await docs.get(user.id, "knowledge", withdrawalEdit.id)).payload.text, /Queued edit before another output is removed/);
  assert.ok(submissions.length > beforeWithdrawalSubmissions);
  assert.ok((await contexts.forProject(project)).selected);
  const { leased, settlement } = await candidate();
  const beforeExpired = (await docs.get(user.id, "knowledge", `wiki:state:${project.id}`)).payload.selectedGeneration;
  await app.store.database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND id=$2", [user.id, leased.id]);
  await assert.rejects(jobs.finishWithLease(user.id, leased.id, leased.leaseToken, {}, client => app.knowledgePages.finishSharedJob(leased, settlement, client)), {code:"product_job_lease_lost"});
  assert.deepEqual((await docs.get(user.id, "knowledge", `wiki:state:${project.id}`)).payload.selectedGeneration, beforeExpired);

  // Retire the deliberately expired candidate before checking periodic catch-up.
  await app.store.database.query("UPDATE evimed_product.jobs SET status='failed',lease_token=NULL,lease_expires_at=NULL WHERE user_id=$1 AND id=$2", [user.id, leased.id]);
  const expiredState = await docs.get(user.id, "knowledge", `wiki:state:${project.id}`);
  await docs.put(user.id,"knowledge",expiredState.id,{...expiredState.payload,run:null,round:expiredState.payload.round+1},{projectId:project.id,expectedRevision:expiredState.revision});
  source = await app.sourceService.get(user.id, sourceId);
  await docs.put(user.id, "source", source.id, { ...source.payload, metadata: { ...source.payload.metadata, title: "Changed metadata" } }, { projectId: project.id, expectedRevision: source.revision });
  assert.equal((await contexts.forProject(project)).selected, null, "metadata-only changes invalidate selected output");
  assert.equal(await app.knowledgePages.catchUp(user.id, project.id), "scheduled", "the existing worker catches metadata-only changes");
  failCompiles = true;
  const failRound = async () => {
    for (let step = 0; step < 30; step += 1) {
      await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
      await app.knowledgePagesWorker.tick();
      const state = (await docs.get(user.id, "knowledge", `wiki:state:${project.id}`)).payload;
      if (state.lastError && !state.run) return state;
    }
    assert.fail("terminal fixture failure was not recorded");
  };
  const failed = await failRound();
  assert.equal(failed.lastError.sourceSetDigest, (await contexts.forProject(project)).sourceSetDigest);
  const failureCount = submissions.length;
  assert.equal(await app.knowledgePages.catchUp(user.id, project.id), "skipped");
  assert.equal(await app.knowledgePages.catchUp(user.id, project.id), "skipped");
  assert.equal(submissions.length, failureCount);
  await app.knowledgePages.requestRound(user.id, project.id);
  // A pending manual round can coexist with the previous failure status.
  await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
  await app.knowledgePagesWorker.tick();
  const manualFailed = await failRound();
  assert.equal(submissions.length, failureCount + 1, "an explicit retry uses one new compile, not every periodic pass");
  assert.equal(manualFailed.lastError.sourceSetDigest, failed.lastError.sourceSetDigest);
  const beforeChangedFailure = await app.sourceService.get(user.id, sourceId);
  await docs.put(user.id,"source",sourceId,{...beforeChangedFailure.payload,metadata:{...beforeChangedFailure.payload.metadata,title:"Changed after terminal failure"}},
    {projectId:project.id,expectedRevision:beforeChangedFailure.revision});
  assert.equal(await app.knowledgePages.catchUp(user.id, project.id), "scheduled");
  await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
  await app.knowledgePagesWorker.tick();
  const changedFailed = await failRound();
  assert.notEqual(changedFailed.lastError.sourceSetDigest, failed.lastError.sourceSetDigest);
  assert.equal(await app.knowledgePages.catchUp(user.id, project.id), "skipped");
  const secondProject = await app.store.createProject(await app.store.userById(user.id),"cross-project-qualification","Cross-project authority fixture");
  const secondGenerationId = `kg_${"c".repeat(32)}`, secondRoots = knowledgeGenerationRoots(app.openVikingResources,user.id,secondProject.id,secondGenerationId);
  const foreignPolicy = { ownerId:user.id,controlProjectId:secondProject.id };
  const secondRequest = {tree:"wiki",skill:"llm-wiki",generationId:secondGenerationId,from:[secondRoots.sources],to:secondRoots.wiki};
  const originalRequest = selected.selected.receipt.tasks.wiki.request, originalRef = selected.selected.receipt.qualificationRefs.wiki;
  assert.ok(await qualification(selected.stamp,originalRequest,{mode:"completed-read",authorityRef:originalRef}));
  observation.allowCompileExec = true;
  assert.equal(await qualification(foreignPolicy,secondRequest,{mode:"live"}),null,"an actual negative observation from another project revokes the global environment");
  executionAuthority.setOffline(true);
  executionService = new OpenVikingCompileExecution(executionDependencies);
  assert.equal(await qualification(selected.stamp,originalRequest,{mode:"completed-read",authorityRef:originalRef}),null,"a restarted reader cannot inherit revoked proof from its project history");
  assert.equal(hash(engine.text(`${roots.wiki}/private.md`)), hash("PRIVATE_OLD_MIXED"));
});
