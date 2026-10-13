import { useEffect, useMemo, useRef } from "react";
import { MapChart } from "@/components/charts/MapChart";
import { mapPalette } from "@/components/charts/map/palette";
import { rangeOfWindow, timeExtent, timeOption, timeRows, windowFromZoom, windowOfRange } from "@/components/charts/map/timeOption";
import { useColorScheme } from "@/lib/colorScheme";
import { formatDay } from "@/lib/format";
import type { MemoryMap } from "@/lib/memoryMapClient";

/**
 * 「时间」: how an understanding changed, and what was remembered when (spec §2, V4) — lineages above, events below, one time axis
 * under them whose slider is the whole map's range: moving it chooses `range`, and the other views read the same window.
 */
export function TimeView({ doc, range, projectName, onRange, onOpen }: {
  doc: Pick<MemoryMap, "lanes" | "events" | "summary" | "scope">;
  range: string;
  projectName: (id: string) => string;
  /** The slider settled on a window (`YYYY-MM-DD..YYYY-MM-DD`), or the whole span (`all`). */
  onRange: (range: string) => void;
  onOpen: (ref: string) => void;
}) {
  const scheme = useColorScheme();
  const timeZone = doc.scope.timeZone;
  const today = doc.scope.range.to;
  const rows = useMemo(() => timeRows(doc.lanes, doc.events, projectName), [doc.lanes, doc.events, projectName]);
  const extent = useMemo(() => timeExtent({ since: doc.summary.since, lanes: doc.lanes, events: doc.events, today }, timeZone), [doc, today, timeZone]);
  // `now` is the end of today's axis, so a version still in force runs to the edge.
  const now = useMemo(() => Date.parse(`${today}T23:59:59Z`), [today]);
  const window = windowOfRange(range);
  const option = useMemo(() => (rows.length === 0 ? null : timeOption({
    lanes: doc.lanes, events: doc.events, rows, extent, window, timeZone, now, palette: mapPalette(),
    formatDay: (iso) => formatDay(iso),
    // The palette is read from the live document, so a theme flip is a reason to build the option again; the window is read by its days.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [doc.lanes, doc.events, rows, extent, window?.from, window?.to, timeZone, now, scheme]);

  // The slider reports many positions while it is dragged; the map is asked once it has settled.
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (settle.current) clearTimeout(settle.current); }, []);
  const byId = new Map(doc.events.map((event) => [event.id, event]));

  // The words under the picture name only what is in it: an account that has replaced nothing has no bars and no grey, and the picture says nothing of them.
  const hasLanes = doc.lanes.length > 0;
  const hasReplaced = doc.events.some((event) => event.change === "superseded");
  const hasConflict = doc.lanes.some((lane) => lane.segments.some((segment) => segment.conflict));
  const legend = [
    "◆ 决定 ✕ 纠正 ▲ 学会一个做法 ● 记下一条",
    hasLanes ? `蓝条是一直成立的说法，灰条和灰点是后来被替代的${hasConflict ? "，条上的琥珀小标是和另一条不一致" : ""}。` : hasReplaced ? "灰点是后来被替代的。" : "",
    "拖下面的滑块可以选一段时间。",
  ].filter(Boolean).join(" ");
  const counted = `${hasLanes ? `${doc.lanes.length} 条沿革，` : ""}${doc.events.length} 件记下的事`;
  if (rows.length === 0) return <p role="status" className="text-ui text-text-2">{window ? "这段时间里没有记下的事。" : "还没有记下的事，时间线会在这里长出来。"}</p>;
  return (
    <div className="space-y-2">
      <MapChart
        kind="time" option={option} height={Math.max(220, 96 + rows.length * 34)}
        on={{
          datazoom: (params: { start?: number; end?: number; batch?: Array<{ start?: number; end?: number }> }) => {
            if (settle.current) clearTimeout(settle.current);
            settle.current = setTimeout(() => {
              const chosen = windowFromZoom(params, extent, timeZone);
              const next = rangeOfWindow(chosen);
              if (next !== range) onRange(next);
            }, 450);
          },
          click: (params: { seriesType?: string; data?: { eventId?: string; recordId?: string } }) => {
            const event = params?.data?.eventId ? byId.get(params.data.eventId) : undefined;
            if (event) onOpen(event.ref);
            else if (params?.data?.recordId) onOpen(`memory:${params.data.recordId}`);
          },
        }}
        label={`时间线：${counted}，列表在下方。`}
        unpainted={`${counted}。`}
      />
      <p className="text-caption text-text-3">
        {legend}
        {window ? `现在看的是 ${window.from} 到 ${window.to}。` : ""}
      </p>
      <span className="sr-only">{`按 ${timeZone} 的日期`}</span>
    </div>
  );
}
