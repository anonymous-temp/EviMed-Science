import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPage } from "./MemoryPage";
import { MemoryRouter } from "react-router";

const api = vi.hoisted(() => ({
  fetchMemoryStatus: vi.fn(),
  fetchMemoryProfile: vi.fn(),
  listResearchMemories: vi.fn(),
  createResearchMemory: vi.fn(),
  updateResearchMemory: vi.fn(),
  deleteResearchMemory: vi.fn(),
  updateStructuredMemory: vi.fn(),
  deleteStructuredMemory: vi.fn(),
  fetchMemorySettings: vi.fn(),
  updateMemorySettings: vi.fn(),
  resetMemory: vi.fn(),
  hasWebApi: true,
}));

vi.mock("@/lib/apiClient", () => ({
  get hasWebApi() {
    return api.hasWebApi;
  },
  fetchMemoryStatus: api.fetchMemoryStatus,
  fetchMemoryProfile: api.fetchMemoryProfile,
  listResearchMemories: api.listResearchMemories,
  createResearchMemory: api.createResearchMemory,
  updateResearchMemory: api.updateResearchMemory,
  deleteResearchMemory: api.deleteResearchMemory,
  updateStructuredMemory: api.updateStructuredMemory,
  deleteStructuredMemory: api.deleteStructuredMemory,
  fetchMemorySettings: api.fetchMemorySettings,
  updateMemorySettings: api.updateMemorySettings,
  resetMemory: api.resetMemory,
  getWebProjectId: () => "project-a",
  webErrorMessage: (_error: unknown, overrides?: { fallback?: string }) => overrides?.fallback ?? "操作未完成，请重试。",
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const memoryClient = vi.hoisted(() => ({
  undoMemoryRecord: vi.fn(),
  announceMemoryChanged: vi.fn(),
  MEMORY_CHANGED_EVENT: "evimed.memory.changed",
}));
vi.mock("@/lib/memoryClient", () => memoryClient);

const existing = {
  id: "memo_1",
  content: "长期关注利妥昔单抗的感染风险。 #药物安全",
  state: "normal" as const,
  pinned: true,
  tags: ["药物安全"],
  createdAt: "2026-07-17T01:00:00.000Z",
  updatedAt: "2026-07-17T02:00:00.000Z",
};

/** A structured record with only the fields the overview reads. */
function structured(overrides: Record<string, unknown>) {
  return {
    id: "mem_1", scope: "user", kind: "preference", key: "preference.x",
    value: "", summary: "", status: "active", origin: "inferred",
    confidence: 1, importance: 0.5, sensitive: false, evidenceCount: 1,
    evidence: [], revisions: [], version: 1,
    ...overrides,
  };
}

/** A profile whose named groups carry the given records. */
function profile(groups: Record<string, unknown[]>) {
  const empty = {
    profile: [], preference: [], behavior: [], project_fact: [], analysis: [],
    decision: [], correction: [], follow_up: [], run_summary: [],
  };
  const merged = { ...empty, ...groups };
  const all = Object.values(merged).flat();
  return {
    records: all,
    groups: merged,
    activeCount: all.filter((record) => (record as { status: string }).status === "active").length,
    pendingCount: all.filter((record) => (record as { status: string }).status === "pending").length,
  };
}

const mocks = api;

describe("MemoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.hasWebApi = true;
    // `account` is deliberately still in this payload although the store no
    // longer sends it: during a rolling deploy the browser can be served by a
    // control plane from the previous release, and the pill must not show it.
    // Without the extra key an implementation that still read the field would
    // render the same text and this suite could not fail on it.
    api.fetchMemoryStatus.mockResolvedValue({
      configured: true,
      connected: true,
      code: null,
      structured: true,
      account: "evimed",
    });
    api.listResearchMemories.mockResolvedValue([existing]);
    api.fetchMemoryProfile.mockResolvedValue({
      records: [],
      groups: {
        profile: [], preference: [], behavior: [], project_fact: [], analysis: [],
        decision: [], correction: [], follow_up: [], run_summary: [],
      },
      activeCount: 0,
      pendingCount: 0,
    });
    api.createResearchMemory.mockImplementation(async (content: string) => ({
      ...existing,
      id: "memo_2",
      content,
      pinned: false,
      tags: [],
    }));
    api.updateResearchMemory.mockImplementation(async (_id: string, update: object) => ({ ...existing, ...update }));
    api.fetchMemorySettings.mockResolvedValue({ learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null });
    api.updateMemorySettings.mockImplementation(async (patch: object) => ({
      learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: "2026-09-16T18:00:00.000Z", ...patch,
    }));
    api.resetMemory.mockResolvedValue({ structured: 3, manual: 1 });
  });

  it("pauses learning, recall and this project without deleting anything, and resets only after saying what goes", async () => {
    // 2026-09-16 review, M4④: pause and reset are different acts.
    render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    const learning = await screen.findByRole("switch", { name: "从对话中学习新记忆" });
    expect(learning).toHaveAttribute("aria-checked", "true");

    await userEvent.click(learning);
    expect(api.updateMemorySettings).toHaveBeenLastCalledWith({ learningPaused: true });
    await waitFor(() => expect(screen.getByRole("switch", { name: "从对话中学习新记忆" })).toHaveAttribute("aria-checked", "false"));
    expect(screen.getByText(/已暂停：之后的对话不会写入新记忆，已有记忆保留/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: "当前项目使用记忆" }));
    expect(api.updateMemorySettings).toHaveBeenLastCalledWith({ pausedProjects: ["project-a"] });
    expect(api.resetMemory).not.toHaveBeenCalled();
    expect(api.deleteStructuredMemory).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "重置全部记忆" }));
    expect(await screen.findByText(/不会删除对话与运行记录、交付文件、知识库来源和方法胶囊/)).toBeInTheDocument();
    expect(api.resetMemory).not.toHaveBeenCalled();
    const loadsBefore = api.listResearchMemories.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "全部删除" }));
    await waitFor(() => expect(api.resetMemory).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.listResearchMemories.mock.calls.length).toBeGreaterThan(loadsBefore));
  });

  it("shows connected memory records and creates a new research memory", async () => {
    render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    // Exact text: the store is part of the control plane and has no account of
    // its own, so the pill states the connection and nothing else -- even when
    // the payload still carries one (see the mock above).
    expect(await screen.findByText("科研记忆服务已连接")).toBeInTheDocument();
    expect(await screen.findByText(/长期关注利妥昔单抗的感染风险/)).toBeInTheDocument();
    expect(screen.getByText("EviMed 对你的持续理解")).toBeInTheDocument();
    expect(screen.getByText("#药物安全")).toBeInTheDocument();

    await userEvent.type(screen.getByRole("textbox", { name: "科研记忆内容" }), "新的项目纳入标准");
    await userEvent.click(screen.getByRole("button", { name: "保存记忆" }));
    await waitFor(() => expect(api.createResearchMemory).toHaveBeenCalledWith("新的项目纳入标准"));
    expect(screen.getByText("新的项目纳入标准")).toBeInTheDocument();
  });

  it("keeps disconnected state explicit instead of rendering an empty connected dashboard", async () => {
    api.fetchMemoryStatus.mockResolvedValue({ configured: true, connected: false, code: "memory_schema_unavailable" });
    render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    expect(await screen.findByText("科研记忆尚未就绪")).toBeInTheDocument();
    expect(screen.getAllByText(/科研记忆库结构未就绪/).length).toBeGreaterThan(0);
    expect(api.listResearchMemories).not.toHaveBeenCalled();
  });

  // Every code the store can report, then the five the retired remote service
  // reported and a code from a later release: those must all fall through to
  // the generic sentence. The negative rows are the ones that matter after this
  // migration -- a merge that puts a retired entry back into the table would
  // otherwise pass every positive assertion -- and the brand check fails
  // whatever copy such an entry carried.
  it.each([
    ["memory_unconfigured", "科研记忆库未配置"],
    ["memory_schema_unavailable", "科研记忆库结构未就绪"],
    ["memory_unavailable", "科研记忆库暂时不可用"],
    ["memory_timeout", "科研记忆库响应超时"],
    ["memory_url_missing", "科研记忆服务未连接"],
    ["memory_token_missing", "科研记忆服务未连接"],
    ["memos_access_token_file_unavailable", "科研记忆服务未连接"],
    ["memos_access_token_file_permissions", "科研记忆服务未连接"],
    ["memory_auth_failed", "科研记忆服务未连接"],
    ["memory_code_from_a_later_release", "科研记忆服务未连接"],
  ])("explains status code %s without naming a retired service", async (code, message) => {
    api.fetchMemoryStatus.mockResolvedValue({
      configured: code !== "memory_unconfigured",
      connected: false,
      code,
    });
    const { container } = render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    // Wait for the status to land before reading the pill. While the request is
    // in flight there is no status yet, so the pill already shows the generic
    // sentence -- asserting it directly would pass every negative row on the
    // loading state alone, before the code was ever looked up.
    expect(await screen.findByText("科研记忆尚未就绪")).toBeInTheDocument();
    expect(screen.getAllByText(message).length).toBeGreaterThan(0);
    expect(container.textContent ?? "").not.toMatch(/memos/i);
  });

  it("points desktop users to the hosted workspace (no backend, no reconnect loop)", async () => {
    api.hasWebApi = false;
    render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    expect(await screen.findByText("科研记忆尚未就绪")).toBeInTheDocument();
    expect(screen.getByText(/科研记忆仅在 EviMed 在线工作空间中可用，请在 EviMed 在线工作空间中使用此功能。/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新连接" })).not.toBeInTheDocument();
    expect(api.fetchMemoryStatus).not.toHaveBeenCalled();
    expect(api.listResearchMemories).not.toHaveBeenCalled();
  });

  it("shows a card-grid skeleton while the connection status resolves", () => {
    api.fetchMemoryStatus.mockReturnValue(new Promise(() => {}));
    const { container } = render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    expect(screen.queryByText("科研记忆尚未就绪")).not.toBeInTheDocument();
  });
});

describe("a stored brief is not a preference, and a sensitive record is not accepted by accident", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.hasWebApi = true;
    api.fetchMemoryStatus.mockResolvedValue({ configured: true, connected: true, code: null, structured: true });
    api.listResearchMemories.mockResolvedValue([]);
    api.updateStructuredMemory.mockImplementation(async (record: object, update: object) => ({ ...record, ...update }));
  });

  // Eleven whole `<evimed-brief>` task briefs were stored as durable
  // preferences at confidence 100% and rendered verbatim, tag and all
  // (2026-09-16 review, M1). The rows are archived; the display half is here.
  it("shows the content without the machine's envelope, and says what it is", async () => {
    mocks.fetchMemoryProfile.mockResolvedValue(profile({
      preference: [structured({
        id: "mem_brief",
        summary: "<evimed-brief> 请以《某某》为题完成证据评审。</evimed-brief>",
        status: "active",
      })],
    }));
    render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    expect(await screen.findByText("请以《某某》为题完成证据评审。")).toBeInTheDocument();
    expect(screen.getByText("疑似任务题面，非你的陈述")).toBeInTheDocument();
  });

  it("says where a memory's evidence came from in words, never as the store's enum", async () => {
    // M6, and the vocabulary regression extended past the run ledger (D5).
    mocks.fetchMemoryProfile.mockResolvedValue(profile({
      preference: [structured({
        id: "mem_evidence",
        summary: "回答使用中文",
        evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/s1/messages/m1",
          quote: "请用中文回答。", observedAt: "2026-09-16T08:00:00.000Z", weight: 1 }],
      })],
    }));
    render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    await userEvent.click(await screen.findByText("查看依据与变更"));
    // Prove the evidence rendered before asserting what it does not say.
    expect(screen.getByText("“请用中文回答。”")).toBeInTheDocument();
    expect(screen.getByText(/对话中的原话/)).toBeInTheDocument();
    expect(screen.queryByText(/conversation_message/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sessions\/s1/)).not.toBeInTheDocument();
  });

  it("asks before a sensitive pending record takes effect, by either path", async () => {
    // The 「确认」 button was hidden for a sensitive record while 「修正」 wrote
    // `status: "active"` regardless, so the only way to accept one was the path
    // that did not ask (M4②).
    mocks.fetchMemoryProfile.mockResolvedValue(profile({
      preference: [structured({ id: "mem_sensitive", summary: "我在服用某种药物。", status: "pending", sensitive: true })],
    }));
    render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: /确认/ }));
    expect(await screen.findByText("确认这条敏感记忆？")).toBeInTheDocument();
    // The dialog tells the truth: both recall paths drop a sensitive record
    // whatever its status, so confirming it never puts it in front of a run.
    // It used to promise that the record "will be read and shape answers".
    expect(screen.getByText(/敏感记忆不会被自动调取到后续研究中/)).toBeInTheDocument();
    expect(screen.queryByText(/会在后续研究中被读取/)).not.toBeInTheDocument();
    expect(mocks.updateStructuredMemory).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "确认保留" }));
    await waitFor(() => expect(mocks.updateStructuredMemory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mem_sensitive" }),
      expect.objectContaining({ status: "active" }),
    ));
  });
});

describe("every change can be taken back in one click", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.hasWebApi = true;
    api.fetchMemoryStatus.mockResolvedValue({ configured: true, connected: true, code: null, structured: true });
    api.listResearchMemories.mockResolvedValue([]);
  });

  it("offers to undo the last change of a memory that has one, and asks nothing first", async () => {
    // Owner ruling 2026-09-19: memory changes by itself, so the way back is one
    // click — no dialog.
    api.fetchMemoryProfile.mockResolvedValue(profile({
      preference: [
        structured({ id: "mem_changed", summary: "证据先用文字叙述", version: 3,
          revisions: [{ version: 2, value: "证据先用表格", summary: "表格优先", status: "active", changedAt: null, reason: "x" }] }),
        structured({ id: "mem_new", summary: "回答用中文", version: 1, revisions: [] }),
      ],
    }));
    memoryClient.undoMemoryRecord.mockResolvedValue({ undone: "restored", record: null, restored: [] });
    render(<MemoryRouter><MemoryPage /></MemoryRouter>);
    const buttons = await screen.findAllByRole("button", { name: "撤销上次改动" });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]);
    await waitFor(() => expect(memoryClient.undoMemoryRecord).toHaveBeenCalledWith("mem_changed", 3));
    expect(memoryClient.announceMemoryChanged).toHaveBeenCalled();
  });
});
