import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate, useNavigationType, useRoutes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knownErrorCodeMessage } from "@evimed/domain";
import { WebApiError } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import type { SourceCounts, SourceDisplay, SourceKind, SourceRecord } from "@/lib/sourceClient";
import { SourcesPage } from "./SourcesPage";

const mocks = vi.hoisted(() => ({
  listSources: vi.fn(), retrySource: vi.fn(), removeSource: vi.fn(), refetchSource: vi.fn(),
  addSourceLink: vi.fn(), addSourceNote: vi.fn(), getSourceNote: vi.fn(), saveSourceNote: vi.fn(),
  getSourceUnderstanding: vi.fn(),
  browseOpenList: vi.fn(), importOpenListSource: vi.fn(), listSourceFolders: vi.fn(), registerSourceFolder: vi.fn(), syncSourceFolder: vi.fn(), setSourceFolderStatus: vi.fn(),
  listDuplicateCandidates: vi.fn(), decideDuplicateGroup: vi.fn(), addToLibrary: vi.fn(), removeFromLibrary: vi.fn(),
  pickFiles: vi.fn(), uploadFilesToWorkspace: vi.fn(), downloadArtifact: vi.fn(),
  listGeoProjects: vi.fn(), getVcrHome: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(),
}));
const context = vi.hoisted(() => ({ projectId: "default", features: { openList: true, geo: true, vcr: true } as Record<string, unknown> | undefined }));

// Only the request functions are replaced. `sourceFailureMessage` is a pure projection over the one error dictionary,
// and a test that stubbed it would prove the page renders a string this file wrote rather than the registry's.
vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()), ...Object.fromEntries(
  ["listSources", "retrySource", "removeSource", "refetchSource", "addSourceLink", "addSourceNote", "getSourceNote", "saveSourceNote", "getSourceUnderstanding",
    "browseOpenList", "importOpenListSource", "listSourceFolders", "registerSourceFolder", "syncSourceFolder", "setSourceFolderStatus",
    "listDuplicateCandidates", "decideDuplicateGroup", "addToLibrary", "removeFromLibrary"].map((name) => [name, (mocks as Record<string, unknown>)[name]])) }));
vi.mock("@/lib/backend", () => ({ pickFiles: mocks.pickFiles, uploadFilesToWorkspace: mocks.uploadFilesToWorkspace }));
vi.mock("@/lib/artifactFile", async (importOriginal) => ({ ...(await importOriginal<object>()), downloadArtifact: mocks.downloadArtifact }));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({ ...(await importOriginal<object>()), listGeoProjects: mocks.listGeoProjects }));
vi.mock("@/lib/vcrClient", async (importOriginal) => ({ ...(await importOriginal<object>()), getVcrHome: mocks.getVcrHome }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<object>()),
  hasWebApi: true,
  getWebProjectId: () => context.projectId,
  fetchWebMe: async () => ({ user: { id: "u", name: "u" }, operator: false, project: { id: context.projectId, name: "p" }, projects: [],
    ...(context.features ? { features: context.features } : {}) }),
}));
// The preview is the file viewer's own business: the drawer has to give it the right file, in the right project, on the right page.
vi.mock("@/components/inspector/FilePreviewInspector", () => ({
  FilePreviewInspector: ({ data, embedded, page }: { data: { path: string; projectId?: string; root?: string }; embedded?: boolean; page?: number }) => (
    <div data-testid="preview" data-embedded={String(Boolean(embedded))}>预览：{data.path}（{data.root}，项目 {data.projectId}{page ? `，第 ${page} 页` : ""}）</div>
  ),
}));
// What a dataset was understood to mean has its own panel and its own tests; the drawer only has to put it where a table's key points would be.
vi.mock("@/components/sources/DatasetMeaningPanel", () => ({
  DatasetMeaningPanel: ({ projectId, path, sha256 }: { projectId: string; path: string; sha256?: string | null }) => <p>数据含义面板：{projectId}·{path}·{sha256}</p>,
}));

/** A day this year, so the row dates it without a year. */
const arrived = `${new Date().getFullYear()}-03-05T08:00:00`;

const display = (overrides: Partial<SourceDisplay> = {}): SourceDisplay => ({
  title: "幽门螺杆菌感染处理第六次全国共识报告", gist: "给出一线四联方案、疗程 14 天与根除后复查的推荐。", docType: "review-guideline", typeLabel: "综述或指南", typeShort: "指南",
  kind: "literature", origin: "upload", format: "pdf", pages: 18, size: 2_200_000, site: null, url: null, shared: false, ...overrides,
});
function makeSource(id: string, shown: Partial<SourceDisplay> = {}, payload: Record<string, unknown> = {}, extra: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id, projectId: "default", revision: 3, createdAt: arrived, updatedAt: arrived, deletedAt: null, readable: true,
    display: display(shown),
    payload: { paths: [`knowledge-base/${id}.pdf`], status: "complete", docType: "review-guideline", depth: "structured", version: 1, generation: 1,
      reasons: ["The document format is parsed into traceable units."], valueVector: {}, coverage: null, outputs: { summary: "给出一线四联方案。" }, fingerprint: { size: 2_200_000 },
      currentUnderstandingId: "understanding:x:g1", ...payload },
    ...extra,
  } as SourceRecord;
}
const guideline = makeSource("src_guideline");
const sheet = makeSource("src_sheet", { title: "疳证纳入研究提取表.xlsx", gist: "75 项研究的基线、干预、对照和总有效率。", docType: "dataset", typeShort: "数据表", kind: "table", origin: "conversation", format: "xlsx", pages: null, size: 48_000, shared: true },
  { paths: ["knowledge-base/chat/疳证纳入研究提取表-1a2b3c4d.xlsx"], fingerprint: { size: 48_000, sha256: "a".repeat(64) } });
const policy = makeSource("src_policy", { title: "2026 医院药事管理制度汇编.docx", gist: null, docType: "policy-document", typeShort: "制度文件", kind: "document", origin: "drive", format: "docx", pages: 42 },
  { paths: ["openlist/制度/2026 医院药事管理制度汇编.docx"], outputs: { summary: "", artifactPath: "knowledge-base/.evimed-derived/src_policy/read-1-job-aaa/index.md" }, connector: { type: "openlist", id: "/制度/2026 医院药事管理制度汇编.docx" } });
const page = makeSource("src_page", { title: "国家药监局关于修订阿莫西林制剂说明书的公告", gist: "增加严重皮肤不良反应警示。", docType: "webpage", typeShort: "网页", kind: "page", origin: "link", format: "md", pages: null, size: 9_000, site: "nmpa.gov.cn", url: "https://www.nmpa.gov.cn/notice" },
  { paths: ["knowledge-base/links/nmpa.gov.cn-notice-1a2b3c4d.md"], link: { url: "https://www.nmpa.gov.cn/notice", finalUrl: "https://www.nmpa.gov.cn/notice", site: "nmpa.gov.cn", fetchedAt: "2026-10-05T08:00:00Z", rendered: false, original: null } });
const note = makeSource("src_note", { title: "10月3日组会记录", gist: "确定 C1–C3 三类比较分开合并。", docType: "note-memo", typeShort: "笔记", kind: "note", origin: "note", format: "md", pages: null, size: 300 },
  { paths: ["knowledge-base/notes/10月3日组会记录-1a2b3c.md"] });
const broken = makeSource("src_broken", { title: "8.11 医学测评.pdf", gist: null, docType: "document", typeShort: "文档", kind: "document", pages: null, size: 2_200_000 },
  { status: "failed", error: { code: "source_parser_timeout", message: "Source analysis failed." }, currentUnderstandingId: null, outputs: {} }, { readable: false });
const reading = makeSource("src_reading", { title: "AAP 2026 儿童尿路感染诊断与管理指南.pdf", gist: null, pages: null, origin: "frontier" },
  { status: "parsing", currentUnderstandingId: null, outputs: {} }, { readable: false });

const counts = (overrides: Partial<SourceCounts> = {}): SourceCounts => ({ all: 0, literature: 0, table: 0, document: 0, page: 0, note: 0, image: 0, ...overrides });
const listing = (items: SourceRecord[], extra: { nextCursor?: string | null; counts?: Partial<SourceCounts> } = {}) => {
  const tally = counts();
  for (const item of items) { tally[item.display.kind as SourceKind] += 1; tally.all += 1; }
  return { items, nextCursor: extra.nextCursor ?? null, counts: { ...tally, ...extra.counts } };
};

const understanding = (extra: Record<string, unknown> = {}) => ({
  sourceId: "src_guideline", generation: 1, depth: "structured", status: "complete",
  pageMap: [{ page: 1, start: 0, end: 100 }, { page: 5, start: 100, end: 200 }, { page: 6, start: 200, end: 300 }],
  current: {
    id: "understanding:x:g1", sourceId: "src_guideline", generation: 1, docType: "review-guideline", depth: "structured", schemaVersion: 1, createdAt: arrived, run: null, usage: null,
    summary: "针对我国幽门螺杆菌高耐药背景，推荐含铋剂四联 14 天作为一线经验方案，强调根除后 4 周以上复查。",
    slots: { purpose: { state: "known", value: "给出处理建议", evidence: [] }, limitations: { state: "unknown", reason: "原文未涉及" }, design: { state: "unknown", reason: "原文未涉及" } },
    claims: [
      { id: "c1", statement: "一线经验治疗推荐铋剂四联方案，疗程 14 天", evidence: [{ sourceId: "src_guideline", generation: 1, unitId: "u1", start: 120, end: 150, quote: "铋剂四联" }] },
      { id: "c2", statement: "不推荐三联方案作为一线经验治疗", evidence: [{ sourceId: "src_guideline", generation: 1, unitId: "u1", start: 250, end: 260, quote: "三联" }] },
      ...Array.from({ length: 9 }, (_, index) => ({ id: `x${index}`, statement: `第 ${index + 3} 条要点`, evidence: [] })),
    ],
    methods: [], omissionAudit: { status: "not_run", omissionRate: null }, units: [],
  },
  ...extra,
});

/** The probe the tests read the navigation off: where the page went and what it carried. */
function Probe() {
  const location = useLocation();
  const how = useNavigationType();
  return <p data-testid="location" data-how={how} data-search={location.search} data-state={JSON.stringify(location.state ?? null)}>{location.pathname}</p>;
}
function renderPage(entry = "/app/files") {
  return render(<MemoryRouter initialEntries={[entry]}><SourcesPage /><Probe /></MemoryRouter>);
}
/** The address the page is at: its path and its query. */
const addressOf = () => { const where = screen.getByTestId("location"); return `${where.textContent}${where.getAttribute("data-search")}`; };
const rowOf = (name: string) => screen.getByText(name).closest("li") as HTMLElement;
const menuOf = async (name: string) => { await userEvent.click(await screen.findByRole("button", { name: `“${name}”的操作` })); };
const selectSpy = vi.fn(async (_projectId: string, land?: () => void) => { land?.(); });

describe("知识库", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    selectSpy.mockClear();
    context.projectId = "default";
    context.features = { openList: true, geo: true, vcr: true };
    useProjectStore.setState({
      currentId: "default", select: selectSpy as never,
      projects: [{ id: "default", name: "我的研究" }, { id: "paper-1", name: "疳证 Meta 文献检索" }, { id: "study-1", name: "二甲双胍外部对照研究" }, { id: "geo-1", name: "波立维" }],
    });
    mocks.listSources.mockResolvedValue(listing([guideline, sheet]));
    mocks.listDuplicateCandidates.mockResolvedValue({ items: [], scanned: 0, truncated: false });
    mocks.getSourceUnderstanding.mockResolvedValue(understanding());
    mocks.listGeoProjects.mockResolvedValue([{ projectId: "geo-1" }]);
    mocks.getVcrHome.mockResolvedValue({ studies: [{ projectId: "study-1" }] });
    mocks.retrySource.mockResolvedValue(guideline);
    mocks.removeSource.mockResolvedValue(guideline);
    mocks.refetchSource.mockResolvedValue({ source: page, duplicate: true, changed: false });
    mocks.addToLibrary.mockResolvedValue({});
    mocks.removeFromLibrary.mockResolvedValue({ sourceId: "src_guideline", removed: true });
    mocks.addSourceLink.mockResolvedValue({ source: page, duplicate: false, changed: true });
    mocks.addSourceNote.mockResolvedValue({ source: note, duplicate: false });
    mocks.getSourceNote.mockResolvedValue({ title: "10月3日组会记录", body: "确定 C1–C3 三类比较分开合并。" });
    mocks.saveSourceNote.mockResolvedValue({ source: { ...note, id: "src_note_2" }, duplicate: false, changed: true });
    mocks.pickFiles.mockResolvedValue([]);
    mocks.uploadFilesToWorkspace.mockResolvedValue([]);
    mocks.browseOpenList.mockResolvedValue({ entries: [], nextCursor: null });
    mocks.listSourceFolders.mockResolvedValue({ items: [], nextCursor: null });
    mocks.downloadArtifact.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  // 2026-10-07 plan §2.3, mockup k01: the title, the scope, a search and one primary action; one row of chips; one list.
  describe("the page", () => {
    it("is its title, the scope it lists, a search and one 「添加」 — and nothing under the title", async () => {
      renderPage();
      const heading = await screen.findByRole("heading", { level: 1, name: "知识库" });
      expect(heading.closest("header")?.querySelectorAll("p")).toHaveLength(0);
      expect(await screen.findByRole("button", { name: "范围：我的研究" })).toBeInTheDocument();
      expect(screen.getByRole("searchbox", { name: "搜索资料和内容" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "添加" })).toBeInTheDocument();
      // The old header's two buttons and the left column are gone.
      expect(screen.queryByRole("button", { name: "上传" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "连接网盘" })).not.toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "项目与类型" })).not.toBeInTheDocument();
      expect(mocks.listSources).toHaveBeenCalledWith({ kind: "project", projectId: "default" }, { q: "", limit: 50 });
    });

    it("is, when empty, one sentence about what to put in and the 「添加」 button", async () => {
      mocks.listSources.mockResolvedValue(listing([]));
      renderPage();
      const empty = await screen.findByText("把文献、指南、方案、数据表、网页或笔记放进来，对话里会读它们并标出处。");
      const state = empty.parentElement!;
      expect(within(state).getAllByRole("button")).toHaveLength(1);
      expect(within(state).getByRole("button", { name: "添加" })).toBeInTheDocument();
      expect(screen.queryByRole("group", { name: "资料类型" })).not.toBeInTheDocument();
      expect(screen.queryByText(/支持 PDF/)).not.toBeInTheDocument();
    });

    it("says it could not load, with a way to try again, and keeps a notice for a failed read or delete off the list", async () => {
      mocks.listSources.mockRejectedValueOnce(new Error("HTTP 503")).mockResolvedValue(listing([guideline]));
      renderPage();
      expect(await screen.findByText(/无法加载资料/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "重试" }));
      expect(await screen.findByText(guideline.display.title)).toBeInTheDocument();
      mocks.removeSource.mockRejectedValueOnce(new WebApiError("conflict", { status: 409, code: "source_revision_conflict" }));
      await menuOf(guideline.display.title);
      await userEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
      await userEvent.click(await screen.findByRole("button", { name: "删除" }));
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
      expect(screen.getByText(guideline.display.title)).toBeInTheDocument();
      expect(screen.queryByText(/无法加载资料/)).not.toBeInTheDocument();
    });
  });

  describe("a row", () => {
    it("is what the document is called, one line of what it says, what it is and where it came from, and the day it came", async () => {
      renderPage();
      await screen.findByText(guideline.display.title);
      const row = rowOf(guideline.display.title);
      expect(within(row).getByText("给出一线四联方案、疗程 14 天与根除后复查的推荐。")).toBeInTheDocument();
      expect(within(row).getByText("指南 · 18 页 · 上传")).toBeInTheDocument();
      expect(within(row).getByText("3月5日")).toBeInTheDocument();
      const table = rowOf("疳证纳入研究提取表.xlsx");
      expect(within(table).getByText("数据表 · 47 KB · 对话产出 · 所有项目可用")).toBeInTheDocument();
      const text = document.body.textContent ?? "";
      for (const bookkeeping of [/已解析/, /处理台账/, /第 1 版/, /深度分析/, /structured/, /The document format/, /上传与浏览原始文件/, /src_guideline/, /review-guideline/, /调整分析/, /查看理解/]) {
        expect(text).not.toMatch(bookkeeping);
      }
    });

    it.each([
      ["a saved page", page, "网页 · nmpa.gov.cn · 链接"],
      ["a note", note, "笔记 · 300 B · 笔记"],
      ["a cloud-drive document", policy, "制度文件 · 42 页 · 网盘"],
    ])("says where %s came from", async (_name, source, meta) => {
      mocks.listSources.mockResolvedValue(listing([source]));
      renderPage();
      expect(within(await screen.findByRole("list", { name: "资料" })).getByText(meta)).toBeInTheDocument();
    });

    it("says a state only while it cannot be used, and 「没能读取 · 重试」 when it could not be read", async () => {
      mocks.listSources.mockResolvedValue(listing([reading, broken, guideline]));
      renderPage();
      expect(within(await screen.findByText(reading.display.title).then((node) => node.closest("li") as HTMLElement)).getByText("正在读取")).toBeInTheDocument();
      const failed = rowOf(broken.display.title);
      expect(within(failed).getByText("没能读取")).toBeInTheDocument();
      await userEvent.click(within(failed).getByRole("button", { name: `重新读取“${broken.display.title}”` }));
      await waitFor(() => expect(mocks.retrySource).toHaveBeenCalledWith("src_broken", 3));
      // A usable document says nothing about its pipeline.
      expect(within(rowOf(guideline.display.title)).queryByText(/正在|没能|无法/)).not.toBeInTheDocument();
      // And reading is not a filter any more.
      expect(screen.queryByRole("button", { name: "需要处理" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "正在读取" })).not.toBeInTheDocument();
    });

    it("gives the reason a read failed, in the registry's words, as the state's tooltip", async () => {
      mocks.listSources.mockResolvedValue(listing([broken]));
      renderPage();
      await userEvent.hover(await screen.findByText("没能读取"));
      expect((await screen.findAllByText(knownErrorCodeMessage("source_parser_timeout")!)).length).toBeGreaterThan(0);
    });

    it("tags a suspected duplicate, and settles it from the row's menu", async () => {
      const group = { kind: "shared-content", groupKey: "shared-content:" + "a".repeat(32), label: "knowledge-base/src_guideline.pdf", sourceIds: ["src_guideline"], decision: null,
        members: [{ sourceId: "src_guideline", paths: ["knowledge-base/a.pdf", "knowledge-base/b.pdf"], updatedAt: arrived }] };
      mocks.listDuplicateCandidates.mockResolvedValue({ items: [group], scanned: 1, truncated: false });
      mocks.decideDuplicateGroup.mockResolvedValue({ id: "srcdup" });
      renderPage();
      await screen.findByText(guideline.display.title);
      expect(await within(rowOf(guideline.display.title)).findByText("疑似重复")).toBeInTheDocument();
      await menuOf(guideline.display.title);
      await userEvent.click(await screen.findByRole("menuitem", { name: "处理疑似重复" }));
      const drawer = await screen.findByRole("dialog", { name: "疑似重复" });
      await userEvent.click(within(drawer).getByRole("button", { name: "不是重复" }));
      await waitFor(() => expect(mocks.decideDuplicateGroup).toHaveBeenCalledWith({ projectId: "default", groupKey: group.groupKey, sourceIds: ["src_guideline"], decision: "dismissed" }));
    });

    it("has four things in its menu: read again, share (or not), settle a duplicate, delete — and not the pipeline's", async () => {
      renderPage();
      await menuOf(sheet.display.title);
      expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["重新读取", "改为仅本项目", "删除"]);
      await userEvent.keyboard("{Escape}");
      await menuOf(guideline.display.title);
      expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["重新读取", "设为所有项目可用", "删除"]);
      for (const removed of ["调整分析", "查看理解", "取消读取", "所有项目可用"]) expect(screen.queryByRole("menuitem", { name: removed === "所有项目可用" ? "所有项目可用" : removed })).not.toBeInTheDocument();
    });

    it("reads a saved page again from its address, and says whether it changed", async () => {
      mocks.listSources.mockResolvedValue(listing([page]));
      renderPage();
      await menuOf(page.display.title);
      await userEvent.click(await screen.findByRole("menuitem", { name: "重新读取" }));
      await waitFor(() => expect(mocks.refetchSource).toHaveBeenCalledWith("src_page"));
      expect(mocks.retrySource).not.toHaveBeenCalled();
      await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("页面没有变化"));
      mocks.refetchSource.mockResolvedValueOnce({ source: page, duplicate: false, changed: true });
      await menuOf(page.display.title);
      await userEvent.click(await screen.findByRole("menuitem", { name: "重新读取" }));
      await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("页面有更新，正在重新读取"));
    });

    it("shares a document with every project, and takes it back", async () => {
      renderPage();
      await menuOf(guideline.display.title);
      await userEvent.click(await screen.findByRole("menuitem", { name: "设为所有项目可用" }));
      await waitFor(() => expect(mocks.addToLibrary).toHaveBeenCalledWith("src_guideline"));
      await menuOf(sheet.display.title);
      await userEvent.click(await screen.findByRole("menuitem", { name: "改为仅本项目" }));
      await waitFor(() => expect(mocks.removeFromLibrary).toHaveBeenCalledWith("src_sheet"));
    });

    it("deletes after a confirmation", async () => {
      renderPage();
      await menuOf(guideline.display.title);
      await userEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
      expect(await screen.findByText("删除这份资料？")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "删除" }));
      await waitFor(() => expect(mocks.removeSource).toHaveBeenCalledWith("src_guideline", 3));
    });
  });

  describe("the chips", () => {
    it("count by what a document is over the whole scope, from the server, and show only the types that are there", async () => {
      mocks.listSources.mockResolvedValue({ ...listing([guideline, sheet]), counts: counts({ all: 11, literature: 4, table: 2, document: 2, page: 1, note: 1, image: 1 }) });
      renderPage();
      const chips = await screen.findByRole("group", { name: "资料类型" });
      expect(within(chips).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部11", "文献与指南4", "数据表2", "文档2", "网页1", "笔记1", "图片1"]);
    });

    it("are left out when only one type is there, and are not asked to count reading state", async () => {
      mocks.listSources.mockResolvedValue(listing([guideline]));
      renderPage();
      await screen.findByText(guideline.display.title);
      expect(screen.queryByRole("group", { name: "资料类型" })).not.toBeInTheDocument();
    });

    it("narrow the list on the server without moving the counts", async () => {
      mocks.listSources.mockImplementation(async (_scope, options) => options?.kind === "table"
        ? { items: [sheet], nextCursor: null, counts: counts({ all: 2, literature: 1, table: 1 }) }
        : { items: [guideline, sheet], nextCursor: null, counts: counts({ all: 2, literature: 1, table: 1 }) });
      renderPage();
      const chips = await screen.findByRole("group", { name: "资料类型" });
      await userEvent.click(within(chips).getByRole("button", { name: /数据表/ }));
      await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith({ kind: "project", projectId: "default" }, { kind: "table", q: "", limit: 50 }));
      await waitFor(() => expect(screen.queryByText(guideline.display.title)).not.toBeInTheDocument());
      expect(within(screen.getByRole("group", { name: "资料类型" })).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部2", "文献与指南1", "数据表1"]);
      await userEvent.click(within(screen.getByRole("group", { name: "资料类型" })).getByRole("button", { name: /全部/ }));
      expect(await screen.findByText(guideline.display.title)).toBeInTheDocument();
    });
  });

  describe("search and pages", () => {
    it("asks the server, after the researcher stops typing, and says when nothing matches", async () => {
      renderPage();
      await screen.findByText(guideline.display.title);
      mocks.listSources.mockResolvedValue(listing([]));
      await userEvent.type(screen.getByRole("searchbox", { name: "搜索资料和内容" }), "不存在");
      await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith({ kind: "project", projectId: "default" }, { q: "不存在", limit: 50 }));
      // Not one request per keystroke.
      expect(mocks.listSources.mock.calls.filter(([, options]) => (options?.q ?? "").length > 0)).toHaveLength(1);
      expect(await screen.findByText("没有找到相关资料")).toBeInTheDocument();
    });

    it("loads the next page of a long list, and never shows a document twice", async () => {
      const second = makeSource("src_second", { title: "第二页的资料" });
      mocks.listSources.mockResolvedValueOnce(listing([guideline], { nextCursor: "cursor-2", counts: { all: 60, literature: 60 } }))
        .mockResolvedValueOnce(listing([guideline, second], { counts: { all: 60, literature: 60 } }));
      renderPage();
      await screen.findByText(guideline.display.title);
      await userEvent.click(screen.getByRole("button", { name: "加载更多" }));
      expect(await screen.findByText("第二页的资料")).toBeInTheDocument();
      expect(mocks.listSources).toHaveBeenLastCalledWith({ kind: "project", projectId: "default" }, { q: "", cursor: "cursor-2", limit: 50 });
      expect(screen.getAllByText(guideline.display.title)).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
    });
  });

  describe("the scope", () => {
    it("groups the account's projects as the sidebar does, and ends with the documents every project shares", async () => {
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "范围：我的研究" }));
      const menu = await screen.findByRole("menu", { name: "选择范围" });
      await waitFor(() => expect(within(menu).getByText("虚拟临床研究")).toBeInTheDocument());
      expect(within(menu).getByText("我的项目")).toBeInTheDocument();
      expect(within(menu).getByText("循证 GEO")).toBeInTheDocument();
      expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["我的研究", "疳证 Meta 文献检索", "二甲双胍外部对照研究", "波立维", "所有项目共享"]);
      expect(within(menu).getByRole("menuitemradio", { name: "我的研究" })).toHaveAttribute("aria-checked", "true");
    });

    it("lists another project without moving the tab to it", async () => {
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "范围：我的研究" }));
      await userEvent.click(await screen.findByRole("menuitemradio", { name: "疳证 Meta 文献检索" }));
      await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith({ kind: "project", projectId: "paper-1" }, { q: "", limit: 50 }));
      expect(await screen.findByRole("button", { name: "范围：疳证 Meta 文献检索" })).toBeInTheDocument();
      expect(selectSpy).not.toHaveBeenCalled();
      expect(mocks.listDuplicateCandidates).toHaveBeenLastCalledWith("paper-1");
    });

    it("lists the shared documents without a project, each saying whose it is, and has its own empty sentence", async () => {
      mocks.listSources.mockImplementation(async (scope) => scope.kind === "shared" ? listing([{ ...sheet, projectId: "paper-1" }]) : listing([guideline]));
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "范围：我的研究" }));
      await userEvent.click(await screen.findByRole("menuitemradio", { name: "所有项目共享" }));
      const row = await screen.findByText("疳证纳入研究提取表.xlsx").then((node) => node.closest("li") as HTMLElement);
      expect(within(row).getByText("数据表 · 47 KB · 对话产出 · 疳证 Meta 文献检索")).toBeInTheDocument();
      expect(mocks.listSources).toHaveBeenLastCalledWith({ kind: "shared" }, { q: "", limit: 50 });
      expect(mocks.listDuplicateCandidates).not.toHaveBeenCalledWith(undefined);
      mocks.listSources.mockResolvedValue(listing([]));
    });

    it("has its own empty sentence, which says how a document gets there", async () => {
      mocks.listSources.mockImplementation(async (scope) => scope.kind === "shared" ? listing([]) : listing([guideline]));
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "范围：我的研究" }));
      await userEvent.click(await screen.findByRole("menuitemradio", { name: "所有项目共享" }));
      expect(await screen.findByText("还没有资料设为所有项目可用。")).toBeInTheDocument();
      expect(screen.getByText("在资料的“⋯”菜单里选“设为所有项目可用”。")).toBeInTheDocument();
    });
  });

  describe("「添加」", () => {
    it("has four ways in: a file, a web link, a note and — where a drive is mounted — the drive", async () => {
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      await waitFor(() => expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["上传文件", "添加网页链接", "新建笔记", "从网盘导入"]));
    });

    it.each([
      ["no storage is mounted", { openList: false }],
      ["the control plane sends no features", undefined],
    ])("offers no drive when %s", async (_case, features) => {
      context.features = features;
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["上传文件", "添加网页链接", "新建笔记"]);
    });

    it("uploads into the project the page lists, says the formats only to a file it refuses, and reads what it uploaded", async () => {
      const files = [new File(["x"], "a.pdf"), new File(["x"], "b.wav")];
      mocks.pickFiles.mockResolvedValue(files);
      mocks.uploadFilesToWorkspace.mockResolvedValue(["knowledge-base/a.pdf"]);
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "范围：我的研究" }));
      await userEvent.click(await screen.findByRole("menuitemradio", { name: "疳证 Meta 文献检索" }));
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "上传文件" }));
      await waitFor(() => expect(mocks.uploadFilesToWorkspace).toHaveBeenCalledWith([files[0]], "knowledge-base", "base", "paper-1"));
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("b.wav（音视频暂不支持）"));
      expect(mocks.toastSuccess).toHaveBeenCalledWith("已上传 1 个文件");
    });

    it("adds to the project the tab is in from the shared scope, and shows it there", async () => {
      mocks.pickFiles.mockResolvedValue([new File(["x"], "a.pdf")]);
      mocks.uploadFilesToWorkspace.mockResolvedValue(["knowledge-base/a.pdf"]);
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "范围：我的研究" }));
      await userEvent.click(await screen.findByRole("menuitemradio", { name: "所有项目共享" }));
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "上传文件" }));
      await waitFor(() => expect(mocks.uploadFilesToWorkspace).toHaveBeenCalledWith(expect.anything(), "knowledge-base", "base", "default"));
      expect(await screen.findByRole("button", { name: "范围：我的研究" })).toBeInTheDocument();
    });

    it("adds a web page by its address, and says in the dialog, in a sentence, why a page cannot be added", async () => {
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "添加网页链接" }));
      const dialog = await screen.findByRole("dialog", { name: "添加网页链接" });
      expect(within(dialog).getByRole("button", { name: "添加" })).toBeDisabled();
      mocks.addSourceLink.mockRejectedValueOnce(new WebApiError("blocked", { status: 403, code: "source_link_blocked" }));
      await userEvent.type(within(dialog).getByLabelText("网址"), "https://www.nmpa.gov.cn/notice");
      await userEvent.click(within(dialog).getByRole("button", { name: "添加" }));
      expect(await within(dialog).findByText(knownErrorCodeMessage("source_link_blocked")!)).toBeInTheDocument();
      expect(mocks.addSourceLink).toHaveBeenCalledWith("default", "https://www.nmpa.gov.cn/notice");
      mocks.listSources.mockResolvedValue(listing([page, guideline]));
      await userEvent.click(within(dialog).getByRole("button", { name: "添加" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加网页链接" })).not.toBeInTheDocument());
      expect(mocks.toastSuccess).toHaveBeenCalledWith("已添加，正在读取");
      expect(await screen.findByText(page.display.title)).toBeInTheDocument();
    });

    it("writes a note, and opens it on its own page", async () => {
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "新建笔记" }));
      const dialog = await screen.findByRole("dialog", { name: "新建笔记" });
      expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();
      await userEvent.type(within(dialog).getByLabelText("标题"), "10月3日组会记录");
      await userEvent.type(within(dialog).getByLabelText("正文"), "确定分组。");
      await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(mocks.addSourceNote).toHaveBeenCalledWith("default", { title: "10月3日组会记录", body: "确定分组。" }));
      // The note opens on its own page, where its editor is; the list it was written from is the way back.
      await waitFor(() => expect(addressOf()).toBe("/app/files/src_note"));
    });

    it("opens the drive from the menu, and browses it for the project the page lists", async () => {
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "从网盘导入" }));
      const drawer = await screen.findByRole("dialog", { name: "从网盘导入" });
      await userEvent.click(within(drawer).getByRole("button", { name: "浏览" }));
      await waitFor(() => expect(mocks.browseOpenList).toHaveBeenCalledWith("default", "/"));
      expect(mocks.listSourceFolders).toHaveBeenCalledWith("default");
    });
  });

  // E-8 and E-19 (design reference §13.1): the list is an address, and a document is a page of its own.
  describe("the list's address", () => {
    it("reads the scope, the type and the search from the address it is opened at", async () => {
      renderPage("/app/files?scope=paper-1&kind=table&q=%E7%96%B3");
      expect(await screen.findByRole("button", { name: "范围：疳证 Meta 文献检索" })).toBeInTheDocument();
      expect(screen.getByRole("searchbox", { name: "搜索资料和内容" })).toHaveValue("疳");
      await waitFor(() => expect(mocks.listSources).toHaveBeenCalledWith({ kind: "project", projectId: "paper-1" }, { kind: "table", q: "疳", limit: 50 }));
      expect(mocks.listSources).not.toHaveBeenCalledWith({ kind: "project", projectId: "default" }, expect.anything());
      expect(await screen.findByRole("button", { name: /数据表/ })).toHaveAttribute("aria-pressed", "true");
    });

    it("reads the shared documents from the address, and ignores a type or a scope it does not know", async () => {
      renderPage("/app/files?scope=shared&kind=nonsense");
      await waitFor(() => expect(mocks.listSources).toHaveBeenCalledWith({ kind: "shared" }, { q: "", limit: 50 }));
    });

    it("writes the type, the scope and the search into the address as they are chosen, and nothing for the defaults", async () => {
      renderPage();
      const chips = await screen.findByRole("group", { name: "资料类型" });
      await userEvent.click(within(chips).getByRole("button", { name: /数据表/ }));
      await waitFor(() => expect(addressOf()).toBe("/app/files?kind=table"));
      await userEvent.click(screen.getByRole("button", { name: "范围：我的研究" }));
      await userEvent.click(await screen.findByRole("menuitemradio", { name: "疳证 Meta 文献检索" }));
      // A scope of its own clears the type; the project the tab is in is the default and is not written.
      await waitFor(() => expect(addressOf()).toBe("/app/files?scope=paper-1"));
      await userEvent.click(screen.getByRole("button", { name: "范围：疳证 Meta 文献检索" }));
      await userEvent.click(await screen.findByRole("menuitemradio", { name: "所有项目共享" }));
      await waitFor(() => expect(addressOf()).toBe("/app/files?scope=shared"));
      await userEvent.type(screen.getByRole("searchbox", { name: "搜索资料和内容" }), "共识");
      await waitFor(() => expect(addressOf()).toBe("/app/files?scope=shared&q=%E5%85%B1%E8%AF%86"));
      await userEvent.click(screen.getByRole("button", { name: "范围：所有项目共享" }));
      await userEvent.click(await screen.findByRole("menuitemradio", { name: "我的研究" }));
      await waitFor(() => expect(addressOf()).toBe("/app/files?q=%E5%85%B1%E8%AF%86"));
    });

    it("changes the address by replacing it, so the back button leaves the list rather than undoing a filter", async () => {
      renderPage();
      const chips = await screen.findByRole("group", { name: "资料类型" });
      await userEvent.click(within(chips).getByRole("button", { name: /数据表/ }));
      await waitFor(() => expect(addressOf()).toBe("/app/files?kind=table"));
      expect(screen.getByTestId("location")).toHaveAttribute("data-how", "REPLACE");
    });

    it("clears the search from its own button and from Escape, and the address follows", async () => {
      renderPage("/app/files?q=%E5%85%B1%E8%AF%86");
      const box = await screen.findByRole("searchbox", { name: "搜索资料和内容" });
      expect(box).toHaveValue("共识");
      await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
      expect(box).toHaveValue("");
      await waitFor(() => expect(addressOf()).toBe("/app/files"));
      await userEvent.type(box, "疳");
      await waitFor(() => expect(addressOf()).toBe("/app/files?q=%E7%96%B3"));
      await userEvent.keyboard("{Escape}");
      expect(box).toHaveValue("");
      await waitFor(() => expect(addressOf()).toBe("/app/files"));
    });

    it("moves the box when the address changes under it (the back button between two lists)", async () => {
      const Mover = () => { const navigate = useNavigate(); return <button type="button" onClick={() => navigate("/app/files?q=%E5%8D%81")}>改地址</button>; };
      render(<MemoryRouter initialEntries={["/app/files?q=%E5%85%B1%E8%AF%86"]}><SourcesPage /><Probe /><Mover /></MemoryRouter>);
      expect(await screen.findByRole("searchbox", { name: "搜索资料和内容" })).toHaveValue("共识");
      await userEvent.click(screen.getByRole("button", { name: "改地址" }));
      await waitFor(() => expect(screen.getByRole("searchbox", { name: "搜索资料和内容" })).toHaveValue("十"));
      await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith({ kind: "project", projectId: "default" }, { q: "十", limit: 50 }));
    });

    it("makes each row a link to the document's own page, carrying the list it came from", async () => {
      renderPage("/app/files?scope=paper-1&kind=literature");
      const link = await screen.findByRole("link", { name: guideline.display.title });
      expect(link).toHaveAttribute("href", "/app/files/src_guideline?scope=paper-1&kind=literature");
      await userEvent.click(link);
      expect(addressOf()).toBe("/app/files/src_guideline?scope=paper-1&kind=literature");
      // The drawer is gone: nothing a row opens is a dialog.
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("sends a document named by ?source= to its own page, with the list's state kept for the way back", async () => {
      renderPage("/app/files?source=src_guideline&scope=paper-1");
      await waitFor(() => expect(addressOf()).toBe("/app/files/src_guideline?scope=paper-1"));
    });

    it("does not take a ?source= that is not a document's id for one", async () => {
      renderPage("/app/files?source=..%2F..%2Fetc");
      expect(await screen.findByRole("heading", { level: 1, name: "知识库" })).toBeInTheDocument();
      expect(addressOf()).toContain("/app/files?source=");
    });

    describe("coming back to it", () => {
      const POSITION = (search: string) => `evimed:knowledge-list-position:${search}`;
      const many = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => makeSource(`src_${from + index}`, { title: `资料 ${from + index}` }));
      const scrollerOf = (container: HTMLElement) => container.querySelector<HTMLElement>(".overflow-y-auto") as HTMLElement;
      beforeEach(() => { window.sessionStorage.clear(); });
      afterEach(() => { window.sessionStorage.clear(); });

      it("keeps where the list was, and how much of it was loaded, when a document is opened", async () => {
        mocks.listSources.mockResolvedValue(listing([guideline, sheet]));
        const { container } = renderPage("/app/files?kind=literature");
        const link = await screen.findByRole("link", { name: guideline.display.title });
        scrollerOf(container).scrollTop = 321;
        await userEvent.click(link);
        expect(JSON.parse(window.sessionStorage.getItem(POSITION("kind=literature"))!)).toEqual({ scroll: 321, count: 2 });
      });

      it("brings the list back as it was left — the same documents loaded, the same scroll — when the back button returns to it", async () => {
        window.sessionStorage.setItem(POSITION("kind=literature"), JSON.stringify({ scroll: 480, count: 120 }));
        mocks.listSources.mockImplementation(async (_scope, options) => options?.cursor
          ? listing(many(101, 120), { counts: { all: 120, literature: 120 } })
          : listing(many(1, 100), { nextCursor: "c2", counts: { all: 120, literature: 120 } }));
        const { container } = renderPage("/app/files?kind=literature");
        await screen.findByText("资料 120");
        expect(mocks.listSources).toHaveBeenNthCalledWith(1, { kind: "project", projectId: "default" }, { kind: "literature", q: "", limit: 100 });
        expect(mocks.listSources).toHaveBeenNthCalledWith(2, { kind: "project", projectId: "default" }, { kind: "literature", q: "", cursor: "c2", limit: 50 });
        expect(scrollerOf(container).scrollTop).toBe(480);
        // Once: a later reload of the same list does not jump back.
        scrollerOf(container).scrollTop = 0;
        await userEvent.type(screen.getByRole("searchbox", { name: "搜索资料和内容" }), "资");
        await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ q: "资" })));
        expect(scrollerOf(container).scrollTop).toBe(0);
      });

      it("brings it back through 「知识库」 on the document's page as well, which is a new entry and not the back button — and not for a visit of its own", async () => {
        window.sessionStorage.setItem(POSITION(""), JSON.stringify({ scroll: 90, count: 2 }));
        function Elsewhere() {
          const navigate = useNavigate();
          return (
            <>
              <button type="button" onClick={() => navigate("/app/files")}>从侧栏进入</button>
              <button type="button" onClick={() => navigate("/app/files", { state: { kbRestore: true } })}>从资料页回来</button>
              <button type="button" onClick={() => navigate("/app/chat")}>离开</button>
            </>
          );
        }
        function Table() { return useRoutes([{ path: "/app/chat", element: <Elsewhere /> }, { path: "/app/files", element: <><SourcesPage /><Elsewhere /></> }]); }
        const { container } = render(<MemoryRouter initialEntries={["/app/chat"]}><Table /></MemoryRouter>);
        await userEvent.click(screen.getByRole("button", { name: "从侧栏进入" }));
        await screen.findByText(guideline.display.title);
        // The sidebar is a visit of its own: the list starts at the top, whatever was kept.
        expect(scrollerOf(container).scrollTop).toBe(0);
        await userEvent.click(screen.getByRole("button", { name: "离开" }));
        await userEvent.click(screen.getByRole("button", { name: "从资料页回来" }));
        await waitFor(() => expect(scrollerOf(container).scrollTop).toBe(90));
      });

      it("starts at the top for a visit of its own, and ignores a kept position that is not a position", async () => {
        window.sessionStorage.setItem(POSITION(""), JSON.stringify({ scroll: -4, count: "many" }));
        const { container } = renderPage();
        await screen.findByText(guideline.display.title);
        expect(scrollerOf(container).scrollTop).toBe(0);
        expect(mocks.listSources).toHaveBeenCalledWith({ kind: "project", projectId: "default" }, { q: "", limit: 50 });
      });
    });
  });

  it("offers dropping files onto the page, and takes them into the project it lists", async () => {
    mocks.uploadFilesToWorkspace.mockResolvedValue(["knowledge-base/dropped.pdf"]);
    const { container } = renderPage();
    await screen.findByText(guideline.display.title);
    const zone = container.firstElementChild as HTMLElement;
    const file = new File(["x"], "dropped.pdf");
    const transfer = (files: File[] = []) => ({ dataTransfer: { types: ["Files"], files } });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.dragEnter(zone, transfer());
    expect(screen.getByText("松开即可上传")).toBeInTheDocument();
    fireEvent.drop(zone, transfer([file]));
    await waitFor(() => expect(mocks.uploadFilesToWorkspace).toHaveBeenCalledWith([file], "knowledge-base", "base", "default"));
  });
});
