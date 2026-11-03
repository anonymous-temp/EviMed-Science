import { useMemo } from "react";
import type { GeoDiagnosis, GeoProject, GeoStrategyView } from "@/lib/geoClient";
import { Delta } from "@/components/ui/Delta";
import { BulletBar, StatBand, StatTile } from "@/components/ui/StatTile";
import { GeoSparkline } from "./GeoSparkline";
import { formatGeoValue } from "./GeoCellText";
import { denominatorLine, overviewCoverageNotice, overviewTiles, type MetricTriple } from "./geoOverviewModel";
import type { GeoLoadResult } from "./geoProjectData";
import { monthDay } from "./geoText";
import { geoTabPath } from "./geoTabs";
import { useGeoPath } from "./useGeoPath";

/** One authoritative rendering of baseline, current values and target, with their measurement scope. */
export function GeoOverviewMetrics({ geoId, project, diagnosis, strategy, compact = false }: { geoId: string; project: GeoProject; diagnosis: GeoLoadResult<GeoDiagnosis>; strategy: GeoLoadResult<GeoStrategyView>; compact?: boolean }) {
  const path = useGeoPath();
  const diag = diagnosis.state.kind === "ready" ? diagnosis.state.data : null;
  const plan = strategy.state.kind === "ready" ? strategy.state.data : null;
  const tiles = useMemo(() => overviewTiles(project, diag, plan), [project, diag, plan]);
  const denominator = denominatorLine(project, diag);
  const cells = tiles.length + 1;
  return (
      <StatBand
        label="本轮指标"
        // The denominator, and — when the engines, the questions or the surface changed since the last round — the plain statement that
        // the tiles' changes are not compared (R14 N-4); the same sentence the headline and the chart say.
        footnote={[denominator, overviewCoverageNotice(project)].filter(Boolean).join(" · ") || null}
        columns={cells >= 6 ? 6 : cells === 5 ? 5 : 4}
        className={cells > 6 ? "xl:[&>div]:grid-cols-7" : undefined}
      >
        {tiles.map((tile) => (
          <StatTile
            key={tile.key}
            label={tile.label}
            valueSize={compact ? "section" : "metric"}
            // A diagnosis that was not read is said once in the tile (the word) and once with its reason and 重试 below the band: a tile that
            // carried the message and a retry of its own repeated both.
            reading={tile.key === "safety" && diagnosis.state.kind === "loading" ? { kind: "loading" } : tile.key === "safety" && diagnosis.state.kind === "error" ? { kind: "unmeasured", reason: "读取失败" } : tile.reading}
            renderMeasured={() => tile.value}
            hint={tile.hint}
            lead={tile.lead}
            rank={tile.rank ?? undefined}
            tone={tile.tone}
            to={tile.tab ? path(geoTabPath(geoId, tile.tab)) : undefined}
            delta={<Delta value={tile.delta} unit={tile.key === "gvi" ? "index" : "point"} polarity={tile.polarity} />}
            note={tile.triple ? undefined : tile.note}
            className={tile.lead ? "sm:col-span-2" : undefined}
            chart={(
              <>
                {tile.lead
                  ? (
                    <BulletBar
                      label={tile.label}
                      value={tile.reading.kind === "measured" ? tile.reading.value : null}
                      target={tile.target}
                      targetLabel={tile.target === null ? undefined : `目标 ${formatGeoValue(tile.target, "index")}`}
                      // The rival's reading is a mention rate, not an index: it is
                      // named under the bar, never placed on its scale.
                      rivalLabel={tile.rival ?? undefined}
                    />
                  )
                  // A tile that reads 「样本不足」 draws no line: the words and a falling line would say two things.
                  : !tile.placeholder && tile.trend.some((value) => value !== null)
                    ? <GeoSparkline values={tile.trend} target={tile.target} width={140} height={28} className="w-full" />
                    : null}
                {tile.triple && !tile.placeholder && <TripleLine triple={tile.triple} unit={tile.key === "gvi" ? "index" : "percent"} />}
              </>
            )}
          />
        ))}
      </StatBand>
  );
}

function TripleLine({ triple, unit }: { triple: MetricTriple; unit: "index" | "percent" }) {
  const base = triple.baseline ? `基线 ${formatGeoValue(triple.baseline.value, unit)}${triple.baseline.date ? ` · ${monthDay(triple.baseline.date)}` : ""}` : null;
  const target = triple.target === null ? null
    : triple.reached ? `已达到目标 ${formatGeoValue(triple.target, unit)}`
      : `目标 ${formatGeoValue(triple.target, unit)}${triple.dueAt ? ` · ${monthDay(triple.dueAt)}前` : ""}`;
  if (!base && !target) return null;
  return (
    <p data-geo-triple="" className="mt-2 flex flex-wrap items-baseline gap-x-1.5 text-caption tabular-nums text-text-3">
      {base && <span>{base}</span>}
      {base && target && <span aria-hidden="true">→</span>}
      {target && <span className={triple.reached ? "text-accent" : undefined}>{target}</span>}
    </p>
  );
}
