import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPage } from "./MemoryPage";

const api = vi.hoisted(() => ({
  fetchMemoryStatus: vi.fn(),
  fetchMemoryProfile: vi.fn(),
  listResearchMemories: vi.fn(),
  createResearchMemory: vi.fn(),
  updateResearchMemory: vi.fn(),
  deleteResearchMemory: vi.fn(),
  updateStructuredMemory: vi.fn(),
  deleteStructuredMemory: vi.fn(),
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
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const existing = {
  id: "memo_1",
  content: "长期关注利妥昔单抗的感染风险。 #药物安全",
  state: "normal" as const,
  pinned: true,
  tags: ["药物安全"],
  createdAt: "2026-07-17T01:00:00.000Z",
  updatedAt: "2026-07-17T02:00:00.000Z",
};

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
  });

  it("shows connected memory records and creates a new research memory", async () => {
    render(<MemoryPage />);
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
    render(<MemoryPage />);
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
    const { container } = render(<MemoryPage />);
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
    render(<MemoryPage />);
    expect(await screen.findByText("科研记忆尚未就绪")).toBeInTheDocument();
    expect(screen.getByText(/科研记忆仅在 EviMed 在线工作空间中可用，请在 EviMed 在线工作空间中使用此功能。/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新连接" })).not.toBeInTheDocument();
    expect(api.fetchMemoryStatus).not.toHaveBeenCalled();
    expect(api.listResearchMemories).not.toHaveBeenCalled();
  });

  it("shows a card-grid skeleton while the connection status resolves", () => {
    api.fetchMemoryStatus.mockReturnValue(new Promise(() => {}));
    const { container } = render(<MemoryPage />);
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    expect(screen.queryByText("科研记忆尚未就绪")).not.toBeInTheDocument();
  });
});
