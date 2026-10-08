import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useRoutes } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { knownErrorCodeMessage } from "@evimed/domain";
import { WebApiError } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import type { SourceDisplay, SourceRecord } from "@/lib/sourceClient";
import type { SourceMaterialsLedger } from "@/lib/sourceMaterials";
import { TWO_COLUMN_MIN_WIDTH } from "@/components/sources/useReaderBox";
import { SourceReaderPage } from "./SourceReaderPage";

const mocks = vi.hoisted(() => ({
  getSource: vi.fn(), getSourceUnderstanding: vi.fn(), getSourceMaterials: vi.fn(), getSourceFamily: vi.fn(),
  retrySource: vi.fn(), removeSource: vi.fn(), refetchSource: vi.fn(), getSourceNote: vi.fn(), saveSourceNote: vi.fn(),
  listDuplicateCandidates: vi.fn(), decideDuplicateGroup: vi.fn(), addToLibrary: vi.fn(), removeFromLibrary: vi.fn(),
  downloadArtifact: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn(),
}));
const context = vi.hoisted(() => ({ projectId: "default" }));
/** The width the page's own box reports, and the observers told when it changes: jsdom lays nothing out. */
const layout = vi.hoisted(() => ({ width: 1200, observers: new Set<() => void>() }));

vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()), ...Object.fromEntries(
  ["getSource", "getSourceUnderstanding", "getSourceMaterials", "getSourceFamily", "retrySource", "removeSource", "refetchSource", "getSourceNote", "saveSourceNote",
    "listDuplicateCandidates", "decideDuplicateGroup", "addToLibrary", "removeFromLibrary"].map((name) => [name, (mocks as Record<string, unknown>)[name]])) }));
vi.mock("@/lib/artifactFile", async (importOriginal) => ({ ...(await importOriginal<object>()), downloadArtifact: mocks.downloadArtifact }));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<object>()), hasWebApi: true, getWebProjectId: () => context.projectId }));
// The preview is the file viewer's own business: the page has to give it the right file, in the right project, on the right page.
vi.mock("@/components/inspector/FilePreviewInspector", () => ({
  FilePreviewInspector: ({ data, embedded, page }: { data: { path: string; projectId?: string; root?: string }; embedded?: boolean; page?: number }) => (
    <div data-testid="preview" data-embedded={String(Boolean(embedded))}>预览：{data.path}（{data.root}，项目 {data.projectId}{page ? `，第 ${page} 页` : ""}）</div>
  ),
}));
// What a dataset was understood to mean has its own panel and its own tests.
vi.mock("@/components/sources/DatasetMeaningPanel", () => ({
  DatasetMeaningPanel: ({ projectId, path, sha256 }: { projectId: string; path: string; sha256?: string | null }) => <p>数据含义面板：{projectId}·{path}·{sha256}</p>,
}));

const arrived = "2020-03-05T08:00:00";

const display = (overrides: Partial<SourceDisplay> = {}): SourceDisplay => ({
  title: "幽门螺杆菌感染处理第六次全国共识报告", gist: "给出一线四联方案、疗程 14 天与根除后复查的推荐。", docType: "review-guideline", typeLabel: "综述或指南", typeShort: "指南",
  kind: "literature", origin: "upload", format: "pdf", pages: 18, size: 2_200_000, site: null, url: null, shared: false, ...overrides,
});
function makeSource(id: string, shown: Partial<SourceDisplay> = {}, payload: Record<string, unknown> = {}, extra: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id, projectId: "default", revision: 3, createdAt: arrived, updatedAt: arrived, deletedAt: null, readable: true,
    display: display(shown),
    payload: { paths: [`knowledge-base/${id}.pdf`], status: "complete", docType: "review-guideline", depth: "structured", version: 1, generation: 1,
      reasons: [], valueVector: {}, coverage: null, outputs: { summary: "给出一线四联方案。" }, fingerprint: { size: 2_200_000 },
      currentUnderstandingId: "understanding:x:g1", ...payload },
    ...extra,
  } as SourceRecord;
}
const guideline = makeSource("src_guideline");
const sheet = makeSource("src_sheet", { title: "疳证纳入研究提取表.xlsx", gist: "75 项研究的基线、干预、对照和总有效率。", docType: "dataset", typeShort: "数据表", kind: "table", origin: "conversation", format: "xlsx", pages: null, size: 48_000, shared: true },
  { paths: ["knowledge-base/chat/疳证纳入研究提取表-1a2b3c4d.xlsx"], fingerprint: { size: 48_000, sha256: "a".repeat(64) } });
const policy = makeSource("src_policy", { title: "2026 医院药事管理制度汇编.docx", gist: null, docType: "policy-document", typeShort: "制度文件", kind: "document", origin: "drive", format: "docx", pages: 42 },
  { paths: ["openlist/制度/2026 医院药事管理制度汇编.docx"], outputs: { summary: "", artifactPath: "knowledge-base/.evimed-derived/src_policy/read-1-job-aaa/index.md" }, connector: { type: "openlist", id: "/制度/2026 医院药事管理制度汇编.docx" } });
const webPage = makeSource("src_page", { title: "国家药监局关于修订阿莫西林制剂说明书的公告", gist: "增加严重皮肤不良反应警示。", docType: "webpage", typeShort: "网页", kind: "page", origin: "link", format: "md", pages: null, size: 9_000, site: "nmpa.gov.cn", url: "https://www.nmpa.gov.cn/notice" },
  { paths: ["knowledge-base/links/nmpa.gov.cn-notice-1a2b3c4d.md"], link: { url: "https://www.nmpa.gov.cn/notice", finalUrl: "https://www.nmpa.gov.cn/notice", site: "nmpa.gov.cn", fetchedAt: "2020-10-05T08:00:00Z", rendered: false, original: null } });
const note = makeSource("src_note", { title: "10月3日组会记录", gist: "确定 C1–C3 三类比较分开合并。", docType: "note-memo", typeShort: "笔记", kind: "note", origin: "note", format: "md", pages: null, size: 300 },
  { paths: ["knowledge-base/notes/10月3日组会记录-1a2b3c.md"] });
const picture = makeSource("src_image", { title: "流程图.png", gist: null, docType: "image", typeShort: "图片", kind: "image", format: "png", pages: null, size: 80_000 },
  { paths: ["knowledge-base/流程图.png"], currentUnderstandingId: null, outputs: {} });
const broken = makeSource("src_broken", { title: "8.11 医学测评.pdf", gist: null, docType: "document", typeShort: "文档", kind: "document", pages: null, size: 2_200_000 },
  { status: "failed", error: { code: "source_parser_timeout", message: "Source analysis failed." }, currentUnderstandingId: null, outputs: {} }, { readable: false });
const reading = makeSource("src_reading", { title: "AAP 2026 儿童尿路感染诊断与管理指南.pdf", gist: null, pages: null, origin: "frontier" },
  { status: "parsing", currentUnderstandingId: null, outputs: {} }, { readable: false });
const removed = makeSource("src_removed", { title: "已移除的原件.pdf" }, { status: "missing" }, { readable: false });

const understanding = (extra: Record<string, unknown> = {}, sourceId = "src_guideline") => ({
  sourceId, generation: 1, depth: "structured", status: "complete",
  pageMap: [{ page: 1, start: 0, end: 100 }, { page: 5, start: 100, end: 200 }, { page: 6, start: 200, end: 300 }],
  current: {
    id: "understanding:x:g1", sourceId, generation: 1, docType: "review-guideline", depth: "structured", schemaVersion: 1, createdAt: arrived, run: null, usage: null,
    summary: "针对我国幽门螺杆菌高耐药背景，推荐含铋剂四联 14 天作为一线经验方案。强调根除后 4 周以上复查。需要时按药敏调整。",
    slots: { purpose: { state: "known", value: "给出处理建议", evidence: [] }, limitations: { state: "unknown", reason: "原文未涉及" }, design: { state: "unknown", reason: "原文未涉及" } },
    claims: [
      { id: "c1", statement: "一线经验治疗推荐铋剂四联方案，疗程 14 天", evidence: [{ sourceId, generation: 1, unitId: "u1", start: 120, end: 150, quote: "铋剂四联" }] },
      { id: "c2", statement: "不推荐三联方案作为一线经验治疗", evidence: [{ sourceId, generation: 1, unitId: "u1", start: 250, end: 260, quote: "三联" }] },
      ...Array.from({ length: 9 }, (_, index) => ({ id: `x${index}`, statement: `第 ${index + 3} 条要点`, evidence: [] })),
    ],
    methods: [], omissionAudit: { status: "not_run", omissionRate: null }, units: [],
  },
  ...extra,
});

const ledger = (overrides: Partial<SourceMaterialsLedger> = {}): SourceMaterialsLedger => ({
  version: 1, status: "extracted", format: "pdf", pagination: "paginated", origin: "reported", extraction: { materials: "m@1" },
  sourceSha256: null, textSha256: null, pages: { status: "mapped", pageCount: 38, textLayerPages: 38 },
  tables: { total: 0, structured: 0, unextracted: 0, failed: 0, continued: 0, continuedAmbiguous: 0 },
  values: { total: 0, located: 0, ambiguous: 0, unlocated: 0, unextracted: 0, failed: 0 },
  figures: { total: 0, captioned: 0, valuesKnown: 0 }, footnotes: { linked: 0, orphanMarkers: 0, orphanNotes: 0 },
  supplements: { referenced: 0, linked: 0 }, reasons: [], ...overrides,
});
const withCoverage = (source: SourceRecord, coverage: Record<string, unknown>): SourceRecord => ({
  ...source, payload: { ...source.payload, coverage: { total: 10, accounted: 10, extracted: 10, indexedOnly: 0, noContent: 0, failed: 0, percent: 100, omissionRate: null, ...coverage } },
}) as SourceRecord;

/** The probe the tests read the navigation off: where the page went and what it carried. */
function Probe() {
  const location = useLocation();
  return <p data-testid="location" data-search={location.search} data-state={JSON.stringify(location.state ?? null)}>{location.pathname}</p>;
}
function Table() {
  return useRoutes([
    { path: "/app/files", element: <><p>知识库列表</p><Probe /></> },
    { path: "/app/files/:sourceId", element: <><SourceReaderPage /><Probe /></> },
    { path: "/app/chat", element: <Probe /> },
  ]);
}
const readerAt = (id = "src_guideline", search = "") => `/app/files/${id}${search}`;
function renderReader(entry = readerAt()) {
  return render(<MemoryRouter initialEntries={[entry]}><Table /></MemoryRouter>);
}
const addressOf = () => { const where = screen.getByTestId("location"); return `${where.textContent}${where.getAttribute("data-search")}`; };
const selectSpy = vi.fn(async (_projectId: string, land?: () => void) => { land?.(); });

/** The page's box is `width` wide: what a resize observer would have told it. */
function resize(width: number) {
  layout.width = width;
  act(() => { for (const observer of layout.observers) observer(); });
}
const columnOf = (name: "original" | "points") => document.querySelector<HTMLElement>(`[data-reader-column="${name}"]`);

describe("a document's page", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", class {
      readonly callback: () => void;
      constructor(callback: () => void) { this.callback = callback; layout.observers.add(callback); }
      observe() {}
      unobserve() {}
      disconnect() { layout.observers.delete(this.callback); }
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return layout.width; } });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  });
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    selectSpy.mockClear();
    layout.width = 1200;
    layout.observers.clear();
    context.projectId = "default";
    useProjectStore.setState({
      currentId: "default", select: selectSpy as never,
      projects: [{ id: "default", name: "我的研究" }, { id: "paper-1", name: "疳证 Meta 文献检索" }],
    });
    mocks.getSource.mockImplementation(async (id: string) => ({ src_guideline: guideline, src_sheet: sheet, src_policy: policy, src_page: webPage, src_note: note, src_image: picture, src_broken: broken, src_reading: reading, src_removed: removed }[id]
      ?? (() => { throw new WebApiError("not found", { status: 404, code: "source_not_found" }); })()));
    mocks.getSourceUnderstanding.mockResolvedValue(understanding());
    mocks.getSourceMaterials.mockResolvedValue({ sourceId: "src_guideline", generation: 1, materials: null, reason: "not_extracted" });
    mocks.getSourceFamily.mockResolvedValue({ sourceId: "src_guideline", familyId: null, currentVersion: 1, items: [], nextCursor: null });
    mocks.listDuplicateCandidates.mockResolvedValue({ items: [], scanned: 0, truncated: false });
    mocks.retrySource.mockResolvedValue(guideline);
    mocks.removeSource.mockResolvedValue(guideline);
    mocks.refetchSource.mockResolvedValue({ source: webPage, duplicate: true, changed: false });
    mocks.addToLibrary.mockResolvedValue({});
    mocks.removeFromLibrary.mockResolvedValue({ sourceId: "src_guideline", removed: true });
    mocks.getSourceNote.mockResolvedValue({ title: "10月3日组会记录", body: "确定 C1–C3 三类比较分开合并。" });
    mocks.saveSourceNote.mockResolvedValue({ source: { ...note, id: "src_note_2" }, duplicate: false, changed: true });
    mocks.downloadArtifact.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  describe("its header", () => {
    it("is one line: the way back, the title with what the document is, and the three things to do with it", async () => {
      renderReader();
      const heading = await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      expect(heading.closest("header")?.querySelectorAll("p")).toHaveLength(0);
      expect(screen.getByRole("navigation", { name: "返回" })).toHaveTextContent("知识库");
      expect(within(heading.closest("header")!).getByText("指南 · 2.1 MB · 18 页 · 上传 · 2020-03-05")).toBeInTheDocument();
      const header = heading.closest("header")!;
      expect(within(header).getByRole("button", { name: "在对话中使用" })).toBeEnabled();
      expect(within(header).getByRole("button", { name: "下载" })).toBeEnabled();
      expect(within(header).getByRole("button", { name: `“${guideline.display.title}”的操作` })).toBeInTheDocument();
    });

    it("goes back to the list it was opened from, with its scope, type and search", async () => {
      renderReader(readerAt("src_guideline", "?scope=paper-1&kind=literature&q=%E5%85%B1%E8%AF%86&tab=content&page=5"));
      const back = await screen.findByRole("link", { name: "知识库" });
      expect(back).toHaveAttribute("href", "/app/files?scope=paper-1&kind=literature&q=%E5%85%B1%E8%AF%86");
      await userEvent.click(back);
      expect(addressOf()).toBe("/app/files?scope=paper-1&kind=literature&q=%E5%85%B1%E8%AF%86");
      // The list is told to put itself back as it was left.
      expect(JSON.parse(screen.getByTestId("location").getAttribute("data-state")!)).toMatchObject({ kbRestore: true });
    });

    it("has the row's four actions in its own 「⋯」, from the same menu", async () => {
      renderReader();
      await userEvent.click(await screen.findByRole("button", { name: `“${guideline.display.title}”的操作` }));
      expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["重新读取", "设为所有项目可用", "删除"]);
    });

    it("offers to take a shared document back to this project, and to settle a suspected duplicate when it is in one", async () => {
      mocks.getSource.mockResolvedValue({ ...guideline, display: { ...guideline.display, shared: true } });
      mocks.listDuplicateCandidates.mockResolvedValue({ items: [{ kind: "version-family", groupKey: "g1", label: "同一份资料的两个版本", members: [], sourceIds: ["src_guideline", "src_other"], decision: null }], scanned: 2, truncated: false });
      renderReader();
      await userEvent.click(await screen.findByRole("button", { name: `“${guideline.display.title}”的操作` }));
      await waitFor(() => expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["重新读取", "改为仅本项目", "处理疑似重复", "删除"]));
      expect(within(document.querySelector("header")!).getByText(/所有项目可用/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("menuitem", { name: "处理疑似重复" }));
      expect(await screen.findByRole("dialog", { name: "疑似重复" })).toBeInTheDocument();
    });

    it("shares a document with every project, and takes it back, then reads the document again", async () => {
      renderReader();
      await userEvent.click(await screen.findByRole("button", { name: `“${guideline.display.title}”的操作` }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "设为所有项目可用" }));
      await waitFor(() => expect(mocks.addToLibrary).toHaveBeenCalledWith("src_guideline"));
      await waitFor(() => expect(mocks.getSource).toHaveBeenCalledTimes(2));
    });

    it("reads again from the copy the platform holds, and a saved page from its address, saying whether it changed", async () => {
      renderReader();
      await userEvent.click(await screen.findByRole("button", { name: `“${guideline.display.title}”的操作` }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "重新读取" }));
      await waitFor(() => expect(mocks.retrySource).toHaveBeenCalledWith("src_guideline", 3));
    });

    it("reads a saved page from its address", async () => {
      renderReader(readerAt("src_page"));
      await userEvent.click(await screen.findByRole("button", { name: `“${webPage.display.title}”的操作` }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "重新读取" }));
      await waitFor(() => expect(mocks.refetchSource).toHaveBeenCalledWith("src_page"));
      expect(mocks.toastSuccess).toHaveBeenCalledWith("页面没有变化");
    });

    it("deletes after a confirmation, and returns to the list as it was", async () => {
      renderReader(readerAt("src_guideline", "?scope=paper-1"));
      await userEvent.click(await screen.findByRole("button", { name: `“${guideline.display.title}”的操作` }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
      const confirm = await screen.findByRole("alertdialog");
      expect(confirm).toHaveTextContent("删除这份资料？");
      await userEvent.click(within(confirm).getByRole("button", { name: "删除" }));
      await waitFor(() => expect(mocks.removeSource).toHaveBeenCalledWith("src_guideline", 3));
      await waitFor(() => expect(addressOf()).toBe("/app/files?scope=paper-1"));
    });

    it("downloads the original from its own project", async () => {
      mocks.getSource.mockResolvedValue({ ...guideline, projectId: "paper-1" });
      renderReader();
      await userEvent.click(await screen.findByRole("button", { name: "下载" }));
      expect(mocks.downloadArtifact).toHaveBeenCalledWith("knowledge-base/src_guideline.pdf", "base", "src_guideline.pdf", "paper-1");
    });
  });

  describe("「在对话中使用」", () => {
    it("puts a request to use the document in the composer, unsent, in the document's own project — naming it by title and file, never by id or path", async () => {
      mocks.getSource.mockResolvedValue({ ...guideline, projectId: "paper-1" });
      renderReader();
      await userEvent.click(await screen.findByRole("button", { name: "在对话中使用" }));
      await waitFor(() => expect(selectSpy).toHaveBeenCalledWith("paper-1", expect.any(Function)));
      const where = await screen.findByText("/app/chat");
      const intent = JSON.parse(where.getAttribute("data-state")!).runtimeUiIntent;
      expect(intent.kind).toBe("create");
      expect(intent.draft).toContain("请阅读知识库里的这份资料");
      expect(intent.draft).toContain(`资料：${guideline.display.title}（src_guideline.pdf）`);
      expect(intent.draft.endsWith("我的问题：")).toBe(true);
      expect(intent.draft).not.toMatch(/src_guideline(?!\.pdf)|knowledge-base|\.evimed-derived|workspace/);
    });

    it("uses a document opened from the shared scope in the project the tab is in", async () => {
      mocks.getSource.mockResolvedValue({ ...sheet, projectId: "paper-1" });
      renderReader(readerAt("src_sheet", "?scope=shared"));
      await userEvent.click(await screen.findByRole("button", { name: "在对话中使用" }));
      await waitFor(() => expect(selectSpy).toHaveBeenCalledWith("default", expect.any(Function)));
    });

    it("is not offered while the document is still being read", async () => {
      mocks.getSourceUnderstanding.mockResolvedValue({ ...understanding({}, "src_reading"), current: null, status: "parsing" });
      renderReader(readerAt("src_reading"));
      expect(await screen.findByRole("button", { name: "在对话中使用" })).toBeDisabled();
      expect(await screen.findByText("正在读取")).toBeInTheDocument();
    });
  });

  describe("two columns or two tabs, by the page's own width", () => {
    it("puts the original on the left and the key points on the right where the original can be 560 px wide", async () => {
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      expect(document.querySelector("[data-reader-layout]")).toHaveAttribute("data-reader-layout", "columns");
      expect(screen.queryByRole("tablist", { name: "资料视图" })).not.toBeInTheDocument();
      const original = columnOf("original")!;
      const points = columnOf("points")!;
      expect(original.compareDocumentPosition(points) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(await within(original).findByTestId("preview")).toHaveTextContent("预览：knowledge-base/src_guideline.pdf（base，项目 default）");
      expect(await within(points).findByText("给出一线四联方案、疗程 14 天与根除后复查的推荐。")).toBeInTheDocument();
      expect(points.style.width).toBe("360px");
    });

    it("goes to the two tabs 「内容」 and 「原文」 one pixel short of that, and back again", async () => {
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(TWO_COLUMN_MIN_WIDTH - 1);
      expect(document.querySelector("[data-reader-layout]")).toHaveAttribute("data-reader-layout", "tabs");
      const tabs = screen.getByRole("tablist", { name: "资料视图" });
      expect(within(tabs).getByRole("tab", { name: "内容", selected: true })).toBeInTheDocument();
      expect(within(tabs).getByRole("tab", { name: "原文", selected: false })).toBeInTheDocument();
      expect(screen.queryByTestId("preview")).not.toBeInTheDocument();
      resize(TWO_COLUMN_MIN_WIDTH);
      expect(document.querySelector("[data-reader-layout]")).toHaveAttribute("data-reader-layout", "columns");
    });

    it("decides by the page's width and not the window's: a wide window whose sidebar leaves a narrow page is tabs", async () => {
      const window1600 = vi.spyOn(window, "innerWidth", "get").mockReturnValue(1600);
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(700);
      expect(document.querySelector("[data-reader-layout]")).toHaveAttribute("data-reader-layout", "tabs");
      window1600.mockRestore();
    });

    it("keeps the tab and the page in the address, and opens the original at the page a key point rests on", async () => {
      renderReader();
      resize(700);
      await userEvent.click(await screen.findByRole("button", { name: "第 5 页" }));
      expect(addressOf()).toBe("/app/files/src_guideline?tab=original&page=5");
      expect(screen.getByRole("tab", { name: "原文", selected: true })).toBeInTheDocument();
      const preview = await screen.findByTestId("preview");
      expect(preview).toHaveTextContent("预览：knowledge-base/src_guideline.pdf（base，项目 default，第 5 页）");
      expect(preview).toHaveAttribute("data-embedded", "true");
      await userEvent.click(screen.getByRole("tab", { name: "内容" }));
      expect(addressOf()).toBe("/app/files/src_guideline?tab=content&page=5");
    });

    it("opens at the tab and the page the address names", async () => {
      resize(700);
      renderReader(readerAt("src_guideline", "?tab=original&page=6"));
      expect(await screen.findByRole("tab", { name: "原文", selected: true })).toBeInTheDocument();
      expect(await screen.findByTestId("preview")).toHaveTextContent("第 6 页");
    });

    it("turns the original to the page in the left column without leaving the key points, when both are on screen", async () => {
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(TWO_COLUMN_MIN_WIDTH + 200);
      await userEvent.click(await screen.findByRole("button", { name: "第 6 页" }));
      expect(addressOf()).toBe("/app/files/src_guideline?page=6");
      expect(await within(columnOf("original")!).findByTestId("preview")).toHaveTextContent("第 6 页");
      expect(within(columnOf("points")!).getByText(/一线经验治疗推荐铋剂四联方案/)).toBeInTheDocument();
    });

    it("ignores a tab or a page the address spells wrongly", async () => {
      resize(700);
      renderReader(readerAt("src_guideline", "?tab=elsewhere&page=-3"));
      expect(await screen.findByRole("tab", { name: "内容", selected: true })).toBeInTheDocument();
    });
  });

  describe("the key points", () => {
    const text = () => columnOf("points")!.textContent ?? "";
    const order = (...needles: string[]) => {
      const at = needles.map((needle) => text().indexOf(needle));
      expect(at.every((index) => index >= 0), `all of ${needles.join(" / ")} are there: ${at}`).toBe(true);
      expect([...at].sort((left, right) => left - right)).toEqual(at);
    };

    it("go in the order of the plan: the gist, what the study is, the key points, what was not read, the tables and figures, then the folds", async () => {
      const materials = ledger({ pages: { status: "mapped", pageCount: 38, textLayerPages: 34, noTextLayerPages: [31, 32, 33, 34] },
        tables: { total: 3, structured: 2, unextracted: 1, failed: 0, continued: 0, continuedAmbiguous: 0 }, figures: { total: 2, captioned: 2, valuesKnown: 0 } });
      mocks.getSource.mockResolvedValue({ ...withCoverage(guideline, { materials }), payload: { ...withCoverage(guideline, { materials }).payload, familyId: "fam_1", version: 2,
        metadata: { authors: ["王一", "李二", "张三", "赵四"], source: "中华消化杂志", publicationDate: "2022-03-15" } } });
      const withStudy = understanding();
      withStudy.current.slots = { ...withStudy.current.slots, design: { state: "known", value: "随机对照试验", evidence: [] }, doi: { state: "known", value: "10.1000/xyz", evidence: [] } } as never;
      mocks.getSourceUnderstanding.mockResolvedValue(withStudy);
      mocks.getSourceMaterials.mockResolvedValue({ sourceId: "src_guideline", generation: 1, materials: { coverage: materials, structure: {
        tables: [{ id: "tbl-1", index: 1, kind: "table", status: "structured", caption: { label: "表 3", text: "表 3 推荐等级汇总", placement: "before" }, page: { status: "located", pages: [9] } }],
        figures: [{ kind: "figure", index: 1, id: "fig-1", label: "图 1", caption: { text: "图 1 治疗流程" }, page: { status: "located", pages: [4] } }] } } });
      mocks.getSourceFamily.mockResolvedValue({ sourceId: "src_guideline", familyId: "fam_1", currentVersion: 2, nextCursor: null,
        items: [{ ...guideline, payload: { ...guideline.payload, version: 2 } }, { ...guideline, id: "src_guideline_v1", payload: { ...guideline.payload, version: 1 }, createdAt: "2019-12-01T08:00:00" }] });
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      await within(columnOf("points")!).findByText("表 3 推荐等级汇总");
      await within(columnOf("points")!).findByText(/以前的版本（1）/);
      order("讲了什么", "给出一线四联方案", "研究信息", "王一、李二、张三 等", "中华消化杂志 2022", "随机对照试验", "10.1000/xyz", "要点", "一线经验治疗推荐铋剂四联方案",
        "没有读全：第 31—34 页没有文字层，1 张表格没有读成数据，2 张图的内容没有读取。", "表格与图", "图 1 治疗流程", "表 3 推荐等级汇总", "完整摘要", "以前的版本（1）");
      // The pages come from the page map and from the materials, and each is a way to the original.
      expect(within(columnOf("points")!).getByRole("button", { name: "第 5 页" })).toBeInTheDocument();
      expect(within(columnOf("points")!).getByRole("button", { name: "第 9 页" })).toBeInTheDocument();
      expect(within(columnOf("points")!).getByRole("button", { name: "第 4 页" })).toBeInTheDocument();
      // The long summary and the earlier versions are folded, and an earlier version is a page of its own.
      expect(within(columnOf("points")!).getByText("完整摘要").closest("details")).not.toHaveAttribute("open");
      expect(within(columnOf("points")!).getByRole("link", { name: "第 1 版 · 2019-12-01" })).toHaveAttribute("href", "/app/files/src_guideline_v1");
    });

    it("show only what the reading has: no row for a study slot it left unknown, and not more than eight points", async () => {
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      const points = await within(columnOf("points")!).findByRole("list");
      expect(within(points).getAllByRole("listitem")).toHaveLength(8);
      expect(text()).not.toMatch(/研究信息|研究设计|尚不明确|原文未涉及|给出处理建议/);
      // There is nothing in the reading to put under these, and no record of who used the document: they are not on the page.
      expect(text()).not.toMatch(/包含什么|局限|用过它的对话|遗漏|抽查|查看历史|方法草稿/);
    });

    it("say the gist as the row does, and fold the whole summary only when there is more than the gist", async () => {
      const oneSentence = understanding();
      oneSentence.current.summary = "给出一线四联方案、疗程 14 天与根除后复查的推荐。";
      mocks.getSourceUnderstanding.mockResolvedValue(oneSentence);
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      await within(columnOf("points")!).findByText("给出一线四联方案、疗程 14 天与根除后复查的推荐。");
      expect(text()).not.toContain("完整摘要");
    });

    it("name a page in plain words where there is no page to open on", async () => {
      mocks.getSource.mockResolvedValue(policy);
      mocks.getSourceUnderstanding.mockResolvedValue({ ...understanding({}, "src_policy"), current: { ...understanding().current, sourceId: "src_policy" } });
      renderReader(readerAt("src_policy"));
      await screen.findByRole("heading", { level: 1, name: policy.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      await within(columnOf("points")!).findByText(/一线经验治疗推荐铋剂四联方案/);
      expect(within(columnOf("points")!).queryByRole("button", { name: /第 \d+ 页/ })).not.toBeInTheDocument();
      expect(within(columnOf("points")!).getAllByText("第 5 页").length).toBeGreaterThan(0);
    });

    it("keep the list of tables and figures to the first six, and give the rest on request", async () => {
      const crowded = withCoverage(guideline, { materials: ledger({ tables: { total: 8, structured: 8, unextracted: 0, failed: 0, continued: 0, continuedAmbiguous: 0 } }) });
      mocks.getSource.mockResolvedValue(crowded);
      mocks.getSourceMaterials.mockResolvedValue({ sourceId: "src_guideline", generation: 1, materials: { coverage: ledger(), structure: { figures: [],
        tables: Array.from({ length: 8 }, (_, index) => ({ id: `tbl-${index + 1}`, index: index + 1, kind: "table", status: "structured", caption: { label: `表 ${index + 1}`, text: `表 ${index + 1} 的标题` }, page: { status: "located", pages: [index + 1] } })) } } });
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      await within(columnOf("points")!).findByText("表 6 的标题");
      expect(within(columnOf("points")!).queryByText("表 7 的标题")).not.toBeInTheDocument();
      await userEvent.click(within(columnOf("points")!).getByRole("button", { name: "显示全部 8 项" }));
      expect(within(columnOf("points")!).getByText("表 8 的标题")).toBeInTheDocument();
    });

    it("leave the tables and figures out when they cannot be read, and keep the rest", async () => {
      mocks.getSource.mockResolvedValue(withCoverage(guideline, { materials: ledger({ tables: { total: 2, structured: 2, unextracted: 0, failed: 0, continued: 0, continuedAmbiguous: 0 } }) }));
      mocks.getSourceMaterials.mockRejectedValue(new WebApiError("unavailable", { status: 503 }));
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      await within(columnOf("points")!).findByText("讲了什么");
      expect(text()).not.toContain("表格与图");
      expect(within(columnOf("points")!).queryByRole("alert")).not.toBeInTheDocument();
    });

    it("say the way to the newest version when this is an old one", async () => {
      mocks.getSource.mockResolvedValue({ ...guideline, id: "src_guideline", payload: { ...guideline.payload, familyId: "fam_1", version: 1 } });
      mocks.getSourceFamily.mockResolvedValue({ sourceId: "src_guideline", familyId: "fam_1", currentVersion: 2, nextCursor: null,
        items: [{ ...guideline, id: "src_guideline_v2", payload: { ...guideline.payload, version: 2 } }, { ...guideline, payload: { ...guideline.payload, version: 1 } }] });
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      expect(await within(columnOf("points")!).findByRole("link", { name: "打开最新版本" })).toHaveAttribute("href", "/app/files/src_guideline_v2");
      expect(text()).not.toContain("以前的版本");
    });
  });

  describe("what was not read", () => {
    const gapOf = async (source: SourceRecord) => {
      mocks.getSource.mockResolvedValue(source);
      renderReader();
      await screen.findByRole("heading", { level: 1, name: source.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      await within(columnOf("points")!).findByText("讲了什么");
      return document.querySelector("[data-reader-gap]")?.textContent ?? null;
    };

    it("is one sentence, naming the pages, the tables and the figures that were not read", async () => {
      expect(await gapOf(withCoverage(guideline, { failed: 3, materials: ledger({
        pages: { status: "mapped", pageCount: 38, textLayerPages: 30, noTextLayerPages: [31, 32, 33, 34, 40] },
        tables: { total: 4, structured: 2, unextracted: 1, failed: 1, continued: 0, continuedAmbiguous: 0 }, figures: { total: 6, captioned: 6, valuesKnown: 0 } }) })))
        .toBe("没有读全：3 段文字没能读取，第 31—34、40 页没有文字层，2 张表格没有读成数据，6 张图的内容没有读取。");
    });

    it("is not there when nothing was missed — and a file that exists is not said to be understood for it", async () => {
      expect(await gapOf(withCoverage(guideline, { materials: ledger({ tables: { total: 3, structured: 3, unextracted: 0, failed: 0, continued: 0, continuedAmbiguous: 0 } }) }))).toBeNull();
    });

    it("is not there for a document read before the extraction existed, which says nothing either way", async () => {
      expect(await gapOf(withCoverage(guideline, {}))).toBeNull();
    });

    it("says only the figures where those are all that was missed", async () => {
      expect(await gapOf(withCoverage(guideline, { materials: ledger({ figures: { total: 1, captioned: 1, valuesKnown: 0 } }) }))).toBe("没有读全：1 张图的内容没有读取。");
    });

    it("says a partly read document's missing parts under its key points", async () => {
      mocks.getSource.mockResolvedValue(withCoverage({ ...guideline, payload: { ...guideline.payload, status: "needs_attention" } } as SourceRecord, { failed: 2 }));
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      await within(columnOf("points")!).findByText("讲了什么");
      expect(document.querySelector("[data-reader-gap]")).toHaveTextContent("没有读全：2 段文字没能读取。");
    });
  });

  describe("the original, by what the document is", () => {
    const original = async (source: SourceRecord) => {
      mocks.getSource.mockResolvedValue(source);
      renderReader(readerAt(source.id));
      await screen.findByRole("heading", { level: 1, name: source.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      return columnOf("original")!;
    };

    it("is the file itself for a paper, a guideline or a document, in the project it belongs to", async () => {
      expect(await within(await original({ ...guideline, projectId: "paper-1" })).findByTestId("preview")).toHaveTextContent("预览：knowledge-base/src_guideline.pdf（base，项目 paper-1）");
    });

    it("is the text that was read for a document in the cloud drive, and says so", async () => {
      const column = await original(policy);
      expect(await within(column).findByTestId("preview")).toHaveTextContent("预览：knowledge-base/.evimed-derived/src_policy/read-1-job-aaa/index.md");
      expect(within(column).getByText("原件在网盘里，这里是从它读出的文本。")).toBeInTheDocument();
    });

    it("is the snapshot for a web page, with the day it was taken and the way to the page itself", async () => {
      const column = await original(webPage);
      expect(await within(column).findByTestId("preview")).toHaveTextContent("预览：knowledge-base/links/nmpa.gov.cn-notice-1a2b3c4d.md");
      expect(within(column).getByText("这是网页的快照，抓取于 2020-10-05")).toBeInTheDocument();
      const link = within(column).getByRole("link", { name: "打开原网页" });
      expect(link).toHaveAttribute("href", "https://www.nmpa.gov.cn/notice");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("is the editor for a note, and saving it follows the note to its next version", async () => {
      const column = await original(note);
      const body = await within(column).findByLabelText("正文");
      expect(body).toHaveValue("确定 C1–C3 三类比较分开合并。");
      expect(within(column).getByRole("button", { name: "保存" })).toBeDisabled();
      await userEvent.clear(body);
      await userEvent.type(body, "增加：敏感性分析另行报告。");
      await userEvent.click(within(column).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(mocks.saveSourceNote).toHaveBeenCalledWith("src_note", { title: "10月3日组会记录", body: "增加：敏感性分析另行报告。" }));
      expect(mocks.toastSuccess).toHaveBeenCalledWith("已保存，正在重新读取");
      await waitFor(() => expect(addressOf()).toBe("/app/files/src_note_2"));
    });

    it("opens on the editor where there are two tabs, because a note is the original", async () => {
      mocks.getSource.mockResolvedValue(note);
      resize(700);
      renderReader(readerAt("src_note"));
      expect(await screen.findByRole("tab", { name: "原文", selected: true })).toBeInTheDocument();
      expect(await screen.findByLabelText("正文")).toBeInTheDocument();
    });

    it("is a preview of the table beside the meaning of its columns, which take the key points' place", async () => {
      mocks.getSourceUnderstanding.mockResolvedValue({ ...understanding({}, "src_sheet"), current: { ...understanding().current, sourceId: "src_sheet", summary: "75 项研究的基线、干预、对照和总有效率，共 82 行 14 列。" } });
      const column = await original(sheet);
      expect(await within(column).findByTestId("preview")).toHaveTextContent("预览：knowledge-base/chat/疳证纳入研究提取表-1a2b3c4d.xlsx");
      const points = columnOf("points")!;
      expect(await within(points).findByText("数据含义面板：default·knowledge-base/chat/疳证纳入研究提取表-1a2b3c4d.xlsx·" + "a".repeat(64))).toBeInTheDocument();
      expect(within(points).getByText("75 项研究的基线、干预、对照和总有效率。")).toBeInTheDocument();
      expect(within(points).queryByText("要点")).not.toBeInTheDocument();
      expect(within(points).queryAllByRole("listitem")).toHaveLength(0);
    });

    it("lets the meaning of a table's columns be the main column where there is no room for two", async () => {
      mocks.getSource.mockResolvedValue(sheet);
      mocks.getSourceUnderstanding.mockResolvedValue({ ...understanding({}, "src_sheet"), current: { ...understanding().current, sourceId: "src_sheet" } });
      resize(700);
      renderReader(readerAt("src_sheet"));
      expect(await screen.findByRole("tab", { name: "内容", selected: true })).toBeInTheDocument();
      expect(await screen.findByText(/数据含义面板：/)).toBeInTheDocument();
    });

    it("is the picture for an image", async () => {
      expect(await within(await original(picture)).findByTestId("preview")).toHaveTextContent("预览：knowledge-base/流程图.png");
    });

    it("says the original was removed, and does not offer a download of it", async () => {
      const column = await original(removed);
      expect(within(column).getByText("原件已移除，这份资料的原文看不到了。")).toBeInTheDocument();
      expect(screen.queryByTestId("preview")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "下载" })).toBeDisabled();
    });

    it("says there is no original to show when the document has no path", async () => {
      const column = await original({ ...guideline, payload: { ...guideline.payload, paths: [] } } as SourceRecord);
      expect(within(column).getByText("这份资料的原文暂时看不到。")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "下载" })).toBeDisabled();
    });
  });

  describe("a document that could not be read, or is being read", () => {
    it("gives the reason in the registry's words and the one thing to do, and still shows and offers the original", async () => {
      mocks.getSourceUnderstanding.mockResolvedValue({ ...understanding({}, "src_broken"), current: null, status: "failed" });
      mocks.getSource.mockResolvedValue(broken);
      renderReader(readerAt("src_broken"));
      await screen.findByRole("heading", { level: 1, name: broken.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      expect(await within(columnOf("points")!).findByText(knownErrorCodeMessage("source_parser_timeout")!)).toBeInTheDocument();
      await userEvent.click(within(columnOf("points")!).getByRole("button", { name: "重新读取" }));
      await waitFor(() => expect(mocks.retrySource).toHaveBeenCalledWith("src_broken", 3));
      expect(await within(columnOf("original")!).findByTestId("preview")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "下载" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "在对话中使用" })).toBeDisabled();
    });

    it("says it is being read, and asks again until it is", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mocks.getSourceUnderstanding.mockResolvedValue({ ...understanding({}, "src_reading"), current: null, status: "parsing" });
      mocks.getSource.mockResolvedValue(reading);
      renderReader(readerAt("src_reading"));
      expect(await screen.findByText("正在读取")).toBeInTheDocument();
      mocks.getSource.mockResolvedValue({ ...reading, readable: true, payload: { ...reading.payload, status: "complete" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
      await waitFor(() => expect(screen.getByRole("button", { name: "在对话中使用" })).toBeEnabled());
      expect(mocks.getSource.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("says that nothing can be shown for a readable document the reading has nothing on", async () => {
      mocks.getSourceUnderstanding.mockResolvedValue({ ...understanding({}, "src_image"), current: null });
      mocks.getSource.mockResolvedValue(picture);
      renderReader(readerAt("src_image"));
      await screen.findByRole("heading", { level: 1, name: picture.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      expect(await within(columnOf("points")!).findByText("没有可以显示的内容。")).toBeInTheDocument();
    });

    it("says it could not load the key points, with a way to try again, and the original still shows", async () => {
      mocks.getSourceUnderstanding.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: "product_state_unavailable" }));
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      const alert = await within(columnOf("points")!).findByRole("alert");
      expect(alert).toHaveTextContent("无法加载内容");
      expect(within(columnOf("original")!).getByTestId("preview")).toBeInTheDocument();
      await userEvent.click(within(alert).getByRole("button", { name: "重试" }));
      expect(await within(columnOf("points")!).findByText("讲了什么")).toBeInTheDocument();
    });
  });

  describe("a document that is not there", () => {
    it("is one sentence and the way back, the same for a document that was deleted and one that was never this account's", async () => {
      renderReader(readerAt("src_gone", "?scope=paper-1"));
      expect(await screen.findByText("这份资料不存在或已删除。")).toBeInTheDocument();
      expect(screen.queryByTestId("preview")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "在对话中使用" })).not.toBeInTheDocument();
      const back = screen.getByRole("link", { name: "回到知识库" });
      expect(back).toHaveAttribute("href", "/app/files?scope=paper-1");
      // 404 is all the control plane says for both; the page adds nothing that tells them apart.
      cleanup();
      mocks.getSource.mockRejectedValue(new WebApiError("The source is unavailable.", { status: 404, code: "project_not_found" }));
      renderReader(readerAt("src_other_account"));
      expect(await screen.findByText("这份资料不存在或已删除。")).toBeInTheDocument();
    });

    it("says it could not open the document when that is what happened, with a way to try again", async () => {
      mocks.getSource.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: "product_state_unavailable" }));
      renderReader();
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("无法打开这份资料");
      expect(screen.queryByText("这份资料不存在或已删除。")).not.toBeInTheDocument();
      await userEvent.click(within(alert).getByRole("button", { name: "重试" }));
      expect(await screen.findByRole("heading", { level: 1, name: guideline.display.title })).toBeInTheDocument();
    });

    it("is loading before it is anything else, and says so without saying it is empty", async () => {
      mocks.getSource.mockReturnValue(new Promise(() => {}));
      renderReader();
      expect(await screen.findByRole("status", { name: "正在打开资料" })).toBeInTheDocument();
      expect(screen.queryByText("这份资料不存在或已删除。")).not.toBeInTheDocument();
    });
  });

  describe("another document's page", () => {
    it("is read afresh, never the previous document under the new address", async () => {
      mocks.getSourceFamily.mockResolvedValue({ sourceId: "src_guideline", familyId: "fam_1", currentVersion: 2, nextCursor: null,
        items: [{ ...guideline, payload: { ...guideline.payload, version: 2 } }, { ...guideline, id: "src_sheet", payload: { ...guideline.payload, version: 1 } }] });
      mocks.getSource.mockImplementation(async (id: string) => (id === "src_guideline" ? { ...guideline, payload: { ...guideline.payload, familyId: "fam_1", version: 2 } } : sheet));
      renderReader();
      await screen.findByRole("heading", { level: 1, name: guideline.display.title });
      resize(TWO_COLUMN_MIN_WIDTH);
      await userEvent.click(await within(columnOf("points")!).findByText(/以前的版本（1）/));
      await userEvent.click(await screen.findByRole("link", { name: /第 1 版/ }));
      expect(await screen.findByRole("heading", { level: 1, name: sheet.display.title })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { level: 1, name: guideline.display.title })).not.toBeInTheDocument();
    });
  });
});
