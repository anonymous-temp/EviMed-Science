import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/Tooltip";
import type { VcrAttritionStep, VcrDesign, VcrProfileRow, VcrValue } from "@/lib/vcrClient";
import { seriesColor } from "./VcrMarks";
import { VcrNumber } from "./VcrNumber";
import { intervalText, mcseText, numberText, rangeText, valueText } from "./vcrText";
import { fixedScale, posX, scaleOf, share } from "./vcrScale";

/**
 * The diagrams that are not time series: the screening waterfall, the balance
 * dot, the weight histogram, the sensitivity tornado, the forest plot and the
 * design trade-off scatter.
 *
 * Two rules run through all of them.
 *
 *  - **「无法判断」 is its own colour and its own texture** — an amber hatch,
 *    never folded into 「不符合」. Which of the two a person is decides whether
 *    the study needs more evidence or a different protocol, and a chart that
 *    merges them has answered a question nobody asked (plan §7.1).
 *  - **Ours is the brand, everyone else is a grey.** A design the platform
 *    found dominated is hatched and carries no numbers, because printing its
 *    numbers invites a comparison that has already been decided.
 */

/** The hatch that means 「无法判断 / 待补证」, built from tokens rather than a colour. */
const UNKNOWN_HATCH = "repeating-linear-gradient(135deg, var(--warn) 0 3px, var(--warn-soft) 3px 7px)";

/**
 * The screening waterfall: how many are left after each rule, and how many of
 * those still lack the evidence that rule needs.
 */
export function VcrAttritionChart({ steps, className }: { steps: readonly VcrAttritionStep[]; className?: string }) {
  const total = Math.max(...steps.map((step) => step.remaining ?? 0), 1);
  return (
    <ol data-vcr-attrition="" className={cn("flex flex-col gap-1.5", className)}>
      {steps.map((step) => {
        const remaining = step.remaining ?? 0;
        const unknown = Math.min(step.unknown ?? 0, remaining);
        const known = remaining - unknown;
        return (
          <li key={step.key} className="grid grid-cols-[3rem_9rem_1fr_4.5rem_3.5rem] items-center gap-2 text-caption">
            <span className="truncate tabular-nums text-text-3">{step.code ?? ""}</span>
            <span className="truncate text-text-2">{step.label}</span>
            <span
              role="img"
              aria-label={`${step.label}：保留 ${numberText(known, 0)}，无法判断 ${numberText(unknown, 0)}`}
              data-forced-colors="preserve"
              className="flex h-3 w-full overflow-hidden rounded-full bg-surface-2"
            >
              <span className="h-3 bg-accent" style={{ width: `${share(known, total)}%` }} />
              <span data-vcr-unknown="" className="h-3" style={{ width: `${share(unknown, total)}%`, backgroundImage: UNKNOWN_HATCH }} />
            </span>
            <span className="text-right tabular-nums text-text">{numberText(remaining, 0)}</span>
            <span className="text-right tabular-nums text-text-3">
              {typeof step.removed === "number" && step.removed > 0 ? `−${numberText(step.removed, 0)}` : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The three totals under the waterfall, as one stacked share bar. */
export function VcrFunnelBar({
  eligible,
  insufficient,
  ineligible,
  className,
}: {
  eligible: number | null;
  insufficient: number | null;
  ineligible: number | null;
  className?: string;
}) {
  const total = (eligible ?? 0) + (insufficient ?? 0) + (ineligible ?? 0);
  if (total <= 0) return null;
  const pct = (value: number | null) => `${((value ?? 0) / total * 100).toFixed(1)}%`;
  return (
    <div data-vcr-funnel="" className={className}>
      <span
        role="img"
        aria-label={`符合 ${eligible ?? 0}，待补证 ${insufficient ?? 0}，不符合 ${ineligible ?? 0}`}
        data-forced-colors="preserve"
        className="flex h-3 w-full overflow-hidden rounded-full bg-surface-2"
      >
        <span className="h-3 bg-accent" style={{ width: `${share(eligible, total)}%` }} />
        <span className="h-3" style={{ width: `${share(insufficient, total)}%`, backgroundImage: UNKNOWN_HATCH }} />
      </span>
      <p className="mt-1.5 flex flex-wrap gap-x-4 text-caption tabular-nums text-text-3">
        <span>{`符合 ${pct(eligible)}`}</span>
        <span>{`待补证 ${pct(insufficient)}`}</span>
        <span>{`不符合 ${pct(ineligible)}`}</span>
      </p>
    </div>
  );
}

/**
 * One covariate's standardized difference on a 0–0.4 axis, with the 0.1 floor
 * drawn. A row past the floor is not balanced, and the dot's position says by
 * how much — which a coloured cell alone never does.
 */
export function VcrSmdDot({ smd, floor = 0.1, max = 0.4, label }: { smd: number | null; floor?: number; max?: number; label: string }) {
  if (typeof smd !== "number" || !Number.isFinite(smd)) return <span className="text-text-3">—</span>;
  const scale = fixedScale(0, max, [0, floor, max]);
  const over = Math.abs(smd) >= floor;
  return (
    <span
      role="img"
      aria-label={`${label} 标准化差异 ${smd.toFixed(2)}${over ? "，超过界值" : ""}`}
      data-vcr-smd={over ? "over" : "under"}
      data-forced-colors="preserve"
      className="relative block h-3 w-full min-w-16"
    >
      <span className="absolute inset-x-0 top-1.5 h-px bg-border" />
      <span className="absolute top-0.5 h-2 w-px bg-border-control" style={{ left: `${posX(floor, scale)}%` }} />
      <span
        className={cn("absolute top-0.5 h-2 w-2 -translate-x-1/2 rounded-full", over ? "bg-warn" : "bg-text-graphic")}
        style={{ left: `${posX(Math.min(Math.abs(smd), max), scale)}%` }}
      />
    </span>
  );
}

/** The profile table's balance column, one row per covariate. */
export function VcrBalanceColumn({ rows, floor = 0.1 }: { rows: readonly VcrProfileRow[]; floor?: number }) {
  const max = Math.max(floor * 4, ...rows.map((row) => Math.abs(row.smd ?? 0)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => <VcrSmdDot key={row.key} smd={row.smd} floor={floor} max={max} label={row.label} />)}
    </div>
  );
}

/**
 * The weights a comparator's records carry, as a histogram, with the effective
 * sample size named under it. A weighting whose effective sample size has
 * collapsed is a comparison resting on a handful of records, and the
 * histogram is where that is visible before the estimate is.
 */
export function VcrWeightHistogram({
  bins,
  effectiveSampleSize,
  total,
  className,
}: {
  bins: ReadonlyArray<{ from: number; to: number; count: number }>;
  effectiveSampleSize?: number | null;
  total?: number | null;
  className?: string;
}) {
  const peak = Math.max(...bins.map((bin) => bin.count), 1);
  if (bins.length === 0) return null;
  return (
    <div data-vcr-weights="" className={className}>
      <div className="flex h-24 items-end gap-0.5">
        {bins.map((bin) => (
          <Tooltip key={`${bin.from}-${bin.to}`} content={`权重 ${bin.from}–${bin.to}：${numberText(bin.count, 0)} 条`}>
            <span
              data-forced-colors="preserve"
              className="block min-w-1 flex-1 rounded-t bg-accent"
              style={{ height: `${Math.max(2, (bin.count / peak) * 100)}%` }}
            />
          </Tooltip>
        ))}
      </div>
      <p className="mt-2 text-caption tabular-nums text-text-3">
        {[
          typeof total === "number" ? `记录 ${numberText(total, 0)} 条` : null,
          typeof effectiveSampleSize === "number" ? `加权有效样本量 ${numberText(effectiveSampleSize, 0)}` : null,
        ].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}

/**
 * 「哪些假设影响最大」: each assumption's range, drawn about the result it is
 * measured against, in the order the result lists them — widest first is the
 * chart's whole finding, and it is the server's to say.
 *
 * The reference line is the model's own output at its default parameters,
 * sent with the result (`base`). The page never makes one up: without a base
 * there is no line and no 「基准」 — the average of the bars' midpoints is not
 * a base case, it is a number nobody computed (plan §8.3).
 */
export function VcrTornadoChart({
  rows,
  centre = null,
  centreLabel,
  formatValue = (value: number) => numberText(value),
  className,
}: {
  rows: ReadonlyArray<{ label: string; range?: string | null; low: number; high: number }>;
  /** The base case the bars are measured against, when the result sent one. */
  centre?: number | null;
  /** The base case as a drillable number, printed under the bars. */
  centreLabel?: ReactNode;
  formatValue?: (value: number) => string;
  className?: string;
}) {
  const base = typeof centre === "number" && Number.isFinite(centre) ? centre : null;
  const scale = scaleOf([base, ...rows.flatMap((row) => [row.low, row.high])]);
  if (!scale || rows.length === 0) return null;
  const middle = base !== null ? posX(base, scale) : null;
  return (
    <div data-vcr-tornado="" className={className}>
      <ol className="flex flex-col gap-3">
        {rows.map((row) => {
          const from = Math.min(posX(row.low, scale), posX(row.high, scale));
          const to = Math.max(posX(row.low, scale), posX(row.high, scale));
          return (
            <li key={row.label} className="grid grid-cols-[8rem_1fr] items-center gap-3">
              <div className="min-w-0">
                <p className="truncate text-caption text-text-2">{row.label}</p>
                {row.range && <p className="truncate text-meta tabular-nums text-text-3">{row.range}</p>}
              </div>
              <div className="relative h-5">
                {middle !== null && <span data-vcr-tornado-base="" className="absolute inset-y-0 w-px bg-border-control" style={{ left: `${middle}%` }} />}
                <span
                  role="img"
                  aria-label={`${row.label}：${formatValue(row.low)} 到 ${formatValue(row.high)}`}
                  data-forced-colors="preserve"
                  className="absolute top-1 h-3 rounded-sm bg-accent-soft"
                  style={{ left: `${from}%`, width: `${Math.max(1, to - from)}%` }}
                />
                <span className="absolute top-1 h-3 w-1 rounded-sm bg-accent" style={{ left: `${from}%` }} />
                <span className="absolute top-1 h-3 w-1 rounded-sm bg-accent" style={{ left: `${Math.max(0, to - 1)}%` }} />
              </div>
            </li>
          );
        })}
      </ol>
      {base !== null && (
        <p className="mt-2 flex items-baseline gap-1.5 text-caption tabular-nums text-text-3">
          基准
          <span className="text-text-2">{centreLabel ?? formatValue(base)}</span>
        </p>
      )}
    </div>
  );
}

export interface ForestRow {
  id: string;
  label: string;
  note?: string | null;
  n?: number | null;
  value: number | null;
  low: number | null;
  high: number | null;
  weight?: number | null;
  highlighted?: boolean;
  pooled?: boolean;
  prediction?: boolean;
  /** The evidence card a run says led it to this value: said beside the study, never as its source. */
  candidateFrom?: { cardId: string; claimId?: string };
}

/**
 * The studies behind one assumption card, their pooled estimate as a diamond,
 * and the **prediction interval** as a separate whisker under it.
 *
 * The two are not the same claim: the confidence interval is about the mean of
 * the studies pooled, the prediction interval is about the next study — which
 * is the one this platform is designing. Drawing only the first is how a
 * design gets built on a precision nobody has.
 */
export function VcrForestPlot({
  rows,
  formatValue = (value: number) => numberText(value),
  unit,
  className,
}: {
  rows: readonly ForestRow[];
  formatValue?: (value: number) => string;
  unit?: string | null;
  className?: string;
}) {
  const scale = scaleOf(rows.flatMap((row) => [row.value, row.low, row.high]));
  if (!scale || rows.length === 0) return null;
  const pooled = rows.find((row) => row.pooled) ?? null;
  return (
    <div data-vcr-forest="" className={className}>
      <table className="w-full border-collapse text-caption">
        <caption className="sr-only">{`每项研究的估计与合并结果${unit ? `（${unit}）` : ""}`}</caption>
        <thead>
          <tr className="border-b border-border text-text-3">
            <th scope="col" className="py-1 pr-2 text-left font-normal">研究</th>
            <th scope="col" className="py-1 pr-2 text-right font-normal">例数</th>
            <th scope="col" className="w-2/5 py-1 text-center font-normal">{unit ?? ""}</th>
            <th scope="col" className="py-1 pl-2 text-right font-normal">估计（95% 置信区间）</th>
            <th scope="col" className="py-1 pl-2 text-right font-normal">权重</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              data-vcr-forest-row={row.id}
              className={cn("border-b border-faint", row.highlighted && "bg-accent-soft", row.pooled && "font-medium")}
            >
              <th scope="row" className="py-1.5 pr-2 text-left font-normal text-text">
                {row.label}
                {row.note && <span className="ml-1.5 text-text-3">{row.note}</span>}
                {row.candidateFrom && <span data-vcr-candidate-from={row.candidateFrom.cardId} className="ml-1.5 text-text-3" title="这个值是顺着一张证据卡找到的线索；是否成立，只看它对原文的核对">线索 · 来自证据卡</span>}
              </th>
              <td className="py-1.5 pr-2 text-right tabular-nums text-text-2">{row.n != null ? numberText(row.n, 0) : ""}</td>
              <td className="py-1.5">
                <ForestMark row={row} scale={scale} centre={pooled?.value ?? null} formatValue={formatValue} />
              </td>
              <td className="py-1.5 pl-2 text-right tabular-nums text-text">
                {row.prediction
                  // The column is headed 置信区间; the prediction row is a
                  // different claim — about the next study — and says so.
                  ? <span data-vcr-forest-pi="">{`预测区间 ${rangeText(row.low, row.high)}`}</span>
                  : (
                    <>
                      {row.value != null ? formatValue(row.value) : "—"}
                      {row.low != null && row.high != null && (
                        <span className="ml-1 text-text-3">{`(${formatValue(row.low)}–${formatValue(row.high)})`}</span>
                      )}
                    </>
                  )}
              </td>
              <td className="py-1.5 pl-2 text-right tabular-nums text-text-3">
                {row.weight != null ? `${numberText(row.weight, 1)}%` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ForestMark({ row, scale, centre, formatValue }: {
  row: ForestRow;
  scale: ReturnType<typeof scaleOf> & object;
  centre: number | null;
  formatValue: (value: number) => string;
}) {
  const at = row.value != null ? posX(row.value, scale) : null;
  const from = row.low != null ? posX(row.low, scale) : at;
  const to = row.high != null ? posX(row.high, scale) : at;
  return (
    <span
      role="img"
      aria-label={`${row.label}：${row.value != null ? formatValue(row.value) : "—"}`}
      data-forced-colors="preserve"
      className="relative block h-4 w-full"
    >
      {centre != null && <span className="absolute inset-y-0 w-px bg-border-control" style={{ left: `${posX(centre, scale)}%` }} />}
      {from != null && to != null && (
        <span
          className={cn("absolute top-1.5 h-px", row.prediction ? "bg-text-graphic" : "bg-text-2")}
          style={{ left: `${from}%`, width: `${Math.max(0.5, to - from)}%` }}
        />
      )}
      {at != null && !row.pooled && !row.prediction && (
        <span className={cn("absolute top-0.5 h-3 w-3 -translate-x-1/2 rounded-sm", row.highlighted ? "bg-accent" : "bg-text-2")} style={{ left: `${at}%` }} />
      )}
      {at != null && row.pooled && (
        <span
          className="absolute top-0.5 h-3 w-3 -translate-x-1/2 rotate-45 bg-accent"
          style={{ left: `${at}%` }}
        />
      )}
      {at != null && row.prediction && (
        <span className="absolute top-1 h-2 w-2 -translate-x-1/2 rounded-full bg-surface ring-1 ring-accent" style={{ left: `${at}%` }} />
      )}
    </span>
  );
}

/** A number and its unit as a label prints them: 「71.0%」, 「3,900 万元」. */
function withUnit(value: VcrValue | null | undefined): string {
  const text = valueText(value);
  if (!value?.unit || text === "—") return text;
  return value.unit === "%" ? `${text}%` : `${text} ${value.unit}`;
}

/** An axis tick in the measure's own unit: a percentage says so, a duration leaves it to the axis title. */
function tickFormat(unit: string | null | undefined): (value: number) => string {
  return unit === "%" ? (value) => `${numberText(value)}%` : (value) => numberText(value);
}

/**
 * The designs as a trade-off: how long against how likely, with cost as the
 * bubble's area.
 *
 *  - **The server sends what to print.** A measure arrives in its own unit
 *    (成功把握 71 with unit 「%」), so the axis and the labels print it as it
 *    is — the page never guesses that a number at most 1 was a proportion.
 *  - Every simulated number keeps its Monte-Carlo error, here too, and the
 *    cost keeps its 「万元」 (plan §4 step 6).
 *  - **The brand is a recorded decision** (`chosen`), never the page's own
 *    pick: until somebody writes one, every design is a grey.
 *  - A design another dominates carries no numbers. When it has no position
 *    it is named under the plot with the design that beats it, rather than
 *    being left out without a word.
 */
export function VcrTradeoffScatter({
  designs,
  xKey,
  yKey,
  sizeKey,
  xLabel,
  yLabel,
  sizeLabel,
  height = 300,
  className,
}: {
  designs: readonly VcrDesign[];
  xKey: string;
  yKey: string;
  sizeKey?: string;
  xLabel?: string;
  yLabel?: string;
  sizeLabel?: string;
  height?: number;
  className?: string;
}) {
  const at = (design: VcrDesign, key: string) => design.measures[key]?.value ?? null;
  const points = designs.filter((design) => at(design, xKey) != null && at(design, yKey) != null);
  const unplaced = designs.filter((design) => design.dominated && !points.includes(design));
  const x = scaleOf(points.map((design) => at(design, xKey)));
  const y = scaleOf(points.map((design) => at(design, yKey)));
  if (!x || !y || points.length === 0) return null;
  const formatX = tickFormat(points[0].measures[xKey]?.unit);
  const formatY = tickFormat(points[0].measures[yKey]?.unit);
  const sizes = sizeKey ? points.map((design) => at(design, sizeKey) ?? 0) : [];
  const biggest = Math.max(...sizes, 1);
  const radius = (design: VcrDesign) => {
    if (!sizeKey) return 4.5;
    const value = at(design, sizeKey) ?? 0;
    // Area, not diameter: a bubble twice as wide is four times the cost, and
    // scaling the radius by the value overstates every big one.
    return 3 + 6 * Math.sqrt(Math.max(0, value) / biggest);
  };
  return (
    <div data-vcr-scatter="" className={className}>
      {yLabel && <p className="mb-1 text-caption text-text-3">{yLabel}</p>}
      <div className="relative ml-10" style={{ height }}>
        {y.ticks.map((tick) => (
          <span key={tick} className="absolute -left-10 w-9 -translate-y-1/2 text-right text-meta tabular-nums text-text-3" style={{ top: `${100 - posX(tick, y)}%` }}>
            {formatY(tick)}
          </span>
        ))}
        <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {y.ticks.map((tick) => (
            <line key={tick} x1={0} x2={100} y1={100 - posX(tick, y)} y2={100 - posX(tick, y)} className="text-chart-grid" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        {points.map((design, index) => {
          const left = posX(at(design, xKey) as number, x);
          const top = 100 - posX(at(design, yKey) as number, y);
          const size = radius(design) * 2;
          return (
            <span
              key={design.id}
              data-vcr-scatter-point={design.code}
              data-vcr-chosen={design.chosen ? "" : undefined}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${left}%`, top: `${top}%` }}
            >
              <span
                aria-hidden="true"
                data-forced-colors="preserve"
                className={cn("block rounded-full", design.dominated && "border border-dashed border-border-control")}
                style={{
                  width: `${size * 2}px`,
                  height: `${size * 2}px`,
                  background: design.dominated ? "var(--surface-2)" : seriesColor(Boolean(design.chosen), index),
                  opacity: design.dominated ? 1 : design.chosen ? 0.9 : 0.42,
                }}
              />
            </span>
          );
        })}
        {points.map((design) => {
          const left = posX(at(design, xKey) as number, x);
          const top = 100 - posX(at(design, yKey) as number, y);
          const measure = design.measures[yKey];
          const cost = sizeKey ? design.measures[sizeKey] : null;
          const mcse = mcseText(measure?.mcse);
          return (
            <span
              key={`label-${design.id}`}
              data-vcr-scatter-label={design.code}
              className="absolute max-w-48 -translate-x-1/2 whitespace-nowrap text-center text-caption"
              style={{ left: `${left}%`, top: `calc(${top}% + ${radius(design) * 2 + 8}px)` }}
            >
              <span className={cn("block font-medium", design.dominated ? "text-text-3" : design.chosen ? "text-accent-strong" : "text-text-2")}>
                {design.name || design.code}
              </span>
              {design.dominated
                ? <span className="block text-text-3">{design.dominatedBy ? `被 ${design.dominatedBy} 占优` : "被占优"}</span>
                : (
                  <span className="block tabular-nums text-text-3">
                    <VcrNumber value={measure} label={`${design.name || design.code} ${yLabel ?? ""}`.trim()}>
                      {withUnit(measure)}
                      {mcse && <span className="ml-1">{mcse}</span>}
                    </VcrNumber>
                    {cost && cost.value != null && <span>{` · ${withUnit(cost)}`}</span>}
                  </span>
                )}
            </span>
          );
        })}
        <ScatterAxis scale={x} format={formatX} />
      </div>
      <p className="ml-10 mt-8 flex flex-wrap justify-between gap-2 text-meta text-text-3">
        {xLabel && <span>{xLabel}</span>}
        {sizeLabel && <span>{sizeLabel}</span>}
      </p>
      {unplaced.length > 0 && (
        <ul className="ml-10 mt-2 flex flex-col gap-1 text-caption text-text-3">
          {unplaced.map((design) => (
            <li key={design.id} data-vcr-scatter-dominated={design.code}>
              {`${design.name || design.code} · ${design.dominatedBy ? `被 ${design.dominatedBy} 占优` : "被占优"}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ScatterAxis({ scale, format }: { scale: NonNullable<ReturnType<typeof scaleOf>>; format: (value: number) => string }) {
  return (
    <div className="absolute inset-x-0 top-full h-5">
      {scale.ticks.map((tick) => (
        <span key={tick} className="absolute -translate-x-1/2 text-meta tabular-nums text-text-3" style={{ left: `${posX(tick, scale)}%` }}>
          {format(tick)}
        </span>
      ))}
    </div>
  );
}

/**
 * 里程碑: when each design would reach its landmarks — the last patient in,
 * above all — as a point inside its named prediction interval, one row per
 * design on one shared time axis (plan §5.4). Every mark is a model's
 * prediction, so every mark is a band; the chosen design, and only a chosen
 * one, is the brand.
 */
export function VcrMilestoneTimeline({
  milestones,
  chosen = [],
  axisLabel = "月",
  className,
}: {
  milestones: ReadonlyArray<{ design: string; name: string; items: ReadonlyArray<{ key: string; label: string; value: VcrValue }> }>;
  /** The codes of the designs a recorded decision chose. */
  chosen?: readonly string[];
  axisLabel?: string;
  className?: string;
}) {
  const ends = milestones.flatMap((row) => row.items.flatMap((item) => [item.value.value, item.value.interval?.low ?? null, item.value.interval?.high ?? null]));
  const scale = scaleOf([0, ...ends]);
  if (!scale || milestones.every((row) => row.items.length === 0)) return null;
  return (
    <div data-vcr-milestones="" className={className}>
      <ol className="flex flex-col gap-3">
        {milestones.map((row, index) => row.items.map((item) => {
          const value = item.value;
          const ours = chosen.includes(row.design);
          const color = seriesColor(ours, index);
          const at = typeof value.value === "number" ? posX(value.value, scale) : null;
          const low = value.interval?.low ?? null;
          const high = value.interval?.high ?? null;
          const from = typeof low === "number" ? posX(low, scale) : at;
          const to = typeof high === "number" ? posX(high, scale) : at;
          const interval = intervalText(value.interval, value.precision);
          return (
            <li key={`${row.design}-${item.key}`} data-vcr-milestone={row.design} className="grid grid-cols-[10rem_1fr_9rem] items-center gap-3">
              <div className="min-w-0">
                <p className={cn("truncate text-caption", ours ? "font-medium text-accent-strong" : "text-text-2")}>{row.name || row.design}</p>
                <p className="truncate text-meta text-text-3">{item.label}</p>
              </div>
              <span
                role="img"
                aria-label={`${row.name || row.design} ${item.label}：${valueText(value)}${value.unit ?? ""}${interval ? `，${interval}` : ""}`}
                data-forced-colors="preserve"
                className="relative block h-4"
              >
                <span className="absolute inset-x-0 top-2 h-px bg-border" />
                {from != null && to != null && to > from && (
                  <span className="absolute top-1 h-2 rounded-full" style={{ left: `${from}%`, width: `${to - from}%`, background: color, opacity: 0.28 }} />
                )}
                {at != null && (
                  <span className="absolute top-0.5 h-3 w-3 -translate-x-1/2 rounded-full" style={{ left: `${at}%`, background: color }} />
                )}
              </span>
              <div className="min-w-0 text-right">
                <p className="text-caption tabular-nums text-text"><VcrNumber value={value} label={`${row.name || row.design} ${item.label}`} /></p>
                {interval && <p className="truncate text-meta tabular-nums text-text-3">{interval}</p>}
              </div>
            </li>
          );
        }))}
      </ol>
      <div className="relative mt-1 grid grid-cols-[10rem_1fr_9rem] gap-3">
        <span />
        <span className="relative block h-5">
          {scale.ticks.map((tick) => (
            <span key={tick} className="absolute -translate-x-1/2 text-meta tabular-nums text-text-3" style={{ left: `${posX(tick, scale)}%` }}>
              {numberText(tick)}
            </span>
          ))}
        </span>
        <span className="text-right text-meta text-text-3">{axisLabel}</span>
      </div>
    </div>
  );
}

/** A chart's own legend row, under its heading. */
export function VcrLegendRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", className)}>{children}</div>;
}
