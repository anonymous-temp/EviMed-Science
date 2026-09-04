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
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByText("hover me")).not.toBeInTheDocument();
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
