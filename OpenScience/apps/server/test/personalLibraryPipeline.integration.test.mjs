// Real PostgreSQL, intake, capture/index workers, synchronization, Compile orchestration,
// mirroring and quotation checks. OpenViking Compile output and embedding/model behavior
// are explicit deterministic fixtures, not a live OpenViking or model qualification.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LIBRARY_PROJECT_ID } from "../src/internalProjects.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { databaseUrl, signedIn } from "./helpers/knowledgeBaseApp.mjs";
import { createOpenVikingStub } from "./helpers/openVikingResourcesStub.mjs";

test("personal storage is indexed and never compiled; a project's own document reaches project-only fixture Compile, a mirrored graph and checked citations", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 90_000,
}, async t => {
  const requests = [];
  let projectSourceId = null;
  let targetRoots = null;
  const engine = createOpenVikingStub({ compile: (request, stub) => {
    requests.push(request);
    assert.deepEqual(request.from, [targetRoots.sources]);
    assert.equal(stub.list(request.from[0]).length, 1, "only the project's own document is an input");
    const uri = `${targetRoots.sources}/${projectSourceId}.md`;
    assert.ok(stub.text(uri).includes("64 seconds"));
    assert.ok(!stub.text(uri).includes("120 seconds"));
    if (request.skill.endsWith("/llm-wiki")) {
      stub.put(`${request.to}/index.md`, "---\ntype: index\ntitle: Protocol index\ndescription: Protocol pages\n---\n\n# Protocol index\n\n- [Aster](concept/Aster.md)\n");
      stub.put(`${request.to}/concept/Aster.md`, `---\ntype: concept\ntitle: Aster protocol\ndescription: Heartbeat interval\n---\n\n# Aster protocol\n\nThe heartbeat is every 64 seconds [Protocol](${uri} "Aster protocol sends a heartbeat every 64 seconds.").\n\nAn intentionally unsupported interval is 60 seconds [Protocol](${uri} "Aster protocol sends a heartbeat every 60 seconds.").\n\n## Sources\n\n- [Protocol](${uri})\n`);
    } else {
      stub.put(`${request.to}/entities/aster.md`, `---\ntype: entity\nid: aster\ntitle: Aster protocol\nentity_type: protocol\ndescription: Synchronization protocol\nsources:\n  - ${uri}\n---\n`);
      stub.put(`${request.to}/entities/heartbeat.md`, `---\ntype: entity\nid: heartbeat\ntitle: Heartbeat\nentity_type: signal\ndescription: Periodic signal\nsources:\n  - ${uri}\n---\n`);
      stub.put(`${request.to}/relations.jsonl`, `${JSON.stringify({ from: "aster", relation: "sends", label: "sends", to: "heartbeat", evidence: [uri] })}\n`);
    }
  } });
  const client = new OpenVikingClient({ openVikingUrl: "http://openviking.test", openVikingApiKey: "stub-key", openVikingAccount: "evimed", openVikingRequestTimeoutMs: 5000 },
    { fetchImpl: engine.fetch });
  let paidCalls = 0;
  const refusePaidCall = async () => { paidCalls += 1; throw new Error("This test must not invoke a real model or public network."); };
  const ctx = await signedIn({ ovKnowledgeEnabled: true, openVikingClient: client, memoryIndexProvider: "builtin",
    knowledgePagesDebounceMs: 0, knowledgePagesMinSources: 1, knowledgePagesPollMs: 100,
    modelGatewayFetch: refusePaidCall, deepseekToolsFetch: refusePaidCall });
  t.after(ctx.close);
  await ctx.app.knowledgePagesWorker.close();
  await ctx.app.sourceSyncWorker.close();
  const { app, user, project } = ctx;
  targetRoots = app.openVikingResources.roots(user.id, project.id);
  const headers = { ...ctx.headers }; delete headers["x-open-science-project"];
  const api = async (route, method = "GET", body) => {
    const response = await fetch(`${ctx.base}${route}`, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...(await response.json()) };
  };
  const ingest = async () => {
    for (let round = 0; round < 200; round += 1) {
      const pending = await app.store.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND kind='ingest' AND status IN ('queued','running')", [user.id]);
      if (!pending.rowCount) return;
      await app.sourceWorker.tick();
    }
    assert.fail("intake jobs did not settle");
  };
  const textOnly = async source => {
    const current = await app.sourceService.get(user.id, source.id);
    if (current.payload.depth !== "index_only") await app.sourceService.override(user.id, source.id, {
      expectedRevision: current.revision, docType: current.payload.docType, depth: "index_only", reason: "Deterministic pipeline fixture: no model understanding." });
    await ingest();
    const captured = await app.sourceService.get(user.id, source.id);
    assert.equal(captured.payload.status, "complete");
    assert.equal(captured.payload.analysis.generation, captured.payload.generation);
    return captured;
  };
  const sync = async () => {
    for (let quiet = 0, round = 0; quiet < 3 && round < 200; round += 1) {
      await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND kind='ov-resource-sync' AND status='queued'", [user.id]);
      const worked = await app.sourceSyncWorker.tick();
      const pending = await app.store.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND kind='ov-resource-sync' AND status IN ('queued','running')", [user.id]);
      quiet = worked || pending.rowCount ? 0 : quiet + 1;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const report = await app.sourceSync.reconcileProject(user.id, project.id, { apply: false });
    assert.deepEqual([report.missing, report.stale, report.extra], [[], [], []]);
  };

  const added = await api("/api/library/uploads", "POST", { filename: "protocol.txt", data: "Aster protocol sends a heartbeat every 64 seconds.\n" });
  assert.equal(added.status, 201); assert.equal(added.data.source.personal, true);
  const personal = await textOnly(added.data.source);
  const unrelated = await api("/api/library/uploads", "POST", { filename: "unrelated.txt", data: "Unselected private inventory is unrelated to the Aster protocol.\n" });
  assert.equal(unrelated.status, 201); await textOnly(unrelated.data.source);
  for (let pass = 0; pass < 20; pass += 1) {
    const result = await app.kbIndex.sync({ userId: user.id, limit: 20 });
    if (!result.indexed && !result.embedded) break;
  }
  const indexed = await app.kbIndex.passages({ userId: user.id, projectId: null, shared: false, all: true, q: "heartbeat" });
  assert.ok(indexed.shas.includes(personal.payload.fingerprint.sha256));
  assert.ok(indexed.bySha[personal.payload.fingerprint.sha256][0].snippet.includes("64 seconds"));
  assert.equal((await app.store.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND project_id=$2 AND kind='wiki-compile'", [user.id, LIBRARY_PROJECT_ID])).rowCount, 0);
  assert.equal((await api("/api/knowledge-pages/compile", "POST", { projectId: LIBRARY_PROJECT_ID })).status, 400);
  assert.equal(requests.length, 0, "personal intake and indexing never Compile storage");

  // The same text held by the project on its own: a project's compile reads the project's documents, never the library's.
  const held = await fetch(`${ctx.base}/api/files/upload`, { method: "POST", headers: ctx.headers,
    body: JSON.stringify({ root: "base", path: "knowledge-base/protocol.txt", encoding: "base64",
      data: Buffer.from("Aster protocol sends a heartbeat every 64 seconds.\n").toString("base64") }) });
  assert.equal(held.status, 200);
  const heldSource = (await held.json()).data.source; projectSourceId = heldSource.id;
  assert.notEqual(projectSourceId, personal.id);
  const projectSource = await textOnly(heldSource);
  const revised = await api("/api/library/uploads", "POST", { filename: "protocol.txt", data: "Aster protocol sends a heartbeat every 120 seconds.\n" });
  assert.equal(revised.status, 201); await textOnly(revised.data.source);
  assert.ok((await readFile(path.join(project.baseDir, projectSource.payload.paths[0]), "utf8")).includes("64 seconds"));
  await sync();
  const storageRoots = app.openVikingResources.roots(user.id, LIBRARY_PROJECT_ID);
  assert.ok(engine.list(storageRoots.sources).some(uri => engine.text(uri).includes("120 seconds")), "personal sources still sync to the engine fixture");
  await app.libraryService.syncCopies({ userId: user.id });
  const librarySync = await app.sourceSync.reconcileLibrary(user.id);
  assert.deepEqual(librarySync.failed, []);
  assert.ok(engine.list(targetRoots.library).some(uri => engine.text(uri).includes("Unselected private inventory")), "an unrelated library input exists but must not enter project Compile");

  assert.equal((await api("/api/knowledge-pages/compile", "POST", { projectId: project.id })).status, 202);
  let compiled;
  for (let round = 0; round < 200; round += 1) {
    await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
    const outcome = await app.knowledgePagesWorker.tick(); await ingest();
    if (outcome && "result" in outcome) { compiled = outcome.result; break; }
  }
  assert.equal(compiled?.wiki.status, "completed"); assert.equal(compiled?.kg.status, "completed");
  assert.deepEqual(requests.map(request => request.skill.split("/").pop()), ["llm-wiki", "knowledge-graph"]);
  assert.ok(requests.every(request => JSON.stringify(request.from) === JSON.stringify([targetRoots.sources])));
  assert.ok(requests.every(request => !request.from.includes(targetRoots.library) && !request.from.includes(storageRoots.sources)));
  const tree = await api(`/api/knowledge-pages/tree?projectId=${project.id}`); assert.equal(tree.status, 200);
  const wiki = tree.data.pages.find(page => page.tree === "wiki" && page.path === "concept/Aster.md"); assert.ok(wiki);
  const page = await api(`/api/knowledge-pages/page?sourceId=${wiki.sourceId}`); assert.equal(page.status, 200);
  assert.deepEqual(page.data.sources.map(source => [source.sourceId, source.available]), [[projectSourceId, true]]);
  assert.deepEqual(page.data.links.filter(link => link.kind === "source" && !link.inSourceList).map(link => [link.sourceId, link.status]), [[projectSourceId, "present"], [projectSourceId, "absent"]]);
  assert.deepEqual([page.data.quotations.present, page.data.quotations.absent], [1, 1], "the UI's verification and warning labels have checked and absent quotation evidence");
  assert.ok(Number.isFinite(Date.parse(page.data.quotations.checkedAt)));
  assert.equal(await readFile(path.join(project.baseDir, "knowledge-base/wiki/concept/Aster.md"), "utf8"), page.data.markdown);
  const graph = await api(`/api/knowledge-pages/graph?projectId=${project.id}&kind=kg`); assert.equal(graph.status, 200);
  assert.deepEqual(graph.data.nodes.map(node => node.id).sort(), ["aster", "heartbeat"]);
  assert.deepEqual(graph.data.links.map(link => [link.source, link.target, link.evidence[0].sourceId]), [["aster", "heartbeat", projectSourceId]]);
  assert.equal((await app.store.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND project_id=$2 AND kind='wiki-compile'", [user.id, LIBRARY_PROJECT_ID])).rowCount, 0);
  assert.equal(paidCalls, 0, "no real model or DeepSeek web-tool request was made");
});
