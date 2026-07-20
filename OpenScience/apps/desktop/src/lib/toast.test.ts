import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast, useToastStore } from "./toast";

describe("toast store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-dismisses success after 3.5s but keeps errors for 6s", () => {
    toast.success("Saved to /tmp/a.py");
    toast.error("Could not save b.svg");
    const { toasts } = useToastStore.getState();
    expect(toasts.map((t) => t.tone)).toEqual(["success", "error"]);

    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts.map((t) => t.tone)).toEqual(["error"]);

    vi.advanceTimersByTime(2500);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("dismisses a single toast by id", () => {
    toast.success("one");
    toast.success("two");
    const [first] = useToastStore.getState().toasts;
    useToastStore.getState().dismiss(first.id);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["two"]);
  });

  it("pause freezes the timer and resume continues with the remaining time", () => {
    toast.success("hover me");
    const [{ id }] = useToastStore.getState().toasts;

    vi.advanceTimersByTime(1000); // 2500ms left
    useToastStore.getState().pause(id);
    vi.advanceTimersByTime(10000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    useToastStore.getState().resume(id);
    vi.advanceTimersByTime(2499);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("stores an optional action on the toast", () => {
    const onClick = vi.fn();
    toast.success("Archived", { action: { label: "撤销", onClick } });
    const [t] = useToastStore.getState().toasts;
    expect(t.action).toEqual({ label: "撤销", onClick });
  });
});
