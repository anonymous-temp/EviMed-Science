import type { ReactNode } from "react";
import type { VcrDoseResponseCard, VcrSeries } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { BlockHeading } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { strokeOf, VcrPlot, VcrSeriesLegend } from "./VcrCharts";
import { seriesColor } from "./VcrMarks";
import { VcrNumber } from "./VcrNumber";
import { VcrPremises } from "./VcrPremises";
import { bandPath, fixedScale, linePath, posX, posY, scaleOf, type Point, type VcrScale } from "./vcrScale";
import { intervalText, numberText } from "./vcrText";

type PredictionRow = VcrDoseResponseCard["predictions"][number] & { key: string };

const SUBHEADING = "text-ui font-semibold text-text";

/** The ratios a log axis may be ticked at: round numbers a reader recognises, tighter around 1 where most effects are. */
const NICE_RATIOS: readonly number[] = [0.05, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.8, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50, 100];
const MAX_RATIO_TICKS = 5;
const MAX_DOSE_LABELS = 7;

/** The round ratios at least `gap` apart on a log axis, walking out from 1 so the null line is always one of them. */
function spacedRatios(candidates: readonly number[], gap: number): number[] {
  const kept = [1];
  for (const outward of [candidates.filter((ratio) => ratio > 1), candidates.filter((ratio) => ratio < 1).reverse()]) {
    let last = 0;
    for (const ratio of outward) {
      if (Math.abs(Math.log(ratio) - last) >= gap - 1e-9) {
        kept.push(ratio);
        last = Math.log(ratio);
      }
    }
  }
  return kept.sort((a, b) => a - b);
}

/**
 * A log axis for a ratio: the scale is in natural logs, so equal distances are equal multiples, and its ticks are round ratios inside the
 * data's span, evenly enough spread to read, 1 always one of them. Null when there is no positive ratio to place.
 */
export function ratioAxis(values: ReadonlyArray<number | null | undefined>): VcrScale | null {
  const positive = [...values, 1].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (positive.length <= 1) return null;
  const min = Math.min(...positive);
  const max = Math.max(...positive);
  let floor = [...NICE_RATIOS].reverse().find((ratio) => ratio <= min) ?? min;
  let ceiling = NICE_RATIOS.find((ratio) => ratio >= max) ?? max;
  // Every ratio exactly 1: the axis still needs a span, one round number either side.
  if (floor === ceiling) {
    const at = NICE_RATIOS.indexOf(floor);
    floor = NICE_RATIOS[at - 1] ?? floor / 2;
    ceiling = NICE_RATIOS[at + 1] ?? ceiling * 2;
  }
  const inside = NICE_RATIOS.filter((ratio) => ratio >= floor && ratio <= ceiling);
  let gap = 0.05;
  let ticks = spacedRatios(inside, gap);
  while (ticks.length > MAX_RATIO_TICKS) {
    gap += 0.01;
    ticks = spacedRatios(inside, gap);
  }
  return fixedScale(Math.log(floor), Math.log(ceiling), ticks.map((tick) => Math.log(tick)));
}

/** A ratio as an axis label: the log tick turned back, to three significant digits. */
const ratioLabel = (logTick: number): string => String(Number(Math.exp(logTick).toPrecision(3)));

/** The doses the x axis is labelled at: the doses the card predicted at, else a round scale over the curve. */
function doseAxis(card: VcrDoseResponseCard): { scale: VcrScale; labels: string[] } | null {
  const doses = card.curve.map((point) => point.dose);
  const low = Math.min(...doses);
  const high = Math.max(...doses);
  const inRange = card.predictions.map((row) => row.dose).filter((dose) => dose >= low && dose <= high);
  // Labels that would crowd the axis are thinned to every other, every third and so on; the first dose stays.
  const stride = Math.ceil(inRange.length / MAX_DOSE_LABELS);
  const stated = inRange.filter((_, index) => index % stride === 0);
  if (stated.length >= 2 && high > low) return { scale: fixedScale(low, high, stated), labels: stated.map((dose) => numberText(dose)) };
  const scale = scaleOf(doses);
  return scale ? { scale, labels: scale.ticks.map((tick) => numberText(tick)) } : null;
}

interface CurveGeometry {
  points: Point[];
  x: VcrScale;
  y: VcrScale;
  xLabels: string[];
}

/** The curve's geometry, or null when there is nothing to draw: fewer than two doses, or a ratio a log axis cannot place. */
function curveOf(card: VcrDoseResponseCard): CurveGeometry | null {
  // A point with a ratio or an interval end of 0 or less is not drawn.
  const curve = card.curve.filter((point) => point.ratio > 0 && point.lower > 0 && point.upper > 0);
  const axis = curve.length >= 2 ? doseAxis({ ...card, curve }) : null;
  const y = ratioAxis(curve.flatMap((point) => [point.ratio, point.lower, point.upper]));
  if (!axis || !y) return null;
  return {
    points: curve.map((point) => ({ x: point.dose, y: Math.log(point.ratio), low: Math.log(point.lower), high: Math.log(point.upper) })),
    x: axis.scale, y, xLabels: axis.labels,
  };
}

/**
 * The fitted curve with its interval band against dose, the ratio on a log axis with the null line at 1, and a dot at each dose the card
 * predicted. The curve comes from pooled published studies, so it is drawn the way every aggregate is: dashed.
 */
function DoseCurve({ card, geometry }: { card: VcrDoseResponseCard; geometry: CurveGeometry }) {
  const { points, x, y, xLabels } = geometry;
  const color = seriesColor(true);
  const stroke = strokeOf({ source: "aggregate", ours: true });
  const level = card.predictions.find((row) => row.value.interval?.level != null)?.value.interval?.level ?? null;
  // The legend names the band from the data: its kind and the level the predictions were computed at.
  const legend: VcrSeries = {
    key: "dose-response", label: card.ratioWord || "拟合曲线", source: "aggregate", ours: true,
    points: points.map((point) => ({ x: point.x, y: point.y, low: point.low, high: point.high })),
    bandKind: "confidence", bandLevel: level,
  };
  return (
    <div data-vcr-dose-curve="" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <VcrSeriesLegend series={[legend]} />
      </div>
      <VcrPlot
        x={x}
        y={y}
        xLabels={xLabels}
        xLabel={card.doseUnit ? `剂量（${card.doseUnit}）` : "剂量"}
        yLabel={`${card.ratioWord || "比值"}（对数刻度）`}
        formatY={ratioLabel}
        height={240}
        overlay={card.predictions.filter((row) => row.value.value != null && row.value.value > 0).map((row) => (
          <span
            key={row.dose}
            data-vcr-dose-point={row.dose}
            aria-hidden="true"
            data-forced-colors="preserve"
            className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-graphic"
            style={{ left: `${posX(row.dose, x)}%`, top: `${posY(Math.log(row.value.value as number), y)}%` }}
          />
        ))}
      >
        <line
          data-vcr-null-line=""
          x1={0}
          x2={100}
          y1={posY(0, y)}
          y2={posY(0, y)}
          className="text-chart-target"
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
        <path data-vcr-band="confidence" d={bandPath(points, x, y)} fill={color} opacity={0.16} />
        <path
          data-vcr-series-line="dose-response"
          d={linePath(points, x, y)}
          fill="none"
          stroke={color}
          strokeWidth={stroke.width}
          strokeDasharray={stroke.dash}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </VcrPlot>
    </div>
  );
}

/** The ratio at each dose the card predicted at, the reference dose marked: the chart's numbers, readable without the chart. */
function predictionColumns(card: VcrDoseResponseCard): Array<DataColumn<PredictionRow>> {
  return [
    {
      key: "dose",
      header: card.doseUnit ? `剂量（${card.doseUnit}）` : "剂量",
      rowHeader: true,
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="tabular-nums text-text">{numberText(row.dose)}</span>
          {row.isReference && <Tag>参照</Tag>}
        </span>
      ),
    },
    {
      key: "ratio",
      header: card.ratioWord || "比值",
      align: "right",
      cell: (row) => {
        // The reference dose is compared with itself: its interval is a point, and printing it would claim a precision nobody computed.
        const interval = row.isReference ? "" : intervalText(row.value.interval, row.value.precision);
        return (
          <span className="flex flex-col items-end">
            <VcrNumber value={row.value} label={`剂量 ${numberText(row.dose)} 的${card.ratioWord || "比值"}`} className="font-normal" />
            {interval && <span className="text-meta font-normal text-text-3">{interval}</span>}
          </span>
        );
      },
    },
  ];
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <BlockHeading className={SUBHEADING}>{title}</BlockHeading>
      {children}
    </div>
  );
}

function DoseResponseCard({ card }: { card: VcrDoseResponseCard }) {
  const predictions: PredictionRow[] = card.predictions.map((row) => ({ ...row, key: String(row.dose) }));
  const geometry = curveOf(card);
  const { overall, nonlinearity } = card.tests;
  return (
    <div data-vcr-dose-response={card.id} className="min-w-0">
      <ChartCard title={card.title}>
        <div className="flex flex-col gap-4">
          {card.question && <p data-vcr-evidence-question="" className="text-caption text-text-3">{card.question}</p>}
          {card.headline && <p data-vcr-dose-headline="" className="text-ui text-text">{card.headline}</p>}

          {(predictions.length > 0 || geometry) && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {geometry && <DoseCurve card={card} geometry={geometry} />}
              {predictions.length > 0 && (
                <Block title="各剂量的估计">
                  <DataTable
                    label={`${card.title}：各剂量的估计`}
                    columns={predictionColumns(card)}
                    rows={predictions}
                    rowKey={(row) => row.key}
                    rowAttrs={(row) => ({ "data-vcr-dose-row": String(row.dose), ...(row.isReference ? { "data-vcr-dose-reference": "" } : {}) })}
                    minWidth="min-w-0"
                    ground="surface"
                  />
                </Block>
              )}
            </div>
          )}

          {card.firstDose && <p data-vcr-first-dose="" className="text-ui text-text">{card.firstDose}</p>}

          {(overall || nonlinearity || card.heterogeneity || card.excluded.length > 0) && (
            <div className="flex flex-col gap-1">
              {overall && <p data-vcr-dose-test="overall" className="text-ui text-text">{overall}</p>}
              {nonlinearity && (
                <p data-vcr-dose-test="nonlinearity" className="text-ui text-text">
                  {"非线性检验 P = "}<VcrNumber value={nonlinearity} label="非线性检验的 P 值" />
                </p>
              )}
              {card.heterogeneity && <p data-vcr-dose-heterogeneity="" className="text-ui text-text">{card.heterogeneity}</p>}
              {card.excluded.length > 0 && <p data-vcr-dose-excluded="" className="text-ui text-text">{`没能纳入的研究：${card.excluded.join("、")}`}</p>}
            </div>
          )}

          {card.note && <p data-vcr-dose-note="" className="text-caption text-text-3">{card.note}</p>}
          <VcrPremises premises={card.premises} onChange={null} />
        </div>
      </ChartCard>
    </div>
  );
}

/** The dose-response meta-analyses a conversation computed, each a card of its own: what a step of dose does and where the curve leaves 1. */
export function VcrDoseResponse({ cards }: { cards: readonly VcrDoseResponseCard[] }) {
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((card) => <DoseResponseCard key={`${card.id}@${card.version}`} card={card} />)}
    </>
  );
}
