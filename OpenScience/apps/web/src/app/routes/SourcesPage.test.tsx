import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knownErrorCodeMessage } from "@evimed/domain";
import { SourcesPage } from "./SourcesPage";

const mocks = vi.hoisted(() => ({
  listSources: vi.fn(), overrideSource: vi.fn(), retrySource: vi.fn(), cancelSource: vi.fn(), removeSource: vi.fn(),
  browseOpenList: vi.fn(), importOpenListSource: vi.fn(),
  getSourceUnderstanding: vi.fn(), listSourceUnderstandingHistory: vi.fn(),
  getSourceFamily: vi.fn(), listSourceFolders: vi.fn(), registerSourceFolder: vi.fn(), syncSourceFolder: vi.fn(),
  setSourceFolderStatus: vi.fn(), listDuplicateCandidates: vi.fn(), decideDuplicateGroup: vi.fn(),
  listLibrary: vi.fn(), addToLibrary: vi.fn(), removeFromLibrary: vi.fn(),
}));
const context = vi.hoisted(() => ({ projectId: "project-one", operator: false }));

// Only the request functions are replaced. `sourceFailureMessage` is a pure
// projection over the one error dictionary, and a test that stubbed it would
// prove the page renders a string this file wrote rather than the registry's.
vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()), ...mocks }));
// Partial: only the project identity is stubbed. `webErrorMessage` and the
// error-detail readers are the real ones, so a page assertion about a refusal
// proves what the shared dictionary says rather than what this file made up.
vi.mock("@/lib/backend", () => ({ pickFiles: vi.fn(async () => []), uploadFilesToWorkspace: vi.fn(async () => []) }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<object>()),
  hasWebApi: true,
  getWebProjectId: () => context.projectId,
  // Operator surfaces (raw codes, pipeline accounting) are shown only to an
  // account `/api/me` marks as one.
  fetchWebMe: async () => ({ user: { id: "u", name: "u" }, operator: context.operator, project: { id: context.projectId, name: "p" }, projects: [] }),
}));
// The preview is the file viewer's own business; the row only has to open it,
// name the document's format and put its summary above it.
vi.mock("@/components/inspector/FilePreviewInspector", () => ({
  FilePreviewInspector: ({ data, kindLabel, lead }: { data: { path: string }; kindLabel?: string | null; lead?: React.ReactNode }) => (
    <div><p>预览：{data.path}</p>{kindLabel && <p>类型：{kindLabel}</p>}{lead}</div>
  ),
}));

/** A day this year, so the row dates it without a year. */
const arrived = `${new Date().getFullYear()}-03-05T08:00:00`;

const source = {
  id: "source-one", projectId: "project-one", revision: 3, createdAt: arrived, updatedAt: arrived, deletedAt: null,
  payload: {
    paths: ["knowledge-base/研究方案.docx"], status: "needs_attention", docType: "research-protocol", depth: "deep",
    version: 2, generation: 3, reasons: ["The file name identifies a protocol, SOP or checklist."], fingerprint: { size: 4096 },
    valueVector: { profileValue: 0.7, methodValue: 0.9, knowledgeValue: 0.6, evidenceValue: 0.4, dataValue: 0.1 },
    coverage: { total: 20, accounted: 20, accountedPercent: 100, extracted: 18, indexedOnly: 0, noContent: 0, failed: 2, percent: 90, omissionRate: 0.1 },
    omissionAudit: { status: "audited", reason: "Question-based audit ran.", omissionRate: 0.12 },
    outputs: { summary: "A randomized research protocol.", facts: 8, methods: 2, artifactPath: "knowledge-base/.evimed-derived/source-one/index.md" },
  },
};
const complete = { ...source, payload: { ...source.payload, status: "complete", coverage: null } };

/** The row's 「⋯」 menu, opened; every action on a document is behind it. */
async function openMenu(name = "研究方案.docx") {
  await userEvent.click(await screen.findByRole("button", { name: `「${name}」的操作` }));
}

/** 「查看理解」: the drawer named by the document. */
async function openDetails(name = "研究方案.docx") {
  await openMenu(name);
  await userEvent.click(await screen.findByRole("menuitem", { name: "查看理解" }));
  return screen.findByRole("dialog", { name });
}

describe("SourcesPage", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    context.projectId = "project-one";
    context.operator = false;
    mocks.listSources.mockResolvedValue({ items: [source], nextCursor: null });
    mocks.overrideSource.mockResolvedValue(source);
    mocks.retrySource.mockResolvedValue(source);
    mocks.cancelSource.mockResolvedValue(source);
    mocks.removeSource.mockResolvedValue(source);
    mocks.getSourceUnderstanding.mockResolvedValue({ sourceId: "source-one", generation: 3, depth: "deep", status: "needs_attention", current: null });
    mocks.listSourceUnderstandingHistory.mockResolvedValue({ items: [], nextCursor: null });
    mocks.getSourceFamily.mockResolvedValue({ sourceId: "source-one", familyId: "fam_one", currentVersion: 2, items: [], nextCursor: null });
    mocks.listSourceFolders.mockResolvedValue({ items: [], nextCursor: null });
    mocks.registerSourceFolder.mockResolvedValue({ folder: { id: "srcdir_one" }, created: true });
    mocks.syncSourceFolder.mockResolvedValue({ folder: { id: "srcdir_one" } });
    mocks.setSourceFolderStatus.mockResolvedValue({ folder: { id: "srcdir_one" } });
    mocks.listDuplicateCandidates.mockResolvedValue({ items: [], scanned: 0, truncated: false });
    mocks.decideDuplicateGroup.mockResolvedValue({ id: "srcdup_one" });
    mocks.browseOpenList.mockResolvedValue({ entries: [], nextCursor: null });
    mocks.listLibrary.mockResolvedValue({ items: [], maxItems: 1000 });
    mocks.addToLibrary.mockResolvedValue({});
    mocks.removeFromLibrary.mockResolvedValue({ sourceId: "source-one", removed: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  // 2026-09-23 plan §5.5, mockup m07: a row is the file, its format and length,
  // and the day it came — the pipeline's accounting, the classifier's English
  // note to itself and the audit stay off the page.
  it("is one list: a row is the file, its format and length — and a state only when something went wrong", async () => {
    render(<SourcesPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "知识库" })).toBeInTheDocument();
    expect(await screen.findByText("研究方案.docx")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "连接网盘" })).toBeInTheDocument();
    expect(screen.getByText("Word · 4 KB")).toBeInTheDocument();
    // Parts of this document could not be read: the one state it says, with the way out.
    expect(screen.getByText("部分没能读取")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新读取「研究方案.docx」" }));
    await waitFor(() => expect(mocks.retrySource).toHaveBeenCalledWith("source-one", 3));
    const page = document.body.textContent ?? "";
    for (const bookkeeping of [/已解析/, /处理台账/, /处理第/, /理解遗漏/, /第 2 版/, /深度分析/, /protocol, SOP or checklist/, /A randomized research protocol/, /上传与浏览原始文件/]) {
      expect(page).not.toMatch(bookkeeping);
    }
  });

  it("says nothing about a document that was read, but the day it arrived", async () => {
    mocks.listSources.mockResolvedValue({ items: [complete], nextCursor: null });
    render(<SourcesPage />);
    expect(await screen.findByText("3月5日")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "资料" });
    expect(within(list).queryByText("已完成")).not.toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /重新读取「/ })).not.toBeInTheDocument();
  });

  // 2026-09-24: every stage — reading, then a minutes-long understanding —
  // was the same bare spinner, and a document could not be used until the
  // understanding ended. It is usable once read; the row says so in words.
  it("says 读取中 in words until a document can be used, and nothing about its understanding after that", async () => {
    const reading = { ...source, readable: false, payload: { ...source.payload, status: "parsing" } };
    const understood = { ...source, id: "source-two", readable: true,
      payload: { ...source.payload, status: "parsing", paths: ["knowledge-base/指南.pdf"] } };
    const understandingFailed = { ...source, id: "source-three", readable: true,
      payload: { ...source.payload, status: "failed", paths: ["knowledge-base/综述.pdf"], error: { code: "source_understanding_invalid", message: "" } } };
    mocks.listSources.mockResolvedValue({ items: [reading, understood, understandingFailed], nextCursor: null });
    render(<SourcesPage />);
    const list = await screen.findByRole("list", { name: "资料" });
    expect(within(list).getAllByText("读取中…")).toHaveLength(1);
    // Read while its understanding still runs, or after that understanding
    // failed: usable, so the row is its type and day — no pipeline word.
    expect(within(list).getAllByText("3月5日")).toHaveLength(2);
    expect(list.textContent).not.toMatch(/分析中|理解中|没能读取|解析失败/);
    await openMenu();
    expect(await screen.findByRole("menuitem", { name: "取消读取" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await openMenu("指南.pdf");
    expect(await screen.findByRole("menuitem", { name: "调整分析" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "取消读取" })).not.toBeInTheDocument();
  });

  it("opens the document's preview from its row", async () => {
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "研究方案.docx" }));
    const preview = await screen.findByRole("dialog", { name: "研究方案.docx" });
    expect(preview).toHaveTextContent("预览：knowledge-base/研究方案.docx");
    // The document's own format, never 「报告」: an upload is not a run's product.
    expect(preview).toHaveTextContent("类型：Word");
    // No understanding yet, no summary: the parser's opening lines are not one.
    expect(within(preview).queryByText("摘要")).not.toBeInTheDocument();
  });

  it("puts the document's summary above its preview once it is understood", async () => {
    const understood = { ...complete, payload: { ...complete.payload, currentUnderstandingId: "understanding:source-one:g3",
      outputs: { ...complete.payload.outputs, summary: "一份随机对照研究的方案。" } } };
    mocks.listSources.mockResolvedValue({ items: [understood], nextCursor: null });
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "研究方案.docx" }));
    const preview = await screen.findByRole("dialog", { name: "研究方案.docx" });
    expect(within(preview).getByText("摘要")).toBeInTheDocument();
    expect(within(preview).getByText("一份随机对照研究的方案。")).toBeInTheDocument();
    // The summary and nothing else of the understanding.
    expect(preview.textContent).not.toMatch(/研究设计|效应估计|A randomized research protocol/);
  });

  it("finds a document by its file name or the title read from it", async () => {
    const other = { ...complete, id: "source-two", payload: { ...complete.payload, paths: ["knowledge-base/1-s2.0-main.pdf"],
      metadata: { title: "Aspirin in older adults" } } };
    mocks.listSources.mockResolvedValue({ items: [complete, other], nextCursor: null });
    render(<SourcesPage />);
    await screen.findByText("研究方案.docx");
    // The title the parser read is what names a download called 1-s2.0-main.pdf.
    expect(screen.getByText("PDF · 4 KB · 《Aspirin in older adults》")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索资料" }), "aspirin");
    expect(screen.getByText("1-s2.0-main.pdf")).toBeInTheDocument();
    expect(screen.queryByText("研究方案.docx")).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索资料" }), " 不存在");
    expect(screen.getByText("没有找到相关资料")).toBeInTheDocument();
  });

  it("lets the researcher override type and depth with a reason", async () => {
    render(<SourcesPage />);
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "调整分析" }));
    await userEvent.selectOptions(screen.getByLabelText("资料类型"), "lecture-slides");
    await userEvent.selectOptions(screen.getByLabelText("分析深度"), "structured");
    await userEvent.type(screen.getByLabelText("调整原因"), "这是教学课件");
    await userEvent.click(screen.getByRole("button", { name: "保存并重新分析" }));
    await waitFor(() => expect(mocks.overrideSource).toHaveBeenCalledWith("source-one", {
      expectedRevision: 3, docType: "lecture-slides", depth: "structured", reason: "这是教学课件",
    }));
  });

  it("filters attention items from one row of chips, and keeps retry and cancel in the menu", async () => {
    render(<SourcesPage />);
    await screen.findByText("研究方案.docx");
    const filters = screen.getByRole("group", { name: "资料状态" });
    // The chips say what the rows say, and ask the server by the same words.
    expect(within(filters).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部", "需要处理", "读取中", "已读取"]);
    await userEvent.click(within(filters).getByRole("button", { name: "需要处理" }));
    await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith("project-one", { state: "attention" }));
    expect(within(filters).getByRole("button", { name: "需要处理" })).toHaveAttribute("aria-pressed", "true");
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "重新读取" }));
    await waitFor(() => expect(mocks.retrySource).toHaveBeenCalledWith("source-one", 3));
    await userEvent.click(within(filters).getByRole("button", { name: "读取中" }));
    await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith("project-one", { state: "reading" }));
    await userEvent.click(within(filters).getByRole("button", { name: "已读取" }));
    await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith("project-one", { state: "ready" }));

    mocks.listSources.mockResolvedValue({ items: [{ ...source, payload: { ...source.payload, status: "parsing" } }], nextCursor: null });
    await userEvent.click(within(filters).getByRole("button", { name: "全部" }));
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "取消读取" }));
    await waitFor(() => expect(mocks.cancelSource).toHaveBeenCalledWith("source-one", 3));
  });

  it("shows an empty library as one sentence, and a failed read with 重试", async () => {
    mocks.listSources.mockResolvedValueOnce({ items: [], nextCursor: null });
    const { unmount } = render(<SourcesPage />);
    expect(await screen.findByText("还没有资料。拖进来，或点右上角上传。")).toBeInTheDocument();
    // The header's 上传 is the only one.
    expect(screen.getAllByRole("button", { name: "上传" })).toHaveLength(1);
    unmount();
    mocks.listSources.mockRejectedValueOnce(new Error("offline"));
    render(<SourcesPage />);
    expect(await screen.findByText(/无法加载资料状态/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("opens the understanding and its history in a drawer named by the document", async () => {
    render(<SourcesPage />);
    const drawer = await openDetails();
    expect(await within(drawer).findByText("这一次分析尚无可用理解")).toBeInTheDocument();
    expect(mocks.getSourceUnderstanding).toHaveBeenCalledWith("source-one");
    await userEvent.click(within(drawer).getByRole("button", { name: "查看历史" }));
    expect(await within(drawer).findByText("暂无历史理解")).toBeInTheDocument();
    // The drawer has one close control; the panel no longer adds its own.
    expect(within(drawer).queryByRole("button", { name: "关闭理解详情" })).not.toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
    expect(screen.queryByText("这一次分析尚无可用理解")).not.toBeInTheDocument();
  });

  it("preserves a correction draft while active polling advances processing state", async () => {
    const pending = { ...source, payload: { ...source.payload, status: "parsing" } };
    mocks.listSources.mockResolvedValueOnce({ items: [pending], nextCursor: null })
      .mockResolvedValue({ items: [{ ...source, revision: 4 }], nextCursor: null });
    render(<SourcesPage />);
    // A document being read says so, in words.
    expect(await screen.findByText("读取中…")).toBeInTheDocument();
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "调整分析" }));
    await userEvent.type(screen.getByLabelText("调整原因"), "保留我的调整说明");
    await userEvent.selectOptions(screen.getByLabelText("分析深度"), "structured");
    // Restart the visible-tab polling deadline under the deterministic clock.
    vi.useFakeTimers();
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.listSources).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("调整原因")).toHaveValue("保留我的调整说明");
    expect(screen.getByLabelText("分析深度")).toHaveValue("structured");
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(mocks.listSources).toHaveBeenCalledTimes(2);
  });

  it("asks before deleting, in one short sentence", async () => {
    render(<SourcesPage />);
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除这份资料？" });
    expect(dialog).toHaveTextContent("删除后不再用于回答。");
    await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(mocks.removeSource).toHaveBeenCalledWith("source-one", 3));
  });

  it("connects the drive without product names, server paths or hash algorithms", async () => {
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "连接网盘" }));
    const drawer = await screen.findByRole("dialog", { name: "连接网盘" });
    expect(within(drawer).getByRole("heading", { name: "网盘资料" })).toBeInTheDocument();
    expect(await within(drawer).findByText("暂无同步文件夹")).toBeInTheDocument();
    expect(drawer.textContent).not.toMatch(/OpenList|SHA-256|\/tenants|本地分析代理|本地代理|不会自动定时轮询/);
  });

  it("registers an explicitly chosen folder for sync and shows what the last run did", async () => {
    mocks.browseOpenList.mockResolvedValue({ entries: [
      { path: "/papers", name: "papers", size: 0, mtime: null, entryType: "dir", providerHash: null },
      { path: "/legacy.pdf", name: "legacy.pdf", size: 10, mtime: null, entryType: "file", providerHash: null },
    ], nextCursor: null });
    mocks.listSourceFolders.mockResolvedValue({ items: [{
      id: "srcdir_one", projectId: "project-one", revision: 5, createdAt: "", updatedAt: "", deletedAt: null,
      payload: { recordType: "source-folder", connector: { type: "openlist", id: "/papers" }, status: "active", recursive: false,
        sync: { run: 3, page: 1 }, entries: {}, createdAt: "", updatedAt: "",
        lastSync: { at: "", run: 2, startPage: 1, endPage: 1, complete: true, scanned: 12, registered: 2, updated: 1,
          unchanged: 9, directories: 0, tracked: 12, skipped: [{ path: "/papers/legacy.pdf", reason: "provider_hash_unsupported" }],
          skippedCount: 1, removedPaths: [], removedCount: 0, removalCheck: "full" },
      },
    }], nextCursor: null });
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "连接网盘" }));
    await userEvent.click(await screen.findByRole("button", { name: "浏览" }));
    // A file the drive cannot fingerprint says so in two words.
    expect(await screen.findByText("不支持此文件")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "同步" }));
    await waitFor(() => expect(mocks.registerSourceFolder).toHaveBeenCalledWith("project-one", "/papers"));
    expect(await screen.findByText(/新增 2/)).toBeInTheDocument();
    expect(screen.getByText(/网盘无法提供内容指纹/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "立即同步" }));
    await waitFor(() => expect(mocks.syncSourceFolder).toHaveBeenCalledWith("srcdir_one", 5));
    // Pausing is the folder's switch, not a button reading 「暂停同步」.
    const toggle = screen.getByRole("switch", { name: "同步「papers」" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(toggle);
    await waitFor(() => expect(mocks.setSourceFolderStatus).toHaveBeenCalledWith("srcdir_one", 5, "paused"));
  });

  it("reports how many entries a run skipped, folded under its count, and not the files it no longer sees", async () => {
    // The service caps the example list at twenty and records the total
    // separately. The count is the total, or a folder that skipped five
    // hundred files says it skipped twenty.
    mocks.listSourceFolders.mockResolvedValue({ items: [{
      id: "srcdir_one", projectId: "project-one", revision: 5, createdAt: "", updatedAt: "", deletedAt: null,
      payload: { recordType: "source-folder", connector: { type: "openlist", id: "/papers" }, status: "active", recursive: false,
        sync: { run: 3, page: 1 }, entries: {}, createdAt: "", updatedAt: "",
        lastSync: { at: "", run: 2, startPage: 1, endPage: 1, complete: true, scanned: 900, registered: 0, updated: 0,
          unchanged: 380, directories: 0, tracked: 380,
          skipped: Array.from({ length: 20 }, (_, index) => ({ path: `/papers/skip-${index}.pdf`, reason: "entry_budget_exhausted" })),
          skippedCount: 500,
          removedPaths: Array.from({ length: 20 }, (_, index) => `/papers/gone-${index}.pdf`),
          removedCount: 137, removalCheck: "full" },
      },
    }], nextCursor: null });
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "连接网盘" }));
    expect(await screen.findByText("跳过 500 项")).toBeInTheDocument();
    expect(screen.queryByText(/跳过 20 项/)).not.toBeInTheDocument();
    expect(screen.queryByText(/网盘里已不见/)).not.toBeInTheDocument();
  });

  it("states a skip reason in Chinese, and a folder's state by its switch", async () => {
    mocks.listSourceFolders.mockResolvedValue({ items: [{
      id: "srcdir_one", projectId: "project-one", revision: 5, createdAt: "", updatedAt: "", deletedAt: null,
      payload: { recordType: "source-folder", connector: { type: "openlist", id: "/papers" }, status: "active", recursive: false,
        sync: { run: 3, page: 1 }, entries: {}, createdAt: "", updatedAt: "",
        lastSync: { at: "", run: 2, startPage: 1, endPage: 1, complete: true, scanned: 3, registered: 1, updated: 0,
          unchanged: 0, directories: 0, tracked: 1, skipped: [
            { path: "/papers/very-long.pdf", reason: "source_payload_invalid" },
            { path: "/papers/unknown.pdf", reason: "source_teleported_away" },
          ], skippedCount: 2, removedPaths: [], removedCount: 0, removalCheck: "full" },
      },
    }], nextCursor: null });
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "连接网盘" }));
    // The reason the sync's own path check produces, and an unmapped code, are
    // both sentences a researcher can read.
    expect(await screen.findByText(/文件路径或属性不合规/)).toBeInTheDocument();
    expect(screen.getByText(/这一项无法入库/)).toBeInTheDocument();
    expect(screen.queryByText(/source_payload_invalid/)).not.toBeInTheDocument();
    expect(screen.queryByText(/source_teleported_away/)).not.toBeInTheDocument();
    // An active folder syncs when a researcher asks it to; nothing polls it,
    // and the switch says it is on without a word beside it.
    expect(screen.getByRole("switch", { name: "同步「papers」" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText(/已启用同步|同步中/)).not.toBeInTheDocument();
  });

  it("wears a duplicate as a tag on its row, resolved from the row's menu — no merge for a single source", async () => {
    mocks.listDuplicateCandidates.mockResolvedValue({ scanned: 2, truncated: false, items: [{
      kind: "shared-content", groupKey: "shared-content:abc", label: "knowledge-base/研究方案.docx",
      sourceIds: ["source-one"], decision: null,
      members: [{ sourceId: "source-one", version: 1, familyId: "fam_one", status: "complete", docType: "research-protocol",
        paths: ["knowledge-base/研究方案.docx", "openlist/papers/研究方案.docx"], size: 4096, sha256: "a", connectorType: "openlist", updatedAt: "" }],
    }] });
    render(<SourcesPage />);
    // A tag, not a button; and a filter counts them.
    expect(await screen.findByText("疑似重复", { selector: "span" })).toBeInTheDocument();
    const filters = screen.getByRole("group", { name: "资料状态" });
    expect(within(filters).getByRole("button", { name: /疑似重复/ })).toHaveTextContent("1");
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "处理疑似重复" }));
    const drawer = await screen.findByRole("dialog", { name: "疑似重复" });
    expect(within(drawer).getByText("同样内容出现在多个路径")).toBeInTheDocument();
    // One source under two paths is already one source. There is nothing to merge.
    expect(within(drawer).queryByRole("button", { name: "标记为同一份" })).not.toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "不是重复" })).toBeInTheDocument();
  });

  it("lists a document's versions inside 查看理解, when it has more than one", async () => {
    mocks.getSourceFamily.mockResolvedValue({ sourceId: "source-one", familyId: "fam_one", currentVersion: 2, nextCursor: null, items: [
      { id: "source-one", projectId: "project-one", revision: 3, createdAt: "", updatedAt: arrived, deletedAt: null,
        payload: { ...source.payload, version: 2, status: "complete" } },
      { id: "source-old", projectId: "project-one", revision: 1, createdAt: "", updatedAt: arrived, deletedAt: null,
        payload: { ...source.payload, version: 1, status: "complete", paths: ["knowledge-base/研究方案.docx"] } },
    ] });
    render(<SourcesPage />);
    const drawer = await openDetails();
    await waitFor(() => expect(mocks.getSourceFamily).toHaveBeenCalledWith("source-one"));
    const versions = await within(drawer).findByRole("region", { name: "版本" });
    expect(within(versions).getByText("第 2 版").closest("li")).toHaveTextContent("当前");
    expect(within(versions).getByText("第 1 版")).toBeInTheDocument();
  });

  it("lists deterministic duplicate candidates without version numbers or sizes, and records an explicit decision", async () => {
    mocks.listDuplicateCandidates.mockResolvedValue({ scanned: 4, truncated: false, items: [{
      kind: "version-family", groupKey: "version-family:abc", label: "knowledge-base/研究方案.docx",
      sourceIds: ["source-one", "source-old"], decision: null,
      members: [
        { sourceId: "source-one", version: 2, familyId: "fam_one", status: "complete", docType: "research-protocol",
          paths: ["knowledge-base/研究方案.docx"], size: 4096, sha256: "a", connectorType: "openlist", updatedAt: arrived },
        { sourceId: "source-old", version: 1, familyId: "fam_one", status: "complete", docType: "research-protocol",
          paths: ["knowledge-base/研究方案.docx"], size: 2048, sha256: "b", connectorType: "openlist", updatedAt: arrived },
      ],
    }] });
    render(<SourcesPage />);
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "处理疑似重复" }));
    const drawer = await screen.findByRole("dialog", { name: "疑似重复" });
    expect(within(drawer).getByText("同一路径的多个版本")).toBeInTheDocument();
    expect(within(drawer).getAllByText("研究方案.docx · 3月5日")).toHaveLength(2);
    expect(drawer.textContent).not.toMatch(/KB|第 \d 版/);
    await userEvent.click(within(drawer).getByRole("button", { name: "标记为同一份" }));
    await waitFor(() => expect(mocks.decideDuplicateGroup).toHaveBeenCalledWith({
      projectId: "project-one", groupKey: "version-family:abc", sourceIds: ["source-one", "source-old"], decision: "linked",
    }));
  });

  it("names why the analysis failed from the one dictionary, as the words' tooltip, and gives an operator the code", async () => {
    // `payload.error` is the fact: the code, turned into a sentence by
    // `@evimed/domain`. The stored English message is the same literal for
    // every failure and is never shown.
    const failed = { ...source, payload: { ...source.payload, status: "failed",
      error: { code: "source_unreadable", message: "Source analysis failed." } } };
    mocks.listSources.mockResolvedValue({ items: [failed], nextCursor: null });
    const view = render(<SourcesPage />);
    const known = knownErrorCodeMessage("source_unreadable") as string;
    expect(known).toBeTruthy();
    const words = await screen.findByText("没能读取");
    expect(words).toHaveAttribute("title", known);
    expect(screen.getByRole("button", { name: "重新读取「研究方案.docx」" })).toBeInTheDocument();
    expect(view.container.textContent).not.toMatch(/Source analysis failed/);
    view.unmount();

    // A code the registry has no sentence for is still a Chinese sentence —
    // never a bare English identifier standing alone.
    mocks.listSources.mockResolvedValue({ items: [{ ...failed, payload: { ...failed.payload,
      error: { code: "source_teleported_away", message: "Source analysis failed." } } }], nextCursor: null });
    const unmapped = render(<SourcesPage />);
    expect((await screen.findByText("没能读取")).getAttribute("title")).toMatch(/^本版本还没有为这个原因准备说明/);
    unmapped.unmount();

    // The code is the handle support searches on, so an operator gets it after
    // the sentence.
    mocks.listSources.mockResolvedValue({ items: [failed], nextCursor: null });
    context.operator = true;
    render(<SourcesPage />);
    await waitFor(async () => expect((await screen.findByText("没能读取")).getAttribute("title")).toBe(`${known}（source_unreadable）`));
  });

  it("states the omission notice inside 查看理解, with the one thing to do about it", async () => {
    // `sourceUnderstandingOmissionNotice` returns blocking:false and its targets
    // have never been checked against an observed distribution, so it is an
    // observation offered where the understanding is read — not a row state.
    const noticed = { ...source, payload: { ...source.payload,
      omissionAudit: { status: "audited", reason: "", omissionRate: 0.32 },
      omissionNotice: { status: "audited", omissionRate: 0.32, reportedRate: 0.1, target: 0.15,
        withinTarget: false, audited: 25, planned: 25,
        disagreements: ["The audit reports an omission rate of 0.1; the anchors this output carries imply 0.32."] } } };
    mocks.listSources.mockResolvedValue({ items: [noticed], nextCursor: null });
    const view = render(<SourcesPage />);
    await screen.findByText("研究方案.docx");
    expect(screen.queryByText(/没有被理解进来/)).not.toBeInTheDocument();
    const drawer = await openDetails();
    expect(within(drawer).getByText(/约 32% 的内容没有被理解进来，高于当前分析深度的参考值 15%/)).toBeInTheDocument();
    // The run's self-audit disagreeing with itself is pipeline diagnostics.
    expect(drawer.textContent).not.toMatch(/至少有 1 处对不上|The audit reports an omission rate/);
    await userEvent.click(within(drawer).getByRole("button", { name: "提高分析深度" }));
    expect(await screen.findByRole("combobox", { name: "分析深度" })).toBeInTheDocument();
    view.unmount();

    mocks.listSources.mockResolvedValue({ items: [{ ...noticed, payload: { ...noticed.payload,
      omissionNotice: { ...noticed.payload.omissionNotice, withinTarget: true, disagreements: [] } } }], nextCursor: null });
    render(<SourcesPage />);
    const quiet = await openDetails();
    expect(quiet.textContent).not.toMatch(/没有被理解进来/);
  });

  it("says why a folder's sync is failing instead of showing only its last good run", async () => {
    // `lastSync` is written only on the success path, so on its own it reports a
    // folder that has been failing for a week as healthy.
    mocks.listSourceFolders.mockResolvedValue({ items: [{
      id: "srcdir_one", projectId: "project-one", revision: 5, createdAt: "", updatedAt: "", deletedAt: null,
      payload: { recordType: "source-folder", connector: { type: "openlist", id: "/papers" }, status: "paused", recursive: false,
        sync: { run: 3, page: 1 }, entries: {}, createdAt: "", updatedAt: "",
        lastError: { code: "connector_unauthorized", at: "2026-09-08T01:00:00Z" },
        lastSync: { at: "", run: 2, startPage: 1, endPage: 1, complete: true, scanned: 12, registered: 2, updated: 1,
          unchanged: 9, directories: 0, tracked: 12, skipped: [], skippedCount: 0, removedPaths: [], removedCount: 0, removalCheck: "full" },
      },
    }], nextCursor: null });
    const view = render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "连接网盘" }));
    const failure = await screen.findByText(/上次同步失败/);
    expect(failure).toHaveTextContent(`上次同步失败：${knownErrorCodeMessage("connector_unauthorized") as string}`);
    expect(failure).not.toHaveAttribute("title");
    // Paused is the switch's position; the last good run is not dressed up as the last sync.
    expect(screen.getByRole("switch", { name: "同步「papers」" })).toHaveAttribute("aria-checked", "false");
    expect(view.container.ownerDocument.body.textContent).not.toMatch(/新增 2/);
    view.unmount();

    // A folder that has never synced says so, and nothing else.
    mocks.listSourceFolders.mockResolvedValue({ items: [{
      id: "srcdir_two", projectId: "project-one", revision: 5, createdAt: "", updatedAt: "", deletedAt: null,
      payload: { recordType: "source-folder", connector: { type: "openlist", id: "/papers" }, status: "active", recursive: false,
        sync: { run: 3, page: 1 }, entries: {}, createdAt: "", updatedAt: "", lastSync: null },
    }], nextCursor: null });
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "连接网盘" }));
    expect(await screen.findByText("尚未同步")).toBeInTheDocument();
    expect(screen.queryByText(/上次同步失败/)).not.toBeInTheDocument();
  });

  it("shows what the parser read about the document in 查看理解, and no DOI bookkeeping", async () => {
    const withMetadata = { ...source, payload: { ...source.payload, analysis: { pageCount: 12 },
      metadata: { title: "房颤抗凝治疗指南", authors: ["张三", "李四", "王五", "赵六"], source: "中华心血管病杂志", publicationDate: "2024-03",
        doi: "10.1000/afib.2024", doiCheck: { status: "verified", similarity: 0.97 } } } };
    mocks.listSources.mockResolvedValue({ items: [withMetadata], nextCursor: null });
    render(<SourcesPage />);
    // The row: the format, the length, and the title read from the file.
    expect(await screen.findByText("Word · 12 页 · 《房颤抗凝治疗指南》")).toBeInTheDocument();
    const drawer = await openDetails();
    expect(within(drawer).getByText("《房颤抗凝治疗指南》 · 张三、李四、王五 等 · 中华心血管病杂志，2024-03 · 共 12 页")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Crossref|DOI 10\./);
  });

  it("marks a parsed document available to every project, and takes it back", async () => {
    // 「加入资料库」 was a second noun for a thing that is just this document,
    // readable from more than one project (plan §3.1). The store is unchanged
    // and names a document by every source holding it, so an entry added from
    // another project is still this row's document.
    const held = { items: [{ sourceId: "source-zero", title: "研究方案", kind: "research-protocol", addedAt: "2026-09-19T00:00:00Z",
      projects: ["project-one", "project-zero"], sourceIds: ["source-one", "source-zero"], status: "ready" }], maxItems: 1000 };
    mocks.listLibrary.mockResolvedValueOnce({ items: [], maxItems: 1000 }).mockResolvedValue(held);
    render(<SourcesPage />);
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "所有项目可用" }));
    await waitFor(() => expect(mocks.addToLibrary).toHaveBeenCalledWith("source-one"));
    expect(await screen.findByText("所有项目")).toBeInTheDocument();
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "改为仅本项目" }));
    await waitFor(() => expect(mocks.removeFromLibrary).toHaveBeenCalledWith("source-one"));
    expect(mocks.addToLibrary).toHaveBeenCalledTimes(1);
  });

  it("offers no cross-project action when the store cannot be read, and none for a document that did not parse", async () => {
    mocks.listLibrary.mockRejectedValue(new Error("library_unavailable"));
    const view = render(<SourcesPage />);
    expect(await screen.findByText("研究方案.docx")).toBeInTheDocument();
    await waitFor(() => expect(mocks.listLibrary).toHaveBeenCalled());
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "所有项目可用" })).not.toBeInTheDocument();
    view.unmount();

    mocks.listLibrary.mockResolvedValue({ items: [], maxItems: 1000 });
    mocks.listSources.mockResolvedValue({ items: [{ ...source, payload: { ...source.payload, status: "failed" } }], nextCursor: null });
    render(<SourcesPage />);
    expect(await screen.findByText("研究方案.docx")).toBeInTheDocument();
    await waitFor(() => expect(mocks.listLibrary).toHaveBeenCalledTimes(2));
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "所有项目可用" })).not.toBeInTheDocument();
  });

  it("discards a previous project's late inventory response", async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.listSources.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const view = render(<SourcesPage />);
    context.projectId = "project-two";
    view.rerender(<SourcesPage />);
    expect(await screen.findByText("还没有资料。拖进来，或点右上角上传。")).toBeInTheDocument();
    await act(async () => { resolveOld({ items: [source], nextCursor: null }); });
    expect(screen.queryByText("研究方案.docx")).not.toBeInTheDocument();
    expect(mocks.listSources).toHaveBeenLastCalledWith("project-two", {});
  });

  it("names whose knowledge base this is, and what is in it", async () => {
    // The page used to name neither: a library of twelve documents gave a
    // reader no way to tell which project's twelve they were looking at.
    render(<SourcesPage />);
    // Wait for the library itself: the rail only exists once there is one.
    expect(await screen.findByText("研究方案.docx")).toBeInTheDocument();
    const rail = screen.getByRole("navigation", { name: "项目与类型" });
    expect(within(rail).getByText("项目")).toBeInTheDocument();
  });

});
