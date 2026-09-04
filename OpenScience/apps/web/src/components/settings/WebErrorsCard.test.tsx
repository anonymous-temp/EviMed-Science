import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebErrorsCard } from "./WebErrorsCard";

const mocks = vi.hoisted(() => ({
  listWebErrorEvents: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  listWebErrorEvents: mocks.listWebErrorEvents,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("WebErrorsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders hosted API errors without raw paths or queries", async () => {
    mocks.listWebErrorEvents.mockResolvedValue([
      {
        createdAt: "2026-01-01T12:00:00.000Z",
        requestId: "req_123",
        method: "GET",
        route: "/api/files/preview/:path",
        status: 404,
        code: "file_not_found",
        projectId: "paper1",
      },
    ]);

    render(<WebErrorsCard />);

    expect(await screen.findByText("托管错误")).toBeInTheDocument();
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByText("/api/files/preview/:path")).toBeInTheDocument();
    expect(screen.getByText("file_not_found")).toBeInTheDocument();
    expect(screen.getByText("req_123")).toBeInTheDocument();
    expect(screen.queryByText(/auth_token|private\/report/i)).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.listWebErrorEvents).toHaveBeenCalledWith(20));
  });

  it("shows an empty state", async () => {
    mocks.listWebErrorEvents.mockResolvedValue([]);

    render(<WebErrorsCard />);

    expect(await screen.findByText("暂无近期 API 错误。")).toBeInTheDocument();
  });
});
