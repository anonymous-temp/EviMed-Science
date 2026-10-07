import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebAuditCard } from "./WebAuditCard";

const mocks = vi.hoisted(() => ({
  listWebAuditLog: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  listWebAuditLog: mocks.listWebAuditLog,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("WebAuditCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders current-project audit events", async () => {
    mocks.listWebAuditLog.mockResolvedValue([
      {
        createdAt: "2026-01-01T12:00:00.000Z",
        userId: "alice",
        projectId: "paper1",
        action: "file.upload",
        command: null,
        status: "completed",
        target: "inputs/data.csv",
        bytes: 2048,
        error: null,
      },
      {
        createdAt: "2026-01-01T12:01:00.000Z",
        userId: "alice",
        projectId: "paper1",
        action: "command.write_workspace_file",
        command: "write_workspace_file",
        status: "failed",
        target: null,
        bytes: null,
        error: "internal path detail",
      },
    ]);

    render(<WebAuditCard />);

    expect(await screen.findByText("操作审计")).toBeInTheDocument();
    // The ledger's dotted names and English status words are the log's; the row says it in Chinese and keeps them in the tooltip.
    expect(screen.getByText("上传文件")).toBeInTheDocument();
    expect(screen.getByText("运行命令")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    for (const raw of ["file.upload", "command.write_workspace_file", "completed", "failed"]) {
      for (const place of screen.getAllByText(raw)) expect(place.getAttribute("role")).toBe("tooltip");
    }
    expect(screen.getByText("inputs/data.csv")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
    expect(screen.queryByText("internal path detail")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.listWebAuditLog).toHaveBeenCalledWith(20));
  });

  it("reads a status the ledger has no word for as 未登记的状态, and an action it does not know as 其他操作", async () => {
    mocks.listWebAuditLog.mockResolvedValue([
      { createdAt: "2026-01-01T12:00:00.000Z", userId: "alice", projectId: "paper1", action: "something.new", command: null, status: "started", target: null, bytes: null, error: null },
      { createdAt: "2026-01-01T12:01:00.000Z", userId: "alice", projectId: "paper1", action: "file.upload", command: null, status: "daydreaming", target: null, bytes: null, error: null },
    ]);
    render(<WebAuditCard />);
    expect(await screen.findByText("其他操作")).toBeInTheDocument();
    expect(screen.getByText("已开始")).toBeInTheDocument();
    expect(screen.getByText("未登记的状态")).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    mocks.listWebAuditLog.mockResolvedValue([]);

    render(<WebAuditCard />);

    expect(await screen.findByText("暂无近期审计事件。")).toBeInTheDocument();
  });
});
