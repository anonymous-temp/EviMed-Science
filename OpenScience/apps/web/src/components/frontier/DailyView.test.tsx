import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrontierDaily } from "@/lib/frontierClient";
import { Toolbar } from "@/components/ui/Toolbar";
import { DailyIssue, dailyControls, type DailyState } from "./DailyView";
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

/** The page's way of using an issue: its controls in the toolbar above it. */
const showWithToolbar = (daily: FrontierDaily, props: { weekly?: boolean; onDay?: (day: string) => void } = {}) => {
  const current = state(daily);
  const controls = dailyControls(current, { weekly: props.weekly, onDay: props.onDay ?? (() => {}) });
  return render(<MemoryRouter><Toolbar label="简报的控制" filters={controls.filters} actions={controls.actions} /><DailyIssue state={current} onDay={() => {}} {...props} /></MemoryRouter>);
};

describe("the issue's own text", () => {
  it("marks the lead's summary and AI 一分钟 as the issue's prose, as a row's summary is content and not a sentence of the page", () => {
    // The fixture walk read both as sentences standing alone at 390 px (orphan-sentence, r19-guards2).
    show(issue({ lead: { item: frontierItem({ id: "lead", title: "头条试验" }), text: "随机、双盲、对照试验纳入 1,264 名成人。", event: null }, aiMinute: "今天与临床相关的 AI 进展有 3 条。" }));
    expect(screen.getByText("随机、双盲、对照试验纳入 1,264 名成人。").closest("[data-prose]")).not.toBeNull();
    expect(screen.getByText("今天与临床相关的 AI 进展有 3 条。").closest("[data-prose]")).not.toBeNull();
  });
});

describe("the issue's header", () => {
  it("is the date and how long the issue takes to read, and holds no control: they are the page toolbar's (R19, audit D C1c)", () => {
    show(issue());
    const header = screen.getByRole("banner");
    expect(header).not.toHaveClass("sticky");
    expect(within(header).getByRole("heading", { name: "10月7日 周三" })).toBeInTheDocument();
    expect(header).toHaveTextContent("12 条 · 约 7 分钟");
    expect(within(header).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "复制" })).not.toBeInTheDocument();
  });

  it("puts 分类, 往期 and 复制 in the toolbar, where the issue's controls stay while it scrolls", () => {
    showWithToolbar(issue());
    const toolbar = screen.getByRole("group", { name: "简报的控制" });
    for (const name of ["分类", "往期", "复制"]) expect(within(toolbar).getByRole("button", { name })).toBeInTheDocument();
    expect(toolbar.compareDocumentPosition(screen.getByRole("article")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists the lanes with their counts in 分类, safety first, and takes the reader to the one chosen without changing the address", async () => {
    // The three things at the head take their rows out of the lanes: the evidence lane's first three are among them, so it lists five.
    showWithToolbar(issue());
    await userEvent.click(screen.getByRole("button", { name: "分类" }));
    const menu = await screen.findByRole("menu", { name: "分类" });
    expect(within(menu).getAllByRole("menuitemradio").map((entry) => entry.textContent)).toEqual(["安全警示 1", "临床证据 5", "指南共识 2", "研发产业 1"]);
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "指南共识 2" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById("daily-guideline"));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("offers 分类 only from three lanes on", () => {
    showWithToolbar(issue({ safety: [], sections: [lane("evidence", "临床证据", 3), lane("guideline", "指南共识", 2)] }));
    expect(screen.queryByRole("button", { name: "分类" })).not.toBeInTheDocument();
  });

  it("keeps the safety alerts and drug-safety lane separately named and addressable", async () => {
    showWithToolbar(issue({ sections: [lane("safety", "药物安全", 2), lane("guideline", "指南共识", 1)] }), { weekly: true });
    expect(screen.getByRole("region", { name: "安全警示 1" })).not.toBe(screen.getByRole("region", { name: "药物安全 2" }));
    for (const [name, id] of [["安全警示 1", "daily-safety-alerts"], ["药物安全 2", "daily-safety"]]) {
      await userEvent.click(screen.getByRole("button", { name: "分类" }));
      await userEvent.click(screen.getByRole("menuitemradio", { name }));
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(document.getElementById(id));
      expect(document.querySelectorAll(`#${id}`)).toHaveLength(1);
    }
  });

  it("counts the safety alerts as a lane, so two lanes and an alert are three", () => {
    // six rows in one lane: the three at the head leave it three, and the other lane two
    showWithToolbar(issue({ sections: [lane("evidence", "临床证据", 6), lane("guideline", "指南共识", 2)] }));
    expect(screen.getByRole("button", { name: "分类" })).toBeInTheDocument();
  });

  it("has no controls for a day without an issue, whose past issues are the empty state's own button", () => {
    const controls = dailyControls({ index: [{ day: "2026-10-06", title: null, itemCount: 3, generatedAt: null }], issue: null, loading: false, error: null, retry: () => {} }, { onDay: () => {} });
    expect(controls.filters).toEqual([]);
    expect(controls.actions).toBeNull();
  });
});

describe("a row", () => {
  it("opens the addressed reader through its title, and 「详情」 beside the institution — no second 「原文」", () => {
    show(issue({ safety: [], sections: [lane("evidence", "临床证据", 1)] }));
    const row = within(screen.getByRole("list", { name: "临床证据" })).getByRole("listitem");
    expect(within(row).getByRole("link", { name: "evidence 第 1 条" })).toHaveAttribute("href", "/app/frontier/items/evidence0");
    expect(within(row).getAllByRole("link")).toHaveLength(2);
    expect(within(row).queryByText(/原文/)).not.toBeInTheDocument();
    expect(within(row).queryByText("阅读详情")).not.toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "详情" })).toHaveAttribute("href", "/app/frontier/items/evidence0");
  });

  it("has no 「详情」 where the drawer would add nothing", () => {
    const plain = frontierItem({ id: "plain", title: "一条普通报道", sourceType: "media", titleZh: null, doi: null, pmid: null, facts: {}, openAccess: null });
    show(issue({ safety: [], sections: [{ lane: "news", laneLabel: "行业动态", items: [plain] }] }));
    expect(screen.queryByRole("button", { name: "详情" })).not.toBeInTheDocument();
  });
});

describe("a day's lanes in full, a week's in a preview", () => {
  it("shows every row of a day's lane that the three things at the head do not hold", () => {
    show(issue());
    expect(within(screen.getByRole("list", { name: "临床证据" })).getAllByRole("listitem")).toHaveLength(5);
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

const lead = (over: Partial<NonNullable<FrontierDaily["lead"]>> = {}): NonNullable<FrontierDaily["lead"]> => ({
  item: frontierItem({ id: "lead", title: "FDA 发布新方法学专题", url: "https://example.org/fda-nams" }), text: "FDA 发布直接最终规则。", event: null, ...over,
});

describe("the lead story, in an issue with fewer than three things to show", () => {
  /** The lead and one more: two things are not three, so the headline stands as it did. */
  const thin = (over: Partial<FrontierDaily> = {}) => issue({ safety: [], sections: [lane("evidence", "临床证据", 1)], ...over });

  it("makes its title the link to the addressed reader, and has no separate 「原文」 control", () => {
    show(thin({ lead: lead() }));
    const title = screen.getByRole("heading", { level: 3, name: "FDA 发布新方法学专题" });
    const link = within(title).getByRole("link", { name: "FDA 发布新方法学专题" });
    expect(link).toHaveAttribute("href", "/app/frontier/items/lead");
    expect(link).not.toHaveAttribute("target");
    // One kind of 「原文」 entry on the page: the lead does not add its own, and says whose it is in plain grey text.
    expect(screen.queryByText(/原文/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /原文/ })).not.toBeInTheDocument();
    const section = screen.getByRole("region", { name: "头条" });
    expect(within(section).getAllByRole("link")).toHaveLength(1);
    expect(within(section).getByText(frontierItem().source.name)).not.toHaveAttribute("href");
  });
});

describe("AI 一分钟 opens the issue, and a day's safety lane shows three rows (owner, 2026-10-27)", () => {
  const minute = "今天与临床相关的 AI 进展有 3 条。";
  const headings = () => screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);

  it("is the first section under the issue's header, before 先看三件事, the safety lane and the lanes; it is not at the end any more", () => {
    show(issue({ aiMinute: minute, lead: lead({ event: null }), safety: items("safety", 2) }));
    const names = headings();
    expect(names[0]).toBe("AI 一分钟");
    expect(names.indexOf("先看三件事")).toBe(1);
    expect(names.indexOf("AI 一分钟")).toBeLessThan(names.findIndex((name) => name?.startsWith("安全警示")));
    expect(names.filter((name) => name === "AI 一分钟")).toHaveLength(1);
    const section = screen.getByRole("region", { name: "AI 一分钟" });
    expect(section.querySelector("[data-prose]")).toHaveTextContent(minute);
    expect(screen.getByRole("banner").compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.compareDocumentPosition(screen.getByRole("region", { name: "先看三件事" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is before the lead's headline where there are fewer than three things, and the sections keep their distance from it", () => {
    show(issue({ aiMinute: minute, lead: lead({ event: null }), safety: [], sections: [lane("evidence", "临床证据", 1)] }));
    const section = screen.getByRole("region", { name: "AI 一分钟" });
    expect(section.compareDocumentPosition(screen.getByRole("region", { name: "头条" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("region", { name: "头条" })).toHaveClass("mt-8");
  });

  it("is not drawn without a minute, and the first section then sits where it did", () => {
    show(issue({ aiMinute: null }));
    expect(screen.queryByRole("heading", { name: "AI 一分钟" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "先看三件事" })).toHaveClass("mt-5");
  });

  it("shows a day's first three safety alerts, the count of all of them, and the rest behind 「展开其余 N 条」", async () => {
    show(issue({ safety: items("safety", 7) }));
    expect(screen.getByRole("heading", { name: "安全警示 7" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "安全警示" })).getAllByRole("listitem").map((row) => row.querySelector("[data-row-title]")?.textContent))
      .toEqual(["safety 第 1 条", "safety 第 2 条", "safety 第 3 条"]);
    await userEvent.click(screen.getByRole("button", { name: "展开其余 4 条" }));
    expect(within(screen.getByRole("list", { name: "安全警示" })).getAllByRole("listitem")).toHaveLength(7);
    expect(screen.queryByRole("button", { name: /展开其余 4 条/ })).not.toBeInTheDocument();
  });

  it("shows three or fewer whole, and keeps the week's own limit", () => {
    show(issue({ safety: items("safety", 3) }));
    expect(within(screen.getByRole("list", { name: "安全警示" })).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /展开其余/ })).not.toBeInTheDocument();
    cleanup();
    show(issue({ safety: items("safety", 7) }), { weekly: true, laneLimit: 5 });
    expect(within(screen.getByRole("list", { name: "安全警示" })).getAllByRole("listitem")).toHaveLength(5);
  });
});

describe("先看三件事", () => {
  const scored = (id: string, score: number | null, summary = `${id} 的导读`) => frontierItem({ id, title: `${id} 标题`, summary, score });
  const lanes = (...lists: Array<[string, ReturnType<typeof scored>[]]>) => lists.map(([key, list]) => ({ lane: key, laneLabel: key, items: list }));
  const three = (over: Partial<FrontierDaily> = {}) => issue({
    lead: lead({ event: { id: "ev9", title: "同一事件" } }),
    safety: [scored("alert", 99)],
    sections: lanes(["evidence", [scored("e1", 40), scored("e2", 91)]], ["guideline", [scored("g1", 77), scored("g2", 20)]]),
    ...over,
  });
  const things = () => within(screen.getByRole("list", { name: "先看三件事" })).getAllByRole("listitem");

  it("is the lead and the two items the lanes score highest, each a title and its 导读 and no more, in a list of its own at the head of the issue", () => {
    show(three());
    expect(screen.getByRole("heading", { level: 3, name: "先看三件事" })).toBeInTheDocument();
    expect(things().map((row) => row.querySelector("[data-row-title]")?.textContent)).toEqual(["FDA 发布新方法学专题", "e2 标题", "g1 标题"]);
    expect(things().map((row) => row.querySelector("[data-prose]:not([data-row-title])")?.textContent)).toEqual(["FDA 发布直接最终规则。事件页 ›", "e2 的导读", "g1 的导读"]);
    expect(things().map((row) => row.firstElementChild?.textContent)).toEqual(["01", "02", "03"]);
    // not a row of a lane: no source line and no 详情, the title opens the reader
    for (const row of things()) {
      expect(within(row).queryByText(frontierItem().source.name)).not.toBeInTheDocument();
      expect(within(row).queryByRole("link", { name: "详情" })).not.toBeInTheDocument();
    }
    // It is the first block under the header; the lanes follow.
    const header = screen.getByRole("banner");
    expect(header.nextElementSibling).toBe(screen.getByRole("heading", { level: 3, name: "先看三件事" }).closest("section"));
  });

  it("opens the addressed reader from a title, and the lead's event from its own row", () => {
    show(three());
    expect(within(things()[1]).getByRole("link", { name: "e2 标题" })).toHaveAttribute("href", "/app/frontier/items/e2");
    expect(within(things()[0]).getByRole("link", { name: "事件页 ›" })).toHaveAttribute("href", "/app/frontier/events/ev9");
    expect(within(things()[1]).queryByRole("link", { name: "事件页 ›" })).not.toBeInTheDocument();
  });

  it("draws the lead once: the headline block is its first row, not a block above it", () => {
    show(three());
    expect(screen.queryByRole("region", { name: "头条" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "FDA 发布新方法学专题" })).toHaveLength(1);
  });

  it("is not drawn again in its lane: the lanes under it skip the three, with their counts and 分类 following, and a lane with nothing else goes", () => {
    const daily = three({ sections: lanes(["evidence", [scored("e1", 40), scored("e2", 91)]], ["guideline", [scored("g1", 77)]], ["industry", [scored("i1", 5)]]) });
    showWithToolbar(daily);
    expect(screen.getAllByRole("link", { name: "e2 标题" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "g1 标题" })).toHaveLength(1);
    expect(within(screen.getByRole("list", { name: "evidence" })).getAllByRole("listitem").map((row) => row.querySelector("[data-row-title]")?.textContent)).toEqual(["e1 标题"]);
    // g1 was its lane's only item: the lane is not drawn empty, and its heading is not left over
    expect(screen.queryByRole("list", { name: "guideline" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: /^guideline/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "evidence 1" })).toBeInTheDocument();
    const lanesMenu = dailyControls(state(daily), { onDay: () => {} }).filters.find((filter) => filter.label === "分类");
    expect(lanesMenu?.kind === "select" && lanesMenu.options.map((option) => option.label)).toEqual(["安全警示 1", "evidence 1", "industry 1"]);
  });

  it("leaves the lanes whole where there is no three: a week, or a day with fewer than three to show", () => {
    show(three(), { weekly: true, laneLimit: 5 });
    expect(within(screen.getByRole("list", { name: "evidence" })).getAllByRole("listitem")).toHaveLength(2);
    cleanup();
    show(three({ safety: [], sections: lanes(["evidence", [scored("only", 60)]]) }));
    expect(within(screen.getByRole("list", { name: "evidence" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("leaves the safety alerts to their own block under it, whatever their score", () => {
    show(three());
    expect(things().map((row) => row.querySelector("[data-row-title]")?.textContent)).not.toContain("alert 标题");
    const lists = screen.getAllByRole("list").filter((list) => list.tagName === "OL").map((list) => list.getAttribute("aria-label"));
    expect(lists.slice(0, 2)).toEqual(["先看三件事", "安全警示"]);
  });

  it("ranks by the score the lanes were composed with and, alike or unscored, by the issue's own order", () => {
    show(three({ lead: null, safety: [], sections: lanes(["evidence", [scored("a", null), scored("b", 50), scored("c", null)]], ["guideline", [scored("d", 50), scored("e", 10)]]) }));
    expect(things().map((row) => row.querySelector("[data-row-title]")?.textContent)).toEqual(["b 标题", "d 标题", "e 标题"]);
  });

  it("takes the three from the lanes when the issue has no lead", () => {
    show(three({ lead: null }));
    expect(things().map((row) => row.querySelector("[data-row-title]")?.textContent)).toEqual(["e2 标题", "g1 标题", "e1 标题"]);
  });

  it("is not drawn for fewer than three things, and the lead keeps its headline", () => {
    show(three({ safety: [], sections: lanes(["evidence", [scored("only", 60)]]) }));
    expect(screen.queryByRole("heading", { name: "先看三件事" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "头条" })).toBeInTheDocument();
  });

  it("is a day's, not a week's: the week keeps its headline and its lanes", () => {
    show(three(), { weekly: true, laneLimit: 5 });
    expect(screen.queryByRole("heading", { name: "先看三件事" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "头条" })).toBeInTheDocument();
  });

  it("marks its sentences as the issue's prose, as a lane's rows are", () => {
    show(three());
    for (const row of things()) expect(row.querySelector("p:not([data-row-title])")?.hasAttribute("data-prose")).toBe(true);
  });
});

describe("the freshness stamp", () => {
  it("says when the issue came out, once, in Beijing time — whatever zone the browser is in", () => {
    // 07:31 in Beijing on the issue's day.
    show(issue({ day: "2026-10-27", generatedAt: "2026-10-26T23:31:00.000Z" }));
    expect(screen.getByRole("banner")).toHaveTextContent("12 条 · 约 7 分钟 · 07:31 发布（北京时间）");
    expect(document.body.textContent?.match(/北京时间/g)).toHaveLength(1);
  });

  it("names the date of an issue written on another day than its own, and leaves out a stamp the server did not send", () => {
    show(issue({ day: "2026-10-27", generatedAt: "2026-10-27T16:05:00.000Z" }));
    expect(screen.getByRole("banner")).toHaveTextContent("约 7 分钟 · 10月28日 00:05 发布（北京时间）");
    cleanup();
    show(issue({ generatedAt: null }));
    expect(screen.getByRole("banner")).not.toHaveTextContent("北京时间");
  });
});

describe("the archive beside the issue", () => {
  const archive = [
    { day: "2026-10-27", title: null, itemCount: 18, generatedAt: null },
    { day: "2026-10-26", title: null, itemCount: 12, generatedAt: null },
    { day: "2026-09-30", title: null, itemCount: 9, generatedAt: null },
    { day: "2026-09-29", title: null, itemCount: 0, generatedAt: null },
  ];
  const withArchive = (over: Partial<DailyState> = {}): DailyState => ({ ...state(issue({ day: "2026-10-26" })), index: archive, ...over });
  const phone = () => vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 639px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  afterEach(() => { vi.restoreAllMocks(); });

  const beside = (current: DailyState, props: { onDay?: (day: string) => void } = {}) => {
    const controls = dailyControls(current, { onDay: props.onDay ?? (() => {}), beside: true });
    return render(<MemoryRouter><Toolbar label="简报的控制" filters={controls.filters} actions={controls.actions} /><DailyIssue state={current} onDay={props.onDay ?? (() => {})} /></MemoryRouter>);
  };

  it("cuts the issues into months, newest first, each day with its number of items, and marks the one open", () => {
    beside(withArchive());
    const column = screen.getByRole("navigation", { name: "往期日报" });
    expect(within(column).getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(["2026年10月", "2026年9月"]);
    expect(within(column).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["10月27日 周二，18 条", "10月26日 周一，12 条", "9月30日 周三，9 条", "9月29日 周二"]);
    expect(within(column).getAllByRole("button").map((button) => button.textContent)).toEqual(["27日 周二18", "26日 周一12", "30日 周三9", "29日 周二"]);
    expect(within(column).getByRole("button", { name: /^10月26日/ })).toHaveAttribute("aria-current", "date");
    expect(within(column).getAllByRole("button").filter((button) => button.hasAttribute("aria-current"))).toHaveLength(1);
  });

  it("opens an issue from its day, and the issue stands beside the column", async () => {
    const onDay = vi.fn();
    beside(withArchive(), { onDay });
    await userEvent.click(within(screen.getByRole("navigation", { name: "往期日报" })).getByRole("button", { name: /^9月30日/ }));
    expect(onDay).toHaveBeenCalledWith("2026-09-30");
    expect(screen.getByRole("navigation", { name: "往期日报" }).parentElement).toContainElement(screen.getByRole("article"));
  });

  it("is the toolbar's 往期 no longer: the same list is not drawn twice", () => {
    beside(withArchive());
    const toolbar = screen.getByRole("group", { name: "简报的控制" });
    expect(within(toolbar).queryByRole("button", { name: "往期" })).not.toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "复制" })).toBeInTheDocument();
  });

  it("ends in 「更早的日报」 where a full page was read, and reads the next page from it", async () => {
    const load = vi.fn();
    beside(withArchive({ more: { loading: false, load } }));
    await userEvent.click(within(screen.getByRole("navigation", { name: "往期日报" })).getByRole("button", { name: "更早的日报" }));
    expect(load).toHaveBeenCalledTimes(1);
    cleanup();
    beside(withArchive());
    expect(screen.queryByRole("button", { name: "更早的日报" })).not.toBeInTheDocument();
  });

  it("scrolls its own column to the open issue where that is out of sight, and leaves the page's ground alone", () => {
    // jsdom has no layout: the column is 400 high and a row 36, so the issue 30 rows down is a screen and more below the top.
    const rows = Array.from({ length: 60 }, (_, at) => ({ day: new Date(Date.UTC(2026, 9, 27 - at)).toISOString().slice(0, 10), title: null, itemCount: 5, generatedAt: null }));
    const offset = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      const at = [...(this.closest("nav")?.querySelectorAll("button") ?? [])].indexOf(this as HTMLButtonElement);
      return at < 0 ? 0 : at * 36;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(36);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    const scrolled = new WeakMap<Element, number>();
    Object.defineProperty(HTMLElement.prototype, "scrollTop", { configurable: true, get() { return scrolled.get(this) ?? 0; }, set(value: number) { scrolled.set(this, value); } });
    try {
      const open = rows[30].day;
      render(<MemoryRouter><DailyIssue state={{ ...state(issue({ day: open })), index: rows }} onDay={() => {}} /></MemoryRouter>);
      const column = screen.getByRole("navigation", { name: "往期日报" });
      expect(scrolled.get(column)).toBe(30 * 36 - (400 - 36) / 2);
      expect(scrollIntoView).not.toHaveBeenCalled();
      cleanup();
      // An issue already in sight moves nothing.
      render(<MemoryRouter><DailyIssue state={{ ...state(issue({ day: rows[3].day })), index: rows }} onDay={() => {}} /></MemoryRouter>);
      expect(scrolled.get(screen.getByRole("navigation", { name: "往期日报" }))).toBeUndefined();
    } finally {
      offset.mockRestore();
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
    }
  });

  it("is not drawn for the one issue there is, which keeps its 往期 in the toolbar", () => {
    const only = withArchive({ index: [archive[1]] });
    const controls = dailyControls(only, { onDay: () => {}, beside: false });
    render(<MemoryRouter><Toolbar label="简报的控制" filters={controls.filters} /><DailyIssue state={only} onDay={() => {}} /></MemoryRouter>);
    expect(screen.queryByRole("navigation", { name: "往期日报" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "往期" })).toBeInTheDocument();
  });

  it("is a daily's: a week keeps its menu, whatever the room", () => {
    const week = withArchive({ index: archive.map((entry) => ({ ...entry, weekStart: entry.day, weekEnd: entry.day })) });
    const controls = dailyControls(week, { onDay: () => {}, weekly: true, beside: true });
    render(<MemoryRouter><Toolbar label="简报的控制" filters={controls.filters} /><DailyIssue state={week} onDay={() => {}} weekly laneLimit={5} /></MemoryRouter>);
    expect(screen.queryByRole("navigation", { name: "往期日报" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "往期" })).toBeInTheDocument();
  });

  describe("on a phone", () => {
    beforeEach(() => { phone(); });
    /** The toolbar folds its filters into 「筛选」 on a phone, so these read what the page hands it. */
    const filters = (current: DailyState, onDay: (day: string) => void = () => {}) => dailyControls(current, { onDay, beside: false }).filters;
    const labelled = (list: ReturnType<typeof filters>, label: string) => {
      const found = list.find((filter) => filter.label === label);
      if (!found || found.kind !== "select") throw new Error(`no select named ${label}`);
      return found;
    };

    it("has no column; 月份 comes before 往期, which lists the open issue's month", () => {
      const onDay = vi.fn();
      const current = withArchive({ browse: { month: null, setMonth: () => {} } });
      render(<MemoryRouter><DailyIssue state={current} onDay={onDay} /></MemoryRouter>);
      expect(screen.queryByRole("navigation", { name: "往期日报" })).not.toBeInTheDocument();
      const list = filters(current, onDay);
      expect(list.map((filter) => filter.label)).toEqual(["分类", "月份", "往期"]);
      const past = labelled(list, "往期");
      expect(past.options).toEqual([{ value: "2026-10-27", label: "10月27日 周二" }, { value: "2026-10-26", label: "10月26日 周一" }]);
      past.onChange("2026-10-27");
      expect(onDay).toHaveBeenCalledWith("2026-10-27");
    });

    it("lists the months with their numbers of issues, and a month chosen is the month 往期 lists", () => {
      const setMonth = vi.fn();
      const month = labelled(filters(withArchive({ browse: { month: null, setMonth } })), "月份");
      expect(month.options.map((option) => option.label)).toEqual(["2026年10月 · 2 期", "2026年9月 · 2 期"]);
      expect(month.value).toBeNull();
      month.onChange("2026-09");
      expect(setMonth).toHaveBeenCalledWith("2026-09");
      const chosen = filters(withArchive({ browse: { month: "2026-09", setMonth } }));
      expect(labelled(chosen, "往期").options.map((option) => option.label)).toEqual(["9月30日 周三", "9月29日 周二"]);
    });

    it("gives the oldest month no count while older issues remain unread: the page ended inside it", () => {
      const more = { loading: false, load: () => {} };
      const held = labelled(filters(withArchive({ browse: { month: null, setMonth: () => {} }, more })), "月份");
      expect(held.options.map((option) => option.label)).toEqual(["2026年10月 · 2 期", "2026年9月", "更早的日报"]);
      // with nothing older the whole of every month is held, and each says so
      const whole = labelled(filters(withArchive({ browse: { month: null, setMonth: () => {} }, more: null })), "月份");
      expect(whole.options.map((option) => option.label)).toEqual(["2026年10月 · 2 期", "2026年9月 · 2 期"]);
    });

    it("offers the next page of the archive as the last month, where a full page was read", () => {
      const load = vi.fn();
      const month = labelled(filters(withArchive({ browse: { month: null, setMonth: () => {} }, more: { loading: false, load } })), "月份");
      expect(month.options.at(-1)).toEqual({ value: "older", label: "更早的日报" });
      month.onChange("older");
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("offers no 月份 for one month, or for a state that cannot browse", () => {
      expect(filters(withArchive({ index: archive.slice(0, 2), browse: { month: null, setMonth: () => {} } })).map((filter) => filter.label)).toEqual(["分类", "往期"]);
      expect(filters(withArchive()).map((filter) => filter.label)).toEqual(["分类", "往期"]);
    });
  });
});

describe("a day without an issue", () => {
  const empty = (over: Partial<DailyState> = {}): DailyState => ({ index: [], issue: null, loading: false, error: null, retry: () => {}, ...over });
  const showEmpty = (state: DailyState, props: Partial<Parameters<typeof DailyIssue>[0]> = {}) =>
    render(<MemoryRouter><DailyIssue state={state} onDay={() => {}} {...props} /></MemoryRouter>);

  it.each([
    ["pending", "10月1日 周四的日报尚未发布。"],
    ["failed", "10月1日 周四的日报生成失败。"],
    ["empty", "10月1日 周四没有符合条件的内容，没有出刊。"],
  ] as const)("keeps the real publication date for a %s outcome and offers past issues", (outcome, title) => {
    showEmpty(empty({
      publication: { day: "2026-10-01", state: outcome },
      index: [{ day: "2026-09-30", title: null, itemCount: 3, generatedAt: null }],
    }));
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "往期" })).toBeInTheDocument();
  });

  it("names the publication time and time zone the server reports, not a time written into the page", () => {
    showEmpty(empty({ schedule: { time: "08:15", timeZone: "Asia/Shanghai" } }));
    expect(screen.getByText("今日日报 08:15（北京时间）发布")).toBeInTheDocument();
    expect(screen.queryByText(/07:30/)).not.toBeInTheDocument();
  });

  it("names another time zone by its own name", () => {
    showEmpty(empty({ schedule: { time: "07:30", timeZone: "UTC" } }));
    expect(screen.getByText(/^今日日报 07:30（.*(UTC|协调世界时|世界时间).*）发布$/)).toBeInTheDocument();
  });

  it("promises no time from a server that named none", () => {
    showEmpty(empty());
    expect(screen.getByText("今日日报尚未发布")).toBeInTheDocument();
    expect(screen.queryByText(/\d{2}:\d{2}/)).not.toBeInTheDocument();
    // With nothing published at all there is no past to open — and the page is still not a dead end: the feed is a link away.
    expect(screen.queryByRole("button", { name: "往期" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看精选动态" })).toHaveAttribute("href", "/app/frontier");
  });

  it("lets the reader open a past issue from the empty state when there are any, for the real day that has none", async () => {
    const onDay = vi.fn();
    showEmpty(empty({
      day: "2026-10-01", schedule: { time: "07:30", timeZone: "Asia/Shanghai" },
      index: [{ day: "2026-10-07", title: null, itemCount: 12, generatedAt: null }, { day: "2026-10-06", title: null, itemCount: 9, generatedAt: null }],
    }), { onDay });
    // One sentence: the fact once, and no 「周四日报」 run together (R19, audit D C3).
    expect(screen.getByText("10月1日 周四没有日报：当天没有符合条件的内容时不出刊。")).toBeInTheDocument();
    expect(screen.queryByText(/07:30/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "往期" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "10月6日 周二" }));
    expect(onDay).toHaveBeenCalledWith("2026-10-06");
  });

  it("keeps saying 暂无日报 where the server has no daily at all, and 暂无周报 for a week", () => {
    showEmpty(empty({ index: null }));
    expect(screen.getByText("暂无日报")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看精选动态" })).toBeInTheDocument();
    cleanup();
    showEmpty(empty(), { weekly: true });
    expect(screen.getByText("暂无周报")).toBeInTheDocument();
  });
});

it("restores a weekly lane's expanded rows from the feed reading position", () => {
  render(<MemoryRouter><DailyIssue weekly laneLimit={2} state={state(issue({ safety: [], sections: [lane("evidence", "临床证据", 8)] }))} onDay={() => {}} expansion={{ ids: ["digest:week:2026-10-07:evidence"], onExpand: () => {} }} /></MemoryRouter>);
  expect(within(screen.getByRole("list", { name: "临床证据" })).getAllByRole("listitem")).toHaveLength(8);
  expect(screen.queryByRole("button", { name: "展开其余 6 条" })).not.toBeInTheDocument();
});
