import { useState } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Star } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toolbar, type ToolbarFilter } from "./Toolbar";

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

  it("folds the filters into one 「筛选」 chip on a phone, with the number that are on, and the same choices in a menu", async () => {
    narrow();
    const selected = vi.fn();
    render(<Page onSelect={selected} />);
    // No row of chips: the one chip stands for the three filters; the views and the search stay.
    expect(screen.queryByRole("button", { name: "本周" })).toBeNull();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "筛选" });
    await userEvent.click(chip);
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "临床证据" }));
    expect(selected).toHaveBeenCalledWith("evidence");
    expect(screen.getByRole("button", { name: "筛选，已选 1 项" })).toHaveTextContent("筛选 · 1");
    await userEvent.click(screen.getByRole("button", { name: "筛选，已选 1 项" }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "收藏" }));
    expect(screen.getByRole("button", { name: "筛选，已选 2 项" })).toBeInTheDocument();
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
