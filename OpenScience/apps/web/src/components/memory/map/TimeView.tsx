import { useEffect, useMemo, useRef } from "react";
import { MapChart } from "@/components/charts/MapChart";
import { CHANGE_KINDS, CHANGE_NAMES, chartsFrom, totalsOf, weeklyChanges, weeksSentence, windowOfWeeks } from "@/components/charts/map/changeWeeks";
import { mapPalette } from "@/components/charts/map/palette";
import { timeExtent, timeOption, timeRows } from "@/components/charts/map/timeOption";
import { weekOption } from "@/components/charts/map/weekOption";
import { dayIn } from "@/components/charts/map/zone";
import { ChartCard, LegendMark } from "@/components/ui/ChartCard";
import { ChartGrid } from "@/components/ui/ChartGrid";
import { useColorScheme } from "@/lib/colorScheme";
import { formatDay } from "@/lib/format";
import type { MemoryMap } from "@/lib/memoryMapClient";

/** The data palette's variables for the three counts, in the order of `CHANGE_KINDS` (they are what `weekOption` paints with). */
const CHANGE_VARS = { noted: "var(--chart-own)", merged: "var(--chart-rival-2)", forgotten: "var(--chart-rival-3)" } as const;
const CHANGE_SERIES = { noted: "own", merged: "rival-2", forgotten: "rival-3" } as const;

/** The last day the axes reach: today, in the researcher's zone — not the end of a window the reader has chosen, or the axis would stop there. */
function axisEnd(scope: MemoryMap["scope"]): string {
  if (scope.range.from === null) return scope.range.to;
  const today = dayIn(Date.now(), scope.timeZone);
  return today > scope.range.to ? today : scope.range.to;
}

/**
 * 「时间」: what happened to the memories, and when — in two cards (spec §2, V4; R19 audit D C6).
 *
 *  1. **Each week, how much was noted, merged and forgotten** — stacked bars, which replace the 「成长」 line that drew the stock and
 *     under a heading that began on another day than its first point. The heading says what the bars add up to; the slider at the top
 *     of the card is the whole map's time window — the one entry for it on this view: moving it chooses `range`, and the other views,
 *     the lineages below and the list read the same window. A press on a week narrows the map to that week.
 *  2. **The lineages and the events** — one row for each understanding that was replaced and one for the account and each project,
 *     on the axis of the window the first card holds.
 *
 * Every word under a chart is a legend mark or a count; how to read the picture is not said.
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
  const end = axisEnd(doc.scope);
  const window = doc.scope.range.from ? { from: doc.scope.range.from, to: doc.scope.range.to } : null;
  const rows = useMemo(() => timeRows(doc.lanes, doc.events, projectName), [doc.lanes, doc.events, projectName]);
  const extent = useMemo(() => timeExtent({ since: doc.summary.since, lanes: doc.lanes, events: doc.events, today: end }, timeZone), [doc.summary.since, doc.lanes, doc.events, end, timeZone]);
  const from = useMemo(() => chartsFrom(extent.from, doc.events, timeZone), [extent.from, doc.events, timeZone]);
  const weeks = useMemo(() => weeklyChanges(doc.events, { from, to: end, timeZone }), [doc.events, from, end, timeZone]);
  // `now` is the end of the axis, so a version still in force runs to the edge.
  const now = useMemo(() => Date.parse(`${end}T23:59:59Z`), [end]);
  const totals = totalsOf(weeks);
  const counted = CHANGE_KINDS.some((kind) => totals[kind] > 0);

  /* The palette is read from the live document, so a theme flip is a reason to build an option again; the window is read by its days. */
  const bars = useMemo(() => (weeks.length === 0 ? null : weekOption({ weeks, window, palette: mapPalette(), formatDay: (day) => formatDay(day) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [weeks, window?.from, window?.to, scheme]);
  const lineage = useMemo(() => (rows.length === 0 ? null : timeOption({
    lanes: doc.lanes, events: doc.events, rows, extent, window, timeZone, now, palette: mapPalette(), formatDay: (iso) => formatDay(iso),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [doc.lanes, doc.events, rows, extent, window?.from, window?.to, timeZone, now, scheme]);

  // The slider reports many positions while it is dragged; the map is asked once it has settled.
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (settle.current) clearTimeout(settle.current); }, []);
  const byId = new Map(doc.events.map((event) => [event.id, event]));

  if (rows.length === 0 && !counted) {
    return <ChartCard level={2} title="记下的事" state="empty" emptyText={window ? "这段时间里没有记下的事。" : "还没有记下的事，时间线会在这里长出来。"} />;
  }

  // The legend names only what the picture has: an account that has replaced nothing has no bars and no grey, and says nothing of them.
  const hasLanes = doc.lanes.length > 0;
  const hasReplaced = doc.events.some((event) => event.change === "superseded");
  const hasConflict = doc.lanes.some((lane) => lane.segments.some((segment) => segment.conflict));
  const sentence = weeksSentence(weeks, { from, window, formatDay: (day) => formatDay(day) });
  const title = sentence ?? (window ? `${formatDay(window.from)}到${formatDay(window.to)}，没有记下、合并或忘记什么` : "还没有记下、合并或忘记什么");
  // Everything that happened — a statement written, replaced, forgotten, a way of working learned — and how many statements changed: the
  // bars above count the three things that make the account hold more or less, so these are not called 「记下的事」 and do not add up to them.
  const counts = `${doc.events.length} 次变化${hasLanes ? `，${doc.lanes.length} 条说法改过` : ""}`;
  const week = (index: unknown) => (typeof index === "number" ? weeks[index] : undefined);

  const barCard = (
    <ChartCard
      level={2}
      title={title}
      legend={CHANGE_KINDS.map((kind) => <LegendMark key={kind} shape="band" series={CHANGE_SERIES[kind]} color={CHANGE_VARS[kind]}>{CHANGE_NAMES[kind]}</LegendMark>)}
    >
      <MapChart
        kind="time-weeks" option={bars} height={260}
        on={{
          datazoom: (params: { start?: number; end?: number; batch?: Array<{ start?: number; end?: number }> }) => {
            if (settle.current) clearTimeout(settle.current);
            settle.current = setTimeout(() => {
              const next = windowOfWeeks(weeks, params, end);
              const asked = next ? `${next.from}..${next.to}` : "all";
              if (asked !== range) onRange(asked);
            }, 450);
          },
          // A week is a window of its own: pressing it narrows the map to those seven days, and pressing it again lets go.
          click: (params: { dataIndex?: number }) => {
            const picked = week(params?.dataIndex);
            if (!picked) return;
            const days = `${picked.start}..${picked.end > end ? end : picked.end}`;
            onRange(days === range ? "all" : days);
          },
        }}
        label={`每周记下、合并和忘记的数量：${title}，列表在下方。`}
        unpainted={`${title}。`}
      />
    </ChartCard>
  );
  const lineageCard = lineage && (
    <ChartCard
      level={2}
      title={counts}
      legend={(
        <>
          <span className="text-caption text-text-2">◆ 决定</span>
          <span className="text-caption text-text-2">✕ 纠正</span>
          <span className="text-caption text-text-2">▲ 学会一个做法</span>
          <span className="text-caption text-text-2">● 记下一条</span>
          {(hasLanes || hasReplaced) && <LegendMark shape="band" color="var(--chart-own)">一直成立</LegendMark>}
          {(hasLanes || hasReplaced) && <LegendMark shape="band" color="var(--chart-rival-2)">后来被替代</LegendMark>}
          {hasConflict && <LegendMark shape="band" color="var(--warn)">和另一条说法不一致</LegendMark>}
        </>
      )}
    >
      <MapChart
        kind="time" option={lineage} height={Math.max(160, 56 + rows.length * 34)}
        on={{
          click: (params: { seriesType?: string; data?: { eventId?: string; recordId?: string } }) => {
            const event = params?.data?.eventId ? byId.get(params.data.eventId) : undefined;
            if (event) onOpen(event.ref);
            else if (params?.data?.recordId) onOpen(`memory:${params.data.recordId}`);
          },
        }}
        label={`时间线：${counts}，列表在下方。`}
        unpainted={`${counts}。`}
      />
      <span className="sr-only">{`按 ${timeZone} 的日期`}</span>
    </ChartCard>
  );
  return (
    <ChartGrid rows={[
      [{ key: "weeks", span: 2, node: barCard }],
      ...(lineageCard ? [[{ key: "lineage", span: 2 as const, node: lineageCard }]] : []),
    ]} />
  );
}
