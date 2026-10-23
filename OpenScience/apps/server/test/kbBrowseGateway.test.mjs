import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { knowledgeGraphToGraph } from "@evimed/domain";

import { KB_BROWSE_GATEWAY_PATH, KB_BROWSE_OPS, KB_BROWSE_ROOTS, createKbBrowseGatewayHandler, kbBrowseGatewayProviderUrl } from "../src/kbBrowseGateway.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { openVikingUserId } from "../src/openVikingLayout.mjs";
import { OpenVikingResources } from "../src/openVikingResources.mjs";
import { createOpenVikingStub } from "./helpers/openVikingResourcesStub.mjs";

// A real compiled tree (lab/knowledge, 2026-10-12): eight project documents, the wiki `llm-wiki` wrote from them and
// the graph `knowledge-graph` did. Its addresses are the lab's; a compile writes them under the project it ran for,
// so they are moved under this test's project the same way.
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/domain/test/fixtures/compiled-knowledge");
const LAB_PROJECT = "viking://user/ulab0001/resources/p/pmix01";
const KICKOFF = "src_488bc670e5038b073483e42cc1f37027";
const README = "src_4d515bae3e64e62ddb71a8f69cc89728";
const LIBRARY_DOC = `src_${"d".repeat(32)}`;
const TITLES = { [KICKOFF]: "拾页书店库存系统 启动会纪要", [README]: "shiye-inventory README" };

/** Every file under a fixture directory, by its path inside it. @param {string} name */
async function fixtureFiles(name) {
  /** @type {{ path: string, content: string }[]} */
  const files = [];
  /** @param {string} relative */
  const walk = async (relative) => {
    for (const entry of await readdir(path.join(FIXTURES, name, relative), { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.name !== "_listing.json") files.push({ path: rel, content: await readFile(path.join(FIXTURES, name, rel), "utf8") });
    }
  };
  await walk("");
  return files;
}

const tokens = {
  "runtime-token": { userId: "user-1", projectId: "project-1" },
  "sibling-project": { userId: "user-1", projectId: "project-2" },
  "someone-else": { userId: "user-2", projectId: "project-1" },
};
const runtimeManager = {
  assertActiveModelGatewayToken(token) {
    if (!Object.hasOwn(tokens, token)) throw new Error("inactive");
    return { ...tokens[token] };
  },
};

/** The ledger's side of a document: this project's own, by id. */
const sources = {
  async get(userId, id) {
    if (userId !== "user-1" || !Object.hasOwn(TITLES, id)) throw Object.assign(new Error("not found"), { status: 404, code: "source_not_found" });
    return { id, projectId: "project-1", deletedAt: null, payload: { title: TITLES[id] } };
  },
};
const library = { async searchScope(userId) { return userId === "user-1" ? [{ sourceId: LIBRARY_DOC, title: "跨项目的抗凝指南" }] : []; } };

async function engine() {
  const stub = createOpenVikingStub();
  const resources = new OpenVikingResources({ client: new OpenVikingClient(
    { openVikingUrl: "http://openviking.test", openVikingApiKey: "stub-key", openVikingAccount: "evimed", openVikingRequestTimeoutMs: 5000 }, { fetchImpl: stub.fetch }) });
  const roots = resources.roots("user-1", "project-1");
  for (const [tree, base] of [["mix-wiki", roots.wiki], ["mix-kg", roots.kg], ["mix-sources", roots.sources]]) {
    for (const file of await fixtureFiles(tree)) stub.put(`${base}/${file.path}`, file.content.replaceAll(LAB_PROJECT, roots.project));
  }
  // What the engine writes beside pages and never shows: it holds the same words a page does.
  stub.put(`${roots.wiki}/.abstract.md`, "sidecar: 总部要求今年压到 1.5% 以内");
  stub.put(`${roots.wiki}/concept/.overview.md`, "sidecar: 1.5% 以内");
  stub.put(`${roots.library}/${LIBRARY_DOC}.md`, "# 抗凝指南\n\n利伐沙班 15 mg 每日一次。\n");
  // What this project's token must never reach: a sibling project of the same account, and another account.
  stub.put(`${resources.roots("user-1", "project-2").wiki}/index.md`, "---\ntype: index\ntitle: 另一个项目\n---\n\nSIBLING-SECRET\n");
  stub.put(`${resources.roots("user-2", "project-1").wiki}/index.md`, "---\ntype: index\ntitle: 别人的项目\n---\n\nFOREIGN-SECRET\n");
  return { stub, resources, roots };
}

async function withGateway(t, { config = {}, resources, dependencies = {} }) {
  const failures = [];
  const handler = createKbBrowseGatewayHandler({ ovKnowledgeEnabled: true, ...config }, runtimeManager,
    { resources, sources, library, titleOf: (source) => source.payload.title, budgetMs: 1_000, ...dependencies });
  const server = createServer((req, res) => { void handler(req, res, (failure) => failures.push(failure)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const call = async (body, { token = "runtime-token", method = "POST", route = KB_BROWSE_GATEWAY_PATH } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  /** An answer that must be one: its data, checked for the one thing no answer may carry. */
  const ok = async (body, options) => {
    const response = await call(body, options);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assertNoAddress(response.body);
    return response.body.data;
  };
  return { call, ok, failures };
}

/** No answer names an engine address or either of the hashed segments one is built from. @param {unknown} body */
function assertNoAddress(body) {
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /viking:\/\//, "an engine address reached the runtime");
  assert.doesNotMatch(text, /\b[up]-[a-f0-9]{24}\b/, "a hashed account or project segment reached the runtime");
}

test("no token, a stale token, another route or another method is refused before the engine is asked", async (t) => {
  const { stub, resources } = await engine();
  const { call } = await withGateway(t, { resources });
  assert.equal((await call({ op: "overview" }, { token: "" })).body.code, "kb_browse_gateway_token_missing");
  assert.equal((await call({ op: "overview" }, { token: "nobody" })).body.code, "kb_browse_gateway_token_invalid");
  assert.equal((await call({ op: "overview" }, { route: `${KB_BROWSE_GATEWAY_PATH}/x` })).status, 404);
  assert.equal((await call(null, { method: "GET" })).status, 404);
  assert.equal(stub.requests.length, 0);
});

test("a request it cannot take is named, field by field, and never becomes an engine request", async (t) => {
  const { stub, resources } = await engine();
  const { call } = await withGateway(t, { resources });
  for (const [body, code] of [
    ["not json", "kb_browse_request_invalid"],
    [{ op: "list", uri: "viking://user/x/resources" }, "kb_browse_request_invalid"],
    [{ op: "list", sessionId: "s" }, "kb_browse_request_invalid"],
    [{}, "kb_browse_op_invalid"],
    [{ op: "write" }, "kb_browse_op_invalid"],
    [{ op: "list", root: "memories" }, "kb_browse_root_invalid"],
    [{ op: "list", root: "viking://user/x/resources/p/y/wiki" }, "kb_browse_root_invalid"],
    [{ op: "list", path: "../kg" }, "kb_browse_path_invalid"],
    [{ op: "list", path: "concept/../../kg" }, "kb_browse_path_invalid"],
    [{ op: "read", path: "/etc/passwd" }, "kb_browse_path_invalid"],
    [{ op: "read", path: "concept\\盘点差异率.md" }, "kb_browse_path_invalid"],
    [{ op: "read", path: "concept/\u0000.md" }, "kb_browse_path_invalid"],
    [{ op: "read", path: `${"x".repeat(481)}` }, "kb_browse_path_invalid"],
    [{ op: "read", path: 7 }, "kb_browse_path_invalid"],
    // The engine's sidecars are not pages.
    [{ op: "read", path: ".abstract.md" }, "kb_browse_path_invalid"],
    [{ op: "read", path: "concept/.overview.md" }, "kb_browse_path_invalid"],
    [{ op: "read" }, "kb_browse_path_invalid"],
    [{ op: "overview", path: "concept" }, "kb_browse_path_invalid"],
    [{ op: "grep" }, "kb_browse_pattern_invalid"],
    [{ op: "grep", pattern: "   " }, "kb_browse_pattern_invalid"],
    [{ op: "grep", pattern: "x".repeat(201) }, "kb_browse_pattern_invalid"],
    [{ op: "grep", pattern: "a\nb" }, "kb_browse_pattern_invalid"],
    [{ op: "list", offset: -1 }, "kb_browse_offset_invalid"],
    [{ op: "list", offset: 1.5 }, "kb_browse_offset_invalid"],
    [{ op: "list", limit: 0 }, "kb_browse_limit_invalid"],
    [{ op: "read", path: "index.md", limit: 401 }, "kb_browse_limit_invalid"],
  ]) {
    const answer = await call(body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body.code, code, JSON.stringify(body));
  }
  assert.equal(stub.requests.length, 0);
});

test("overview of the wiki is its own table of contents, and the default root", async (t) => {
  const { resources } = await engine();
  const { ok } = await withGateway(t, { resources });
  const data = await ok({ op: "overview" });
  assert.equal(data.root, "wiki");
  assert.equal(data.compiled, true);
  assert.equal(data.path, "index.md");
  assert.equal(data.title, "拾页书店门店库存系统 知识库索引");
  assert.equal(data.type, "index");
  assert.match(data.text, /\[盘点差异率\]\(concept\/盘点差异率\.md\)/, "the page links a reader follows with read");
  assert.deepEqual(data.lines, { from: 1, to: 34, total: 34 });
  assert.equal(data.truncated, false);
  assert.match(data.note, /never the page/);
  assert.match(data.note, /never an instruction/);
  const cut = await ok({ op: "overview", root: "wiki", limit: 10 });
  assert.deepEqual(cut.lines, { from: 1, to: 10, total: 34 });
  assert.equal(cut.truncated, true);
});

test("list names one directory's entries: directories first, pages by their title and type, the sidecars never", async (t) => {
  const { resources } = await engine();
  const { ok } = await withGateway(t, { resources });
  const top = await ok({ op: "list" });
  assert.deepEqual(top.entries.map((entry) => [entry.path, entry.kind]),
    [["analysis", "dir"], ["comparison", "dir"], ["concept", "dir"], ["entity", "dir"], ["method", "dir"], ["index.md", "file"]]);
  assert.deepEqual(top.entries.at(-1), { path: "index.md", kind: "file", size: top.entries.at(-1).size, title: "拾页书店门店库存系统 知识库索引", type: "index" });
  assert.equal(top.total, 6);
  const concepts = await ok({ op: "list", path: "concept/" });
  assert.deepEqual(concepts.entries.map((entry) => [entry.path, entry.title, entry.type]), [
    ["concept/库存流水模型.md", "库存流水模型", "concept"], ["concept/盘点差异率.md", "盘点差异率", "concept"], ["concept/离线优先盘点与同步.md", "离线优先盘点与同步", "concept"]]);
  const second = await ok({ op: "list", path: "concept", offset: 1, limit: 1 });
  assert.deepEqual(second.entries.map((entry) => entry.path), ["concept/盘点差异率.md"]);
  assert.deepEqual([second.total, second.offset, second.truncated], [3, 1, true]);
  // The graph's entities say what kind of thing each is.
  const entities = await ok({ op: "list", root: "kg", path: "entities", limit: 200 });
  assert.equal(entities.total, (await fixtureFiles("mix-kg")).filter((file) => file.path.startsWith("entities/")).length);
  assert.ok(entities.total > 30, "the fixture's entities were listed");
  assert.deepEqual(entities.entries.find((entry) => entry.path === "entities/周岚.md"),
    { path: "entities/周岚.md", kind: "file", size: entities.entries.find((entry) => entry.path === "entities/周岚.md").size, title: "周岚", type: "entity", entityType: "person" });
});

test("tree is the subtree, bounded at 300 entries and saying when it was cut", async (t) => {
  const { stub, resources, roots } = await engine();
  const { ok } = await withGateway(t, { resources });
  const tree = await ok({ op: "tree" });
  assert.equal(tree.entries.filter((entry) => entry.kind === "dir").length, 5);
  assert.equal(tree.entries.filter((entry) => entry.kind === "file").length, 13);
  assert.equal(tree.truncated, false);
  assert.ok(tree.entries.every((entry) => entry.kind === "dir" || (entry.title && entry.type)), "every page is named");
  assert.ok(!tree.entries.some((entry) => entry.path.split("/").some((part) => part.startsWith("."))));
  const sub = await ok({ op: "tree", path: "method" });
  assert.deepEqual(sub.entries.map((entry) => entry.path), ["method/门店库存系统交付里程碑.md", "method/门店库存系统遗留问题与待办.md"]);
  for (let index = 0; index < 320; index += 1) stub.put(`${roots.wiki}/bulk/page-${String(index).padStart(3, "0")}.txt`, "x");
  const large = await ok({ op: "tree", path: "bulk" });
  assert.equal(large.entries.length, 300);
  assert.equal(large.truncated, true);
  assert.match(large.note, /first 300 entries/);
});

test("read gives a page by lines, its documents by id and title, and no address", async (t) => {
  const { stub, resources, roots } = await engine();
  const { ok, call } = await withGateway(t, { resources });
  const page = await ok({ op: "read", path: "concept/盘点差异率.md" });
  assert.equal(page.title, "盘点差异率");
  assert.equal(page.type, "concept");
  assert.equal(page.lines.from, 1);
  assert.equal(page.lines.to, page.lines.total);
  assert.equal(page.truncated, false);
  assert.match(page.text, new RegExp(`\\[启动会纪要\\]\\(source:${KICKOFF} "总部要求今年压到 1\\.5% 以内"\\)`), "a source link keeps its quotation and names the document by id");
  assert.deepEqual(page.documents.find((document) => document.sourceId === KICKOFF), { sourceId: KICKOFF, title: TITLES[KICKOFF] });
  assert.deepEqual(page.documents.find((document) => document.sourceId === README), { sourceId: README, title: TITLES[README] });
  assert.equal(page.documents.length, 6, "every document the page names, titled or not");
  const middle = await ok({ op: "read", path: "concept/盘点差异率.md", offset: 6, limit: 3 });
  assert.deepEqual(middle.lines, { from: 7, to: 9, total: page.lines.total });
  assert.equal(middle.truncated, true);
  assert.equal(middle.text, page.text.split("\n").slice(6, 9).join("\n"));
  const past = await ok({ op: "read", path: "concept/盘点差异率.md", offset: 5000 });
  assert.deepEqual([past.text, past.lines.from, past.lines.to, past.truncated], ["", 0, 0, false]);

  // A relation line of the graph is evidence addresses in JSON: they come back as ids too.
  const relations = await ok({ op: "read", root: "kg", path: "relations.jsonl", limit: 2 });
  assert.match(relations.text, /"evidence":\["source:src_df149068671ff3e8a5ee48080b0c967a"\]/);
  assert.equal(relations.lines.total, 96);

  // Addresses a compile may write that are not documents: one inside this project's wiki, one outside the project.
  stub.put(`${roots.wiki}/entity/links.md`, `---\ntype: entity\ntitle: 链接\n---\n\n见 [协议](${roots.wiki}/concept/盘点差异率.md) 与 [别处](viking://user/u-0123456789abcdef01234567/memories/profile.md)。\n`);
  const links = await ok({ op: "read", path: "entity/links.md" });
  assert.match(links.text, /\[协议\]\(wiki:concept\/盘点差异率\.md\)/);
  assert.match(links.text, /\[别处\]\(\(internal address omitted\)\)/);
  // A root counts whole: a tree whose name merely begins like one is not that root.
  stub.put(`${roots.wiki}/entity/older.md`, `---\ntype: entity\ntitle: 旧版\n---\n\n见 [旧页](${roots.wiki}-q1/concept/x.md)。\n`);
  assert.match((await ok({ op: "read", path: "entity/older.md" })).text, /\[旧页\]\(\(internal address omitted\)\)/);
  // A graph entity cites documents in its front matter by address and in its body by bare id: both are named.
  const person = await ok({ op: "read", root: "kg", path: "entities/周岚.md" });
  assert.equal(person.title, "周岚");
  assert.ok(person.documents.some((document) => document.sourceId === "src_df149068671ff3e8a5ee48080b0c967a"), "the id only the body cites");
  assert.ok(person.documents.some((document) => document.sourceId === KICKOFF && document.title === TITLES[KICKOFF]));

  const missing = await call({ op: "read", path: "concept/不存在.md" });
  assert.deepEqual([missing.status, missing.body.code], [404, "kb_browse_not_found"]);
  const directory = await call({ op: "read", path: "concept" });
  assert.deepEqual([directory.status, directory.body.code], [400, "kb_browse_path_invalid"]);
  const file = await call({ op: "list", path: "index.md" });
  assert.deepEqual([file.status, file.body.code], [400, "kb_browse_path_invalid"]);
  const nowhere = await call({ op: "list", path: "nowhere" });
  assert.deepEqual([nowhere.status, nowhere.body.code], [404, "kb_browse_not_found"]);
});

test("a document is read by its lines and named by its id and title; one enormous line is cut and said to be", async (t) => {
  const { stub, resources, roots } = await engine();
  const { ok } = await withGateway(t, { resources });
  const document = await ok({ op: "read", root: "sources", path: `${KICKOFF}.md`, limit: 5 });
  assert.equal(document.sourceId, KICKOFF);
  assert.equal(document.title, TITLES[KICKOFF]);
  assert.deepEqual([document.lines.from, document.lines.to, document.lines.total], [1, 5, 34]);
  assert.match(document.note, /kb_search/);
  assert.equal(document.documents, undefined);
  const untitled = await ok({ op: "read", root: "sources", path: "src_3191c1be80141b92e13d1f3373520072.md", limit: 1 });
  assert.equal(untitled.sourceId, "src_3191c1be80141b92e13d1f3373520072");
  assert.equal(untitled.title, undefined, "a document the ledger does not name is still read, by its id");
  const shared = await ok({ op: "read", root: "library", path: `${LIBRARY_DOC}.md` });
  assert.equal(shared.title, "跨项目的抗凝指南");
  assert.match(shared.text, /利伐沙班 15 mg/);
  stub.put(`${roots.sources}/src_${"e".repeat(32)}.md`, `${"字".repeat(100_000)}\nsecond line\n`);
  const wide = await ok({ op: "read", root: "sources", path: `src_${"e".repeat(32)}.md` });
  assert.equal(wide.text.length, 80_000);
  assert.deepEqual([wide.lines.from, wide.lines.to, wide.lines.total, wide.truncated, wide.lineCut], [1, 1, 2, true, true]);
});

test("grep finds a literal as written, under the root or one path, at most 50 lines, never in a sidecar", async (t) => {
  const { stub, resources } = await engine();
  const { ok } = await withGateway(t, { resources });
  const found = await ok({ op: "grep", pattern: "1.5%" });
  assert.ok(found.count >= 2);
  assert.ok(found.matches.every((match) => match.text.includes("1.5%") && Number.isInteger(match.line) && match.line > 0));
  assert.ok(found.matches.some((match) => match.path === "concept/盘点差异率.md"));
  assert.ok(!found.matches.some((match) => match.path.includes(".abstract") || match.path.includes(".overview")), "the sidecars hold the same words and are not matched");
  assert.ok(found.documents.some((document) => document.sourceId === KICKOFF && document.title === TITLES[KICKOFF]));
  // The pattern is a literal: the engine was handed it escaped, so `.` matched a dot and nothing else.
  const sent = stub.requests.filter((request) => request.path === "/api/v1/search/grep").at(-1);
  assert.equal(sent.body.pattern, "1\\.5%");
  assert.equal((await ok({ op: "grep", pattern: "1x5%" })).count, 0);
  const scoped = await ok({ op: "grep", pattern: "1.5%", path: "method" });
  assert.ok(scoped.matches.every((match) => match.path.startsWith("method/")));
  const inDocuments = await ok({ op: "grep", root: "sources", pattern: "readme" });
  assert.ok(inDocuments.count >= 1, "case is not part of the literal");
  assert.ok(inDocuments.matches.some((match) => match.sourceId === README && match.title === TITLES[README] && match.path === `${README}.md`));
  const many = await ok({ op: "grep", root: "kg", pattern: "店" });
  assert.equal(many.matches.length, 50);
  assert.equal(many.truncated, true);
  const none = await ok({ op: "grep", pattern: "一句任何页面都没有的话" });
  assert.deepEqual([none.count, none.truncated], [0, false]);
  assert.match(none.note, /kb_search/);
});

test("overview of the graph is its counts, read by the domain's own reader; of the documents, their titles", async (t) => {
  const { resources } = await engine();
  const { ok } = await withGateway(t, { resources });
  const expected = knowledgeGraphToGraph(await fixtureFiles("mix-kg"));
  const graph = await ok({ op: "overview", root: "kg" });
  assert.equal(graph.compiled, true);
  assert.equal(graph.entities, expected.nodes.length);
  assert.equal(graph.relations, expected.links.length);
  assert.equal(graph.entityTypes.reduce((sum, row) => sum + row.count, 0), expected.nodes.length);
  assert.ok(graph.entityTypes.length > 1 && graph.entityTypes[0].count >= graph.entityTypes[1].count);
  assert.deepEqual(graph.relationCounts, expected.relationCounts.slice(0, 40));
  assert.equal(graph.topEntities.length, 30);
  assert.ok(graph.topEntities[0].degree >= graph.topEntities[1].degree);
  assert.match(graph.topEntities[0].path, /^entities\/.+\.md$/);
  assert.equal((await ok({ op: "overview", root: "kg", limit: 5 })).topEntities.length, 5);

  const documents = await ok({ op: "overview", root: "sources" });
  assert.equal(documents.total, 8);
  assert.deepEqual(documents.documents.find((document) => document.sourceId === KICKOFF),
    { path: `${KICKOFF}.md`, size: documents.documents.find((document) => document.sourceId === KICKOFF).size, sourceId: KICKOFF, title: TITLES[KICKOFF] });
  assert.ok(documents.documents.every((document) => /^src_[a-f0-9]{32}$/.test(document.sourceId)));
  const shared = await ok({ op: "overview", root: "library" });
  assert.deepEqual(shared.documents.map((document) => [document.sourceId, document.title]), [[LIBRARY_DOC, "跨项目的抗凝指南"]]);
  const listed = await ok({ op: "list", root: "sources", limit: 3 });
  assert.deepEqual([listed.entries.length, listed.total, listed.truncated], [3, 8, true]);
  assert.ok(listed.entries.every((entry) => entry.sourceId && entry.path === `${entry.sourceId}.md`));
});

test("a token reaches its own project of its own account and nothing beside it", async (t) => {
  const { stub, resources } = await engine();
  const { ok, call } = await withGateway(t, { resources });
  // The sibling project and the other account hold a wiki; this project's token is answered from its own.
  assert.doesNotMatch(JSON.stringify(await ok({ op: "tree" })), /SECRET|另一个项目|别人的项目/);
  assert.doesNotMatch(JSON.stringify(await ok({ op: "grep", pattern: "SECRET" })), /SIBLING|FOREIGN/);
  const sibling = await ok({ op: "overview" }, { token: "sibling-project" });
  assert.match(sibling.text, /SIBLING-SECRET/, "the sibling's own token reads the sibling's wiki");
  assert.doesNotMatch(sibling.text, /拾页|FOREIGN/);
  const before = stub.requests.length;
  const foreign = await ok({ op: "overview" }, { token: "someone-else" });
  assert.match(foreign.text, /FOREIGN-SECRET/);
  assert.ok(stub.requests.slice(before).every((request) => request.user === openVikingUserId("user-2")), "the engine is asked as the token's account");
  // The address is built here, and one outside the project's scope is refused before the engine hears of it.
  const astray = Object.create(resources, { roots: { value: () => resources.roots("user-2", "project-1") }, inScope: { value: (...args) => resources.inScope(...args) } });
  const guarded = await withGateway(t, { resources: astray });
  const asked = stub.requests.length;
  for (const body of [{ op: "overview" }, { op: "list" }, { op: "tree" }, { op: "read", path: "index.md" }, { op: "grep", pattern: "SECRET" }]) {
    const refused = await guarded.call(body);
    assert.deepEqual([refused.status, refused.body.code], [400, "kb_browse_path_invalid"], JSON.stringify(body));
  }
  assert.equal(stub.requests.length, asked);
  assert.equal((await call({ op: "read", path: "../../p-000000000000000000000000/wiki/index.md" })).body.code, "kb_browse_path_invalid");
});

test("a project with nothing compiled or pushed is an empty answer that says what to use instead", async (t) => {
  const stub = createOpenVikingStub();
  const resources = new OpenVikingResources({ client: new OpenVikingClient(
    { openVikingUrl: "http://openviking.test", openVikingApiKey: "stub-key", openVikingAccount: "evimed", openVikingRequestTimeoutMs: 5000 }, { fetchImpl: stub.fetch }) });
  const { ok } = await withGateway(t, { resources });
  const wiki = await ok({ op: "overview" });
  assert.deepEqual([wiki.compiled, wiki.text], [false, ""]);
  assert.match(wiki.note, /Nothing has been compiled here yet/);
  assert.deepEqual((await ok({ op: "list" })).entries, []);
  assert.deepEqual((await ok({ op: "tree", root: "kg" })).entries, []);
  const graph = await ok({ op: "overview", root: "kg" });
  assert.deepEqual([graph.compiled, graph.entities, graph.relations], [false, 0, 0]);
  const documents = await ok({ op: "overview", root: "sources" });
  assert.deepEqual([documents.documents, documents.total], [[], 0]);
  assert.match(documents.note, /kb_search/);
  assert.deepEqual((await ok({ op: "grep", root: "library", pattern: "x" })).matches, []);
});

test("switched off, or with no engine, it says disabled and what the run can do instead", async (t) => {
  const { stub, resources } = await engine();
  const off = await withGateway(t, { config: { ovKnowledgeEnabled: false }, resources });
  const answer = await off.call({ op: "overview" });
  assert.equal(answer.status, 503);
  assert.equal(answer.body.code, "kb_browse_disabled");
  assert.match(answer.body.error, /kb_search/);
  assert.deepEqual(off.failures, [{ code: "kb_browse_disabled", status: 503 }]);
  const unconfigured = await withGateway(t, { resources: new OpenVikingResources({ client: new OpenVikingClient({}, { fetchImpl: stub.fetch }) }) });
  assert.equal((await unconfigured.call({ op: "overview" })).body.code, "kb_browse_disabled");
  assert.equal((await (await withGateway(t, { resources: null })).call({ op: "overview" })).body.code, "kb_browse_disabled");
  assert.equal(stub.requests.length, 0);
});

test("an engine that is down or slow is a named answer, and its own words never reach the runtime", async (t) => {
  const { stub, resources } = await engine();
  const down = await withGateway(t, { resources });
  stub.setDown(true);
  for (const body of [{ op: "overview" }, { op: "list" }, { op: "tree" }, { op: "read", path: "index.md" }, { op: "grep", pattern: "x" }, { op: "overview", root: "kg" }]) {
    const failed = await down.call(body);
    assert.deepEqual([failed.status, failed.body.code], [503, "kb_browse_unavailable"], JSON.stringify(body));
    assert.match(failed.body.error, /kb_search/);
    assert.doesNotMatch(JSON.stringify(failed.body), /ECONNREFUSED|memory_index|openviking\.test|api\/v1/);
  }
  assert.equal(down.failures.length, 6);
  stub.setDown(false);
  const slow = await withGateway(t, { resources: Object.create(resources, { listAll: { value: () => new Promise(() => {}) } }) });
  const timedOut = await slow.call({ op: "list" });
  assert.deepEqual([timedOut.status, timedOut.body.code], [504, "kb_browse_timeout"]);
});

test("a title the ledger cannot give costs the title, never the answer", async (t) => {
  const { resources } = await engine();
  const { ok } = await withGateway(t, { resources, dependencies: {
    sources: { async get() { throw new Error("database down"); } }, library: { async searchScope() { throw new Error("database down"); } } } });
  const documents = await ok({ op: "overview", root: "sources" });
  assert.equal(documents.total, 8);
  assert.ok(documents.documents.every((document) => document.sourceId && document.title === undefined));
  const page = await ok({ op: "read", path: "concept/盘点差异率.md" });
  assert.deepEqual(page.documents.find((document) => document.sourceId === KICKOFF), { sourceId: KICKOFF });
});

test("a removed source is excluded immediately even while its engine copy remains", async (t) => {
  const { resources } = await engine();
  const { call, ok } = await withGateway(t, { resources, dependencies: {
    sources: { async get(userId, id) {
      if (id === KICKOFF) throw Object.assign(new Error("removed"), { status: 404, code: "source_not_found" });
      return sources.get(userId, id);
    } },
  } });
  assert.equal((await call({ op: "read", root: "sources", path: `${KICKOFF}.md` })).status, 404);
  const listing = await ok({ op: "list", root: "sources" });
  assert.ok(!listing.entries.some((entry) => entry.sourceId === KICKOFF));
  const matches = await ok({ op: "grep", root: "sources", pattern: "1.5%" });
  assert.ok(!matches.matches.some((entry) => entry.sourceId === KICKOFF));
});

test("a withdrawn personal-library copy is not readable through a stale engine path", async (t) => {
  const { resources } = await engine();
  const { call } = await withGateway(t, { resources, dependencies: { library: { async searchScope() { return []; } } } });
  assert.equal((await call({ op: "read", root: "library", path: `${LIBRARY_DOC}.md` })).status, 404);
});

test("document authorization fails closed when the source ledger is unavailable", async (t) => {
  const { resources } = await engine();
  const { call } = await withGateway(t, { resources, dependencies: { sources: { async get() { throw new Error("database down"); } } } });
  assert.equal((await call({ op: "read", root: "sources", path: `${KICKOFF}.md` })).status, 503);
});

test("what it returns passes through the evaluation isolation, as a knowledge-base answer", async (t) => {
  const { resources } = await engine();
  const seen = [];
  const { ok } = await withGateway(t, { resources, dependencies: { evaluationIsolation: {
    async filter(identity, gateway, value) { seen.push([identity.userId, identity.projectId, gateway]); return { ...value, filtered: true }; } } } });
  assert.equal((await ok({ op: "overview" })).filtered, true);
  assert.deepEqual(seen, [["user-1", "project-1", "knowledge-base"]]);
});

test("a runaway loop is bounded per project, not per request", async (t) => {
  const { resources } = await engine();
  const { call } = await withGateway(t, { resources });
  let last;
  for (let attempt = 0; attempt < 61; attempt += 1) last = await call({ op: "list", root: "library" });
  assert.equal(last.status, 429);
  assert.equal(last.body.code, "kb_browse_rate_limited");
  assert.equal((await call({ op: "list", root: "library" }, { token: "sibling-project" })).status, 200, "another project has its own window");
});

test("the runtime learns the route only when the knowledge switch is on, an engine is named and the address is sound", () => {
  const search = "http://open-science-web:8787/internal/kb/v1/search";
  const on = { ovKnowledgeEnabled: true, openVikingUrl: "http://openviking:1933", kbSearchGatewayInternalUrl: search };
  assert.equal(kbBrowseGatewayProviderUrl(on), "http://open-science-web:8787/internal/kb/v1/browse");
  // It follows the search gateway's address and not its switch: browsing reads the engine, not the search index.
  assert.equal(kbBrowseGatewayProviderUrl({ ...on, kbSearchEnabled: false }), "http://open-science-web:8787/internal/kb/v1/browse");
  assert.equal(kbBrowseGatewayProviderUrl({ ...on, ovKnowledgeEnabled: false }), "");
  assert.equal(kbBrowseGatewayProviderUrl({ ...on, openVikingUrl: "" }), "");
  assert.equal(kbBrowseGatewayProviderUrl({ ...on, kbSearchGatewayInternalUrl: "http://user:fake@host/internal/kb/v1/search" }), "");
  assert.equal(kbBrowseGatewayProviderUrl({ ...on, kbSearchGatewayInternalUrl: "not a url" }), "");
});

test("the runtime's tool offers exactly the operations and roots this gateway takes", async () => {
  const tool = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../runtime/mcp/evimed-research/kb_browse.py"), "utf8");
  /** @param {string} name */
  const tuple = (name) => [...(new RegExp(`^${name} = \\(([^)]*)\\)`, "m").exec(tool)?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tuple("OPS"), [...KB_BROWSE_OPS]);
  assert.deepEqual(tuple("ROOTS"), [...KB_BROWSE_ROOTS]);
  assert.match(tool, /EVIMED_KB_BROWSE_GATEWAY_URL/);
});
