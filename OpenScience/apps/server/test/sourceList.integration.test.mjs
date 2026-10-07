// The knowledge base page's list, against PostgreSQL: a page at a time, searched and counted where the documents are,
// and the account's shared documents listed without naming a project.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { SourceService, projectSourceManifestRecord } from "../src/sourceService.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const durable = { timeout: 30_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

async function fixture(t) {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  const owner = `source_list_${randomUUID()}`;
  const stranger = `source_list_${randomUUID()}`;
  const documents = new ProductDocuments(database);
  const sources = new SourceService(documents, new ProductJobs(database));
  t.after(async () => {
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1)", [[owner, stranger]]);
    await database.close();
  });
  for (const id of [owner, stranger]) {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Owner','development')", [id]);
    for (const project of ["default", "study"]) await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,$2,1048576)", [id, project]);
  }
  let counter = 0;
  /** Register one document and, when asked, set what an understanding would have left on it. */
  const add = async (userId, projectId, name, patch = {}) => {
    counter += 1;
    const sha256 = counter.toString(16).padStart(64, "0");
    const { source } = await sources.register(userId, { projectId, connector: { type: "upload", id: `${projectId}-library` },
      path: `knowledge-base/${name}`, sha256, size: 1000 + counter, mimeType: "application/octet-stream", mtime: "2026-09-06T00:00:00.000Z" });
    if (!Object.keys(patch).length) return source;
    return documents.put(userId, "source", source.id, { ...source.payload, ...patch }, { expectedRevision: source.revision, projectId });
  };
  return { database, documents, sources, owner, stranger, add };
}

/** @param {any} page */
const names = (page) => page.items.map((item) => item.payload.paths[0].replace("knowledge-base/", ""));

test("the list is a page at a time, newest first, and its counts are the whole scope's, not the page's", durable, async (t) => {
  const { sources, owner, add } = await fixture(t);
  for (let index = 1; index <= 7; index += 1) await add(owner, "default", `file-${index}.pdf`);
  await add(owner, "study", "elsewhere.pdf");
  const first = await sources.list(owner, { projectId: "default", limit: 3 });
  assert.deepEqual(names(first), ["file-7.pdf", "file-6.pdf", "file-5.pdf"]);
  assert.ok(first.nextCursor);
  const second = await sources.list(owner, { projectId: "default", limit: 3, cursor: first.nextCursor });
  assert.deepEqual(names(second), ["file-4.pdf", "file-3.pdf", "file-2.pdf"]);
  const last = await sources.list(owner, { projectId: "default", limit: 3, cursor: second.nextCursor });
  assert.deepEqual(names(last), ["file-1.pdf"]);
  assert.equal(last.nextCursor, null);
  for (const page of [first, second, last]) assert.equal(page.counts.all, 7, "every page says how many there are in all");
  // No silent ceiling: more than the page default is still all reachable.
  for (let index = 8; index <= 60; index += 1) await add(owner, "default", `file-${index}.pdf`);
  let seen = 0;
  let cursor = null;
  do {
    const page = await sources.list(owner, { projectId: "default", limit: 50, cursor });
    seen += page.items.length;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen, 60);
  await assert.rejects(sources.list(owner, { projectId: "default", limit: 500 }), { code: "product_parameter_invalid" });
  await assert.rejects(sources.list(owner, { projectId: "default", cursor: "not-a-cursor" }), { code: "product_cursor_invalid" });
});

test("a search runs over the whole scope: the title, the title the parser read, the authors, what it says and the file's name", durable, async (t) => {
  const { sources, owner, stranger, add } = await fixture(t);
  await add(owner, "default", "ruanguo-guideline.pdf", { docType: "review-guideline", metadata: { title: "幽门螺杆菌感染处理第六次全国共识报告", authors: ["刘文忠", "谢勇"] },
    outputs: { summary: "给出一线四联方案与疗程。" }, currentUnderstandingId: "understanding:x:g1" });
  await add(owner, "default", "AAP-uti.pdf", { docType: "review-guideline", metadata: { title: "AAP 2026 儿童尿路感染指南" }, outputs: { summary: "Duration of antibiotics." } });
  await add(owner, "default", "note-1.md", { title: "10月3日组会记录", docType: "note-memo" });
  await add(owner, "default", "100%_done.pdf");
  await add(owner, "default", "100x.pdf");
  await add(owner, "study", "幽门螺杆菌-other-project.pdf");
  await add(stranger, "default", "幽门螺杆菌-stranger.pdf");
  const search = async (q, extra = {}) => names(await sources.list(owner, { projectId: "default", q, ...extra }));
  assert.deepEqual(await search("幽门螺杆菌"), ["ruanguo-guideline.pdf"], "the parsed title; another project's and another account's documents are not in it");
  assert.deepEqual(await search("谢勇"), ["ruanguo-guideline.pdf"], "an author");
  assert.deepEqual(await search("四联方案"), ["ruanguo-guideline.pdf"], "what it says");
  assert.deepEqual(await search("antibiotics"), ["AAP-uti.pdf"]);
  assert.deepEqual(await search("DURATION"), ["AAP-uti.pdf"], "case does not matter");
  assert.deepEqual(await search("组会"), ["note-1.md"], "a note's own title");
  assert.deepEqual(await search("uti.pdf"), ["AAP-uti.pdf"], "the file's name");
  assert.deepEqual(await search("knowledge-base"), [], "the folder is not part of what a document is called");
  assert.deepEqual(await search("100%"), ["100%_done.pdf"], "a percent sign is a percent sign");
  assert.deepEqual(await search("_done"), ["100%_done.pdf"]);
  assert.deepEqual(await search("100_.pdf"), [], "an underscore is not a wildcard for the x of 100x.pdf");
  assert.deepEqual(await search("不存在的词"), []);
  const searched = await sources.list(owner, { projectId: "default", q: "AAP" });
  assert.equal(searched.counts.all, 1, "the counts are the search's");
  await assert.rejects(sources.list(owner, { projectId: "default", q: "x".repeat(201) }), { code: "source_payload_invalid" });
});

test("the chips count by what a document is, and choosing one narrows the page without moving the counts", durable, async (t) => {
  const { sources, owner, add } = await fixture(t);
  await add(owner, "default", "a.pdf", { docType: "published-paper" });
  await add(owner, "default", "b.pdf", { docType: "review-guideline" });
  await add(owner, "default", "c.xlsx", { docType: "dataset" });
  await add(owner, "default", "d.csv", { docType: "cohort-data" });
  await add(owner, "default", "e.docx", { docType: "policy-document" });
  await add(owner, "default", "f.pdf", { docType: "document" });
  await add(owner, "default", "g.html", { docType: "webpage" });
  await add(owner, "default", "h.md", { docType: "note-memo" });
  await add(owner, "default", "i.png", { docType: "image-figure" });
  await add(owner, "default", "j.pdf", { docType: "audio-recording" });
  const all = await sources.list(owner, { projectId: "default" });
  assert.deepEqual(all.counts, { all: 10, literature: 2, table: 2, document: 3, page: 1, note: 1, image: 1 });
  const tables = await sources.list(owner, { projectId: "default", kind: "table" });
  assert.deepEqual(names(tables).sort(), ["c.xlsx", "d.csv"]);
  assert.deepEqual(tables.counts, all.counts, "choosing a chip does not change the inventory");
  assert.deepEqual(names(await sources.list(owner, { projectId: "default", kind: "document" })).sort(), ["e.docx", "f.pdf", "j.pdf"], "a type the list no longer has is a document");
  assert.deepEqual(names(await sources.list(owner, { projectId: "default", kind: "literature", q: "b.p" })), ["b.pdf"]);
  assert.deepEqual((await sources.list(owner, { projectId: "default", kind: "note", q: "zzz" })).items, []);
  await assert.rejects(sources.list(owner, { projectId: "default", kind: "paper" }), { code: "source_payload_invalid" });
});

test("a state still narrows the list, and a document that cannot be used yet is listed as reading", durable, async (t) => {
  const { sources, owner, add } = await fixture(t);
  const reading = await add(owner, "default", "reading.pdf");
  await add(owner, "default", "ready.pdf", { status: "complete" });
  await add(owner, "default", "broken.pdf", { status: "failed", error: { code: "source_parser_timeout", message: "x" } });
  assert.deepEqual(names(await sources.list(owner, { projectId: "default", state: "reading" })), ["reading.pdf"]);
  assert.deepEqual(names(await sources.list(owner, { projectId: "default", state: "ready" })), ["ready.pdf"]);
  assert.deepEqual(names(await sources.list(owner, { projectId: "default", state: "attention" })), ["broken.pdf"]);
  assert.equal((await sources.listByState(owner, { projectId: "default", state: "reading" })).items[0].id, reading.id);
  await assert.rejects(sources.list(owner, { projectId: "default", state: "understanding" }), { code: "source_payload_invalid" });
  await assert.rejects(sources.list(owner, { projectId: "default", state: "reading", status: "parsing" }), { code: "source_payload_invalid" });
});

test("the shared scope lists one document per entry of the account library, whichever project holds it", durable, async (t) => {
  const { database, documents, sources, owner, stranger, add } = await fixture(t);
  const shared = await add(owner, "default", "shared-guideline.pdf", { docType: "review-guideline" });
  const sameBytesElsewhere = await sources.register(owner, { projectId: "study", connector: { type: "upload", id: "study-library" }, path: "knowledge-base/copy.pdf",
    sha256: shared.payload.fingerprint.sha256, size: shared.payload.fingerprint.size, mimeType: "application/octet-stream", mtime: "2026-09-06T00:00:00.000Z" });
  await add(owner, "default", "private.pdf");
  const theirs = await add(stranger, "default", "their-shared.pdf");
  const entry = (userId, source) => documents.put(userId, "preferences", `library:${source.payload.fingerprint.sha256}`,
    { recordType: "library-item", sourceId: source.id, sha256: source.payload.fingerprint.sha256, addedAt: "2026-10-01T00:00:00.000Z" }, { expectedRevision: 0 });
  await entry(owner, shared);
  await entry(stranger, theirs);
  const page = await sources.list(owner, { shared: true });
  assert.deepEqual(page.items.map((item) => item.id), [shared.id], "one row for the document, the one it was added from; nothing private, nothing of another account's");
  assert.equal(page.items[0].projectId, "default");
  assert.deepEqual(page.counts, { all: 1, literature: 1, table: 0, document: 0, page: 0, note: 0, image: 0 });
  assert.equal(page.items[0].shared, true);
  assert.equal(projectSourceManifestRecord(page.items[0]).display.shared, true);
  // The project's own list says which of its documents are shared, without a second request.
  const own = await sources.list(owner, { projectId: "default" });
  assert.deepEqual(own.items.map((item) => [item.payload.paths[0].replace("knowledge-base/", ""), item.shared]).sort(), [["private.pdf", false], ["shared-guideline.pdf", true]]);
  assert.equal((await sources.list(owner, { projectId: "study" })).items.find((item) => item.id === sameBytesElsewhere.source.id).shared, true, "the same bytes in another project are the same document");
  // The shared documents are searched and counted like any scope; a removed entry is out of it.
  assert.deepEqual((await sources.list(owner, { shared: true, q: "nothing like it" })).items, []);
  assert.equal((await sources.list(owner, { shared: true, kind: "table" })).items.length, 0);
  await database.query("UPDATE evimed_product.documents SET deleted_at=clock_timestamp() WHERE user_id=$1 AND kind='preferences'", [owner]);
  assert.deepEqual((await sources.list(owner, { shared: true })).items, []);
  await assert.rejects(sources.list(owner, { shared: true, status: "complete" }), { code: "source_payload_invalid" });
});

test("a link's title and address are kept on its source, and the same bytes read again only update when they were read", durable, async (t) => {
  const { sources, owner } = await fixture(t);
  const link = (fetchedAt) => ({ url: "https://www.nmpa.gov.cn/notice", finalUrl: "https://www.nmpa.gov.cn/notice", site: "nmpa.gov.cn", fetchedAt, rendered: false, original: null });
  const input = (extra = {}) => ({ projectId: "default", connector: { type: "upload", id: "default-library" }, path: "knowledge-base/links/nmpa.gov.cn-notice-1a2b3c4d.md",
    sha256: "e".repeat(64), size: 500, mimeType: "text/markdown", mtime: "2026-10-07T08:00:00.000Z", ...extra });
  const first = await sources.register(owner, input({ title: "关于修订阿莫西林制剂说明书的公告", link: link("2026-10-07T08:00:00.000Z") }));
  assert.equal(first.source.payload.title, "关于修订阿莫西林制剂说明书的公告");
  assert.equal(first.source.payload.link.site, "nmpa.gov.cn");
  assert.equal(first.source.payload.docType, "webpage");
  const again = await sources.register(owner, input({ title: "关于修订阿莫西林制剂说明书的公告", link: link("2026-10-08T09:00:00.000Z") }));
  assert.equal(again.duplicate, true);
  assert.equal(again.source.id, first.source.id);
  assert.equal(again.source.payload.link.fetchedAt, "2026-10-08T09:00:00.000Z");
  const listed = (await sources.list(owner, { projectId: "default", q: "nmpa" })).items;
  assert.deepEqual(listed.map((item) => item.id), [first.source.id], "the address is searchable");
  await assert.rejects(sources.register(owner, input({ sha256: "f".repeat(64), link: { url: "", site: "x", fetchedAt: "now" } })), { code: "source_payload_invalid" });
  await assert.rejects(sources.register(owner, input({ sha256: "d".repeat(64), title: "x".repeat(301) })), { code: "source_payload_invalid" });
});
