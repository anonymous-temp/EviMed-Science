import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast, useToastStore } from "@/lib/toast";
import { Toaster } from "./Toaster";

describe("Toaster", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sits at least 1.5 rem above the window's bottom, and above the device's safe area where it reports one", () => {
    toast.success("saved");
    const { container } = render(<Toaster />);
    expect(container.firstElementChild).toHaveClass("bottom-[max(1.5rem,env(safe-area-inset-bottom))]");
  });

  it("announces success politely and errors assertively", () => {
    toast.success("saved");
    toast.error("broken");
    render(<Toaster />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  });

  it("pauses auto-dismiss while hovered and resumes on leave", () => {
    vi.useFakeTimers();
    toast.success("hover me");
    render(<Toaster />);
    const card = screen.getByRole("status");

    // Timer-driven store updates need act() to flush React's re-render.
    act(() => vi.advanceTimersByTime(1000));
    // React synthesizes onMouseEnter/Leave from mouseover/mouseout.
    fireEvent.mouseOver(card);
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText("hover me")).toBeInTheDocument();

    fireEvent.mouseOut(card);
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByText("hover me")).not.toBeInTheDocument();
  });

  // Appendix E #7: the status is the icon's to say; the card is one card with
  // a hairline edge whatever it reports, and an error reads in the body colour.
  it("says the status with its icon, not a coloured border or coloured text", () => {
    toast.success("已保存");
    toast.error("无法下载报告");
    render(<Toaster />);
    for (const card of [screen.getByRole("status"), screen.getByRole("alert")]) {
      expect(card).toHaveClass("border-border");
      expect(card.className).not.toMatch(/border-(ok|danger|error)\b/);
      expect(card.className).not.toMatch(/(^|\s)text-error(\s|$)/);
      expect(card.querySelector("svg")).not.toBeNull();
    }
  });

  it("expands a truncated message on click and collapses it again", async () => {
    toast.error("a very long failure detail");
    render(<Toaster />);
    const message = screen.getByRole("button", { name: "a very long failure detail" });
    expect(message).toHaveClass("truncate");

    await userEvent.click(message);
    expect(message).toHaveClass("whitespace-pre-wrap");
    expect(message).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(message);
    expect(message).toHaveClass("truncate");
  });

  it("runs the action and dismisses the toast", async () => {
    const onClick = vi.fn();
    toast.success("已归档", { action: { label: "撤销", onClick } });
    render(<Toaster />);
    await userEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByText("已归档")).not.toBeInTheDocument();
  });

  it("dismisses via the close button", async () => {
    toast.success("bye");
    render(<Toaster />);
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByText("bye")).not.toBeInTheDocument();
  });
});
