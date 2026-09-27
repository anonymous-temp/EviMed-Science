import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_DURATIONS } from "@evimed/design-tokens";
import { MAX_TOASTS, toast, toastDuration, useToastStore } from "./toast";

describe("toast store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Spec §22.1, appendix E #7: a success 5 s, with an action 10 s, and an
  // error stays until it is closed.
  it("keeps a success for 5 s, one with an action for 10 s, and an error until it is closed", () => {
    toast.success("已保存");
    toast.success("已归档", { action: { label: "撤销", onClick: () => {} } });
    toast.error("无法保存 b.svg");
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["已保存", "已归档", "无法保存 b.svg"]);

    vi.advanceTimersByTime(4999);
    expect(useToastStore.getState().toasts).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["已归档", "无法保存 b.svg"]);

    vi.advanceTimersByTime(5000);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["无法保存 b.svg"]);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["无法保存 b.svg"]);
  });

  it("reads its durations from the token table", () => {
    expect(toastDuration("success", false)).toBe(TOAST_DURATIONS.success);
    expect(toastDuration("success", true)).toBe(TOAST_DURATIONS.action);
    expect(toastDuration("error", false)).toBeNull();
    expect(toastDuration("error", true)).toBeNull();
  });

  it("shows at most three, and a fourth sends the oldest away", () => {
    toast.error("一");
    toast.success("二");
    toast.success("三");
    toast.success("四");
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["二", "三", "四"]);
    expect(MAX_TOASTS).toBe(3);
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

    vi.advanceTimersByTime(1000); // 4000ms left
    useToastStore.getState().pause(id);
    vi.advanceTimersByTime(10000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    useToastStore.getState().resume(id);
    vi.advanceTimersByTime(3999);
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
