import type { ReactNode } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { canPaintChart, useEChart, type ChartEvents } from "./echartsBase";
import "./map/register";

/**
 * One canvas of the memory map: the host the five views draw into. It paints nothing when it is given no option, and where a
 * canvas cannot be painted (a test, a printed page) it says what the figure shows instead — the page's list under it is the same
 * marks in words, which is also what a screen reader is given (`aria-label` names the figure; the list is its text).
 */
export function MapChart({ option, label, height, on, unpainted, kind }: {
  option: EChartsCoreOption | null;
  label: string;
  height: number;
  on?: ChartEvents;
  /** What the figure says where no canvas can be painted. */
  unpainted?: ReactNode;
  /** A name for the figure in the document (`data-chart`). */
  kind: string;
}) {
  const host = useEChart(option, { on });
  return (
    <figure data-chart={kind} className="m-0 min-w-0">
      <div ref={host} role="img" aria-label={label} style={{ height }} className="w-full" />
      {!canPaintChart() && unpainted && <figcaption className="text-caption text-text-3">{unpainted}</figcaption>}
    </figure>
  );
}
