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
