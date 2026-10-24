// The Resources and Compile half of the OpenViking client, held to what a running v0.5.1.1 server answered.
//
// Every response here is a recorded one (`packages/contracts/openviking/fixtures/knowledge/`, off the lab instance of
// 2026-10-23, `provenance.json` beside them): served over real HTTP, so a parse that only works on a hand-shaped
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

test("a document is pushed as <srcId>.md with vectors only and its tags, in one replacing write", async () => {
  const created = await fixture("content-write-create");
  await withEngine(() => ({ body: created }), async ({ resources, seen }) => {
    const uri = resources.sourceUri(USER, PROJECT, "src_00000000000000000000000000000001");
    const pushed = await resources.pushSource(USER, uri, "# Alpha\n\ntext\n", { sourceId: "src_00000000000000000000000000000001", sha: "a".repeat(64), docType: "paper" });
    assert.equal(pushed.bytes, 342);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, provenance["content-write-create"].path);
    // `replace` creates what is not there from v0.5.1, where `create` is only its alias: one call, never a 409 to fall back from.
    assert.deepEqual(seen[0].body, { uri, content: "# Alpha\n\ntext\n", wait: true, processing_mode: "vectors_only",
      tags: ["src=src_00000000000000000000000000000001", `sha=${"a".repeat(64)}`, "doctype=paper", "rendition=49d32a1883784a6e5006e9ab2a74ed04cdfc3d86cd5bac7e8ddf6c6b92f1f709"], tag_mode: "replace", mode: "replace" });
    assert.equal(seen[0].headers["x-openviking-user"], openVikingUserId(USER));
    assert.equal(seen[0].headers["x-openviking-account"], "evimed");
    assert.equal(seen[0].headers["x-openviking-role"], undefined);
  });
  await withEngine(() => ({ body: created }), async ({ resources, seen }) => {
    await resources.pushSource(USER, resources.sourceUri(USER, PROJECT, "src_00000000000000000000000000000001"), "v2", { sourceId: "src_00000000000000000000000000000001", sha: "b".repeat(64) });
    assert.deepEqual(seen.map((request) => request.body.mode), ["replace"]);
    assert.equal(seen[0].body.tags[2], "doctype=other");
    assert.equal(resources.status().pushes, 1);
  });
});

test("a document that is not in the engine yet is created by the same one replacing write, and any refusal is a counted failure", async () => {
  // Recorded on v0.5.1.1: `replace` on a file that is not there creates it, parents included — so the create fallback the
  // v0.5.0 pin kept is gone, and a refusal is never retried as something else.
  const created = await fixture("content-write-replace-missing");
  assert.equal(created.result.mode, "replace");
  assert.equal(created.result.content_updated, true);
  await withEngine(() => ({ body: created }), async ({ resources, seen }) => {
    const pushed = await resources.pushSource(USER, resources.sourceUri(USER, PROJECT, "src_00000000000000000000000000000001"), "v1", { sourceId: "src_00000000000000000000000000000001", sha: "a".repeat(64) });
    assert.deepEqual(seen.map((request) => request.body.mode), ["replace"]);
    assert.ok(pushed.bytes > 0);
    assert.equal(resources.status().pushes, 1);
  });
  await withEngine(() => ({ status: 404, body: { status: "error", result: null, error: { code: "NOT_FOUND", message: "File not found" } } }), async ({ resources, seen }) => {
    await assert.rejects(() => resources.pushSource(USER, resources.sourceUri(USER, PROJECT, "src_00000000000000000000000000000001"), "v3", { sourceId: "src_00000000000000000000000000000001", sha: "c".repeat(64) }), { code: "memory_index_not_found" });
    assert.equal(seen.length, 1, "a refusal is not retried as a create");
    assert.equal(resources.status().failures, 1);
  });
});

test("a page is written back as one checked operation: the hash it was read at, and a changed page is refused and left alone", async () => {
  const pageBody = (await fixture("provenance")).fixtures["content-batch-write-checked"].request_body;
  const written = readdress(await fixture("content-batch-write-checked"));
  const stale = await fixture("content-batch-write-checked-stale");
  const missing = await fixture("content-batch-write-checked-missing");
  const busy = await fixture("content-batch-write-checked-busy");
  assert.equal(pageBody.operations[0].mode, "replace");
  assert.match(pageBody.operations[0].expected_sha256, /^[a-f0-9]{64}$/);
  const uri = `${OUR_ROOT}/wiki/concept/page.md`;
  const hash = "a".repeat(64);
  await withEngine(() => ({ body: written }), async ({ resources, seen }) => {
    const done = await resources.writePage(USER, uri, "---\ntype: concept\n---\n\nnew\n", { expectedSha256: hash });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/api/v1/content/batch-write");
    assert.deepEqual(seen[0].body, { root_uri: `${OUR_ROOT}/wiki/concept`, wait: true, operations: [{ uri, content: "---\ntype: concept\n---\n\nnew\n", mode: "replace", expected_sha256: hash }] });
    assert.equal(done.bytes, Buffer.byteLength("---\ntype: concept\n---\n\nnew\n"));
    assert.equal(seen[0].headers["x-openviking-user"], openVikingUserId(USER));
    assert.equal(seen[0].headers["x-openviking-role"], undefined);
  });
  // A save that must answer at once does not wait for the summary and the vector.
  await withEngine(() => ({ body: written }), async ({ resources, seen }) => {
    await resources.writePage(USER, uri, "x\n", { expectedSha256: hash, wait: false });
    assert.equal(seen[0].body.wait, false);
  });
  // The page is not the one that was read: 409 CONFLICT "Content revision changed" (or the file is gone) is the caller's
  // `knowledge_page_engine_changed`; a directory still being processed is the client's own conflict, which the caller retries.
  for (const refusal of [stale, missing]) {
    await withEngine(() => ({ status: 409, body: refusal }), async ({ resources, seen }) => {
      await assert.rejects(() => resources.writePage(USER, uri, "x\n", { expectedSha256: hash }), { code: "knowledge_page_engine_changed", status: 409 });
      assert.equal(seen.length, 1, "a changed page was retried");
    });
  }
  assert.equal(busy.error.details.conflict_type, "path_busy");
  await withEngine(() => ({ status: 409, body: busy }), async ({ resources }) => {
    await assert.rejects(() => resources.writePage(USER, uri, "x\n", { expectedSha256: hash }), (error) => error.code === "memory_index_conflict" && error.upstreamDetails?.retryable === true && error.upstreamDetails?.conflict_type === "path_busy");
  });
  // No write goes out without the hash it is checked against.
  await withEngine(() => ({ body: written }), async ({ resources, seen }) => {
    for (const bad of [undefined, "", "abc", "A".repeat(64)]) {
      await assert.rejects(() => resources.writePage(USER, uri, "x\n", { expectedSha256: /** @type {any} */ (bad) }), { code: "knowledge_write_back_invalid" });
    }
    assert.equal(seen.length, 0);
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
    // v0.5.1 reports a compile's tokens under `meta.pipeline.tokens` (`input`, `output`, `cached`); v0.5.0 had `meta.token_usage`.
    const tokens = completed.result.meta.pipeline.tokens;
    assert.deepEqual(done?.usage, { inputTokens: tokens.input, outputTokens: tokens.output, cachedTokens: tokens.cached, totalTokens: tokens.input + tokens.output });
    assert.ok((done?.usage?.totalTokens ?? 0) > 0, "a compile's tokens were not read: the account's knowledge caps would never move");
    assert.deepEqual(done?.result?.warnings, []);
    assert.equal((await resources.cancelTask(USER, task.taskId))?.status, "cancelling");
    // An expired task and one that never existed answer the same; neither is an error.
    assert.equal(await resources.task(USER, `cmp_${"0".repeat(64)}`), null);
    await assert.rejects(resources.submitCompile(USER, { from: [roots.sources], to: roots.wiki, skill: "daily-report", idempotencyKey: key }), { code: "knowledge_skill_unknown" });
  });
});

test("a compile that completed with a failed job is read as partial, and a root outside the acting user's own resources is never submitted", async () => {
  const completed = readdress(await fixture("tasks-get-completed"));
  const partial = structuredClone(completed);
  partial.result.meta.pipeline.errors = ["1 pipeline jobs failed: ['Required agent transform ended without validated output: No emit result was submitted']"];
  partial.result.result.warnings = ["Partial output; unfinished jobs: 1 pipeline jobs failed: ['Required agent transform ended without validated output: No emit result was submitted']"];
  await withEngine(() => ({ body: partial }), async ({ resources }) => {
    const task = await resources.task(USER, completed.result.task_id);
    assert.equal(task?.status, "completed");
    assert.equal(task?.result?.warnings.length, 2, "the partial output was not reported");
    assert.match(String(task?.result?.warnings[0]), /Partial output/);
  });
  // The engine refuses another user's root (403 at submission) but takes the account-shared `viking://resources/…` and
  // `viking://agent/…` roots, which the identity shim of the v0.5.0 pin used to refuse by rule: so the control plane does.
  await withEngine(() => ({ status: 202, body: null }), async ({ resources, seen }) => {
    const roots = resources.roots(USER, PROJECT);
    const key = compileIdempotencyKey({ projectId: PROJECT, tree: "wiki", round: 1 });
    const other = `viking://user/${openVikingUserId("someone-else")}/resources/p/${openVikingPeerId(PROJECT)}`;
    for (const [from, to] of [
      [[roots.sources], "viking://resources/shared"], [[roots.sources], "viking://agent/skills/llm-wiki"], [[roots.sources], `${other}/wiki`],
      [[`${other}/sources`], roots.wiki], [["viking://resources"], roots.wiki], [[`${roots.project}/../p-other/sources`], roots.wiki], [[roots.sources], `${roots.project}/../x`],
    ]) {
      await assert.rejects(resources.submitCompile(USER, { from, to, skill: "llm-wiki", idempotencyKey: key }), { code: "knowledge_compile_invalid" }, `${from} -> ${to} left the control plane`);
    }
    assert.equal(seen.length, 0);
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
