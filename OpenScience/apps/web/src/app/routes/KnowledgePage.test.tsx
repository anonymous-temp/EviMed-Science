import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@/lib/sourceClient";
import { KnowledgePage } from "./KnowledgePage";

const mocks = vi.hoisted(() => ({
  listSources: vi.fn(), listDuplicateCandidates: vi.fn(), listSourceFolders: vi.fn(), listGeoProjects: vi.fn(), getVcrHome: vi.fn(),
}));
vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()), ...mocks }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({ ...(await importOriginal<object>()), listGeoProjects: mocks.listGeoProjects }));
vi.mock("@/lib/vcrClient", async (importOriginal) => ({ ...(await importOriginal<object>()), getVcrHome: mocks.getVcrHome }));
vi.mock("@/lib/backend", () => ({ pickFiles: vi.fn(async () => []), uploadFilesToWorkspace: vi.fn(async () => []) }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<object>()),
  hasWebApi: true,
  getWebProjectId: () => "project-one",
  // A deployment with a drive mounted: 从网盘导入 is offered only then.
  fetchWebMe: async () => ({ user: { id: "u", name: "u" }, operator: false, project: { id: "project-one", name: "p" }, projects: [],
    features: { openList: true } }),
}));

const source = {
  id: "source-one", projectId: "project-one", revision: 1, createdAt: "2026-09-22T08:00:00Z", updatedAt: "2026-09-22T08:00:00Z", deletedAt: null, readable: true,
  display: { title: "ASPREE.pdf", gist: null, docType: "published-paper", typeLabel: "已发表论文", typeShort: "论文", kind: "literature", origin: "upload", format: "pdf",
    pages: 14, size: 1000, site: null, url: null, shared: false },
  payload: { paths: ["knowledge-base/ASPREE.pdf"], status: "complete", docType: "published-paper", depth: "structured", version: 1,
    reasons: [], valueVector: {}, coverage: null, outputs: {}, analysis: { pageCount: 14 } },
} as unknown as SourceRecord;
const counts = (overrides: Record<string, number> = {}) => ({ all: 0, literature: 0, table: 0, document: 0, page: 0, note: 0, image: 0, ...overrides });

describe("知识库", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listSources.mockResolvedValue({ items: [], nextCursor: null, counts: counts() });
    mocks.listDuplicateCandidates.mockResolvedValue({ items: [], scanned: 0, truncated: false });
    mocks.listSourceFolders.mockResolvedValue({ items: [], nextCursor: null });
    mocks.listGeoProjects.mockResolvedValue([]);
    mocks.getVcrHome.mockResolvedValue({ studies: [] });
  });

  // 2026-10-07 plan §2.3, mockup k01: the title, the scope, a search and the one 「添加」; when empty, one sentence about
  // what to put in — a place for whatever a researcher hands over, not a library of clinical papers.
  it("is its title, the scope it lists, a search and one 「添加」, and when empty one sentence — nothing under the title", async () => {
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);
    const heading = screen.getByRole("heading", { level: 1, name: "知识库" });
    expect(heading.closest("header")?.querySelectorAll("p")).toHaveLength(0);
    expect(screen.queryByText(/你放进来的资料/)).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索资料和内容" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^范围：/ })).toBeInTheDocument();

    const empty = await screen.findByText("把文献、指南、方案、数据表、网页或笔记放进来，对话里会读它们并标出处。");
    // The empty state is that one sentence and the one button; the header's is the same menu.
    expect(within(empty.parentElement!).getAllByRole("button")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "添加" })).toHaveLength(2);
    expect(screen.queryByRole("group", { name: "资料类型" })).not.toBeInTheDocument();
    expect(screen.queryByText(/支持 PDF/)).not.toBeInTheDocument();
    expect(screen.queryByText(/临床/)).not.toBeInTheDocument();
  });

  it("shows the chips by content once there is more than one kind, and never reading state", async () => {
    mocks.listSources.mockResolvedValue({ items: [source], nextCursor: null, counts: counts({ all: 3, literature: 2, document: 1 }) });
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);
    expect(await screen.findByText("ASPREE.pdf")).toBeInTheDocument();
    const chips = screen.getByRole("group", { name: "资料类型" });
    expect(within(chips).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部3", "文献与指南2", "文档1"]);
    expect(screen.queryByRole("group", { name: "资料状态" })).not.toBeInTheDocument();
    // No progress box above the list: a row says its own state.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
