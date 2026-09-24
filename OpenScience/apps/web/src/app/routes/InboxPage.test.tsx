import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { InboxPage } from "./InboxPage";
import * as api from "@/lib/inboxClient";

const operator = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/inboxClient");
vi.mock("@/lib/useOperator", () => ({ useOperator: () => operator.value }));

const review: api.InboxItem = {
  id: "review-one", noticeType: "review", priority: 0, title: "审阅一个研究结论", body: "证据之间存在冲突。",
  actions: [{ id: "adopt", label: "采纳", style: "primary" }, { id: "reject", label: "驳回", style: "danger" }],
  count: 1, readAt: null, resolvedAt: null, resolution: null, revision: 1, createdAt: "2026-09-06T00:00:00Z",
};

const today = new Date();
const at = (hoursAgo: number) => new Date(today.getTime() - hoursAgo * 3_600_000).toISOString();
const todayEarly = (() => { const d = new Date(); d.setHours(0, 30, 0, 0); return d.toISOString(); })();
const yesterdayNoon = (() => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(12, 0, 0, 0); return d.toISOString(); })();

function runNotice(over: Partial<api.InboxItem>): api.InboxItem {
  return {
    ...review, noticeType: "notify", title: "中医药治疗儿童疳证的 Meta 分析检索 已完成", body: "报告和 6 个文件已在对话里",
    source: { type: "run", id: `run_${over.id ?? "x"}` },
    actions: [{ id: "open", label: "打开对话", style: "primary" }],
    createdAt: todayEarly, ...over,
  };
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}{location.search}</p>;
}

function open() {
  return render(
    <MemoryRouter initialEntries={["/app/inbox"]}>
      <Routes>
        <Route path="/app/inbox" element={<InboxPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  operator.value = false;
  vi.mocked(api.listInbox).mockResolvedValue({ items: [review], nextCursor: null });
  vi.mocked(api.inboxErrorMessage).mockImplementation(() => "操作未完成，请重试。");
});

// The inbox sat 126 px right of every other page (748 px column, 32 px top);
// it is in the one column now, with its title and nothing under it.
it("sits in the one page column with a one-line header and no subtitle", async () => {
  const { container } = open();
  const heading = await screen.findByRole("heading", { level: 1, name: "收件箱" });
  expect(container.querySelector(".max-w-page")).toContainElement(heading);
  expect(container.querySelector(".max-w-content")).toBeNull();
  expect(screen.queryByText(/研究完成、需要你决定/)).not.toBeInTheDocument();
  // 「全部已读」 is a text button in the header, not a bordered one.
  const banner = screen.getByRole("banner");
  const readAll = within(banner).getByRole("button", { name: "全部已读" });
  expect(readAll.className).not.toMatch(/(^|\s)border(\s|$)/);
});

it("filters with two quiet chips, 全部 and 未读 with its count, and no segmented control", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({ items: [runNotice({ id: "a" })], nextCursor: null, unreadTotal: 2 });
  open();
  expect(await screen.findByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /^未读\s*2$/ })).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryAllByRole("radio")).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: /^未读\s*2$/ }));
  await waitFor(() => expect(api.listInbox).toHaveBeenLastCalledWith({ unread: true }));
});

it("draws a notice as a row: unread dot, title, one line of what happened, and the time", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({ items: [runNotice({ id: "row", createdAt: yesterdayNoon })], nextCursor: null });
  open();
  const link = await screen.findByRole("link", { name: /中医药治疗儿童疳证的 Meta 分析检索 已完成/ });
  const row = link.closest("li")!;
  expect(within(row).getByText("报告和 6 个文件已在对话里")).toBeInTheDocument();
  expect(within(row).getByText("昨天")).toBeInTheDocument();
  expect(within(row).getByText("（未读）")).toHaveClass("sr-only");
  // No card around it and no buttons under it.
  expect(row.className).not.toMatch(/(^|\s)border(\s|$)/);
  expect(within(row).queryByRole("link", { name: "打开对话" })).not.toBeInTheDocument();
});

it("opens the whole row: it goes where the notice points and marks it read on the way", async () => {
  const notice = runNotice({ id: "follow" });
  vi.mocked(api.listInbox).mockResolvedValue({ items: [notice], nextCursor: null, unreadTotal: 1 });
  vi.mocked(api.markInboxRead).mockResolvedValue({ ...notice, readAt: at(0), revision: 2 });
  open();
  const link = await screen.findByRole("link", { name: /已完成/ });
  expect(link).toHaveAttribute("href", "/app/runs?run=run_follow");
  // The title is stretched over the row, so the whole row is the target.
  expect(link.className).toMatch(/after:absolute/);
  await userEvent.click(link);
  await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledWith("follow", 1));
  expect(screen.getByTestId("where")).toHaveTextContent("/app/runs?run=run_follow");
});

it("opens a digest, the frontier daily and a memory where each lives, without deciding anything", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({
    items: [
      { ...review, id: "digest", title: "主动科研简报：GLP-1", source: { type: "digest", id: "digest-owned" },
        actions: [{ id: "open", label: "查看简报", style: "neutral" }], readAt: at(1), resolvedAt: at(1) },
      { ...review, id: "daily", noticeType: "notify", title: "今日前沿 · 9月23日", body: "头条：FDA 发布新方法学专题",
        source: { type: "digest", id: "frontier-daily:2026-09-23" }, actions: [{ id: "open", label: "打开日报", style: "neutral" }], readAt: at(1) },
      { ...review, id: "memory", noticeType: "notify", title: "一条记忆被改写", body: "",
        source: { type: "memory", id: "rec_1" }, actions: [{ id: "open", label: "查看", style: "primary" }], readAt: at(1) },
    ],
    nextCursor: null,
  });
  open();
  expect(await screen.findByRole("link", { name: "主动科研简报：GLP-1" })).toHaveAttribute("href", "/app/autopilot?digest=digest-owned");
  expect(screen.getByRole("link", { name: "今日前沿 · 9月23日" })).toHaveAttribute("href", "/app/frontier?view=daily&day=2026-09-23");
  expect(screen.getByRole("link", { name: "一条记忆被改写" })).toHaveAttribute("href", "/app/memory?record=rec_1");
  expect(api.resolveInboxItem).not.toHaveBeenCalled();
  expect(api.markInboxRead).not.toHaveBeenCalled();
});

it("offers 「标为已读」 on the row, including one that carries actions", async () => {
  const notice = runNotice({ id: "with-action" });
  vi.mocked(api.listInbox).mockResolvedValue({ items: [notice], nextCursor: null, unreadTotal: 1 });
  vi.mocked(api.markInboxRead).mockResolvedValue({ ...notice, readAt: at(0), revision: 2 });
  open();
  const mark = await screen.findByRole("button", { name: "标为已读" });
  // An icon, shown with the row's other quiet actions on hover or focus.
  expect(mark).toHaveClass("h-6", "w-6");
  await userEvent.click(mark);
  await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledWith("with-action", 1));
  expect(api.announceInboxChanged).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "标为已读" })).not.toBeInTheDocument();
  expect(screen.queryByText("（未读）")).not.toBeInTheDocument();
});

it("keeps a failed 「标为已读」 retryable and says why", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({ items: [runNotice({ id: "notice-one" })], nextCursor: null });
  vi.mocked(api.markInboxRead).mockRejectedValue(new Error("network"));
  open();
  await userEvent.click(await screen.findByRole("button", { name: "标为已读" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请重试。");
  expect(screen.getByRole("button", { name: "标为已读" })).toBeInTheDocument();
});

it("keeps a decision the notice asks for in its 「⋯」, and it is gone once made", async () => {
  vi.mocked(api.resolveInboxItem).mockResolvedValue({ ...review, revision: 2, readAt: at(0), resolvedAt: at(0), resolution: { actionId: "adopt" } });
  open();
  const row = (await screen.findByText("审阅一个研究结论")).closest("li")!;
  expect(within(row).getByText("待核对")).toBeInTheDocument();
  await userEvent.click(within(row).getByRole("button", { name: "处理" }));
  expect(await screen.findByRole("menuitem", { name: "驳回" })).toHaveClass("text-danger");
  await userEvent.click(screen.getByRole("menuitem", { name: "采纳" }));
  await waitFor(() => expect(api.resolveInboxItem).toHaveBeenCalledWith("review-one", "adopt", 1));
  expect(await screen.findByText("已处理")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "处理" })).not.toBeInTheDocument();
  expect(screen.queryByText("待核对")).not.toBeInTheDocument();
});

it("opens a notice that points nowhere in place, whole, and reads it", async () => {
  const notice: api.InboxItem = {
    ...review, id: "bound", noticeType: "notify", title: "飞书机器人已绑定到你的账号",
    body: "绑定的飞书身份：张三。\n如果不是你本人扫的码，点「解除绑定」。",
    source: { type: "system", id: "feishu-binding:1" }, actions: [{ id: "feishu-unbind", label: "解除绑定", style: "danger" }],
  };
  vi.mocked(api.listInbox).mockResolvedValue({ items: [notice], nextCursor: null });
  vi.mocked(api.markInboxRead).mockResolvedValue({ ...notice, readAt: at(0), revision: 2 });
  open();
  const title = await screen.findByRole("button", { name: /飞书机器人已绑定到你的账号/ });
  expect(title).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("绑定的飞书身份：张三。 如果不是你本人扫的码，点「解除绑定」。")).toHaveClass("truncate");
  await userEvent.click(title);
  expect(title).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("如果不是你本人扫的码，点「解除绑定」。")).toBeInTheDocument();
  await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledWith("bound", 1));
});

it("empties the view with one sentence and no button", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({ items: [], nextCursor: null });
  open();
  expect(await screen.findByText("收件箱为空")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "未读" }));
  await waitFor(() => expect(api.listInbox).toHaveBeenLastCalledWith({ unread: true }));
  expect(await screen.findByText("没有未读消息")).toBeInTheDocument();
  expect(screen.queryByText(/新的研究结果和待决事项/)).not.toBeInTheDocument();
});

it("says so, with a retry, when the list cannot be read, rather than showing an empty inbox", async () => {
  vi.mocked(api.listInbox).mockRejectedValueOnce(new Error("down")).mockResolvedValue({ items: [review], nextCursor: null });
  open();
  expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请重试。");
  expect(screen.queryByText("收件箱为空")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("审阅一个研究结论")).toBeInTheDocument();
});

it("discards a late page after changing filters and prevents duplicate page requests", async () => {
  let finishPage!: (value: api.InboxPageResult) => void;
  vi.mocked(api.listInbox).mockImplementation(async ({ unread = false, cursor = null } = {}) => {
    if (unread) return { items: [], nextCursor: null };
    if (cursor) return new Promise((resolve) => { finishPage = resolve; });
    return { items: [review], nextCursor: "old-page" };
  });
  open();
  const more = await screen.findByRole("button", { name: "加载更多" });
  await userEvent.click(more);
  expect(more).toBeDisabled();
  await userEvent.click(more);
  expect(api.listInbox).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole("button", { name: "未读" }));
  expect(await screen.findByText("没有未读消息")).toBeInTheDocument();
  finishPage({ items: [{ ...review, id: "late-review", title: "旧筛选消息" }], nextCursor: null });
  await waitFor(() => expect(screen.queryByText("旧筛选消息")).not.toBeInTheDocument());
});

it("removes a read item from the unread view and ignores a late mutation after reload", async () => {
  const notice = runNotice({ id: "read-one", title: "研究完成" });
  vi.mocked(api.listInbox).mockResolvedValue({ items: [notice], nextCursor: null });
  let finishRead!: (value: api.InboxItem) => void;
  vi.mocked(api.markInboxRead).mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
  open();
  await userEvent.click(await screen.findByRole("button", { name: "未读" }));
  await userEvent.click(await screen.findByRole("button", { name: "标为已读" }));
  await userEvent.click(screen.getByRole("button", { name: "全部" }));
  finishRead({ ...notice, readAt: "2026-09-06T00:01:00Z", revision: 2 });
  await waitFor(() => expect(screen.getByText("研究完成")).toBeInTheDocument());

  await userEvent.click(screen.getByRole("button", { name: "未读" }));
  vi.mocked(api.markInboxRead).mockResolvedValue({ ...notice, readAt: "2026-09-06T00:01:00Z", revision: 2 });
  await userEvent.click(await screen.findByRole("button", { name: "标为已读" }));
  await waitFor(() => expect(screen.queryByText("研究完成")).not.toBeInTheDocument());
});

it("does not leak an old mutation failure or busy state into a reloaded filter", async () => {
  const notice = runNotice({ id: "stale-read", title: "旧请求" });
  vi.mocked(api.listInbox).mockResolvedValue({ items: [notice], nextCursor: null });
  let failRead!: (error: Error) => void;
  vi.mocked(api.markInboxRead).mockImplementation(() => new Promise((_resolve, reject) => { failRead = reject; }));
  open();
  await userEvent.click(await screen.findByRole("button", { name: "未读" }));
  await userEvent.click(await screen.findByRole("button", { name: "标为已读" }));
  await userEvent.click(screen.getByRole("button", { name: "全部" }));
  expect(await screen.findByRole("button", { name: "标为已读" })).toBeEnabled();
  failRead(new Error("old request failed"));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "标为已读" })).toBeEnabled();
});

it("reads the whole inbox in one request", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({ items: [runNotice({ id: "a" })], nextCursor: null, unreadTotal: 7 });
  vi.mocked(api.markAllInboxRead).mockResolvedValue({ updated: 7 });
  open();
  expect(await screen.findByRole("button", { name: /^未读\s*7$/ })).toBeInTheDocument();
  vi.mocked(api.listInbox).mockResolvedValue({ items: [runNotice({ id: "a", readAt: at(0) })], nextCursor: null, unreadTotal: 0 });
  await userEvent.click(screen.getByRole("button", { name: "全部已读" }));
  await waitFor(() => expect(api.markAllInboxRead).toHaveBeenCalledTimes(1));
  expect(api.markInboxRead).not.toHaveBeenCalled();
  expect(api.announceInboxChanged).toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "全部已读" })).toBeDisabled());
  // No status sentence about how many were marked.
  expect(screen.queryByText(/已把 .* 条标为已读/)).not.toBeInTheDocument();
});

// The fold 「自动运行 N 条（评测与主动科研，不计入未读）」 is gone: whatever the
// list route returns is a row, and no grouping field is read.
it("renders every item as a row: no automated-run fold, no merged completions", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({
    items: [
      runNotice({ id: "auto-1", silent: true, readAt: at(0), title: "GLP-1 受体激动剂在心衰中的新证据 · 本周结果" }),
      runNotice({ id: "c1", title: "研究已完成" }),
      runNotice({ id: "c2", title: "研究已完成", groupKey: "run-finished:default:2026-09-18", count: 3 }),
    ],
    nextCursor: null,
  });
  open();
  expect(await screen.findByText("GLP-1 受体激动剂在心衰中的新证据 · 本周结果")).toBeInTheDocument();
  expect(screen.getAllByText("研究已完成")).toHaveLength(2);
  expect(screen.queryByText(/自动运行/)).not.toBeInTheDocument();
  expect(screen.queryByText(/合并 \d+ 条/)).not.toBeInTheDocument();
  expect(document.querySelector("details")).toBeNull();
  expect(within(screen.getByRole("list", { name: "消息" })).getAllByRole("listitem")).toHaveLength(3);
});

// C1: SAFETY is the only class allowed to interrupt.
it("keeps an unread clinical-safety finding above everything, and only it", async () => {
  vi.mocked(api.listInbox).mockResolvedValue({
    items: [
      { ...review, id: "later", title: "今天的审阅", createdAt: at(0) },
      runNotice({ id: "safety", title: "〈研究〉：有 1 处用药安全提示", severity: "safety", createdAt: yesterdayNoon }),
    ],
    nextCursor: null,
  });
  open();
  const pinned = await screen.findByRole("heading", { name: /涉及临床安全 · 未读 1 条/ });
  const section = pinned.closest("section")!;
  expect(within(section).getByText("〈研究〉：有 1 处用药安全提示")).toBeInTheDocument();
  expect(within(section).queryByText("今天的审阅")).not.toBeInTheDocument();
  expect(pinned.compareDocumentPosition(screen.getByText("今天的审阅")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

// Bodies written before 2026-09-18 carried the gate's sentences verbatim; they
// are held back, and shown as written only to an operator.
it("holds back the sentences an old run notice quoted for the agent, except for an operator", async () => {
  const old = runNotice({
    id: "old-run", title: "研究已交付，待你复核",
    body: ["结果已交付，但有质量检查没有通过。", "MUST FIX — claims[52].claim numeric fact 6 is not present in its direct support."].join("\n"),
  });
  vi.mocked(api.listInbox).mockResolvedValue({ items: [old], nextCursor: null });
  const first = open();
  expect(await screen.findByText("结果已交付，但有质量检查没有通过。")).toBeInTheDocument();
  expect(screen.queryByText(/numeric fact/)).not.toBeInTheDocument();
  expect(screen.queryByText(/技术提示/)).not.toBeInTheDocument();
  first.unmount();

  operator.value = true;
  open();
  expect(await screen.findByText(/另有 1 条技术原文（仅运维账号可见）/)).toBeInTheDocument();
});
