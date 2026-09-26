import { useMemo } from "react";
import { getGeoMonitoring, readGeoCell, type GeoMonitoring, type GeoProject } from "@/lib/geoClient";
import { ChartCard, LegendMark } from "@/components/ui/ChartCard";
import { DataTable } from "@/components/ui/DataTable";
import { TrendChart } from "@/components/charts/TrendChart";
import { OWN_COLOR, rivalColor } from "@/components/charts/trendModel";
import { GeoCellText } from "../GeoCellText";
import { engineName, monthDay } from "../geoText";
import { signed } from "./geoTabText";
import { useGeoLoad } from "./geoTabKit";

/**
 * 「投了有没有用」, measured rather than asserted: the question groups we
 * placed articles for against the control groups we only watched, and the
 * difference between their movements.
 *
 * The control line is a grey, like every line that is not ours — the same rule
 * that keeps a rival out of the brand colour. A net effect inside the measured
 * fluctuation band is 「持平」 and carries no arrow: a programme that reports
 * two points of daily wobble as a win is worse than one that reports nothing.
 */
export function EffectSection({ project }: { project: GeoProject }) {
  const monitoring = useGeoLoad<GeoMonitoring>(`effect:${project.id}`, () => getGeoMonitoring(project.id));
  const data = monitoring.state.kind === "ready" ? monitoring.state.data : null;
  const arms = useMemo(() => ({
    pilot: Array.isArray(data?.arms?.pilot) ? data.arms.pilot : [],
    control: Array.isArray(data?.arms?.control) ? data.arms.control : [],
  }), [data]);
  const { pilot, control } = arms;
  const dates = useMemo(() => [...new Set([...arms.pilot, ...arms.control].map((point) => point.date))].sort(), [arms]);
  const at = (points: typeof pilot) => dates.map((date) => {
    const found = points.find((point) => point.date === date);
    return found && typeof found.value === "number" ? found.value : null;
  });
  const cell = readGeoCell(data?.arms?.netEffect);
  const band = typeof data?.arms?.netEffect?.noiseBand === "number" ? data.arms.netEffect.noiseBand : null;
  const flat = cell.status === "ok" && cell.value !== null && band !== null && Math.abs(cell.value) <= band;
  const net = cell.status !== "ok" || cell.value === null ? null : flat ? "持平" : signed(cell.value);
  const input = useMemo(() => ({
    labels: dates.map((date) => monthDay(date) ?? ""),
    own: { name: "投放的语义群", values: at(pilot) },
    rivals: [{ name: "对照组", values: at(control) }],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [dates, pilot, control]);

  const title = net === null
    ? "投放的效果还要等下一次复测"
    : flat
      ? "投放组和对照组目前还在波动范围内"
      : `投放的语义群比对照组${(cell.value ?? 0) > 0 ? "多涨" : "少涨"} ${Math.abs(Math.round(cell.value ?? 0))}`;

  return (
    <div className="flex flex-col gap-6">
      <ChartCard
        title={title}
        legend={(
          <>
            <LegendMark series="own" color={OWN_COLOR}>投放的语义群</LegendMark>
            <LegendMark series="rival-1" color={rivalColor(0)}>对照组</LegendMark>
          </>
        )}
        meta={band !== null ? `波动范围 ±${Math.round(band * 10) / 10}` : undefined}
        state={monitoring.state.kind === "loading" ? "loading"
          : monitoring.state.kind === "error" ? "error"
            : dates.length === 0 ? "empty" : "content"}
        emptyText="首批稿件上线后，这里会把投放的语义群和对照组放在一起比。"
        errorMessage={monitoring.state.kind === "error" ? monitoring.state.message : undefined}
        onRetry={monitoring.reload}
        height={220}
      >
        <div data-geo-arms="">
          <TrendChart input={input} label="投放与对照" height={220} />
          <p className="mt-2 text-ui text-text-2">
            净效应
            <span data-geo-net-effect={flat ? "flat" : cell.status} className="ml-2 font-medium tabular-nums text-text">
              {net ?? <GeoCellText cell={cell} unit="index" />}
            </span>
          </p>
        </div>
      </ChartCard>
      <Cited rows={data?.cited} />
    </div>
  );
}

/** The articles an engine has started quoting: the placement pipeline's last step. */
function Cited({ rows }: { rows: GeoMonitoring["cited"] | null | undefined }) {
  const byArticle = new Map<string, { title: string; engines: string[]; firstSeen: string }>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.articleId) continue;
    const entry = byArticle.get(row.articleId) ?? { title: row.title, engines: [], firstSeen: row.firstSeen };
    if (!entry.engines.includes(row.engine)) entry.engines.push(row.engine);
    if (row.firstSeen && (!entry.firstSeen || row.firstSeen < entry.firstSeen)) entry.firstSeen = row.firstSeen;
    byArticle.set(row.articleId, entry);
  }
  const list = [...byArticle.entries()].map(([id, article]) => ({ id, ...article }));
  if (list.length === 0) return null;
  return (
    <ChartCard title={`${list.length} 篇稿件已经被 AI 引用`}>
      <DataTable
        label="被 AI 引用的稿件"
        rows={list}
        rowKey={(row) => row.id}
        columns={[
          { key: "title", header: "稿件", rowHeader: true, cell: (row) => row.title || "未命名稿件" },
          { key: "engines", header: "引用它的引擎", cell: (row) => row.engines.map(engineName).join("、") },
          { key: "first", header: "首次被引", align: "right", width: "w-24", cell: (row) => monthDay(row.firstSeen) ?? "—" },
        ]}
      />
    </ChartCard>
  );
}
