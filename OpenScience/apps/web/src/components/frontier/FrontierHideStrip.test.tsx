import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frontierItem } from "./__fixtures__/frontierItems";
import { FrontierHideReasonMenu, FrontierHideStrip } from "./FrontierHideStrip";
import { FRONTIER_HIDE_REASONS } from "@evimed/domain";

const item = frontierItem({ id: "item-1", source: { id: "nejm", name: "新英格兰医学杂志" } });

function strip(props: Partial<Parameters<typeof FrontierHideStrip>[0]> = {}) {
  const handlers = { onReason: vi.fn(), onUndo: vi.fn(), onClose: vi.fn() };
  render(<ul><FrontierHideStrip item={item} noted={false} {...handlers} {...props} /></ul>);
  return handlers;
}

/** An IntersectionObserver the test drives: what the line reports of being in sight. */
let observers: Array<{ callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }> = [];
beforeEach(() => {
  observers = [];
  vi.stubGlobal("IntersectionObserver", class {
    disconnect = vi.fn();
    constructor(callback: IntersectionObserverCallback) { observers.push({ callback, disconnect: this.disconnect }); }
    observe() {}
    unobserve() {}
    takeRecords() { return []; }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });
const inSight = (isIntersecting: boolean) => observers[0].callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);

describe("the line a hidden card leaves", () => {
  it("says what happened and offers the reasons as chips in the domain's order, the source's own named, and 撤销 at the end", () => {
    strip();
    const line = screen.getByRole("group", { name: "不感兴趣" });
    expect(line).toHaveTextContent("已隐藏 · 说说原因（可不选）");
    const buttons = within(line).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "与我无关", "看过了", "内容质量不高", "像广告或软文", "不是我的专科", "不想看“新英格兰医学杂志”", "撤销"]);
    expect(buttons).toHaveLength(FRONTIER_HIDE_REASONS.length + 1);
    // A chip is the filter chip, on the line's own ground; nothing about the line is a tag or a toast.
    expect(buttons[0]).toHaveClass("rounded-full", "h-sm");
    expect(line.closest("li")).toHaveAttribute("data-frontier-hidden", "item-1");
    expect(line.closest("li")).not.toHaveAttribute("data-frontier-item"); // not a card: no impression of its own
  });

  it("wraps on a phone and keeps a long source name to one row", () => {
    strip({ item: frontierItem({ source: { id: "x", name: "A very long source name that would not fit a phone's row of chips at all" } }) });
    expect(screen.getByRole("group", { name: "不感兴趣" })).toHaveClass("flex-wrap");
    const long = screen.getByRole("button", { name: /^不想看“A very long/ });
    expect(long).toHaveClass("max-w-full", "min-w-0");
    expect(within(long).getByText(/A very long/)).toHaveClass("truncate");
  });

  it("sends the chip pressed, and takes the hide back on 撤销", async () => {
    const { onReason, onUndo, onClose } = strip();
    await userEvent.click(screen.getByRole("button", { name: "看过了" }));
    expect(onReason).toHaveBeenCalledWith("already-seen");
    await userEvent.click(screen.getByRole("button", { name: "不想看“新英格兰医学杂志”" }));
    expect(onReason).toHaveBeenLastCalledWith("source");
    await userEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("is reachable by keyboard: the first chip has focus, Tab walks the chips to 撤销, Enter chooses and Escape closes", async () => {
    const { onReason, onClose } = strip();
    expect(screen.getByRole("button", { name: "与我无关" })).toHaveFocus();
    for (const name of ["看过了", "内容质量不高", "像广告或软文", "不是我的专科", "不想看“新英格兰医学杂志”", "撤销"]) {
      await userEvent.tab();
      expect(screen.getByRole("button", { name })).toHaveFocus();
    }
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await userEvent.keyboard("{Enter}");
    expect(onReason).toHaveBeenCalledWith("not-my-specialty");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says 「已记下」 once a reason is taken, with 撤销 still there and no chips", () => {
    strip({ noted: true });
    const line = screen.getByRole("group", { name: "不感兴趣" });
    expect(within(line).getByRole("status")).toHaveTextContent("已记下");
    expect(within(line).getAllByRole("button").map((button) => button.textContent)).toEqual(["撤销"]);
    expect(line).not.toHaveTextContent("说说原因");
  });

  it("closes when it is scrolled out of sight after it was in sight, and not before", () => {
    const { onClose } = strip();
    expect(observers).toHaveLength(1);
    inSight(false);
    expect(onClose).not.toHaveBeenCalled(); // never seen yet: no scroll has taken it away
    inSight(true);
    expect(onClose).not.toHaveBeenCalled();
    inSight(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stops watching when it goes, and keeps the clock column of a day group", () => {
    const { unmount } = render(<ul><FrontierHideStrip item={item} grouped noted={false} onReason={vi.fn()} onUndo={vi.fn()} onClose={vi.fn()} /></ul>);
    expect(document.querySelector("li > div[aria-hidden=true]")).toHaveClass("w-14");
    unmount();
    expect(observers.at(-1)?.disconnect).toHaveBeenCalled();
  });
});

describe("the reader's reasons", () => {
  function reasons() {
    const onChoose = vi.fn();
    render(<FrontierHideReasonMenu item={item} onChoose={onChoose} anchorClassName="fixed bottom-16 right-3" />);
    return onChoose;
  }

  it("opens as a menu of the same reasons with 「不说原因，直接隐藏」 at its end", async () => {
    reasons();
    const menu = await screen.findByRole("menu", { name: "不感兴趣的原因" });
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual([
      "与我无关", "看过了", "内容质量不高", "像广告或软文", "不是我的专科", "不想看“新英格兰医学杂志”", "不说原因，直接隐藏"]);
    expect(menu).toHaveTextContent("说说原因（可不选）");
  });

  it("chooses a reason, or none", async () => {
    const onChoose = reasons();
    await userEvent.click(await screen.findByRole("menuitem", { name: "像广告或软文" }));
    expect(onChoose).toHaveBeenCalledWith("promotional");
  });

  it("chooses none by name, and Escape chooses nothing", async () => {
    const onChoose = reasons();
    await userEvent.click(await screen.findByRole("menuitem", { name: "不说原因，直接隐藏" }));
    expect(onChoose).toHaveBeenCalledWith(null);
    onChoose.mockClear();
    const again = reasons();
    await screen.findAllByRole("menu");
    await userEvent.keyboard("{Escape}");
    expect(again).not.toHaveBeenCalled();
    expect(onChoose).not.toHaveBeenCalled();
  });
});

describe("the line a hidden card of a stream source leaves", () => {
  it("does not offer to stop the source by the journal's name, which would mute the whole stream", () => {
    strip({ item: { ...item, source: { ...item.source, id: "pubmed-cardiology", name: "The Lancet Oncology", followable: false } } });
    const buttons = within(screen.getByRole("group", { name: "不感兴趣" })).getAllByRole("button").map((button) => button.textContent);
    expect(buttons).not.toContain("不想看“The Lancet Oncology”");
    expect(buttons).toHaveLength(FRONTIER_HIDE_REASONS.length);
  });
});
