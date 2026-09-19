import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebProjectsCard } from "./WebProjectsCard";
import { projectMetaLine } from "@/lib/projectNames";

type Project = { id: string; name: string; runCount?: number; lastActivityAt?: string | null };

const mocks = vi.hoisted(() => ({
  projectId: "default",
  projects: [] as Project[],
  listWebProjects: vi.fn(),
  exportWebProject: vi.fn(),
  deleteWebProject: vi.fn(),
  fetchWebMe: vi.fn(),
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
  setWebProjectId: (projectId: string) => {
    mocks.projectId = projectId;
  },
  listWebProjects: mocks.listWebProjects,
  exportWebProject: mocks.exportWebProject,
  deleteWebProject: mocks.deleteWebProject,
  fetchWebMe: mocks.fetchWebMe,
}));

vi.mock("@/lib/projects", () => ({
  useProjectStore: {
    getState: () => ({ select: mocks.select, load: mocks.load, create: mocks.create, rename: mocks.rename }),
  },
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

function row(name: string): HTMLElement {
  return screen.getByText(name, { selector: "span" }).closest("li")!;
}

describe("WebProjectsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectId = "default";
    mocks.projects = [
      { id: "default", name: "我的研究", runCount: 12, lastActivityAt: new Date(Date.now() - 3 * 3_600_000).toISOString() },
      { id: "paper1", name: "Paper 1", runCount: 0, lastActivityAt: null },
    ];
    mocks.listWebProjects.mockImplementation(async () => mocks.projects);
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
    mocks.fetchWebMe.mockImplementation(async () => ({
      user: { id: "alice", name: "Alice" },
      project: mocks.projects.find((project) => project.id === mocks.projectId),
      projects: mocks.projects,
    }));
    mocks.select.mockImplementation(async (projectId: string) => {
      mocks.projectId = projectId;
      await mocks.fetchWebMe();
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:project-archive"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows what each project holds, and never its id", async () => {
    render(<WebProjectsCard />);

    await screen.findByText("我的研究");
    expect(within(row("我的研究")).getByText("当前")).toBeInTheDocument();
    expect(within(row("我的研究")).getByText("12 次运行 · 最近活动 3 小时前")).toBeInTheDocument();
    expect(within(row("Paper 1")).getByText("还没有运行")).toBeInTheDocument();
    expect(screen.queryByText("paper1")).not.toBeInTheDocument();
    expect(screen.queryByText(/default/)).not.toBeInTheDocument();
  });

  it("switches the active project through the project store", async () => {
    const onProjectChange = vi.fn();
    render(<WebProjectsCard onProjectChange={onProjectChange} />);

    await screen.findByText("Paper 1");
    fireEvent.click(screen.getByRole("button", { name: "切换到「Paper 1」" }));

    await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("paper1"));
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledWith(expect.objectContaining({ id: "paper1", name: "Paper 1" })));
  });

  it("creates a project from its name alone, in any language, then switches to it", async () => {
    render(<WebProjectsCard />);

    await screen.findByText("我的研究");
    fireEvent.change(screen.getByRole("textbox", { name: "新建项目" }), {
      target: { value: "心衰 GDMT 综述" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("心衰 GDMT 综述"));
    await waitFor(() => expect(mocks.projectId).toBe("p-1a2b3c4d"));
    expect(await screen.findByText("心衰 GDMT 综述")).toBeInTheDocument();
    // The sidebar's project list reads the shared store, which is refreshed too.
    expect(mocks.load).toHaveBeenCalled();
  });

  it("refuses a name longer than the server accepts, without calling the API", async () => {
    render(<WebProjectsCard />);

    await screen.findByText("我的研究");
    const input = screen.getByRole("textbox", { name: "新建项目" });
    // The input caps typing at 40; a paste can still arrive longer.
    fireEvent.change(input, { target: { value: "长".repeat(41) } });
    fireEvent.submit(input.closest("form")!);

    expect(await screen.findByText("项目名最多 40 个字。")).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("renames a project in place", async () => {
    render(<WebProjectsCard />);

    await screen.findByText("Paper 1");
    fireEvent.click(screen.getByRole("button", { name: "重命名「Paper 1」" }));
    const input = screen.getByRole("textbox", { name: "「Paper 1」的新名字" });
    fireEvent.change(input, { target: { value: "论文一" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mocks.rename).toHaveBeenCalledWith("paper1", "论文一"));
    expect(await screen.findByText("论文一")).toBeInTheDocument();
  });

  it("exports a project archive", async () => {
    render(<WebProjectsCard />);

    await screen.findByText("Paper 1");
    fireEvent.click(screen.getByRole("button", { name: "导出「Paper 1」" }));

    await waitFor(() => expect(mocks.exportWebProject).toHaveBeenCalledWith("paper1"));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已导出「Paper 1」。");
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("confirms deletion in a dialog and protects the default project", async () => {
    render(<WebProjectsCard />);

    await screen.findByText("我的研究");
    expect(screen.getByRole("button", { name: "删除「我的研究」" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "删除「Paper 1」" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除项目「Paper 1」？" });
    expect(within(dialog).getByText(/无法恢复/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除项目" }));

    await waitFor(() => expect(mocks.deleteWebProject).toHaveBeenCalledWith("paper1"));
    await waitFor(() => expect(screen.queryByText("Paper 1")).not.toBeInTheDocument());
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已删除「Paper 1」。");
    expect(mocks.load).toHaveBeenCalled();
  });

  // Setting the header alone, as this did, left the sidebar and the page on a
  // project that no longer exists; the move goes through the store they are
  // keyed on.
  it("moves the shell to 「我的研究」 through the project store when the project it is in is deleted", async () => {
    mocks.projectId = "paper1";
    render(<WebProjectsCard />);

    await screen.findByText("Paper 1");
    fireEvent.click(screen.getByRole("button", { name: "删除「Paper 1」" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除项目" }));

    await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("default"));
    expect(mocks.projectId).toBe("default");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已删除「Paper 1」。");
    expect(mocks.load).toHaveBeenCalled();
  });

  // The project is gone either way; a refused move is not a failed deletion,
  // and the list refresh falls back to 「我的研究」 by itself.
  it("still reports the deletion when the move afterwards is refused", async () => {
    mocks.projectId = "paper1";
    mocks.select.mockRejectedValue(new Error("该项目当前不可用。"));
    render(<WebProjectsCard />);

    await screen.findByText("Paper 1");
    fireEvent.click(screen.getByRole("button", { name: "删除「Paper 1」" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除项目" }));

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("已删除「Paper 1」。"));
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalled();
  });

  it("cancels a deletion without touching the project", async () => {
    render(<WebProjectsCard />);

    await screen.findByText("Paper 1");
    fireEvent.click(screen.getByRole("button", { name: "删除「Paper 1」" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mocks.deleteWebProject).not.toHaveBeenCalled();
  });
});

describe("projectMetaLine", () => {
  const now = Date.parse("2026-09-18T12:00:00Z");

  it("says how many runs and when the project was last used", () => {
    expect(projectMetaLine({ id: "a", name: "A", runCount: 3, lastActivityAt: "2026-09-18T11:30:00Z" }, now)).toBe(
      "3 次运行 · 最近活动 30 分钟前",
    );
  });

  it("says a project has no runs yet, and leaves out what the list does not carry", () => {
    expect(projectMetaLine({ id: "a", name: "A", runCount: 0, lastActivityAt: null }, now)).toBe("还没有运行");
    expect(projectMetaLine({ id: "a", name: "A" }, now)).toBe("");
  });
});
