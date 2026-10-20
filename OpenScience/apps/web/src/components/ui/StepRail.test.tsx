import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepRail, type StepRailStep } from "./StepRail";

function narrow() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 639px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
}

afterEach(() => vi.restoreAllMocks());

const STEPS: StepRailStep[] = [
  { id: "evidence", label: "证据", state: "done", summary: "86 条结论", href: "/app/geo/g1/evidence" },
  { id: "journey", label: "旅程", state: "done", href: "/app/geo/g1/questions" },
  { id: "questions", label: "问题", state: "active", href: "/app/geo/g1/questions" },
  { id: "sources", label: "信源", state: "attention", href: "/app/geo/g1/sources" },
  { id: "delivery", label: "投放", state: "waiting", href: "/app/geo/g1/actions" },
  { id: "monitor", label: "监测", state: "todo" },
];

const rail = (extra: Partial<React.ComponentProps<typeof StepRail>> = {}) => (
  <MemoryRouter><StepRail label="进度" steps={STEPS} {...extra} /></MemoryRouter>
);

describe("StepRail", () => {
  it("keeps every workflow step and its state visible on mobile when requested", () => {
    narrow();
    render(rail({ visible: true, showState: true, activeSteps: ["questions"] }));
    const nav = screen.getByRole("navigation", { name: "进度" });
    expect(within(nav).getAllByRole("listitem")).toHaveLength(6);
    expect(within(nav).getByText("进行中")).not.toHaveClass("sr-only");
    expect(within(nav).getByRole("link", { name: /问题/ })).toHaveAttribute("aria-current", "step");
    expect(within(nav).queryByRole("button")).toBeNull();
  });
  it("is one row of steps, each saying its state in words for a reader who cannot see the mark", () => {
    const { container } = render(rail());
    const nav = container.querySelector("[data-step-rail]") as HTMLElement;
    expect(nav).toHaveAttribute("aria-label", "进度");
    expect(nav).toHaveClass("h-10");
    const items = within(nav).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-rail-state"))).toEqual(["done", "done", "active", "attention", "waiting", "todo"]);
    expect(screen.getByRole("link", { name: /^信源\s*，需要留意$/ })).toHaveAttribute("href", "/app/geo/g1/sources");
    expect(screen.getByRole("link", { name: /^投放\s*，等你$/ })).toBeInTheDocument();
    // A step with nowhere to go is text, not a dead link.
    expect(within(items[5]).queryByRole("link")).toBeNull();
    expect(items[5]).toHaveTextContent("监测，未开始");
  });

  it("is the same height whatever the states are", () => {
    const all = (state: StepRailStep["state"]) => STEPS.map((step) => ({ ...step, state }));
    const heights = (["done", "active", "waiting", "partial", "attention", "todo"] as const).map((state) => {
      const { container, unmount } = render(<MemoryRouter><StepRail label="进度" steps={all(state)} /></MemoryRouter>);
      const className = (container.querySelector("[data-step-rail]") as HTMLElement).className;
      unmount();
      return className.split(" ").find((name) => /^h-/.test(name));
    });
    expect(new Set(heights)).toEqual(new Set(["h-10"]));
  });

  it("underlines the steps the open tab is built from, and says so to assistive technology", () => {
    render(rail({ activeSteps: ["questions", "sources"] }));
    expect(screen.getByRole("link", { name: /^问题\s*，进行中$/ })).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("link", { name: /^信源\s*，需要留意$/ })).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("link", { name: /^证据\s*，已完成$/ })).not.toHaveAttribute("aria-current");
  });

  it("takes a handler for a step whose home is a tab of the same page, and a sentence of 「现在」 at the end", async () => {
    const select = vi.fn();
    render(rail({
      steps: [{ id: "a", label: "定义", state: "done", onSelect: select }, { id: "b", label: "人群", state: "active" }],
      trailing: "第 3 轮复测中",
    }));
    await userEvent.click(screen.getByRole("button", { name: /^定义\s*，已完成$/ }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(screen.getByText("第 3 轮复测中")).toBeInTheDocument();
  });

  it("folds to one chip on a phone, with the steps in its menu, and keeps its height", async () => {
    narrow();
    const { container } = render(rail({ activeSteps: ["questions"] }));
    const nav = container.querySelector("[data-step-rail]") as HTMLElement;
    expect(nav).toHaveClass("h-10");
    expect(screen.queryByRole("list")).toBeNull();
    const chip = screen.getByRole("button", { name: "进度：已完成 2/6 步" });
    expect(chip).toHaveTextContent("已完成 2/6 步");
    await userEvent.click(chip);
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["证据 · 已完成", "旅程 · 已完成", "问题 · 进行中", "信源 · 需要留意", "投放 · 等你", "监测 · 未开始"]);
    expect(items[2]).toHaveAttribute("aria-checked", "true");
  });

  it("keeps the 「现在」 sentence on a phone, after the chip, on the one line", () => {
    narrow();
    const { container } = render(rail({ trailing: "正在写稿、投放 · 下次复测 周二 10月20日" }));
    const nav = container.querySelector("[data-step-rail]") as HTMLElement;
    const sentence = screen.getByText("正在写稿、投放 · 下次复测 周二 10月20日");
    expect(nav).toContainElement(sentence);
    expect(sentence).toHaveClass("truncate");
    expect(nav).toHaveClass("h-10");
  });
});
