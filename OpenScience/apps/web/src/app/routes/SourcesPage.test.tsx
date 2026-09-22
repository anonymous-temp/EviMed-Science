import { act, render, screen, waitFor } from "@testing-library/react";
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

const source = {
  id: "source-one", projectId: "project-one", revision: 3,
  payload: {
    paths: ["knowledge-base/研究方案.docx"], status: "needs_attention", docType: "research-protocol", depth: "deep",
    version: 2, generation: 3, reasons: ["The file name identifies a protocol, SOP or checklist."],
    valueVector: { profileValue: 0.7, methodValue: 0.9, knowledgeValue: 0.6, evidenceValue: 0.4, dataValue: 0.1 },
    coverage: { total: 20, accounted: 20, accountedPercent: 100, extracted: 18, indexedOnly: 0, noContent: 0, failed: 2, percent: 90, omissionRate: 0.1 },
    outputs: { summary: "A randomized research protocol.", facts: 8, methods: 2, artifactPath: "knowledge-base/.evimed-derived/source-one/index.md" },
  },
};

/** The row's 「…」 menu, opened; every action on a document is behind it. */
async function openMenu(name = "研究方案.docx") {
  await userEvent.click(await screen.findByRole("button", { name: `「${name}」的操作` }));
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

  it("is one list: each row carries its name, what was read, its state — and nothing the reader did not ask for", async () => {
    render(<SourcesPage />);
    expect(await screen.findByRole("heading", { name: "知识库" })).toBeInTheDocument();
    expect(await screen.findByText("研究方案.docx")).toBeInTheDocument();
    // The one primary action, and the cloud drive beside it; no second view
    // of the folder, no separate duplicates desk (2026-09-22).
    expect(screen.getByRole("button", { name: "上传资料" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "连接网盘" })).toBeInTheDocument();
    expect(screen.queryByText("上传与浏览原始文件")).toBeNull();
    expect(screen.queryByText("A randomized research protocol.")).toBeNull();
    // What was read, in the researcher's terms; the parse ledger is the
    // pipeline's bookkeeping and stays with the operator.
    expect(screen.getByText("已解析 90% · 2 个片段未能解析")).toBeInTheDocument();
    expect(screen.queryByText(/处理台账/)).not.toBeInTheDocument();
    expect(screen.queryByText(/处理第 3 代/)).not.toBeInTheDocument();
    expect(screen.getByText("理解遗漏尚未审计")).toBeInTheDocument();
    expect(screen.queryByText(/遗漏 10%/)).not.toBeInTheDocument();
    expect(screen.queryByText("事实 8 · 方法线索 2")).not.toBeInTheDocument();
    // Why it was classified is said when a person is being asked to look.
    expect(screen.getByText(/protocol, SOP or checklist/)).toBeInTheDocument();
    expect(screen.getByText(/需要你看一下/)).toBeInTheDocument();
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

  it("filters attention items and exposes retry and cancel actions", async () => {
    render(<SourcesPage />);
    await screen.findByText("研究方案.docx");
    await userEvent.click(screen.getByRole("radio", { name: "需要处理" }));
    await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith("project-one", { status: "needs_attention" }));
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "重新分析" }));
    await waitFor(() => expect(mocks.retrySource).toHaveBeenCalledWith("source-one", 3));
  });

  it("shows an actionable empty and error state", async () => {
    mocks.listSources.mockResolvedValueOnce({ items: [], nextCursor: null });
    const { unmount } = render(<SourcesPage />);
    // One empty state, with the one thing to do about it.
    expect(await screen.findByText("知识库还是空的")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "上传资料" }).length).toBeGreaterThan(1);
    unmount();
    mocks.listSources.mockRejectedValueOnce(new Error("offline"));
    render(<SourcesPage />);
    expect(await screen.findByText(/无法加载资料状态/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("opens the actual understanding and history endpoints from the row", async () => {
    render(<SourcesPage />);
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "查看理解" }));
    expect(await screen.findByText("这一次分析尚无可用理解")).toBeInTheDocument();
    expect(mocks.getSourceUnderstanding).toHaveBeenCalledWith("source-one");
    await userEvent.click(screen.getByRole("button", { name: "查看历史" }));
    expect(await screen.findByText("暂无历史理解")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭理解详情" }));
    expect(screen.queryByText("这一次分析尚无可用理解")).not.toBeInTheDocument();
  });

  it("preserves a correction draft while active polling advances processing state", async () => {
    const pending = { ...source, payload: { ...source.payload, status: "parsing" } };
    mocks.listSources.mockResolvedValueOnce({ items: [pending], nextCursor: null })
      .mockResolvedValue({ items: [{ ...source, revision: 4 }], nextCursor: null });
    render(<SourcesPage />);
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


  it("no longer offers a local analysis agent this deployment does not ship", async () => {
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "连接网盘" }));
    // No product names, server paths or hash algorithms on a researcher's page.
    expect(await screen.findByText(/无法提供内容指纹的文件，请改用平台上传/)).toBeInTheDocument();
    expect(screen.queryByText(/OpenList|SHA-256|\/tenants/)).not.toBeInTheDocument();
    expect(screen.queryByText(/本地分析代理/)).not.toBeInTheDocument();
    expect(screen.queryByText(/本地代理/)).not.toBeInTheDocument();
  });

  it("registers an explicitly chosen folder for sync and shows what the last run did", async () => {
    mocks.browseOpenList.mockResolvedValue({ entries: [
      { path: "/papers", name: "papers", size: 0, mtime: null, entryType: "dir", providerHash: null },
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
    await userEvent.click(await screen.findByRole("button", { name: "同步" }));
    await waitFor(() => expect(mocks.registerSourceFolder).toHaveBeenCalledWith("project-one", "/papers"));
    expect(await screen.findByText(/新增 2 · 更新 1 · 未变化 9/)).toBeInTheDocument();
    expect(screen.getByText(/网盘无法提供内容指纹/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "立即同步" }));
    await waitFor(() => expect(mocks.syncSourceFolder).toHaveBeenCalledWith("srcdir_one", 5));
    await userEvent.click(screen.getByRole("button", { name: "暂停同步" }));
    await waitFor(() => expect(mocks.setSourceFolderStatus).toHaveBeenCalledWith("srcdir_one", 5, "paused"));
  });

  it("reports how many entries a run skipped and lost, not how many it named", async () => {
    // The service caps both lists at twenty examples and records the totals
    // separately. The card must state the totals, or a folder that skipped five
    // hundred files tells the researcher it skipped twenty.
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
    expect(await screen.findByText(/跳过 500 项/)).toBeInTheDocument();
    expect(screen.queryByText(/跳过 20 项/)).not.toBeInTheDocument();
    expect(await screen.findByText(/网盘里已不见 137 个文件/)).toBeInTheDocument();
    expect(screen.queryByText(/网盘里已不见 20 个文件/)).not.toBeInTheDocument();
  });

  it("states a skip reason in Chinese and says syncing is something the researcher triggers", async () => {
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
    // An active folder syncs when a researcher asks it to; nothing polls it.
    expect(screen.getByText("已启用同步")).toBeInTheDocument();
    expect(screen.queryByText("同步中")).not.toBeInTheDocument();
  });

  it("offers no merge on a group that names a single source", async () => {
    mocks.listDuplicateCandidates.mockResolvedValue({ scanned: 2, truncated: false, items: [{
      kind: "shared-content", groupKey: "shared-content:abc", label: "knowledge-base/研究方案.docx",
      sourceIds: ["source-one"], decision: null,
      members: [{ sourceId: "source-one", version: 1, familyId: "fam_one", status: "complete", docType: "research-protocol",
        paths: ["knowledge-base/研究方案.docx", "openlist/papers/研究方案.docx"], size: 4096, sha256: "a", connectorType: "openlist", updatedAt: "" }],
    }] });
    render(<SourcesPage />);
    // The badge is on the row, and a filter counts them; no separate desk.
    await userEvent.click(await screen.findByRole("button", { name: /^疑似重复$/ }));
    expect(await screen.findByText("同样内容出现在多个路径")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /疑似重复/ })).toHaveTextContent("1");
    // One source under two paths is already one source. There is nothing to merge.
    expect(screen.queryByRole("button", { name: "标记为同一份" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "不是重复" })).toBeInTheDocument();
  });

  it("shows the version chain a source belongs to instead of only its own version number", async () => {
    mocks.getSourceFamily.mockResolvedValue({ sourceId: "source-one", familyId: "fam_one", currentVersion: 2, nextCursor: null, items: [
      { id: "source-one", projectId: "project-one", revision: 3, createdAt: "", updatedAt: "", deletedAt: null,
        payload: { ...source.payload, version: 2, status: "complete" } },
      { id: "source-old", projectId: "project-one", revision: 1, createdAt: "", updatedAt: "", deletedAt: null,
        payload: { ...source.payload, version: 1, status: "complete", paths: ["knowledge-base/研究方案.docx"] } },
    ] });
    render(<SourcesPage />);
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "查看版本链" }));
    await waitFor(() => expect(mocks.getSourceFamily).toHaveBeenCalledWith("source-one"));
    expect(await screen.findByText(/第 2 版 .* 当前查看/)).toBeInTheDocument();
    expect(screen.getByText(/第 1 版/)).toBeInTheDocument();
  });

  it("lists deterministic duplicate candidates and records an explicit decision", async () => {
    mocks.listDuplicateCandidates.mockResolvedValue({ scanned: 4, truncated: false, items: [{
      kind: "version-family", groupKey: "version-family:abc", label: "knowledge-base/研究方案.docx",
      sourceIds: ["source-one", "source-old"], decision: null,
      members: [
        { sourceId: "source-one", version: 2, familyId: "fam_one", status: "complete", docType: "research-protocol",
          paths: ["knowledge-base/研究方案.docx"], size: 4096, sha256: "a", connectorType: "openlist", updatedAt: "" },
        { sourceId: "source-old", version: 1, familyId: "fam_one", status: "complete", docType: "research-protocol",
          paths: ["knowledge-base/研究方案.docx"], size: 2048, sha256: "b", connectorType: "openlist", updatedAt: "" },
      ],
    }] });
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^疑似重复$/ }));
    expect(await screen.findByText("同一路径的多个版本")).toBeInTheDocument();
    expect(screen.getByText(/第 2 版 · 研究方案.docx · 4 KB/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "标记为同一份" }));
    await waitFor(() => expect(mocks.decideDuplicateGroup).toHaveBeenCalledWith({
      projectId: "project-one", groupKey: "version-family:abc", sourceIds: ["source-one", "source-old"], decision: "linked",
    }));
  });

  it("states the omission verdict the understanding contract actually returned", async () => {
    mocks.listSources.mockResolvedValue({ items: [{ ...source, payload: { ...source.payload,
      omissionAudit: { status: "audited", reason: "Question-based audit ran.", omissionRate: 0.12 } } }], nextCursor: null });
    render(<SourcesPage />);
    expect(await screen.findByText("理解遗漏 12%")).toBeInTheDocument();
    expect(screen.queryByText("理解遗漏尚未审计")).not.toBeInTheDocument();
  });

  it("names why the analysis failed, from the one dictionary, not the reason the file was classified", async () => {
    // `payload.error` was stored, served and typed all the way to this component
    // and rendered by nothing, so a failed source showed 「分析失败」 next to
    // `reasons[0]` — a classification rationale with nothing to do with the
    // failure. The code is the fact; the sentence comes from `@evimed/domain`.
    const failed = { ...source, payload: { ...source.payload, status: "failed",
      error: { code: "source_unreadable", message: "Source analysis failed." } } };
    mocks.listSources.mockResolvedValue({ items: [failed], nextCursor: null });
    const view = render(<SourcesPage />);
    const known = knownErrorCodeMessage("source_unreadable") as string;
    expect(known).toBeTruthy();
    expect(await screen.findByText(new RegExp("^解析失败："))).toHaveTextContent(`解析失败：${known}`);
    // The stored message is the same English literal for every failure.
    expect(view.container.textContent).not.toMatch(/Source analysis failed/);
    // The classification reason survives, labelled as what it is.
    expect(screen.getByText(/分类依据：/)).toBeInTheDocument();
    view.unmount();

    // A code the registry has no sentence for is still a Chinese sentence —
    // never a bare English identifier standing alone in a Chinese interface.
    // The code itself is the handle support searches on, so an operator keeps
    // it as a tooltip; a researcher does not get it at all.
    mocks.listSources.mockResolvedValue({ items: [{ ...failed, payload: { ...failed.payload,
      error: { code: "source_parser_timeout", message: "Source analysis failed." } } }], nextCursor: null });
    const researcher = render(<SourcesPage />);
    const row = await screen.findByText(/^解析失败：/);
    expect(row.textContent).not.toBe("source_parser_timeout");
    expect(row).not.toHaveAttribute("title");
    researcher.unmount();
    context.operator = true;
    render(<SourcesPage />);
    await waitFor(async () => expect(await screen.findByText(/^解析失败：/)).toHaveAttribute("title", "source_parser_timeout"));
  });

  it("states the omission notice as an observation, in Chinese, and stays silent when it has nothing to say", async () => {
    // `sourceUnderstandingOmissionNotice` returns blocking:false and its targets
    // have never been checked against an observed distribution, so the card says
    // out loud that nothing is being asked of the researcher.
    const noticed = { ...source, payload: { ...source.payload,
      omissionAudit: { status: "audited", reason: "", omissionRate: 0.32 },
      omissionNotice: { status: "audited", omissionRate: 0.32, reportedRate: 0.1, target: 0.15,
        withinTarget: false, audited: 25, planned: 25,
        disagreements: ["The audit reports an omission rate of 0.1; the anchors this output carries imply 0.32."] } } };
    mocks.listSources.mockResolvedValue({ items: [noticed], nextCursor: null });
    const view = render(<SourcesPage />);
    // Something the researcher can act on, with the action beside it — not a
    // notice whose own text says it can be ignored.
    expect(await screen.findByText(/约 32% 的内容没有被理解进来，高于当前分析深度的参考值 15%/)).toBeInTheDocument();
    expect(screen.queryByText(/仅供参考/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "提高分析深度" }));
    expect(await screen.findByRole("combobox", { name: "分析深度" })).toBeInTheDocument();
    // The run's self-audit disagreeing with itself is pipeline diagnostics.
    expect(screen.queryByText(/至少有 1 处对不上/)).not.toBeInTheDocument();
    expect(view.container.textContent).not.toMatch(/The audit reports an omission rate/);
    view.unmount();

    mocks.listSources.mockResolvedValue({ items: [{ ...noticed, payload: { ...noticed.payload,
      omissionNotice: { ...noticed.payload.omissionNotice, withinTarget: true, disagreements: [] } } }], nextCursor: null });
    render(<SourcesPage />);
    await screen.findByText("研究方案.docx");
    expect(screen.queryByText(/遗漏审计提示/)).not.toBeInTheDocument();
  });

  it("says why a folder's sync is failing instead of showing only its last good run", async () => {
    // `lastSync` is written only on the success path, so on its own it reports a
    // folder that has been failing for a week as healthy, and a paused folder as
    // a bare 「已暂停」 with no reason.
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
    expect(failure.textContent).toContain(knownErrorCodeMessage("connector_unauthorized") as string);
    expect(failure).not.toHaveAttribute("title");
    expect(failure.textContent).toContain("同步已暂停");
    // The successful run is still shown, but no longer as "the last sync".
    expect(view.container.textContent).toContain("上次成功同步：");
    view.unmount();

    // A folder that has never failed reads exactly as it did before.
    mocks.listSourceFolders.mockResolvedValue({ items: [{
      id: "srcdir_two", projectId: "project-one", revision: 5, createdAt: "", updatedAt: "", deletedAt: null,
      payload: { recordType: "source-folder", connector: { type: "openlist", id: "/papers" }, status: "active", recursive: false,
        sync: { run: 3, page: 1 }, entries: {}, createdAt: "", updatedAt: "", lastSync: null },
    }], nextCursor: null });
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "连接网盘" }));
    expect(await screen.findByText("尚未完成第一次同步。")).toBeInTheDocument();
    expect(screen.queryByText(/上次同步失败/)).not.toBeInTheDocument();
  });

  it("shows what the parser read about the document, with the DOI said as checked as it is", async () => {
    const withMetadata = (doiCheck: Record<string, unknown>, doi?: string) => ({ ...source, payload: { ...source.payload,
      analysis: { pageCount: 12 },
      metadata: { title: "房颤抗凝治疗指南", authors: ["张三", "李四", "王五", "赵六"], source: "中华心血管病杂志", publicationDate: "2024-03",
        ...(doi ? { doi } : {}), doiCheck } } });
    mocks.listSources.mockResolvedValueOnce({ items: [withMetadata({ status: "verified", similarity: 0.97 }, "10.1000/afib.2024")], nextCursor: null });
    const view = render(<SourcesPage />);
    expect(await screen.findByText("《房颤抗凝治疗指南》 · 张三、李四、王五 等 · 中华心血管病杂志，2024-03 · 共 12 页")).toBeInTheDocument();
    expect(screen.getByText("DOI 10.1000/afib.2024（已与 Crossref 登记的题名核对）")).toBeInTheDocument();
    view.unmount();

    mocks.listSources.mockResolvedValueOnce({ items: [withMetadata({ status: "unconfirmed", reason: "crossref_unreachable" }, "10.1000/afib.2024")], nextCursor: null });
    const unconfirmed = render(<SourcesPage />);
    expect(await screen.findByText("DOI 10.1000/afib.2024（未经 Crossref 确认）")).toBeInTheDocument();
    unconfirmed.unmount();

    // Crossref registered the parsed DOI for another work: it is dropped, and said so.
    mocks.listSources.mockResolvedValueOnce({ items: [withMetadata({ status: "mismatch", droppedDoi: "10.9999/other", crossrefTitle: "Another paper" })], nextCursor: null });
    render(<SourcesPage />);
    expect(await screen.findByText("解析出的 DOI 10.9999/other 在 Crossref 登记的是另一篇文献，已不采用")).toBeInTheDocument();
    expect(screen.queryByText(/已与 Crossref/)).not.toBeInTheDocument();
  });

  it("marks a parsed document available to every project, and takes it back", async () => {
    // 「加入资料库」 was a second noun for a thing that is just this document,
    // readable from more than one project (plan §3.1). The store is unchanged
    // and names a document by every source holding it, so an entry added from
    // another project is still this card's document.
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
    expect(await screen.findByText("知识库还是空的")).toBeInTheDocument();
    await act(async () => { resolveOld({ items: [source], nextCursor: null }); });
    expect(screen.queryByText("研究方案.docx")).not.toBeInTheDocument();
    expect(mocks.listSources).toHaveBeenLastCalledWith("project-two", { status: "" });
  });
});
