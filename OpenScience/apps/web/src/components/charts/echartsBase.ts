import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { AriaComponent } from "echarts/components";
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
 * Motion follows the reader's setting: under `prefers-reduced-motion: reduce`
 * every chart is drawn without animation, at the root and on every series
 * (spec §32.13 — ECharts reads both), and a chart already on screen is
 * redrawn when the setting changes.
 *
 * Colour is not the only thing that tells series apart (spec §32.13 rule 4):
 * a reader who asked for more contrast (`prefers-contrast: more`) or runs a
 * Windows contrast theme (`forced-colors: active`) gets ECharts' decal
 * patterns on every filled mark, and a chart that has three or more
 * categories with no direct label asks for them always (`useEChart(option,
 * { decal: true })`). A chart already on screen follows the setting too.
 *
 * In a test environment there is no 2D context, and a chart that cannot be
 * painted simply is not: the component's own DOM — its heading, its legend
 * and its `data-chart-*` attributes — is what a test reads, which is also
 * what a screen reader gets.
 */

export const CHART_THEMES = Object.freeze({ light: "evimed-light", dark: "evimed-dark" });

let registered = false;
/**
 * The renderer, the component the decal patterns live in, and both themes —
 * once per document. Exported so a test can draw what the app draws.
 */
export function registerCharts(): void {
  if (registered) return;
  echarts.use([CanvasRenderer, AriaComponent]);
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

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Whether the reader asked for less motion, right now. */
export function readReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION).matches;
}

/** The reader's motion setting, kept current as it changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(REDUCED_MOTION);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

const MORE_CONTRAST = "(prefers-contrast: more)";
const FORCED_COLORS = "(forced-colors: active)";

/** Whether the reader asked for more contrast, or runs a forced-colours theme, right now. */
export function readContrastSetting(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(MORE_CONTRAST).matches || window.matchMedia(FORCED_COLORS).matches;
}

/** The reader's contrast setting, kept current as either query changes. */
export function useContrastSetting(): boolean {
  const [more, setMore] = useState(readContrastSetting);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const queries = [window.matchMedia(MORE_CONTRAST), window.matchMedia(FORCED_COLORS)];
    const update = () => setMore(queries.some((query) => query.matches));
    update();
    for (const query of queries) query.addEventListener("change", update);
    return () => { for (const query of queries) query.removeEventListener("change", update); };
  }, []);
  return more;
}

/**
 * An option with decal patterns on its filled marks (spec §32.13 rule 4):
 * ECharts' `aria.decal`, which needs `aria.enabled`. ECharts' own generated
 * description is left off unless the option asks for it — it would replace
 * the chart host's accessible name, which is the conclusion the chart shows.
 */
export function decalOption(option: EChartsCoreOption, on: boolean): EChartsCoreOption {
  if (!on) return option;
  const aria = (option.aria ?? {}) as { label?: object; decal?: object };
  return {
    ...option,
    aria: { ...aria, enabled: true, label: { enabled: false, ...aria.label }, decal: { ...aria.decal, show: true } },
  } as EChartsCoreOption;
}

/**
 * An option as it is drawn for a reader who asked for less motion: no
 * animation at the root and none on any series — a series that sets its own
 * `animation` would otherwise keep it.
 */
export function motionOption(option: EChartsCoreOption, reduced: boolean): EChartsCoreOption {
  if (!reduced) return option;
  const series = option.series;
  const still = (entry: unknown) => (entry && typeof entry === "object" ? { ...entry, animation: false } : entry);
  return {
    ...option,
    animation: false,
    ...(series === undefined ? {} : { series: Array.isArray(series) ? series.map(still) : still(series) }),
  } as EChartsCoreOption;
}

/**
 * Mounts one chart into the returned element and keeps it in step with the
 * container's width, the page's scheme, and the reader's motion and contrast
 * settings. `option` of `null` paints nothing, which is how a caller says
 * “there is no reading to draw” without unmounting its card. `decal: true`
 * is for a chart with three or more categories and no direct label, which
 * needs its patterns whatever the reader's settings.
 */
export function useEChart(option: EChartsCoreOption | null, { decal = false }: { decal?: boolean } = {}): React.RefObject<HTMLDivElement | null> {
  const host = useRef<HTMLDivElement | null>(null);
  const scheme = useColorScheme();
  const reduced = useReducedMotion();
  const patterned = useContrastSetting() || decal;
  useEffect(() => {
    const node = host.current;
    if (!node || !option || !canPaintChart()) return undefined;
    registerCharts();
    const chart = echarts.init(node, scheme === "dark" ? CHART_THEMES.dark : CHART_THEMES.light, { renderer: "canvas" });
    chart.setOption(decalOption(motionOption(option, reduced), patterned));
    const resize = () => chart.resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(node);
    window.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, [option, scheme, reduced, patterned]);
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
