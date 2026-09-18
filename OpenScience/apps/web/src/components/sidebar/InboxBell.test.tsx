import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InboxBell, inboxBellLabel, unreadBadgeText } from "./InboxBell";

const mocks = vi.hoisted(() => ({ fetchInboxUnreadCount: vi.fn() }));

vi.mock("@/lib/inboxClient", () => ({
  fetchInboxUnreadCount: mocks.fetchInboxUnreadCount,
  INBOX_CHANGED_EVENT: "evimed:inbox-changed",
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the inbox bell", () => {
  // The count used to be one 50-item page's length, so 「99+」 was dead code.
  it("shows the server's total, and 99+ past ninety-nine", async () => {
    mocks.fetchInboxUnreadCount.mockResolvedValue({ unreadTotal: 137, safetyUnread: 0 });
    render(<MemoryRouter><InboxBell /></MemoryRouter>);
    const bell = await screen.findByRole("button", { name: "收件箱，137 条未读" });
    expect(bell).toHaveTextContent("99+");
    expect(unreadBadgeText(99)).toBe("99");
    expect(unreadBadgeText(100)).toBe("99+");
  });

  it("shows no badge at zero and when the count cannot be read", async () => {
    mocks.fetchInboxUnreadCount.mockRejectedValue(new Error("down"));
    render(<MemoryRouter><InboxBell /></MemoryRouter>);
    const bell = await screen.findByRole("button", { name: "收件箱" });
    await waitFor(() => expect(mocks.fetchInboxUnreadCount).toHaveBeenCalled());
    expect(bell.textContent).toBe("");
  });

  // Safety is the one class allowed to interrupt, so it is told apart by
  // shape and by words, not by a second shade of red.
  it("changes shape and says so when an unread item is a clinical-safety finding", async () => {
    mocks.fetchInboxUnreadCount.mockResolvedValue({ unreadTotal: 3, safetyUnread: 1 });
    render(<MemoryRouter><InboxBell /></MemoryRouter>);
    const bell = await screen.findByRole("button", { name: "收件箱，3 条未读，其中 1 条涉及临床安全" });
    expect(bell).toHaveAttribute("data-safety", "true");
    expect(inboxBellLabel({ unreadTotal: 3, safetyUnread: 0 })).toBe("收件箱，3 条未读");
  });

  // Marking everything read on the inbox page must not leave the badge saying
  // otherwise for another minute.
  it("re-reads the count as soon as a page says the inbox changed", async () => {
    mocks.fetchInboxUnreadCount.mockResolvedValueOnce({ unreadTotal: 4, safetyUnread: 0 });
    render(<MemoryRouter><InboxBell /></MemoryRouter>);
    await screen.findByRole("button", { name: "收件箱，4 条未读" });
    mocks.fetchInboxUnreadCount.mockResolvedValueOnce({ unreadTotal: 0, safetyUnread: 0 });
    await act(async () => { window.dispatchEvent(new Event("evimed:inbox-changed")); });
    expect(await screen.findByRole("button", { name: "收件箱" })).toBeInTheDocument();
  });
});
