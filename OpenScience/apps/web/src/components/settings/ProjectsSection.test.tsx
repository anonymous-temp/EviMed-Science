import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectMetaLine } from "@/lib/projectNames";
import { ProjectsSection } from "./ProjectsSection";

type Project = { id: string; name: string; runCount?: number; lastActivityAt?: string | null };

const mocks = vi.hoisted(() => ({
  projectId: "default",
  projects: [] as Project[],
  listWebProjects: vi.fn(),
  exportWebProject: vi.fn(),
  deleteWebProject: vi.fn(),
  listWebAgentRuns: vi.fn(),
  archiveWebAgentRun: vi.fn(),
  select: vi.fn(),
  load: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  getWebProjectId: () => mocks.projectId,
  listWebProjects: mocks.listWebProjects,
  exportWebProject: mocks.exportWebProject,
  deleteWebProject: mocks.deleteWebProject,
  listWebAgentRuns: mocks.listWebAgentRuns,
  archiveWebAgentRun: mocks.archiveWebAgentRun,
}));

vi.mock("@/lib/projects", () => {
  const state = () => ({ currentId: mocks.projectId, select: mocks.select, load: mocks.load, create: mocks.create, rename: mocks.rename });
  const useProjectStore = Object.assign((selector: (value: ReturnType<typeof state>) => unknown) => selector(state()), { getState: state });
  return { useProjectStore };
});

vi.mock("@/lib/toast", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

function open() {
  return render(<MemoryRouter><ProjectsSection /></MemoryRouter>);
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest("li")!;
}

describe("项目", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectId = "default";
    mocks.projects = [
      { id: "default", name: "我的研究", runCount: 12, lastActivityAt: new Date(Date.now() - 3 * 3_600_000).toISOString() },
      { id: "paper1", name: "Paper 1", runCount: 0, lastActivityAt: null },
    ];
    mocks.listWebProjects.mockImplementation(async () => mocks.projects);
    mocks.listWebAgentRuns.mockResolvedValue([]);
    mocks.create.mockImplementation(async (name: string) => {
      const project = { id: "p-1a2b3c4d", name };
      mocks.projects = [...mocks.projects, project];
      return project;
    });
    mocks.rename.mockImplementation(async (id: string, name: string) => {
      mocks.projects = mocks.projects.map((project) => (project.id === id ? { ...project, name } : project));
      return mocks.projects.find((project) => project.id === id);
    });
    mocks.exportWebProject.mockResolvedValue(new Blob(["archive"]));
    mocks.deleteWebProject.mockImplementation(async (id: string) => {
      mocks.projects = mocks.projects.filter((project) => project.id !== id);
    });
    mocks.select.mockImplementation(async (projectId: string) => { mocks.projectId = projectId; });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:project-archive") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("lists each project as a row: its name, when it was last used, and 当前 — never its id or a 切换", async () => {
    open();
    await screen.findByText("我的研究");
    expect(within(row("我的研究")).getByText("当前")).toBeInTheDocument();
    expect(within(row("我的研究")).getByText("最近活动 3 小时前")).toBeInTheDocument();
    expect(within(row("Paper 1")).queryByText("当前")).not.toBeInTheDocument();
    expect(screen.queryByText(/次运行/)).not.toBeInTheDocument();
    expect(screen.queryByText("paper1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /切换/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/一个项目 =/)).not.toBeInTheDocument();
    // The plugins card and the data-flow card are not a researcher's.
    expect(screen.queryByText(/项目插件|隐私与数据流向/)).not.toBeInTheDocument();
  });

  it("offers 重命名 and 导出 on hover, and 删除 in the row's 「⋯」", async () => {
    open();
    await screen.findByText("Paper 1");
    const rename = within(row("Paper 1")).getByRole("button", { name: "重命名「Paper 1」" });
    expect(rename.parentElement).toHaveClass("opacity-0", "group-hover/row:opacity-100");
    expect(within(row("Paper 1")).getByRole("button", { name: "导出「Paper 1」" })).toBeInTheDocument();
    expect(within(row("Paper 1")).getByRole("button", { name: "「Paper 1」的更多操作" })).toBeInTheDocument();
    // The account's own project cannot be deleted, so it has no 「⋯」.
    expect(within(row("我的研究")).queryByRole("button", { name: /更多操作/ })).not.toBeInTheDocument();
  });

  it("creates a project from its name alone, then moves the shell into it", async () => {
    open();
    await screen.findByText("我的研究");
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新项目名" }), { target: { value: "心衰 GDMT 综述" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("心衰 GDMT 综述"));
    await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("p-1a2b3c4d"));
    expect(await screen.findByText("心衰 GDMT 综述")).toBeInTheDocument();
    expect(mocks.load).toHaveBeenCalled();
  });

  it("refuses a name longer than the server accepts, without calling the API", async () => {
    open();
    await screen.findByText("我的研究");
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    const input = screen.getByRole("textbox", { name: "新项目名" });
    fireEvent.change(input, { target: { value: "长".repeat(41) } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText("项目名最多 40 个字。")).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("renames a project in place", async () => {
    open();
    await screen.findByText("Paper 1");
    fireEvent.click(screen.getByRole("button", { name: "重命名「Paper 1」" }));
    fireEvent.change(screen.getByRole("textbox", { name: "「Paper 1」的新名字" }), { target: { value: "论文一" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.rename).toHaveBeenCalledWith("paper1", "论文一"));
    expect(await screen.findByText("论文一")).toBeInTheDocument();
  });

  it("exports a project archive", async () => {
    open();
    await screen.findByText("Paper 1");
    fireEvent.click(screen.getByRole("button", { name: "导出「Paper 1」" }));
    await waitFor(() => expect(mocks.exportWebProject).toHaveBeenCalledWith("paper1"));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已导出「Paper 1」");
  });

  it("deletes after a confirmation, and moves the shell to 「我的研究」 when it was in that project", async () => {
    mocks.projectId = "paper1";
    open();
    await screen.findByText("Paper 1");
    fireEvent.click(within(row("Paper 1")).getByRole("button", { name: "「Paper 1」的更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除项目「Paper 1」？" });
    expect(within(dialog).getByText(/无法恢复/)).toBeInTheDocument();
    expect(mocks.deleteWebProject).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除项目" }));
    await waitFor(() => expect(mocks.deleteWebProject).toHaveBeenCalledWith("paper1"));
    await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("default"));
    await waitFor(() => expect(screen.queryByText("Paper 1")).not.toBeInTheDocument());
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已删除「Paper 1」");
    expect(mocks.load).toHaveBeenCalled();
  });

  it("still reports a deletion when the move afterwards is refused", async () => {
    mocks.projectId = "paper1";
    mocks.select.mockRejectedValue(new Error("该项目当前不可用。"));
    open();
    await screen.findByText("Paper 1");
    fireEvent.click(within(row("Paper 1")).getByRole("button", { name: "「Paper 1」的更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除项目" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("已删除「Paper 1」"));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("keeps this project's archived conversations, each opening the conversation, with 恢复", async () => {
    mocks.listWebAgentRuns.mockResolvedValue([{
      id: "run_1", sessionId: "ses_1", title: "阿司匹林一级预防", startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      finishedAt: null, archived: true,
    }]);
    mocks.archiveWebAgentRun.mockResolvedValue({});
    open();
    const link = await screen.findByRole("link", { name: "阿司匹林一级预防" });
    expect(link).toHaveAttribute("href", "/app/chat/ses_1");
    expect(mocks.listWebAgentRuns).toHaveBeenCalledWith({ projectId: "default", archived: true });
    fireEvent.click(screen.getByRole("button", { name: "恢复「阿司匹林一级预防」" }));
    await waitFor(() => expect(mocks.archiveWebAgentRun).toHaveBeenCalledWith("run_1", false));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已恢复到对话列表");
  });

  it("says so in one line when nothing is archived", async () => {
    open();
    expect(await screen.findByText("没有归档的对话")).toBeInTheDocument();
    expect(screen.queryByText(/从侧栏归档的对话放在这里/)).not.toBeInTheDocument();
  });
});

describe("projectMetaLine", () => {
  const now = Date.parse("2026-09-18T12:00:00Z");

  it("says when the project was last used, and never how many runs it holds", () => {
    expect(projectMetaLine({ id: "a", name: "A", runCount: 3, lastActivityAt: "2026-09-18T11:30:00Z" }, now)).toBe("最近活动 30 分钟前");
    expect(projectMetaLine({ id: "a", name: "A", runCount: 0, lastActivityAt: null }, now)).toBe("");
    expect(projectMetaLine({ id: "a", name: "A" }, now)).toBe("");
  });
});
