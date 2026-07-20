import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebTasksCard } from "./WebTasksCard";

const mocks = vi.hoisted(() => ({
  listWebTasks: vi.fn(),
  cancelWebTask: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  listWebTasks: mocks.listWebTasks,
  cancelWebTask: mocks.cancelWebTask,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("WebTasksCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders hosted tasks and cancels a running task", async () => {
    mocks.listWebTasks.mockResolvedValue([
      {
        id: "task_1",
        command: "write_workspace_file",
        status: "running",
        userId: "alice",
        projectId: "paper1",
        createdAt: "2026-01-01T00:00:00.000Z",
        queuedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        finishedAt: null,
        error: null,
      },
    ]);
    mocks.cancelWebTask.mockResolvedValue({
      id: "task_1",
      command: "write_workspace_file",
      status: "canceled",
      userId: "alice",
      projectId: "paper1",
      createdAt: "2026-01-01T00:00:00.000Z",
      queuedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      finishedAt: "2026-01-01T00:00:02.000Z",
      error: { code: "task_canceled", message: "Task was canceled." },
    });

    render(<WebTasksCard />);

    expect(await screen.findByText("write_workspace_file")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("取消 write_workspace_file"));

    await waitFor(() => expect(mocks.cancelWebTask).toHaveBeenCalledWith("task_1"));
    expect(await screen.findByText("canceled")).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    mocks.listWebTasks.mockResolvedValue([]);

    render(<WebTasksCard />);

    expect(await screen.findByText("该项目暂无任务。")).toBeInTheDocument();
  });
});
