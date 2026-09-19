import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibrarySection } from "./LibrarySection";

// The kb stream serves the library; this is its agreed shape, mocked here.
const library = vi.hoisted(() => ({ fetchLibrary: vi.fn(), publishToCapsule: vi.fn() }));
vi.mock("@/lib/libraryClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/libraryClient")>()), ...library }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/apiClient")>()), getWebProjectId: () => "project-a" }));
const client = vi.hoisted(() => ({ MEMORY_CHANGED_EVENT: "evimed.memory.changed", announceMemoryChanged: vi.fn() }));
vi.mock("@/lib/memoryClient", () => client);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const items = [
  { sourceId: "src_1", title: "心衰指南 2025", authors: ["王某", "李某", "张某", "赵某"], doi: "10.1000/hf.2025", kind: "review-guideline",
    addedAt: "2026-09-10T00:00:00Z", projects: ["project-a"], pageCount: 48, status: "complete" },
  { sourceId: "src_2", title: "队列数据字典", kind: "cohort-data", addedAt: "2026-09-11T00:00:00Z", projects: ["project-a"], status: "parsing" },
  { sourceId: "src_3", title: "别的项目的论文", kind: "published-paper", addedAt: "2026-09-12T00:00:00Z", projects: ["project-b"], status: "complete" },
];

function section() {
  return render(<MemoryRouter><LibrarySection /></MemoryRouter>);
}

describe("资料: the library seen from the capsule", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  it("lists this project's sources in the reader's words, and all of them on request", async () => {
    library.fetchLibrary.mockResolvedValue(items);
    section();
    expect(await screen.findByText("心衰指南 2025")).toBeInTheDocument();
    expect(screen.getByText("综述或指南")).toBeInTheDocument();
    expect(screen.getByText("王某、李某、张某 等")).toBeInTheDocument();
    expect(screen.getByText("10.1000/hf.2025")).toBeInTheDocument();
    expect(screen.getByText("48 页")).toBeInTheDocument();
    expect(screen.getByText("正在解析")).toBeInTheDocument();
    expect(screen.queryByText("别的项目的论文")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "全部" }));
    expect(screen.getByText("别的项目的论文")).toBeInTheDocument();
  });

  it("puts what was read into the capsule as sourced facts, and only once reading has finished", async () => {
    library.fetchLibrary.mockResolvedValue(items);
    library.publishToCapsule.mockResolvedValue({ facts: 5, methods: 1 });
    section();
    const [ready, reading] = await screen.findAllByRole("button", { name: "放进胶囊" });
    expect(reading).toBeDisabled();
    await userEvent.click(ready);
    expect(library.publishToCapsule).toHaveBeenCalledWith("src_1");
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已从「心衰指南 2025」放进胶囊 5 条事实、1 个方法草稿，都注明了出处"));
    expect(client.announceMemoryChanged).toHaveBeenCalled();
  });

  it("says plainly when this deployment does not serve the library, and when the read failed", async () => {
    library.fetchLibrary.mockResolvedValueOnce(null);
    section();
    expect(await screen.findByText(/这个部署还没有接入资料库的胶囊视图/)).toBeInTheDocument();
    cleanup();
    library.fetchLibrary.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([]);
    section();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText(/这个项目还没有资料/)).toBeInTheDocument();
  });
});
