// The knowledge base on OpenViking's Resources and Compile, end to end against PostgreSQL and an engine that holds its
// files in memory (`helpers/openVikingStub.mjs`): documents pushed and reconciled both ways, a compile scheduled,
// polled and mirrored by content hash, the routes the reader and the graph view are built on, a person's edit that
// survives a recompile that dropped it, a removed document labelling its pages, the page limit, and the engine down.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { createOpenVikingStub } from "./helpers/openVikingStub.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const sha256 = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");

const DOCUMENTS = {
  "alpha.md": "# Alpha 协议\n\nAlpha 协议是一个用于设备间时间同步的轻量协议，由 Lumen 工作组在 2021 年发布。它使用 UDP 端口 4123，默认同步周期为 64 秒。\n\n## 时间线\n\n- 14:05 第一台设备完成同步\n- 14:20 全部设备完成同步\n",
  "beta.txt": "Beta 网关是 Lumen 工作组推出的边缘网关产品，2.0 版本最多可接入 512 台下游设备。\n",
  "gamma.md": "# Gamma 仪表盘\n\nGamma 仪表盘是 Beta 网关 2.0 自带的 Web 管理界面，默认监听 TCP 端口 8443。\n",
};

test("documents are pushed, compiled by the engine, mirrored, read, edited and kept through a recompile", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 180_000,
}, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-knowledge-"));
  /** What the next compile writes: `(request, engine, ids) => void`. */
  let script = /** @type {(request: any, engine: any) => void} */ (() => {});
  const engine = createOpenVikingStub({ compile: (request, stub) => script(request, stub) });
  const client = new OpenVikingClient({ openVikingUrl: "http://openviking.test", openVikingApiKey: "stub-key", openVikingAccount: "evimed", openVikingRequestTimeoutMs: 5000 },
    { fetchImpl: /** @type {any} */ (engine.fetch) });
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl, sourceIngestionEnabled: true, sourceIngestionPollMs: 100, sourceIngestionLeaseMs: 5000,
    memoryIndexProvider: "builtin", ovKnowledgeEnabled: true, openVikingClient: client, knowledgePagesDebounceMs: 0, knowledgePagesMinSources: 2, knowledgePagesPollMs: 100,
    kbSearchEnabled: false });
  const username = `kp${randomUUID().slice(0, 8)}`;
  let user;
  let listening = false;
  try {
    user = await app.store.createUser(username, "test-only-knowledge-password", "Knowledge fixture");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const address = await app.listen(0, "127.0.0.1");
    listening = true;
    // The test drives every worker by hand, so each step is one observable thing.
    await app.sourceWorker.close();
    await app.knowledgePagesWorker.close();
    await app.sourceSyncWorker.close();
    assert.equal(app.knowledgePages.enabled, true);
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "test-only-knowledge-password" }) });
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": auth.data.csrfToken,
      "x-open-science-project": project.id, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" };
    const api = async (/** @type {string} */ route, /** @type {RequestInit} */ init = {}) => {
      const response = await fetch(`${base}${route}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    /** Read every queued document; an understanding is not part of this fixture. */
    const ingest = async () => {
      for (let round = 0; round < 60; round += 1) {
        const queued = await app.store.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND kind='ingest' AND status IN ('queued','running')", [user.id]);
        if (!queued.rowCount) return;
        await app.sourceWorker.tick();
      }
      assert.fail("the documents were not read");
    };
    const upload = async (/** @type {string} */ name, /** @type {string} */ content) => {
      const sent = await api("/api/files/upload", { method: "POST", body: JSON.stringify({ root: "base", path: `knowledge-base/${name}`, data: content, encoding: "utf8" }) });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const source = await app.sourceService.get(user.id, sent.body.data.source.id);
      if (source.payload.depth !== "index_only") {
        await app.sourceService.override(user.id, source.id, { expectedRevision: source.revision, docType: source.payload.docType, depth: "index_only", reason: "Knowledge fixture: text only." });
      }
      return sent.body.data.source.id;
    };
    const syncSources = async () => { for (let round = 0; round < 60 && (await app.sourceSyncWorker.tick()); round += 1) { /* until the queue is empty */ } };
    /** Run the compile job to its end, reading what it mirrors as it goes. */
    const compileRound = async () => {
      for (let round = 0; round < 200; round += 1) {
        await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
        const outcome = await app.knowledgePagesWorker.tick();
        await ingest();
        if (outcome && "result" in outcome) return outcome.result;
        if (!outcome) {
          const open = await app.store.database.query("SELECT status FROM evimed_product.jobs WHERE user_id=$1 AND kind='wiki-compile' AND status IN ('queued','running')", [user.id]);
          if (!open.rowCount) return null;
        }
      }
      assert.fail("the compile round did not end");
    };

    // ---- 1. documents reach the engine, and reconciliation proves the two agree ------------------------------------
    /** @type {Record<string, string>} */
    const ids = {};
    for (const [name, content] of Object.entries(DOCUMENTS)) ids[name] = await upload(name, content);
    await ingest();
    await syncSources();
    const roots = app.openVikingResources.roots(user.id, project.id);
    assert.deepEqual(engine.list(roots.sources).map((uri) => uri.split("/").pop()).sort(), Object.values(ids).map((id) => `${id}.md`).sort());
    const pushed = String(engine.text(`${roots.sources}/${ids["alpha.md"]}.md`));
    // What is pushed is the captured text under the header a run reads, and the tag is the captured text's digest.
    assert.ok(pushed.includes(DOCUMENTS["alpha.md"].trim()) && pushed.startsWith("# "));
    const alpha = await app.sourceService.get(user.id, ids["alpha.md"]);
    assert.ok(engine.files.get(`${roots.sources}/${ids["alpha.md"]}.md`)?.tags.includes(`sha=${alpha.payload.analysis.textSha256}`));
    let report = await app.sourceSync.reconcileProject(user.id, project.id, { apply: false });
    assert.deepEqual([report.expected, report.present, report.missing, report.stale, report.extra], [3, 3, [], [], []]);
    // Both ways: a file the engine lost is pushed again, one PostgreSQL does not know is removed.
    engine.remove(`${roots.sources}/${ids["beta.txt"]}.md`);
    engine.put(`${roots.sources}/src_${"f".repeat(32)}.md`, "stale", ["src=x"]);
    report = await app.sourceSync.reconcileProject(user.id, project.id);
    assert.deepEqual([report.pushed, report.removed, report.failed], [1, 1, []]);
    report = await app.sourceSync.reconcileProject(user.id, project.id, { apply: false });
    assert.deepEqual([report.missing, report.stale, report.extra], [[], [], []]);

    // ---- 2. a compile: scheduled by the documents, submitted with the instruction, polled, mirrored -----------------
    const source = (/** @type {string} */ name) => `${roots.sources}/${ids[name]}.md`;
    const wikiV1 = () => ({
      "index.md": "---\ntype: index\ntitle: 知识页目录\ndescription: 目录\n---\n\n# 知识页目录\n\n- [Alpha 协议](concept/Alpha 协议.md)\n- [Beta 网关](entity/Beta网关.md)\n",
      "concept/Alpha 协议.md": `---\ntype: concept\ntitle: Alpha 协议\ndescription: 设备间时间同步协议\ntags: [协议]\n---\n\n# Alpha 协议\n\n## 定义\n\nAlpha 协议由 Lumen 工作组发布 [Alpha](${source("alpha.md")} "由 Lumen 工作组在 2021 年发布")，同步周期为一分钟左右 [Alpha](${source("alpha.md")} "默认同步周期为 60 秒")。\n\n- 第一台设备在 14:05 完成同步 [Alpha](${source("alpha.md")} "14:05 第一台设备完成同步")\n\n## 相关\n\n- [Beta 网关](../entity/Beta网关.md)\n\n## 来源\n\n- [Alpha](${source("alpha.md")})\n`,
      "entity/Beta网关.md": `---\ntype: entity\ntitle: Beta 网关\ndescription: 边缘网关\n---\n\n# Beta 网关\n\nBeta 网关最多接入 512 台设备 [Beta](${source("beta.txt").replace(/\.md$/, "")} "2.0 版本最多可接入 512 台下游设备")，管理界面是 [Gamma](${source("gamma.md")})。\n\n参见 [Alpha 协议](../concept/Alpha 协议.md)。\n`,
    });
    /** @type {any[]} */
    const compiles = [];
    script = (request, stub) => {
      compiles.push(request);
      if (request.skill.endsWith("/llm-wiki")) for (const [rel, text] of Object.entries(wikiV1())) stub.put(`${request.to}/${rel}`, text);
      else {
        stub.put(`${request.to}/entities/alpha.md`, `---\ntype: entity\nid: alpha\ntitle: Alpha 协议\nentity_type: protocol\ndescription: 时间同步协议。\nsources:\n  - ${source("alpha.md")}\n---\n\n正文\n`);
        stub.put(`${request.to}/entities/beta.md`, `---\ntype: entity\nid: beta\ntitle: Beta 网关\nentity_type: product\ndescription: 边缘网关。\nsources:\n  - ${source("beta.txt")}\n---\n`);
        stub.put(`${request.to}/relations.jsonl`, `${JSON.stringify({ from: "beta", relation: "implements", label: "实现", to: "alpha", evidence: [source("beta.txt")] })}\n`);
        stub.put(`${request.to}/.overview.md`, "a hidden sidecar the mirror never takes");
      }
    };
    // The status route also learns the reader's language, once.
    let status = await api(`/api/knowledge-pages?projectId=${project.id}`);
    assert.equal(status.status, 200);
    assert.deepEqual([status.body.data.enabled, status.body.data.state, status.body.data.pending, status.body.data.readable, status.body.data.pageLimit], [true, "queued", 3, 3, 100]);
    const first = await compileRound();
    assert.equal(first.wiki.status, "completed");
    assert.deepEqual([first.wiki.created, first.wiki.typed, first.kg.created, first.kg.typed], [3, 3, 3, 2]);
    assert.deepEqual(compiles.map((request) => request.skill.split("/").pop()), ["llm-wiki", "knowledge-graph"]);
    assert.deepEqual(compiles[0].from, [roots.sources]);
    assert.equal(compiles[0].to, roots.wiki);
    assert.match(compiles[0].instruction, /in Simplified Chinese/);
    assert.match(compiles[0].instruction, /copied verbatim from that source/);
    const submitted = engine.requests.filter((request) => request.path === "/api/v1/compile");
    assert.ok(submitted.every((request) => /^[A-Za-z0-9_-]{16,128}$/.test(request.headers["idempotency-key"]) && !("args" in request.body)));

    status = await api(`/api/knowledge-pages?projectId=${project.id}`);
    assert.deepEqual([status.body.data.state, status.body.data.pages, status.body.data.graphFiles, status.body.data.typedPages, status.body.data.language],
      ["compiled", 3, 3, { wiki: 3, kg: 2 }, "zh-cn"]);
    assert.ok(status.body.data.compiledAt && status.body.data.lastRound.wiki.tokens === 65_000 && status.body.data.lastRound.wiki.cost > 0);
    assert.deepEqual(status.body.data.quotations, { present: 3, absent: 1, none: 1 });

    // ---- 3. the routes the reader and the graph are built on -------------------------------------------------------
    const tree = await api(`/api/knowledge-pages/tree?projectId=${project.id}`);
    assert.deepEqual(tree.body.data.pages.map((/** @type {any} */ page) => `${page.tree}:${page.path}:${page.type}`), [
      "wiki:concept/Alpha 协议.md:concept", "wiki:entity/Beta网关.md:entity", "wiki:index.md:index",
      "kg:entities/alpha.md:entity", "kg:entities/beta.md:entity", "kg:relations.jsonl:relations",
    ]);
    assert.deepEqual(tree.body.data.trees.wiki.children.map((/** @type {any} */ node) => [node.kind, node.name]), [["directory", "concept"], ["directory", "entity"], ["page", "index.md"]]);
    const alphaPage = tree.body.data.pages[0];
    assert.deepEqual(alphaPage.labels.quotations, { present: 2, absent: 1, none: 0, sourceMissing: 0 });
    // Each mirrored file is a document of the knowledge base, under the 知识页 filter like any other.
    const listed = await api(`/api/sources?projectId=${project.id}&kind=wiki`);
    assert.equal(listed.body.data.items.length, 6);
    assert.ok(listed.body.data.items.every((/** @type {any} */ item) => /^knowledge-base\/(?:wiki|kg)\//.test(item.payload.paths[0])));
    assert.equal(await readFile(path.join(project.baseDir, "knowledge-base/wiki/concept/Alpha 协议.md"), "utf8"), wikiV1()["concept/Alpha 协议.md"]);

    let page = (await api(`/api/knowledge-pages/page?sourceId=${alphaPage.sourceId}`)).body.data;
    assert.deepEqual([page.tree, page.path, page.type, page.title, page.editable, page.userEdited, page.basis], ["wiki", "concept/Alpha 协议.md", "concept", "Alpha 协议", true, false, "compiler"]);
    assert.equal(page.markdown, wikiV1()["concept/Alpha 协议.md"]);
    assert.equal(page.sha256, sha256(page.markdown));
    assert.deepEqual(page.frontmatter.tags, ["协议"]);
    assert.deepEqual(page.links.filter((/** @type {any} */ link) => link.kind === "source").map((/** @type {any} */ link) => [link.sourceId === ids["alpha.md"], link.status, link.inSourceList]),
      [[true, "present", false], [true, "absent", false], [true, "present", false], [true, "no_quotation", true]]);
    const pageLink = page.links.find((/** @type {any} */ link) => link.kind === "page");
    assert.deepEqual([pageLink.path, pageLink.exists, pageLink.title], ["entity/Beta网关.md", true, "Beta 网关"]);
    assert.deepEqual(page.sources.map((/** @type {any} */ entry) => [entry.sourceId, entry.available]), [[ids["alpha.md"], true]]);
    assert.deepEqual(page.quotations, { present: 2, absent: 1, none: 0, sourceMissing: 0 });
    // The same page by the path a link inside another page names; and a link that lost its `.md` still names its document.
    const byPath = await api(`/api/knowledge-pages/page?projectId=${project.id}&tree=wiki&path=${encodeURIComponent("entity/Beta网关.md")}`);
    assert.deepEqual(byPath.body.data.links.filter((/** @type {any} */ link) => link.kind === "source").map((/** @type {any} */ link) => [link.sourceId, link.status]),
      [[ids["beta.txt"], "present"], [ids["gamma.md"], "no_quotation"]]);

    const wikiGraph = (await api(`/api/knowledge-pages/graph?projectId=${project.id}&kind=wiki`)).body.data;
    assert.deepEqual(wikiGraph.nodes.map((/** @type {any} */ node) => [node.id, node.type, node.degree]).sort(), [["concept/Alpha 协议.md", "concept", 3], ["entity/Beta网关.md", "entity", 3], ["index.md", "index", 2]]);
    assert.equal(wikiGraph.links.length, 4);
    assert.ok(wikiGraph.nodes.every((/** @type {any} */ node) => typeof node.sourceId === "string"));
    assert.deepEqual(wikiGraph.nodes.find((/** @type {any} */ node) => node.id === "entity/Beta网关.md").sources.map((/** @type {any} */ entry) => entry.sourceId).sort(), [ids["beta.txt"], ids["gamma.md"]].sort());
    const kgGraph = (await api(`/api/knowledge-pages/graph?projectId=${project.id}&kind=kg`)).body.data;
    assert.deepEqual(kgGraph.nodes.map((/** @type {any} */ node) => [node.id, node.entityType, node.sources[0].sourceId]), [["alpha", "protocol", ids["alpha.md"]], ["beta", "product", ids["beta.txt"]]]);
    assert.deepEqual(kgGraph.links.map((/** @type {any} */ link) => [link.source, link.relation, link.label, link.target, link.evidence[0].sourceId]), [["beta", "implements", "实现", "alpha", ids["beta.txt"]]]);
    // The memory map's reader gets the same files, whole.
    const products = await app.knowledgePages.fetchProducts({ user: { id: user.id }, projectId: project.id });
    assert.deepEqual([products.entities.length, products.pages.length, products.relations.trim().split("\n").length], [2, 3, 1]);

    // ---- 4. a mirror that is run again writes nothing; the hash decides, not the task's "updated" -------------------
    const before = (await api(`/api/sources?projectId=${project.id}&kind=wiki`)).body.data.items.map((/** @type {any} */ item) => item.id).sort();
    await api("/api/knowledge-pages/compile", { method: "POST", body: JSON.stringify({ projectId: project.id }) });
    const second = await compileRound();
    assert.deepEqual([second.wiki.unchanged, second.wiki.created, second.wiki.updated, second.kg.unchanged], [3, 0, 0, 3]);
    assert.deepEqual((await api(`/api/sources?projectId=${project.id}&kind=wiki`)).body.data.items.map((/** @type {any} */ item) => item.id).sort(), before);

    // ---- 5. a person's edit: a ledger revision, then the engine's copy; kept through a recompile that drops it --------
    const mine = "团队备注：周会上确认，同步周期以现场配置为准。";
    const edited = page.markdown.replace("## 相关", `${mine}\n\n## 相关`);
    const stale = await api("/api/knowledge-pages/page", { method: "PUT", body: JSON.stringify({ sourceId: alphaPage.sourceId, markdown: edited, baseSha256: "0".repeat(64) }) });
    assert.deepEqual([stale.status, stale.body.error?.code ?? stale.body.code], [409, "knowledge_page_changed"]);
    const saved = await api("/api/knowledge-pages/page", { method: "PUT", body: JSON.stringify({ sourceId: alphaPage.sourceId, markdown: edited, baseSha256: page.sha256 }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual([saved.body.data.changed, saved.body.data.writeBack, saved.body.data.userBlocks], [true, "written", 1]);
    assert.deepEqual([saved.body.data.page.userEdited, saved.body.data.page.basis, saved.body.data.page.userBlocks[0].text], [true, "user", mine]);
    assert.equal(engine.text(`${roots.wiki}/concept/Alpha 协议.md`), edited);
    await ingest();
    // The engine recompiles and writes its own page again, without the person's paragraph.
    compiles.length = 0;
    await upload("delta.md", "# Delta\n\nDelta 是第四份资料。\n");
    await ingest();
    await syncSources();
    const third = await compileRound();
    assert.match(compiles[0].instruction, /written into the pages by the user by hand/);
    assert.ok(compiles[0].instruction.includes(`page concept/Alpha 协议.md:\n${mine}`));
    assert.deepEqual([third.wiki.restored, third.wiki.updated], [1, 0], "the page was put back to what the ledger held: no new version");
    assert.equal(engine.text(`${roots.wiki}/concept/Alpha 协议.md`), edited, "the engine's copy holds the paragraph again");
    page = (await api(`/api/knowledge-pages/page?sourceId=${saved.body.data.page.sourceId}`)).body.data;
    assert.ok(page.markdown.includes(mine));

    // ---- 6. a document is removed: its pages are labelled at once, the engine's copy goes, a recompile is queued -----
    const beta = await app.sourceService.get(user.id, ids["beta.txt"]);
    const dependents = await api(`/api/sources/${ids["beta.txt"]}/dependents`);
    assert.equal(dependents.status, 200);
    await app.sourceService.remove(user.id, beta.id, { expectedRevision: beta.revision });
    const labelled = (await api(`/api/knowledge-pages/tree?projectId=${project.id}`)).body.data.pages.filter((/** @type {any} */ entry) => entry.labels.stale.length);
    assert.deepEqual(labelled.map((/** @type {any} */ entry) => `${entry.tree}:${entry.path}`).sort(), ["kg:entities/beta.md", "kg:relations.jsonl", "wiki:entity/Beta网关.md"]);
    assert.deepEqual(labelled[0].labels.stale, [{ sourceId: ids["beta.txt"], reason: "removed" }]);
    await syncSources();
    assert.equal(engine.text(`${roots.sources}/${ids["beta.txt"]}.md`), null);
    status = await api(`/api/knowledge-pages?projectId=${project.id}`);
    assert.deepEqual([status.body.data.state, status.body.data.stale], ["queued", 3]);

    // ---- 7. a task the engine forgot loses nothing: what it wrote is mirrored all the same ---------------------------
    script = (request, stub) => {
      if (request.skill.endsWith("/llm-wiki")) stub.put(`${request.to}/entity/Beta网关.md`, wikiV1()["entity/Beta网关.md"].replace(/Beta 网关最多接入[^\n]+\n/, "Beta 网关的规格见原始资料（该来源已不在范围内）。\n"));
    };
    engine.setPollsToFinish(1);
    await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
    await app.knowledgePagesWorker.tick(); // reconcile, mirror, submit
    const running = [...engine.tasks.values()].at(-1);
    await engine.advance(running);
    engine.expire(running.id);
    const fourth = await compileRound();
    assert.deepEqual([fourth.wiki.status, fourth.wiki.updated], ["expired", 1]);
    status = await api(`/api/knowledge-pages?projectId=${project.id}`);
    assert.equal(status.body.data.lastError.code, "knowledge_task_expired");
    // The rewritten page no longer rests on the removed document, and says so by having no label.
    assert.deepEqual((await api(`/api/knowledge-pages/tree?projectId=${project.id}`)).body.data.pages.find((/** @type {any} */ entry) => entry.path === "entity/Beta网关.md").labels.stale, []);

    // ---- 8. at 100 typed pages nothing is submitted, and everything compiled stays --------------------------------
    for (let index = 0; index < 100; index += 1) engine.put(`${roots.wiki}/entity/filler-${index}.md`, `---\ntype: entity\ntitle: Filler ${index}\ndescription: d\n---\n\n# Filler ${index}\n`);
    compiles.length = 0;
    script = (request) => { compiles.push(request); };
    await api("/api/knowledge-pages/compile", { method: "POST", body: JSON.stringify({ projectId: project.id }) });
    const limited = await compileRound();
    assert.equal(limited.wiki, undefined, "no wiki compile was submitted");
    assert.deepEqual(compiles.map((request) => request.skill.split("/").pop()), ["knowledge-graph"]);
    status = await api(`/api/knowledge-pages?projectId=${project.id}`);
    assert.deepEqual([status.body.data.state, status.body.data.limited.wiki, status.body.data.typedPages.wiki >= 100], ["page_limit", true, true]);

    // ---- 9. the engine down: uploads, the list and the pages do not notice; the round waits ------------------------
    engine.setDown(true);
    const offline = await upload("epsilon.md", "# Epsilon\n\n第五份资料。\n");
    await ingest();
    assert.equal((await app.sourceService.get(user.id, offline)).payload.status, "complete");
    assert.equal((await api(`/api/knowledge-pages/page?sourceId=${saved.body.data.page.sourceId}`)).status, 200);
    assert.equal((await api(`/api/knowledge-pages/graph?projectId=${project.id}&kind=kg`)).status, 200);
    assert.equal(await app.sourceSyncWorker.tick(), null, "the push failed and stays queued");
    const waiting = await app.store.database.query("SELECT status, error FROM evimed_product.jobs WHERE user_id=$1 AND kind='ov-resource-sync' AND status='queued'", [user.id]);
    assert.ok((waiting.rowCount ?? 0) >= 1);
    engine.setDown(false);
    await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND kind='ov-resource-sync' AND status='queued'", [user.id]);
    await syncSources();
    assert.ok(engine.text(`${roots.sources}/${offline}.md`));
    assert.ok(app.knowledgePages.status().rounds >= 5);
  } finally {
    if (listening) await app.close();
    if (user) await app.store.deleteUser?.(user.id).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});
