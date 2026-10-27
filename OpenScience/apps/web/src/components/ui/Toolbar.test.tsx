import { useState, type ReactNode } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Star } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toolbar, type ToolbarFilter, type ToolbarProps, type ToolbarToken } from "./Toolbar";

/** A viewport that matches the narrow query and nothing else (jsdom has no layout). */
function narrow() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 639px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const LANES = [{ value: "evidence", label: "临床证据" }, { value: "safety", label: "药物安全" }];
const WINDOWS = [{ value: "now", label: "当前" }, { value: "week", label: "本周" }, { value: "month", label: "本月" }];

it("keeps a real selected scope reachable alongside a list action at narrow widths", async () => {
  narrow();
  const openScope = vi.fn(), continueWork = vi.fn();
  const scope = { scopeAction: { id: "scope", label: "分析范围 · 已筛选", onSelect: openScope } } as unknown as ToolbarProps;
  render(<Toolbar oneRow {...scope}
    views={{ label: "研究视图", items: [{ value: "current", label: "当前" }], value: "current", onChange: () => {} }}
    actionPlan={{ primary: { id: "continue", label: "加问", onSelect: continueWork } }} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "分析范围 · 已筛选" }));
  await user.click(screen.getByRole("button", { name: "加问" }));
  expect(openScope).toHaveBeenCalledOnce();
  expect(continueWork).toHaveBeenCalledOnce();
});

function Page({ onSelect = vi.fn() }: { onSelect?: (value: string | null) => void }) {
  const [lane, setLane] = useState<string | null>(null);
  const [window, setWindow] = useState("now");
  const [starred, setStarred] = useState(false);
  const [query, setQuery] = useState("");
  const filters: ToolbarFilter[] = [
    { kind: "select", label: "全部栏目", allLabel: "全部栏目", options: LANES, value: lane, onChange: (next) => { setLane(next); onSelect(next); } },
    { kind: "chips", label: "时间范围", options: WINDOWS, value: window, onChange: setWindow },
    { kind: "toggle", label: "收藏", icon: Star, pressed: starred, onChange: setStarred },
  ];
  return (
    <Toolbar
      views={{ label: "动态视图", items: [{ value: "all", label: "全部" }, { value: "hot", label: "热榜" }], value: "all", onChange: () => {}, panelId: "feed" }}
      filters={filters}
      onClear={() => { setLane(null); setWindow("now"); setStarred(false); setQuery(""); }}
      search={{ label: "搜索动态", value: query, onChange: setQuery, onClear: () => setQuery("") }}
      summary="38 条"
      actions={<button type="button">管理关注</button>}
    />
  );
}

describe("Toolbar", () => {
  it("is one row: the views, the filters it draws itself, then the search, the count and the actions", () => {
    const { container } = render(<Page />);
    const toolbar = container.querySelector("[data-toolbar]") as HTMLElement;
    expect(toolbar).not.toBeNull();
    expect(within(toolbar).getAllByRole("tablist")).toHaveLength(1);
    expect(within(toolbar).getByRole("tab", { name: "全部" })).toHaveAttribute("aria-selected", "true");
    // The three kinds of filter, in the order the page declared them.
    const order = [...toolbar.querySelectorAll("button, input")].map((node) => node.getAttribute("aria-label") ?? node.textContent);
    expect(order).toEqual(["全部", "热榜", "全部栏目", "当前", "本周", "本月", "收藏", "搜索动态", "管理关注"]);
    expect(within(toolbar).getByText("38 条")).toBeInTheDocument();
  });

  it("changes a select, a chip row and a toggle through their own callbacks, and clears them all at once", async () => {
    const selected = vi.fn();
    render(<Page onSelect={selected} />);
    expect(screen.queryByRole("button", { name: "清除筛选" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "全部栏目" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "药物安全" }));
    expect(selected).toHaveBeenCalledWith("safety");
    await userEvent.click(screen.getByRole("button", { name: "本周" }));
    expect(screen.getByRole("button", { name: "本周" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "收藏" }));
    expect(screen.getByRole("button", { name: "收藏" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("button", { name: "当前" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "收藏" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "清除筛选" })).toBeNull();
  });

  it("shows the clear chip for a search alone, and the search's own clear empties it", async () => {
    render(<Page />);
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索动态" }), "阿司匹林");
    expect(screen.getByRole("button", { name: "清除筛选" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getByRole("searchbox", { name: "搜索动态" })).toHaveValue("");
  });

  it("folds the filters into one 「筛选」 chip on a phone, which opens a sheet of labelled groups — never a menu that stacks them", async () => {
    narrow();
    const selected = vi.fn();
    render(<Page onSelect={selected} />);
    // No row of chips: the one chip stands for the three filters; the views and the search stay.
    expect(screen.queryByRole("button", { name: "本周" })).toBeNull();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "筛选" }));
    const sheet = screen.getByRole("dialog", { name: "筛选" });
    expect(screen.queryByRole("menu")).toBeNull();
    // Each dimension is a group under its own name: the select's chips with its 「全部」 first, the chip row as it is, the toggle a switch.
    const lanes = within(sheet).getByRole("group", { name: "全部栏目" });
    expect(within(lanes).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部", "临床证据", "药物安全"]);
    expect(within(within(sheet).getByRole("group", { name: "时间范围" })).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["当前", "本周", "本月"]);
    await userEvent.click(within(lanes).getByRole("button", { name: "临床证据" }));
    expect(selected).toHaveBeenCalledWith("evidence");
    expect(within(lanes).getByRole("button", { name: "临床证据" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(sheet).getByRole("switch", { name: "收藏" }));
    expect(within(sheet).getByRole("switch", { name: "收藏" })).toHaveAttribute("aria-checked", "true");
    // 「查看结果」 closes the sheet: the choices applied as they were made.
    await userEvent.click(within(sheet).getByRole("button", { name: "查看结果" }));
    expect(screen.queryByRole("dialog", { name: "筛选" })).toBeNull();
    expect(screen.getByRole("button", { name: "筛选，已选 2 项" })).toHaveTextContent("筛选 · 2");
    // 「重置」 lets go of every filter at once.
    await userEvent.click(screen.getByRole("button", { name: "筛选，已选 2 项" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "筛选" })).getByRole("button", { name: "重置" }));
    expect(screen.getByRole("button", { name: "筛选" })).toBeInTheDocument();
  });

  it("keeps the search in the row on a phone, taking what is left, so a band with a search is as tall as one without", () => {
    // 循证 GEO at 390 px: the search took a row of its own and the band of five tabs was 160 px, of three 124 (module-chrome).
    narrow();
    render(<Page onSelect={vi.fn()} />);
    const end = screen.getByRole("searchbox").closest("div.ml-auto") as HTMLElement;
    expect(end.className).toMatch(/max-sm:flex-1/);
    expect(end.className).not.toMatch(/basis-full/);
    // The search keeps room to type in (112 px); the count beside it gives way first.
    expect(screen.getByRole("searchbox").closest("label")!.className).toMatch(/max-sm:min-w-28/);
  });

  it("keeps a pinned group of chips on the row on a phone — the page's own views — and folds the rest", async () => {
    narrow();
    const changed = vi.fn();
    const { container } = render(
      <Toolbar
        filters={[
          { kind: "chips", label: "地图的视图", neutral: "graph", options: [{ value: "graph", label: "关系" }, { value: "time", label: "时间" }], value: "graph", onChange: changed, pinned: true },
          { kind: "select", label: "种类", allLabel: "全部种类", options: LANES, value: null, onChange: () => {} },
        ]}
        onClear={() => {}}
      />,
    );
    const toolbar = container.querySelector("[data-toolbar]") as HTMLElement;
    // The views are on the row; the kind of memory is behind the one chip, which counts what is on among what it holds.
    expect(within(toolbar).getByRole("group", { name: "地图的视图" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "时间" })).toBeInTheDocument();
    expect(within(toolbar).queryByRole("button", { name: "种类" })).toBeNull();
    expect(within(toolbar).getByRole("button", { name: "筛选" })).toBeInTheDocument();
    await userEvent.click(within(toolbar).getByRole("button", { name: "时间" }));
    expect(changed).toHaveBeenCalledWith("time");
    // A pinned chip group that is on still counts for 「清除筛选」, though not for the number on the folded chip.
    expect(within(toolbar).queryByRole("button", { name: "清除筛选" })).toBeNull();
  });

  it("draws a pinned group like any other where the window is wide", () => {
    const { container } = render(
      <Toolbar filters={[{ kind: "chips", label: "地图的视图", options: [{ value: "graph", label: "关系" }], value: "graph", onChange: () => {}, pinned: true }]} />,
    );
    expect(within(container.querySelector("[data-toolbar]") as HTMLElement).getByRole("group", { name: "地图的视图" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "筛选" })).toBeNull();
  });

  it("is a row of its own without views, so a section can carry one", () => {
    const { container } = render(<Toolbar filters={[{ kind: "toggle", label: "只看需要看一眼的", pressed: false, onChange: () => {} }]} summary="12 项" />);
    expect(container.querySelector("[data-toolbar]")).not.toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "只看需要看一眼的" })).toBeInTheDocument();
  });

  describe("in the sticky band, where the row is one line whatever the data", () => {
    /** A layout for jsdom: the row is 64 px tall (two lines) while it holds the filters in a row narrower than 1,000 px, 28 otherwise. */
    function layout(widths: { current: number }) {
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("flex-wrap") && this.querySelector("[aria-label='时间范围']") && widths.current < 1_000 ? 64 : 28;
      });
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("flex-wrap") ? widths.current : 0;
      });
      const observers: Array<() => void> = [];
      vi.stubGlobal("ResizeObserver", class {
        constructor(private callback: () => void) {}
        observe(element: HTMLElement) { if (element.classList.contains("-ml-3")) observers.push(this.callback); }
        unobserve() {}
        disconnect() {}
      });
      return observers;
    }
    const filters: ToolbarFilter[] = [
      { kind: "chips", label: "视图", pinned: true, options: [{ value: "a", label: "按问句池" }, { value: "b", label: "按旅程" }], value: "a", onChange: () => {} },
      { kind: "chips", label: "时间范围", options: WINDOWS, value: "now", onChange: () => {} },
    ];

    it("folds the filters into 「筛选」 when they would wrap, and keeps the page's own views, the search and the count on the row", () => {
      layout({ current: 900 });
      render(<Toolbar inBand filters={filters} search={{ label: "搜索问题", value: "", onChange: () => {} }} summary="25 个问题群" />);
      expect(screen.queryByRole("button", { name: "本周" })).toBeNull();
      expect(screen.getByRole("button", { name: "筛选" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "按旅程" })).toBeInTheDocument();
      expect(screen.getByRole("searchbox", { name: "搜索问题" })).toBeInTheDocument();
      expect(screen.getByText("25 个问题群")).toBeInTheDocument();
    });

    it("unfolds when the row has grown past the width where they did not fit, and not before", () => {
      const widths = { current: 900 };
      const observers = layout(widths);
      render(<Toolbar inBand filters={filters} />);
      expect(screen.queryByRole("button", { name: "本周" })).toBeNull();
      // Still the same width: nothing to try.
      act(() => observers.forEach((notify) => notify()));
      expect(screen.queryByRole("button", { name: "本周" })).toBeNull();
      widths.current = 1100;
      act(() => observers.forEach((notify) => notify()));
      expect(screen.getByRole("button", { name: "本周" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "筛选" })).toBeNull();
      // And a row that shrinks again folds them again.
      widths.current = 800;
      act(() => observers.forEach((notify) => notify()));
      expect(screen.queryByRole("button", { name: "本周" })).toBeNull();
    });

    it("folds the filters beside the page's views when the views no longer all show, and keeps every view on the row", () => {
      const widths = { current: 1000 };
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
        // The tab list holds 600 px of tabs; it is given what the row leaves beside the filters (500 px of them) or the folded chip (300).
        return this.getAttribute("role") === "tablist" ? 600 : 0;
      });
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("role") === "tablist") return widths.current - (this.closest("[data-toolbar]")?.querySelector("[aria-label='时间范围']") ? 500 : 300);
        return this.hasAttribute("data-toolbar") ? widths.current : 0;
      });
      const observers: Array<() => void> = [];
      vi.stubGlobal("ResizeObserver", class {
        constructor(private callback: () => void) {}
        observe() { observers.push(this.callback); }
        unobserve() {}
        disconnect() {}
      });
      const views = { label: "动态视图", items: [{ value: "a", label: "精选" }, { value: "b", label: "简报" }], value: "a", onChange: () => {} };
      render(<Toolbar inBand views={views} filters={filters} />);
      expect(screen.queryByRole("button", { name: "本周" })).toBeNull();
      expect(screen.getByRole("button", { name: "筛选" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "简报" })).toBeInTheDocument();
      // Wider than where they did not fit: they are tried on the row again.
      widths.current = 1400;
      act(() => observers.forEach((notify) => notify()));
      expect(screen.getByRole("button", { name: "本周" })).toBeInTheDocument();
    });

    it("leaves a toolbar outside the band alone, wrapping or not", () => {
      layout({ current: 900 });
      render(<Toolbar filters={filters} />);
      expect(screen.getByRole("button", { name: "本周" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "筛选" })).toBeNull();
    });

    it("draws everything when the row fits", () => {
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(28);
      render(<Toolbar inBand filters={filters} />);
      expect(screen.getByRole("button", { name: "本周" })).toBeInTheDocument();
    });

    it("keeps an open pinned menu and its focus when late filters fold the row, then when it unfolds", async () => {
      const widths = { current: 900 };
      const observers = layout(widths);
      const selected = vi.fn();
      const declared: ToolbarFilter[] = [
        { kind: "toggle", label: "收藏", pressed: false, onChange: () => {} },
        { kind: "select", label: "查看", pinned: true, value: "accuracy", options: [{ value: "accuracy", label: "准确与安全" }, { value: "questions", label: "问题与回答" }], onChange: selected },
      ];
      const { rerender } = render(<Toolbar inBand filters={declared} />);
      const trigger = screen.getByRole("button", { name: "查看：准确与安全" });
      const order = [...trigger.parentElement!.querySelectorAll("button")].map(button => button.getAttribute("aria-label") ?? button.textContent);
      expect(order).toEqual(["收藏", "查看：准确与安全"]);
      await userEvent.click(trigger);
      const menu = screen.getByRole("menu", { name: "查看" });
      const focused = document.activeElement;
      rerender(<Toolbar inBand filters={[...declared, filters[1]]} />);
      act(() => observers.forEach(notify => notify()));
      expect(screen.getByRole("button", { name: "筛选" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "查看：准确与安全" })).toBe(trigger);
      expect(screen.getByRole("menu", { name: "查看" })).toBe(menu);
      expect(document.activeElement).toBe(focused);
      await userEvent.click(within(menu).getByRole("menuitemradio", { name: "问题与回答" }));
      expect(selected).toHaveBeenLastCalledWith("questions");
      await userEvent.click(trigger);
      const reopened = screen.getByRole("menu", { name: "查看" });
      const refocused = document.activeElement;
      widths.current = 1100;
      act(() => observers.forEach(notify => notify()));
      expect(screen.queryByRole("button", { name: "筛选" })).toBeNull();
      expect(screen.getByRole("button", { name: "查看：准确与安全" })).toBe(trigger);
      expect(screen.getByRole("menu", { name: "查看" })).toBe(reopened);
      expect(document.activeElement).toBe(refocused);
      expect([...trigger.parentElement!.querySelectorAll("button")].map(button => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["收藏", "查看：准确与安全", "当前", "本周", "本月"]);
      await userEvent.click(within(reopened).getByRole("menuitemradio", { name: "问题与回答" }));
      expect(selected).toHaveBeenCalledTimes(2);
    });

    it("lets a band summary give room to mobile actions while keeping its complete text accessible", () => {
      narrow();
      const summary = "合作方：研究协作中心 · 候选 6 名 · 数据快照 2026-10-20";
      const { rerender } = render(<Toolbar inBand filters={[{ kind: "select", label: "查看", pinned: true, value: "matching", options: [{ value: "matching", label: "匹配与招募" }], onChange: () => {} }]} summary={summary} actions={<button>选择方法</button>} />);
      const text = screen.getByText(summary);
      expect(text).not.toHaveAttribute("title");
      expect(text).toHaveClass("min-w-0", "truncate", "max-sm:flex-1");
      expect(text.parentElement).toHaveClass("max-sm:flex-1");
      expect(screen.getByRole("button", { name: "选择方法" })).toBeInTheDocument();
      rerender(<Toolbar summary={summary} actions={<button>选择方法</button>} />);
      expect(screen.getByText(summary)).not.toHaveClass("max-sm:flex-1");
      rerender(<Toolbar inBand actions={<button>选择方法</button>} />);
      expect(screen.getByRole("button", { name: "选择方法" }).parentElement).not.toHaveClass("max-sm:flex-1");
    });
  });
});

it("keeps an opted-in View select explicit on a phone while ordinary filters fold", () => {
  narrow();
  render(<Toolbar filters={[{ kind: "select", label: "查看", value: "chat", options: [{ value: "chat", label: "对话" }], onChange: () => undefined, pinned: true }, { kind: "select", label: "状态", value: "running", options: [{ value: "running", label: "进行中" }], onChange: () => undefined }]} />);
  expect(screen.getByRole("button", { name: "查看：对话" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "筛选，已选 1 项" })).toBeInTheDocument();
});

it("uses the shared tooltip for a clipped band summary and lets touch readers open its full text without a second row", async () => {
  narrow();
  const summary = "合作方：研究协作中心 · 候选 6 名 · 数据快照 2026-10-20";
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) { return this.textContent === summary ? 400 : 0; });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.textContent === summary ? 40 : 0; });
  render(<Toolbar inBand summary={summary} actions={<button>选择方法</button>} />);
  const trigger = screen.getByRole("button", { name: summary });
  expect(trigger).not.toHaveAttribute("title");
  await userEvent.tab();
  expect(trigger).toHaveFocus(); expect(screen.getByRole("tooltip")).toHaveTextContent(summary);
  await userEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "完整摘要" })).toHaveTextContent(summary);
  expect(screen.getByRole("button", { name: "选择方法" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}"); expect(screen.queryByRole("dialog", { name: "完整摘要" })).toBeNull();
});

describe("a panel of filters (前沿动态's 「专科 ▾」 and 「更多筛选 ▾」, 2026-10-23)", () => {
  const GROUPS = [{ label: "内科", values: ["cardiology", "oncology"] }, { label: "外科", values: ["general-surgery"] }];
  const SPECIALTIES = [{ value: "cardiology", label: "心血管" }, { value: "oncology", label: "肿瘤" }, { value: "general-surgery", label: "普通外科" }];

  function Panels({ onClear = vi.fn() }: { onClear?: () => void }) {
    const [specialties, setSpecialties] = useState<string[]>([]);
    const [source, setSource] = useState("");
    const [unread, setUnread] = useState(false);
    const filters: ToolbarFilter[] = [
      {
        kind: "panel", label: "专科", chosen: specialties.length ? `${specialties.length} 个专科` : undefined,
        groups: [{ kind: "chips", multi: true, label: "专科", options: SPECIALTIES, sections: GROUPS, value: specialties, onChange: setSpecialties }],
        onClear: () => { setSpecialties([]); onClear(); },
      },
      {
        kind: "panel", label: "更多筛选",
        groups: [
          { kind: "chips", label: "来源", options: [{ value: "", label: "全部" }, { value: "news", label: "资讯" }], value: source, neutral: "", onChange: (next: string) => setSource(next) },
          { kind: "toggle", label: "只看未读", pressed: unread, onChange: (next: boolean) => setUnread(next) },
        ],
      },
    ];
    return <Toolbar filters={filters} onClear={() => { setSpecialties([]); setSource(""); setUnread(false); }} />;
  }

  it("opens its groups under the chip, several at once where it says so, and reads what is chosen", async () => {
    render(<Panels />);
    await userEvent.click(screen.getByRole("button", { name: "专科" }));
    const panel = screen.getByRole("dialog", { name: "专科" });
    // The specialties under their group's name, each a chip that is pressed or not.
    expect(within(panel).getByRole("group", { name: "内科" })).toHaveTextContent("心血管肿瘤");
    await userEvent.click(within(panel).getByRole("button", { name: "心血管" }));
    await userEvent.click(within(panel).getByRole("button", { name: "普通外科" }));
    expect(within(panel).getByRole("button", { name: "心血管" })).toHaveAttribute("aria-pressed", "true");
    expect(within(panel).getByRole("button", { name: "普通外科" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "专科：2 个专科" })).toHaveTextContent("2 个专科");
    // A second press lets one go; 「清除」 lets go of the rest.
    await userEvent.click(within(panel).getByRole("button", { name: "心血管" }));
    expect(within(panel).getByRole("button", { name: "心血管" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(within(panel).getByRole("button", { name: "清除" }));
    expect(screen.getByRole("button", { name: "专科" })).toBeInTheDocument();
  });

  it("counts the groups that are on in its chip, and switches its toggles", async () => {
    render(<Panels />);
    await userEvent.click(screen.getByRole("button", { name: "更多筛选" }));
    const panel = screen.getByRole("dialog", { name: "更多筛选" });
    await userEvent.click(within(within(panel).getByRole("group", { name: "来源" })).getByRole("button", { name: "资讯" }));
    await userEvent.click(within(panel).getByRole("switch", { name: "只看未读" }));
    expect(screen.getByRole("button", { name: "更多筛选：更多筛选 · 2" })).toHaveTextContent("更多筛选 · 2");
    expect(screen.getByRole("button", { name: "清除筛选" })).toBeInTheDocument();
  });

  it("puts a panel's own groups into the phone's one sheet, not the panel's chip", async () => {
    narrow();
    render(<Panels />);
    expect(screen.queryByRole("button", { name: "专科" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "筛选" }));
    const sheet = screen.getByRole("dialog", { name: "筛选" });
    expect(within(sheet).getByRole("group", { name: "外科" })).toBeInTheDocument();
    expect(within(sheet).getByRole("group", { name: "来源" })).toBeInTheDocument();
    expect(within(sheet).getByRole("switch", { name: "只看未读" })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "肿瘤" }));
    expect(screen.getByRole("button", { name: "筛选，已选 1 项" })).toBeInTheDocument();
  });

  it("opens the same groups under 「筛选」 where a wide band's row ran out of room", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("flex-wrap") && this.querySelector("[aria-haspopup='dialog']") ? 64 : 28;
    });
    render(<Toolbar inBand filters={[
      { kind: "chips", label: "视图", pinned: true, options: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }], value: "a", onChange: () => {} },
      { kind: "panel", label: "更多筛选", groups: [{ kind: "toggle", label: "只看未读", pressed: false, onChange: () => {} }] },
    ]} />);
    expect(screen.queryByRole("button", { name: "更多筛选" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "筛选" }));
    expect(screen.getByRole("dialog", { name: "筛选" })).toContainElement(screen.getByRole("switch", { name: "只看未读" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("one row with a filter button (`oneRow`, 前沿动态 2026-10-25)", () => {
  const views = { label: "动态视图", items: [{ value: "a", label: "精选" }, { value: "b", label: "关注" }], value: "a", onChange: () => {}, panelId: "feed" };
  const SPECIALTIES = [{ value: "onc", label: "肿瘤" }, { value: "cardio", label: "心血管" }, { value: "neuro", label: "神经" }];

  function Feed({ tokens = [], extra = [], reset = vi.fn(), search = true, sheetLead }: {
    tokens?: ToolbarToken[]; extra?: ToolbarFilter[]; reset?: () => void; search?: boolean; sheetLead?: (close: () => void) => ReactNode;
  }) {
    const [lane, setLane] = useState("");
    const [specialties, setSpecialties] = useState<string[]>([]);
    const [starred, setStarred] = useState(false);
    const [hot, setHot] = useState("");
    const [query, setQuery] = useState("");
    const filters: ToolbarFilter[] = [
      ...extra,
      { kind: "chips", label: "栏目", folded: true, options: [{ value: "", label: "全部" }, ...LANES], value: lane, neutral: "", onChange: setLane },
      // Several at once is a group of a panel: the panel is folded, and its groups are the sheet's.
      { kind: "panel", label: "专科", folded: true, groups: [
        { kind: "chips", multi: true, label: "专科", options: SPECIALTIES, value: specialties, onChange: setSpecialties,
          chosenAction: (value: string) => ({ label: value === "cardio" ? "已关注" : "关注", disabled: value === "cardio", onClick: () => {} }) },
        { kind: "chips", label: "热门标签", quiet: true, options: [{ value: "hcc", label: "#肝细胞癌" }], value: hot, neutral: "", onChange: setHot },
      ] },
      { kind: "toggle", label: "只看收藏", folded: true, pressed: starred, onChange: setStarred },
    ];
    return (
      <Toolbar oneRow searchShortcut views={views} filters={filters} tokens={tokens} sheetLead={sheetLead}
        onReset={() => { reset(); setLane(""); setSpecialties([]); setStarred(false); }}
        search={search ? { label: "搜索", value: query, onChange: setQuery, onClear: () => setQuery("") } : undefined}
        summary="3 个" actions={<button type="button">新建</button>} />
    );
  }

  async function choose(...names: string[]) {
    await userEvent.click(screen.getByRole("button", { name: /^筛选/ }));
    for (const name of names) await userEvent.click(within(screen.getByRole("dialog", { name: "筛选" })).getByRole("button", { name }));
  }

  it("keeps the folded filters inside 「筛选」 at every width, on the views' own row, with the search last", () => {
    const { container } = render(<Feed />);
    const toolbar = container.querySelector("[data-toolbar]") as HTMLElement;
    expect(within(toolbar).getAllByRole("tablist")).toHaveLength(1);
    expect(within(toolbar).queryByRole("group", { name: "栏目" })).toBeNull();
    expect(container.querySelector("[data-toolbar-row]")).toBeNull();
    const order = [...toolbar.querySelectorAll("button, input")].map((node) => node.getAttribute("aria-label") ?? node.textContent);
    expect(order).toEqual(["精选", "关注", "筛选", "新建", "搜索"]);
    expect(within(toolbar).getByText("3 个")).toBeInTheDocument();
  });

  it("opens the panel with its groups in order, a choice applying at once, and counts what is on — not a quiet group — with the accent mark", async () => {
    const { container } = render(<Feed />);
    expect(container.querySelector("[data-filter-mark]")).toBeNull();
    await choose("临床证据", "肿瘤", "#肝细胞癌");
    const panel = screen.getByRole("dialog", { name: "筛选" });
    expect(within(panel).getAllByRole("group").map((group) => group.getAttribute("aria-label") ?? group.textContent?.slice(0, 2))).toEqual(
      expect.arrayContaining(["栏目", "专科"]),
    );
    expect(screen.getByRole("button", { name: "筛选，已选 2 项" })).toHaveTextContent("筛选 · 2");
    expect(container.querySelector("[data-filter-mark]")).not.toBeNull();
  });

  it("offers each chosen value's own button under a group of several", async () => {
    render(<Feed />);
    await choose("肿瘤", "心血管");
    const panel = screen.getByRole("dialog", { name: "筛选" });
    expect(within(panel).getByRole("button", { name: "关注：肿瘤" })).toBeEnabled();
    expect(within(panel).getByRole("button", { name: "已关注：心血管" })).toBeDisabled();
  });

  it("says what is on as tokens before 「筛选」 — at most two, then 「+N」 that opens the panel — and each press lets go of its own", async () => {
    render(<Feed />);
    await choose("临床证据", "肿瘤", "神经");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "筛选" })).toBeNull();
    expect(screen.getByRole("button", { name: "移除筛选：临床证据" })).not.toHaveAttribute("aria-pressed");
    expect(screen.getByRole("button", { name: "移除筛选：肿瘤 等 2 个" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^筛选/ }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "筛选" })).getByRole("switch", { name: "只看收藏" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "移除筛选：只看收藏" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "另有 1 项筛选，打开筛选" }));
    expect(screen.getByRole("dialog", { name: "筛选" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "移除筛选：临床证据" }));
    expect(screen.queryByRole("button", { name: "移除筛选：临床证据" })).toBeNull();
    expect(screen.getByRole("button", { name: "筛选，已选 2 项" })).toBeInTheDocument();
  });

  it("draws the page's own tokens first, with their button, and 「清除」 lets go of the filters among them", async () => {
    const follow = vi.fn();
    const reset = vi.fn();
    render(<Feed reset={reset} tokens={[{ label: "#肝细胞癌", filter: true, onRemove: () => {}, action: { label: "关注", onClick: follow } }]} />);
    await userEvent.click(screen.getByRole("button", { name: "关注：#肝细胞癌" }));
    expect(follow).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "筛选，已选 1 项" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清除" })).toBeNull();
    await choose("药物安全");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(reset).toHaveBeenCalled();
  });

  it("returns the focus to 「筛选」 when Escape closes the panel", async () => {
    render(<Feed />);
    const trigger = screen.getByRole("button", { name: "筛选" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "筛选" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "筛选" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("puts the cursor in the search on 「/」, and leaves a 「/」 typed in a field alone", async () => {
    render(<><Feed /><input aria-label="别处" /></>);
    await userEvent.keyboard("/");
    expect(screen.getByRole("searchbox", { name: "搜索" })).toHaveFocus();
    expect(screen.getByRole("searchbox", { name: "搜索" })).toHaveValue("");
    await userEvent.click(screen.getByRole("textbox", { name: "别处" }));
    await userEvent.keyboard("/");
    expect(screen.getByRole("textbox", { name: "别处" })).toHaveValue("/");
  });

  it("keeps another page's row as it was: no folded filter, no filter button, no tokens", () => {
    render(<Toolbar oneRow views={views} filters={[{ kind: "chips", label: "时间范围", options: WINDOWS, value: "now", onChange: () => {} }]} />);
    expect(screen.getByRole("group", { name: "时间范围" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^筛选/ })).toBeNull();
  });

  describe("on a phone", () => {
    it("is the scrolling views with 「筛选」 and the search as icons, and no second line while nothing narrows the list", () => {
      narrow();
      const { container } = render(<Feed />);
      expect(screen.getByRole("tablist")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "筛选" })).not.toHaveTextContent("筛选");
      expect(screen.getByRole("button", { name: "搜索" })).toBeInTheDocument();
      expect(screen.queryByRole("searchbox")).toBeNull();
      expect(container.querySelector("[data-toolbar-row]")).toBeNull();
    });

    it("opens the search over the row with the cursor in it, and 「取消」 gives the views back with the words said as a token", async () => {
      narrow();
      render(<Feed />);
      await userEvent.click(screen.getByRole("button", { name: "搜索" }));
      const box = screen.getByRole("searchbox", { name: "搜索" });
      expect(box).toHaveFocus();
      await userEvent.type(box, "司美格鲁肽");
      await userEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(screen.queryByRole("searchbox")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "移除筛选：搜索：司美格鲁肽" }));
      expect(screen.queryByRole("button", { name: /移除筛选/ })).toBeNull();
    });

    it("opens the search on 「/」 too", async () => {
      narrow();
      render(<Feed />);
      await userEvent.keyboard("/");
      expect(screen.getByRole("searchbox", { name: "搜索" })).toHaveFocus();
    });

    it("retains pinned controls and list actions outside the filter sheet (DS22.4)", async () => {
      narrow();
      const { container } = render(<Feed extra={[{ kind: "chips", label: "简报周期", pinned: true, options: WINDOWS, value: "now", onChange: () => {} }]} />);
      const line = container.querySelector("[data-toolbar-row]") as HTMLElement;
      expect(line).toContainElement(screen.getByRole("group", { name: "简报周期" }));
      await userEvent.click(screen.getByRole("button", { name: "筛选" }));
      const sheet = screen.getByRole("dialog", { name: "筛选" });
      expect(within(sheet).queryByRole("button", { name: "新建" })).toBeNull();
      expect(container.querySelector("[data-toolbar]")?.textContent).toContain("新建");
      await userEvent.click(within(sheet).getByRole("button", { name: "临床证据" }));
      await userEvent.click(within(sheet).getByRole("button", { name: "查看结果" }));
      expect(line).toContainElement(screen.getByRole("button", { name: "移除筛选：临床证据" }));
      expect(screen.getByRole("button", { name: "筛选，已选 1 项" }).querySelector("[data-filter-mark]")).not.toBeNull();
    });

    it("counts a page's token that is not a filter on 「筛选」, and offers no 「重置」 that would leave it standing", async () => {
      narrow();
      const { container } = render(<Feed tokens={[{ label: "只看：肿瘤", onRemove: () => {} }]} />);
      expect(container.querySelector("[data-toolbar-row]")).toContainElement(screen.getByRole("button", { name: "移除筛选：只看：肿瘤" }));
      await userEvent.click(screen.getByRole("button", { name: "筛选，已选 1 项" }));
      expect(within(screen.getByRole("dialog", { name: "筛选" })).getByRole("button", { name: "重置" })).toBeDisabled();
    });

    it("begins the sheet with the page's own section, which can close it", async () => {
      narrow();
      render(<Feed sheetLead={(close) => <nav aria-label="我的关注"><button type="button" onClick={close}>与我相关</button></nav>} />);
      await userEvent.click(screen.getByRole("button", { name: "筛选" }));
      const sheet = screen.getByRole("dialog", { name: "筛选" });
      const lead = within(sheet).getByRole("navigation", { name: "我的关注" });
      expect(lead.compareDocumentPosition(within(sheet).getByRole("group", { name: "栏目" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await userEvent.click(within(lead).getByRole("button", { name: "与我相关" }));
      expect(screen.queryByRole("dialog", { name: "筛选" })).toBeNull();
    });
  });
});

describe("a search box's suggestions", () => {
  function Suggesting({ onPick = vi.fn(), onSubmit = vi.fn() }: { onPick?: (value: string) => void; onSubmit?: () => void }) {
    const [value, setValue] = useState("");
    return <Toolbar search={{ label: "搜索", value, onChange: setValue, onSubmit, suggestions: {
      label: "标签建议", onPick, items: value ? [{ value: "hcc", label: "#肝细胞癌" }, { value: "liver", label: "#肝病" }] : [],
    } }} />;
  }

  it("lists them under the box while it holds words, and takes one with a press", async () => {
    const pick = vi.fn();
    render(<Suggesting onPick={pick} />);
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.type(screen.getByRole("combobox", { name: "搜索" }), "肝");
    const list = screen.getByRole("listbox", { name: "标签建议" });
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["#肝细胞癌", "#肝病"]);
    await userEvent.click(within(list).getByRole("option", { name: "#肝病" }));
    expect(pick).toHaveBeenCalledWith("liver");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("moves through them with the arrow keys, takes the marked one on Enter, and searches the words on Enter with none marked", async () => {
    const pick = vi.fn();
    const submit = vi.fn();
    render(<Suggesting onPick={pick} onSubmit={submit} />);
    const box = screen.getByRole("combobox", { name: "搜索" });
    await userEvent.type(box, "肝{Enter}");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(pick).not.toHaveBeenCalled();
    await userEvent.type(box, "细");
    await userEvent.keyboard("{ArrowDown}");
    expect(box).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0].id);
    await userEvent.keyboard("{Enter}");
    expect(pick).toHaveBeenCalledWith("hcc");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("closes the list on the first Escape and keeps the words", async () => {
    render(<Suggesting />);
    const box = screen.getByRole("combobox", { name: "搜索" });
    await userEvent.type(box, "肝");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box).toHaveValue("肝");
  });
});


it("keeps declared navigation outside filter count and reset (AT53/54)", () => {
  const navigate = vi.fn(), reset = vi.fn();
  render(<Toolbar navigation={[{ kind: "select", label: "查看", options: [{ value: "graph", label: "图谱" }], value: "graph", onChange: navigate }]} onClear={reset} />);
  expect(screen.getByRole("button", { name: "查看：图谱" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "清除筛选" })).toBeNull();
  expect(screen.queryByRole("button", { name: /移除筛选/ })).toBeNull();
});

it('rechecks normal row folding and clipped summaries on window resize without ResizeObserver and cleans listeners', () => {
  vi.stubGlobal('ResizeObserver', undefined);
  let width = 1100, clipped = false;
  const summary = '完整结果摘要';
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.textContent === summary ? 40 : width; });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.textContent === summary ? clipped ? 400 : 20 : 0; });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function(this: HTMLElement) { return this.classList.contains('flex-wrap') && this.querySelector('[aria-label="时间范围"]') && width < 1000 ? 64 : 28; });
  const remove = vi.spyOn(window, 'removeEventListener');
  const { unmount } = render(<Toolbar inBand filters={[{ kind: 'chips', label: '时间范围', options: WINDOWS, value: 'now', onChange() {} }]} summary={summary} />);
  expect(screen.getByRole('button', { name: '本周' })).toBeVisible();
  width = 900; clipped = true;
  act(() => window.dispatchEvent(new Event('resize')));
  expect(screen.queryByRole('button', { name: '本周' })).toBeNull();
  expect(screen.getByRole('button', { name: summary })).toBeVisible();
  width = 1100; clipped = false;
  act(() => window.dispatchEvent(new Event('resize')));
  expect(screen.getByRole('button', { name: '本周' })).toBeVisible();
  expect(screen.queryByRole('button', { name: summary })).toBeNull();
  unmount();
  expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
});

it('rechecks oneRow view crowding on window resize without ResizeObserver', () => {
  vi.stubGlobal('ResizeObserver', undefined);
  let width = 1100, clipped = false;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.getAttribute('role') === 'tablist' ? 100 : width; });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.getAttribute('role') === 'tablist' ? clipped ? 200 : 100 : 0; });
  const remove = vi.spyOn(window, 'removeEventListener');
  const { unmount } = render(<Toolbar oneRow inBand views={{ label: '视图', items: [{ value: 'all', label: '全部' }], value: 'all', onChange() {} }} tokens={[{ label: '已选条件', onRemove() {} }]} />);
  expect(screen.getByRole('button', { name: '移除筛选：已选条件' })).toBeVisible();
  clipped = true;
  act(() => window.dispatchEvent(new Event('resize')));
  expect(screen.queryByRole('button', { name: '移除筛选：已选条件' })).toBeNull();
  width = 1200; clipped = false;
  act(() => window.dispatchEvent(new Event('resize')));
  expect(screen.getByRole('button', { name: '移除筛选：已选条件' })).toBeVisible();
  unmount();
  expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
});
