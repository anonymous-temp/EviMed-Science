import { Fragment, useMemo } from "react";
import { agendaLocalDate, DISPLAY_TIME_ZONE } from "@evimed/domain";
import type { GeoActionsView, GeoArticle, GeoClusterRow, GeoDistribution, GeoMonitoring } from "@/lib/geoClient";
import { NetEffectBand, type NetEffectInput } from "@/components/charts/NetEffectBand";
import { ChartCard, LegendMark } from "@/components/ui/ChartCard";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Tag } from "@/components/ui/Tag";
import { OWN_COLOR, rivalColor } from "@/components/charts/trendModel";
import { geoSectionId } from "../geoTabs";
import { layerName, monthDay } from "../geoText";
import { yuan } from "../tabs/geoTabText";
import { clusterName, poolDescription } from "./clusterModel";
import { ClusterLink } from "./ClusterLink";
import { articleMeta, articleStatusLine, headlineText, type HeadlinePart } from "./actionModel";
import type { ArticleRef } from "./useArticleActions";

/* ------------------------------------------------------------------ effect */

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The day the first page went out, from what the platform knows has been published: an order that is published (its last change
 * is the day it went live) or a page the brand registered with its own date. Null while nothing has.
 */
export function firstPublishedDay(distribution: GeoDistribution | null | undefined): string | null {
  const days: string[] = [];
  for (const order of distribution?.orders ?? []) {
    if (["published", "verified", "settled"].includes(order.state) && order.updatedAt) days.push(agendaLocalDate(DISPLAY_TIME_ZONE, order.updatedAt));
  }
  for (const link of distribution?.ownedLinks ?? []) {
    if (link.publishedAt && link.status !== "retired") days.push(agendaLocalDate(DISPLAY_TIME_ZONE, link.publishedAt));
  }
  return days.sort()[0] ?? null;
}

/** The first time an engine cited what we published: the one event that explains a rise. */
export function firstCitedDay(monitoring: GeoMonitoring | null | undefined): string | null {
  const days = (monitoring?.cited ?? [])
    .map((row) => row?.firstSeen)
    .filter((seen): seen is string => typeof seen === "string" && !Number.isNaN(Date.parse(seen)))
    .map((seen) => agendaLocalDate(DISPLAY_TIME_ZONE, seen))
    .sort();
  return days[0] ?? null;
}

/** The chart's input: the arms' rounds with the pilot and control lines and the marks of what was done. */
export function netEffectInput(monitoring: GeoMonitoring | null | undefined, distribution: GeoDistribution | null | undefined): NetEffectInput | null {
  const pilot = monitoring?.arms?.pilot ?? [];
  const control = monitoring?.arms?.control ?? [];
  const dates = [...new Set([...pilot, ...control].filter((point) => finite(point.value)).map((point) => point.date))].sort();
  if (dates.length === 0) return null;
  const placeOn = (day: string | null): number | null => {
    if (!day) return null;
    const at = dates.findIndex((date) => date >= day);
    return at < 0 ? dates.length - 1 : at;
  };
  const published = placeOn(firstPublishedDay(distribution));
  const cited = placeOn(firstCitedDay(monitoring));
  const markers: Array<{ index: number; label: string }> = [];
  if (published !== null) markers.push({ index: published, label: "稿件发布" });
  if (cited !== null) {
    const same = markers.find((marker) => marker.index === cited);
    if (same) same.label = `${same.label}·首次被引用`;
    else markers.push({ index: cited, label: "首次被引用" });
  }
  const band = monitoring?.arms?.netEffect?.noiseBand;
  return {
    dates,
    labels: dates.map((date) => monthDay(date) ?? ""),
    pilot,
    control,
    band: typeof band === "number" ? band : null,
    markers,
  };
}

/**
 * 「投了有没有用」 at the top of 行动 (R19, audit C §2.5): the page's lead sentence — the arms' verdict and how many groups still
 * wait — is the card's title, the figures in it open what they count, and under it is the picture of the two arms.
 */
export function EffectCard({
  parts,
  input,
  loading,
  onOpen,
}: {
  parts: readonly HeadlinePart[];
  input: NetEffectInput | null;
  loading: boolean;
  onOpen: (target: "acted" | "waiting" | "effect") => void;
}) {
  // The figures of a heading take the heading's own weight (a `Note`'s medium figure would be a type pair of its own at this size).
  const title = parts.length > 0
    ? parts.map((part, index) => (typeof part === "string"
      ? <Fragment key={index}>{part}</Fragment>
      : (
        <button
          key={index}
          type="button"
          onClick={() => onOpen(part.target)}
          className="rounded tabular-nums text-link hover:underline hover:underline-offset-4"
        >
          {part.n}
        </button>
      )))
    : "投放的语义群和对照组还没有可以比较的读数";
  return (
    <div id={geoSectionId("effect")} data-geo-effect="" data-headline="">
      <ChartCard
        title={title}
        legend={input ? (
          <>
            <LegendMark series="own" color={OWN_COLOR}>投放的语义群</LegendMark>
            <LegendMark series="rival-1" color={rivalColor(0)}>对照组</LegendMark>
            {input.band !== null && <LegendMark series="band" shape="band" color="var(--chart-band)">对照组的波动范围</LegendMark>}
          </>
        ) : undefined}
        state={loading ? "loading" : input ? "content" : "empty"}
        emptyText="首批稿件上线后，这里会把投放的语义群和对照组放在一起比。"
        height={200}
      >
        {input && <NetEffectBand input={input} label={headlineText(parts) || "投放的语义群和对照组的变化"} />}
      </ChartCard>
    </div>
  );
}

/* ------------------------------------------------------------------ review */

/**
 * The one stop on this page: an article held for a safety finding waits for a person to have looked at it. Said first, because
 * nothing past it is placed until it is released. `#geo-review` is where 「需要你」 sends a person.
 */
export function ReviewBlock({
  articles,
  groupOf,
  canReview,
  busy,
  reachable,
  onOpen,
  onRelease,
}: {
  articles: readonly GeoArticle[];
  groupOf: (article: GeoArticle) => GeoClusterRow | null;
  canReview: boolean;
  busy: string | null;
  reachable: (article: ArticleRef) => { label: string } | null;
  onOpen: (article: GeoArticle) => void;
  onRelease: (article: GeoArticle) => void;
}) {
  if (articles.length === 0) return null;
  return (
    <section id={geoSectionId("review")} aria-label="等你放行的稿件" data-geo-review="">
      <Note tone="warn" result={[{ n: articles.length }, " 篇稿件有安全问题没有看过，放行之前不会投放。"]} />
      <List label="等你放行的稿件" divided className="mt-2">
        {articles.map((article) => {
          const group = groupOf(article);
          const reach = reachable(article);
          return (
            <ListRow
              key={article.id}
              title={article.title || article.question || "未命名稿件"}
              titleProps={{ "data-geo-article": article.id }}
              onOpen={reach ? () => onOpen(article) : undefined}
              meta={(
                <span className="inline-flex flex-wrap items-baseline gap-x-2">
                  {group && <ClusterLink groupId={group.id} className="relative z-sticky">{clusterName(group)}</ClusterLink>}
                  <span>{layerName(article.layer) === "—" ? "" : layerName(article.layer)}</span>
                </span>
              )}
              trailing={<Tag tone="safety">安全待复核</Tag>}
              actions={canReview ? <Button variant="text" size="sm" loading={busy === article.id} onClick={() => onRelease(article)}>放行</Button> : undefined}
            />
          );
        })}
      </List>
    </section>
  );
}

/* ------------------------------------------------------------------ budget */

/**
 * The budget, where a market is there to spend it: what was set, spent and reserved, and the way to change it. With no market
 * connected there is nothing to place and nothing here: the sources say so row by row.
 */
export function BudgetLine({
  distribution,
  canManage,
  onEdit,
}: {
  distribution: GeoDistribution | null;
  canManage: boolean;
  onEdit: () => void;
}) {
  if (!distribution) return null;
  const connected = distribution.market?.configured !== false;
  const budget = distribution.budget && typeof distribution.budget.totalCny === "number" ? distribution.budget : null;
  if (!connected && !budget) return null;
  const spent = typeof distribution.spentCny === "number" ? distribution.spentCny : 0;
  const reserved = typeof distribution.reservedCny === "number" ? distribution.reservedCny : 0;
  return (
    <section id={geoSectionId("budget")} aria-label="投放预算" data-geo-budget={budget ? "set" : "unset"}>
      {budget ? (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-card bg-surface-1 px-4 py-3 text-ui">
          <span className="text-text">{`预算 ${yuan(budget.totalCny)}`}</span>
          <span className="tabular-nums text-text-2">{`已花 ${yuan(spent)}`}</span>
          <span className="tabular-nums text-text-2">{`已预留 ${yuan(reserved)}`}</span>
          <span className="tabular-nums text-text-2">{`每天最多 ${yuan(budget.dailyCny)}`}</span>
          <span className="flex-1" />
          {connected && canManage && <Button variant="text" size="sm" onClick={onEdit}>修改</Button>}
        </div>
      ) : (
        <Note
          tone="warn"
          action={canManage ? <Button size="sm" onClick={onEdit}>设置投放预算</Button> : undefined}
        >
          {typeof distribution.suggestedBudgetCny === "number" && distribution.suggestedBudgetCny > 0
            ? `还没有设投放预算，建议 ${yuan(distribution.suggestedBudgetCny)}。`
            : "还没有设投放预算，写好的稿件要等预算才会投放。"}
        </Note>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- control */

/** The control groups, collapsed: they are measured and never worked on, and a group that has articles has left the control. */
export function ControlGroups({ view, clusters }: { view: GeoActionsView; clusters: readonly GeoClusterRow[] }) {
  const named = useMemo(() => view.control.map((entry) => ({ ...entry, row: clusters.find((cluster) => cluster.id === entry.id) ?? null })), [view.control, clusters]);
  if (named.length === 0) return null;
  const written = named.filter((entry) => entry.articles > 0);
  return (
    <section aria-label="对照组" data-geo-control="">
      <Disclosure summary={`对照组 ${named.length} 个，只监测`}>
        <ul className="flex flex-col divide-y divide-faint">
          {named.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-ui">
              <ClusterLink groupId={entry.id} className="min-w-0">{entry.row ? clusterName(entry.row) : entry.name}</ClusterLink>
              {entry.pool && <span className="text-caption text-text-3" title={poolDescription(entry.pool) ?? undefined}>{entry.pool}</span>}
              {entry.articles > 0 && <Tag tone="warn">{`已写 ${entry.articles} 篇，不再是对照`}</Tag>}
            </li>
          ))}
        </ul>
        {written.length > 0 && <p className="sr-only">{`有 ${written.length} 个对照群写了稿件`}</p>}
      </Disclosure>
    </section>
  );
}

/* ----------------------------------------------------------- other articles */

/**
 * The articles no action lists — written for a group that has no gap, or for a control group — so nothing a person made or may
 * want to take out of distribution is out of sight.
 */
export function OtherArticles({
  articles,
  groupOf,
  reachable,
  onOpen,
  onWithdraw,
  canEdit,
}: {
  articles: readonly GeoArticle[];
  groupOf: (article: GeoArticle) => GeoClusterRow | null;
  reachable: (article: ArticleRef) => { label: string } | null;
  onOpen: (article: GeoArticle) => void;
  onWithdraw: (article: GeoArticle) => void;
  canEdit: boolean;
}) {
  if (articles.length === 0) return null;
  return (
    <section aria-label="其他稿件" data-geo-other-articles="">
      <Disclosure summary={`其他稿件 ${articles.length} 篇`}>
        <List label="其他稿件" divided>
          {articles.map((article) => {
            const group = groupOf(article);
            const reach = reachable(article);
            return (
              <ListRow
                key={article.id}
                title={article.title || article.question || "未命名稿件"}
                titleProps={{ "data-geo-article": article.id }}
                onOpen={reach ? () => onOpen(article) : undefined}
                meta={(
                  <span className="inline-flex flex-wrap items-baseline gap-x-2">
                    {group && <ClusterLink groupId={group.id} className="relative z-sticky">{clusterName(group)}</ClusterLink>}
                    <span>{[articleMeta(article), articleStatusLine(article)].filter(Boolean).join(" · ")}</span>
                  </span>
                )}
                trailing={article.groupIsControl ? <Tag tone="warn">对照群</Tag> : undefined}
                actions={canEdit && article.status !== "withdrawn" ? <Button variant="text" size="sm" onClick={() => onWithdraw(article)}>撤回</Button> : undefined}
              />
            );
          })}
        </List>
      </Disclosure>
    </section>
  );
}
