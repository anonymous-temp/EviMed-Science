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


/** The page as a reader has it: tooltips (hidden until the pointer or the keyboard asks) taken out. */
function visibleText() {
  const copy = document.body.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[role="tooltip"]').forEach((node) => node.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ");
}

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

    expect(await screen.findByText("安全事件")).toBeInTheDocument();
    expect(screen.getByText("登录")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    // The code is a copy button's, with the account it came from; the row says what happened.
    expect(visibleText()).not.toContain("invalid_credentials");
    expect(screen.getAllByRole("button", { name: "复制事件标识" })).toHaveLength(2);
    expect(screen.getByText("退出登录")).toBeInTheDocument();
    expect(screen.queryByText("bob")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.listWebSecurityEvents).toHaveBeenCalledWith(20));
  });

  it("shows an empty state", async () => {
    mocks.listWebSecurityEvents.mockResolvedValue([]);

    render(<WebSecurityCard />);

    expect(await screen.findByText("暂无近期安全事件。")).toBeInTheDocument();
  });
});
