import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useElapsed } from "./useElapsed";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("shows actual producer elapsed by ten seconds and stops ticking after settlement", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
  const startedAt = Date.now();
  const { result, rerender, unmount } = renderHook(({ live }) => useElapsed(startedAt, live), { initialProps: { live: true } });
  expect(result.current).toBe("");
  act(() => vi.advanceTimersByTime(10_000));
  expect(result.current).toBe("10 秒");
  rerender({ live: false });
  act(() => vi.advanceTimersByTime(50_000));
  expect(result.current).toBe("10 秒");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
