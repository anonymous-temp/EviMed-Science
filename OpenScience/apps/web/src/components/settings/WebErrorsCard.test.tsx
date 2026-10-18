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


/** The page as a reader has it: tooltips (hidden until the pointer or the keyboard asks) taken out. */
function visibleText() {
  const copy = document.body.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[role="tooltip"]').forEach((node) => node.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ");
}

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

    expect(await screen.findByText("错误账本")).toBeInTheDocument();
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByText("/api/files/preview/:path")).toBeInTheDocument();
    // What went wrong is said in words; the code and the request id are one copy button's, not page text.
    expect(screen.getByText("其他错误")).toBeInTheDocument();
    expect(visibleText()).not.toMatch(/file_not_found|req_123/);
    expect(screen.getByRole("button", { name: "复制错误标识" })).toBeInTheDocument();
    expect(screen.queryByText(/auth_token|private\/report/i)).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.listWebErrorEvents).toHaveBeenCalledWith(20));
  });

  it("shows an empty state", async () => {
    mocks.listWebErrorEvents.mockResolvedValue([]);

    render(<WebErrorsCard />);

    expect(await screen.findByText("暂无近期 API 错误。")).toBeInTheDocument();
  });
});
