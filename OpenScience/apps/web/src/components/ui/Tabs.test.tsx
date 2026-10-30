import { RailMark } from "./ProgressRail";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tabs } from "./Tabs";

function Example() {
  const [value, setValue] = useState("daily");
  return <Tabs label="简报周期" items={[{ value: "daily", label: "日报" }, { value: "weekly", label: "周报" }]} value={value} onChange={setValue} panelId="brief" />;
}
describe("Tabs", () => {
  it("keeps mobile tabs on a scrolling row and preserves keyboard selection", async () => {
    const user = userEvent.setup();
    render(<Example />);
    expect(screen.getByRole("tablist")).toHaveClass("overflow-x-auto");
    const daily = screen.getByRole("tab", { name: "日报" });
    const weekly = screen.getByRole("tab", { name: "周报" });
    expect(daily).toHaveClass("shrink-0", "whitespace-nowrap");
    daily.focus();
    await user.keyboard("{ArrowRight}");
    expect(weekly).toHaveFocus();
    expect(weekly).toHaveAttribute("aria-selected", "true");
    expect(daily).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{Home}");
    expect(daily).toHaveFocus();
    expect(daily).toHaveAttribute("aria-controls", "brief");
    await user.keyboard("{End}{ArrowRight}");
    expect(daily).toHaveFocus();
  });

  it("says a tab's state three ways: a dot whose shape and colour differ, and words after the name for a reader who cannot see it", () => {
    render(
      <Tabs
        label="研究视图"
        items={[
          { value: "a", label: "定义与证据", dot: "done" },
          { value: "b", label: "试验", dot: "active" },
          { value: "c", label: "对照", dot: "attention" },
          { value: "d", label: "匹配与招募", dot: "todo" },
          { value: "e", label: "总览" },
        ]}
        value="b"
        onChange={() => {}}
      />,
    );
    const states = [...document.querySelectorAll("[data-tab-dot]")].map((dot) => dot.getAttribute("data-tab-dot"));
    expect(states).toEqual(["done", "active", "attention", "todo"]);
    // The dot is decoration; the words carry the state to a screen reader, after the tab's own name.
    expect(screen.getByRole("tab", { name: "试验 进行中" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "定义与证据 已完成" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "对照 需要留意" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "总览" }), "a tab with no dot is named by its label alone").toBeInTheDocument();
  });

  // 2026-10-07: 「定义与证据」 read 进行中 on a study where nothing was running — the ring said work under way for "some steps done".
  it("has a fifth dot for a stage that is partly done and not running, spoken 「部分完成」, a different mark from the running ring", () => {
    render(
      <Tabs
        label="研究视图"
        items={[
          { value: "a", label: "定义与证据", dot: "partial" },
          { value: "b", label: "试验", dot: "active" },
        ]}
        value="a"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("tab", { name: "定义与证据 部分完成" })).toBeInTheDocument();
    const [partial, active] = [...document.querySelectorAll("[data-tab-dot]")];
    expect(partial).toHaveAttribute("data-tab-dot", "partial");
    expect(partial).toHaveClass("ring-2", "ring-info", "bg-info-soft");
    expect(active).toHaveClass("ring-2", "ring-info", "bg-surface");
    expect(partial.className).not.toBe(active.className);
  });

  // The phone shows four of seven tabs; the fourth was cut mid-word and read as clipped, not as a row that scrolls.
  describe("a row wider than its box", () => {
    function withLayout(scrollWidth: number, clientWidth: number, scrollLeft: number, run: () => void) {
      const saved = ["scrollWidth", "clientWidth", "scrollLeft"].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => scrollWidth });
      Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => clientWidth });
      Object.defineProperty(HTMLElement.prototype, "scrollLeft", { configurable: true, get: () => scrollLeft });
      try {
        run();
      } finally {
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
          else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
        }
      }
    }
    const items = [{ value: "a", label: "总览" }, { value: "b", label: "试验" }];

    it("fades at the end that still has tabs, with a mask that needs no ground colour", () => {
      withLayout(900, 360, 0, () => {
        render(<Tabs label="视图" items={items} value="a" onChange={() => {}} />);
        const list = screen.getByRole("tablist", { name: "视图" });
        expect(list.getAttribute("style")).toMatch(/mask-image: linear-gradient\(to right, black calc\(100% - 2rem\), transparent\)/);
        expect(list).toHaveClass("overflow-x-auto", "scroll-px-6");
      });
    });

    it("does not fade at the end of the row, nor when everything fits", () => {
      withLayout(900, 360, 540, () => {
        render(<Tabs label="视图" items={items} value="a" onChange={() => {}} />);
        expect(screen.getByRole("tablist", { name: "视图" })).not.toHaveAttribute("style");
      });
      withLayout(300, 360, 0, () => {
        render(<Tabs label="适合" items={items} value="a" onChange={() => {}} />);
        expect(screen.getByRole("tablist", { name: "适合" })).not.toHaveAttribute("style");
      });
    });
  });
});

// R19 (audit D C1d): `vcr-overview@phone` opened with 「对照」 selected and cut in half. The open tab is whole on arrival, when the view
// changes and by keyboard — in the row, never by moving the page — and a tab that already shows is left alone.
describe("the open tab of a row wider than its box is whole", () => {
  const scrollBy = vi.fn();
  const items = [{ value: "a", label: "总览" }, { value: "b", label: "对照" }, { value: "c", label: "试验" }];
  /** The row is 0..360 and the tab named is where `places` says; every other tab is whole at 0..80. */
  function layout(places: Record<string, [number, number]>) {
    Object.defineProperty(HTMLElement.prototype, "scrollBy", { configurable: true, value: scrollBy });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const [left, right] = this.getAttribute("role") === "tablist" ? [0, 360] : places[this.textContent ?? ""] ?? [0, 80];
      return { left, right, top: 0, bottom: 40, width: right - left, height: 40, x: left, y: 0, toJSON: () => ({}) };
    });
  }
  afterEach(() => {
    vi.restoreAllMocks();
    scrollBy.mockReset();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollBy;
  });

  it("is scrolled to on arrival, when a page opens with the cut tab already selected", () => {
    layout({ "对照": [330, 420] });
    render(<Tabs label="视图" items={items} value="b" onChange={() => {}} />);
    expect(scrollBy).toHaveBeenCalledWith({ left: 92 });
  });

  it("is scrolled back to when the open tab is out of the row's start, and left alone when it already shows", () => {
    layout({ "总览": [-40, 40] });
    const { unmount } = render(<Tabs label="视图" items={items} value="a" onChange={() => {}} />);
    expect(scrollBy).toHaveBeenCalledWith({ left: -40 });
    unmount();
    scrollBy.mockReset();
    layout({});
    render(<Tabs label="视图" items={items} value="b" onChange={() => {}} />);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("keeps the last tab to the row's end, with no fade reserved after it", () => {
    layout({ "试验": [300, 380] });
    render(<Tabs label="视图" items={items} value="c" onChange={() => {}} />);
    expect(scrollBy).toHaveBeenCalledWith({ left: 20 });
  });

  it("follows the keyboard: an arrow selects the next tab, focuses it, and brings it whole — without scrolling the page", async () => {
    layout({ "对照": [330, 420] });
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    function Controlled() {
      const [value, setValue] = useState("a");
      return <Tabs label="视图" items={items} value={value} onChange={setValue} />;
    }
    render(<Controlled />);
    expect(scrollBy).not.toHaveBeenCalled();
    screen.getByRole("tab", { name: "总览" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "对照" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "对照" })).toHaveFocus();
    expect(scrollBy).toHaveBeenCalledWith({ left: 92 });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("the optional moving underline", () => {
  const items = [{ value: "sms", label: "短信登录" }, { value: "password", label: "密码登录" }];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function layout() {
    const boxes: Record<string, [number, number]> = { "短信登录": [24, 80], "密码登录": [104, 168] };
    let scrollLeft = 0;
    const resize: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize.push(callback); }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const [start, end] = this.getAttribute("role") === "tablist" ? [24, 344] : boxes[this.textContent ?? ""] ?? [0, 0];
      const left = start - (this.getAttribute("role") === "tab" ? scrollLeft : 0);
      return { left, right: left + end - start, top: 0, bottom: 40, width: end - start, height: 40, x: left, y: 0, toJSON: () => ({}) };
    });
    return { boxes, resize, scrollTo: (left: number) => { scrollLeft = left; } };
  }

  it("keeps the existing static rule for consumers that do not opt in", () => {
    render(<Tabs label="登录方式" items={items} value="sms" onChange={() => {}} />);
    expect(document.querySelector("[data-tab-indicator]")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "短信登录" })).toHaveClass("border-text", "text-text");
  });

  it("mounts at the selected tab and moves one underline with keyboard selection", async () => {
    layout();
    function LoginTabs() {
      const [value, setValue] = useState("password");
      return <Tabs animatedIndicator label="登录方式" items={items} value={value} onChange={setValue} />;
    }
    render(<LoginTabs />);
    const indicator = document.querySelector("[data-tab-indicator]");
    expect(indicator).toHaveStyle({ width: "64px", transform: "translateX(80px)" });
    expect(indicator).toHaveClass("duration-base", "ease-standard", "motion-reduce:transition-none");
    expect(indicator).toHaveAttribute("aria-hidden", "true");
    screen.getByRole("tab", { name: "密码登录" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.querySelectorAll("[data-tab-indicator]")).toHaveLength(1);
    expect(document.querySelector("[data-tab-indicator]")).toBe(indicator);
    expect(indicator).toHaveStyle({ width: "56px", transform: "translateX(0px)" });
    expect(screen.getByRole("tab", { name: "短信登录" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "短信登录" })).toHaveClass("border-transparent", "text-accent");
  });

  it("stays aligned while the row scrolls and remeasures when tab widths change", () => {
    const geometry = layout();
    render(<Tabs animatedIndicator label="登录方式" items={items} value="password" onChange={() => {}} />);
    const list = screen.getByRole("tablist");
    Object.defineProperty(list, "scrollLeft", { configurable: true, value: 36 });
    geometry.scrollTo(36);
    fireEvent.scroll(list);
    expect(document.querySelector("[data-tab-indicator]")).toHaveStyle({ width: "64px", transform: "translateX(80px)" });
    geometry.boxes["密码登录"] = [112, 188];
    act(() => geometry.resize.forEach((resize) => resize()));
    expect(document.querySelector("[data-tab-indicator]")).toHaveStyle({ width: "76px", transform: "translateX(88px)" });
  });

  it("hides the rule when the selected view is not a tab, without losing keyboard access", () => {
    layout();
    const { rerender } = render(<Tabs animatedIndicator label="登录方式" items={items} value="sms" onChange={() => {}} />);
    expect(document.querySelector("[data-tab-indicator]")).toBeInTheDocument();
    rerender(<Tabs animatedIndicator label="登录方式" items={items} value="register" onChange={() => {}} />);
    expect(document.querySelector("[data-tab-indicator]")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "短信登录" })).toHaveAttribute("tabindex", "0");
    expect(screen.getAllByRole("tab").every((tab) => tab.getAttribute("aria-selected") === "false")).toBe(true);
  });
});

it("uses success for completion and information for active and partial rail marks", () => {
  const { container } = render(<><RailMark state="done" /><RailMark state="active" /><RailMark state="partial" /></>);
  const marks = container.querySelectorAll("[data-status-mark]");
  expect(marks[0]).toHaveClass("bg-ok");
  expect(marks[1]).toHaveClass("border-info", "bg-surface");
  expect(marks[2]).toHaveClass("border-info", "bg-info-soft");
});

it("manual activation moves focus without selecting until Enter",async()=>{
 const change=vi.fn();render(<Tabs activation="manual" label="views" items={[{value:"a",label:"A"},{value:"b",label:"B"}]} value="a" onChange={change}/>);
 screen.getByRole("tab",{name:"A"}).focus();await userEvent.keyboard("{ArrowRight}");
 expect(screen.getByRole("tab",{name:"B"})).toHaveFocus();expect(change).not.toHaveBeenCalled();
 await userEvent.keyboard("{Enter}");expect(change).toHaveBeenCalledWith("b");
});
