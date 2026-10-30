import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast, useToastStore } from "@/lib/toast";
import { WEB_SESSION_ENDED_EVENT } from "@/lib/sessionLifecycle";
import { Toaster } from "./Toaster";

const polite = () => document.querySelector('[data-announcer="polite"]');
const assertive = () => document.querySelector('[data-announcer="assertive"]');
const card = (message: string) => screen.getByRole("button", { name: message }).closest("[data-toast]") as HTMLElement;

describe("Toaster", () => {
  beforeEach(() => {
    // A session boundary empties the toast store and the announcer's queue, which outlive a test.
    window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT));
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    act(() => { for (const item of useToastStore.getState().toasts) useToastStore.getState().dismiss(item.id); });
  });

  it("shows a truthful visible repetition count for the same event and entity", () => {
    render(<Toaster />);
    act(() => { toast.error("Unable to save", { eventId: "save", entityId: "draft" }); toast.error("Unable to save", { eventId: "save", entityId: "draft" }); });
    expect(screen.getByLabelText("重复 2 次")).toHaveTextContent("×2");
    const repeated = screen.getByLabelText("重复 2 次").closest("[data-toast]");
    expect(repeated).toHaveAttribute("data-toast-tone", "error");
    // The card itself is not a live region: the announcer says it once (below), so a screen reader does not hear it twice.
    expect(repeated).not.toHaveAttribute("role");
    expect(screen.getAllByRole("button", { name: "Unable to save" })).toHaveLength(1);
  });

  it("sits at least 1.5 rem above the window's bottom, and above the device's safe area where it reports one", () => {
    toast.success("saved");
    const { container } = render(<Toaster />);
    expect(container.querySelector("[data-toast]")?.parentElement).toHaveClass("bottom-[max(1.5rem,env(safe-area-inset-bottom))]");
  });

  // Politeness moved from the card's role (status / alert) to the announcer: every toast is polite, and assertive is kept for an
  // urgent safety or session event, which a toast is not.
  it("announces each toast once through the announcer, politely and one at a time, and the cards carry no live role", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => { toast.success("saved"); toast.error("broken", { eventId: "export", entityId: "report" }); });
    act(() => { vi.advanceTimersByTime(60); });
    expect(polite()).toHaveTextContent("saved");
    expect(assertive()).toBeEmptyDOMElement();
    act(() => { vi.advanceTimersByTime(1200); });
    expect(polite()).toHaveTextContent("broken");
    expect(assertive()).toBeEmptyDOMElement();
    expect(card("saved")).not.toHaveAttribute("role");
    expect(card("broken")).not.toHaveAttribute("role");
  });

  it("pauses auto-dismiss while hovered and resumes on leave", () => {
    vi.useFakeTimers();
    toast.success("hover me");
    render(<Toaster />);
    const hovered = card("hover me");

    // Timer-driven store updates need act() to flush React's re-render.
    act(() => { vi.advanceTimersByTime(1000); });
    // React synthesizes onMouseEnter/Leave from mouseover/mouseout.
    fireEvent.mouseOver(hovered);
    act(() => { vi.advanceTimersByTime(10000); });
    expect(screen.getByRole("button", { name: "hover me" })).toBeInTheDocument();

    fireEvent.mouseOut(hovered);
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByRole("button", { name: "hover me" })).not.toBeInTheDocument();
  });

  it("pauses while a control in it holds focus, and resumes when focus leaves it", () => {
    vi.useFakeTimers();
    toast.success("已归档", { action: { label: "撤销", onClick: () => {} } });
    render(<Toaster />);
    act(() => { screen.getByRole("button", { name: "撤销" }).focus(); });
    act(() => { vi.advanceTimersByTime(30000); });
    expect(screen.getByRole("button", { name: "已归档" })).toBeInTheDocument();
    act(() => { screen.getByRole("button", { name: "撤销" }).blur(); });
    act(() => { vi.advanceTimersByTime(10000); });
    expect(screen.queryByRole("button", { name: "已归档" })).not.toBeInTheDocument();
  });

  it("keeps an error until it is closed", () => {
    vi.useFakeTimers();
    toast.error("无法下载报告");
    render(<Toaster />);
    act(() => { vi.advanceTimersByTime(60 * 60 * 1000); });
    expect(screen.getByRole("button", { name: "无法下载报告" })).toBeInTheDocument();
  });

  // Appendix E #7: the status is the icon's to say; the card is one card with
  // a hairline edge whatever it reports, and an error reads in the body colour.
  it("says the status with its icon, not a coloured border or coloured text", () => {
    toast.success("已保存");
    toast.error("无法下载报告");
    render(<Toaster />);
    for (const each of [card("已保存"), card("无法下载报告")]) {
      expect(each).toHaveClass("border-border");
      expect(each.className).not.toMatch(/border-(ok|danger|error)\b/);
      expect(each.className).not.toMatch(/(^|\s)text-error(\s|$)/);
      expect(each.querySelector("svg")).not.toBeNull();
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
    expect(screen.queryByRole("button", { name: "已归档" })).not.toBeInTheDocument();
  });

  it("dismisses via the close button", async () => {
    toast.success("bye");
    render(<Toaster />);
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("button", { name: "bye" })).not.toBeInTheDocument();
  });

  it("shows at most three cards, the oldest leaving first", () => {
    render(<Toaster />);
    act(() => { for (const message of ["一", "二", "三", "四"]) toast.success(message); });
    expect(screen.queryByRole("button", { name: "一" })).not.toBeInTheDocument();
    for (const message of ["二", "三", "四"]) expect(screen.getByRole("button", { name: message })).toBeInTheDocument();
  });
});
