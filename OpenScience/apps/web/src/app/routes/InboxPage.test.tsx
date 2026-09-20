import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { InboxPage } from "./InboxPage";
import * as api from "@/lib/inboxClient";
import { MemoryRouter } from "react-router";

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
  render(<MemoryRouter><InboxPage /></MemoryRouter>);
  const link = await screen.findByRole("link", { name: "查看简报" });
  expect(link).toHaveAttribute("href", "/app/autopilot?digest=digest-owned");
  expect(api.resolveInboxItem).not.toHaveBeenCalled();
  expect(api.markInboxRead).not.toHaveBeenCalled();
});

it("shows blocking reviews first and resolves a selected action", async () => {
  vi.mocked(api.resolveInboxItem).mockResolvedValue({ ...review, revision: 2, resolvedAt: "2026-09-06T00:01:00Z", resolution: { actionId: "adopt" } });
  render(<MemoryRouter><InboxPage /></MemoryRouter>);
  expect(await screen.findByText("审阅一个研究结论")).toBeInTheDocument();
  expect(screen.getByText("有结论要核对")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "采纳" }));
  await waitFor(() => expect(api.resolveInboxItem).toHaveBeenCalledWith("review-one", "adopt", 1));
  expect(await screen.findByText("已处理")).toBeInTheDocument();
});

it("marks an informational item read and preserves errors for retry", async () => {
  const notice: api.InboxItem = { ...review, id: "notice-one", noticeType: "notify", priority: 2, title: "研究完成", actions: [] };
  vi.mocked(api.listInbox).mockResolvedValue({ items: [notice], nextCursor: null });
  vi.mocked(api.markInboxRead).mockRejectedValue(new Error("network"));
  render(<MemoryRouter><InboxPage /></MemoryRouter>);
  await userEvent.click(await screen.findByRole("button", { name: "标为已读" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请重试。");
  expect(screen.getByRole("button", { name: "标为已读" })).toBeInTheDocument();
});

it("filters unread items and has a truthful empty state", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({ items: [], nextCursor: null });
  render(<MemoryRouter><InboxPage /></MemoryRouter>);
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
  render(<MemoryRouter><InboxPage /></MemoryRouter>);
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
  render(<MemoryRouter><InboxPage /></MemoryRouter>);
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
  render(<MemoryRouter><InboxPage /></MemoryRouter>);
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
  // time. A notice names a run, and `?run=` is resolved to the conversation
  // that run happened in (`RunRedirect`, router.tsx).
  const runNotice = { ...review, id: "run-finished", noticeType: "notify" as const,
    title: "交付物未通过质量门",
    body: "这次运行没有通过交付前的质量门。\n本次运行产出 8 个文件，仍在工作区里，可以直接打开。",
    source: { type: "run" as const, id: "run_abc123" },
    actions: [{ id: "open", label: "打开对话", style: "primary" as const }],
    readAt: "2026-09-06T00:01:00Z", resolvedAt: "2026-09-06T00:01:00Z" };
  vi.mocked(api.listInbox).mockResolvedValue({ items: [runNotice], nextCursor: null });

  render(<MemoryRouter><InboxPage /></MemoryRouter>);

  const link = await screen.findByRole("link", { name: "打开对话" });
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
    actions: [{ id: "open", label: "打开对话", style: "primary" as const }] };
  vi.mocked(api.listInbox).mockResolvedValue({ items: [runNotice], nextCursor: null });

  render(<MemoryRouter><InboxPage /></MemoryRouter>);

  expect(await screen.findByText("研究已交付，待你复核")).toBeInTheDocument();
  expect(screen.getByText(/需要你自己复核后再使用/)).toBeInTheDocument();
  expect(screen.getByText(/本次运行产出 3 个文件，仍在工作区里/)).toBeInTheDocument();
});

// Bodies written before 2026-09-18 carried the gate's first two sentences
// verbatim; that is where a pharmacist first met English validator prose.
it("holds back the sentences an old run notice quoted for the agent", async () => {
  const old: api.InboxItem = {
    ...review, id: "old-run", noticeType: "notify", title: "研究已交付，待你复核", actions: [],
    body: [
      "结果已交付，但有质量检查没有通过，需要你自己复核后再使用。",
      "MUST FIX — claims[52].claim numeric fact 6 is not present in its direct support.",
    ].join("\n"),
  };
  vi.mocked(api.listInbox).mockResolvedValue({ items: [old], nextCursor: null });
  render(<MemoryRouter><InboxPage /></MemoryRouter>);
  expect(await screen.findByText("结果已交付，但有质量检查没有通过，需要你自己复核后再使用。")).toBeInTheDocument();
  expect(screen.getByText(/另有 1 条技术提示/)).toBeInTheDocument();
  expect(screen.queryByText(/numeric fact/)).not.toBeInTheDocument();
});

const today = new Date();
const at = (hoursAgo: number) => new Date(today.getTime() - hoursAgo * 3_600_000).toISOString();
const yesterdayNoon = (() => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(12, 0, 0, 0); return d.toISOString(); })();
const todayEarly = (() => { const d = new Date(); d.setHours(0, 30, 0, 0); return d.toISOString(); })();

function runNotice(over: Partial<api.InboxItem>): api.InboxItem {
  return {
    ...review, noticeType: "notify", title: "研究已完成", body: "研究结果已准备好，报告与文件都在这条对话里。",
    source: { type: "run", id: `run_${over.id ?? "x"}` },
    actions: [{ id: "open", label: "打开对话", style: "primary" }],
    createdAt: todayEarly, ...over,
  };
}

// B §1e: every run notice carries an 「打开对话」 action, and the page only
// offered 标为已读 on items with none — so the commonest item could never be
// marked read without clicking through.
it("marks any unread item read, including one that carries actions", async () => {
  const notice = runNotice({ id: "with-action" });
  vi.mocked(api.listInbox).mockResolvedValue({ items: [notice], nextCursor: null, unreadTotal: 1 });
  vi.mocked(api.markInboxRead).mockResolvedValue({ ...notice, readAt: at(0), revision: 2 });
  render(<MemoryRouter><InboxPage /></MemoryRouter>);

  await userEvent.click(await screen.findByRole("button", { name: "标为已读" }));
  await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledWith("with-action", 1));
  // The bell hears about it at once rather than on its next poll.
  expect(api.announceInboxChanged).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "标为已读" })).not.toBeInTheDocument();
});

it("reads the whole inbox in one request", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({ items: [runNotice({ id: "a" })], nextCursor: null, unreadTotal: 7 });
  vi.mocked(api.markAllInboxRead).mockResolvedValue({ updated: 7 });
  render(<MemoryRouter><InboxPage /></MemoryRouter>);

  expect(await screen.findByText("7 条未读")).toBeInTheDocument();
  vi.mocked(api.listInbox).mockResolvedValue({ items: [runNotice({ id: "a", readAt: at(0) })], nextCursor: null, unreadTotal: 0 });
  await userEvent.click(screen.getByRole("button", { name: "全部已读" }));

  await waitFor(() => expect(api.markAllInboxRead).toHaveBeenCalledTimes(1));
  expect(api.markInboxRead).not.toHaveBeenCalled();
  expect(await screen.findByText("已把 7 条标为已读。")).toBeInTheDocument();
  expect(api.announceInboxChanged).toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "全部已读" })).toBeDisabled();
});

it("reads a notice when its link is followed", async () => {
  const notice = runNotice({ id: "follow" });
  vi.mocked(api.listInbox).mockResolvedValue({ items: [notice], nextCursor: null });
  vi.mocked(api.markInboxRead).mockResolvedValue({ ...notice, readAt: at(0), revision: 2 });
  render(<MemoryRouter><InboxPage /></MemoryRouter>);

  await userEvent.click(await screen.findByRole("link", { name: "打开对话" }));
  await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledWith("follow", 1));
});

it("groups by day, newest day first", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({
    items: [
      { ...review, id: "old", title: "昨天的审阅", createdAt: yesterdayNoon },
      { ...review, id: "new", title: "今天的审阅", createdAt: todayEarly },
    ],
    nextCursor: null,
  });
  render(<MemoryRouter><InboxPage /></MemoryRouter>);

  const headings = await screen.findAllByRole("heading", { level: 2 });
  expect(headings.map((heading) => heading.textContent)).toEqual(["今天", "昨天"]);
});

// Older per-run items: ten identical 「研究已完成」 cards for one afternoon.
it("folds a day's older per-run completions into one line", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({
    items: [runNotice({ id: "c1" }), runNotice({ id: "c2", readAt: at(0) }), runNotice({ id: "c3", title: "研究已交付" })],
    nextCursor: null,
  });
  vi.mocked(api.markInboxRead).mockImplementation(async (id: string) => ({ ...runNotice({ id }), readAt: at(0), revision: 2 }));
  render(<MemoryRouter><InboxPage /></MemoryRouter>);

  const row = await screen.findByRole("article", { name: "研究已完成 × 3" });
  expect(row).toHaveTextContent("其中 1 项有结论要核对");
  expect(screen.getAllByRole("link", { name: "打开对话" })).toHaveLength(3);
  await userEvent.click(screen.getByRole("button", { name: "标为已读" }));
  // Reading the line reads each unread item it stands for, and only those.
  await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.markInboxRead).mock.calls.map(([id]) => id).sort()).toEqual(["c1", "c3"]);
});

it("keeps automated runs quiet, folded under one line", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({
    items: [
      runNotice({ id: "eval-1", silent: true, readAt: at(0), title: "研究已完成" }),
      runNotice({ id: "eval-2", silent: true, readAt: at(0), title: "研究已完成" }),
      { ...review, id: "person", title: "需要你回答一个问题", noticeType: "question", createdAt: todayEarly },
    ],
    nextCursor: null,
  });
  render(<MemoryRouter><InboxPage /></MemoryRouter>);

  expect(await screen.findByText("需要你回答一个问题")).toBeInTheDocument();
  const fold = screen.getByText(/自动运行 2 条/).closest("details")!;
  expect(fold).not.toHaveAttribute("open");
  expect(screen.queryByRole("article", { name: "研究已完成" })).not.toBeInTheDocument();
});

// C1: SAFETY is the only class allowed to interrupt.
it("pins an unread clinical-safety finding above everything, in the danger colour", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({
    items: [
      { ...review, id: "later", title: "今天的审阅", createdAt: at(0) },
      runNotice({ id: "safety", title: "交付物涉及临床安全", severity: "safety", createdAt: yesterdayNoon }),
    ],
    nextCursor: null,
  });
  render(<MemoryRouter><InboxPage /></MemoryRouter>);

  const pinned = await screen.findByRole("heading", { name: /涉及临床安全 · 未读 1 条/ });
  const section = pinned.closest("section")!;
  const article = screen.getByRole("article", { name: "交付物涉及临床安全" });
  expect(section).toContainElement(article);
  expect(article.closest("li")).toHaveClass("border-danger");
  // Nothing else wears it.
  expect(screen.getByRole("article", { name: "今天的审阅" }).closest("li")).not.toHaveClass("border-danger");
  const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
  expect(headings[0]).toMatch(/涉及临床安全/);
});
