import { Fragment, useState } from "react";
import { Link } from "react-router";
import { Check } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import {
  setGeoTier,
  skipGeoAction,
  type GeoProject,
  type GeoStrategyEngine,
  type GeoStrategyTargetRow,
  type GeoStrategyView,
  type GeoTierId,
} from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { Disclosure } from "@/components/ui/Disclosure";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { BulletBar } from "@/components/ui/StatTile";
import { Tag } from "@/components/ui/Tag";
import { formatGeoValue, GeoCellText } from "../GeoCellText";
import { useGeoFrame } from "../geoFrame";
import { geoDestinationPath, geoSectionId } from "../geoTabs";
import {
  engineName,
  GEO_ASSUMPTION_BASIS_WORDS,
  GEO_POOL_KINDS,
  GEO_PROMISE_CEILING_WORDS,
  GEO_SOURCE_LAYER_WORDS,
  monthDay,
  type GeoUnit,
} from "../geoText";
import { MENTION_ONLY_WORD, mentionOnly, sourceKindWord, yuan } from "./geoTabText";
import { useOpenGeoConversation } from "../useOpenGeoConversation";

/**
 * What 方案 says: where the work goes and what it is meant to reach — the strategy and the targets, from `GET …/strategy`, the
 * page's one read (R19 audit C §2.3). Five blocks, in the order a reader asks:
 *
 *  1. **目标** — three tiers as three columns whose header is the choice (「选这一档」: it writes the project, which a row of chips
 *     looked like a filter and was not), each head metric as where it began, where it is and where this tier puts it;
 *  2. **战场** — the main battlefield, the secondary ones and what is not worth doing, each with its reason and its groups;
 *  3. **各引擎能承诺什么** — what each engine's retrieval lets the plan promise, where to place and what account that needs;
 *  4. **需要你做的** — what the strategy asks the client to do outside the platform;
 *  5. **假设** — what the plan took as given, one line each.
 *
 * The project's measurement settings — engines, cadence, budget, who speaks for the product, members — are not here: they are the
 * header's 「项目设置」.
 */

export const TIER_WORDS: Readonly<Record<GeoTierId, string>> = Object.freeze({ "1": "档一", "2": "档二", "3": "档三" });

/** The metrics a tier is told by: the overview's four, over the whole project. A target on one pool alone is a row of the table. */
const HEAD_METRICS: readonly string[] = ["M-19", "M-01S", "M-06", "M-08"];

function unitOf(row: GeoStrategyTargetRow): GeoUnit {
  return row.unit === "index" ? "index" : row.unit === "count" ? "count" : "percent";
}

/** The row's name as a reader says it: the metric's, and the pool it is over when it is not the whole project. */
export function targetRowName(row: GeoStrategyTargetRow): string {
  const pool = row.pool !== "all" && row.pool in GEO_POOL_KINDS ? GEO_POOL_KINDS[row.pool] : null;
  return pool ? `${row.name}（${pool}）` : row.name;
}

/** The head metrics of a plan, over the whole project; where the plan names none of them, the rows over the whole project. */
export function headRows(rows: readonly GeoStrategyTargetRow[]): GeoStrategyTargetRow[] {
  const head = rows.filter((row) => HEAD_METRICS.includes(row.metricId) && row.pool === "all");
  if (head.length > 0) return head.sort((a, b) => HEAD_METRICS.indexOf(a.metricId) - HEAD_METRICS.indexOf(b.metricId));
  const whole = rows.filter((row) => row.pool === "all");
  return whole.length > 0 ? whole : rows.slice(0, 4);
}

/** 「档二：…」 — the run's name for the tier, which already says its number; else the number alone. */
function tierTitle(tier: GeoTierId, name: string | null): string {
  if (!name) return TIER_WORDS[tier];
  return /^档[一二三]/.test(name) ? name : `${TIER_WORDS[tier]}：${name}`;
}

/** The day a target falls due: the baseline round's day and the weeks the plan gives it. */
function dueDay(baselineDay: string | null | undefined, weeks: number | null | undefined): string | null {
  if (!baselineDay || typeof weeks !== "number" || !Number.isFinite(weeks)) return null;
  const start = Date.parse(`${baselineDay}T00:00:00Z`);
  return Number.isNaN(start) ? null : new Date(start + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ targets */

export function Targets({ geoId, plan, onChosen }: { geoId: string; plan: GeoStrategyView; onChosen: () => void }) {
  const frame = useGeoFrame();
  const [busy, setBusy] = useState<GeoTierId | null>(null);
  const tiers = plan.tiers.filter((tier) => tier.tier === "1" || tier.tier === "2" || tier.tier === "3");
  if (tiers.length === 0) return null;
  const head = headRows(plan.targets.rows);
  const baselineDay = plan.targets.baselineRound?.sampleDate ?? null;
  const mayChoose = !frame?.project.access || frame.project.access.abilities.includes("edit");
  const choose = (tier: GeoTierId) => {
    if (busy) return;
    setBusy(tier);
    void setGeoTier(geoId, tier)
      .then(() => {
        toast.success(`已选${TIER_WORDS[tier]}，之后按这一档写稿和投放。`);
        onChosen();
        frame?.reload();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "目标档位无法修改，请稍后重试。" })))
      .finally(() => setBusy(null));
  };
  // The pools' own rows, and the metrics beyond the head, are a table behind the columns: a reader needs them to check, not to choose.
  const rest = plan.targets.rows.filter((row) => !head.includes(row));

  return (
    <div id={geoSectionId("targets")}>
      <Section title="目标" className="mt-0">
        <div data-geo-tiers="" className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {tiers.map((tier) => {
            const chosen = tier.tier === plan.chosenTier;
            return (
              <article
                key={tier.tier}
                data-geo-tier={tier.tier}
                aria-current={chosen ? "true" : undefined}
                className={cn("flex min-w-0 flex-col rounded-card border p-4", chosen ? "border-accent bg-accent-soft" : "border-border bg-surface")}
              >
                <header className="flex items-start justify-between gap-3">
                  <h3 className="min-w-0 text-ui font-semibold text-text">{tierTitle(tier.tier, tier.name)}</h3>
                  {chosen ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-ui font-semibold text-accent">
                      <Check size={16} aria-hidden="true" />
                      这一档
                    </span>
                  ) : mayChoose ? (
                    <Button variant="secondary" size="sm" className="shrink-0" loading={busy === tier.tier} onClick={() => choose(tier.tier)}>
                      选这一档
                    </Button>
                  ) : null}
                </header>
                {tier.summary && <p className="mt-2 text-ui text-text-2">{tier.summary}</p>}
                <ul className="mt-4 flex flex-col gap-4">
                  {head.map((row) => (
                    <TargetBarRow key={`${row.metricId}|${row.pool}`} row={row} tier={tier.tier} baselineDay={baselineDay} latestDay={plan.targets.latestRound?.sampleDate ?? null} />
                  ))}
                </ul>
                <p className="mt-4 text-caption tabular-nums text-text-3">
                  {[
                    tier.contentUnits != null ? `${tier.contentUnits} 篇稿件` : null,
                    typeof tier.placements === "number" ? `${tier.placements} 个投放位` : null,
                    typeof tier.budgetCny === "number" ? `预算 ${yuan(tier.budgetCny)}` : null,
                  ].filter(Boolean).join(" · ")}
                </p>
                {tier.buys && <p className="mt-2 text-caption text-text-3">{tier.buys}</p>}
                {tier.notPromised.length > 0 && (
                  <ul aria-label="不承诺的" className="mt-2 flex flex-col gap-0.5 text-caption text-text-3">
                    {tier.notPromised.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
        {rest.length > 0 && (
          <Disclosure summary="各问句池和其余指标的目标" className="mt-3">
            <DataTable<GeoStrategyTargetRow>
              label="各档目标"
              rows={rest}
              rowKey={(row) => `${row.metricId}|${row.pool}`}
              columns={[
                { key: "name", header: "指标", rowHeader: true, cell: (row) => targetRowName(row) },
                { key: "baseline", header: "基线", align: "right", cell: (row) => <GeoCellText cell={row.baseline} unit={unitOf(row)} hideSample /> },
                { key: "latest", header: "现在", align: "right", cell: (row) => <GeoCellText cell={row.latest} unit={unitOf(row)} hideSample /> },
                ...tiers.map((tier) => ({
                  key: `tier-${tier.tier}`,
                  header: tier.tier === plan.chosenTier ? `${TIER_WORDS[tier.tier]}（已选）` : TIER_WORDS[tier.tier],
                  align: "right" as const,
                  cell: (row: GeoStrategyTargetRow) => {
                    const target = row.tiers[tier.tier]?.target;
                    return typeof target === "number" ? formatGeoValue(target, unitOf(row)) : "—";
                  },
                })),
              ]}
            />
          </Disclosure>
        )}
      </Section>
    </div>
  );
}

/** One head metric in one tier's column: this tier's target, and where the reading stands against it, from where it began. */
function TargetBarRow({ row, tier, baselineDay, latestDay }: { row: GeoStrategyTargetRow; tier: GeoTierId; baselineDay: string | null; latestDay: string | null }) {
  const unit = unitOf(row);
  const target = row.tiers[tier]?.target ?? null;
  const baseline = row.baseline?.status === "ok" ? row.baseline.value : null;
  const latest = row.latest?.status === "ok" ? row.latest.value : null;
  const due = dueDay(baselineDay, row.tiers[tier]?.horizonWeeks);
  const scaled = unit === "percent" || unit === "index";
  // A target the reading has already passed is not a deadline any more: 「12% 12月18日前」 beside a bar at 21% read as the page
  // contradicting itself. Said the way 总览 says it (the head metrics are all ones that rise).
  const reached = typeof target === "number" && latest !== null && latest >= target;
  return (
    <li data-geo-target={row.metricId} data-geo-reached={reached || undefined} className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-ui text-text">{targetRowName(row)}</span>
        <span className="shrink-0 text-ui font-semibold tabular-nums text-text">
          {typeof target === "number" ? formatGeoValue(target, unit) : "—"}
          {reached
            ? <span className="ml-1.5 text-caption font-normal text-accent">已达到</span>
            : due && typeof target === "number" && <span className="ml-1.5 text-caption font-normal text-text-3">{`${monthDay(due)}前`}</span>}
        </span>
      </div>
      {scaled && typeof target === "number" && (
        <div className="mt-1.5">
          <BulletBar
            label={targetRowName(row)}
            value={latest}
            baseline={baseline}
            target={target}
            targetLabel={`目标 ${formatGeoValue(target, unit)}`}
            baselineLabel={baseline === null ? undefined : `基线 ${formatGeoValue(baseline, unit)}`}
            scale={false}
          />
        </div>
      )}
      <p className="mt-1 text-caption tabular-nums text-text-3">
        {[
          baseline !== null ? `基线 ${formatGeoValue(baseline, unit)}${baselineDay ? ` · ${monthDay(baselineDay)}` : ""}` : "基线 未测",
          latest !== null ? `现在 ${formatGeoValue(latest, unit)}${latestDay ? ` · ${monthDay(latestDay)}` : ""}` : null,
        ].filter(Boolean).join(" → ")}
      </p>
    </li>
  );
}

/* ------------------------------------------------------------- battlefield */

/** A group by its name, a link to its question group where it is one the plan resolved; plain text where it is not. */
function GroupLinks({ geoId, groups }: { geoId: string; groups: ReadonlyArray<{ id: string | null; name: string }> }) {
  return (
    <>
      {groups.map((group, index) => (
        <Fragment key={`${group.id ?? group.name}-${index}`}>
          {index > 0 && "、"}
          {group.id
            ? <Link to={geoDestinationPath(geoId, { tab: "questions" }, { group: group.id })} className="rounded text-link hover:underline">{group.name}</Link>
            : <span>{group.name}</span>}
        </Fragment>
      ))}
    </>
  );
}

export function Battlefield({ geoId, plan }: { geoId: string; plan: GeoStrategyView }) {
  const field = plan.battlefield;
  const secondary = field?.secondary.filter((entry) => entry.name || entry.groups.length > 0) ?? [];
  const noGo = plan.noGo.filter((entry) => entry && entry.item);
  const why = field ? (field.why.length > 0 ? field.why : field.reason ? [field.reason] : []) : [];
  const groups = field?.groups ?? [];
  if (!field && noGo.length === 0) return null;
  if (groups.length === 0 && why.length === 0 && !field?.action && secondary.length === 0 && noGo.length === 0) return null;
  return (
    <div id={geoSectionId("battlefield")}>
    <Section title="战场">
      <div data-geo-battlefield="" className="flex flex-col gap-5">
        {(groups.length > 0 || why.length > 0) && (
          <div>
            <h3 className="text-ui font-semibold text-text">主战场</h3>
            {groups.length > 0 && <p className="mt-1.5 text-ui text-text"><GroupLinks geoId={geoId} groups={groups} /></p>}
            {why.length > 0 && (
              <ul className="mt-1.5 flex max-w-measure-body flex-col gap-1.5 text-ui text-text-2">
                {why.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}
            {field?.action && <p className="mt-1.5 max-w-measure-body text-ui text-text">{field.action}</p>}
          </div>
        )}
        {secondary.length > 0 && (
          <div>
            <h3 className="text-ui font-semibold text-text">次要战场</h3>
            <ul className="mt-1.5 flex flex-col gap-3">
              {secondary.map((entry, index) => (
                <li key={`${entry.id ?? entry.name}-${index}`} className="max-w-measure-body text-ui text-text-2">
                  {entry.name && <span className="text-text">{entry.name}</span>}
                  {entry.groups.length > 0 && <span className="text-text">{entry.name ? "：" : ""}<GroupLinks geoId={geoId} groups={entry.groups} /></span>}
                  {entry.why.map((line) => <span key={line} className="block">{line}</span>)}
                  {entry.action && <span className="block">{entry.action}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {noGo.length > 0 && (
          <div>
            <h3 className="text-ui font-semibold text-text">不做</h3>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {noGo.map((entry) => (
                <li key={entry.item} className="max-w-measure-body text-ui text-text-2">
                  <span className="text-text">{entry.item}</span>
                  {entry.reason && <span>{`：${entry.reason}`}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
    </div>
  );
}

/* ----------------------------------------------------------------- engines */

/** What each engine can be promised, and what placing for it takes: the retrieval it rests on, the level, the layer, the account. */
export function EnginePromises({ plan }: { plan: GeoStrategyView }) {
  const rows = plan.engines.filter((row) => row && row.engine);
  if (rows.length === 0) return null;
  return (
    <div id={geoSectionId("engines")}>
      <Section title="各引擎能承诺什么">
        <DataTable<GeoStrategyEngine>
          label="各引擎的承诺"
          minWidth="min-w-[44rem]"
          rows={rows}
          rowKey={(row) => row.engine}
          rowAttrs={(row) => ({ "data-geo-expectation": row.engine })}
          columns={[
            { key: "engine", header: "AI 引擎", rowHeader: true, cell: (row) => engineName(row.engine) },
            {
              key: "retrieval",
              header: "检索触发率",
              align: "right",
              width: "w-32",
              cell: (row) => (mentionOnly(row.engine)
                ? <span className="text-text-3">{MENTION_ONLY_WORD}</span>
                : <GeoCellText cell={row.retrieval} layout="stack" />),
            },
            {
              key: "level",
              header: "能承诺",
              width: "w-44",
              cell: (row) => (row.ceiling && row.ceiling in GEO_PROMISE_CEILING_WORDS ? GEO_PROMISE_CEILING_WORDS[row.ceiling] : "—"),
              isEmpty: (row) => !row.ceiling,
            },
            {
              key: "layers",
              header: "投哪一层",
              width: "w-32",
              cell: (row) => {
                const layers = row.layers
                  .map((layer) => GEO_SOURCE_LAYER_WORDS[layer as keyof typeof GEO_SOURCE_LAYER_WORDS] ?? sourceKindWord(layer))
                  .filter(Boolean);
                return layers.length ? layers.join(" + ") : "—";
              },
            },
            {
              key: "account",
              header: "需要的账号",
              width: "w-40",
              cell: (row) => (row.layout?.account ? (
                <span>
                  {row.layout.account}
                  {row.layout.state && <span className="block text-caption text-text-3">{row.layout.state}</span>}
                </span>
              ) : "—"),
              isEmpty: (row) => !row.layout?.account,
            },
            { key: "promise", header: "这个周期能做到", cell: (row) => <span className="block max-w-measure">{row.promise || "—"}</span> },
          ]}
        />
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------ client to-dos */

/** What the strategy asks the client to do outside the platform. Marking one done is reversible and the only thing written. */
export function ClientToDos({ geoId, plan, onChanged }: { geoId: string; plan: GeoStrategyView; onChanged: () => void }) {
  const frame = useGeoFrame();
  const [busy, setBusy] = useState<string | null>(null);
  const items = plan.layout.clientActions;
  if (items.length === 0) return null;
  const mayChange = !frame?.project.access || frame.project.access.abilities.includes("edit");
  const mark = (key: string, done: boolean) => {
    setBusy(key);
    void skipGeoAction(geoId, key, done)
      .then(() => {
        onChanged();
        frame?.reload();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法记下这件事，请稍后重试。" })))
      .finally(() => setBusy(null));
  };
  const open = items.filter((item) => !item.done);
  const done = items.filter((item) => item.done);
  return (
    <div id={geoSectionId("client_actions")}>
      <Section title="需要你做的" count={open.length > 0 ? open.length : undefined}>
        <List divided label="需要你做的事">
          {[...open, ...done].map((item) => (
            <ListRow
              key={item.key}
              title={<span className="max-w-measure">{item.text}</span>}
              muted={item.done}
              trailing={item.done ? <Tag>已经做了</Tag> : undefined}
              actions={mayChange ? (
                <Button variant="text" size="sm" loading={busy === item.key} onClick={() => mark(item.key, !item.done)}>
                  {item.done ? "还没做" : "已经做了"}
                </Button>
              ) : undefined}
            />
          ))}
        </List>
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------- assumptions */

/** A value a reader can say in a word: a short text or a number. A list or a record is the reason's to say. */
function plainValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() && value.length <= 24) return value.trim();
  return null;
}

/** What the plan took as given, one line each, and a way to change one: in the conversation, with the line in the draft, unsent. */
export function Assumptions({ project, plan }: { project: GeoProject; plan: GeoStrategyView }) {
  const open = useOpenGeoConversation();
  const rows = plan.assumptions.filter((entry) => entry && (entry.reason || plainValue(entry.value)));
  if (rows.length === 0) return null;
  const mayChange = !project.access || project.access.abilities.includes("edit");
  return (
    <Section title="假设" count={rows.length}>
      <Disclosure summary="方案按这些假设做，不对的可以改">
        <List divided label="方案的假设">
          {rows.map((entry, index) => {
            const value = plainValue(entry.value);
            const line = entry.reason || value || "";
            const basis = entry.basis && entry.basis in GEO_ASSUMPTION_BASIS_WORDS ? GEO_ASSUMPTION_BASIS_WORDS[entry.basis] : null;
            return (
              <ListRow
                key={`${entry.field}-${index}`}
                title={<span className="max-w-measure-body">{value && entry.reason ? `${value}：${entry.reason}` : line}</span>}
                trailing={basis ? <Tag>{basis}</Tag> : undefined}
                actions={mayChange ? (
                  <Button
                    variant="text"
                    size="sm"
                    onClick={() => { void open({ projectId: project.projectId, sessionId: project.sessionId }, `方案里有一条假设：“${line}”。我想改成：`); }}
                  >
                    修改
                  </Button>
                ) : undefined}
              />
            );
          })}
        </List>
      </Disclosure>
    </Section>
  );
}
