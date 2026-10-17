import { useMemo } from "react";
import { MapChart } from "@/components/charts/MapChart";
import { mapPalette } from "@/components/charts/map/palette";
import { radarOption, radarState, radarValue } from "@/components/charts/map/radarOption";
import { ChartCard } from "@/components/ui/ChartCard";
import { ChartGrid, type ChartGridCell } from "@/components/ui/ChartGrid";
import { useColorScheme } from "@/lib/colorScheme";
import type { MapDimension } from "@/lib/memoryMapClient";

/**
 * 「维度」: two radars with fixed, named axes (spec §2, V3) — what the researcher has been doing with the platform, and which
 * aspects of them it remembers. Each prints its numbers at the vertices and keeps the previous period as a ghost on the same scale.
 * A radar that would say nothing is not drawn: a sentence stands in its place. Pressing an axis narrows the map to it (the
 * aspects count memories, so they narrow the list; an axis of the work counts conversations and narrows nothing).
 */
function Radar({ dimension, selected, onAxis }: { dimension: MapDimension; selected: string | null; onAxis: (id: string | null) => void }) {
  const scheme = useColorScheme();
  const state = radarState(dimension);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const option = useMemo(() => (state.drawable ? radarOption(dimension, mapPalette()) : null), [dimension, state.drawable, scheme]);
  const byName = new Map(dimension.axes.map((axis) => [axis.label, axis]));
  const axisOf = (name: unknown) => byName.get(String(name ?? "").split("\n")[0]);
  return (
    <ChartCard level={2} title={dimension.title} state={state.drawable ? "content" : "empty"} emptyText={state.sentence}
      footnote={state.drawable ? `虚线是${dimension.previous}。` : undefined}>
      <div data-radar={dimension.id} className="space-y-2">
        <MapChart
          kind={`radar-${dimension.id}`} option={option} height={330}
          on={{ click: (params: { componentType?: string; name?: string }) => { const axis = axisOf(params?.name); if (axis) onAxis(selected === axis.id ? null : axis.id); } }}
          label={`${dimension.title}：${dimension.axes.map((axis) => `${axis.label} ${radarValue(dimension.scale, axis.value)}`).join("，")}。`}
          unpainted={dimension.axes.map((axis) => `${axis.label} ${radarValue(dimension.scale, axis.value)}`).join(" · ")}
        />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-3">
          {dimension.axes.map((axis) => (
            <button
              key={axis.id} type="button" aria-pressed={selected === axis.id}
              onClick={() => onAxis(selected === axis.id ? null : axis.id)}
              className={`rounded px-1 py-0.5 hover:bg-surface-2 ${selected === axis.id ? "bg-accent-soft text-accent" : ""}`}
            >
              {`${axis.label} ${radarValue(dimension.scale, axis.value)}`}
            </button>
          ))}
        </div>
      </div>
    </ChartCard>
  );
}

/** The cards two to a row, and a card left alone in its row takes the row: a grid with a hole in it is the thing `ChartGrid` refuses. */
function inRows(cells: ChartGridCell[]): ChartGridCell[][] {
  const rows: ChartGridCell[][] = [];
  for (let index = 0; index < cells.length; index += 2) {
    const row = cells.slice(index, index + 2);
    rows.push(row.length === 1 ? [{ ...row[0]!, span: 2 }] : row);
  }
  return rows;
}

export function DimsView({ dimensions, selected, onAxis }: { dimensions: readonly MapDimension[]; selected: string | null; onAxis: (id: string | null) => void }) {
  if (dimensions.length === 0) return <ChartCard level={2} title="记下的内容分布在哪些方面" state="empty" emptyText="记下的内容还不多，再多聊几次，这里会长出各方面的分布。" />;
  return <ChartGrid rows={inRows(dimensions.map((dimension) => ({ key: dimension.id, node: <Radar dimension={dimension} selected={selected} onAxis={onAxis} /> })))} />;
}
