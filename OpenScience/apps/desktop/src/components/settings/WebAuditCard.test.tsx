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

    expect(await screen.findByText("托管审计")).toBeInTheDocument();
    expect(screen.getByText("file.upload")).toBeInTheDocument();
    expect(screen.getByText("inputs/data.csv")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
    expect(screen.getByText("command.write_workspace_file")).toBeInTheDocument();
    expect(screen.queryByText("internal path detail")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.listWebAuditLog).toHaveBeenCalledWith(20));
  });

  it("shows an empty state", async () => {
    mocks.listWebAuditLog.mockResolvedValue([]);

    render(<WebAuditCard />);

    expect(await screen.findByText("暂无近期审计事件。")).toBeInTheDocument();
  });
});
