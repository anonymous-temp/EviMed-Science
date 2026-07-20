import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPage } from "./MemoryPage";

const api = vi.hoisted(() => ({
  fetchMemoryStatus: vi.fn(),
  listResearchMemories: vi.fn(),
  createResearchMemory: vi.fn(),
  updateResearchMemory: vi.fn(),
  deleteResearchMemory: vi.fn(),
  hasWebApi: true,
}));

vi.mock("@/lib/apiClient", () => ({
  get hasWebApi() {
    return api.hasWebApi;
  },
  fetchMemoryStatus: api.fetchMemoryStatus,
  listResearchMemories: api.listResearchMemories,
  createResearchMemory: api.createResearchMemory,
  updateResearchMemory: api.updateResearchMemory,
  deleteResearchMemory: api.deleteResearchMemory,
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
    api.fetchMemoryStatus.mockResolvedValue({ configured: true, connected: true, code: null, account: "evimed" });
    api.listResearchMemories.mockResolvedValue([existing]);
    api.createResearchMemory.mockImplementation(async (content: string) => ({
      ...existing,
      id: "memo_2",
      content,
      pinned: false,
      tags: [],
    }));
    api.updateResearchMemory.mockImplementation(async (_id: string, update: object) => ({ ...existing, ...update }));
  });

  it("shows connected Memos records and creates a new research memory", async () => {
    render(<MemoryPage />);
    expect(await screen.findByText(/记忆服务已连接 · evimed/)).toBeInTheDocument();
    expect(await screen.findByText(/长期关注利妥昔单抗的感染风险/)).toBeInTheDocument();
    expect(screen.getByText("#药物安全")).toBeInTheDocument();

    await userEvent.type(screen.getByRole("textbox", { name: "科研记忆内容" }), "新的项目纳入标准");
    await userEvent.click(screen.getByRole("button", { name: "保存记忆" }));
    await waitFor(() => expect(api.createResearchMemory).toHaveBeenCalledWith("新的项目纳入标准"));
    expect(screen.getByText("新的项目纳入标准")).toBeInTheDocument();
  });

  it("keeps disconnected state explicit instead of rendering an empty connected dashboard", async () => {
    api.fetchMemoryStatus.mockResolvedValue({ configured: false, connected: false, code: "memory_token_missing" });
    render(<MemoryPage />);
    expect(await screen.findByText("科研记忆尚未就绪")).toBeInTheDocument();
    expect(screen.getAllByText(/尚未配置 Memos 访问令牌/).length).toBeGreaterThan(0);
    expect(api.listResearchMemories).not.toHaveBeenCalled();
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
