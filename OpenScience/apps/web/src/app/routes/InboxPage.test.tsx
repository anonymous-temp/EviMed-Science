import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { InboxPage } from "./InboxPage";
import * as api from "@/lib/inboxClient";

vi.mock("@/lib/inboxClient");
const review = {
  id: "review-one", noticeType: "review", priority: 0, title: "审阅一个研究结论", body: "证据之间存在冲突。",
  actions: [{ id: "adopt", label: "采纳", style: "primary" }, { id: "reject", label: "驳回", style: "danger" }],
  count: 1, readAt: null, resolvedAt: null, resolution: null, revision: 1, createdAt: "2026-09-06T00:00:00Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listInbox).mockResolvedValue({ items: [review], nextCursor: null });
  vi.mocked(api.inboxErrorMessage).mockImplementation(() => "操作未完成，请重试。");
});

it("shows blocking reviews first and resolves a selected action", async () => {
  vi.mocked(api.resolveInboxItem).mockResolvedValue({ ...review, revision: 2, resolvedAt: "2026-09-06T00:01:00Z", resolution: { actionId: "adopt" } });
  render(<InboxPage />);
  expect(await screen.findByText("审阅一个研究结论")).toBeInTheDocument();
  expect(screen.getByText("需要审阅")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "采纳" }));
  await waitFor(() => expect(api.resolveInboxItem).toHaveBeenCalledWith("review-one", "adopt", 1));
  expect(await screen.findByText("已处理")).toBeInTheDocument();
});

it("marks an informational item read and preserves errors for retry", async () => {
  const notice = { ...review, id: "notice-one", noticeType: "notify", priority: 2, title: "研究完成", actions: [] };
  vi.mocked(api.listInbox).mockResolvedValue({ items: [notice], nextCursor: null });
  vi.mocked(api.markInboxRead).mockRejectedValue(new Error("network"));
  render(<InboxPage />);
  await userEvent.click(await screen.findByRole("button", { name: "标为已读" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请重试。");
  expect(screen.getByRole("button", { name: "标为已读" })).toBeInTheDocument();
});

it("filters unread items and has a truthful empty state", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({ items: [], nextCursor: null });
  render(<InboxPage />);
  await userEvent.click(screen.getByRole("radio", { name: "未读" }));
  await waitFor(() => expect(api.listInbox).toHaveBeenLastCalledWith({ unread: true }));
  expect(await screen.findByText("没有未读消息")).toBeInTheDocument();
});
