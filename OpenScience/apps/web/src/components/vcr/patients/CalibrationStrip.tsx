import { CircleCheck, TriangleAlert } from "lucide-react";
import type { VcrCalibration, VcrCalibrationRow } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { ChartCard } from "@/components/ui/ChartCard";
import { numberText } from "../vcrText";
import { intervalLabel } from "../vcrText";

/**
 * What the study set, what the table holds and what the evidence allows — one line each (R19, plan §5.3; audit B §4.5 `CalibrationStrip`).
 *
 * Every number is the server's (`vcrCalibration.mjs`: Kaplan–Meier, Cox and means computed from the table by code, the interval
 * the card's own); the page does not work out a difference, an interval or a verdict. A row whose generated value is outside the
 * evidence's interval carries ⚠ — a mark for the reader, never a pass or a fail — and a row with no interval carries nothing:
 * 「在区间内」 is a claim only an interval can make.
 *
 * The drawing is geometry only: a track from the least to the greatest number of the row, the interval as a band, the declared value
 * as a hollow mark and the generated one as a solid dot.
 */
export function CalibrationStrip({ calibration, id }: { calibration: VcrCalibration; id?: string }) {
  const outside = calibration.rows.filter((row) => row.status === "outside").length;
  const intervals = calibration.rows.filter((row) => row.status !== "unknown").length;
  const title = outside > 0
    ? `${outside} 项生成值偏出证据区间`
    : intervals > 0 && intervals === calibration.rows.length ? "生成值都在证据区间内" : "设定、生成值与证据区间";
  return (
    <div id={id} data-vcr-calibration="" tabIndex={-1} className="outline-none">
      <ChartCard title={title}>
        <table className="w-full border-separate border-spacing-0 text-ui">
          <caption className="sr-only">设定的数、生成的数和证据区间</caption>
          <thead>
            <tr className="text-compact text-text-3">
              <th scope="col" className="border-b border-border px-2 pb-2 pt-1 text-left font-normal">指标</th>
              <th scope="col" className="border-b border-border px-2 pb-2 pt-1 text-right font-normal">设定</th>
              <th scope="col" className="border-b border-border px-2 pb-2 pt-1 text-right font-normal">生成</th>
              <th scope="col" className="border-b border-border px-2 pb-2 pt-1 text-right font-normal">证据区间</th>
              <th scope="col" className="w-1/4 border-b border-border px-2 pb-2 pt-1 text-left font-normal max-sm:hidden"><span className="sr-only">位置</span></th>
              <th scope="col" className="w-8 border-b border-border px-2 pb-2 pt-1 font-normal"><span className="sr-only">是否在区间内</span></th>
            </tr>
          </thead>
          <tbody>
            {calibration.rows.map((row) => <Row key={row.key} row={row} />)}
          </tbody>
        </table>
      </ChartCard>
    </div>
  );
}

const withUnit = (value: number | null, unit: string | null) => (value === null ? "—" : `${numberText(value)}${unit ? ` ${unit}` : ""}`);

function Row({ row }: { row: VcrCalibrationRow }) {
  const interval = row.interval;
  return (
    <tr data-vcr-calibration-row={row.key} data-vcr-calibration-status={row.status}>
      <th scope="row" className="border-b border-faint px-2 py-2.5 text-left font-normal text-text">{row.label}</th>
      <td className="whitespace-nowrap border-b border-faint px-2 py-2.5 text-right tabular-nums text-text-2">{withUnit(row.declared, row.unit)}</td>
      <td className={cn("whitespace-nowrap border-b border-faint px-2 py-2.5 text-right tabular-nums", row.status === "outside" ? "font-medium text-warn-strong" : "text-text")}>
        {withUnit(row.generated, row.unit)}
      </td>
      <td className="border-b border-faint px-2 py-2.5 text-right tabular-nums text-text-2">
        {interval ? (
          <>
            <span className="whitespace-nowrap">{`${interval.low === null ? "…" : numberText(interval.low)}–${interval.high === null ? "…" : numberText(interval.high)}`}</span>
            <span className="ml-1 text-caption text-text-3 max-sm:ml-0 max-sm:block">{interval.kind === "prediction" ? intervalLabel("prediction") : "文献范围"}</span>
          </>
        ) : "—"}
      </td>
      <td className="border-b border-faint px-2 py-2.5 max-sm:hidden"><Track row={row} /></td>
      <td className="border-b border-faint px-2 py-2.5 text-center">
        {row.status === "outside" ? (
          <span role="img" aria-label="生成值在证据区间之外" className="inline-flex text-warn-strong"><TriangleAlert size={16} aria-hidden="true" /></span>
        ) : row.status === "within" ? (
          <span role="img" aria-label="生成值在证据区间内" className="inline-flex text-ok"><CircleCheck size={16} aria-hidden="true" /></span>
        ) : null}
      </td>
    </tr>
  );
}

/** The row's numbers on one track: the interval as a band, the declared value as a ring and the generated one as a dot. */
function Track({ row }: { row: VcrCalibrationRow }) {
  // The track is the interval and where the two numbers stand against it. A row with no interval has nothing to stand against, and a
  // track scaled to two close numbers would draw a gap of a few hundredths as wide as the card.
  if (!row.interval || (row.interval.low === null && row.interval.high === null)) return null;
  const values = [row.declared, row.generated, row.interval.low, row.interval.high].filter((value): value is number => value !== null);
  if (values.length < 2) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = (high - low || Math.abs(high) || 1) * 0.15;
  const from = low - pad;
  const span = high + pad - from;
  const at = (value: number) => `${((value - from) / span) * 100}%`;
  const band = row.interval && row.interval.low !== null && row.interval.high !== null ? { left: at(row.interval.low), width: `${((row.interval.high - row.interval.low) / span) * 100}%` } : null;
  return (
    <span aria-hidden="true" data-forced-colors="preserve" className="relative block h-3 w-full">
      <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
      {band && <span data-vcr-interval-band="" className="absolute top-1/2 h-2 -translate-y-1/2 rounded-tag bg-accent-soft" style={band} />}
      {row.declared !== null && (
        <span data-vcr-declared-mark="" className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-text-2 bg-bg" style={{ left: at(row.declared) }} />
      )}
      {row.generated !== null && (
        <span data-vcr-generated-mark="" className={cn("absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full", row.status === "outside" ? "bg-warn" : "bg-accent")} style={{ left: at(row.generated) }} />
      )}
    </span>
  );
}
