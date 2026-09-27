import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Copy, PanelLeft } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLTIP_DELAYS } from "@evimed/design-tokens";
import { IconButton } from "./IconButton";
import { Tooltip } from "./Tooltip";

/**
 * The tooltip's contract (spec §22.8, WCAG 1.4.13): the token's delays, open
 * on keyboard focus, hoverable, dismissible with Escape, on its own layer, and
 * wired to the trigger for assistive technology.
 */

const tooltip = () => document.querySelector<HTMLElement>("[role='tooltip']");
const shown = () => {
  const node = tooltip();
  return node !== null && !node.hidden;
};
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("Tooltip", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("shows after the token's delay on hover and hides the token's delay after the pointer leaves", () => {
    render(<Tooltip content="Aspirin in the Primary Prevention of Cardiovascular Disease"><button type="button">Aspirin in…</button></Tooltip>);
    const trigger = screen.getByRole("button");
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    wait(TOOLTIP_DELAYS.show - 1);
    expect(shown()).toBe(false);
    wait(1);
    expect(shown()).toBe(true);
    expect(tooltip()).toHaveTextContent("Aspirin in the Primary Prevention of Cardiovascular Disease");
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    wait(TOOLTIP_DELAYS.hide - 1);
    expect(shown()).toBe(true);
    wait(1);
    expect(shown()).toBe(false);
  });

  it("stays while the pointer moves onto it (WCAG 1.4.13, hoverable)", () => {
    render(<Tooltip content="全文"><button type="button">截断</button></Tooltip>);
    const trigger = screen.getByRole("button");
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    wait(TOOLTIP_DELAYS.show);
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    fireEvent.pointerEnter(tooltip() as HTMLElement, { pointerType: "mouse" });
    wait(TOOLTIP_DELAYS.hide * 5);
    expect(shown()).toBe(true);
    fireEvent.pointerLeave(tooltip() as HTMLElement, { pointerType: "mouse" });
    wait(TOOLTIP_DELAYS.hide);
    expect(shown()).toBe(false);
  });

  it("shows at once on keyboard focus and hides on blur", () => {
    render(<Tooltip content="全文"><button type="button">截断</button></Tooltip>);
    const trigger = screen.getByRole("button");
    act(() => { trigger.focus(); });
    expect(shown()).toBe(true);
    act(() => { trigger.blur(); });
    expect(shown()).toBe(false);
  });

  it("is not opened by a click, and a click closes one that is open", () => {
    render(<Tooltip content="全文"><button type="button">截断</button></Tooltip>);
    const trigger = screen.getByRole("button");
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerDown(trigger, { pointerType: "mouse" });
    act(() => { trigger.focus(); });
    wait(TOOLTIP_DELAYS.show * 2);
    expect(shown()).toBe(false);
  });

  it("closes on Escape without moving focus, and the key goes no further", () => {
    const underneath = vi.fn();
    document.addEventListener("keydown", underneath);
    try {
      render(<Tooltip content="全文"><button type="button">截断</button></Tooltip>);
      const trigger = screen.getByRole("button");
      act(() => { trigger.focus(); });
      expect(shown()).toBe(true);
      fireEvent.keyDown(trigger, { key: "Escape" });
      expect(shown()).toBe(false);
      expect(document.activeElement).toBe(trigger);
      expect(underneath).not.toHaveBeenCalled();
      // With the tooltip closed, Escape belongs to whatever is under it again.
      fireEvent.keyDown(trigger, { key: "Escape" });
      expect(underneath).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener("keydown", underneath);
    }
  });

  it("describes its trigger, and its text is there for a screen reader before it is shown", () => {
    render(<Tooltip content="发表于 2018 年"><button type="button">NEJM</button></Tooltip>);
    const trigger = screen.getByRole("button", { description: "发表于 2018 年" });
    expect(trigger).toHaveAttribute("aria-describedby", tooltip()?.id);
    expect(shown()).toBe(false);
  });

  it("sits on the tooltip layer, in the inverse colours, drawn into the body", () => {
    render(<Tooltip content="全文" defaultOpen><button type="button">截断</button></Tooltip>);
    expect(shown()).toBe(true);
    expect(tooltip()).toHaveClass("z-tooltip", "bg-text", "text-bg", "rounded-card", "text-caption");
    expect(tooltip()?.parentElement).toBe(document.body);
  });

  it("is never opened by a touch: a touch screen cannot hover", () => {
    render(<Tooltip content="全文"><button type="button">截断</button></Tooltip>);
    // jsdom has no PointerEvent, so the pointer's type is set on the event.
    const trigger = screen.getByRole("button");
    const touch = createEvent.pointerOver(trigger);
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    fireEvent(trigger, touch);
    wait(TOOLTIP_DELAYS.show * 2);
    expect(shown()).toBe(false);
  });
});

describe("IconButton's tooltip", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("is its label, shown and not announced a second time, and the browser's title is gone", () => {
    render(<IconButton icon={Copy} label="复制 DOI" />);
    const button = screen.getByRole("button", { name: "复制 DOI" });
    expect(button).not.toHaveAttribute("title");
    expect(button).not.toHaveAttribute("aria-describedby");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    wait(TOOLTIP_DELAYS.show);
    expect(tooltip()).toHaveTextContent("复制 DOI");
    expect(tooltip()).toHaveAttribute("aria-hidden", "true");
  });

  it("shows a title that says more than the label, and describes the button with it", () => {
    render(<IconButton icon={PanelLeft} label="收起侧边栏" title="收起侧边栏 (Ctrl+B)" />);
    expect(screen.getByRole("button", { name: "收起侧边栏", description: "收起侧边栏 (Ctrl+B)" })).toBeInTheDocument();
  });

  it("keeps the caller's own handlers and ref", async () => {
    vi.useRealTimers();
    const onFocus = vi.fn();
    const onClick = vi.fn();
    const ref = { current: null as HTMLButtonElement | null };
    render(<IconButton ref={ref} icon={Copy} label="复制" onFocus={onFocus} onClick={onClick} />);
    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(onFocus).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledOnce();
    expect(ref.current).toBe(screen.getByRole("button", { name: "复制" }));
    // A click is not a request for the tooltip.
    expect(tooltip()).toBeNull();
  });
});
