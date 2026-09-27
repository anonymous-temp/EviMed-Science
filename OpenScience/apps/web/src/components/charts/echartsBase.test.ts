import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { motionOption, readReducedMotion, useReducedMotion } from "./echartsBase";

/**
 * Charts follow the reader's motion setting (spec §32.13): under
 * `prefers-reduced-motion: reduce` there is no animation at the root and none
 * on any series, and a chart on screen follows the setting when it changes.
 */

type Listener = (event: { matches: boolean }) => void;

/** A media query the test can flip, standing in for the browser's. */
function fakeMotionQuery(initial: boolean) {
  const listeners = new Set<Listener>();
  const query = {
    matches: initial,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
  };
  const original = window.matchMedia;
  window.matchMedia = vi.fn((media: string) => (media === query.media ? query : original(media))) as unknown as typeof window.matchMedia;
  return {
    set(matches: boolean) {
      query.matches = matches;
      for (const listener of listeners) listener({ matches });
    },
    listeners,
    restore() { window.matchMedia = original; },
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("a chart under reduced motion", () => {
  it("draws with no animation at the root and on every series", () => {
    const option = { animation: true, series: [{ type: "line", data: [1, 2] }, { type: "line", animation: true, data: [3] }] };
    const still = motionOption(option, true) as { animation: boolean; series: Array<{ animation: boolean }> };
    expect(still.animation).toBe(false);
    expect(still.series.map((series) => series.animation)).toEqual([false, false]);
    // The option handed in is not changed.
    expect(option.series[1].animation).toBe(true);
  });

  it("covers a single series written as an object, and an option with none", () => {
    expect((motionOption({ series: { type: "bar" } }, true) as { series: { animation: boolean } }).series.animation).toBe(false);
    expect(motionOption({ title: { text: "x" } }, true)).toEqual({ title: { text: "x" }, animation: false });
  });

  it("leaves the option as written when the reader did not ask for less motion", () => {
    const option = { series: [{ type: "line" }] };
    expect(motionOption(option, false)).toBe(option);
  });

  it("reads the setting, and follows it when it changes", () => {
    const media = fakeMotionQuery(false);
    restore = media.restore;
    expect(readReducedMotion()).toBe(false);
    const { result, unmount } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    act(() => media.set(true));
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);
    unmount();
    expect(media.listeners.size).toBe(0);
  });
});
