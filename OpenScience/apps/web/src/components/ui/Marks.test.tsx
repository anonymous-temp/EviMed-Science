import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Flame } from "lucide-react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "@/components/cards/EmptyState";
import { StatTile } from "./StatTile";
import { Tabs } from "./Tabs";
import { Tag } from "./Tag";

describe("the markers the walk reads", () => {
  it("marks a tag, and a tag has no handler and no role to give it", () => {
    const { container } = render(<Tag tone="warn">T0 公开资料</Tag>);
    const tag = container.querySelector("[data-tag]") as HTMLElement;
    expect(tag).toHaveTextContent("T0 公开资料");
    expect(tag).not.toHaveAttribute("role");
    expect(tag).not.toHaveAttribute("tabindex");
    // @ts-expect-error a tag is not clickable: a clickable chip is a filter
    const clickable = <Tag onClick={() => {}}>可点</Tag>;
    expect(clickable).toBeTruthy();
  });

  it("marks an empty state, and whether it says why it has no action", () => {
    const { container, rerender } = render(<EmptyState icon={Flame} title="暂无热点" action={<button type="button">刷新</button>} />);
    expect(container.querySelector("[data-empty]")).not.toBeNull();
    expect(container.querySelector("[data-reason]")).toBeNull();
    rerender(<EmptyState icon={Flame} title="暂无热点" reason="每天 07:30 更新。" />);
    expect(container.querySelector("[data-empty][data-reason]")).not.toBeNull();
    expect(screen.getByText("每天 07:30 更新。")).toBeInTheDocument();
  });
});

describe("StatTile opens what it counts", () => {
  it("makes the number a link to the things counted", () => {
    render(<MemoryRouter><StatTile label="严重讲错" value={18} unit="条" to="/app/geo/g1/accuracy?severity=high" /></MemoryRouter>);
    const link = screen.getByRole("link", { name: "严重讲错 18，查看" });
    expect(link).toHaveAttribute("href", "/app/geo/g1/accuracy?severity=high");
    expect(link).toHaveTextContent("18");
  });

  it("makes it a button that narrows the page in place", async () => {
    const open = vi.fn();
    render(<StatTile label="需要看一眼" value={4} onOpen={open} />);
    await userEvent.click(screen.getByRole("button", { name: "需要看一眼 4，查看" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for a word that stands in for a number, and is plain text without a target", () => {
    render(<StatTile label="样本" value="样本不足" placeholder to="/somewhere" />);
    expect(screen.queryByRole("link")).toBeNull();
    render(<StatTile label="已核对" value={39} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Tabs keeps the open tab whole", () => {
  it("scrolls a row wider than its box to the open tab, as the view changes — and never the page", () => {
    // jsdom has no element `scrollBy`: the browser's is what the row scrolls with.
    const scrollBy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollBy", { configurable: true, value: scrollBy });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // The row is 0..360; the tab 「对照」 sits at 330..420, half out of it.
      const role = this.getAttribute("role");
      const [left, right] = role === "tablist" ? [0, 360] : this.textContent === "对照" ? [330, 420] : [0, 80];
      return { left, right, top: 0, bottom: 40, width: right - left, height: 40, x: left, y: 0, toJSON: () => ({}) };
    });
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const items = [{ value: "a", label: "总览" }, { value: "b", label: "对照" }, { value: "c", label: "试验" }];
    const { rerender } = render(<Tabs label="视图" items={items} value="a" onChange={() => {}} />);
    expect(scrollBy).not.toHaveBeenCalled();
    rerender(<Tabs label="视图" items={items} value="b" onChange={() => {}} />);
    // Its end is at 420; the row's visible end is 360 less the 32 px fade that says more tabs follow: scroll 92 right.
    expect(scrollBy).toHaveBeenCalledWith({ left: 92 });
    expect(scrollIntoView).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollBy;
  });
});
