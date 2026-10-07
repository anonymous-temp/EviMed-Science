// A web page and a note become documents of a project's knowledge base the way an upload does — through the real routes, the
// real source service and the real write path over PostgreSQL — and a conversation's file is saved into it by the page's own
// command. The page reader is the production one; only the network under it is the test's.
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { databaseUrl, signedIn } from "./helpers/knowledgeBaseApp.mjs";

const skip = !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured";
const options = { skip, timeout: 60_000 };

/** A site that answers with the pages the test names, and a robots.txt it can close. */
function site() {
  const state = { pages: new Map(), robots: "", requests: [] };
  const transport = async ({ url }) => {
    state.requests.push(url.href);
    if (url.pathname === "/robots.txt") return state.robots ? { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from(state.robots) } : { status: 404, headers: {}, body: Buffer.alloc(0) };
    const page = state.pages.get(url.pathname);
    if (!page) return { status: 404, headers: { "content-type": "text/html" }, body: Buffer.from("not found") };
    return { status: 200, headers: { "content-type": page.type ?? "text/html; charset=utf-8" }, body: Buffer.isBuffer(page.body) ? page.body : Buffer.from(page.body) };
  };
  const html = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p><p>${"本公告适用于全国范围内的药品生产企业与使用单位。".repeat(8)}</p></main></body></html>`;
  return { state, transport, html };
}

const post = (base, headers, route, body) => fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
const listed = async (base, headers, projectId, query = "") => (await (await fetch(`${base}/api/sources?projectId=${encodeURIComponent(projectId)}${query}`, { headers })).json()).data;

test("a note is written, listed as a note, edited into its next version, and never asked about by the type judge", options, async () => {
  const { app, user, project, base, headers, close } = await signedIn();
  try {
    app.sourceWorker.understandingRuns = { execute: async () => { throw Object.assign(new Error("busy"), { code: "runtime_busy" }); } };
    const created = await post(base, headers, "/api/sources/notes", { projectId: project.id, title: "10月3日组会记录", body: "确定 C1–C3 三类比较分开合并；局限性写明全文未获取。" });
    assert.equal(created.status, 201);
    const note = (await created.json()).data;
    assert.equal(note.job, undefined);
    const rel = note.source.payload.paths[0];
    assert.match(rel, /^knowledge-base\/notes\/10月3日组会记录-[0-9a-f]{6}\.md$/);
    assert.equal(await readFile(path.join(project.baseDir, rel), "utf8"), "# 10月3日组会记录\n\n确定 C1–C3 三类比较分开合并；局限性写明全文未获取。\n");
    assert.deepEqual([note.source.payload.docType, note.source.display.kind, note.source.display.origin, note.source.display.title, note.source.display.typeShort],
      ["note-memo", "note", "note", "10月3日组会记录", "笔记"]);

    const page = await listed(base, headers, project.id, "&kind=note");
    assert.deepEqual(page.items.map((item) => item.id), [note.source.id]);
    assert.equal(page.counts.note, 1);
    assert.deepEqual(await (await fetch(`${base}/api/sources/${note.source.id}/note`, { headers })).json().then((body) => body.data),
      { title: "10月3日组会记录", body: "确定 C1–C3 三类比较分开合并；局限性写明全文未获取。" });

    // Saved unchanged: nothing new. Saved changed: the next version of the same note, and the one it replaces is gone.
    const same = await fetch(`${base}/api/sources/${note.source.id}/note`, { method: "PUT", headers,
      body: JSON.stringify({ title: "10月3日组会记录", body: "确定 C1–C3 三类比较分开合并；局限性写明全文未获取。" }) });
    assert.equal(same.status, 200);
    const unchanged = (await same.json()).data;
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.source.id, note.source.id);
    const edited = await fetch(`${base}/api/sources/${note.source.id}/note`, { method: "PUT", headers,
      body: JSON.stringify({ title: "10月3日组会记录（修订）", body: "增加：敏感性分析另行报告。" }) });
    assert.equal(edited.status, 200);
    const next = (await edited.json()).data;
    assert.equal(next.changed, true);
    assert.notEqual(next.source.id, note.source.id);
    assert.equal(next.source.payload.paths[0], rel, "the same path");
    assert.equal(next.source.payload.version, 2);
    assert.equal(next.source.display.title, "10月3日组会记录（修订）");
    assert.deepEqual((await listed(base, headers, project.id)).items.map((item) => item.id), [next.source.id], "one note, not two");
    assert.equal((await fetch(`${base}/api/sources/${note.source.id}`, { headers })).status, 404, "the replaced version is gone");
    assert.equal(await readFile(path.join(project.baseDir, rel), "utf8"), "# 10月3日组会记录（修订）\n\n增加：敏感性分析另行报告。\n");

    // What is refused is refused by name, and a document that is not a note has no editor.
    assert.equal((await post(base, headers, "/api/sources/notes", { projectId: project.id, title: "", body: "x" })).status, 400);
    const upload = await fetch(`${base}/api/files/upload`, { method: "POST", headers, body: JSON.stringify({ root: "base", path: "knowledge-base/plain.txt", data: "正文", encoding: "utf8" }) });
    const plain = (await upload.json()).data.source;
    const refused = await fetch(`${base}/api/sources/${plain.id}/note`, { headers });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "source_note_required");
    assert.equal(user.id.length > 0, true);
  } finally { await close(); }
});

test("a web page is kept as a snapshot with its address and time, read again on request, and refused by name when the site says no", options, async () => {
  const web = site();
  web.state.pages.set("/notice", { body: web.html("国家药监局关于修订阿莫西林制剂说明书的公告", "增加严重皮肤不良反应警示，修订儿童用法用量。") });
  web.state.pages.set("/closed", { body: web.html("不让读的页面", "内容。") });
  web.state.robots = "User-agent: *\nDisallow: /closed\n";
  const { project, base, headers, close } = await signedIn({ webReadTransport: web.transport, webReadHostIntervalMs: 0 });
  try {
    const added = await post(base, headers, "/api/sources/links", { projectId: project.id, url: "https://www.nmpa.gov.cn/notice#top" });
    assert.equal(added.status, 201);
    const link = (await added.json()).data;
    assert.equal(link.job, undefined);
    const rel = link.source.payload.paths[0];
    assert.match(rel, /^knowledge-base\/links\/nmpa\.gov\.cn-notice-[0-9a-f]{8}\.md$/);
    const snapshot = await readFile(path.join(project.baseDir, rel), "utf8");
    assert.ok(snapshot.startsWith("---\nurl: https://www.nmpa.gov.cn/notice\n"));
    assert.match(snapshot, /\ntitle: "国家药监局关于修订阿莫西林制剂说明书的公告"\n/);
    assert.match(snapshot, /\nfetched_at: \d{4}-\d{2}-\d{2}T/);
    assert.ok(snapshot.includes("增加严重皮肤不良反应警示"));
    const original = link.source.payload.link.original;
    assert.match(original, /^knowledge-base\/\.evimed-snapshots\/nmpa\.gov\.cn-notice-[0-9a-f]{8}\.html$/);
    assert.ok((await readFile(path.join(project.baseDir, original), "utf8")).includes("<h1>"), "the original page is kept");
    assert.deepEqual([link.source.payload.docType, link.source.display.kind, link.source.display.origin, link.source.display.site, link.source.display.title],
      ["webpage", "page", "link", "www.nmpa.gov.cn", "国家药监局关于修订阿莫西林制剂说明书的公告"]);
    // The original is a file beside the text, never a second document.
    const inventory = await listed(base, headers, project.id);
    assert.deepEqual(inventory.items.map((item) => item.id), [link.source.id]);
    assert.equal(inventory.counts.page, 1);

    // Read again: the page as it was is the same document, with the new time.
    const unchanged = await post(base, headers, `/api/sources/${link.source.id}/refetch`, {});
    assert.equal(unchanged.status, 200);
    const same = (await unchanged.json()).data;
    assert.equal(same.changed, false);
    assert.equal(same.source.id, link.source.id);
    // The page changed: the next version of the same address, and the one it replaces is gone.
    web.state.pages.set("/notice", { body: web.html("国家药监局关于修订阿莫西林制剂说明书的公告", "新增：肾功能不全患者的剂量调整。") });
    const changed = await post(base, headers, `/api/sources/${link.source.id}/refetch`, {});
    assert.equal(changed.status, 200);
    const next = (await changed.json()).data;
    assert.equal(next.changed, true);
    assert.notEqual(next.source.id, link.source.id);
    assert.equal(next.source.payload.paths[0], rel);
    assert.deepEqual((await listed(base, headers, project.id)).items.map((item) => item.id), [next.source.id]);
    assert.ok((await readFile(path.join(project.baseDir, rel), "utf8")).includes("肾功能不全"));
    // Searching finds a page by its address too.
    assert.equal((await listed(base, headers, project.id, "&q=nmpa.gov.cn")).items.length, 1);

    // Refusals say which, and write nothing.
    const before = (await readdir(path.join(project.baseDir, "knowledge-base/links"))).length;
    const blocked = await post(base, headers, "/api/sources/links", { projectId: project.id, url: "https://www.nmpa.gov.cn/closed" });
    assert.deepEqual([blocked.status, (await blocked.json()).code], [403, "source_link_blocked"]);
    const gone = await post(base, headers, "/api/sources/links", { projectId: project.id, url: "https://www.nmpa.gov.cn/missing" });
    assert.deepEqual([gone.status, (await gone.json()).code], [404, "source_link_not_found"]);
    const priv = await post(base, headers, "/api/sources/links", { projectId: project.id, url: "http://localhost/admin" });
    assert.deepEqual([priv.status, (await priv.json()).code], [403, "source_link_private"]);
    const internal = await post(base, headers, "/api/sources/links", { projectId: project.id, url: "http://192.168.1.10/router" });
    assert.deepEqual([internal.status, (await internal.json()).code], [403, "source_link_private"]);
    const nonsense = await post(base, headers, "/api/sources/links", { projectId: project.id, url: "nmpa.gov.cn/notice" });
    assert.deepEqual([nonsense.status, (await nonsense.json()).code], [400, "source_link_invalid"]);
    assert.equal((await readdir(path.join(project.baseDir, "knowledge-base/links"))).length, before, "nothing was written for a refused address");
    assert.ok(!web.state.requests.some((request) => request.includes("localhost") || request.includes("192.168")), "a private address is never fetched");
    const notLink = await fetch(`${base}/api/files/upload`, { method: "POST", headers, body: JSON.stringify({ root: "base", path: "knowledge-base/plain.txt", data: "正文", encoding: "utf8" }) });
    const plain = (await notLink.json()).data.source;
    const refused = await post(base, headers, `/api/sources/${plain.id}/refetch`, {});
    assert.deepEqual([refused.status, (await refused.json()).code], [409, "source_link_required"]);
  } finally { await close(); }
});

test("a PDF behind an address is kept as the PDF, and the intake reads it like an upload", options, async () => {
  const web = site();
  const pdf = Buffer.from("%PDF-1.4\n共识报告\n");
  web.state.pages.set("/consensus.pdf", { type: "application/pdf", body: pdf });
  const parsed = [];
  const documentParserFetch = async (_url, init) => {
    parsed.push(init.body.get("filename"));
    return new Response(JSON.stringify({ code: 200, message: "success", uuid: "U", timestamp: 1, elapsed_ms: 1, data: { title: "幽门螺杆菌共识报告", content: "第一页。", pages: [{ index: 1, start: 0, end: 4, status: "ok" }] } }), { status: 200 });
  };
  const { app, user, project, base, headers, close } = await signedIn({ webReadTransport: web.transport, webReadHostIntervalMs: 0, documentParserUrl: "http://parser.test", documentParserToken: "sk-test-only", documentParserFetch });
  try {
    app.sourceWorker.understandingRuns = { execute: async () => { throw Object.assign(new Error("busy"), { code: "runtime_busy" }); } };
    const added = await post(base, headers, "/api/sources/links", { projectId: project.id, url: "https://example.org/consensus.pdf" });
    assert.equal(added.status, 201);
    const link = (await added.json()).data;
    const rel = link.source.payload.paths[0];
    assert.match(rel, /^knowledge-base\/links\/example\.org-consensus\.pdf-[0-9a-f]{8}\.pdf$/);
    assert.deepEqual(await readFile(path.join(project.baseDir, rel)), pdf, "the original bytes");
    assert.deepEqual([link.source.payload.docType, link.source.display.origin], ["document", "link"]);
    assert.ok(link.source.display.title, "the page's title, or the site's name");
    assert.equal(link.source.payload.link.original, null);
    assert.equal(parsed.length, 1, "the page reader parsed it once to answer; the intake's own read is the worker's");
    for (let attempt = 0; attempt < 40 && parsed.length < 2; attempt += 1) { await app.sourceWorker.tick(); await new Promise((resolve) => setTimeout(resolve, 20)); }
    assert.equal(parsed.length, 2, "and the worker reads the stored PDF like any upload");
    assert.equal((await app.sourceService.get(user.id, link.source.id)).payload.analysis?.generation, 1);
  } finally { await close(); }
});

test("a file a conversation produced is saved into this project's knowledge base by the page's own command, and nowhere else", options, async () => {
  const { app, user, project, base, headers, close } = await signedIn();
  try {
    const command = (name, args) => fetch(`${base}/api/commands/${name}`, { method: "POST", headers, body: JSON.stringify(args) });
    await command("add_text_to_workspace", { filename: "report/评价报告.md", content: "# 评价报告\n\n结论：可以使用。" });
    const saved = await command("save_to_knowledge_base", { path: "report/评价报告.md" });
    assert.equal(saved.status, 200);
    const result = (await saved.json()).data;
    assert.match(result.path, /^knowledge-base\/chat\/评价报告-[0-9a-f]{8}\.md$/);
    assert.equal(result.duplicate, false);
    assert.equal(await readFile(path.join(project.baseDir, result.path), "utf8"), "# 评价报告\n\n结论：可以使用。");
    const source = await app.sourceService.get(user.id, result.sourceId);
    assert.equal(source.projectId, project.id);
    const row = (await listed(base, headers, project.id)).items.find((item) => item.id === result.sourceId);
    assert.deepEqual([row.display.origin, row.display.title], ["conversation", "评价报告-" + result.path.match(/-([0-9a-f]{8})\.md$/)[1] + ".md"]);

    // Saved again, it is the same document; changed under the same name, another.
    const again = (await (await command("save_to_knowledge_base", { path: "report/评价报告.md" })).json()).data;
    assert.deepEqual([again.path, again.duplicate, again.sourceId], [result.path, true, result.sourceId]);
    await command("add_text_to_workspace", { filename: "report/评价报告.md", content: "# 评价报告\n\n结论：暂不推荐。" });
    const changed = (await (await command("save_to_knowledge_base", { path: "report/评价报告.md" })).json()).data;
    assert.notEqual(changed.path, result.path);

    // A format the knowledge base cannot read is refused by name; a path outside the workspace and a file that is not there are refused.
    await command("add_text_to_workspace", { filename: "report/data.sav", content: "x" });
    const unreadable = await command("save_to_knowledge_base", { path: "report/data.sav" });
    assert.deepEqual([unreadable.status, (await unreadable.json()).code], [415, "source_format_unsupported"]);
    assert.equal((await command("save_to_knowledge_base", { path: "report/not-there.md" })).status, 404);
    assert.equal((await command("save_to_knowledge_base", { path: "../../etc/passwd" })).status, 403);
    assert.equal((await command("save_to_knowledge_base", { path: "report" })).status, 400);
    const files = await readdir(path.join(project.baseDir, "knowledge-base/chat"));
    assert.equal(files.length, 2, "only the two saved versions were written");
    await assert.rejects(stat(path.join(project.baseDir, "knowledge-base/chat/data.sav")), { code: "ENOENT" });
  } finally { await close(); }
});
