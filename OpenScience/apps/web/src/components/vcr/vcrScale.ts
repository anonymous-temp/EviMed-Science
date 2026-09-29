/**
 * The geometry every 「虚拟临研」 chart shares.
 *
 * All of it maps a value onto **0–100 in the plot's own box**, never onto
 * pixels: the plot is an SVG with `viewBox="0 0 100 100"` and
 * `preserveAspectRatio="none"`, so the lines stretch to whatever width the
 * column gives them, while every label and every dot is HTML placed by
 * percentage and keeps its 12 px at any width, down to 390 px. It is the
 * frontier feed's sparkline mechanism, one chart family further on.
 *
 * Pure functions on purpose: a survival step, a prediction band and a
 * waterfall are decisions about numbers, and the tests that matter here are
 * about the numbers rather than about React.
 */

export interface VcrScale {
  low: number;
  high: number;
  ticks: number[];
}

export interface Point {
  x: number;
  y: number | null;
  /** A band's lower and upper edge at this x. */
  low?: number | null;
  high?: number | null;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A round step near a third of the span: 1, 2, 5 × 10ⁿ. */
export function niceStep(span: number): number {
  if (!finite(span) || span <= 0) return 1;
  const raw = span / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

/**
 * A scale over every value it is given, on round numbers.
 *
 * `domain` is a range the scale must cover whatever the data do — a survival
 * probability is 0–1 even when nothing falls below 0.4, because a curve drawn
 * against its own minimum exaggerates every drop in it.
 */
export function scaleOf(
  values: ReadonlyArray<number | null | undefined>,
  domain: readonly [number, number] | null = null,
): VcrScale | null {
  const levels = [...values, ...(domain ?? [])].filter(finite);
  if (levels.length === 0) return null;
  let low = Math.min(...levels);
  let high = Math.max(...levels);
  if (domain) {
    low = Math.min(low, domain[0]);
    high = Math.max(high, domain[1]);
  }
  if (high === low) {
    low -= 1;
    high += 1;
  }
  const step = niceStep(high - low);
  const flooredLow = Math.floor(low / step) * step;
  const ceiledHigh = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let tick = flooredLow; tick <= ceiledHigh + step / 2; tick += step) {
    ticks.push(Math.round(tick * 1e6) / 1e6);
  }
  return { low: flooredLow, high: ceiledHigh, ticks };
}

/** A fixed scale, for an axis whose ticks are given rather than derived. */
export function fixedScale(low: number, high: number, ticks: readonly number[]): VcrScale {
  return { low, high, ticks: [...ticks] };
}

/** Where a value sits across the box, 0 at the left. */
export function posX(value: number, scale: VcrScale): number {
  return round((value - scale.low) / (scale.high - scale.low) * 100);
}

/** Where a value sits down the box, 0 at the **top** — SVG's own direction. */
export function posY(value: number, scale: VcrScale): number {
  return round((1 - (value - scale.low) / (scale.high - scale.low)) * 100);
}

function round(value: number): number {
  return Math.round(Math.max(-1000, Math.min(1000, value)) * 100) / 100;
}

/**
 * The path through a series.
 *
 * A missing reading breaks the line rather than being drawn as a guess: a
 * gap in a trajectory is a fact about the data, and joining across it invents
 * a measurement.
 */
export function linePath(points: readonly Point[], x: VcrScale, y: VcrScale): string {
  let path = "";
  let open = false;
  for (const point of points) {
    if (!finite(point.y) || !finite(point.x)) {
      open = false;
      continue;
    }
    path += `${path ? " " : ""}${open ? "L" : "M"}${posX(point.x, x)} ${posY(point.y, y)}`;
    open = true;
  }
  return path;
}

/**
 * A step function — what a Kaplan-Meier estimate actually is. Drawing survival
 * as a smooth line claims events happened between the times they were
 * observed at.
 */
export function stepPath(points: readonly Point[], x: VcrScale, y: VcrScale): string {
  let path = "";
  let last: { x: number; y: number } | null = null;
  for (const point of points) {
    if (!finite(point.y) || !finite(point.x)) continue;
    const at = { x: posX(point.x, x), y: posY(point.y, y) };
    if (last === null) path += `M${at.x} ${at.y}`;
    else path += ` L${at.x} ${last.y} L${at.x} ${at.y}`;
    last = at;
  }
  return path;
}

/**
 * The closed area between a series' lower and upper edge: a prediction or
 * confidence band. Model output is drawn as a band and never as a line,
 * because a line hides the spread that is the model's whole answer.
 */
export function bandPath(points: readonly Point[], x: VcrScale, y: VcrScale, { step = false } = {}): string {
  const usable = points.filter((point) => finite(point.x) && finite(point.low) && finite(point.high));
  if (usable.length < 2) return "";
  const top = usable.map((point) => ({ x: posX(point.x, x), y: posY(point.high as number, y) }));
  const bottom = usable.map((point) => ({ x: posX(point.x, x), y: posY(point.low as number, y) })).reverse();
  const draw = (list: Array<{ x: number; y: number }>, first: boolean) => list.map((at, index) => {
    if (index === 0) return `${first ? "M" : "L"}${at.x} ${at.y}`;
    const previous = list[index - 1];
    return step ? `L${at.x} ${previous.y} L${at.x} ${at.y}` : `L${at.x} ${at.y}`;
  }).join(" ");
  return `${draw(top, true)} ${draw(bottom, false)} Z`;
}

/** The share of a whole, clamped, for a stacked bar. A zero whole is no share. */
export function share(value: number | null | undefined, total: number | null | undefined): number {
  if (!finite(value) || !finite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}
