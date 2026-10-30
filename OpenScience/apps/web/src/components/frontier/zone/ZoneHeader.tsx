import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import type { ZoneDetail } from "@/lib/evidenceTopicClient";
import { Tag } from "@/components/ui/Tag";
import { FEED_ZONE_NOTE, dateClock, feedDay } from "../frontierText";
import { itemsHref, zoneOwnerLine, zonePath, zoneSpecialties } from "./zoneText";

/** A count that opens what it counts: an underlined link in the line, the way a number in a sentence is (`Note`, DESIGN.md rule 7). */
const COUNT = "rounded text-link underline decoration-1 underline-offset-2 hover:decoration-2";

/**
 * What stands under a zone's title: its keywords as labels (two or three, never inside a link), the scope sentence, and one line of
 * facts — the specialty, how many items came in the last 7 days, the last 30 and in all (each a link to the 动态 tab with that window),
 * how many evidence cards the team's interface holds (only when it holds any), whose zone it is (only for a reader's own) and the time
 * the counts were taken, in Beijing time.
 *
 * A zone that went quiet says when it last had something (「最近更新于 …」, first in the facts); one that was archived says it is no
 * longer updated, and where the reader goes instead when a merge or a split gave it successors (plan 6.4: the page stays, readable, at
 * its address, and says what it is).
 */
export function ZoneHeader({ zone, path, cards, linked = true }: {
  zone: ZoneDetail;
  /** The zone's address, which a count opens the 动态 tab of. */
  path: string;
  cards: number;
  /**
   * Whether the counts open what they count. They do from the 概览; on the 动态 and 证据卡片 tabs the toolbar's window and the tab row
   * already say it, and a second kind of link in the header was an eleventh kind of control on the 动态 tab.
   */
  linked?: boolean;
}) {
  const owner = zoneOwnerLine(zone);
  const specialties = zoneSpecialties(zone);
  // The time of the counts shown, not of the zone's last edit; while they are being counted again there is no time to state.
  const taken = zone.countsAt ? dateClock(zone.countsAt) : "";
  const hasCounts = zone.counts.all > 0;
  /** A count: the link it is on the overview, plain text elsewhere. */
  const figure = (to: string, label: string, value: number) => linked
    ? <Link to={to} aria-label={`${label}，查看`} className={COUNT}>{value}</Link>
    : <span>{value}</span>;
  const lastDay = feedDay(zone.lastItemAt);
  const facts: ReactNode[] = [
    ...(zone.lifecycle === "quiet" ? [<span key="quiet" className="tabular-nums">{lastDay ? `最近更新于 ${lastDay}` : "近期没有新动态"}</span>] : []),
    ...(specialties ? [<span key="specialty">{specialties}</span>] : []),
    ...(owner ? [<span key="owner">{owner}</span>] : []),
    ...(hasCounts ? [
      <span key="week" className="tabular-nums">近 7 天 {figure(itemsHref(path, { window: "7d" }), `近 7 天 ${zone.counts.week} 条`, zone.counts.week)}</span>,
      <span key="month" className="tabular-nums">近 30 天 {figure(itemsHref(path, { window: "30d" }), `近 30 天 ${zone.counts.month} 条`, zone.counts.month)}</span>,
      <span key="all" className="tabular-nums">全部 {figure(itemsHref(path, { window: "all" }), `全部 ${zone.counts.all} 条`, zone.counts.all)} 条</span>,
    ] : []),
    ...(cards > 0 ? [<span key="cards" className="tabular-nums">证据卡片 {figure(`${path}?tab=cards`, `证据卡片 ${cards} 张`, cards)} 张</span>] : []),
    ...(taken ? [<span key="taken" className="tabular-nums">截至 {taken}{FEED_ZONE_NOTE}</span>] : []),
  ];
  return (
    <div className="space-y-2.5">
      {zone.keywords.length > 0 && (
        <ul aria-label="关键词" className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {zone.keywords.map((keyword, index) => (
            <Fragment key={`${index}:${keyword}`}>
              {index > 0 && <li aria-hidden="true" className="text-caption text-text-3">×</li>}
              <li><Tag>{keyword}</Tag></li>
            </Fragment>
          ))}
        </ul>
      )}
      {zone.lifecycle === "archived" && <Archived zone={zone} lastDay={lastDay} />}
      {zone.scope && <p data-prose="" className="max-w-measure-body text-ui text-text-2">{zone.scope}</p>}
      {facts.length > 0 && (
        <p className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-text-3")}>
          {facts.map((fact, index) => (
            <Fragment key={index}>
              {index > 0 && <span aria-hidden="true">·</span>}
              {fact}
            </Fragment>
          ))}
        </p>
      )}
    </div>
  );
}

/**
 * 「不再更新」: what an archived zone says before anything else (it stays readable at its address). Where a merge or a split archived
 * it, the zones that took over are links, so a bookmark, a notice or an old link leads on.
 */
function Archived({ zone, lastDay }: { zone: ZoneDetail; lastDay: string }) {
  return (
    <p className="flex max-w-measure-body flex-wrap items-baseline gap-x-1.5 gap-y-1 text-ui text-text-2">
      <span>这个专区不再更新{lastDay ? `，最后更新于 ${lastDay}` : ""}。</span>
      {zone.successors.length > 0 && (
        <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
          <span>现在请看：</span>
          {zone.successors.map((successor, index) => (
            <Fragment key={successor.id}>
              {index > 0 && <span aria-hidden="true">、</span>}
              <Link to={zonePath(successor)} className="rounded text-link underline decoration-1 underline-offset-2 hover:decoration-2">{successor.title}</Link>
            </Fragment>
          ))}
        </span>
      )}
    </p>
  );
}
