import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { InboxPage } from "./InboxPage";
import * as api from "@/lib/inboxClient";

vi.mock("@/lib/inboxClient");
const review: api.InboxItem = {
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
  const notice: api.InboxItem = { ...review, id: "notice-one", noticeType: "notify", priority: 2, title: "研究完成", actions: [] };
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

it("discards a late page after changing filters and prevents duplicate page requests", async () => {
  let finishPage!: (value: api.InboxPageResult) => void;
  vi.mocked(api.listInbox).mockImplementation(async ({ unread = false, cursor = null } = {}) => {
    if (unread) return { items: [], nextCursor: null };
    if (cursor) return new Promise((resolve) => { finishPage = resolve; });
    return { items: [review], nextCursor: "old-page" };
  });
  render(<InboxPage />);
  const more = await screen.findByRole("button", { name: "加载更多" });
  await userEvent.click(more);
  expect(more).toBeDisabled();
  await userEvent.click(more);
  expect(api.listInbox).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole("radio", { name: "未读" }));
  expect(await screen.findByText("没有未读消息")).toBeInTheDocument();
  finishPage({ items: [{ ...review, id: "late-review", title: "旧筛选消息" }], nextCursor: null });
  await waitFor(() => expect(screen.queryByText("旧筛选消息")).not.toBeInTheDocument());
});

it("removes a read item from the unread view and ignores a late mutation after reload", async () => {
  const notice: api.InboxItem = { ...review, id: "read-one", noticeType: "notify", priority: 2, title: "研究完成", actions: [] };
  vi.mocked(api.listInbox).mockResolvedValue({ items: [notice], nextCursor: null });
  let finishRead!: (value: api.InboxItem) => void;
  vi.mocked(api.markInboxRead).mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
  render(<InboxPage />);
  await userEvent.click(screen.getByRole("radio", { name: "未读" }));
  const read = await screen.findByRole("button", { name: "标为已读" });
  await userEvent.click(read);
  await userEvent.click(screen.getByRole("radio", { name: "全部" }));
  finishRead({ ...notice, readAt: "2026-09-06T00:01:00Z", revision: 2 });
  await waitFor(() => expect(screen.getByText("研究完成")).toBeInTheDocument());

  await userEvent.click(screen.getByRole("radio", { name: "未读" }));
  vi.mocked(api.markInboxRead).mockResolvedValue({ ...notice, readAt: "2026-09-06T00:01:00Z", revision: 2 });
  await userEvent.click(await screen.findByRole("button", { name: "标为已读" }));
  await waitFor(() => expect(screen.queryByText("研究完成")).not.toBeInTheDocument());
});

it("does not leak an old mutation failure or busy state into a reloaded filter", async () => {
  const notice: api.InboxItem = { ...review, id: "stale-read", noticeType: "notify", priority: 2, title: "旧请求", actions: [] };
  vi.mocked(api.listInbox).mockResolvedValue({ items: [notice], nextCursor: null });
  let failRead!: (error: Error) => void;
  vi.mocked(api.markInboxRead).mockImplementation(() => new Promise((_resolve, reject) => { failRead = reject; }));
  render(<InboxPage />);
  await userEvent.click(screen.getByRole("radio", { name: "未读" }));
  await userEvent.click(await screen.findByRole("button", { name: "标为已读" }));
  await userEvent.click(screen.getByRole("radio", { name: "全部" }));
  expect(await screen.findByRole("button", { name: "标为已读" })).toBeEnabled();
  failRead(new Error("old request failed"));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "标为已读" })).toBeEnabled();
});
