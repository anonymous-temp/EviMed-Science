import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSecurityCard } from "./WebSecurityCard";

const mocks = vi.hoisted(() => ({
  listWebSecurityEvents: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  listWebSecurityEvents: mocks.listWebSecurityEvents,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("WebSecurityCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders current-account security events", async () => {
    mocks.listWebSecurityEvents.mockResolvedValue([
      {
        createdAt: "2026-01-01T12:00:00.000Z",
        action: "auth.login",
        status: "failed",
        username: "alice",
        userId: null,
        code: "invalid_credentials",
      },
      {
        createdAt: "2026-01-01T12:01:00.000Z",
        action: "auth.logout",
        status: "completed",
        username: null,
        userId: "alice",
        code: null,
      },
    ]);

    render(<WebSecurityCard />);

    expect(await screen.findByText("托管安全")).toBeInTheDocument();
    expect(screen.getByText("auth.login")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("invalid_credentials")).toBeInTheDocument();
    expect(screen.getByText("auth.logout")).toBeInTheDocument();
    expect(screen.queryByText("bob")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.listWebSecurityEvents).toHaveBeenCalledWith(20));
  });

  it("shows an empty state", async () => {
    mocks.listWebSecurityEvents.mockResolvedValue([]);

    render(<WebSecurityCard />);

    expect(await screen.findByText("暂无近期安全事件。")).toBeInTheDocument();
  });
});
