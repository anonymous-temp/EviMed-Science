// The Resources and Compile half of the OpenViking client, held to what a running v0.5.0 server answered.
//
// Every response here is a recorded one (`packages/contracts/openviking/fixtures/knowledge/`, off the lab instance of
// 2026-10-12, `provenance.json` beside them): served over real HTTP, so a parse that only works on a hand-shaped
// object fails, and what the client asked is asserted against what the recording was asked.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";

import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { openVikingPeerId, openVikingUserId } from "../src/openVikingLayout.mjs";
import { OpenVikingResources, compileIdempotencyKey, escapeGrepPattern, resourceTags } from "../src/openVikingResources.mjs";

const fixtureUrl = (/** @type {string} */ name) => new URL(`../../../packages/contracts/openviking/fixtures/knowledge/${name}`, import.meta.url);
const fixture = async (/** @type {string} */ name) => JSON.parse(await readFile(fixtureUrl(`${name}.json`), "utf8"));
const provenance = (await fixture("provenance")).fixtures;

const USER = "user-contract";
const PROJECT = "project-contract";
/** The recorded project root, and ours: a recorded response is re-addressed to the caller so paths line up. */
const RECORDED_ROOT = "viking://user/u-0f1e2d3c4b5a69788796a5b4/resources/p/p-3c2b1a0998877665";
const OUR_ROOT = `viking://user/${openVikingUserId(USER)}/resources/p/${openVikingPeerId(PROJECT)}`;
const readdress = (/** @type {unknown} */ value) => JSON.parse(JSON.stringify(value).replaceAll(RECORDED_ROOT, OUR_ROOT));

/**
 * Serve recorded responses and keep what was asked.
 * @param {(request: { method: string, path: string, query: URLSearchParams, body: any, headers: http.IncomingHttpHeaders }) => { status?: number, body?: unknown, bytes?: Buffer }} answer
 * @param {(context: { resources: OpenVikingResources, seen: any[] }) => Promise<void>} run
 */
async function withEngine(answer, run) {
  /** @type {any[]} */
  const seen = [];
  const server = http.createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://engine");
      const raw = Buffer.concat(chunks);
      const json = String(request.headers["content-type"] ?? "").startsWith("application/json");
      const asked = { method: request.method ?? "GET", path: url.pathname, query: url.searchParams, body: json && raw.length ? JSON.parse(raw.toString("utf8")) : raw.length ? raw : null, headers: request.headers };
      seen.push(asked);
      const reply = answer(asked);
      if (reply.bytes) { response.writeHead(reply.status ?? 200, { "Content-Type": "application/octet-stream" }); response.end(reply.bytes); return; }
      response.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(reply.body ?? null));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(null)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const client = new OpenVikingClient({ openVikingUrl: `http://127.0.0.1:${port}`, openVikingApiKey: "recorded-against-a-real-server", openVikingAccount: "evimed", openVikingRequestTimeoutMs: 5_000 });
  try { await run({ resources: new OpenVikingResources({ client }), seen }); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(() => resolve(null))); }
}

test("the layout: one subtree per project, a library beside them, and nothing outside either is in scope", async () => {
  await withEngine(() => ({ body: null }), async ({ resources }) => {
    const roots = resources.roots(USER, PROJECT);
    assert.equal(roots.sources, `${OUR_ROOT}/sources`);
    assert.equal(roots.wiki, `${OUR_ROOT}/wiki`);
    assert.equal(roots.kg, `${OUR_ROOT}/kg`);
    assert.equal(roots.library, `viking://user/${openVikingUserId(USER)}/resources/library`);
    assert.equal(resources.sourceUri(USER, PROJECT, "src_00000000000000000000000000000001"), `${OUR_ROOT}/sources/src_00000000000000000000000000000001.md`);
    assert.throws(() => resources.sourceUri(USER, PROJECT, "../etc"), { code: "source_id_invalid" });
    for (const inside of [roots.project, `${roots.wiki}/entity/Alpha 协议.md`, roots.library, `${roots.library}/src_00000000000000000000000000000001.md`]) {
      assert.equal(resources.inScope(USER, PROJECT, inside), true, inside);
    }
    for (const outside of [
      `viking://user/${openVikingUserId(USER)}/resources/p/${openVikingPeerId("another-project")}/wiki`, `viking://user/${openVikingUserId("another-user")}/resources/library`,
      `viking://user/${openVikingUserId(USER)}/memories`, `${roots.wiki}/../../x`, `${roots.project}-evil/a.md`, "viking://agent/skills", "https://example.org", "",
    ]) assert.equal(resources.inScope(USER, PROJECT, outside), false, outside);
  });
});

test("a document is pushed as <srcId>.md with vectors only and its tags; one that is there already is replaced", async () => {
  const created = await fixture("content-write-create");
  const exists = await fixture("content-write-create-exists");
  let first = true;
  await withEngine(() => {
    if (first) { first = false; return { body: created }; }
    return { body: created };
  }, async ({ resources, seen }) => {
    const uri = resources.sourceUri(USER, PROJECT, "src_00000000000000000000000000000001");
    const pushed = await resources.pushSource(USER, uri, "# Alpha\n\ntext\n", { sourceId: "src_00000000000000000000000000000001", sha: "a".repeat(64), docType: "paper" });
    assert.equal(pushed.bytes, 342);
    assert.equal(seen[0].path, provenance["content-write-create"].path);
    assert.deepEqual(seen[0].body, { uri, content: "# Alpha\n\ntext\n", wait: true, processing_mode: "vectors_only",
      tags: ["src=src_00000000000000000000000000000001", `sha=${"a".repeat(64)}`, "doctype=paper"], tag_mode: "replace", mode: "create" });
    assert.equal(seen[0].headers["x-openviking-user"], openVikingUserId(USER));
    assert.equal(seen[0].headers["x-openviking-account"], "evimed");
    assert.equal(seen[0].headers["x-openviking-role"], undefined);
  });
  let calls = 0;
  await withEngine(() => (++calls === 1 ? { status: 409, body: exists } : { body: created }), async ({ resources, seen }) => {
    await resources.pushSource(USER, resources.sourceUri(USER, PROJECT, "src_00000000000000000000000000000001"), "v2", { sourceId: "src_00000000000000000000000000000001", sha: "b".repeat(64) });
    assert.deepEqual(seen.map((request) => request.body.mode), ["create", "replace"]);
    assert.equal(seen[1].body.tags[2], "doctype=other");
    assert.equal(resources.status().pushes, 1);
  });
});

test("the documents under sources/ are listed page by page with what their tags say", async () => {
  const pages = [readdress(await fixture("fs-ls-page-1")), readdress(await fixture("fs-ls-page-2")), { status: "ok", result: [], has_more: false }];
  await withEngine(({ query }) => ({ body: pages[Number(query.get("offset") ?? 0) / 2] ?? pages[2] }), async ({ resources, seen }) => {
    const listed = await resources.listSources(USER, resources.roots(USER, PROJECT).sources);
    // `edges.jsonl` is not a pushed document and is not reported as one.
    assert.deepEqual(listed.map((entry) => [entry.sourceId, entry.docType, entry.state, entry.sha]), [
      ["src_00000000000000000000000000000001", "other", null, null],
      ["src_00000000000000000000000000000002", null, "retracted", null],
      ["src_00000000000000000000000000000003", null, null, null],
    ]);
    assert.deepEqual(seen.map((request) => request.query.get("offset")), [null, "2", "4"]);
    assert.ok(seen.every((request) => request.query.get("include_tags") === "true" && request.query.get("uri") === `${OUR_ROOT}/sources`));
  });
  const missing = await fixture("fs-ls-missing");
  await withEngine(() => ({ status: 404, body: missing }), async ({ resources }) => {
    assert.deepEqual(await resources.listSources(USER, `${OUR_ROOT}/sources`), []);
  });
  assert.deepEqual(resourceTags(["src=src_1", "state=retracted", "loose", "k=a=b"]), { src: "src_1", state: "retracted", k: "a=b" });
});

test("a tree is read whole, hidden sidecars left out; an absent root is an empty tree", async () => {
  const wiki = readdress(await fixture("fs-tree-wiki"));
  const hidden = readdress(await fixture("fs-tree-wiki-with-hidden"));
  const missing = await fixture("fs-stat-missing");
  await withEngine(({ query }) => (query.get("uri")?.endsWith("/none") ? { status: 404, body: missing } : { body: query.get("show_all_hidden") ? hidden : wiki }), async ({ resources, seen }) => {
    const entries = await resources.tree(USER, `${OUR_ROOT}/wiki`);
    const files = entries.filter((entry) => !entry.isDir);
    assert.ok(files.length >= 5);
    assert.ok(files.every((entry) => entry.uri === `${OUR_ROOT}/wiki/${entry.relPath}` && entry.size > 0));
    assert.ok(files.some((entry) => entry.relPath === "index.md"));
    assert.equal(seen[0].query.get("node_limit"), "1000");
    assert.equal(seen[0].query.get("level_limit"), "6");
    const all = await resources.tree(USER, `${OUR_ROOT}/wiki`, { showHidden: true });
    assert.ok(all.some((entry) => /\.(?:abstract|overview)\.md$/.test(entry.relPath)));
    assert.ok(entries.every((entry) => !/(?:^|\/)\./.test(entry.relPath)));
    assert.deepEqual(await resources.tree(USER, `${OUR_ROOT}/none`), []);
  });
});

test("read, download, stat and attrs answer what is stored, and null for what is not", async () => {
  const read = await fixture("content-read");
  const lines = await fixture("content-read-lines");
  const bytes = await readFile(fixtureUrl("content-download.bin"));
  const stat = readdress(await fixture("fs-stat-file"));
  const attrs = await fixture("fs-attrs");
  const missing = await fixture("content-read-missing");
  await withEngine(({ path, query }) => {
    if (query.get("uri")?.endsWith("none.md")) return { status: 404, body: missing };
    if (path === "/api/v1/content/read") return { body: query.get("limit") ? lines : read };
    if (path === "/api/v1/content/download") return { bytes };
    if (path === "/api/v1/fs/stat") return { body: stat };
    return { body: attrs };
  }, async ({ resources, seen }) => {
    const uri = `${OUR_ROOT}/sources/src_00000000000000000000000000000001.md`;
    assert.equal(await resources.read(USER, uri), read.result);
    assert.equal(await resources.read(USER, uri, { offset: 6, limit: 2 }), lines.result);
    assert.deepEqual([seen[1].query.get("offset"), seen[1].query.get("limit")], ["6", "2"]);
    const downloaded = await resources.download(USER, uri);
    assert.equal(downloaded?.length, provenance["content-download"].binary.bytes);
    // The download is the stored bytes; the text route returned the same document.
    assert.equal(downloaded?.toString("utf8"), read.result);
    assert.equal((await resources.stat(USER, uri))?.size, 342);
    assert.deepEqual(await resources.attrs(USER, uri), { src: "src_00000000000000000000000000000002", state: "retracted" });
    for (const call of [resources.read(USER, `${OUR_ROOT}/sources/none.md`), resources.download(USER, `${OUR_ROOT}/sources/none.md`), resources.stat(USER, `${OUR_ROOT}/sources/none.md`), resources.attrs(USER, `${OUR_ROOT}/sources/none.md`)]) {
      assert.equal(await call, null);
    }
  });
});

test("grep answers lines with their file and number; the pages that cite a document are found by its address", async () => {
  const cited = readdress(await fixture("search-grep-source-uri-in-wiki"));
  const none = await fixture("search-grep-no-match");
  await withEngine(({ body }) => ({ body: String(body.pattern).includes("nothing") ? none : cited }), async ({ resources, seen }) => {
    const source = `${OUR_ROOT}/sources/src_00000000000000000000000000000001.md`;
    const found = await resources.grep(USER, `${OUR_ROOT}/wiki`, escapeGrepPattern(source), { limit: 200 });
    assert.ok(found.matches.length >= 4);
    assert.ok(found.matches.every((match) => match.uri.startsWith(`${OUR_ROOT}/wiki/`) && match.line > 0 && match.content.includes(source)));
    assert.deepEqual(seen[0].body, { uri: `${OUR_ROOT}/wiki`, pattern: source.replaceAll(".", "\\."), node_limit: 200 });
    assert.deepEqual((await resources.grep(USER, `${OUR_ROOT}/sources`, "nothing-like-this")).matches, []);
  });
});

test("a compile is submitted with an idempotency key and no args, polled, and cancelled", async () => {
  const submitted = readdress(await fixture("compile-submit"));
  const running = readdress(await fixture("tasks-get-running"));
  const completed = readdress(await fixture("tasks-get-completed"));
  const cancelling = readdress(await fixture("tasks-cancel"));
  const unknown = await fixture("tasks-get-unknown");
  let polls = 0;
  await withEngine(({ method, path }) => {
    if (path === "/api/v1/compile") return { status: 202, body: submitted };
    if (path.endsWith("/cancel")) return { body: cancelling };
    if (path.includes("cmp_0000")) return { status: 404, body: unknown };
    return { body: method === "GET" && ++polls === 1 ? running : completed };
  }, async ({ resources, seen }) => {
    const key = compileIdempotencyKey({ projectId: PROJECT, tree: "wiki", round: 3 });
    assert.match(key, /^[A-Za-z0-9_-]{16,128}$/);
    assert.equal(key, compileIdempotencyKey({ projectId: PROJECT, tree: "wiki", round: 3, attempt: 0 }));
    assert.notEqual(key, compileIdempotencyKey({ projectId: PROJECT, tree: "wiki", round: 3, attempt: 1 }));
    const roots = resources.roots(USER, PROJECT);
    const task = await resources.submitCompile(USER, { from: [roots.sources, roots.library], to: roots.wiki, skill: "llm-wiki", instruction: "全部用简体中文输出。", idempotencyKey: key });
    assert.deepEqual([task.taskId, task.status, task.stage, task.terminal], [submitted.result.task_id, "pending", "queued", false]);
    assert.equal(seen[0].headers["idempotency-key"], key);
    assert.deepEqual(seen[0].body, { from: [roots.sources, roots.library], to: roots.wiki, skill: "viking://agent/skills/llm-wiki", instruction: "全部用简体中文输出。" });
    assert.equal("args" in seen[0].body, false);
    const first = await resources.task(USER, task.taskId);
    assert.deepEqual([first?.status, first?.stage, first?.terminal, first?.usage], ["running", "compile: collecting_context", false, null]);
    const done = await resources.task(USER, task.taskId);
    assert.equal(done?.terminal, true);
    assert.deepEqual(done?.usage, { inputTokens: 60864, outputTokens: 5108, totalTokens: 65972 });
    assert.ok((done?.result?.pageCount ?? 0) > 0);
    assert.equal((await resources.cancelTask(USER, task.taskId))?.status, "cancelling");
    // An expired task and one that never existed answer the same; neither is an error.
    assert.equal(await resources.task(USER, `cmp_${"0".repeat(64)}`), null);
    await assert.rejects(resources.submitCompile(USER, { from: [roots.sources], to: roots.wiki, skill: "daily-report", idempotencyKey: key }), { code: "knowledge_skill_unknown" });
  });
});

test("a file the platform's own readers do not take is parsed by the engine in a staging directory that is removed again", async () => {
  const upload = await fixture("resources-temp-upload");
  const added = readdress(await fixture("resources-add-no-split"));
  const removed = await fixture("fs-delete-file");
  const staging = `viking://user/${openVikingUserId(USER)}/resources/staging/src_0123456789abcdef0123456789abcdef`;
  await withEngine(({ method, path, query }) => {
    if (method === "DELETE") return { body: removed };
    if (path === "/api/v1/resources/temp_upload") return { body: upload };
    if (path === "/api/v1/resources") return { body: added };
    if (path === "/api/v1/fs/tree") return { body: { status: "ok", result: [
      { uri: `${staging}/repo`, rel_path: "repo", isDir: true, size: 0 },
      { uri: `${staging}/repo/b.md`, rel_path: "repo/b.md", isDir: false, size: 4 }, { uri: `${staging}/repo/a.md`, rel_path: "repo/a.md", isDir: false, size: 4 },
    ] } };
    return { body: { status: "ok", result: query.get("uri")?.endsWith("a.md") ? "# A\n" : "# B\n" } };
  }, async ({ resources, seen }) => {
    const parsed = await resources.parseWithEngine(USER, { name: "notes.zip", bytes: Buffer.from("PK\u0003\u0004"), token: "src_0123456789abcdef0123456789abcdef" });
    assert.equal(parsed.text, "<!-- file: repo/a.md -->\n# A\n\n<!-- file: repo/b.md -->\n# B");
    assert.deepEqual(parsed.files.map((file) => file.path), ["repo/a.md", "repo/b.md"]);
    const uploadRequest = seen.find((request) => request.path === "/api/v1/resources/temp_upload");
    assert.match(String(uploadRequest.headers["content-type"]), /^multipart\/form-data/);
    assert.equal(uploadRequest.headers["x-openviking-user"], openVikingUserId(USER));
    assert.ok(Buffer.from(uploadRequest.body).includes(Buffer.from('filename="notes.zip"')));
    const add = seen.find((request) => request.path === "/api/v1/resources");
    assert.deepEqual(add.body, { temp_file_id: upload.result.temp_file_id, to: staging, wait: true, processing_mode: "vectors_only" });
    // Removed before (a read that crashed) and after: nothing of the file stays in the engine.
    const deletes = seen.filter((request) => request.method === "DELETE");
    assert.equal(deletes.length, 2);
    assert.ok(deletes.every((request) => request.query.get("uri") === staging && request.query.get("recursive") === "true"));
    assert.equal(seen.at(-1).method, "DELETE");
  });
});
