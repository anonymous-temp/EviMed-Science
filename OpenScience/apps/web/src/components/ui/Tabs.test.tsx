import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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
    expect(partial).toHaveClass("ring-2", "ring-accent", "bg-accent-soft");
    expect(active).toHaveClass("ring-2", "ring-accent", "bg-surface");
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
