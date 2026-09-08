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

it("opens the exact digest without resolving its notice or hiding an already-read link", async () => {
  const digestNotice = { ...review, id: "digest-notice", projectId: "another-owned-project",
    source: { type: "digest" as const, id: "digest-owned" },
    actions: [{ id: "open", label: "查看简报", style: "neutral" as const }],
    readAt: "2026-09-06T00:01:00Z", resolvedAt: "2026-09-06T00:01:00Z" };
  vi.mocked(api.listInbox).mockResolvedValue({ items: [digestNotice], nextCursor: null });
  render(<InboxPage />);
  const link = await screen.findByRole("link", { name: "查看简报" });
  expect(link).toHaveAttribute("href", "/app/autopilot?digest=digest-owned");
  expect(api.resolveInboxItem).not.toHaveBeenCalled();
  expect(api.markInboxRead).not.toHaveBeenCalled();
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

it("opens the run a notice names, and keeps that link after the notice is handled", async () => {
  // The inbox was the one surface that named a run and then offered no way to
  // reach it: the card rendered no control, so a reader who was told their
  // research had finished had to go and find it by hand in a list ordered by
  // time. RunsPage has accepted `?run=` since the sidebar started linking to
  // it; nothing was ever pointed at it from here.
  const runNotice = { ...review, id: "run-finished", noticeType: "notify" as const,
    title: "交付物未通过质量门",
    body: "这次运行没有通过交付前的质量门。\n本次运行产出 8 个文件，仍在工作区里，可以直接打开。",
    source: { type: "run" as const, id: "run_abc123" },
    actions: [{ id: "open", label: "查看运行", style: "primary" as const }],
    readAt: "2026-09-06T00:01:00Z", resolvedAt: "2026-09-06T00:01:00Z" };
  vi.mocked(api.listInbox).mockResolvedValue({ items: [runNotice], nextCursor: null });

  render(<InboxPage />);

  const link = await screen.findByRole("link", { name: "查看运行" });
  expect(link).toHaveAttribute("href", "/app/runs?run=run_abc123");
  // Opening a run is navigation, not a decision, so a handled notice must not
  // hide it — and it must not resolve anything on the way.
  expect(api.resolveInboxItem).not.toHaveBeenCalled();
  expect(api.markInboxRead).not.toHaveBeenCalled();
});

it("says which outcome a finished run had, and that its files are still there", async () => {
  // Both run-finished bodies used to be fixed strings chosen by whether the run
  // succeeded, so a refused package, a stall timer and a spend ceiling all
  // arrived under one sentence and the reader had to open the run to learn
  // which. The server now writes the reason and the file count.
  const runNotice = { ...review, id: "run-unverified", noticeType: "notify" as const,
    title: "研究已交付，待你复核",
    body: "结果已交付，但有质量检查没有通过，需要你自己复核后再使用。\n本次运行产出 3 个文件，仍在工作区里，可以直接打开。",
    source: { type: "run" as const, id: "run_xyz" },
    actions: [{ id: "open", label: "查看运行", style: "primary" as const }] };
  vi.mocked(api.listInbox).mockResolvedValue({ items: [runNotice], nextCursor: null });

  render(<InboxPage />);

  expect(await screen.findByText("研究已交付，待你复核")).toBeInTheDocument();
  expect(screen.getByText(/需要你自己复核后再使用/)).toBeInTheDocument();
  expect(screen.getByText(/本次运行产出 3 个文件，仍在工作区里/)).toBeInTheDocument();
});
