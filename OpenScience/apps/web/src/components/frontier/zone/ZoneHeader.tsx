import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import type { ZoneDetail } from "@/lib/evidenceTopicClient";
import { Tag } from "@/components/ui/Tag";
import { FEED_ZONE_NOTE, dateClock } from "../frontierText";
import { itemsHref, zoneOwnerLine, zoneSpecialties } from "./zoneText";

/** A count that opens what it counts: an underlined link in the line, the way a number in a sentence is (`Note`, DESIGN.md rule 7). */
const COUNT = "rounded text-link underline decoration-1 underline-offset-2 hover:decoration-2";

/**
 * What stands under a zone's title: its keywords as labels (two or three, never inside a link), the scope sentence, and one line of
 * facts — the specialty, how many items came in the last 7 days, the last 30 and in all (each a link to the 动态 tab with that window),
 * how many evidence cards the team's interface holds (only when it holds any), whose zone it is (only for a reader's own) and the time
 * the counts were taken, in Beijing time.
 */
export function ZoneHeader({ zone, path, cards }: {
  zone: ZoneDetail;
  /** The zone's address, which a count opens the 动态 tab of. */
  path: string;
  cards: number;
}) {
  const owner = zoneOwnerLine(zone);
  const specialties = zoneSpecialties(zone);
  const taken = zone.updatedAt ? dateClock(zone.updatedAt) : "";
  const hasCounts = zone.counts.all > 0;
  const facts: ReactNode[] = [
    ...(specialties ? [<span key="specialty">{specialties}</span>] : []),
    ...(owner ? [<span key="owner">{owner}</span>] : []),
    ...(hasCounts ? [
      <span key="week" className="tabular-nums">近 7 天 <Link to={itemsHref(path, { window: "7d" })} aria-label={`近 7 天 ${zone.counts.week} 条，查看`} className={COUNT}>{zone.counts.week}</Link></span>,
      <span key="month" className="tabular-nums">近 30 天 <Link to={itemsHref(path, { window: "30d" })} aria-label={`近 30 天 ${zone.counts.month} 条，查看`} className={COUNT}>{zone.counts.month}</Link></span>,
      <span key="all" className="tabular-nums">全部 <Link to={itemsHref(path, { window: "all" })} aria-label={`全部 ${zone.counts.all} 条，查看`} className={COUNT}>{zone.counts.all}</Link> 条</span>,
    ] : []),
    ...(cards > 0 ? [<span key="cards" className="tabular-nums">证据卡片 <Link to={`${path}?tab=cards`} aria-label={`证据卡片 ${cards} 张，查看`} className={COUNT}>{cards}</Link> 张</span>] : []),
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
