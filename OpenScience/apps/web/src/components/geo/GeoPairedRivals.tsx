import { Link, useLocation } from "react-router";
import { ChartCard } from "@/components/ui/ChartCard";
import { getGeoAnalysis, type GeoAnalysisRow, type GeoAnalysisValue } from "@/lib/geoAnalysisClient";
import type { GeoReadScope } from "@/lib/geoReadScope";
import { geoAnalysisSearch, geoFrozenAnalysisSearch } from "./geoAnalysisMode";
import { formatGeoValue } from "./GeoCellText";
import { useScopedGeoLoad } from "./geoProjectData";

const VIEW = { viewId: "V08", metricId: "M-16", dimension: "project" } as const;

/** Only the two readings calculated over one rival's exact eligible cohort form a pair. */
function pairedReading(row: GeoAnalysisRow, reference: string, digest: string) {
  const { entityName, entityLabel, entityKind, own, period, pool } = row.dimensions;
  const current = row.values.current;
  const ours = row.values.pairedOwn;
  if (own || entityKind !== "brand" || period !== "selected" || !entityName || !["P2", "P3"].includes(pool ?? "")) return null;
  if (current?.state !== "known" || ours?.state !== "known" || typeof current.value !== "number" || typeof ours.value !== "number"
    || !Number.isFinite(current.value) || !Number.isFinite(ours.value)) return null;
  const n = current.metric?.denominator;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 30 || n !== ours.metric?.denominator) return null;
  const bound = (value: GeoAnalysisValue, column: string) => {
    const members = value.members;
    return members && "rowKey" in members && members.exact === true && members.selectionRef === reference
      && members.expectedDigest === digest && members.rowKey === row.key && members.columnKey === column
      && members.unit === "answers" && members.total === n;
  };
  if (!bound(current, "current") || !bound(ours, "pairedOwn")) return null;
  const unknown = row.values.unknown?.value;
  return { key: row.key, name: entityLabel || `${entityName}（当前登记；历史名称未知）`, pool, ours: ours.value, rival: current.value, n,
    unknown: typeof unknown === "number" && Number.isSafeInteger(unknown) && unknown > 0 ? unknown : 0 };
}

/** Page only the same frozen selection and stop when the selected-interval rows end. */
async function readPairs(geoId: string, scope?: GeoReadScope) {
  let page = await getGeoAnalysis(geoId, scope, VIEW);
  const reference = page.selection?.reference, digest = page.digest;
  const pairs: NonNullable<ReturnType<typeof pairedReading>>[] = [];
  if (!reference || !digest) return { pairs, reference: null, incomplete: true, more: true };
  let offset = -1;
  for (let pages = 0; pages < 20; pages += 1) {
    if (page.selection?.reference !== reference || page.digest !== digest) throw new Error("所选数据已变化，请重试。");
    const rows = Array.isArray(page.rows) ? page.rows : [];
    if (reference && digest) for (const row of rows) {
      const pair = pairedReading(row, reference, digest);
      if (pair) pairs.push(pair);
    }
    const next = page.page?.nextOffset;
    const selectedEnded = rows.some(row => row.dimensions.period !== "selected");
    if (pairs.length >= 3 || selectedEnded || next == null) return { pairs: pairs.slice(0, 3), reference, incomplete: false, more: pairs.length > 3 || next != null };
    if (!Number.isSafeInteger(next) || next <= offset || !rows.length) return { pairs, reference, incomplete: true, more: true };
    offset = next;
    page = await getGeoAnalysis(geoId, { selectionRef: reference }, VIEW, offset, digest);
  }
  return { pairs, reference, incomplete: true, more: true };
}

/** The comparison keeps each rival paired with its own measured cohort instead of ranking unlike samples. */
export function GeoPairedRivals({ geoId }: { geoId: string }) {
  const location = useLocation();
  const comparison = useScopedGeoLoad(`visibility-rival-pairs:${geoId}`, (scope) => readPairs(geoId, scope));
  const result = comparison.state.kind === "ready" ? comparison.state.data : null;
  const pairs = result?.pairs ?? [];
  const loading = comparison.state.kind === "loading";
  const error = comparison.state.kind === "error" ? comparison.state.message : comparison.state.kind === "ready" ? comparison.state.refreshError : null;
  const search = result?.reference ? geoFrozenAnalysisSearch(location.search, VIEW, result.reference) : geoAnalysisSearch(location.search, VIEW);
  return <section aria-label="本品与竞品提及率" className="min-w-0">
    <ChartCard title="本品与竞品提及率" height={180}
      meta={<Link className="text-link hover:underline" to={{ pathname: location.pathname, search }}>查看全部竞品分析</Link>}
      state={loading ? "loading" : error && !pairs.length ? "error" : pairs.length ? "content" : "empty"}
      errorMessage={error ? `竞品比较暂时无法读取：${error}` : undefined} onRetry={comparison.reload}
      emptyText={result?.incomplete ? "当前页未找到可比读数，请在完整分析中继续查看。" : "当前范围暂无可比的竞品读数，可查看完整分析与原因。"}
      footnote={pairs.length ? "每组使用该竞品各自的合资格回答，不跨组排名；这些提及率与趋势图指标可能不同。" : undefined}>
      <ul className="divide-y divide-border" aria-label="同一回答范围内的竞品比较">
        {pairs.map(pair => <li key={pair.key} className="space-y-1 py-3 first:pt-0">
          <p className="text-ui font-semibold text-text">{pair.name} · {pair.pool === "P2" ? "品类问题" : "泛症状问题"}</p>
          <p className="text-ui tabular-nums text-text">本品 {formatGeoValue(pair.ours)} · 竞品 {formatGeoValue(pair.rival)}</p>
          <p className="text-caption text-text-3">{pair.n} 条合资格回答{pair.unknown > 0 ? ` · ${pair.unknown} 条历史依据未知` : ""}</p>
        </li>)}
      </ul>
      {result?.more && <p className="mt-2 text-caption text-text-3">更多记录可在完整分析中查看。</p>}
      {error && <p role="status" className="mt-2 text-caption text-text-3">更新未完成，仍显示上次结果。</p>}
    </ChartCard>
  </section>;
}
