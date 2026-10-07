/**
 * What a trend chart will draw, decided before any chart library is asked.
 *
 * Two reasons this is a pure function and not part of the component:
 *
 *  - **Sparse data must not render an empty frame.** A single reading is not
 *    “nothing to draw”: it is a baseline point, the target line and the date
 *    of the next measurement. The old board left a 330 px blank canvas there,
 *    which is the clearest way a dashboard can say “this product is broken”.
 *  - **A rival is never drawn in the brand colour.** Ours is the brand and
 *    every rival is a grey, darkest for the highest rank (DESIGN.md). Deciding
 *    that here means it can be tested without a canvas.
 */

/** The brand — reserved for us, in every chart, always. */
export const OWN_COLOR = "var(--chart-own)";
/** Three greys, darkest first: the highest-ranked rival is the darkest. */
export const RIVAL_COLORS = Object.freeze(["var(--chart-rival-1)", "var(--chart-rival-2)", "var(--chart-rival-3)"]);
export const TARGET_COLOR = "var(--chart-target)";
export const BAND_COLOR = "var(--chart-band)";

/** How many rivals a comparison may carry before it becomes a plate of spaghetti. */
export const MAX_RIVALS = RIVAL_COLORS.length;

export function rivalColor(index: number): string {
  return RIVAL_COLORS[Math.min(index, RIVAL_COLORS.length - 1)];
}

export interface TrendLineInput {
  name: string;
  values: ReadonlyArray<number | null>;
}

export interface TrendMarker {
  /** Which reading it sits on. */
  index: number;
  /** “首批稿件上线”“投放生效” — what happened, in the reader's words. */
  label: string;
}

export interface TrendInput {
  /** One label per reading, in order. */
  labels: ReadonlyArray<string>;
  own: TrendLineInput;
  rivals?: ReadonlyArray<TrendLineInput>;
  /** The chosen tier's target, on the metric's own scale. */
  target?: number | null;
  targetLabel?: string | null;
  /** The measured fluctuation band, drawn as a ribbon around our line. */
  band?: number | null;
  markers?: ReadonlyArray<TrendMarker>;
  /** “10月23日 复测” — an extra slot after the last reading. */
  nextLabel?: string | null;
}

export interface TrendLine extends TrendLineInput {
  values: Array<number | null>;
  color: string;
  role: "own" | "rival";
}

export interface TrendModel {
  /** `empty`: nothing measured. `baseline`: one reading. `series`: two or more. */
  mode: "empty" | "baseline" | "series";
  /** How many of our readings can be stated. */
  readings: number;
  labels: string[];
  own: TrendLine;
  rivals: TrendLine[];
  target: number | null;
  targetLabel: string | null;
  band: number | null;
  markers: TrendMarker[];
  /** The slot the next measurement will fill, when the date is known. */
  nextIndex: number | null;
  /** The first stated reading. */
  baselineIndex: number | null;
  /**
   * The one reading of a chart that has only one, drawn as a reference line
   * labelled “基线” at the plot's right end; null once there are two.
   */
  baseline: { index: number; value: number } | null;
  /** The latest stated reading: the hollow dot. */
  lastIndex: number | null;
}

function readable(values: ReadonlyArray<number | null>): number[] {
  const at: number[] = [];
  values.forEach((value, index) => {
    if (typeof value === "number" && Number.isFinite(value)) at.push(index);
  });
  return at;
}

export function trendModel(input: TrendInput): TrendModel {
  const width = Math.max(input.labels.length, input.own.values.length, ...(input.rivals ?? []).map((line) => line.values.length));
  const pad = (values: ReadonlyArray<number | null>): Array<number | null> =>
    Array.from({ length: width }, (_, index) => {
      const value = values[index];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    });
  const labels = Array.from({ length: width }, (_, index) => input.labels[index] ?? "");
  const ownValues = pad(input.own.values);
  const stated = readable(ownValues);
  const nextLabel = input.nextLabel?.trim() || null;
  if (nextLabel) labels.push(nextLabel);
  const has = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

  return {
    mode: stated.length === 0 ? "empty" : stated.length === 1 ? "baseline" : "series",
    readings: stated.length,
    labels,
    own: { name: input.own.name, values: nextLabel ? [...ownValues, null] : ownValues, color: OWN_COLOR, role: "own" },
    // A rival with nothing measured is not a grey line at zero; it is absent.
    rivals: (input.rivals ?? [])
      .filter((line) => readable(line.values).length > 0)
      .slice(0, MAX_RIVALS)
      .map((line, index) => {
        const values = pad(line.values);
        return { name: line.name, values: nextLabel ? [...values, null] : values, color: rivalColor(index), role: "rival" as const };
      }),
    target: has(input.target) ? input.target : null,
    targetLabel: input.targetLabel?.trim() || null,
    band: has(input.band) && input.band > 0 ? input.band : null,
    markers: (input.markers ?? []).filter((marker) => marker.index >= 0 && marker.index < width && marker.label),
    nextIndex: nextLabel ? labels.length - 1 : null,
    baselineIndex: stated.length > 0 ? stated[0] : null,
    baseline: stated.length === 1 ? { index: stated[0], value: ownValues[stated[0]] as number } : null,
    lastIndex: stated.length > 0 ? stated[stated.length - 1] : null,
  };
}

/** The most labelled steps an integer axis carries before it widens its step. */
const AXIS_STEPS = 5;

/**
 * The value axis of a chart whose readings are whole numbers: a window over our line, the rivals, the target and the baseline —
 * padded so nothing sits on the frame — floored and ceiled to whole numbers and kept inside the scale's own bounds, with a whole
 * `interval` so no two labels read alike (a fractional step printed through a rounding formatter gave “47, 46, 46, 45, 45, 44, 44”).
 * A rule outside the readings' span (a target of 50 above a line at 44–46) is inside the window: the library never widens an axis
 * for a rule on its own.
 *
 * Null where there is nothing to window.
 */
export function trendAxis(
  model: TrendModel,
  { bounds = null }: { bounds?: readonly [number, number] | null } = {},
): { min: number; max: number; interval: number } | null {
  const values = [
    ...model.own.values,
    ...model.rivals.flatMap((line) => line.values),
    model.target,
    model.baseline?.value ?? null,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = Math.max(1, (high - low) * 0.08);
  let min = Math.floor(low - pad);
  let max = Math.ceil(high + pad);
  if (bounds) {
    min = Math.max(bounds[0], min);
    max = Math.min(bounds[1], max);
  }
  if (max <= min) max = min + 1;
  const interval = Math.max(1, Math.ceil((max - min) / AXIS_STEPS));
  return { min, max, interval };
}
