import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BarChart } from "echarts/charts";
import { GridComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import {
  decalOption,
  echarts,
  motionOption,
  readContrastSetting,
  readReducedMotion,
  registerCharts,
  useContrastSetting,
  useReducedMotion,
} from "./echartsBase";

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

/** Two media queries the test can flip: more contrast, and a forced-colours theme. */
function fakeContrastQueries() {
  const make = (media: string) => {
    const listeners = new Set<Listener>();
    return {
      matches: false,
      media,
      listeners,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    };
  };
  const queries = { more: make("(prefers-contrast: more)"), forced: make("(forced-colors: active)") };
  const original = window.matchMedia;
  window.matchMedia = vi.fn((media: string) => Object.values(queries).find((query) => query.media === media) ?? original(media)) as unknown as typeof window.matchMedia;
  return {
    set(which: keyof typeof queries, matches: boolean) {
      queries[which].matches = matches;
      for (const listener of queries[which].listeners) listener({ matches });
    },
    listening: () => queries.more.listeners.size + queries.forced.listeners.size,
    restore() { window.matchMedia = original; },
  };
}

/** Draws an option the way the app registers ECharts, but to an SVG string: jsdom has no canvas. */
function drawn(option: Parameters<typeof decalOption>[0]): string {
  registerCharts();
  echarts.use([BarChart, GridComponent, SVGRenderer]);
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 400, height: 240 });
  chart.setOption(option);
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg;
}

describe("patterns as well as colour (spec §32.13 rule 4)", () => {
  const bars = {
    animation: false,
    xAxis: { type: "category", data: ["豆包", "元宝"] },
    yAxis: { type: "value" },
    series: ["RCT", "指南", "说明书"].map((name, index) => ({ type: "bar", name, data: [index + 1, index + 2] })),
  };

  it("turns on ECharts' decal, without letting ECharts rename the chart", () => {
    const patterned = decalOption(bars, true) as { aria: unknown };
    expect(patterned.aria).toEqual({ enabled: true, label: { enabled: false }, decal: { show: true } });
    // A caller's own aria settings are kept.
    const own = decalOption({ ...bars, aria: { label: { enabled: true } } }, true) as { aria: { label: { enabled: boolean } } };
    expect(own.aria.label.enabled).toBe(true);
    expect(decalOption(bars, false)).toBe(bars);
  });

  it("draws a pattern on every series once it is on, and none before", () => {
    // Registered by the app's own `registerCharts`: the decal lives in the
    // aria component, and a chart without it would draw plain colour.
    const patterns = (svg: string) => (svg.match(/<pattern/g) ?? []).length;
    expect(patterns(drawn(bars))).toBe(0);
    expect(patterns(drawn(decalOption(bars, true)))).toBe(3);
  });

  it("is on under more contrast or a forced-colours theme, and follows either as it changes", () => {
    const media = fakeContrastQueries();
    restore = media.restore;
    expect(readContrastSetting()).toBe(false);
    const { result, unmount } = renderHook(() => useContrastSetting());
    expect(result.current).toBe(false);
    act(() => media.set("forced", true));
    expect(result.current).toBe(true);
    act(() => media.set("forced", false));
    expect(result.current).toBe(false);
    act(() => media.set("more", true));
    expect(result.current).toBe(true);
    expect(readContrastSetting()).toBe(true);
    unmount();
    expect(media.listening()).toBe(0);
  });
});
