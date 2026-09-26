import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import theme from "@evimed/design-tokens/echarts-theme.json";
import { useColorScheme } from "@/lib/colorScheme";

/**
 * The one place ECharts is wired into this app.
 *
 * Two rules hold the bundle honest, and they are the reason this file exists
 * rather than an `import * as echarts from "echarts"` in each chart:
 *
 *  1. **The core only, here.** This module pulls `echarts/core` and the canvas
 *     renderer; every chart module registers the series and components *it*
 *     uses with `echarts.use([...])` at its own top level, so a page that
 *     draws one line chart never ships the bar, pie, map and graph code.
 *  2. **The theme is generated, never typed.** `@evimed/design-tokens` writes
 *     `echarts-theme.json` from the same table as the CSS variables and the
 *     Tailwind preset, so a chart's grid, axes, fonts and tooltip cannot
 *     disagree with the page around them. Both schemes are registered once;
 *     the chart re-initialises when `data-theme` flips.
 *
 * In a test environment there is no 2D context, and a chart that cannot be
 * painted simply is not: the component's own DOM — its heading, its legend
 * and its `data-chart-*` attributes — is what a test reads, which is also
 * what a screen reader gets.
 */

export const CHART_THEMES = Object.freeze({ light: "evimed-light", dark: "evimed-dark" });

let registered = false;
function registerOnce(): void {
  if (registered) return;
  echarts.use([CanvasRenderer]);
  echarts.registerTheme(CHART_THEMES.light, theme.light);
  echarts.registerTheme(CHART_THEMES.dark, theme.dark);
  registered = true;
}

let paintable: boolean | null = null;
/** Whether this document can paint a canvas at all (jsdom cannot). */
export function canPaintChart(): boolean {
  if (paintable !== null) return paintable;
  try {
    paintable = typeof document !== "undefined" && Boolean(document.createElement("canvas").getContext("2d"));
  } catch {
    paintable = false;
  }
  return paintable;
}

/**
 * Mounts one chart into the returned element and keeps it in step with the
 * container's width and the page's scheme. `option` of `null` paints nothing,
 * which is how a caller says 「there is no reading to draw」 without
 * unmounting its card.
 */
export function useEChart(option: EChartsCoreOption | null): React.RefObject<HTMLDivElement | null> {
  const host = useRef<HTMLDivElement | null>(null);
  const scheme = useColorScheme();
  useEffect(() => {
    const node = host.current;
    if (!node || !option || !canPaintChart()) return undefined;
    registerOnce();
    const chart = echarts.init(node, scheme === "dark" ? CHART_THEMES.dark : CHART_THEMES.light, { renderer: "canvas" });
    chart.setOption(option);
    const resize = () => chart.resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(node);
    window.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, [option, scheme]);
  return host;
}

/**
 * A data colour as a canvas can use it. The palette is written as custom
 * properties so the document and the chart cannot drift, but a canvas resolves
 * nothing: handed `var(--chart-own)` it paints the fallback grey, which is how
 * our own line came out the colour reserved for rivals. Everything that
 * reaches ECharts goes through here.
 */
export function resolvedColor(value: string): string {
  const named = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim());
  if (!named || typeof document === "undefined" || typeof getComputedStyle !== "function") return value;
  const read = getComputedStyle(document.documentElement).getPropertyValue(named[1]).trim();
  return read || value;
}

export { echarts };
