import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PENDING_GIVE_UP_MS, PENDING_POLL_MS, usePendingMemory } from "./usePendingMemory";

const asked = (at: number, state: "pending" | "retrying" = "pending") => ({ id: `p${at}`, text: "以后报告先给结论。", at: new Date(at).toISOString(), state });

describe("waiting for the memory to write what was asked", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-13T06:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("reads the list again every three seconds while something waits, and says nothing is slow in the first minute", () => {
    const reload = vi.fn();
    const waiting = [asked(Date.now())];
    const { result } = renderHook(() => usePendingMemory(waiting, reload));
    expect(result.current.slow).toBe(false);
    act(() => { vi.advanceTimersByTime(PENDING_POLL_MS * 3); });
    expect(reload).toHaveBeenCalledTimes(3);
    expect(result.current.slow).toBe(false);
  });

  it("stops after a minute, counted from when it was asked, and says it is taking longer", () => {
    const reload = vi.fn();
    const waiting = [asked(Date.now())];
    const { result } = renderHook(() => usePendingMemory(waiting, reload));
    act(() => { vi.advanceTimersByTime(PENDING_GIVE_UP_MS + PENDING_POLL_MS); });
    expect(result.current.slow).toBe(true);
    const reads = reload.mock.calls.length;
    expect(reads).toBeLessThanOrEqual(PENDING_GIVE_UP_MS / PENDING_POLL_MS + 1);
    act(() => { vi.advanceTimersByTime(PENDING_GIVE_UP_MS); });
    expect(reload).toHaveBeenCalledTimes(reads);
  });

  it("counts a request made before the page was opened from the time it was made: no fresh minute of polling", () => {
    const reload = vi.fn();
    const waiting = [asked(Date.now() - 2 * PENDING_GIVE_UP_MS, "retrying")];
    const { result } = renderHook(() => usePendingMemory(waiting, reload));
    expect(result.current.slow).toBe(true);
    act(() => { vi.advanceTimersByTime(PENDING_POLL_MS * 5); });
    expect(reload).not.toHaveBeenCalled();
  });

  it("does nothing when nothing waits, and stops the moment what waited is written", () => {
    const reload = vi.fn();
    const { rerender, result } = renderHook(({ items }) => usePendingMemory(items, reload), { initialProps: { items: [asked(Date.now())] } });
    act(() => { vi.advanceTimersByTime(PENDING_POLL_MS); });
    expect(reload).toHaveBeenCalledTimes(1);
    rerender({ items: [] });
    act(() => { vi.advanceTimersByTime(PENDING_POLL_MS * 4); });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.slow).toBe(false);
  });
});
