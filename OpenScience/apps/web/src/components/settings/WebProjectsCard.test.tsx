import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebProjectsCard } from "./WebProjectsCard";

const mocks = vi.hoisted(() => ({
  projectId: "default",
  projects: [
    { id: "default", name: "Default Project" },
    { id: "paper1", name: "Paper 1" },
  ],
  listWebProjects: vi.fn(),
  createWebProject: vi.fn(),
  exportWebProject: vi.fn(),
  deleteWebProject: vi.fn(),
  fetchWebMe: vi.fn(),
  select: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  getWebProjectId: () => mocks.projectId,
  setWebProjectId: (projectId: string) => {
    mocks.projectId = projectId;
  },
  listWebProjects: mocks.listWebProjects,
  createWebProject: mocks.createWebProject,
  exportWebProject: mocks.exportWebProject,
  deleteWebProject: mocks.deleteWebProject,
  fetchWebMe: mocks.fetchWebMe,
}));

vi.mock("@/lib/projects", () => ({
  useProjectStore: {
    getState: () => ({ select: mocks.select }),
  },
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

describe("WebProjectsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectId = "default";
    mocks.projects = [
      { id: "default", name: "Default Project" },
      { id: "paper1", name: "Paper 1" },
    ];
    mocks.listWebProjects.mockImplementation(async () => mocks.projects);
    mocks.createWebProject.mockImplementation(async (id: string, name: string) => {
      const project = { id, name };
      mocks.projects = [...mocks.projects, project];
      return project;
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

  it("switches the active hosted project through the project store", async () => {
    const onProjectChange = vi.fn();
    render(<WebProjectsCard onProjectChange={onProjectChange} />);

    expect(await screen.findByText("Default Project")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Paper 1").closest("button")!);

    await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("paper1"));
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledWith({ id: "paper1", name: "Paper 1" }));
  });

  it("creates a hosted project before switching to it", async () => {
    render(<WebProjectsCard />);

    await screen.findByText("Default Project");
    fireEvent.change(screen.getByRole("textbox", { name: "项目 id" }), {
      target: { value: "review_2026" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称" }), {
      target: { value: "Review 2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(mocks.createWebProject).toHaveBeenCalledWith("review_2026", "Review 2026"),
    );
    await waitFor(() => expect(mocks.projectId).toBe("review_2026"));
    expect(await screen.findByText("Review 2026")).toBeInTheDocument();
  });

  it("validates hosted project ids before calling the API", async () => {
    render(<WebProjectsCard />);

    await screen.findByText("Default Project");
    fireEvent.change(screen.getByRole("textbox", { name: "项目 id" }), {
      target: { value: "../private" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText("只能使用字母、数字、连字符或下划线。")).toBeInTheDocument();
    expect(mocks.createWebProject).not.toHaveBeenCalled();
  });

  it("exports a hosted project archive", async () => {
    render(<WebProjectsCard />);

    await screen.findByText("Default Project");
    fireEvent.click(screen.getByRole("button", { name: "导出 Paper 1" }));

    await waitFor(() => expect(mocks.exportWebProject).toHaveBeenCalledWith("paper1"));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已导出 Paper 1。");
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("confirms hosted project deletion and protects the default project", async () => {
    render(<WebProjectsCard />);

    await screen.findByText("Default Project");
    expect(screen.getByRole("button", { name: "删除 Default Project" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "删除 Paper 1" }));
    expect(await screen.findByText("删除 Paper 1？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除项目" }));

    await waitFor(() => expect(mocks.deleteWebProject).toHaveBeenCalledWith("paper1"));
    await waitFor(() => expect(screen.queryByText("Paper 1")).not.toBeInTheDocument());
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已删除 Paper 1。");
  });
});
