import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrontierDaily } from "@/lib/frontierClient";
import { DailyIssue, type DailyState } from "./DailyView";
import { frontierItem } from "./__fixtures__/frontierItems";

const items = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => frontierItem({ id: `${prefix}${index}`, title: `${prefix} 第 ${index + 1} 条` }));
const lane = (key: string, label: string, count: number) => ({ lane: key, laneLabel: label, items: items(key, count) });
const issue = (overrides: Partial<FrontierDaily> = {}): FrontierDaily => ({
  day: "2026-10-07", windowStart: null, windowEnd: null, generatedAt: null, lead: null, aiMinute: null, markdown: "日报", itemCount: 12, readingMinutes: 7,
  previousDay: null, nextDay: null, safety: items("safety", 1),
  sections: [lane("evidence", "临床证据", 8), lane("guideline", "指南共识", 2), lane("industry", "研发产业", 1)], ...overrides,
});
const state = (daily: FrontierDaily): DailyState => ({ index: [{ day: daily.day, title: null, itemCount: 12, generatedAt: null }], issue: daily, loading: false, error: null, retry: () => {} });
const show = (daily: FrontierDaily, props: Partial<Parameters<typeof DailyIssue>[0]> = {}) =>
  render(<MemoryRouter><DailyIssue state={state(daily)} onDay={() => {}} {...props} /></MemoryRouter>);

const scrollIntoView = vi.fn();
beforeEach(() => { scrollIntoView.mockReset(); Element.prototype.scrollIntoView = scrollIntoView; });
afterEach(() => { delete (Element.prototype as Partial<Element>).scrollIntoView; });

describe("the issue's header", () => {
  it("stays at the top while the issue scrolls, with the date, 分类, 往期 and 复制 in it", () => {
    show(issue());
    const header = screen.getByRole("banner");
    expect(header).toHaveClass("sticky", "top-0", "z-sticky", "bg-bg");
    expect(within(header).getByRole("heading", { name: "10月7日 周三" })).toBeInTheDocument();
    for (const name of ["复制", "分类", "往期"]) expect(within(header).getByRole("button", { name })).toBeInTheDocument();
  });

  it("lists the lanes with their counts in 分类, safety first, and takes the reader to the one chosen without changing the address", async () => {
    show(issue());
    await userEvent.click(screen.getByRole("button", { name: "分类" }));
    const menu = await screen.findByRole("menu", { name: "分类" });
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual(["安全警示 1", "临床证据 8", "指南共识 2", "研发产业 1"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "指南共识 2" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById("daily-guideline"));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("offers 分类 only from three lanes on", () => {
    show(issue({ safety: [], sections: [lane("evidence", "临床证据", 3), lane("guideline", "指南共识", 2)] }));
    expect(screen.queryByRole("button", { name: "分类" })).not.toBeInTheDocument();
  });

  it("keeps the safety alerts and drug-safety lane separately named and addressable", async () => {
    show(issue({ sections: [lane("safety", "药物安全", 2), lane("guideline", "指南共识", 1)] }));
    expect(screen.getByRole("region", { name: "安全警示 1" })).not.toBe(screen.getByRole("region", { name: "药物安全 2" }));
    for (const [name, id] of [["安全警示 1", "daily-safety-alerts"], ["药物安全 2", "daily-safety"]]) {
      await userEvent.click(screen.getByRole("button", { name: "分类" }));
      await userEvent.click(screen.getByRole("menuitem", { name }));
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(document.getElementById(id));
      expect(document.querySelectorAll(`#${id}`)).toHaveLength(1);
    }
  });

  it("counts the safety alerts as a lane, so two lanes and an alert are three", () => {
    show(issue({ sections: [lane("evidence", "临床证据", 3), lane("guideline", "指南共识", 2)] }));
    expect(screen.getByRole("button", { name: "分类" })).toBeInTheDocument();
  });
});

describe("a row", () => {
  it("has its title as the one way to the original, and 「详情」 beside the institution — no second 「原文」", () => {
    show(issue({ safety: [], sections: [lane("evidence", "临床证据", 1)] }));
    const row = within(screen.getByRole("list", { name: "临床证据" })).getByRole("listitem");
    expect(within(row).getByRole("link", { name: "evidence 第 1 条" })).toHaveAttribute("target", "_blank");
    expect(within(row).getAllByRole("link")).toHaveLength(1);
    expect(within(row).queryByText(/原文/)).not.toBeInTheDocument();
    expect(within(row).queryByText("阅读详情")).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "详情" })).toBeInTheDocument();
  });

  it("has no 「详情」 where the drawer would add nothing", () => {
    const plain = frontierItem({ id: "plain", title: "一条普通报道", sourceType: "media", titleZh: null, doi: null, pmid: null, facts: {}, openAccess: null });
    show(issue({ safety: [], sections: [{ lane: "news", laneLabel: "行业动态", items: [plain] }] }));
    expect(screen.queryByRole("button", { name: "详情" })).not.toBeInTheDocument();
  });
});

describe("a day's lanes in full, a week's in a preview", () => {
  it("shows every row of a day's lane", () => {
    show(issue());
    expect(within(screen.getByRole("list", { name: "临床证据" })).getAllByRole("listitem")).toHaveLength(8);
    expect(screen.queryByRole("button", { name: /展开其余/ })).not.toBeInTheDocument();
  });

  it("shows the first rows of each lane given a limit, says how many are left, and opens them where they stand", async () => {
    show(issue({ safety: items("safety", 7) }), { laneLimit: 5, weekly: true });
    const evidence = screen.getByRole("list", { name: "临床证据" });
    expect(within(evidence).getAllByRole("listitem")).toHaveLength(5);
    expect(within(screen.getByRole("list", { name: "安全警示" })).getAllByRole("listitem")).toHaveLength(5);
    // A lane that fits shows no button; the heading's count is the lane's whole size.
    expect(within(screen.getByRole("list", { name: "指南共识" })).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /展开其余/ }).map((button) => button.textContent)).toEqual(["展开其余 2 条", "展开其余 3 条"]);
    expect(screen.getByRole("heading", { name: "临床证据 8" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开其余 3 条" }));
    expect(within(screen.getByRole("list", { name: "临床证据" })).getAllByRole("listitem")).toHaveLength(8);
    expect(screen.queryByRole("button", { name: "展开其余 3 条" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开其余 2 条" })).toBeInTheDocument();
  });
});

describe("the lead story", () => {
  const lead = (over: Partial<NonNullable<FrontierDaily["lead"]>> = {}): NonNullable<FrontierDaily["lead"]> => ({
    item: frontierItem({ id: "lead", title: "FDA 发布新方法学专题", url: "https://example.org/fda-nams" }), text: "FDA 发布直接最终规则。", event: null, ...over,
  });

  it("makes its title the link to the original, in a new tab, and has no separate 「原文」 control", () => {
    show(issue({ lead: lead() }));
    const title = screen.getByRole("heading", { level: 3, name: "FDA 发布新方法学专题" });
    const link = within(title).getByRole("link", { name: "FDA 发布新方法学专题" });
    expect(link).toHaveAttribute("href", "https://example.org/fda-nams");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    // One kind of 「原文」 entry on the page: the lead does not add its own, and says whose it is in plain grey text.
    expect(screen.queryByText(/原文/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /原文/ })).not.toBeInTheDocument();
    const section = screen.getByRole("region", { name: "头条" });
    expect(within(section).getAllByRole("link")).toHaveLength(1);
    expect(within(section).getByText(frontierItem().source.name)).not.toHaveAttribute("href");
  });
});

describe("a day without an issue", () => {
  const empty = (over: Partial<DailyState> = {}): DailyState => ({ index: [], issue: null, loading: false, error: null, retry: () => {}, ...over });
  const showEmpty = (state: DailyState, props: Partial<Parameters<typeof DailyIssue>[0]> = {}) =>
    render(<MemoryRouter><DailyIssue state={state} onDay={() => {}} {...props} /></MemoryRouter>);

  it("names the publication time and time zone the server reports, not a time written into the page", () => {
    showEmpty(empty({ schedule: { time: "08:15", timeZone: "Asia/Shanghai" } }));
    expect(screen.getByText("今日日报 08:15（北京时间）发布")).toBeInTheDocument();
    expect(screen.queryByText(/07:30/)).not.toBeInTheDocument();
    expect(screen.getByText("当天没有符合条件的内容时不出刊。")).toBeInTheDocument();
  });

  it("names another time zone by its own name", () => {
    showEmpty(empty({ schedule: { time: "07:30", timeZone: "UTC" } }));
    expect(screen.getByText(/^今日日报 07:30（.*(UTC|协调世界时|世界时间).*）发布$/)).toBeInTheDocument();
  });

  it("promises no time from a server that named none", () => {
    showEmpty(empty());
    expect(screen.getByText("今日日报尚未发布")).toBeInTheDocument();
    expect(screen.queryByText(/\d{2}:\d{2}/)).not.toBeInTheDocument();
    // With nothing published at all there is no past to open.
    expect(screen.queryByRole("button", { name: "往期" })).not.toBeInTheDocument();
  });

  it("lets the reader open a past issue from the empty state when there are any, for the real day that has none", async () => {
    const onDay = vi.fn();
    showEmpty(empty({
      day: "2026-10-01", schedule: { time: "07:30", timeZone: "Asia/Shanghai" },
      index: [{ day: "2026-10-07", title: null, itemCount: 12, generatedAt: null }, { day: "2026-10-06", title: null, itemCount: 9, generatedAt: null }],
    }), { onDay });
    expect(screen.getByText("10月1日 周四没有日报")).toBeInTheDocument();
    expect(screen.getByText("日报每天 07:30（北京时间）发布；当天没有符合条件的内容时不出刊。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "往期" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "10月6日 周二" }));
    expect(onDay).toHaveBeenCalledWith("2026-10-06");
  });

  it("keeps saying 暂无日报 where the server has no daily at all, and 暂无周报 for a week", () => {
    showEmpty(empty({ index: null }));
    expect(screen.getByText("暂无日报")).toBeInTheDocument();
    cleanup();
    showEmpty(empty(), { weekly: true });
    expect(screen.getByText("暂无周报")).toBeInTheDocument();
  });
});
