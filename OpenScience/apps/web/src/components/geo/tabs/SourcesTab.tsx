import { useState } from "react";
import { Check, Minus, X } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import {
  getGeoSources,
  readGeoCell,
  setGeoTier,
  type GeoProject,
  type GeoSourceRow,
  type GeoSources,
  type GeoTier,
  type GeoTierId,
} from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { DataTable, InlineBar } from "@/components/ui/DataTable";
import { Disclosure } from "@/components/ui/Disclosure";
import { FilterChips, type FilterOption } from "@/components/ui/FilterChips";
import { Tag } from "@/components/ui/Tag";
import { formatGeoValue } from "../GeoCellText";
import { engineName, GEO_POOL_KINDS, GEO_SOURCE_LAYER_WORDS } from "../geoText";
import { MENTION_ONLY_WORD, mentionOnly, metricName, metricUnit, sourceKindWord, yuan } from "./geoTabText";
import { CellLink, FilterRow, StepPending, TabError, TabSection, TabSkeleton, TD, TH, useGeoLoad } from "./geoTabKit";

const TIER_WORDS: Readonly<Record<GeoTierId, string>> = Object.freeze({ "1": "档一", "2": "档二", "3": "档三" });
const TIERS: readonly GeoTierId[] = ["1", "2", "3"];

/**
 * 信源 (plan §3.5, mockup g08): who the engines cite, whether each site meets
 * the three conditions (ICP owner matches, news-grade indexed, medical), what
 * it says about us and what a placement there costs; per engine, what this
 * coverage window can be expected to change; the main battlefield; and the
 * three target tiers, with the switch that chooses one.
 */
export function SourcesTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const { state, reload } = useGeoLoad(`sources:${geoId}`, () => getGeoSources(geoId));
  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const sources = (Array.isArray(data?.sources) ? data.sources : []).filter((source) => source && source.domain);
  const expectations = (Array.isArray(data?.expectations) ? data.expectations : []).filter((row) => row && row.engine);
  const tiers = (Array.isArray(data?.tiers) ? data.tiers : []).filter((tier) => tier && TIERS.includes(tier.tier));
  if (sources.length === 0 && expectations.length === 0 && tiers.length === 0) {
    return <StepPending geoId={geoId} project={project} step="sources" />;
  }
  return (
    <div data-geo-tab="sources">
      {sources.length > 0 && <SourceTable sources={sources} engines={project.engines} />}
      {expectations.length > 0 && <Expectations geoId={geoId} rows={expectations} />}
      {data.battlefield && (data.battlefield.groups?.length || data.battlefield.reason) && <Battlefield battlefield={data.battlefield} />}
      {tiers.length > 0 && <Tiers geoId={geoId} tiers={tiers} chosen={data.chosenTier ?? project.tier ?? null} onChanged={reload} />}
    </div>
  );
}

function citedCount(source: GeoSourceRow, engine: string): number {
  const cited = source.cited && typeof source.cited === "object" ? source.cited : {};
  if (engine !== "all") return typeof cited[engine] === "number" ? cited[engine] : 0;
  return Object.values(cited).reduce((sum, count) => sum + (typeof count === "number" ? count : 0), 0);
}

function SourceTable({ sources, engines }: { sources: GeoSourceRow[]; engines: string[] }) {
  const [engine, setEngine] = useState("all");
  const cited = new Set(sources.flatMap((source) => Object.keys(source.cited ?? {})));
  const listed = [...engines.filter((key) => cited.has(key)), ...[...cited].filter((key) => !engines.includes(key))];
  const options: FilterOption<string>[] = [
    { value: "all", label: "全部引擎" },
    ...listed.map((key) => ({ value: key, label: engineName(key) })),
  ];
  const impostors = sources.filter((source) => source.impostor);
  const rows = sources
    .filter((source) => !source.impostor && (engine === "all" || citedCount(source, engine) > 0))
    .sort((a, b) => citedCount(b, engine) - citedCount(a, engine));
  const top = rows.reduce((max, source) => Math.max(max, citedCount(source, engine)), 0);

  return (
    <section aria-label="信源">
      <FilterRow summary={impostors.length > 0 ? `已排除 ${impostors.length} 个冒名站` : undefined}>
        <FilterChips
          label="引擎"
          options={options}
          value={options.some((option) => option.value === engine) ? engine : "all"}
          onChange={setEngine}
        />
      </FilterRow>
      <DataTable
        className="mt-3"
        label="信源"
        minWidth="min-w-[44rem]"
        rows={rows}
        rowKey={(source) => source.id || source.domain}
        rowAttrs={(source) => ({ "data-geo-source": source.domain })}
        columns={[
          {
            key: "source",
            header: "信源",
            rowHeader: true,
            // The reader's name for the site, and the domain under it — never
            // the row's internal id, which means nothing to anyone.
            cell: (source) => (
              <>
                <span className="block">{source.name || source.domain}</span>
                {source.name && <span className="block text-caption text-text-3">{source.domain}</span>}
              </>
            ),
          },
          {
            key: "kind",
            header: "类型",
            cell: (source) => { const word = sourceKindWord(source.kind); return word ? <Tag>{word}</Tag> : "—"; },
            isEmpty: (source) => !sourceKindWord(source.kind),
          },
          {
            key: "conditions",
            header: "三条件",
            cell: (source) => <Conditions conditions={source.conditions} />,
            isEmpty: (source) => CONDITION_WORDS.every(({ key }) => source.conditions?.[key] == null),
          },
          {
            key: "bar",
            header: "",
            width: "w-24",
            cell: (source) => <InlineBar value={citedCount(source, engine)} max={top} tone="quiet" label={`${source.name || source.domain} 被引用的次数`} />,
            isEmpty: (source) => citedCount(source, engine) === 0,
          },
          {
            key: "cited",
            header: "被引用",
            align: "right",
            width: "w-20",
            cell: (source) => citedCount(source, engine),
            isEmpty: (source) => citedCount(source, engine) === 0,
          },
          {
            key: "relation",
            header: "和你的关系",
            cell: (source) => <Relation source={source} />,
            isEmpty: (source) => source.wrongOurs === 0 && source.mentionsOurs === 0,
          },
          {
            key: "layer",
            header: "布局",
            cell: (source) => (source.layer ? GEO_SOURCE_LAYER_WORDS[source.layer] ?? "—" : "—"),
            isEmpty: (source) => !source.layer,
          },
          {
            key: "price",
            header: "单篇价格",
            align: "right",
            width: "w-24",
            cell: (source) => (source.market && typeof source.market.price === "number" ? yuan(source.market.price) : "—"),
            isEmpty: (source) => !source.market || typeof source.market.price !== "number",
          },
        ]}
      />
      {impostors.length > 0 && (
        <Disclosure summary="冒名站" className="mt-4">
          <ul className="flex flex-col gap-1">
            {impostors.map((source) => (
              <li key={source.id || source.domain} className="text-ui text-text-2">
                {source.name ? `${source.name} · ${source.domain}` : source.domain}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </section>
  );
}

const CONDITION_WORDS: Array<{ key: keyof GeoSourceRow["conditions"]; label: string }> = [
  { key: "icp", label: "备案" },
  { key: "newsIndexed", label: "新闻源" },
  { key: "medical", label: "医疗" },
];

/** The three conditions, each said with a shape and a word: 「备案 ✓ 新闻源 ✓ 医疗 ✗」. */
function Conditions({ conditions }: { conditions: GeoSourceRow["conditions"] | null | undefined }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {CONDITION_WORDS.map(({ key, label }) => {
        const value = conditions?.[key];
        const Icon = value === true ? Check : value === false ? X : Minus;
        const word = value === true ? "满足" : value === false ? "不满足" : "未核实";
        return (
          <span key={key} data-geo-condition={`${key}:${value === true ? "yes" : value === false ? "no" : "unknown"}`} className="inline-flex items-center gap-0.5 text-caption text-text-2">
            {label}
            <Icon size={16} aria-hidden="true" className={value === true ? "text-accent" : "text-text-3"} />
            <span className="sr-only">{word}</span>
          </span>
        );
      })}
    </span>
  );
}

function Relation({ source }: { source: GeoSourceRow }) {
  const parts: Array<{ text: string; wrong?: boolean }> = [];
  if (source.wrongOurs > 0) parts.push({ text: `有 ${source.wrongOurs} 处讲错`, wrong: true });
  if (source.mentionsOurs > 0) parts.push({ text: `提到你 ${source.mentionsOurs} 次` });
  if (parts.length === 0) return <span className="text-text-3">—</span>;
  return (
    <span className="flex flex-col">
      {parts.map((part) => <span key={part.text} className={part.wrong ? "text-danger" : undefined}>{part.text}</span>)}
    </span>
  );
}

function Expectations({ geoId, rows }: { geoId: string; rows: GeoSources["expectations"] }) {
  return (
    <TabSection title="预期匹配" className="mt-10">
      <div className="overflow-x-auto">
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
      </div>
    </TabSection>
  );
}

function Battlefield({ battlefield }: { battlefield: NonNullable<GeoSources["battlefield"]> }) {
  const groups = (Array.isArray(battlefield.groups) ? battlefield.groups : []).filter((group) => typeof group === "string" && group);
  return (
    <TabSection title="主战场">
      {groups.length > 0 && <p className="text-ui text-text">{groups.join("、")}</p>}
      {battlefield.reason && <p className="mt-1 max-w-measure text-ui text-text-2">{battlefield.reason}</p>}
    </TabSection>
  );
}

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

function Tiers({ geoId, tiers, chosen, onChanged }: { geoId: string; tiers: GeoTier[]; chosen: GeoTierId | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const byId = new Map(tiers.map((tier) => [tier.tier, tier]));
  const present = TIERS.filter((tier) => byId.has(tier));
  const rows = targetRows(tiers);
  const value = (number: number | null | undefined, unit: TargetRow["unit"]) => (typeof number === "number" && Number.isFinite(number) ? formatGeoValue(number, unit) : "—");
  const choose = (tier: GeoTierId) => {
    if (busy || tier === chosen) return;
    setBusy(true);
    void setGeoTier(geoId, tier)
      .then(() => {
        toast.success(`已选${TIER_WORDS[tier]}，之后按这一档写稿和投放。`);
        onChanged();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "没有改成功，请稍后重试。" })))
      .finally(() => setBusy(false));
  };
  const header = (tier: GeoTierId) => (tier === chosen ? `${TIER_WORDS[tier]}（已选）` : TIER_WORDS[tier]);

  return (
    <TabSection title="预期达标">
      <FilterChips
        label="目标档位"
        options={present.map((tier) => ({ value: tier, label: TIER_WORDS[tier] }))}
        value={chosen && present.includes(chosen) ? chosen : present[0]}
        onChange={choose}
      />
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse" aria-busy={busy || undefined}>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={`${TH} sticky left-0 bg-bg`}>指标</th>
              <th scope="col" className={`${TH} text-right`}>现状</th>
              {present.map((tier) => (
                <th key={tier} scope="col" className={cn(TH, "text-right", tier === chosen && "font-medium text-text")}>{header(tier)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-faint">
                <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>{row.name}</th>
                <td className={`${TD} text-right tabular-nums`}>{value(row.baseline, row.unit)}</td>
                {present.map((tier) => (
                  <td key={tier} className={cn(TD, "text-right tabular-nums", tier === chosen && "font-medium")}>{value(row.byTier[tier], row.unit)}</td>
                ))}
              </tr>
            ))}
            <tr className="border-b border-faint">
              <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>投放篇数</th>
              <td className={`${TD} text-right`}>—</td>
              {present.map((tier) => {
                const placements = byId.get(tier)?.placements;
                return <td key={tier} className={cn(TD, "text-right tabular-nums", tier === chosen && "font-medium")}>{typeof placements === "number" ? `${placements} 篇` : "—"}</td>;
              })}
            </tr>
            <tr className="border-b border-faint">
              <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>预算</th>
              <td className={`${TD} text-right`}>—</td>
              {present.map((tier) => (
                <td key={tier} className={cn(TD, "text-right tabular-nums", tier === chosen && "font-medium")}>{yuan(byId.get(tier)?.budgetCny)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </TabSection>
  );
}
