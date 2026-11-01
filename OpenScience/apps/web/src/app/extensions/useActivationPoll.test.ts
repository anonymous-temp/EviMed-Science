import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ACTIVATION_POLL_DELAYS_MS } from "./catalogueModel";
import { useActivationPoll } from "./useActivationPoll";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("re-reads a pending apply with growing waits and stops when they run out", () => {
  const refresh = vi.fn();
  const { rerender } = renderHook(({ pending, observed, round }) => useActivationPoll(pending, refresh, observed, round), { initialProps: { pending: true, observed: {}, round: "1" } });
  const total = ACTIVATION_POLL_DELAYS_MS.length;
  for (let index = 0; index < total; index++) {
    act(() => { vi.advanceTimersByTime(ACTIVATION_POLL_DELAYS_MS[index] - 1); });
    expect(refresh).toHaveBeenCalledTimes(index);
    act(() => { vi.advanceTimersByTime(1); });
    expect(refresh).toHaveBeenCalledTimes(index + 1);
    // Each read returns a new answer, which arms the next, longer wait.
    rerender({ pending: true, observed: {}, round: "1" });
  }
  act(() => { vi.advanceTimersByTime(60 * 60 * 1000); });
  expect(refresh).toHaveBeenCalledTimes(total);
  // The reader's own change starts the waits again.
  rerender({ pending: true, observed: {}, round: "2" });
  act(() => { vi.advanceTimersByTime(ACTIVATION_POLL_DELAYS_MS[0]); });
  expect(refresh).toHaveBeenCalledTimes(total + 1);
});

it("never polls an activation that is not under way", () => {
  const refresh = vi.fn();
  renderHook(() => useActivationPoll(false, refresh, {}, "1"));
  act(() => { vi.advanceTimersByTime(60 * 60 * 1000); });
  expect(refresh).not.toHaveBeenCalled();
});

it("says it gave up once the waits ran out with the apply still pending, and starts afresh when asked", () => {
  const refresh = vi.fn();
  const { result, rerender } = renderHook(({ pending, observed, round }) => useActivationPoll(pending, refresh, observed, round), { initialProps: { pending: true, observed: {}, round: "1" } });
  expect(result.current.gaveUp).toBe(false);
  for (let index = 0; index < ACTIVATION_POLL_DELAYS_MS.length; index++) {
    act(() => { vi.advanceTimersByTime(ACTIVATION_POLL_DELAYS_MS[index]); });
    // The last wait is the last look: the hook says it gave up as that look is taken, and not before.
    expect(result.current.gaveUp).toBe(index === ACTIVATION_POLL_DELAYS_MS.length - 1);
    rerender({ pending: true, observed: {}, round: "1" });
  }
  expect(result.current.gaveUp).toBe(true);
  // A press reads once more and the waits begin again from the first.
  const reads = refresh.mock.calls.length;
  act(() => { result.current.again(); });
  expect(refresh).toHaveBeenCalledTimes(reads + 1);
  expect(result.current.gaveUp).toBe(false);
  rerender({ pending: true, observed: {}, round: "1" });
  act(() => { vi.advanceTimersByTime(ACTIVATION_POLL_DELAYS_MS[0]); });
  expect(refresh).toHaveBeenCalledTimes(reads + 2);
});

it("does not say it gave up when nothing is pending, whatever happened before", () => {
  const refresh = vi.fn();
  const { result, rerender } = renderHook(({ pending }) => useActivationPoll(pending, refresh, {}, "1"), { initialProps: { pending: true } });
  for (const delay of ACTIVATION_POLL_DELAYS_MS) { act(() => { vi.advanceTimersByTime(delay); }); rerender({ pending: true }); }
  expect(result.current.gaveUp).toBe(true);
  rerender({ pending: false });
  expect(result.current.gaveUp).toBe(false);
});
