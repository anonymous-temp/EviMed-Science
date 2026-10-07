import { useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { readGeoCell, setGeoTier, type GeoSources, type GeoTier, type GeoTierId } from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { FilterChips } from "@/components/ui/FilterChips";
import { ScrollRegion } from "@/components/ui/ScrollRegion";
import { formatGeoValue } from "../GeoCellText";
import { engineName, GEO_POOL_KINDS, GEO_SOURCE_LAYER_WORDS } from "../geoText";
import { MENTION_ONLY_WORD, mentionOnly, metricName, metricUnit, sourceKindWord, yuan } from "./geoTabText";
import { CellLink, TabSection, TD, TH } from "./geoTabKit";

/**
 * What 方案 says about where the work goes and what it is meant to reach: the target tier (chosen here) with its numbers, the
 * main battlefield, and what each engine can be expected to do in this coverage window. These sat at the bottom of 信源, a page
 * of 1,000 rows; they are the plan, not a fact about a site.
 */

export const TIER_WORDS: Readonly<Record<GeoTierId, string>> = Object.freeze({ "1": "档一", "2": "档二", "3": "档三" });
const TIERS: readonly GeoTierId[] = ["1", "2", "3"];

/** The metrics a sentence about a tier names, in the overview's order. A target on one pool alone is not the project's. */
const HEADLINE_TARGETS: readonly string[] = ["M-19", "M-01S", "M-06", "M-08"];

interface TargetRow {
  key: string;
  name: string;
  unit: ReturnType<typeof metricUnit>;
  baseline: number | null;
  byTier: Partial<Record<GeoTierId, number | null>>;
}

/** One row per metric and pool, across the three tiers; a metric this page cannot name is left out. */
function targetRows(tiers: GeoTier[]): TargetRow[] {
  const rows = new Map<string, TargetRow>();
  for (const tier of tiers) {
    for (const target of Array.isArray(tier.targets) ? tier.targets : []) {
      const base = metricName(target?.metricId);
      if (!base) continue;
      const key = `${target.metricId}|${target.pool ?? ""}`;
      const pool = target.pool && target.pool in GEO_POOL_KINDS ? GEO_POOL_KINDS[target.pool] : null;
      const row = rows.get(key) ?? {
        key,
        name: pool ? `${base}（${pool}）` : base,
        unit: metricUnit(target.metricId),
        baseline: null,
        byTier: {},
      };
      if (row.baseline === null && typeof target.baseline === "number") row.baseline = target.baseline;
      row.byTier[tier.tier] = typeof target.target === "number" ? target.target : null;
      rows.set(key, row);
    }
  }
  return [...rows.values()];
}

/** “档二：综合可见度指数 55，事实准确率 98%” — the chosen tier with the numbers it stands for; null when it has none. */
export function tierSentence(tier: GeoTier | undefined): string | null {
  if (!tier) return null;
  const parts = HEADLINE_TARGETS.flatMap((metricId) => {
    const target = (Array.isArray(tier.targets) ? tier.targets : []).find((row) => row?.metricId === metricId && (row.pool == null || (row.pool as string) === "all"));
    const name = metricName(metricId);
    return name && target && typeof target.target === "number" ? [`${name} ${formatGeoValue(target.target, metricUnit(metricId))}`] : [];
  });
  return parts.length ? `${TIER_WORDS[tier.tier]}：${parts.join("，")}` : null;
}

export function Targets({ geoId, tiers, chosen, onChanged }: { geoId: string; tiers: GeoTier[]; chosen: GeoTierId | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const byId = new Map(tiers.map((tier) => [tier.tier, tier]));
  const present = TIERS.filter((tier) => byId.has(tier));
  const rows = targetRows(tiers);
  const picked = chosen && present.includes(chosen) ? chosen : present[0];
  const sentence = tierSentence(byId.get(picked));
  const value = (number: number | null | undefined, unit: TargetRow["unit"]) => (typeof number === "number" && Number.isFinite(number) ? formatGeoValue(number, unit) : "—");
  const choose = (tier: GeoTierId) => {
    if (busy || tier === chosen) return;
    setBusy(true);
    void setGeoTier(geoId, tier)
      .then(() => {
        toast.success(`已选${TIER_WORDS[tier]}，之后按这一档写稿和投放。`);
        onChanged();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "目标档位无法修改，请稍后重试。" })))
      .finally(() => setBusy(false));
  };
  const header = (tier: GeoTierId) => (tier === chosen ? `${TIER_WORDS[tier]}（已选）` : TIER_WORDS[tier]);

  return (
    <TabSection title="目标" level="ui">
      <FilterChips
        label="目标档位"
        options={present.map((tier) => ({ value: tier, label: TIER_WORDS[tier] }))}
        value={picked}
        onChange={choose}
      />
      {sentence && <p data-geo-tier-line="" className="mt-3 max-w-measure text-ui text-text">{sentence}</p>}
      <ScrollRegion label="各档目标" className="relative mt-3">
        <table className="w-full min-w-[36rem] border-collapse" aria-busy={busy || undefined}>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={`${TH} sticky left-0 bg-bg`}>指标</th>
              <th scope="col" className={`${TH} text-right`}>现状</th>
              {present.map((tier) => (
                <th key={tier} scope="col" className={cn(TH, "text-right", tier === chosen && "text-text")}>{header(tier)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-faint">
                <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>{row.name}</th>
                <td className={`${TD} text-right tabular-nums`}>{value(row.baseline, row.unit)}</td>
                {present.map((tier) => (
                  <td key={tier} className={cn(TD, "text-right tabular-nums", tier !== chosen && "text-text-2")}>{value(row.byTier[tier], row.unit)}</td>
                ))}
              </tr>
            ))}
            <tr className="border-b border-faint">
              <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>投放篇数</th>
              <td className={`${TD} text-right`}>—</td>
              {present.map((tier) => {
                const placements = byId.get(tier)?.placements;
                return <td key={tier} className={cn(TD, "text-right tabular-nums", tier !== chosen && "text-text-2")}>{typeof placements === "number" ? `${placements} 篇` : "—"}</td>;
              })}
            </tr>
            <tr className="border-b border-faint">
              <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>预算</th>
              <td className={`${TD} text-right`}>—</td>
              {present.map((tier) => (
                <td key={tier} className={cn(TD, "text-right tabular-nums", tier !== chosen && "text-text-2")}>{yuan(byId.get(tier)?.budgetCny)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </ScrollRegion>
    </TabSection>
  );
}

/** The main battlefield — by the groups' names — and each engine's expectation for this window. */
export function Layout({ geoId, battlefield, expectations }: { geoId: string; battlefield: GeoSources["battlefield"]; expectations: GeoSources["expectations"] }) {
  // The names the server resolved. `groups` is what the run wrote — a group's id or its name — so it only stands in, minus any id,
  // for a server that does not send names yet: an id is never printed.
  const written = Array.isArray(battlefield?.groups) ? battlefield.groups.filter((group) => !/^ggr_/.test(group)) : [];
  const names = (Array.isArray(battlefield?.groupNames) ? battlefield.groupNames : written).filter((group) => typeof group === "string" && group);
  const reason = battlefield?.reason || null;
  if (names.length === 0 && !reason && expectations.length === 0) return null;
  return (
    <TabSection title="布局" level="ui">
      {(names.length > 0 || reason) && (
        <div data-geo-battlefield="">
          <h3 className="text-caption text-text-3">主战场</h3>
          {names.length > 0 && <p className="mt-1 text-ui text-text">{names.join("、")}</p>}
          {reason && <p className="mt-1 max-w-measure text-ui text-text-2">{reason}</p>}
        </div>
      )}
      {expectations.length > 0 && (
        <div className={names.length > 0 || reason ? "mt-6" : undefined}>
          <h3 className="text-caption text-text-3">各引擎的预期</h3>
          <Expectations geoId={geoId} rows={expectations} />
        </div>
      )}
    </TabSection>
  );
}

function Expectations({ geoId, rows }: { geoId: string; rows: GeoSources["expectations"] }) {
  return (
    <ScrollRegion label="各引擎的预期" className="relative mt-1">
      <table className="w-full min-w-[40rem] border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={`${TH} sticky left-0 bg-bg`}>AI 引擎</th>
            <th scope="col" className={`${TH} text-right`}>检索触发率</th>
            <th scope="col" className={TH}>投哪一层</th>
            <th scope="col" className={TH}>这个周期能做到</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cell = readGeoCell(row.retrieval);
            const only = mentionOnly(row.engine);
            const layers = (Array.isArray(row.layers) ? row.layers : [])
              .map((layer) => GEO_SOURCE_LAYER_WORDS[layer as keyof typeof GEO_SOURCE_LAYER_WORDS] ?? sourceKindWord(layer))
              .filter(Boolean);
            return (
              <tr key={row.engine} data-geo-expectation={row.engine} className="border-b border-faint">
                <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>{engineName(row.engine)}</th>
                <td className={`${TD} text-right`}>
                  {only
                    ? <span className="text-text-3">{MENTION_ONLY_WORD}</span>
                    : <CellLink geoId={geoId} cell={cell} className="inline-flex justify-end" label={`${engineName(row.engine)}的检索触发率`} />}
                </td>
                <td className={TD}>{layers.length ? layers.join(" + ") : "—"}</td>
                <td className={`${TD} max-w-measure`}>{row.promise || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
