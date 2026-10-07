import assert from "node:assert/strict";
import test from "node:test";
import { createKnowledgeBaseEntries, fileSlug, linkError, linkSlug, snapshotMarkdown } from "../src/knowledgeBaseEntries.mjs";
import { HttpError } from "../src/security.mjs";

const user = { id: "user-one", accountCreatedAt: "2026-09-01" };
const project = { id: "project-one", baseDir: "/tmp/never-read" };
const FETCHED = "2026-10-07T08:00:00.000Z";

/** The fakes the entries stand on: the project's write path, the public-web reader and the source service. */
function setup({ page = null, onRead = null, files = new Map(), standing = [] } = {}) {
  const log = { writes: [], reads: [], removed: [], refreshed: [] };
  const sources = {
    documents: { list: async (_userId, _kind, { filter }) => ({ items: filter.familyId ? standing.filter((row) => row.payload.familyId === filter.familyId)
      : standing.filter((row) => row.payload.paths.includes(filter.paths?.[0])) }) },
    remove: async (userId, id, input) => { log.removed.push({ userId, id, ...input }); return { id }; },
    refreshFacts: async (_userId, source, facts) => { log.refreshed.push({ id: source.id, ...facts }); return { ...source, payload: { ...source.payload, link: facts.link } }; },
  };
  let registered = 0;
  const write = async (request) => {
    log.writes.push({ rel: request.rel, size: request.buffer.length, meta: request.meta ?? null, register: request.register !== false, text: request.buffer.toString("utf8") });
    files.set(request.rel, request.buffer);
    if (request.register === false) return null;
    registered += 1;
    return { source: { id: `src_new${registered}`, projectId: project.id, revision: 1, payload: { familyId: "fam_one", paths: [request.rel] } }, duplicate: false, job: { id: "job" } };
  };
  const readWeb = async (url, options) => {
    log.reads.push({ url, runtime: options.runtime, hasSignal: Boolean(options.signal) });
    if (onRead) return onRead(url, options);
    options.onBytes?.({ bytes: Buffer.from("<html><body>公告正文</body></html>"), mediaType: "text/html", extension: "html" });
    return page ?? { receipt: { url, finalUrl: url, title: "关于修订阿莫西林制剂说明书的公告", site: "www.nmpa.gov.cn", fetchedAt: FETCHED, rendered: false, contentType: "html" }, text: "增加严重皮肤不良反应警示。" };
  };
  const readFile = async (_project, rel) => { if (!files.has(rel)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files.get(rel); };
  const entries = createKnowledgeBaseEntries({ sources, write, readWeb, readFile, now: () => new Date(FETCHED) });
  return { entries, log, files };
}

test("a file name keeps letters and digits of any script, and is never empty", () => {
  assert.equal(fileSlug("10月3日 组会记录!", "note"), "10月3日-组会记录");
  assert.equal(fileSlug("../../etc/passwd", "note"), "etc-passwd");
  assert.equal(fileSlug("???", "note"), "note");
  assert.equal(fileSlug("a".repeat(200), "x").length, 48);
});

test("the same address is the same path, whatever follows the # and whichever site it is", () => {
  const first = linkSlug(new URL("https://www.nmpa.gov.cn/xxgk/ggtg/20261005.html#top"));
  assert.equal(first, linkSlug(new URL("https://www.nmpa.gov.cn/xxgk/ggtg/20261005.html")));
  assert.match(first, /^nmpa\.gov\.cn-ggtg-20261005\.html-[0-9a-f]{8}$/);
  assert.notEqual(first, linkSlug(new URL("https://www.nmpa.gov.cn/xxgk/ggtg/20261006.html")));
  assert.match(linkSlug(new URL("https://例子.中国/")), /^[\p{L}\p{N}._-]+$/u);
});

test("a snapshot carries the address and the time before the text, and says when a page was drawn by a browser", () => {
  const markdown = snapshotMarkdown({ url: "https://a.org/x", finalUrl: "https://a.org/y", title: "标题", site: "a.org", fetchedAt: FETCHED, rendered: true, text: "正文" });
  assert.equal(markdown.split("\n")[0], "---");
  for (const line of ["url: https://a.org/x", "final_url: https://a.org/y", 'title: "标题"', "site: a.org", `fetched_at: ${FETCHED}`, "rendered: true", "# 标题", "正文"]) assert.ok(markdown.includes(line), line);
  assert.ok(!snapshotMarkdown({ url: "https://a.org/x", finalUrl: "https://a.org/x", title: "t", site: "a.org", fetchedAt: FETCHED, rendered: false, text: "x" }).includes("final_url"));
});

test("a page that cannot be added is told as a sentence's code, and a refusal of the reader is never a bare web_read code", () => {
  const mapped = (code, status = 403) => linkError(Object.assign(new Error("x"), { code, status }));
  assert.deepEqual([mapped("web_read_robots_disallowed").status, mapped("web_read_robots_disallowed").code], [403, "source_link_blocked"]);
  assert.equal(mapped("web_read_host_forbidden").code, "source_link_private");
  assert.equal(mapped("web_read_url_forbidden").code, "source_link_invalid");
  assert.equal(mapped("web_read_login_required").code, "source_link_login_required");
  assert.equal(mapped("web_read_not_found", 404).code, "source_link_not_found");
  assert.equal(mapped("web_read_needs_browser", 422).code, "source_link_unreadable");
  assert.equal(mapped("web_read_timeout", 504).code, "source_link_unreachable");
  assert.equal(mapped("web_read_host_unresolved", 502).code, "source_link_unreachable");
  assert.equal(mapped("web_read_busy", 429).code, "source_link_busy");
  assert.equal(mapped("web_read_disabled", 403).code, "source_link_unavailable");
  assert.equal(mapped("something_unforeseen", 500).code, "source_link_failed");
  assert.equal(linkError(new Error("no code")).code, "source_link_failed");
  const own = new HttpError(422, "source_link_unreadable", "x");
  assert.equal(linkError(own), own);
});

test("an added page is kept as its text with the address in front and its original beside it, and registered as a page of its address", async () => {
  const { entries, log } = setup();
  const added = await entries.addLink({ user, project, url: " https://www.nmpa.gov.cn/xxgk/notice.html#top " });
  assert.equal(added.changed, true);
  assert.deepEqual(log.reads, [{ url: "https://www.nmpa.gov.cn/xxgk/notice.html", runtime: { userId: "user-one", projectId: "project-one" }, hasSignal: true }]);
  const [original, snapshot] = log.writes;
  assert.match(original.rel, /^knowledge-base\/\.evimed-snapshots\/nmpa\.gov\.cn-xxgk-notice\.html-[0-9a-f]{8}\.html$/);
  assert.equal(original.register, false, "the original is kept and never becomes a source of its own");
  assert.match(snapshot.rel, /^knowledge-base\/links\/nmpa\.gov\.cn-xxgk-notice\.html-[0-9a-f]{8}\.md$/);
  assert.equal(snapshot.register, true);
  assert.ok(snapshot.text.includes("url: https://www.nmpa.gov.cn/xxgk/notice.html") && snapshot.text.includes("增加严重皮肤不良反应警示。"));
  assert.deepEqual(snapshot.meta.link, { url: "https://www.nmpa.gov.cn/xxgk/notice.html", finalUrl: "https://www.nmpa.gov.cn/xxgk/notice.html", site: "www.nmpa.gov.cn", fetchedAt: FETCHED, rendered: false, original: original.rel });
  assert.equal(snapshot.meta.title, "关于修订阿莫西林制剂说明书的公告");
});

test("a PDF behind an address is kept as the PDF, for the intake to read like an upload", async () => {
  const pdf = Buffer.from("%PDF-1.4 guideline");
  const { entries, log } = setup({ onRead: async (url, options) => {
    options.onBytes({ bytes: pdf, mediaType: "application/pdf", extension: "pdf" });
    return { receipt: { url, finalUrl: url, title: "共识报告", site: "x.org", fetchedAt: FETCHED, rendered: false, contentType: "document" }, text: "整份正文" };
  } });
  await entries.addLink({ user, project, url: "https://x.org/consensus.pdf" });
  assert.equal(log.writes.length, 1);
  assert.match(log.writes[0].rel, /^knowledge-base\/links\/x\.org-consensus\.pdf-[0-9a-f]{8}\.pdf$/);
  assert.equal(log.writes[0].size, pdf.length, "the original bytes, not the text the reader took from them");
  assert.equal(log.writes[0].meta.title, "共识报告");
});

test("an address that is not a web page, or that cannot be read, writes nothing", async () => {
  for (const url of ["", "   ", "not a link", "ftp://example.org/a", "javascript:alert(1)", `https://example.org/${"a".repeat(2100)}`]) {
    const { entries, log } = setup();
    await assert.rejects(entries.addLink({ user, project, url }), { code: "source_link_invalid", status: 400 }, url);
    assert.deepEqual([log.reads.length, log.writes.length], [0, 0], "the reader is not asked");
  }
  const refused = setup({ onRead: async () => { throw Object.assign(new Error("robots"), { status: 403, code: "web_read_robots_disallowed" }); } });
  await assert.rejects(refused.entries.addLink({ user, project, url: "https://example.org/a" }), { code: "source_link_blocked", status: 403 });
  assert.equal(refused.log.writes.length, 0);
  const empty = setup({ page: { receipt: { site: "example.org", fetchedAt: FETCHED, contentType: "html", title: "t" }, text: "  " } });
  await assert.rejects(empty.entries.addLink({ user, project, url: "https://example.org/a" }), { code: "source_link_unreadable" });
  assert.equal(empty.log.writes.length, 0);
});

test("a link read again says only when, if the page is as it was, and is the next version if it is not", async () => {
  const first = setup();
  await first.entries.addLink({ user, project, url: "https://www.nmpa.gov.cn/notice" });
  const snapshotRel = first.log.writes.find((write) => write.register).rel;
  const standing = { id: "src_stand", projectId: "project-one", revision: 3, payload: { familyId: "fam_one", paths: [snapshotRel],
    link: { url: "https://www.nmpa.gov.cn/notice", fetchedAt: "2026-09-01T00:00:00.000Z" } } };

  // The same page: the file already holds this text, so nothing is written and the fetch time is what changes.
  const same = setup({ files: first.files, standing: [standing] });
  const again = await same.entries.refetchLink({ user, project, source: standing });
  assert.equal(again.changed, false);
  assert.equal(again.duplicate, true);
  assert.equal(same.log.writes.filter((write) => write.register).length, 0);
  assert.equal(same.log.refreshed.length, 1);
  assert.equal(same.log.refreshed[0].link.fetchedAt, FETCHED);
  assert.deepEqual(same.log.removed, []);

  // A changed page: the next version is written to the same path, and the version it replaces goes.
  const changed = setup({ files: first.files, standing: [standing], page: { receipt: { url: "u", finalUrl: "u", title: "关于修订阿莫西林制剂说明书的公告（更新）", site: "www.nmpa.gov.cn", fetchedAt: FETCHED, rendered: false, contentType: "html" }, text: "新增儿童用法用量。" } });
  const next = await changed.entries.refetchLink({ user, project, source: standing });
  assert.equal(next.changed, true);
  const written = changed.log.writes.find((write) => write.register);
  assert.equal(written.rel, snapshotRel);
  assert.deepEqual(changed.log.removed, [{ userId: "user-one", id: "src_stand", expectedRevision: 3, accountCreatedAt: "2026-09-01" }]);

  await assert.rejects(setup().entries.refetchLink({ user, project, source: { id: "src_plain", payload: { paths: ["knowledge-base/a.pdf"] } } }), { code: "source_link_required", status: 409 });
});

test("a note is a Markdown file under notes/ named for its title, and two notes with one title are two notes", async () => {
  const { entries, log } = setup();
  await entries.addNote({ user, project, title: "  10月3日   组会记录 ", body: "确定 C1–C3 三类比较分开合并。\r\n局限性写明全文未获取。" });
  const [write] = log.writes;
  assert.match(write.rel, /^knowledge-base\/notes\/10月3日-组会记录-[0-9a-f]{6}\.md$/);
  assert.equal(write.text, "# 10月3日 组会记录\n\n确定 C1–C3 三类比较分开合并。\n局限性写明全文未获取。\n");
  assert.equal(write.meta.title, "10月3日 组会记录");
  await entries.addNote({ user, project, title: "10月3日 组会记录", body: "" });
  assert.notEqual(log.writes[1].rel, write.rel);
  for (const title of ["", "   ", "x".repeat(121), 7, null]) {
    await assert.rejects(entries.addNote({ user, project, title, body: "x" }), { code: "source_note_invalid" }, String(title));
  }
  await assert.rejects(entries.addNote({ user, project, title: "t", body: { text: "x" } }), { code: "source_note_invalid" });
});

test("a note opens with its title and text, and saving writes the same path and retires the version it replaces", async () => {
  const { entries, log, files } = setup();
  const added = await entries.addNote({ user, project, title: "组会记录", body: "确定分组。" });
  const rel = log.writes[0].rel;
  const source = { id: "src_note", projectId: "project-one", revision: 2, payload: { paths: [rel], connector: { type: "upload", id: "project-one-library" }, title: "组会记录", familyId: "fam_one" } };
  assert.deepEqual(await entries.readNote({ project, source }), { title: "组会记录", body: "确定分组。" });
  assert.ok(files.has(rel) && added.source);

  const family = setup({ files, standing: [source, { id: "src_new1", projectId: "project-one", revision: 1, payload: { familyId: "fam_one", paths: [rel] } }] });
  const saved = await family.entries.saveNote({ user, project, source, title: "组会记录（修订）", body: "确定分组并写明局限。" });
  assert.equal(saved.changed, true);
  assert.equal(family.log.writes[0].rel, rel, "the same path: changed text is the next version of one note");
  assert.equal(family.log.writes[0].text, "# 组会记录（修订）\n\n确定分组并写明局限。\n");
  assert.deepEqual(family.log.removed.map((entry) => entry.id), ["src_note"], "only the older version goes, never the one that now stands");

  await assert.rejects(entries.saveNote({ user, project, source: { id: "src_pdf", payload: { paths: ["knowledge-base/a.pdf"], connector: { type: "upload" } } }, title: "t", body: "" }), { code: "source_note_required", status: 409 });
  await assert.rejects(entries.readNote({ project, source: { id: "src_link", payload: { paths: ["knowledge-base/links/a.md"], connector: { type: "upload" } } } }), { code: "source_note_required" });
});
