import assert from "node:assert/strict";
import test from "node:test";
import { sourceDisplayOf, sourceGist } from "../src/sourceDisplay.mjs";
import { projectSourceManifestRecord } from "../src/sourceService.mjs";

test("a row's one line is the first sentence of what the document says, cut where a line ends", () => {
  assert.equal(sourceGist("给出一线四联方案、疗程 14 天与根除后复查的推荐，附证据等级。其余内容从略。"), "给出一线四联方案、疗程 14 天与根除后复查的推荐，附证据等级。");
  assert.equal(sourceGist("The guideline recommends bismuth quadruple therapy for 14 days. Details follow."), "The guideline recommends bismuth quadruple therapy for 14 days.");
  assert.equal(sourceGist("第一行没有句号\n第二行不属于这一句"), "第一行没有句号");
  assert.equal(sourceGist("版本 1.2 的说明书规定了用量。"), "版本 1.2 的说明书规定了用量。", "a decimal point is not the end of a sentence");
  const long = sourceGist(`${"很长的一句话".repeat(40)}。`);
  assert.ok(long && long.length <= 90 && long.endsWith("…"));
  assert.equal(sourceGist(""), null);
  assert.equal(sourceGist("   \n  "), null);
  assert.equal(sourceGist(undefined), null);
});

/** @param {Record<string, any>} payload @param {string} [id] */
const row = (payload, id = "src_" + "a".repeat(32)) => ({ id, payload: { paths: ["knowledge-base/a.pdf"], connector: { type: "upload", id: "p-library" }, docType: "document", status: "complete", ...payload } });

test("a row says what the document is called, in the order the researcher would name it", () => {
  assert.equal(sourceDisplayOf(row({})).title, "a.pdf");
  assert.equal(sourceDisplayOf(row({ metadata: { title: "幽门螺杆菌感染处理第六次全国共识报告" } })).title, "幽门螺杆菌感染处理第六次全国共识报告");
  assert.equal(sourceDisplayOf(row({ metadata: { title: "解析出的标题" }, title: "我给它起的名字" })).title, "我给它起的名字");
  assert.equal(sourceDisplayOf(row({ metadata: { title: "   " } })).title, "a.pdf", "a blank title is no title");
});

test("what a document says shows once it is understood, and never the parser's opening lines", () => {
  const outputs = { summary: "AAP 2026 儿童尿路感染诊断与管理指南。本版更新了抗生素疗程。" };
  assert.equal(sourceDisplayOf(row({ outputs })).gist, null, "no understanding yet: the summary is the document's own opening text");
  assert.equal(sourceDisplayOf(row({ outputs, currentUnderstandingId: "understanding:x:g1" })).gist, "AAP 2026 儿童尿路感染诊断与管理指南。");
});

test("a row carries the type, the chip, where it came from and the facts a meta line states", () => {
  const paper = sourceDisplayOf(row({ docType: "review-guideline", analysis: { pageCount: 18 }, fingerprint: { size: 2_200_000 } }));
  assert.deepEqual([paper.typeLabel, paper.typeShort, paper.kind, paper.origin, paper.pages, paper.size, paper.format],
    ["综述或指南", "综述或指南", "literature", "upload", 18, 2_200_000, "pdf"]);
  const link = sourceDisplayOf(row({ docType: "webpage", paths: ["knowledge-base/links/nmpa.gov.cn-notice-1a2b3c4d.md"],
    link: { url: "https://www.nmpa.gov.cn/notice", site: "nmpa.gov.cn" }, title: "关于修订阿莫西林制剂说明书的公告" }));
  assert.deepEqual([link.kind, link.origin, link.site, link.url, link.title], ["page", "link", "nmpa.gov.cn", "https://www.nmpa.gov.cn/notice", "关于修订阿莫西林制剂说明书的公告"]);
  assert.equal(sourceDisplayOf(row({ docType: "note-memo", paths: ["knowledge-base/notes/a.md"] })).origin, "note");
  assert.equal(sourceDisplayOf(row({ paths: ["knowledge-base/frontier/a.pdf"] })).origin, "frontier");
  assert.equal(sourceDisplayOf(row({ paths: ["knowledge-base/open-access/trial/a.xlsx"], docType: "dataset" })).origin, "conversation");
  assert.equal(sourceDisplayOf(row({ paths: ["openlist/docs/a.pdf"], connector: { type: "openlist", id: "/docs/a.pdf" } })).origin, "drive");
  // A stored type the list no longer has reads as a document, never as its id.
  const stale = sourceDisplayOf(row({ docType: "audio-recording" }));
  assert.deepEqual([stale.typeLabel, stale.kind], ["其他", "document"]);
  assert.equal(sourceDisplayOf(row({ analysis: { pageCount: 0 }, fingerprint: {} })).pages, null);
});

test("the projection adds the display to the card and keeps the list query's own column out of it", () => {
  const card = projectSourceManifestRecord({ ...row({ docType: "dataset", paths: ["knowledge-base/a.xlsx"] }), revision: 1, shared: true });
  assert.equal(card.display.kind, "table");
  assert.equal(card.display.shared, true);
  assert.equal("shared" in card, false);
  assert.equal(projectSourceManifestRecord({ ...row({}), revision: 1 }).display.shared, null, "a card read alone does not know whether the library holds it");
});
