import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate, useNavigationType, useRoutes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knownErrorCodeMessage } from "@evimed/domain";
import { WebApiError } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import type { SourceCounts, SourceDisplay, SourceKind, SourceRecord } from "@/lib/sourceClient";
import statusCompiled from "@/components/sources/knowledgeFixtures/status-compiled.json";
import knowledgePage from "@/components/sources/knowledgeFixtures/page-analysis-mine.json";
import treeMixed from "@/components/sources/knowledgeFixtures/tree-mixed.json";
import graphKgMedical from "@/components/sources/knowledgeFixtures/graph-kg-medical.json";
import graphWikiMedical from "@/components/sources/knowledgeFixtures/graph-wiki-medical.json";
import { compositionFacts, precedes } from "@/test/compositionFixtures";
import { SourcesPage } from "./SourcesPage";

const mocks = vi.hoisted(() => ({
  listSources: vi.fn(), retrySource: vi.fn(), removeSource: vi.fn(), refetchSource: vi.fn(),
  addSourceLink: vi.fn(), addSourceNote: vi.fn(), getSourceNote: vi.fn(), saveSourceNote: vi.fn(),
  getSourceUnderstanding: vi.fn(), getOpenListStatus: vi.fn(), uploadPersonalFile: vi.fn(),
  browseOpenList: vi.fn(), importOpenListSource: vi.fn(), listSourceFolders: vi.fn(), registerSourceFolder: vi.fn(), syncSourceFolder: vi.fn(), setSourceFolderStatus: vi.fn(),
  listDuplicateCandidates: vi.fn(), decideDuplicateGroup: vi.fn(), setSourceProjects: vi.fn(),
  getSource: vi.fn(), getSourceMaterials: vi.fn(), getSourceFamily: vi.fn(), getSourceUses: vi.fn(), getSourceDependents: vi.fn(), getKnowledgePage: vi.fn(),
  pickFiles: vi.fn(), uploadFilesToWorkspace: vi.fn(), downloadArtifact: vi.fn(), downloadKnowledgeVault: vi.fn(), listProjectOutputs: vi.fn(), getSourceComposition: vi.fn(),
  listGeoProjects: vi.fn(), getVcrHome: vi.fn(), requestKnowledgeCompile: vi.fn(), getKnowledgeStatus: vi.fn(), getKnowledgeTree: vi.fn(), getKnowledgeGraph: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(),
}));
const context = vi.hoisted(() => ({ projectId: "default", features: { openList: true, geo: true, vcr: true } as Record<string, unknown> | undefined }));

// Only the request functions are replaced. `sourceFailureMessage` is a pure projection over the one error dictionary,
// and a test that stubbed it would prove the page renders a string this file wrote rather than the registry's.
vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()), ...Object.fromEntries(
  ["getOpenListStatus", "uploadPersonalFile", "listSources", "retrySource", "removeSource", "refetchSource", "addSourceLink", "addSourceNote", "getSourceNote", "saveSourceNote", "getSourceUnderstanding",
    "getSource", "getSourceMaterials", "getSourceFamily", "getSourceUses", "getKnowledgePage", "setSourceProjects",
    "browseOpenList", "importOpenListSource", "listSourceFolders", "registerSourceFolder", "syncSourceFolder", "setSourceFolderStatus",
    "listDuplicateCandidates", "decideDuplicateGroup", "requestKnowledgeCompile",
    "getKnowledgeStatus", "getKnowledgeTree", "getKnowledgeGraph"].map((name) => [name, (mocks as Record<string, unknown>)[name]])) }));
vi.mock("@/lib/knowledgeBaseClient", async (importOriginal) => ({ ...(await importOriginal<object>()), downloadKnowledgeVault: mocks.downloadKnowledgeVault, listProjectOutputs: mocks.listProjectOutputs, getSourceComposition: mocks.getSourceComposition, getSourceDependents: mocks.getSourceDependents }));
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
    // Where a document of the whole library's list takes effect: the project that holds it, unless its own choice says more.
    holders: [{ id: "default", name: "我的研究" }], libraryProjects: null, appliesTo: ["default"],
    display: display(shown),
    payload: { paths: [`knowledge-base/${id}.pdf`], status: "complete", docType: "review-guideline", depth: "structured", version: 1, generation: 1,
      reasons: ["The document format is parsed into traceable units."], valueVector: {}, coverage: null, outputs: { summary: "给出一线四联方案。" }, fingerprint: { size: 2_200_000 },
      currentUnderstandingId: "understanding:x:g1", ...payload },
    ...extra,
  } as SourceRecord;
}
const guideline = makeSource("src_guideline");
const sheet = makeSource("src_sheet", { title: "疳证纳入研究提取表.xlsx", gist: "75 项研究的基线、干预、对照和总有效率。", docType: "dataset", typeShort: "数据表", kind: "table", origin: "conversation", format: "xlsx", pages: null, size: 48_000, shared: true },
  { paths: ["knowledge-base/chat/疳证纳入研究提取表-1a2b3c4d.xlsx"], fingerprint: { size: 48_000, sha256: "a".repeat(64) } },
  { projectId: "paper-1", holders: [{ id: "paper-1", name: "疳证 Meta 文献检索" }], libraryProjects: "all", appliesTo: "all" });
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

const counts = (overrides: Partial<SourceCounts> = {}): SourceCounts => ({ all: 0, literature: 0, table: 0, document: 0, page: 0, note: 0, image: 0, wiki: 0, ...overrides });
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
/** The router's one route to the page — the list, or a document in the list's pane (`files/:sourceId?`) — so choosing a document is not a reload. */
function Pages() {
  return useRoutes([
    { path: "/app/files/:sourceId?", element: <><SourcesPage /><Probe /></> },
    { path: "/app/chat", element: <Probe /> },
  ]);
}
function renderPage(entry = "/app/files") {
  return render(<MemoryRouter initialEntries={[entry]}><Pages /></MemoryRouter>);
}
/** jsdom lays nothing out: a page that splits is told it has `width` px, and a reader's box that it has `box` px (the pane's own, which is less). */
const layout = vi.hoisted(() => ({ width: 0, box: 700 }));
let rectSpy: { mockRestore(): void } | null = null;
function stubLayout(width: number, box = 700) {
  layout.width = width; layout.box = box;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => (
    { width: layout.width, height: 800, top: 0, left: 0, right: layout.width, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect));
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return layout.box; } });
}
function unstubLayout() {
  vi.unstubAllGlobals();
  rectSpy?.mockRestore(); rectSpy = null;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
}
/** The address the page is at: its path and its query. */
const addressOf = () => { const where = screen.getByTestId("location"); return `${where.textContent}${where.getAttribute("data-search")}`; };
const rowOf = (name: string) => screen.getByText(name).closest("li") as HTMLElement;
/** A row of the list column, when the pane beside it names the same document. */
const listRowOf = (name: string) => within(screen.getByRole("region", { name: "资料列表" })).getByText(name).closest("li") as HTMLElement;
const menuOf = async (name: string) => { await userEvent.click(await screen.findByRole("button", { name: `“${name}”的操作` })); };
const selectSpy = vi.fn(async (_projectId: string, land?: () => void) => { land?.(); });

describe("知识库", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    Object.values(mocks).forEach((mock) => mock.mockReset());
    selectSpy.mockClear();
    context.projectId = "default";
    context.features = { openList: true, geo: true, vcr: true };
    useProjectStore.setState({
      currentId: "default", select: selectSpy as never,
      projects: [{ id: "default", name: "我的研究" }, { id: "paper-1", name: "疳证 Meta 文献检索" }, { id: "study-1", name: "二甲双胍外部对照研究" }, { id: "geo-1", name: "波立维" }],
    });
    mocks.listSources.mockResolvedValue(listing([guideline, sheet]));
    mocks.getKnowledgeStatus.mockResolvedValue(statusCompiled);
    mocks.getKnowledgeTree.mockResolvedValue(treeMixed);
    mocks.getKnowledgeGraph.mockImplementation(async (_project: string, kind: string) => (kind === "kg" ? graphKgMedical : graphWikiMedical));
    mocks.listDuplicateCandidates.mockResolvedValue({ items: [], scanned: 0, truncated: false });
    mocks.getSourceUnderstanding.mockResolvedValue(understanding());
    mocks.getSource.mockImplementation(async (id: string) => [guideline, sheet, page, note, policy, broken, reading].find((source) => source.id === id)
      ?? (() => { throw new WebApiError("not found", { status: 404, code: "source_not_found" }); })());
    mocks.getSourceMaterials.mockResolvedValue({ sourceId: "src_guideline", generation: 1, materials: null, reason: "not_extracted" });
    mocks.getSourceFamily.mockResolvedValue({ sourceId: "src_guideline", familyId: null, currentVersion: 1, items: [], nextCursor: null });
    mocks.getSourceUses.mockResolvedValue({ items: [] });
    mocks.getSourceDependents.mockResolvedValue({ memories: [], methods: [], results: [] });
    mocks.listGeoProjects.mockResolvedValue([{ projectId: "geo-1" }]);
    mocks.getVcrHome.mockResolvedValue({ studies: [{ projectId: "study-1" }] });
    mocks.retrySource.mockResolvedValue(guideline);
    mocks.removeSource.mockResolvedValue(guideline);
    mocks.refetchSource.mockResolvedValue({ source: page, duplicate: true, changed: false });
    mocks.setSourceProjects.mockResolvedValue({ libraryProjects: "all", appliesTo: "all" });
    mocks.addSourceLink.mockResolvedValue({ source: page, duplicate: false, changed: true });
    mocks.addSourceNote.mockResolvedValue({ source: note, duplicate: false });
    mocks.getSourceNote.mockResolvedValue({ title: "10月3日组会记录", body: "确定 C1–C3 三类比较分开合并。" });
    mocks.saveSourceNote.mockResolvedValue({ source: { ...note, id: "src_note_2" }, duplicate: false, changed: true });
    mocks.pickFiles.mockResolvedValue([]);
    mocks.uploadFilesToWorkspace.mockResolvedValue([]);
    mocks.getOpenListStatus.mockResolvedValue({ state: "ready" });
    mocks.uploadPersonalFile.mockResolvedValue({ source: { ...guideline, personal: true, projectId: "evimed-library" } });
    mocks.browseOpenList.mockResolvedValue({ entries: [], nextCursor: null });
    mocks.listSourceFolders.mockResolvedValue({ items: [], nextCursor: null });
    mocks.downloadArtifact.mockResolvedValue(undefined);
    mocks.downloadKnowledgeVault.mockResolvedValue(undefined);
    mocks.listProjectOutputs.mockResolvedValue([]);
    mocks.getSourceComposition.mockResolvedValue({ total: 0, dated: 0, keyworded: 0, years: [], keywords: [] });
  });
  afterEach(() => { vi.useRealTimers(); unstubLayout(); });

  it("lists every document of the account once, with no project to choose at the top, and asks no project to compile", async () => {
    renderPage();
    expect(await screen.findByText(guideline.display.title)).toBeInTheDocument();
    await waitFor(() => expect(mocks.listSources).toHaveBeenCalledWith({ kind: "all" }, { q: "", limit: 50 }));
    expect(screen.queryByRole("button", { name: /^范围/ })).toBeNull();
    expect(mocks.getKnowledgeStatus).not.toHaveBeenCalled(); expect(mocks.getKnowledgeGraph).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab")).toBeNull();
    // A project the sidebar is in, or one the address names, does not narrow the documents: where one takes effect is its own choice.
    cleanup();
    renderPage("/app/files?scope=paper-1");
    await screen.findByText(guideline.display.title);
    expect(mocks.listSources).not.toHaveBeenCalledWith({ kind: "project", projectId: "paper-1" }, expect.anything());
  });

  it("keeps individual personal upload successes when another file is refused, and the account's own storage is the default place", async () => {
    mocks.uploadPersonalFile.mockResolvedValueOnce({ source: { ...guideline, personal: true } }).mockRejectedValueOnce(new Error("too large"));
    renderPage("/app/files");
    await userEvent.click(await screen.findByRole("button", { name: "添加" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "上传文件" }));
    expect(screen.getByRole("combobox", { name: "保存位置" })).toHaveValue("我的资料（所有项目可用）");
    expect(screen.getByRole("combobox", { name: "保存位置" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText(/选择资料文件/, { selector: "input" })).toHaveFocus();
    expect(screen.getByText(/放进我的资料，所有项目都能用；也可以改选一个项目，只放在那个项目里。/)).toBeInTheDocument();
    expect(screen.queryByText(/资料权限/)).toBeNull();
    await userEvent.upload(screen.getByLabelText(/选择资料文件/, { selector: "input" }), [new File(["x"], "one.pdf"), new File(["x"], "two.pdf")]);
    await waitFor(() => expect(mocks.uploadPersonalFile).toHaveBeenCalledTimes(2));
    expect(mocks.uploadFilesToWorkspace).not.toHaveBeenCalled();
    expect(await screen.findByText(/^two.pdf：失败/)).toBeInTheDocument();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已上传 1 个文件");
  });

  it("selects the document it has just added in the pane, with no filter or search hiding it from the list", async () => {
    stubLayout(1200);
    const added = { ...guideline, id: "src_added", personal: true, projectId: "evimed-library", display: { ...guideline.display, title: "刚上传的指南.pdf" } } as SourceRecord;
    mocks.uploadPersonalFile.mockResolvedValue({ source: added });
    renderPage("/app/files?kind=table&q=%E7%96%B3");
    await userEvent.click(await screen.findByRole("button", { name: "添加" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "上传文件" }));
    await userEvent.upload(screen.getByLabelText(/选择资料文件/, { selector: "input" }), new File(["x"], "added.pdf"));
    await waitFor(() => expect(addressOf()).toBe("/app/files/src_added"));
  });

  it.each([
    ["/app/files", "我的资料（所有项目可用）"], ["/app/files?scope=shared", "我的资料（所有项目可用）"],
  ])("opens the upload form from an unavailable drive with the account's own storage as the place: %s", async (address, destination) => {
    mocks.getOpenListStatus.mockResolvedValue({ state: "unavailable" });
    renderPage(address);
    await userEvent.click(await screen.findByRole("button", { name: "添加" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "从网盘导入" }));
    const drive = await screen.findByRole("dialog", { name: "从网盘导入" });
    await userEvent.click(await within(drive).findByRole("button", { name: "上传文件" }));
    const upload = await screen.findByRole("dialog", { name: "上传资料" });
    expect(screen.queryByRole("dialog", { name: "从网盘导入" })).toBeNull();
    expect(within(upload).getByRole("combobox", { name: "保存位置" })).toHaveValue(destination);
    expect(within(upload).getByRole("combobox", { name: "保存位置" })).toHaveAttribute("aria-expanded", "false");
    expect(within(upload).getByLabelText(/选择资料文件/, { selector: "input" })).toHaveFocus();
    expect(mocks.pickFiles).not.toHaveBeenCalled(); expect(mocks.uploadFilesToWorkspace).not.toHaveBeenCalled(); expect(mocks.uploadPersonalFile).not.toHaveBeenCalled();
  });

  it("keeps the upload picker focused and handles its first click without moving the destination field", async () => {
    renderPage("/app/files");
    await userEvent.click(await screen.findByRole("button", { name: "添加" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "上传文件" }));
    const picker = screen.getByLabelText(/选择资料文件/, { selector: "input" });
    const destination = screen.getByRole("combobox", { name: "保存位置" });
    expect(picker).toHaveFocus(); expect(destination).toHaveAttribute("aria-expanded", "false");
    const clicked = vi.fn(); picker.addEventListener("click", clicked);
    await userEvent.click(picker);
    expect(clicked).toHaveBeenCalledOnce(); expect(destination).toHaveAttribute("aria-expanded", "false");
    expect(mocks.uploadPersonalFile).not.toHaveBeenCalled();
  });

  // 2026-10-28 (owner: 「不要上下布局」): the page is a list and a pane side by side. Below the room for both, the list is the page.
  describe("the page", () => {
    it("is its title, a search, the four views as links and one 「添加」 — and nothing under the title", async () => {
      renderPage();
      const heading = await screen.findByRole("heading", { level: 1, name: "知识库" });
      expect(heading.closest("header")?.querySelectorAll("p")).toHaveLength(0);
      expect(await screen.findByRole("searchbox", { name: "搜索资料和内容" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "添加" })).toBeInTheDocument();
      // The views are links, not a tab list: which of them it is, is the address.
      const views = screen.getByRole("navigation", { name: "知识库的内容" });
      expect(within(views).getAllByRole("link").map((link) => link.textContent)).toEqual(["资料", "对话产出"]);
      expect(within(views).getByRole("link", { name: "资料" })).toHaveAttribute("aria-current", "page");
      expect(screen.queryByRole("tablist")).toBeNull();
      // The old header's two buttons and the left column are gone.
      expect(screen.queryByRole("button", { name: "上传" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "连接网盘" })).not.toBeInTheDocument();
      expect(mocks.listSources).toHaveBeenCalledWith({ kind: "all" }, { q: "", limit: 50 });
    });

    it("offers 知识页 and 图谱 beside 资料 where the deployment compiles pages", async () => {
      context.features = { knowledgePages: true };
      renderPage();
      const views = await screen.findByRole("navigation", { name: "知识库的内容" });
      await waitFor(() => expect(within(views).getAllByRole("link").map((link) => link.textContent)).toEqual(["资料", "知识页", "图谱", "对话产出"]));
      expect(within(views).getByRole("link", { name: "知识页" })).toHaveAttribute("href", "/app/files?kind=wiki");
      expect(within(views).getByRole("link", { name: "图谱" })).toHaveAttribute("href", "/app/files?kind=wiki&view=graph");
      expect(within(views).getByRole("link", { name: "对话产出" })).toHaveAttribute("href", "/app/files?view=outputs");
    });

    it("keeps 知识页 and 图谱 as a pair where either is open, though the deployment compiles no pages: the way to a project's pages is not hidden from its own address", async () => {
      context.features = { openList: true };
      stubLayout(1200);
      renderPage("/app/files?scope=default&kind=wiki&view=graph");
      const views = await screen.findByRole("navigation", { name: "知识库的内容" });
      expect(within(views).getAllByRole("link").map((link) => link.textContent)).toEqual(["资料", "知识页", "图谱", "对话产出"]);
      expect(within(views).getByRole("link", { name: "图谱" })).toHaveAttribute("aria-current", "page");
    });

    it("holds the list in the one page column a list page uses, its title and its rows in the same box, where the page has no room for a pane", async () => {
      const { container } = renderPage();
      const heading = await screen.findByRole("heading", { level: 1, name: "知识库" });
      const column = container.querySelector(".max-w-page");
      expect(column, "the page has no list column").not.toBeNull();
      expect(column).toContainElement(heading);
      expect(column).toContainElement(await screen.findByRole("list", { name: "资料" }));
      expect(container.querySelector("[data-knowledge-layout]")).toHaveAttribute("data-knowledge-layout", "single");
    });

    it("is, when empty and alone, one sentence about what to put in and the 「添加」 button — which is then not also in the header", async () => {
      mocks.listSources.mockResolvedValue(listing([]));
      renderPage();
      const empty = await screen.findByText("把文献、指南、方案、数据表、网页或笔记放进来，对话里会读它们并标出处。");
      const state = empty.parentElement!;
      expect(within(state).getAllByRole("button")).toHaveLength(1);
      expect(within(state).getByRole("button", { name: "添加" })).toBeInTheDocument();
      // Review L-5: two solid 「添加」, one in the header and one in the empty state, with the same menu behind both.
      expect(screen.getAllByRole("button", { name: "添加" })).toHaveLength(1);
      expect(within(screen.getByRole("heading", { level: 1, name: "知识库" }).closest("header")!).queryByRole("button", { name: "添加" })).not.toBeInTheDocument();
      expect(screen.queryByRole("group", { name: "资料类型" })).not.toBeInTheDocument();
      expect(screen.queryByText(/支持 PDF/)).not.toBeInTheDocument();
    });

    it("keeps the header's 「添加」 while the list is read, and where the empty state offers none: a search with no hit", async () => {
      mocks.listSources.mockReturnValue(new Promise(() => undefined));
      renderPage();
      expect(await screen.findByRole("button", { name: "添加" })).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "添加" })).toHaveLength(1);
      cleanup();
      mocks.listSources.mockReset();
      mocks.listSources.mockResolvedValue(listing([]));
      renderPage("/app/files?q=没有这个");
      expect(await screen.findByText("没有找到相关资料")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "添加" })).toHaveLength(1);
      expect(within(screen.getByRole("heading", { level: 1, name: "知识库" }).closest("header")!).getByRole("button", { name: "添加" })).toBeInTheDocument();
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

  describe("choosing documents for a conversation", () => {
    it("takes several selected sources to an unsent conversation in the one project they all take effect in, and excludes a removed selection", async () => {
      renderPage();
      const user = userEvent.setup();
      const first = await screen.findByRole("checkbox", { name: `选择“${guideline.display.title}”` });
      const second = screen.getByRole("checkbox", { name: `选择“${sheet.display.title}”` });
      await user.click(first);
      await user.click(second);
      // The selection takes the place of the one row of controls — nothing is drawn at the bottom of the page.
      const selection = screen.getByRole("group", { name: "所选资料" });
      expect(selection).toHaveTextContent("已选 2 份");
      expect(selection.hasAttribute("data-toolbar")).toBe(true);
      expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(1);
      expect(screen.queryByRole("searchbox", { name: "搜索资料和内容" })).toBeNull();
      expect(screen.queryByRole("region", { name: "所选资料" })).toBeNull();
      await user.click(second);
      await user.click(within(screen.getByRole("group", { name: "所选资料" })).getByRole("button", { name: "在对话中使用" }));
      const location = screen.getByTestId("location");
      await waitFor(() => expect(location).toHaveTextContent("/app/chat"));
      const intent = JSON.parse(location.dataset.state!).runtimeUiIntent;
      expect(intent.references).toEqual([{ id: guideline.id, title: guideline.display.title }]);
      expect(intent.draft).not.toMatch(/src_|knowledge-base|\.evimed-/);
      expect(intent.send).not.toBe(true);
      expect(selectSpy).toHaveBeenCalledWith("default", expect.any(Function));
    });

    it("opens the one project both documents take effect in without asking, and never switches the sidebar's project behind the person's back", async () => {
      // The guideline is held by 「我的研究」 alone; the sheet takes effect everywhere: they share exactly one project.
      renderPage();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("checkbox", { name: `选择“${guideline.display.title}”` }));
      await user.click(screen.getByRole("checkbox", { name: `选择“${sheet.display.title}”` }));
      await user.click(within(screen.getByRole("group", { name: "所选资料" })).getByRole("button", { name: "在对话中使用" }));
      await waitFor(() => expect(selectSpy).toHaveBeenCalledWith("default", expect.any(Function)));
      expect(screen.queryByRole("dialog", { name: "选择对话项目" })).toBeNull();
    });

    it("asks which project when they all take effect in several, and uses the one the person picks", async () => {
      renderPage();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("checkbox", { name: `选择“${sheet.display.title}”` }));
      await user.click(within(screen.getByRole("group", { name: "所选资料" })).getByRole("button", { name: "在对话中使用" }));
      expect(selectSpy).not.toHaveBeenCalled();
      const dialog = await screen.findByRole("dialog", { name: "选择对话项目" });
      await user.click(within(dialog).getByRole("combobox", { name: "项目" }));
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["我的研究", "疳证 Meta 文献检索"]);
      await user.click(screen.getByRole("button", { name: "疳证 Meta 文献检索" }));
      await user.click(within(dialog).getByRole("button", { name: "在对话中使用" }));
      await waitFor(() => expect(selectSpy).toHaveBeenCalledWith("paper-1", expect.any(Function)));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
    });

    it("says so, and starts nothing, when the documents share no project", async () => {
      const elsewhere = makeSource("src_elsewhere", { title: "只在另一个项目的方案.docx" }, {}, { projectId: "paper-1", holders: [{ id: "paper-1", name: "疳证 Meta 文献检索" }], appliesTo: ["paper-1"] });
      mocks.listSources.mockResolvedValue(listing([guideline, elsewhere]));
      renderPage();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("checkbox", { name: `选择“${guideline.display.title}”` }));
      await user.click(screen.getByRole("checkbox", { name: `选择“${elsewhere.display.title}”` }));
      await user.click(within(screen.getByRole("group", { name: "所选资料" })).getByRole("button", { name: "在对话中使用" }));
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("没有共同生效的项目"));
      expect(selectSpy).not.toHaveBeenCalled();
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
      expect(within(table).getByText("数据表 · 47 KB · 对话产出")).toBeInTheDocument();
      const text = document.body.textContent ?? "";
      for (const bookkeeping of [/已解析/, /处理台账/, /第 1 版/, /深度分析/, /structured/, /The document format/, /上传与浏览原始文件/, /src_guideline/, /review-guideline/, /调整分析/, /查看理解/, /所有项目可用/]) {
        expect(text).not.toMatch(bookkeeping);
      }
    });

    it("says where the document takes effect after what it is — the project that holds it, or 「所有项目」 — and that is the press that changes it", async () => {
      renderPage();
      await screen.findByText(guideline.display.title);
      const held = within(rowOf(guideline.display.title)).getByRole("button", { name: `“${guideline.display.title}”的生效项目：我的研究，点击修改` });
      expect(held).toHaveTextContent("我的研究");
      expect(rowOf(guideline.display.title)).toHaveTextContent("生效于");
      expect(within(rowOf(sheet.display.title)).getByRole("button", { name: `“${sheet.display.title}”的生效项目：所有项目，点击修改` })).toHaveTextContent("所有项目");
    });

    it("names the holders first and then the projects it was sent to, and says when it takes effect nowhere", async () => {
      const spread = makeSource("src_spread", { title: "送到了两个项目的方案.docx" }, {}, { holders: [{ id: "default", name: "我的研究" }], libraryProjects: ["paper-1"], appliesTo: ["default", "paper-1"] });
      const nowhere = makeSource("src_nowhere", { title: "还没有交给任何项目的笔记" }, {}, { personal: true, projectId: "evimed-library", holders: [], libraryProjects: [], appliesTo: [] });
      mocks.listSources.mockResolvedValue(listing([spread, nowhere]));
      renderPage();
      await screen.findByText(spread.display.title);
      expect(within(rowOf(spread.display.title)).getByRole("button", { name: /生效项目：我的研究、疳证 Meta 文献检索/ })).toBeInTheDocument();
      expect(within(rowOf(nowhere.display.title)).getByRole("button", { name: /生效项目：暂未用于任何项目/ })).toBeInTheDocument();
    });

    it("changes where it takes effect from a dialog: every project or a list, the holder checked and fixed, saved with one PUT, and said in the row at once", async () => {
      mocks.setSourceProjects.mockResolvedValue({ libraryProjects: ["paper-1"], appliesTo: ["default", "paper-1"] });
      renderPage();
      await screen.findByText(guideline.display.title);
      await userEvent.click(within(rowOf(guideline.display.title)).getByRole("button", { name: /生效项目：我的研究/ }));
      const dialog = await screen.findByRole("dialog", { name: "生效项目" });
      expect(within(dialog).getByRole("radio", { name: "选择项目" })).toBeChecked();
      const held = within(dialog).getByRole("checkbox", { name: /我的研究/ });
      expect(held).toBeChecked(); expect(held).toBeDisabled();
      // The projects a document may be sent to are the person's own: not a study, not a 循证 GEO project.
      expect(within(dialog).getAllByRole("checkbox").map((box) => box.closest("label")?.textContent)).toEqual(["我的研究所在项目，不能取消", "疳证 Meta 文献检索"]);
      await userEvent.click(within(dialog).getByRole("checkbox", { name: "疳证 Meta 文献检索" }));
      await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(mocks.setSourceProjects).toHaveBeenCalledWith("src_guideline", ["paper-1"]));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "生效项目" })).not.toBeInTheDocument());
      expect(within(rowOf(guideline.display.title)).getByRole("button", { name: /生效项目：我的研究、疳证 Meta 文献检索/ })).toBeInTheDocument();
      expect(mocks.toastSuccess).toHaveBeenCalledWith("已更新生效项目");
    });

    it("sends 「所有项目」 as the word, and says a refusal in the registry's sentence without losing the choice", async () => {
      mocks.setSourceProjects.mockRejectedValueOnce(new WebApiError("no", { status: 400, code: "library_project_invalid" }));
      renderPage();
      await screen.findByText(guideline.display.title);
      await userEvent.click(within(rowOf(guideline.display.title)).getByRole("button", { name: /生效项目：我的研究/ }));
      const dialog = await screen.findByRole("dialog", { name: "生效项目" });
      await userEvent.click(within(dialog).getByRole("radio", { name: "所有项目" }));
      await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(knownErrorCodeMessage("library_project_invalid")!);
      expect(mocks.setSourceProjects).toHaveBeenLastCalledWith("src_guideline", "all");
      expect(within(dialog).getByRole("radio", { name: "所有项目" })).toBeChecked();
      await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "生效项目" })).not.toBeInTheDocument());
      expect(within(rowOf(guideline.display.title)).getByRole("button", { name: /生效项目：所有项目/ })).toBeInTheDocument();
    });

    it.each([
      ["a saved page", page, "网页 · nmpa.gov.cn · 链接"],
      ["a note", note, "笔记 · 300 B"],
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

    it("has two things in its menu — read again where that is possible, and delete — and neither a suspected duplicate nor where it takes effect", async () => {
      renderPage();
      await menuOf(sheet.display.title);
      expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["重新读取", "删除"]);
      await userEvent.keyboard("{Escape}");
      for (const removed of ["添加到项目", "设为所有项目可用", "改为仅本项目", "处理疑似重复", "调整分析", "查看理解", "取消读取"]) expect(screen.queryByRole("menuitem", { name: removed })).not.toBeInTheDocument();
    });

    it("tags no suspected duplicate: those are a project's, and the document's own page settles them", async () => {
      const group = { kind: "shared-content", groupKey: "shared-content:" + "a".repeat(32), label: "knowledge-base/src_guideline.pdf", sourceIds: ["src_guideline"], decision: null,
        members: [{ sourceId: "src_guideline", paths: ["knowledge-base/a.pdf", "knowledge-base/b.pdf"], updatedAt: arrived }] };
      mocks.listDuplicateCandidates.mockResolvedValue({ items: [group], scanned: 1, truncated: false });
      renderPage();
      await screen.findByText(guideline.display.title);
      expect(within(rowOf(guideline.display.title)).queryByText("疑似重复")).not.toBeInTheDocument();
      expect(mocks.listDuplicateCandidates).not.toHaveBeenCalled();
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

    it("removes only the deleted source from selected references", async () => {
      renderPage();
      await userEvent.click(await screen.findByRole("checkbox", { name: `选择“${guideline.display.title}”` }));
      await userEvent.click(screen.getByRole("checkbox", { name: `选择“${sheet.display.title}”` }));
      await menuOf(guideline.display.title);
      await userEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
      mocks.listSources.mockResolvedValue(listing([sheet]));
      await userEvent.click(await screen.findByRole("button", { name: "删除" }));
      await waitFor(() => expect(screen.getByRole("group", { name: "所选资料" })).toHaveTextContent("已选 1 份"));
      await userEvent.click(within(screen.getByRole("group", { name: "所选资料" })).getByRole("button", { name: "在对话中使用" }));
      await userEvent.click(await screen.findByRole("combobox", { name: "项目" }));
      await userEvent.click(screen.getByRole("button", { name: "我的研究" }));
      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "在对话中使用" }));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
      expect(JSON.parse(screen.getByTestId("location").dataset.state!).runtimeUiIntent.references).toEqual([{ id: sheet.id, title: sheet.display.title }]);
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

  describe("the list's own controls", () => {
    it("count by what a document is over the whole library, from the server, and show only the types that are there", async () => {
      mocks.listSources.mockResolvedValue({ ...listing([guideline, sheet]), counts: counts({ all: 11, literature: 4, table: 2, document: 2, page: 1, note: 1, image: 1 }) });
      renderPage();
      const chips = await screen.findByRole("group", { name: "资料类型" });
      expect(within(chips).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部11", "文献与指南4", "数据表2", "文档2", "网页1", "笔记1", "图片1"]);
    });

    it("leaves the platform's own compiled files out of the documents and of their count, and follows pages until the list holds documents", async () => {
      const compiled = (id: string) => makeSource(id, { title: `编译页 ${id}`, kind: "wiki", origin: "wiki", typeShort: "知识页" });
      mocks.listSources.mockImplementation(async (_scope, options) => options?.cursor === "cursor-2"
        ? { items: [guideline], nextCursor: null, counts: counts({ all: 5, literature: 3, table: 2, wiki: 2 }) }
        : { items: [compiled("src_w1"), compiled("src_w2")], nextCursor: "cursor-2", counts: counts({ all: 5, literature: 3, table: 2, wiki: 2 }) });
      renderPage();
      expect(await screen.findByText(guideline.display.title)).toBeInTheDocument();
      expect(screen.queryByText("编译页 src_w1")).toBeNull();
      expect(mocks.listSources).toHaveBeenCalledWith({ kind: "all" }, { q: "", cursor: "cursor-2", limit: 50 });
      const chips = within(screen.getByRole("group", { name: "资料类型" }));
      // 5 documents were counted, 2 of them the platform's own: the type row says 3.
      expect(chips.getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部3", "文献与指南3", "数据表2"]);
    });

    it("is one row of controls above the list: the types, the search and the count, and the only toolbar there is", async () => {
      mocks.listSources.mockResolvedValue({ ...listing([guideline, sheet]), counts: counts({ all: 2, literature: 1, table: 1 }) });
      renderPage();
      await screen.findByText(guideline.display.title);
      const toolbars = document.querySelectorAll("[data-toolbar]");
      expect(toolbars).toHaveLength(1);
      expect(toolbars[0]).toContainElement(screen.getByRole("group", { name: "资料类型" }));
      expect(toolbars[0]).toContainElement(screen.getByRole("searchbox", { name: "搜索资料和内容" }));
      expect(toolbars[0]).toHaveTextContent("2 份");
      const list = screen.getByRole("list", { name: "资料" });
      expect(toolbars[0]!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
      await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith({ kind: "all" }, { kind: "table", q: "", limit: 50 }));
      await waitFor(() => expect(screen.queryByText(guideline.display.title)).not.toBeInTheDocument());
      expect(within(screen.getByRole("group", { name: "资料类型" })).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部2", "文献与指南1", "数据表1"]);
      await userEvent.click(within(screen.getByRole("group", { name: "资料类型" })).getByRole("button", { name: /全部/ }));
      expect(await screen.findByText(guideline.display.title)).toBeInTheDocument();
    });

    it("asks the server, after the researcher stops typing, and says when nothing matches", async () => {
      renderPage();
      await screen.findByText(guideline.display.title);
      mocks.listSources.mockResolvedValue(listing([]));
      await userEvent.type(screen.getByRole("searchbox", { name: "搜索资料和内容" }), "不存在");
      await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith({ kind: "all" }, { q: "不存在", limit: 50 }));
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
      // A bare 「加载更多」 is the shared 「显示更多」, which says how many are left.
      await userEvent.click(screen.getByRole("button", { name: "显示更多 · 还有 59 份" }));
      expect(await screen.findByText("第二页的资料")).toBeInTheDocument();
      expect(mocks.listSources).toHaveBeenLastCalledWith({ kind: "all" }, { q: "", cursor: "cursor-2", limit: 50 });
      expect(screen.getAllByText(guideline.display.title)).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /显示更多/ })).not.toBeInTheDocument();
    });
  });

  // 2026-10-28: the list and the document it opens, side by side where the page has room (the page's own width, not the window's).
  describe("beside the pane", () => {
    beforeEach(() => stubLayout(1200));

    it("shows the first document in the pane when none is chosen — without writing it into the address — and marks its row", async () => {
      renderPage();
      const heading = await screen.findByRole("heading", { level: 2, name: guideline.display.title });
      expect(document.querySelector("[data-knowledge-layout]")).toHaveAttribute("data-knowledge-layout", "split");
      expect(addressOf()).toBe("/app/files");
      expect(mocks.getSource).toHaveBeenCalledWith("src_guideline");
      expect(within(listRowOf(guideline.display.title)).getByRole("link", { name: guideline.display.title })).toHaveAttribute("aria-current", "true");
      expect(within(listRowOf(sheet.display.title)).getByRole("link", { name: sheet.display.title })).not.toHaveAttribute("aria-current");
      // The list is on the left and the document on the right: two regions of one page, which has one title and no tab list.
      const list = screen.getByRole("region", { name: "资料列表" });
      const pane = screen.getByRole("region", { name: "资料阅读" });
      expect(list.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(pane).toContainElement(heading);
      expect(list).toContainElement(screen.getByRole("heading", { level: 1, name: "知识库" }));
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.queryByRole("tablist")).toBeNull();
      expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(1);
      expect(list).toContainElement(document.querySelector("[data-toolbar]") as HTMLElement);
      // The pane has no room for the original and the key points side by side, so the document's two views are a switch in it.
      expect(await screen.findByRole("radiogroup", { name: "资料视图" })).toBeInTheDocument();
      // The list is 400 px wide, a column of its own.
      expect(list).toHaveStyle({ width: "400px" });
    });

    it("reads another document in the pane when its row is pressed, and does not read the list again", async () => {
      renderPage();
      await screen.findByRole("heading", { level: 2, name: guideline.display.title });
      expect(mocks.listSources).toHaveBeenCalledTimes(1);
      await userEvent.click(within(listRowOf(sheet.display.title)).getByRole("link", { name: sheet.display.title }));
      expect(await screen.findByRole("heading", { level: 2, name: sheet.display.title })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { level: 2, name: guideline.display.title })).not.toBeInTheDocument();
      expect(addressOf()).toBe("/app/files/src_sheet");
      expect(within(listRowOf(sheet.display.title)).getByRole("link", { name: sheet.display.title })).toHaveAttribute("aria-current", "true");
      // The same page, the same list: nothing was reloaded and nothing flashed.
      expect(mocks.listSources).toHaveBeenCalledTimes(1);
    });

    it("selects the document a deep link names, wherever it is in the list, with the list's own type and search kept", async () => {
      renderPage("/app/files/src_sheet?kind=table&q=%E7%96%B3");
      expect(await screen.findByRole("heading", { level: 2, name: sheet.display.title })).toBeInTheDocument();
      expect(mocks.getSource).toHaveBeenCalledWith("src_sheet");
      expect(mocks.getSource).not.toHaveBeenCalledWith("src_guideline");
      expect(screen.getByRole("searchbox", { name: "搜索资料和内容" })).toHaveValue("疳");
      expect(mocks.listSources).toHaveBeenCalledWith({ kind: "all" }, { kind: "table", q: "疳", limit: 50 });
    });

    it("says where the document takes effect in the pane and in its row alike, and a change made in the pane is in the row at once", async () => {
      mocks.setSourceProjects.mockResolvedValue({ libraryProjects: "all", appliesTo: "all" });
      renderPage();
      const heading = await screen.findByRole("heading", { level: 2, name: guideline.display.title });
      const pane = screen.getByRole("region", { name: "资料阅读" });
      const press = await within(pane).findByRole("button", { name: /生效项目：我的研究/ });
      await userEvent.click(press);
      const dialog = await screen.findByRole("dialog", { name: "生效项目" });
      await userEvent.click(within(dialog).getByRole("radio", { name: "所有项目" }));
      await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(mocks.setSourceProjects).toHaveBeenCalledWith("src_guideline", "all"));
      await waitFor(() => expect(within(listRowOf(guideline.display.title)).getByRole("button", { name: /生效项目：所有项目/ })).toBeInTheDocument());
      expect(heading).toBeInTheDocument();
    });

    it("changes the pane too when the row's own control changes where the open document takes effect", async () => {
      mocks.setSourceProjects.mockResolvedValue({ libraryProjects: "all", appliesTo: "all" });
      mocks.getSource.mockImplementation(async (id: string) => (id === "src_guideline" && mocks.setSourceProjects.mock.calls.length > 0
        ? { ...guideline, libraryProjects: "all", appliesTo: "all" } : [guideline, sheet].find((source) => source.id === id)!));
      renderPage();
      await screen.findByRole("heading", { level: 2, name: guideline.display.title });
      const pane = screen.getByRole("region", { name: "资料阅读" });
      await userEvent.click(within(listRowOf(guideline.display.title)).getByRole("button", { name: /生效项目：我的研究/ }));
      const dialog = await screen.findByRole("dialog", { name: "生效项目" });
      await userEvent.click(within(dialog).getByRole("radio", { name: "所有项目" }));
      await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(within(pane).getByRole("button", { name: /生效项目：所有项目/ })).toBeInTheDocument());
    });

    it("is, with no document at all, the recipe in the pane with 「添加」 there and not in the header: the page has one solid button", async () => {
      mocks.listSources.mockResolvedValue(listing([]));
      renderPage();
      const pane = await screen.findByRole("region", { name: "资料阅读" });
      const empty = await within(pane).findByText("把文献、指南、方案、数据表、网页或笔记放进来，对话里会读它们并标出处。");
      expect(within(empty.parentElement!).getAllByRole("button")).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "添加" })).toHaveLength(1);
      expect(within(screen.getByRole("heading", { level: 1, name: "知识库" }).closest("header")!).queryByRole("button", { name: "添加" })).not.toBeInTheDocument();
      expect(mocks.getSource).not.toHaveBeenCalled();
    });

    it("leaves the pane empty when a search finds nothing, and says so in the list", async () => {
      mocks.listSources.mockResolvedValue(listing([]));
      renderPage("/app/files?q=%E6%B2%A1%E6%9C%89");
      expect(await screen.findByText("没有找到相关资料")).toBeInTheDocument();
      expect(mocks.getSource).not.toHaveBeenCalled();
      expect(within(screen.getByRole("region", { name: "资料阅读" })).queryByRole("heading")).toBeNull();
      expect(within(screen.getByRole("heading", { level: 1, name: "知识库" }).closest("header")!).getByRole("button", { name: "添加" })).toBeInTheDocument();
    });

    it("goes back to the list as it was, with the next document in the pane, when the open one is deleted from it", async () => {
      renderPage("/app/files/src_guideline");
      await screen.findByRole("heading", { level: 2, name: guideline.display.title });
      mocks.listSources.mockResolvedValue(listing([sheet]));
      await userEvent.click(within(screen.getByRole("region", { name: "资料阅读" })).getByRole("button", { name: `“${guideline.display.title}”的操作` }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
      await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }));
      await waitFor(() => expect(mocks.removeSource).toHaveBeenCalledWith("src_guideline", 3));
      await waitFor(() => expect(addressOf()).toBe("/app/files"));
      expect(await screen.findByRole("heading", { level: 2, name: sheet.display.title })).toBeInTheDocument();
    });

    it("draws the project views with the projects on the left and the chosen project's pages on the right", async () => {
      context.features = { knowledgePages: true, geo: true, vcr: true };
      renderPage("/app/files?kind=wiki");
      const list = await screen.findByRole("region", { name: "资料列表" });
      await waitFor(() => expect(within(list).getByText("虚拟临床研究")).toBeInTheDocument());
      expect(within(list).getAllByRole("link").map((link) => link.textContent)).toEqual(expect.arrayContaining(["资料", "知识页", "图谱", "对话产出", "我的研究", "疳证 Meta 文献检索", "二甲双胍外部对照研究", "波立维"]));
      // The sidebar's project is the one shown when the address names none; its row is the chosen one, and the address is not written.
      expect(within(list).getByRole("link", { name: "我的研究" })).toHaveAttribute("aria-current", "true");
      const pane = screen.getByRole("region", { name: "资料阅读" });
      expect(await within(pane).findByRole("heading", { level: 2, name: "我的研究" })).toBeInTheDocument();
      expect(await within(pane).findByText("概念")).toBeInTheDocument();
      await waitFor(() => expect(mocks.getKnowledgeTree).toHaveBeenCalledWith("default"));
      expect(addressOf()).toBe("/app/files?kind=wiki");
      // Pressing another project is a link to the same view of it.
      await userEvent.click(within(list).getByRole("link", { name: "疳证 Meta 文献检索" }));
      await waitFor(() => expect(addressOf()).toBe("/app/files?scope=paper-1&kind=wiki"));
      await waitFor(() => expect(mocks.getKnowledgeTree).toHaveBeenCalledWith("paper-1"));
      expect(await within(pane).findByRole("heading", { level: 2, name: "疳证 Meta 文献检索" })).toBeInTheDocument();
      expect(selectSpy).not.toHaveBeenCalled();
    });
  });

  describe("where there is no room for a pane", () => {
    it("opens a document as a page of its own, with the way back to the list as it was left, and no list beside it", async () => {
      renderPage("/app/files/src_guideline?kind=literature");
      expect(await screen.findByRole("heading", { level: 1, name: guideline.display.title })).toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "资料" })).toBeNull();
      const back = screen.getByRole("link", { name: "知识库" });
      expect(back).toHaveAttribute("href", "/app/files?kind=literature");
      await userEvent.click(back);
      expect(addressOf()).toBe("/app/files?kind=literature");
      expect(JSON.parse(screen.getByTestId("location").getAttribute("data-state")!)).toMatchObject({ kbRestore: true });
      expect(await screen.findByRole("list", { name: "资料" })).toBeInTheDocument();
    });

    it("lists the projects first in the project views, and shows the chosen project's pages as a page with the way back to them", async () => {
      context.features = { knowledgePages: true };
      renderPage("/app/files?kind=wiki");
      expect(await screen.findByRole("link", { name: "疳证 Meta 文献检索" })).toHaveAttribute("href", "/app/files?scope=paper-1&kind=wiki");
      expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
      cleanup();
      renderPage("/app/files?scope=paper-1&kind=wiki");
      expect(await screen.findByRole("heading", { level: 2, name: "疳证 Meta 文献检索" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "项目" })).toHaveAttribute("href", "/app/files?kind=wiki");
    });
  });

  describe("「添加」", () => {
    it("has four ways in: a file, a web link, a note and — where a drive is mounted — the drive", async () => {
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      await waitFor(() => expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["上传文件", "添加网页链接", "新建笔记", "从网盘导入"]));
    });

    // A menu entry that always ends in 「请联系管理员」 is a dead end: it is shown only where the drive's own status for this account
    // says there is something to open, or that it cannot be reached just now (the panel says so and retries).
    it.each([["unconfigured"], ["storage_missing"], ["permission_denied"]])("leaves the drive out of the menu when its status is %s", async (state) => {
      mocks.getOpenListStatus.mockResolvedValue({ state });
      renderPage();
      await waitFor(() => expect(mocks.getOpenListStatus).toHaveBeenCalled());
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["上传文件", "添加网页链接", "新建笔记"]);
    });

    it("keeps the drive in the menu while it is unreachable, and leaves it out until its status is known", async () => {
      let answer!: (value: { state: string }) => void;
      mocks.getOpenListStatus.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["上传文件", "添加网页链接", "新建笔记"]);
      await userEvent.keyboard("{Escape}");
      await act(async () => { answer({ state: "unavailable" }); });
      await userEvent.click(screen.getByRole("button", { name: "添加" }));
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["上传文件", "添加网页链接", "新建笔记", "从网盘导入"]);
    });

    it("does not read the drive from the deployment's feature list: the account's own status decides", async () => {
      context.features = { openList: false };
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      await waitFor(() => expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toContain("从网盘导入"));
    });

    it("uploads into the project the person picks in the dialog, whatever each file is, refuses none by its name, and reads what it uploaded", async () => {
      // 2026-10-13: a recording is kept as an original like any other file; until then it was refused here by its name.
      const files = [new File(["x"], "a.pdf"), new File(["x"], "b.wav")];
      mocks.pickFiles.mockResolvedValue(files);
      mocks.uploadFilesToWorkspace.mockImplementation(async (files: File[]) => files.map(file => `knowledge-base/${file.name}`));
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "上传文件" }));
      await userEvent.click(screen.getByRole("combobox", { name: "保存位置" }));
      await userEvent.click(screen.getByRole("button", { name: "疳证 Meta 文献检索" }));
      expect(within(screen.getByRole("dialog", { name: "上传资料" })).getByText(/先保存到所选项目；之后可以在资料的“生效项目”里，让其他项目也用它。/)).toBeInTheDocument();
      await userEvent.upload(screen.getByLabelText(/选择资料文件/, { selector: "input" }), files);
      await waitFor(() => expect(mocks.uploadFilesToWorkspace).toHaveBeenCalledTimes(2));
      files.forEach(file => expect(mocks.uploadFilesToWorkspace).toHaveBeenCalledWith([file], "knowledge-base", "base", "paper-1", expect.any(Function)));
      expect(mocks.uploadPersonalFile).not.toHaveBeenCalled();
      expect(mocks.pickFiles).not.toHaveBeenCalled();
      expect(mocks.toastError).not.toHaveBeenCalled();
      expect(mocks.toastSuccess).toHaveBeenCalledWith("已上传 2 个文件");
      // What was uploaded is read again, in the list that holds every document.
      await waitFor(() => expect(mocks.listSources.mock.calls.length).toBeGreaterThan(1));
    });

    it("opens the upload dialog empty each time, and says what happens to a file whose name is already there", async () => {
      const file = new File(["x"], "guideline.pdf");
      renderPage();
      const openUpload = async () => {
        await userEvent.click(await screen.findByRole("button", { name: "添加" }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "上传文件" }));
        return screen.findByRole("dialog", { name: "上传资料" });
      };
      let dialog = await openUpload();
      expect(dialog).toHaveTextContent("同名文件会成为这份资料的新版本，旧版本仍可查看；内容相同的文件不会重复添加。");
      expect(dialog).not.toHaveTextContent("服务器");
      await userEvent.upload(within(dialog).getByLabelText(/选择资料文件/, { selector: "input" }), file);
      await waitFor(() => expect(mocks.uploadPersonalFile).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(dialog).toHaveTextContent("guideline.pdf"));
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "上传资料" })).not.toBeInTheDocument());
      dialog = await openUpload();
      expect(dialog).not.toHaveTextContent("guideline.pdf");
    });

    it("adds a web page to the account's own materials by its address, says in the dialog, in a sentence, why a page cannot be added, and opens what was added", async () => {
      stubLayout(1200);
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "添加网页链接" }));
      const dialog = await screen.findByRole("dialog", { name: "添加网页链接" });
      expect(within(dialog).getByRole("button", { name: "添加" })).toBeDisabled();
      expect(within(dialog).getByRole("combobox", { name: "保存位置" })).toHaveValue("我的资料（所有项目可用）");
      mocks.addSourceLink.mockRejectedValueOnce(new WebApiError("blocked", { status: 403, code: "source_link_blocked" }));
      await userEvent.type(within(dialog).getByLabelText("网址"), "https://www.nmpa.gov.cn/notice");
      await userEvent.click(within(dialog).getByRole("button", { name: "添加" }));
      expect(await within(dialog).findByText(knownErrorCodeMessage("source_link_blocked")!)).toBeInTheDocument();
      expect(mocks.addSourceLink).toHaveBeenCalledWith(null, "https://www.nmpa.gov.cn/notice");
      mocks.listSources.mockResolvedValue(listing([page, guideline]));
      await userEvent.click(within(dialog).getByRole("button", { name: "添加" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加网页链接" })).not.toBeInTheDocument());
      expect(mocks.toastSuccess).toHaveBeenCalledWith("已添加，正在读取");
      await waitFor(() => expect(addressOf()).toBe("/app/files/src_page"));
    });

    it("writes a note into the account's own materials, and opens it on its own page", async () => {
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "新建笔记" }));
      const dialog = await screen.findByRole("dialog", { name: "新建笔记" });
      expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();
      await userEvent.type(within(dialog).getByLabelText("标题"), "10月3日组会记录");
      await userEvent.type(within(dialog).getByLabelText("正文"), "确定分组。");
      await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(mocks.addSourceNote).toHaveBeenCalledWith(null, { title: "10月3日组会记录", body: "确定分组。" }));
      // The note opens on its own page, where its editor is; the list it was written from is the way back.
      await waitFor(() => expect(addressOf()).toBe("/app/files/src_note"));
    });

    it("opens the drive from the menu, and browses it for the project the person picks", async () => {
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "添加" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "从网盘导入" }));
      const drawer = await screen.findByRole("dialog", { name: "从网盘导入" });
      await userEvent.click(within(drawer).getByRole("combobox", { name: "保存位置" }));
      await userEvent.click(screen.getByRole("button", { name: "我的研究" }));
      await userEvent.click(within(drawer).getByRole("button", { name: "浏览" }));
      await waitFor(() => expect(mocks.browseOpenList).toHaveBeenCalledWith("default", "/"));
      expect(mocks.listSourceFolders).toHaveBeenCalledWith("default");
    });
  });

  // N-16: the box also searches the documents' own text, and the matches are shown under their documents.
  describe("matches inside a document's text", () => {
    const withPassages = (items: SourceRecord[], passages: Record<string, unknown[]>) => ({ ...listing(items), passages });

    it("are shown under the row of their document: the page, one line around the match with what was typed marked, and a link that opens the document at that page", async () => {
      mocks.listSources.mockImplementation(async (_scope, options) => options?.q
        ? withPassages([guideline], { src_guideline: [{ page: 2, snippet: "…达比加群酯为另一选择，剂量 150 mg…", start: 120, end: 150 }, { page: null, snippet: "正文里没有页码的一处达比加群", start: 900, end: 940 }] })
        : listing([guideline, sheet]));
      renderPage();
      await screen.findByText(guideline.display.title);
      expect(screen.queryByRole("list", { name: "正文里的匹配" })).not.toBeInTheDocument();
      await userEvent.type(screen.getByRole("searchbox", { name: "搜索资料和内容" }), "达比加群");
      const matches = await screen.findByRole("list", { name: "正文里的匹配" });
      const row = matches.closest("li[class*='relative']") as HTMLElement;
      expect(within(row).getByRole("link", { name: guideline.display.title })).toBeInTheDocument();
      const [first, second] = within(matches).getAllByRole("link");
      expect(first).toHaveTextContent("第 2 页…达比加群酯为另一选择，剂量 150 mg…");
      expect(second).toHaveTextContent("正文里没有页码的一处达比加群");
      expect(second).toHaveTextContent(/^正文/);
      // What was typed is marked where it is, and nothing else changes.
      expect([...first.querySelectorAll("span.bg-highlight")].map((mark) => mark.textContent)).toEqual(["达比加群"]);
      expect(first.textContent).toBe("第 2 页…达比加群酯为另一选择，剂量 150 mg…");
      // Opened at the page, from the list it was found in.
      expect(first).toHaveAttribute("href", "/app/files/src_guideline?q=%E8%BE%BE%E6%AF%94%E5%8A%A0%E7%BE%A4&tab=original&page=2");
      expect(second).toHaveAttribute("href", "/app/files/src_guideline?q=%E8%BE%BE%E6%AF%94%E5%8A%A0%E7%BE%A4");
      await userEvent.click(first);
      expect(addressOf()).toBe("/app/files/src_guideline?q=%E8%BE%BE%E6%AF%94%E5%8A%A0%E7%BE%A4&tab=original&page=2");
    });

    it("are for the rows that have them, and a row the box matched by its name has none", async () => {
      mocks.listSources.mockResolvedValue(withPassages([guideline, sheet], { src_sheet: [{ page: null, snippet: "…75 项研究…", start: 1, end: 5 }] }));
      renderPage("/app/files?q=75");
      await screen.findByText(sheet.display.title);
      expect(within(rowOf(guideline.display.title)).queryByRole("list", { name: "正文里的匹配" })).not.toBeInTheDocument();
      expect(within(rowOf(sheet.display.title)).getByRole("list", { name: "正文里的匹配" })).toBeInTheDocument();
      // The two are in separate rows: the first row's link is still the document.
      expect(within(rowOf(guideline.display.title)).getByRole("link", { name: guideline.display.title })).toBeInTheDocument();
    });

    it("follow the list as it is paged, and go with the search that found them", async () => {
      const second = makeSource("src_second", { title: "第二页的资料" });
      mocks.listSources.mockImplementation(async (_scope, options) => options?.cursor
        ? withPassages([guideline, second], { src_second: [{ page: 7, snippet: "第二页的匹配", start: 1, end: 5 }] })
        : { ...withPassages([guideline], { src_guideline: [{ page: 1, snippet: "第一页的匹配", start: 1, end: 5 }] }), nextCursor: "cursor-2" });
      renderPage("/app/files?q=%E5%8C%B9%E9%85%8D");
      // What was typed is marked inside the line, so the line is read as text, not as one element's.
      const said = () => document.body.textContent ?? "";
      await waitFor(() => expect(said()).toContain("第一页的匹配"));
      await userEvent.click(screen.getByRole("button", { name: /显示更多/ }));
      await waitFor(() => expect(said()).toContain("第二页的匹配"));
      expect(said()).toContain("第一页的匹配");
      // A new search starts again from what it found.
      mocks.listSources.mockResolvedValue(listing([guideline]));
      await userEvent.clear(screen.getByRole("searchbox", { name: "搜索资料和内容" }));
      await waitFor(() => expect(said()).not.toContain("第一页的匹配"));
      expect(said()).not.toContain("第二页的匹配");
    });

    it("keep the list's own search when the server has no text to offer: no list, no empty heading", async () => {
      mocks.listSources.mockResolvedValue(listing([guideline]));
      renderPage("/app/files?q=%E5%85%B1%E8%AF%86");
      await screen.findByText(guideline.display.title);
      expect(screen.queryByRole("list", { name: "正文里的匹配" })).not.toBeInTheDocument();
      expect(screen.getByRole("searchbox", { name: "搜索资料和内容" })).toHaveValue("共识");
    });
  });

  // E-8 and E-19 (design reference §13.1): the list is an address, and a document is a page of its own.
  describe("the list's address", () => {
    it("reads the type and the search from the address it is opened at", async () => {
      renderPage("/app/files?kind=table&q=%E7%96%B3");
      expect(screen.getByRole("searchbox", { name: "搜索资料和内容" })).toHaveValue("疳");
      await waitFor(() => expect(mocks.listSources).toHaveBeenCalledWith({ kind: "all" }, { kind: "table", q: "疳", limit: 50 }));
      expect(await screen.findByRole("button", { name: /数据表/ })).toHaveAttribute("aria-pressed", "true");
    });

    it("reads an address from before the page listed every document — a project, or the shared documents — as the documents", async () => {
      renderPage("/app/files?scope=shared&kind=nonsense");
      await waitFor(() => expect(mocks.listSources).toHaveBeenCalledWith({ kind: "all" }, { q: "", limit: 50 }));
      cleanup();
      mocks.listSources.mockClear();
      renderPage("/app/files?scope=paper-1&kind=table");
      await waitFor(() => expect(mocks.listSources).toHaveBeenCalledWith({ kind: "all" }, { kind: "table", q: "", limit: 50 }));
    });

    it("writes the type and the search into the address as they are chosen, and nothing for the defaults", async () => {
      renderPage();
      const chips = await screen.findByRole("group", { name: "资料类型" });
      await userEvent.click(within(chips).getByRole("button", { name: /数据表/ }));
      await waitFor(() => expect(addressOf()).toBe("/app/files?kind=table"));
      await userEvent.type(screen.getByRole("searchbox", { name: "搜索资料和内容" }), "共识");
      await waitFor(() => expect(addressOf()).toBe("/app/files?kind=table&q=%E5%85%B1%E8%AF%86"));
      await userEvent.click(within(screen.getByRole("group", { name: "资料类型" })).getByRole("button", { name: /全部/ }));
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
      render(<MemoryRouter initialEntries={["/app/files?q=%E5%85%B1%E8%AF%86"]}><Pages /><Mover /></MemoryRouter>);
      expect(await screen.findByRole("searchbox", { name: "搜索资料和内容" })).toHaveValue("共识");
      await userEvent.click(screen.getByRole("button", { name: "改地址" }));
      await waitFor(() => expect(screen.getByRole("searchbox", { name: "搜索资料和内容" })).toHaveValue("十"));
      await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith({ kind: "all" }, { q: "十", limit: 50 }));
    });

    it("makes each row a link to the document's own address, carrying the list it came from", async () => {
      renderPage("/app/files?kind=literature");
      const link = await screen.findByRole("link", { name: guideline.display.title });
      expect(link).toHaveAttribute("href", "/app/files/src_guideline?kind=literature");
      await userEvent.click(link);
      expect(addressOf()).toBe("/app/files/src_guideline?kind=literature");
      // The drawer is gone: nothing a row opens is a dialog.
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("sends a document named by ?source= to its own address, with the list's state kept for the way back", async () => {
      renderPage("/app/files?kind=literature&source=src_guideline");
      await waitFor(() => expect(addressOf()).toBe("/app/files/src_guideline?kind=literature"));
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

      it("brings the list back to the same place, with the same documents, when a document is opened in a window with no pane and closed again — the page stays drawn", async () => {
        mocks.listSources.mockResolvedValue(listing(many(1, 30), { counts: { all: 30, literature: 30 } }));
        mocks.getSource.mockResolvedValue(makeSource("src_3", { title: "资料 3" }));
        const { container } = renderPage("/app/files?kind=literature");
        const link = await screen.findByRole("link", { name: "资料 3" });
        scrollerOf(container).scrollTop = 321;
        await userEvent.click(link);
        expect(await screen.findByRole("heading", { level: 1, name: "资料 3" })).toBeInTheDocument();
        expect(screen.queryByRole("list", { name: "资料" })).toBeNull();
        await userEvent.click(screen.getByRole("link", { name: "知识库" }));
        await screen.findByRole("list", { name: "资料" });
        expect(scrollerOf(container).scrollTop).toBe(321);
        // Said once: the next time the list is drawn again it is where it is then, not where it was.
        expect(screen.getByText("资料 30")).toBeInTheDocument();
        // The page was not drawn again: the list was read once.
        expect(mocks.listSources).toHaveBeenCalledTimes(1);
      });

      it("brings the list back as it was left — the same documents loaded, the same scroll — when the back button returns to it", async () => {
        window.sessionStorage.setItem(POSITION("kind=literature"), JSON.stringify({ scroll: 480, count: 120 }));
        mocks.listSources.mockImplementation(async (_scope, options) => options?.cursor
          ? listing(many(101, 120), { counts: { all: 120, literature: 120 } })
          : listing(many(1, 100), { nextCursor: "c2", counts: { all: 120, literature: 120 } }));
        const { container } = renderPage("/app/files?kind=literature");
        await screen.findByText("资料 120");
        expect(mocks.listSources).toHaveBeenNthCalledWith(1, { kind: "all" }, { kind: "literature", q: "", limit: 100 });
        expect(mocks.listSources).toHaveBeenNthCalledWith(2, { kind: "all" }, { kind: "literature", q: "", cursor: "c2", limit: 50 });
        expect(scrollerOf(container).scrollTop).toBe(480);
        // Once: a later reload of the same list does not jump back.
        scrollerOf(container).scrollTop = 0;
        await userEvent.type(screen.getByRole("searchbox", { name: "搜索资料和内容" }), "资");
        // A hundred and twenty rows are drawn again for the key and again for the address, which takes this test longer than the default second.
        await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ q: "资" })), { timeout: 8_000 });
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
        expect(mocks.listSources).toHaveBeenCalledWith({ kind: "all" }, { q: "", limit: 50 });
      });
    });
  });

  describe("dropping files onto the page", () => {
    const transfer = (files: File[] = []) => ({ dataTransfer: { types: ["Files"], files } });

    it("offers it, and takes the files into the account's own materials, which every project reads", async () => {
      const { container } = renderPage();
      await screen.findByText(guideline.display.title);
      const zone = container.firstElementChild as HTMLElement;
      const file = new File(["x"], "dropped.pdf");
      fireEvent.dragEnter(zone, transfer());
      expect(screen.getByText("松开即可上传")).toBeInTheDocument();
      fireEvent.drop(zone, transfer([file]));
      await waitFor(() => expect(mocks.uploadPersonalFile).toHaveBeenCalledWith(file, expect.any(Function)));
      expect(mocks.uploadFilesToWorkspace).not.toHaveBeenCalled();
    });

    it("takes them into the project in view where the page is one project's pages", async () => {
      mocks.uploadFilesToWorkspace.mockResolvedValue(["knowledge-base/dropped.pdf"]);
      const { container } = renderPage("/app/files?scope=default&kind=wiki");
      await screen.findByRole("heading", { level: 2, name: "我的研究" });
      const file = new File(["x"], "dropped.pdf");
      fireEvent.drop(container.firstElementChild as HTMLElement, transfer([file]));
      await waitFor(() => expect(mocks.uploadFilesToWorkspace).toHaveBeenCalledWith([file], "knowledge-base", "base", "default", expect.any(Function)));
    });

    it.each(["resolve", "reject", "unmount"])("stops old-account upload callbacks after %s", async outcome => {
      let finish!: () => void;
      mocks.uploadPersonalFile.mockImplementationOnce(() => new Promise((yes, no) => { finish = () => outcome === "reject" ? no(new Error("old private failure")) : yes({ source: { ...guideline, personal: true } }); }));
      const { container, unmount } = renderPage();
      await screen.findByText(guideline.display.title);
      fireEvent.drop(container.firstElementChild as HTMLElement, transfer([new File(["a"], "a.pdf"), new File(["b"], "b.pdf")]));
      await waitFor(() => expect(mocks.uploadPersonalFile).toHaveBeenCalledTimes(1));
      const { WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT } = await import("@/lib/sessionLifecycle");
      if (outcome === "unmount") unmount();
      else { window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT)); window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)); }
      await act(async () => { finish(); });
      expect(mocks.uploadPersonalFile).toHaveBeenCalledTimes(1);
      expect(mocks.toastSuccess).not.toHaveBeenCalled(); expect(mocks.toastError).not.toHaveBeenCalled();
    });

    it("continues same-session uploads after an individual file refusal", async () => {
      mocks.uploadPersonalFile.mockRejectedValueOnce(new WebApiError("refused", { status: 400 })).mockResolvedValueOnce({ source: { ...guideline, personal: true } });
      const { container } = renderPage(); await screen.findByText(guideline.display.title);
      fireEvent.drop(container.firstElementChild as HTMLElement, transfer([new File(["a"], "a.pdf"), new File(["b"], "b.pdf")]));
      await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("已上传 1 个文件"));
      expect(mocks.uploadPersonalFile).toHaveBeenCalledTimes(2);
    });

    it("takes source code, a notebook, a mail, an archive and a recording dropped on it, and turns none of them away", async () => {
      const { container } = renderPage();
      await screen.findByText(guideline.display.title);
      const files = ["offlineMerge.ts", "stocktake-variance.ipynb", "复盘.eml", "资料.zip", "周会录音.mp3"].map((name) => new File(["x"], name));
      fireEvent.drop(container.firstElementChild as HTMLElement, transfer(files));
      await waitFor(() => expect(mocks.uploadPersonalFile).toHaveBeenCalledTimes(files.length));
      files.forEach(file => expect(mocks.uploadPersonalFile).toHaveBeenCalledWith(file, expect.any(Function)));
      expect(mocks.toastError).not.toHaveBeenCalled();
      expect(mocks.toastSuccess).toHaveBeenCalledWith("已上传 5 个文件");
    });
  });

  it("says in the row that a recording is kept as the original it was, and explains why when asked", async () => {
    const recording = makeSource("src_recording", { title: "周会录音.mp3", gist: null, docType: "other", typeShort: "音频", kind: "document", format: "mp3", pages: null, size: 3_000_000 },
      { status: "complete", paths: ["knowledge-base/周会录音.mp3"], original: { generation: 1, code: "source_original_media", at: arrived } }, { readable: false });
    mocks.listSources.mockResolvedValue(listing([recording]));
    renderPage();
    await screen.findByText("周会录音.mp3");
    const row = rowOf("周会录音.mp3");
    expect(within(row).getByText("只保存原件")).toBeInTheDocument();
    expect(within(row).queryByText("没能读取")).toBeNull();
    expect(within(row).queryByRole("button", { name: /重新读取/ })).toBeNull();
  });

  // A project's part of the knowledge base: what the platform compiled from its documents, the picture of it, and what its conversations
  // delivered. The column lists the projects; the pane is the chosen one's.
  describe("a project's pages", () => {
    beforeEach(() => { context.features = { knowledgePages: true }; });

    it("browses the compiled files as a tree by type, each opening in the reader, and says where the tree cannot be read", async () => {
      renderPage("/app/files?scope=default&kind=wiki");
      expect(await screen.findByText("概念")).toBeInTheDocument();
      const opener = (await screen.findAllByRole("link", { name: "盘点差异率" }))[0]!;
      expect(opener).toHaveAttribute("href", expect.stringMatching(/^\/app\/files\/src_[a-f0-9]{32}\?scope=default&kind=wiki$/));
      expect(screen.getAllByText("来源已更改").length).toBeGreaterThanOrEqual(3);
      // The toolbar over the tree is the search and the count of pages — no types, which belong to documents.
      expect(screen.queryByRole("group", { name: "资料类型" })).toBeNull();
      expect(screen.getByRole("searchbox", { name: "搜索资料和内容" })).toBeInTheDocument();
      expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(1);
      expect(screen.queryByRole("tablist")).toBeNull();
      cleanup();
      mocks.getKnowledgeTree.mockRejectedValue(new Error("down"));
      renderPage("/app/files?scope=default&kind=wiki");
      expect(await screen.findByText(/知识页的目录暂时没能读取/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    });

    it("says nothing of the compile while it is no trouble: the dot is for a fault, and 重新整理 is in the project's menu", async () => {
      mocks.requestKnowledgeCompile.mockResolvedValue({ ...statusCompiled, state: "compiling", stage: { tree: "wiki", step: "wiki", task: null, status: "running", startedAt: "2026-10-13T12:00:00Z" } });
      renderPage("/app/files?scope=default&kind=wiki");
      await screen.findByText("概念");
      await waitFor(() => expect(mocks.getKnowledgeStatus).toHaveBeenCalledWith("default"));
      expect(document.querySelector("[data-knowledge-status]")).toBeNull();
      expect(screen.queryByText(/已整理 · 上次整理于/u)).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "更多" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "重新整理知识页" }));
      await waitFor(() => expect(mocks.requestKnowledgeCompile).toHaveBeenCalledWith("default"));
      await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
      // The round that was asked for is said where the person is looking: a strip over the pane, not a line in the list.
      const strip = await screen.findByText("正在整理知识页");
      expect(strip.closest("[data-activity='strip']")).not.toBeNull();
      expect(strip.closest("[data-activity='strip']")).toHaveTextContent("已有 13 页，53 个实体");
    });

    it("keeps the project's own actions in its menu: 重新整理知识页, 导出到 Obsidian and 在记忆总览中查看, and 「添加」 stays the one solid button", async () => {
      renderPage("/app/files?scope=default&kind=wiki");
      await screen.findByText("概念");
      await userEvent.click(screen.getByRole("button", { name: "更多" }));
      expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["在记忆总览中查看", "重新整理知识页", "导出到 Obsidian"]);
      await userEvent.click(screen.getByRole("menuitem", { name: "导出到 Obsidian" }));
      expect(mocks.downloadKnowledgeVault).toHaveBeenCalledWith("default");
      expect(mocks.toastError).not.toHaveBeenCalled();
    });

    it("names the size limit when the export is refused", async () => {
      mocks.downloadKnowledgeVault.mockRejectedValue(new WebApiError("too big", { status: 413, code: "archive_too_large" }));
      renderPage("/app/files?scope=default&kind=wiki");
      await screen.findByText("概念");
      await userEvent.click(screen.getByRole("button", { name: "更多" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "导出到 Obsidian" }));
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("没能导出：资料太多，一次导不完。请先删掉一部分再导出。"));
    });

    it("a failed round offers 重新整理 from the dot beside the project's name", async () => {
      mocks.getKnowledgeStatus.mockResolvedValue({ ...statusCompiled, state: "failed" });
      mocks.requestKnowledgeCompile.mockResolvedValue({ ...statusCompiled, state: "compiling", stage: { tree: "wiki", step: "wiki", task: null, status: "running", startedAt: "2026-10-13T12:00:00Z" } });
      renderPage("/app/files?scope=default&kind=wiki");
      const dot = await screen.findByRole("button", { name: /上次整理没有完成/u });
      // The row's 28 px icon button at the interface's type size, not a hand-drawn circle of its own: one look for one job.
      expect(dot.closest("header")).toContainElement(screen.getByRole("heading", { level: 2, name: "我的研究" }));
      expect(dot).toHaveClass("h-sm", "w-7", "rounded", "text-ui");
      expect(dot).not.toHaveClass("rounded-full");
      await userEvent.click(dot);
      expect(await screen.findByText(/上次整理没有完成/u, { selector: "[role=menu] *" })).toBeInTheDocument();
      await userEvent.click(await screen.findByRole("menuitem", { name: "重新整理" }));
      await waitFor(() => expect(mocks.requestKnowledgeCompile).toHaveBeenCalledWith("default"));
    });

    it("tells a project short of documents what to do — what it uses, what it gives, the number it lacks and 添加资料 — and not under the header", async () => {
      mocks.getKnowledgeStatus.mockResolvedValue({ ...statusCompiled, state: "below_threshold", readable: 1, minSources: 3, pages: 0 });
      mocks.getKnowledgeTree.mockResolvedValue({ pages: [], counts: { wiki: 0, kg: 0 } });
      renderPage("/app/files?scope=default&kind=wiki");
      expect(await screen.findByText("还没有知识页")).toBeInTheDocument();
      const recipe = document.querySelector("[data-step-state='empty']")!;
      expect(recipe).toHaveTextContent("用 这个项目的 1 份资料（还差 2 份）");
      expect(recipe).toHaveTextContent("得到 按类整理好的页面");
      // The sentence that used to stand under the header is gone, and no dot is drawn for a project that merely has too few documents.
      expect(screen.queryByText(/资料还不够：再加 2 份就会开始整理/u)).toBeNull();
      expect(document.querySelector("[data-knowledge-status]")).toBeNull();
      // 添加资料 opens the upload form aimed at this project: that is where the pages are short of documents.
      await userEvent.click(within(recipe as HTMLElement).getByRole("button", { name: "添加资料" }));
      const upload = await screen.findByRole("dialog", { name: "上传资料" });
      expect(within(upload).getByRole("combobox", { name: "保存位置" })).toHaveValue("我的研究");
      // 「这个项目的 1 份资料」 is the way to the documents.
      await userEvent.keyboard("{Escape}");
      await userEvent.click(within(recipe as HTMLElement).getByRole("button", { name: /^这个项目的 1 份资料/ }));
      await waitFor(() => expect(addressOf()).toBe("/app/files"));
    });

    it("offers no 知识页 or 图谱, no dot and no 重新整理 where the deployment compiles no pages", async () => {
      context.features = { openList: true };
      renderPage("/app/files?scope=default&view=outputs");
      await screen.findByRole("heading", { level: 2, name: "我的研究" });
      expect(document.querySelector("[data-knowledge-status]")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "更多" }));
      expect(screen.queryByRole("menuitem", { name: "重新整理知识页" })).toBeNull();
    });

    it("draws what the project's documents are made of, folded at the head of the pages, and only where three documents stand behind a table", async () => {
      const composition = { total: 5, dated: 4, keyworded: 3, years: [{ year: 2021, count: 3 }, { year: 2019, count: 1 }], keywords: [{ keyword: "房颤", count: 3 }, { keyword: "华法林", count: 1 }] };
      mocks.getSourceComposition.mockResolvedValue(composition);
      renderPage("/app/files?scope=default&kind=wiki");
      const fold = await screen.findByText("资料组成");
      expect(fold.closest("details")).not.toHaveAttribute("open");
      expect(mocks.getSourceComposition).toHaveBeenCalledWith("default");
      // Under the one row of controls and over the tree.
      expect(screen.getByRole("searchbox", { name: "搜索资料和内容" }).compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await userEvent.click(fold);
      const years = screen.getByRole("table", { name: "按发表年份的资料数" });
      expect(within(years).getAllByRole("row").map((row) => row.textContent)).toEqual(["发表年份数量份数", "20213", "20191"]);
      expect(within(screen.getByRole("table", { name: "按关键词的资料数" })).getAllByRole("row").map((row) => row.textContent)).toEqual(["关键词数量份数", "房颤3", "华法林1"]);
      cleanup();
      mocks.getSourceComposition.mockResolvedValue({ ...composition, total: 2, dated: 2, keyworded: 2 });
      renderPage("/app/files?scope=default&kind=wiki");
      await screen.findByText("概念");
      expect(screen.queryByText("资料组成")).not.toBeInTheDocument();
      cleanup();
      // A read that fails leaves the page as it was; the documents and the delivered files have none.
      mocks.getSourceComposition.mockRejectedValue(new WebApiError("down", { status: 503 }));
      renderPage("/app/files?scope=default&kind=wiki");
      await screen.findByText("概念");
      expect(screen.queryByText("资料组成")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      cleanup();
      mocks.getSourceComposition.mockReset();
      mocks.getSourceComposition.mockResolvedValue(composition);
      renderPage("/app/files");
      await screen.findByRole("list", { name: "资料" });
      expect(mocks.getSourceComposition).not.toHaveBeenCalled();
      expect(screen.queryByText("资料组成")).not.toBeInTheDocument();
    });
  });

  describe("a project's graph", () => {
    beforeEach(() => { context.features = { knowledgePages: true }; });

    it("draws the graph in the pane, whose kind of graph is the first chip group of the pane's one toolbar, and keeps that in the address", async () => {
      renderPage("/app/files?scope=default&kind=wiki&view=graph");
      await waitFor(() => expect(mocks.getKnowledgeGraph).toHaveBeenCalledWith("default", "wiki"));
      const toolbar = document.querySelector("[data-toolbar]")!;
      expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(1);
      expect(toolbar).toContainElement(screen.getByRole("group", { name: "图谱的类型" }));
      expect(screen.queryByRole("tablist")).toBeNull();
      await userEvent.click(await screen.findByRole("button", { name: "实体和关系" }));
      await waitFor(() => expect(addressOf()).toBe("/app/files?scope=default&kind=wiki&view=graph&graph=kg"));
      await waitFor(() => expect(mocks.getKnowledgeGraph).toHaveBeenCalledWith("default", "kg"));
      // The graph is also a list, and a mark of it opens its file in the reader.
      const row = await screen.findByRole("link", { name: "2014 年《柳叶刀》新型口服抗凝药荟萃分析" });
      expect(row).toHaveAttribute("href", "/app/files/src_c52267a68a26fb6c418a9e7a990cc89a?scope=default&kind=wiki&view=graph&graph=kg");
    });

    it("draws the graph as the picture first and the same marks as a list under it, both after the toolbar", async () => {
      const { container } = renderPage("/app/files?scope=default&kind=wiki&view=graph");
      const list = await screen.findByRole("list", { name: "页面" });
      const { toolbars } = compositionFacts(container);
      const picture = container.querySelector("[data-chart]")!;
      expect(precedes(toolbars[0]!, picture)).toBe(true);
      expect(precedes(picture, list)).toBe(true);
      // The kind of graph is the toolbar's first chip group, in the one row.
      expect(toolbars[0]!.querySelector("[role=group]")).toHaveAttribute("aria-label", "图谱的类型");
    });
  });

  // 2026-10-12 (knowledge base P0, G3): the files the project's conversations delivered, an index of the run ledger — a link to each
  // file where its run left it, and nothing copied into the library. A view of its own since the documents are the account's.
  describe("对话产出", () => {
    const outputs = [
      { runId: "run_2", title: "房颤抗凝综述", path: "deliverables/clinical-evidence-synthesis/clinical-evidence-report.md", at: `${new Date().getFullYear()}-03-06T08:00:00.000Z` },
      { runId: "run_1", title: null, path: "deliverables/deep-research/report.md", at: "2020-10-10T08:00:00.000Z" },
    ];

    it("lists the files, newest first, each a link to its file in the run that left it, for the project in view", async () => {
      mocks.listProjectOutputs.mockResolvedValue(outputs);
      renderPage("/app/files?scope=default&view=outputs");
      const list = await screen.findByRole("list", { name: "对话产出" });
      expect(mocks.listProjectOutputs).toHaveBeenCalledWith("default");
      const rows = within(list).getAllByRole("listitem");
      expect(rows).toHaveLength(2);
      // The conversation names the line and the file is under it; a conversation the ledger has no name for is named by its file.
      expect(within(rows[0]).getByRole("link", { name: "房颤抗凝综述" })).toHaveAttribute("href", "/app/runs/run_2/files/deliverables/clinical-evidence-synthesis/clinical-evidence-report.md");
      expect(rows[0].textContent).toContain("证据分析报告");
      expect(within(rows[1]).getByRole("link", { name: "report.md" })).toHaveAttribute("href", "/app/runs/run_1/files/deliverables/deep-research/report.md");
      expect(rows[1].textContent).toContain("2020-10-10");
      expect(list.textContent).not.toMatch(/run_|rv_|\.evimed|已交付/);
      // The documents are not under it, and 「添加」 is still the one solid button.
      expect(screen.queryByRole("list", { name: "资料" })).not.toBeInTheDocument();
      expect(mocks.listSources).not.toHaveBeenCalled();
    });

    it("is reached from the documents by its link and shows the sidebar's project when the address names none", async () => {
      mocks.listProjectOutputs.mockResolvedValue(outputs);
      renderPage();
      await userEvent.click(await screen.findByRole("link", { name: "对话产出" }));
      await waitFor(() => expect(addressOf()).toBe("/app/files?view=outputs"));
      // Narrow, the projects come first; the one the sidebar is in is the one a press on it chooses.
      await userEvent.click(await screen.findByRole("link", { name: "我的研究" }));
      await waitFor(() => expect(addressOf()).toBe("/app/files?scope=default&view=outputs"));
      expect(await screen.findByRole("list", { name: "对话产出" })).toBeInTheDocument();
    });

    it("is searched by the box, and says in one sentence when there is nothing or nothing matches", async () => {
      mocks.listProjectOutputs.mockResolvedValue(outputs);
      renderPage("/app/files?scope=default&view=outputs");
      const user = userEvent.setup();
      const list = await screen.findByRole("list", { name: "对话产出" });
      await user.type(screen.getByRole("searchbox", { name: "搜索对话产出" }), "房颤");
      await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
      await waitFor(() => expect(addressOf()).toBe("/app/files?scope=default&view=outputs&q=%E6%88%BF%E9%A2%A4"));
      await user.type(screen.getByRole("searchbox", { name: "搜索对话产出" }), "不存在");
      expect(await screen.findByText("没有找到相关产出")).toBeInTheDocument();
      cleanup();
      mocks.listProjectOutputs.mockResolvedValue([]);
      renderPage("/app/files?scope=default&view=outputs");
      expect(await screen.findByText("这个项目的对话还没有产出文件。")).toBeInTheDocument();
    });

    it("says when it could not be read, with 重试, and does not turn the failure into an empty list", async () => {
      mocks.listProjectOutputs.mockRejectedValueOnce(new WebApiError("down", { status: 503 }));
      renderPage("/app/files?scope=default&view=outputs");
      const user = userEvent.setup();
      expect(await screen.findByText("无法加载对话产出，请重试。")).toBeInTheDocument();
      expect(screen.queryByText("这个项目的对话还没有产出文件。")).not.toBeInTheDocument();
      mocks.listProjectOutputs.mockResolvedValue(outputs);
      await user.click(screen.getByRole("button", { name: "重试" }));
      expect(await screen.findByRole("list", { name: "对话产出" })).toBeInTheDocument();
      expect(mocks.listProjectOutputs).toHaveBeenCalledTimes(2);
    });
  });

  describe("the views, beside the pane", () => {
    beforeEach(() => { stubLayout(1200); context.features = { knowledgePages: true }; });

    it("moves between the four by their links, keeping the project and dropping it for the documents, and the search goes along", async () => {
      renderPage("/app/files?q=%E5%85%B1%E8%AF%86");
      const views = await screen.findByRole("navigation", { name: "知识库的内容" });
      await waitFor(() => expect(within(views).getByRole("link", { name: "知识页" })).toBeInTheDocument());
      await userEvent.click(within(views).getByRole("link", { name: "知识页" }));
      await waitFor(() => expect(addressOf()).toBe("/app/files?kind=wiki&q=%E5%85%B1%E8%AF%86"));
      expect(await screen.findByRole("heading", { level: 2, name: "我的研究" })).toBeInTheDocument();
      await userEvent.click(within(screen.getByRole("navigation", { name: "知识库的内容" })).getByRole("link", { name: "图谱" }));
      await waitFor(() => expect(addressOf()).toBe("/app/files?kind=wiki&view=graph&q=%E5%85%B1%E8%AF%86"));
      await userEvent.click(within(screen.getByRole("navigation", { name: "知识库的内容" })).getByRole("link", { name: "资料" }));
      await waitFor(() => expect(addressOf()).toBe("/app/files?q=%E5%85%B1%E8%AF%86"));
      expect(await screen.findByRole("heading", { level: 2, name: guideline.display.title })).toBeInTheDocument();
    });

    it("opens a compiled page in the pane with the way back to the project's pages", async () => {
      const compiled = makeSource(knowledgePage.sourceId, { title: knowledgePage.title, origin: "wiki", kind: "wiki", format: "md", pages: null }, { paths: [`knowledge-base/wiki/${knowledgePage.path}`] });
      mocks.getSource.mockImplementation(async (id: string) => { if (id === knowledgePage.sourceId) return compiled; throw new WebApiError("not found", { status: 404, code: "source_not_found" }); });
      mocks.getKnowledgePage.mockResolvedValue(knowledgePage);
      renderPage(`/app/files/${knowledgePage.sourceId}?scope=default&kind=wiki`);
      expect(await screen.findByRole("heading", { level: 2, name: knowledgePage.title })).toBeInTheDocument();
      expect(within(screen.getByRole("navigation", { name: "返回" })).getByRole("link", { name: "知识页" })).toHaveAttribute("href", "/app/files?scope=default&kind=wiki");
    });
  });

  // R19 (plan §3 S10): the page is held to the framework's own assertions — a master-detail page has a header, no tab list, and one row of
  // controls before what it controls.
  describe("composed as a master-detail page of the framework", () => {
    it("has one header, no tab list and one toolbar before its list; no control that filters stands in the list", async () => {
      mocks.listSources.mockResolvedValue({ ...listing([guideline, sheet]), counts: counts({ all: 4, literature: 1, table: 1, wiki: 2 }) });
      const { container } = renderPage();
      await screen.findByRole("list", { name: "资料" });
      const facts = compositionFacts(container);
      expect(facts.header, "the page has a header").not.toBeNull();
      expect(facts.tablists).toHaveLength(0);
      expect(facts.toolbars).toHaveLength(1);
      expect(precedes(facts.header!, facts.toolbars[0]!)).toBe(true);
      expect(precedes(facts.toolbars[0]!, screen.getByRole("list", { name: "资料" }))).toBe(true);
      expect(facts.headerPrimaryActions.length).toBeLessThanOrEqual(1);
      expect(facts.clickableTags).toEqual([]);
      expect(facts.controlsBelowContent).toEqual([]);
      const loose = [...container.querySelectorAll("[role=group], input[type=search]")]
        .filter((node) => !node.closest("[data-toolbar]") && !node.closest("[role=dialog]") && !node.closest("[data-page-header]"))
        .filter((node) => node.matches("input[type=search]") || node.querySelector("[aria-pressed]"));
      expect(loose).toEqual([]);
    });

    it("replaces the toolbar with the selection while documents are chosen, and the page still has exactly one", async () => {
      const { container } = renderPage();
      await userEvent.click(await screen.findByRole("checkbox", { name: `选择“${guideline.display.title}”` }));
      const facts = compositionFacts(container);
      expect(facts.toolbars).toHaveLength(1);
      expect(facts.toolbars[0]).toHaveTextContent("已选 1 份");
      expect(facts.toolbars[0]!.querySelector("input[type=search]")).toBeNull();
      await userEvent.click(within(facts.toolbars[0]!).getByRole("button", { name: "取消" }));
      expect(await screen.findByRole("searchbox", { name: "搜索资料和内容" })).toBeInTheDocument();
    });
  });
});
