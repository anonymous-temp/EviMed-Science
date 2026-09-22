// The reader's two writing actions with stubs (build spec D.5, D.6): 存入知识库
// as an open-access PDF or as an honest record, through the upload's path;
// 中文摘要 cached, budget-gated, number-checked, one call per item.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRONTIER_ABSTRACT_NOTES,
  FRONTIER_ABSTRACT_READER_HOURLY,
  FrontierActions,
  fetchOpenAccessPdf,
  frontierLibraryRecord,
  frontierLibrarySlug,
} from "../src/frontierActions.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";

const PUBLIC_ID = "a1b2c3d4e5f60718";
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 1)]);

/** A published item row as the actions read it. @param {Record<string, any>} [overrides] */
const itemRow = (overrides = {}) => ({
  id: "41", public_id: PUBLIC_ID, title_raw: "Semaglutide and Kidney Outcomes in Type 2 Diabetes", title_zh: "司美格鲁肽与 2 型糖尿病肾脏结局",
  summary_zh: "FLOW 试验显示肾脏复合终点风险降低 24%。", reason_zh: "改变糖尿病肾病的用药选择。", lang: "en", doi: "10.1056/NEJMoa2403347", pmid: "38785209",
  registry_ids: ["NCT03819153"], canonical_url: "https://www.nejm.org/doi/full/10.1056/NEJMoa2403347",
  published_at: "2026-09-20T16:30:00Z", timeline_at: "2026-09-21T01:00:00Z", date_precision: "day", source_type: "journal", source_name: "NEJM",
  text_id: "41", abstract_raw: "The risk of a primary-outcome event was 24% lower in the semaglutide group (hazard ratio, 0.76).", abstract_zh: null,
  journal: "N Engl J Med", authors_short: "Perkovic V, et al.", open_access: "bronze", oa_pdf_url: null, ...overrides,
});

/** A database that answers the item read and the abstract write, and records every statement. */
function stubDatabase(item) {
  const statements = [];
  const client = {
    query: async (sql, values = []) => {
      statements.push(sql);
      if (/UPDATE evimed_frontier\.item_texts SET abstract_zh/.test(sql)) return { rows: [{ abstract_zh: values[1] }], rowCount: 1 };
      if (/INSERT INTO evimed_frontier\.meta/.test(sql)) return { rows: [{ version: 2 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return {
    statements,
    transaction: async (operation) => operation(client),
    query: async (sql, values = []) => {
      statements.push(sql);
      if (/FROM evimed_frontier\.items i JOIN evimed_frontier\.sources/.test(sql)) return { rows: item && values[0] === item.public_id ? [item] : [], rowCount: item ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}

/** A library that records what was saved where. */
function stubLibrary({ saveError = null } = {}) {
  const saved = [];
  return {
    saved,
    project: async (_user, projectId) => ({ id: projectId }),
    save: async (input) => { if (saveError) throw saveError; saved.push(input); return { duplicate: false }; },
  };
}

const glossary = { current: async () => new FrontierGlossary([{ kind: "drug", termEn: "semaglutide", termZh: "司美格鲁肽", keepOriginal: false }]) };
const user = { id: "reader" };

/** @param {Array<{ status: number, headers?: Record<string, string>, body?: Buffer }>} answers */
function transportOf(answers) {
  const requests = [];
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      const answer = answers.shift() ?? { status: 404 };
      return { status: answer.status, headers: answer.headers ?? {}, body: answer.body ?? Buffer.alloc(0) };
    },
  };
}

test("a saved item's file name: its day, a slug of its title in any script, a piece of its id", () => {
  assert.equal(frontierLibrarySlug({ publicId: PUBLIC_ID, title: "Semaglutide and Kidney Outcomes!", day: "2026-09-21" }),
    "2026-09-21-semaglutide-and-kidney-outcomes-a1b2c3");
  assert.equal(frontierLibrarySlug({ publicId: PUBLIC_ID, title: "国家药监局：关于修订 XX 说明书的公告", day: "2026-09-21" }),
    "2026-09-21-国家药监局-关于修订-xx-说明书的公告-a1b2c3");
  assert.equal(frontierLibrarySlug({ publicId: PUBLIC_ID, title: "——", day: "2026-09-21" }), "2026-09-21-item-a1b2c3");
  assert.ok([...frontierLibrarySlug({ publicId: PUBLIC_ID, title: "x".repeat(300), day: "2026-09-21" })].length < 60);
});

test("the Markdown record carries what a reader needs to cite and find the work again, and says it holds no full text", () => {
  const record = frontierLibraryRecord({ item: itemRow(), savedAt: new Date("2026-09-22T04:00:00Z"), day: "2026-09-21" });
  for (const expected of ["# 司美格鲁肽与 2 型糖尿病肾脏结局", "原标题：Semaglutide and Kidney Outcomes in Type 2 Diabetes", "来源：NEJM（期刊）",
    "作者：Perkovic V, et al.", "期刊：N Engl J Med", "发布日期：2026-09-21", "DOI：10.1056/NEJMoa2403347", "PMID：38785209", "注册号：NCT03819153",
    "原文链接：https://www.nejm.org/doi/full/10.1056/NEJMoa2403347", "开放获取：bronze", "## 导读", "## 为什么值得看", "## 原文摘要",
    "由 EviMed「前沿动态」于 2026-09-22 存入。"]) {
    assert.ok(record.includes(expected), expected);
  }
  const closed = frontierLibraryRecord({ item: itemRow({ open_access: null, abstract_raw: null, date_precision: "inferred" }), savedAt: new Date(), day: "2026-09-21" });
  assert.match(closed, /开放获取：无开放获取全文，这里只存题录和链接/);
  assert.doesNotMatch(closed, /原文摘要|发布日期/, "no abstract to show, and an inferred date is not stated as a date");
});

test("an open-access PDF is fetched hop by hop through the pinned transport and must be a PDF", async () => {
  const ok = transportOf([{ status: 302, headers: { location: "/files/paper.pdf" } }, { status: 200, body: PDF }]);
  const pdf = await fetchOpenAccessPdf({ url: "https://journals.example.org/doi/pdf/10.1/x", transport: ok.transport, userAgent: "EviMedBot/1.0 test", maxBytes: 1024 });
  assert.equal(pdf.finalUrl, "https://journals.example.org/files/paper.pdf");
  assert.equal(ok.requests[0].headers["user-agent"], "EviMedBot/1.0 test");
  assert.equal(ok.requests[0].maxBytes, 1024, "the body bound travels with every hop");
  await assert.rejects(fetchOpenAccessPdf({ url: "https://journals.example.org/x", transport: transportOf([{ status: 200, body: Buffer.from("<html>login</html>") }]).transport,
    userAgent: "t", maxBytes: 1024 }), { code: "frontier_library_pdf_invalid" });
  await assert.rejects(fetchOpenAccessPdf({ url: "https://journals.example.org/x", transport: transportOf([{ status: 403 }]).transport, userAgent: "t", maxBytes: 1024 }),
    { code: "frontier_library_pdf_unavailable" });
  await assert.rejects(fetchOpenAccessPdf({ url: "https://journals.example.org/x", transport: transportOf([{ status: 302, headers: { location: "http://127.0.0.1/admin" } }]).transport,
    userAgent: "t", maxBytes: 1024 }), { code: "web_read_host_forbidden" }, "a redirect into this network is refused before it is followed");
  await assert.rejects(fetchOpenAccessPdf({ url: "http://localhost/x.pdf", transport: transportOf([]).transport, userAgent: "t", maxBytes: 1024 }),
    { code: "web_read_host_forbidden" });
  const loop = transportOf(Array.from({ length: 8 }, () => ({ status: 301, headers: { location: "https://journals.example.org/again" } })));
  await assert.rejects(fetchOpenAccessPdf({ url: "https://journals.example.org/x", transport: loop.transport, userAgent: "t", maxBytes: 1024 }),
    { code: "frontier_library_pdf_redirects" });
  assert.equal(loop.requests.length, 6, "five redirects followed, and no more");
});

test("存入知识库 saves the open-access PDF into knowledge-base/frontier through the library's path", async () => {
  const library = stubLibrary();
  const pdf = transportOf([{ status: 200, body: PDF }]);
  const actions = new FrontierActions({ database: stubDatabase(itemRow({ oa_pdf_url: "https://journals.example.org/paper.pdf" })), library, glossary,
    pdfTransport: pdf.transport, config: { maxFileBytes: 4096, frontierTimeZone: "Asia/Shanghai" } });
  assert.equal(actions.capabilities().saveToLibrary, true);
  const answer = await actions.saveToLibrary(user, PUBLIC_ID, { projectId: "cardio-review" });
  assert.deepEqual(answer, { saved: { kind: "pdf", path: "knowledge-base/frontier/2026-09-21-semaglutide-and-kidney-outcomes-in-type-a1b2c3.pdf", note: null } });
  assert.equal(library.saved.length, 1);
  assert.deepEqual(library.saved[0].project, { id: "cardio-review" });
  assert.equal(library.saved[0].rel, answer.saved.path);
  assert.ok(library.saved[0].buffer.equals(PDF));
  assert.equal(pdf.requests[0].maxBytes, 4096, "a PDF is bounded by the upload limit");
});

test("without an open-access PDF, or when it cannot be had, the record is saved and the answer says which", async () => {
  const closed = stubLibrary();
  const answer = await new FrontierActions({ database: stubDatabase(itemRow()), library: closed, glossary }).saveToLibrary(user, PUBLIC_ID, { projectId: "cardio-review" });
  assert.equal(answer.saved.kind, "md");
  assert.equal(answer.saved.note, null);
  assert.match(answer.saved.path, /^knowledge-base\/frontier\/2026-09-21-.*-a1b2c3\.md$/);
  assert.match(closed.saved[0].buffer.toString("utf8"), /^# 司美格鲁肽与 2 型糖尿病肾脏结局/);

  const failing = stubLibrary();
  const refused = await new FrontierActions({ database: stubDatabase(itemRow({ oa_pdf_url: "https://journals.example.org/paper.pdf" })), library: failing, glossary,
    pdfTransport: transportOf([{ status: 403 }]).transport }).saveToLibrary(user, PUBLIC_ID, { projectId: "cardio-review" });
  assert.equal(refused.saved.kind, "md");
  assert.equal(refused.saved.note, "开放获取全文暂时下载不了，先存了题录和链接。");
  assert.match(failing.saved[0].buffer.toString("utf8"), /开放获取全文这次没有下载成功。/);
});

test("存入知识库 refuses what is not a reader's own project, and a full project is the reader's to see", async () => {
  const actions = new FrontierActions({ database: stubDatabase(itemRow({ oa_pdf_url: "https://journals.example.org/paper.pdf" })), glossary,
    library: stubLibrary({ saveError: Object.assign(new Error("full"), { status: 413, code: "project_quota_exceeded" }) }),
    pdfTransport: transportOf([{ status: 200, body: PDF }]).transport });
  await assert.rejects(actions.saveToLibrary(user, PUBLIC_ID, { projectId: "evimed-frontier" }), { code: "project_not_found" });
  await assert.rejects(actions.saveToLibrary(user, PUBLIC_ID, { projectId: "../etc" }), { code: "frontier_library_project_invalid" });
  await assert.rejects(actions.saveToLibrary(user, PUBLIC_ID, {}), { code: "frontier_library_project_invalid" });
  await assert.rejects(actions.saveToLibrary(user, "nope", { projectId: "cardio-review" }), { code: "frontier_item_not_found" });
  await assert.rejects(actions.saveToLibrary(user, PUBLIC_ID, { projectId: "cardio-review" }), { code: "project_quota_exceeded" },
    "a refused write is not papered over with a record");
  const noLibrary = new FrontierActions({ database: stubDatabase(itemRow()), glossary });
  assert.equal(noLibrary.capabilities().saveToLibrary, false);
  await assert.rejects(noLibrary.saveToLibrary(user, PUBLIC_ID, { projectId: "cardio-review" }), { code: "not_found" });
});

/** An editor stub: available, and answering the abstract with what the test says. */
function stubEditor(answer) {
  const calls = [];
  return {
    calls,
    available: true,
    writeAbstractZh: async (input) => {
      calls.push(input);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return answer;
    },
  };
}

test("中文摘要: the cached one, or the original with a sentence when there is nothing to translate or no way to", async () => {
  const cached = stubEditor(null);
  assert.deepEqual(await new FrontierActions({ database: stubDatabase(itemRow({ abstract_zh: "已写好的中文摘要。" })), editor: cached, glossary }).abstractZh(user, PUBLIC_ID),
    { abstractZh: "已写好的中文摘要。", abstract: itemRow().abstract_raw, note: null });
  assert.equal(cached.calls.length, 0);
  assert.deepEqual(await new FrontierActions({ database: stubDatabase(itemRow({ abstract_raw: null })), editor: cached, glossary }).abstractZh(user, PUBLIC_ID),
    { abstractZh: null, abstract: null, note: FRONTIER_ABSTRACT_NOTES.none });
  const chinese = "本研究纳入 3533 例患者，主要终点风险降低 24%。";
  assert.deepEqual(await new FrontierActions({ database: stubDatabase(itemRow({ abstract_raw: chinese })), editor: cached, glossary }).abstractZh(user, PUBLIC_ID),
    { abstractZh: chinese, abstract: chinese, note: null }, "a Chinese source's abstract is already the Chinese abstract");
  assert.deepEqual(await new FrontierActions({ database: stubDatabase(itemRow()), editor: { available: false }, glossary }).abstractZh(user, PUBLIC_ID),
    { abstractZh: null, abstract: itemRow().abstract_raw, note: FRONTIER_ABSTRACT_NOTES.unavailable });
  const spent = new FrontierActions({ database: stubDatabase(itemRow()), editor: cached, glossary, budget: async () => ({ state: "exhausted" }) });
  assert.deepEqual(await spent.abstractZh(user, PUBLIC_ID), { abstractZh: null, abstract: itemRow().abstract_raw, note: FRONTIER_ABSTRACT_NOTES.exhausted });
  assert.equal(cached.calls.length, 0, "no call was made for any of these");
});

test("中文摘要 written once for everyone: one call per item however many readers ask at once, stored and announced", async () => {
  const editor = stubEditor({ verification: "passed", abstractZh: "司美格鲁肽组主要结局事件风险降低 24%（风险比 0.76）。", error: null });
  const database = stubDatabase(itemRow());
  const actions = new FrontierActions({ database, editor, glossary, budget: async () => ({ state: "throttled" }) });
  const [first, second] = await Promise.all([actions.abstractZh(user, PUBLIC_ID), actions.abstractZh({ id: "other" }, PUBLIC_ID)]);
  assert.equal(editor.calls.length, 1);
  assert.deepEqual(first, { abstractZh: "司美格鲁肽组主要结局事件风险降低 24%（风险比 0.76）。", abstract: itemRow().abstract_raw, note: null });
  assert.deepEqual(second, first);
  assert.deepEqual(editor.calls[0].glossary.map((entry) => entry.termEn), ["semaglutide"], "only the glossary entries its own text names");
  assert.ok(database.statements.some((sql) => /UPDATE evimed_frontier\.item_texts SET abstract_zh/.test(sql)));
  assert.ok(database.statements.some((sql) => /INSERT INTO evimed_frontier\.meta/.test(sql)), "the item's answer moves with the content version");
});

test("中文摘要: one reader causes at most thirty new ones an hour; a cached one is never counted", async () => {
  let now = new Date("2026-09-22T04:00:00Z");
  const editor = stubEditor({ verification: "dropped", abstractZh: null, error: null });
  const actions = new FrontierActions({ database: stubDatabase(itemRow()), editor, glossary, now: () => now });
  for (let call = 0; call < FRONTIER_ABSTRACT_READER_HOURLY; call += 1) await actions.abstractZh(user, PUBLIC_ID);
  assert.equal(editor.calls.length, FRONTIER_ABSTRACT_READER_HOURLY);
  assert.deepEqual(await actions.abstractZh(user, PUBLIC_ID), { abstractZh: null, abstract: itemRow().abstract_raw, note: FRONTIER_ABSTRACT_NOTES.limited });
  assert.equal(editor.calls.length, FRONTIER_ABSTRACT_READER_HOURLY, "the thirty-first is not asked");
  assert.equal(actions.counters.abstractsLimited, 1);
  await actions.abstractZh({ id: "someone-else" }, PUBLIC_ID);
  assert.equal(editor.calls.length, FRONTIER_ABSTRACT_READER_HOURLY + 1, "another reader's hour is their own");
  now = new Date(now.getTime() + 3_600_001);
  await actions.abstractZh(user, PUBLIC_ID);
  assert.equal(editor.calls.length, FRONTIER_ABSTRACT_READER_HOURLY + 2, "an hour later the reader may ask again");
  const cached = new FrontierActions({ database: stubDatabase(itemRow({ abstract_zh: "已写好。" })), editor, glossary, now: () => now });
  for (let call = 0; call < FRONTIER_ABSTRACT_READER_HOURLY + 5; call += 1) assert.equal((await cached.abstractZh(user, PUBLIC_ID)).abstractZh, "已写好。");
});

test("中文摘要 that fails its number check is not shown: the original is, with the reason", async () => {
  const dropped = new FrontierActions({ database: stubDatabase(itemRow()), glossary,
    editor: stubEditor({ verification: "dropped", abstractZh: null, error: null }) });
  assert.deepEqual(await dropped.abstractZh(user, PUBLIC_ID), { abstractZh: null, abstract: itemRow().abstract_raw, note: FRONTIER_ABSTRACT_NOTES.dropped });
  const failed = new FrontierActions({ database: stubDatabase(itemRow()), glossary,
    editor: stubEditor({ verification: "pending", abstractZh: null, error: "frontier_model_timeout" }) });
  assert.equal((await failed.abstractZh(user, PUBLIC_ID)).note, FRONTIER_ABSTRACT_NOTES.failed);
  assert.equal(failed.counters.abstractsDropped, 1);
});
