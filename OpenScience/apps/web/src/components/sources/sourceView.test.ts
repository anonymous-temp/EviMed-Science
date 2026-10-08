import { describe, expect, it } from "vitest";
import type { SourceDisplay, SourceRecord } from "@/lib/sourceClient";
import { conversationDraft, fileNameOf, isEditableNote, isReading, isUsable, kindIcon, metaLine, originalPathOf, readerMeta, stateLabel } from "./sourceView";

const display = (overrides: Partial<SourceDisplay> = {}): SourceDisplay => ({
  title: "幽门螺杆菌感染处理第六次全国共识报告", gist: null, docType: "review-guideline", typeLabel: "综述或指南", typeShort: "指南", kind: "literature",
  origin: "upload", format: "pdf", pages: 18, size: 2_200_000, site: null, url: null, shared: null, ...overrides,
});
const source = (overrides: Partial<SourceRecord["payload"]> = {}, shown: Partial<SourceDisplay> = {}, extra: Partial<SourceRecord> = {}) => ({
  id: "src_one", projectId: "project-one", revision: 1, createdAt: "2026-10-03T08:00:00Z", updatedAt: "2026-10-03T08:00:00Z", deletedAt: null,
  display: display(shown),
  payload: { paths: ["knowledge-base/共识.pdf"], status: "complete", docType: "review-guideline", depth: "structured", version: 1, reasons: [], valueVector: {}, coverage: null, outputs: {}, ...overrides },
  ...extra,
}) as SourceRecord;

describe("a row's meta line", () => {
  it("says what the document is, how long, and where it came from", () => {
    expect(metaLine(source())).toBe("指南 · 18 页 · 上传");
    expect(metaLine(source({}, { pages: null, size: 2_200_000, typeShort: "文档", kind: "document", origin: "drive" }))).toBe("文档 · 2.1 MB · 网盘");
    expect(metaLine(source({}, { typeShort: "网页", kind: "page", origin: "link", site: "nmpa.gov.cn", pages: null }))).toBe("网页 · nmpa.gov.cn · 链接");
    expect(metaLine(source({}, { typeShort: "数据表", kind: "table", origin: "conversation", pages: null, size: null, shared: true }))).toBe("数据表 · 对话产出 · 所有项目可用");
    expect(metaLine(source({}, { typeShort: "笔记", kind: "note", origin: "note", pages: null, size: null }))).toBe("笔记 · 笔记");
    expect(metaLine(source({}, { origin: "frontier" }))).toBe("指南 · 18 页 · 前沿动态");
  });

  it("leaves 「所有项目可用」 out where every row is shared", () => {
    expect(metaLine(source({}, { shared: true }), { showShared: false })).toBe("指南 · 18 页 · 上传");
  });

  it("is never an id, a status word or a model's name", () => {
    expect(metaLine(source({ docType: "audio-recording", status: "needs_attention" }, { typeShort: "文档", pages: null, size: null }))).toBe("文档 · 上传");
  });
});

describe("a document page's meta line", () => {
  // A day in an earlier year is dated with its year, so these do not depend on the clock.
  const earlier = { createdAt: "2020-10-03T08:00:00Z" };
  it("says what the document is, how big, how long, where it came from and when", () => {
    expect(readerMeta(source({}, {}, earlier))).toBe("指南 · 2.1 MB · 18 页 · 上传 · 2020-10-03");
    expect(readerMeta(source({}, { typeShort: "网页", kind: "page", origin: "link", site: "nmpa.gov.cn", pages: null, size: 9000 }, earlier))).toBe("网页 · nmpa.gov.cn · 8.8 KB · 链接 · 2020-10-03");
    expect(readerMeta(source({}, { typeShort: "数据表", kind: "table", origin: "conversation", pages: null, size: 48_000, shared: true }, earlier))).toBe("数据表 · 47 KB · 对话产出 · 所有项目可用 · 2020-10-03");
  });

  it("leaves out what is not known, and is never an id or a status word", () => {
    expect(readerMeta(source({ status: "needs_attention" }, { typeShort: "笔记", kind: "note", origin: "note", pages: null, size: null }, earlier))).toBe("笔记 · 笔记 · 2020-10-03");
  });
});

describe("what 「在对话中使用」 leaves in the composer", () => {
  it("names the document by its title and its file, and never by an id or a path", () => {
    const draft = conversationDraft(source({ paths: ["knowledge-base/共识.pdf"] }));
    expect(draft).toContain("资料：幽门螺杆菌感染处理第六次全国共识报告（共识.pdf）");
    expect(draft.endsWith("我的问题：")).toBe(true);
    expect(draft).not.toMatch(/src_|knowledge-base|\.evimed/);
    expect(conversationDraft(source({ paths: ["knowledge-base/notes/10月3日组会.md"] }, { title: "10月3日组会.md" }))).toContain("资料：10月3日组会.md\n");
  });
});

describe("where a document's original is", () => {
  it("is its own file, the text read from it for a cloud-drive document, and a note's editor for a note", () => {
    expect(originalPathOf(source())).toBe("knowledge-base/共识.pdf");
    expect(originalPathOf(source({ outputs: { artifactPath: "knowledge-base/.evimed-derived/src_one/index.md" } }, { origin: "drive" }))).toBe("knowledge-base/.evimed-derived/src_one/index.md");
    expect(originalPathOf(source({ paths: [], outputs: {} }, { origin: "drive" }))).toBeNull();
    expect(isEditableNote(source({}, { kind: "note", origin: "note" }))).toBe(true);
    expect(isEditableNote(source({}, { kind: "note", origin: "upload" }))).toBe(false);
    expect(isEditableNote(source())).toBe(false);
  });
});

describe("a document's state", () => {
  it("is said only while it cannot be used, or when it could not be read", () => {
    expect(stateLabel(source())).toBe("");
    expect(stateLabel(source({ status: "queued" }))).toBe("正在读取");
    expect(stateLabel(source({ status: "parsing" }))).toBe("正在读取");
    expect(stateLabel(source({ status: "failed" }))).toBe("没能读取");
    expect(stateLabel(source({ status: "needs_attention" }))).toBe("部分无法读取");
    expect(stateLabel(source({ status: "missing" }))).toBe("原件已移除");
    expect(stateLabel(source({ status: "canceled" }))).toBe("已取消");
  });

  it("is not reading once the text is read, whatever the understanding still does", () => {
    expect(isReading(source({ status: "parsing" }, {}, { readable: true }))).toBe(false);
    expect(isUsable(source({ status: "parsing" }, {}, { readable: true }))).toBe(true);
    expect(stateLabel(source({ status: "parsing" }, {}, { readable: true }))).toBe("");
    expect(isReading(source({ status: "parsing" }, {}, { readable: false }))).toBe(true);
    // A record from before the field existed answers by its status.
    expect(isUsable(source({ status: "complete" }))).toBe(true);
    expect(isUsable(source({ status: "queued" }))).toBe(false);
  });
});

describe("a file's name and icon", () => {
  it("are the file's own name, and the chip's icon", () => {
    expect(fileNameOf(source({ paths: ["knowledge-base/links/nmpa.gov.cn-notice-1a2b3c4d.md"] }))).toBe("nmpa.gov.cn-notice-1a2b3c4d.md");
    expect(fileNameOf(source({ paths: [] }))).toBe("src_one");
    for (const kind of ["literature", "table", "document", "page", "note", "image", "something-else"]) expect(kindIcon(kind)).toBeTruthy();
  });
});
