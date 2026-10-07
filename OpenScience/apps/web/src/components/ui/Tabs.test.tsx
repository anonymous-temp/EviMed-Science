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

  it("says a tab's state three ways: a dot whose shape and colour differ, a tooltip, and words after the name", () => {
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
    expect(document.querySelector("[data-tab-dot=active]")).toHaveAttribute("title", "进行中");
  });
});
