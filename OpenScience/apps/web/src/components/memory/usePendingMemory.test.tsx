import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PENDING_BACKOFF_CAP_MS, PENDING_POLL_MS, PENDING_SLOW_MS, PENDING_STALL_MS, usePendingMemory } from "./usePendingMemory";

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

  it("says it is taking longer after a minute, counted from when it was asked, and keeps reading on a growing wait (audit D8)", () => {
    const reload = vi.fn();
    const waiting = [asked(Date.now())];
    const { result } = renderHook(() => usePendingMemory(waiting, reload));
    act(() => { vi.advanceTimersByTime(PENDING_SLOW_MS + 1); });
    expect(result.current.slow).toBe(true);
    expect(result.current.stalled).toBe(false);
    // Past the minute the waits are 6, 12, 24, 48 s and then a minute: each one longer than the last, none shorter than six seconds.
    const times: number[] = [];
    reload.mockImplementation(() => { times.push(Date.now()); });
    act(() => { vi.advanceTimersByTime(6_000 + 12_000 + 24_000 + 48_000 + 60_000 + 60_000); });
    const gaps = times.slice(1).map((time, index) => time - times[index]);
    expect(times.length).toBeGreaterThanOrEqual(5);
    expect(gaps.slice(0, 4)).toEqual([12_000, 24_000, 48_000, PENDING_BACKOFF_CAP_MS]);
    expect(Math.max(...gaps)).toBe(PENDING_BACKOFF_CAP_MS);
  });

  it("stops after ten minutes and says it is not finished, and reads no more", () => {
    const reload = vi.fn();
    const waiting = [asked(Date.now())];
    const { result } = renderHook(() => usePendingMemory(waiting, reload));
    act(() => { vi.advanceTimersByTime(PENDING_STALL_MS - 1_000); });
    expect(result.current.stalled).toBe(false);
    act(() => { vi.advanceTimersByTime(PENDING_BACKOFF_CAP_MS + 1_000); });
    expect(result.current.stalled).toBe(true);
    const reads = reload.mock.calls.length;
    expect(reads).toBeGreaterThan(PENDING_SLOW_MS / PENDING_POLL_MS);
    act(() => { vi.advanceTimersByTime(PENDING_STALL_MS); });
    expect(reload).toHaveBeenCalledTimes(reads);
  });

  it("counts a request made before the page was opened from the time it was made: slow at once, and no read at all if it is past ten minutes", () => {
    const reload = vi.fn();
    const recent = renderHook(() => usePendingMemory([asked(Date.now() - 2 * PENDING_SLOW_MS, "retrying")], reload));
    expect(recent.result.current).toEqual({ slow: true, stalled: false });
    act(() => { vi.advanceTimersByTime(PENDING_BACKOFF_CAP_MS); });
    expect(reload).toHaveBeenCalled();
    recent.unmount();
    reload.mockClear();
    const old = renderHook(() => usePendingMemory([asked(Date.now() - 2 * PENDING_STALL_MS, "retrying")], reload));
    expect(old.result.current).toEqual({ slow: true, stalled: true });
    act(() => { vi.advanceTimersByTime(PENDING_POLL_MS * 5); });
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps disputed preferences visible without polling or describing a delayed save", () => {
    const reload = vi.fn();
    const waiting = [{ ...asked(Date.now() - PENDING_STALL_MS), reason: "instruction_origin_uncertain" as const }];
    const { result } = renderHook(() => usePendingMemory(waiting, reload));
    expect(result.current).toEqual({ slow: false, stalled: false });
    act(() => { vi.advanceTimersByTime(PENDING_STALL_MS); });
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
