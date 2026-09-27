import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import {
  LINE_PATTERNS,
  PATTERN_MARKER,
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
  echarts.use([BarChart, LineChart, GridComponent, SVGRenderer]);
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

  it("gives each line its own dash and marker shape, and leaves the band's invisible floor and the bars alone", () => {
    const lines = {
      animation: false,
      xAxis: { type: "category", data: ["9/1", "9/8", "9/15"] },
      yAxis: { type: "value" },
      series: [
        { type: "line", silent: true, stack: "band", symbol: "none", lineStyle: { opacity: 0 }, data: [1, 1, 1] },
        { type: "line", name: "信尔美", symbol: "circle", symbolSize: 5, lineStyle: { width: 2.5 }, data: [44, 50, 61] },
        { type: "line", name: "诺和盈", symbol: "none", lineStyle: { width: 1.5 }, data: [70, 71, 72] },
        { type: "line", name: "司美", symbol: "none", data: [30, 32, 35] },
        { type: "bar", name: "投放", data: [1, 2, 3] },
      ],
    };
    type Drawn = { symbol?: string; showSymbol?: boolean; symbolSize?: number; lineStyle?: { type?: unknown; width?: number; opacity?: number } };
    const series = (decalOption(lines, true) as { series: Drawn[] }).series;
    expect(series[0]).toBe(lines.series[0]);
    expect(series.slice(1, 4).map((entry) => [entry.lineStyle?.type, entry.symbol])).toEqual(
      LINE_PATTERNS.slice(0, 3).map((pattern) => [pattern.type, pattern.symbol]),
    );
    expect(new Set(series.slice(1, 4).map((entry) => String(entry.lineStyle?.type))).size).toBe(3);
    expect(series.slice(1, 4).every((entry) => entry.showSymbol && entry.symbolSize === PATTERN_MARKER)).toBe(true);
    // What a line already set stays: its weight.
    expect(series[1]!.lineStyle?.width).toBe(2.5);
    expect(series[4]).toBe(lines.series[4]);
    // Off, the option is as written.
    expect(decalOption(lines, false)).toBe(lines);
    // Drawn, the dashes are really there.
    const dashes = (svg: string) => (svg.match(/stroke-dasharray/g) ?? []).length;
    expect(dashes(drawn(lines))).toBe(0);
    expect(dashes(drawn(decalOption(lines, true)))).toBeGreaterThanOrEqual(2);
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
