import { render, screen, within } from "@testing-library/react";
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
