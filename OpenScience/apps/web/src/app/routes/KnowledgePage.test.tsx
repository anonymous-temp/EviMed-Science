import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgePage } from "./KnowledgePage";

const mocks = vi.hoisted(() => ({
  listSources: vi.fn(), listDuplicateCandidates: vi.fn(), listLibrary: vi.fn(), listSourceFolders: vi.fn(),
}));
vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()), ...mocks }));
vi.mock("@/lib/backend", () => ({ pickFiles: vi.fn(async () => []), uploadFilesToWorkspace: vi.fn(async () => []) }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<object>()),
  hasWebApi: true,
  getWebProjectId: () => "project-one",
  fetchWebMe: async () => ({ user: { id: "u", name: "u" }, operator: false, project: { id: "project-one", name: "p" }, projects: [] }),
}));

const source = {
  id: "source-one", projectId: "project-one", revision: 1, createdAt: "2026-09-22T08:00:00Z", updatedAt: "2026-09-22T08:00:00Z", deletedAt: null,
  payload: { paths: ["knowledge-base/ASPREE.pdf"], status: "complete", docType: "published-paper", depth: "structured", version: 1,
    reasons: [], valueVector: {}, coverage: null, outputs: {}, analysis: { pageCount: 14 } },
};

describe("知识库", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listSources.mockResolvedValue({ items: [], nextCursor: null });
    mocks.listDuplicateCandidates.mockResolvedValue({ items: [], scanned: 0, truncated: false });
    mocks.listLibrary.mockResolvedValue({ items: [], maxItems: 1000 });
    mocks.listSourceFolders.mockResolvedValue({ items: [], nextCursor: null });
  });

  // 2026-09-23 plan §5.5, mockup m07b: the title and its two buttons, and under
  // them one sentence. No definition of the page, no list of formats, and no
  // second 「上传」 in the empty state repeating the header's.
  it("is its title, 连接网盘 and 上传, and when empty one sentence — nothing under the title", async () => {
    render(<KnowledgePage />);
    const heading = screen.getByRole("heading", { level: 1, name: "知识库" });
    expect(heading.closest("header")?.querySelectorAll("p")).toHaveLength(0);
    expect(screen.queryByText(/你放进来的资料/)).not.toBeInTheDocument();

    const empty = await screen.findByText("还没有资料。拖进来，或点右上角上传。");
    // The empty state is that one sentence: no second line and no button.
    const state = empty.parentElement!;
    expect(within(state).queryAllByRole("button")).toEqual([]);
    expect(state.textContent).toBe("还没有资料。拖进来，或点右上角上传。");
    expect(screen.getAllByRole("button", { name: "上传" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "连接网盘" })).toBeInTheDocument();
    // Nothing to filter or search yet.
    expect(screen.queryByRole("group", { name: "资料状态" })).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/支持 PDF/)).not.toBeInTheDocument();
  });

  it("offers search and the status filters once there is something in it", async () => {
    mocks.listSources.mockResolvedValue({ items: [source], nextCursor: null });
    render(<KnowledgePage />);
    expect(await screen.findByText("ASPREE.pdf")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索资料" })).toBeInTheDocument();
    const filters = screen.getByRole("group", { name: "资料状态" });
    expect(within(filters).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部", "需要处理", "读取中", "已读取"]);
    // No progress box above the list: a row says its own state.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
