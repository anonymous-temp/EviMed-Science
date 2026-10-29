import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import type { ZoneEntityCount, ZoneSide } from "@/lib/evidenceTopicClient";
import { filterChipClasses } from "@/components/ui/FilterChips";
import { List, ListRow } from "@/components/ui/ListRow";
import { Tooltip } from "@/components/ui/Tooltip";
import { congressDates } from "../FrontierTrackView";
import { itemsHref, weekLabel, weekWindow, zonePath } from "./zoneText";

/** How many of each kind of name the rail lists. */
const TOP = 5;
/** Weeks the chart draws. */
const WEEKS = 12;
/** The chart's tallest bar, in px: the height of every small control of the feed, so a bar is one of their looks and not one of its own. */
const BAR_HEIGHT = 28;

const LABEL = "text-caption text-text-3";
const CHIP = filterChipClasses({ selected: true });

/** One block of the rail: a small heading and what it holds. The first has no rule over it, the others have one. */
function RailBlock({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-border pt-3.5 first:border-t-0 first:pt-0">
      <h2 id={id} className={LABEL}>{label}</h2>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/** A drug, a disease or an institution that comes up in the zone: a chip that opens the 动态 tab searched for it. */
function Names({ label, names, path }: { label: string; names: readonly ZoneEntityCount[]; path: string }) {
  const top = names.filter((entry) => entry.label).slice(0, TOP);
  if (top.length === 0) return null;
  return (
    <RailBlock label={label}>
      <ul aria-label={label} className="flex flex-wrap gap-1.5">
        {top.map((entry) => (
          <li key={entry.key ?? entry.label}>
            <Link to={itemsHref(path, { q: entry.label, window: "30d" })} className={CHIP}>
              {entry.label}{entry.count > 0 && <span className="tabular-nums text-text-3">{entry.count}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </RailBlock>
  );
}

/**
 * 近 12 周动态: one bar per week, oldest at the left, the tallest the zone's busiest week; a bar is a link to the 动态 tab narrowed to
 * that week (its name, the week and its count, says what it opens). The bars are drawn by their counts and say nothing the links do not.
 */
function Weekly({ weekly, path, now }: { weekly: ZoneSide["weekly"]; path: string; now: number }) {
  const weeks = weekly.slice(-WEEKS);
  const top = Math.max(1, ...weeks.map((week) => week.count));
  const total = weeks.reduce((sum, week) => sum + week.count, 0);
  return (
    <RailBlock label={`近 ${weeks.length} 周动态`}>
      <ul aria-label={`近 ${weeks.length} 周每周动态条数，共 ${total} 条`} className="flex items-end gap-0.5" style={{ height: BAR_HEIGHT }}>
        {weeks.map((week) => {
          const start = week.weekStart.slice(0, 10);
          const name = `${weekLabel(start, now)}，${week.count} 条`;
          return (
            <li key={week.weekStart} className="flex h-full min-w-0 flex-1 items-end">
              <Tooltip content={name} kind="label">
                <Link to={itemsHref(path, { week: start, window: weekWindow(start, now) })} aria-label={name}
                  className="group flex h-full w-full items-end rounded outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
                  <span aria-hidden="true" data-bar="" className={cn("block w-full rounded-sm bg-border-control transition-colors duration-fast group-hover:bg-accent group-focus-visible:bg-accent", week.count > 0 && "min-h-0.5")}
                    style={{ height: week.count > 0 ? Math.max(2, Math.round((week.count / top) * BAR_HEIGHT)) : 1 }} />
                </Link>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </RailBlock>
  );
}

/**
 * The right column of a zone's 概览 (from 1024 px; below it follows the main column): the neighbouring zones, the names that come up in
 * it, the last twelve weeks, the hot topics and the congresses that touch it. A block with nothing in it is not drawn.
 */
export function ZoneRail({ side, path, now = Date.now() }: { side: ZoneSide; path: string; now?: number }) {
  const hasWeeks = side.weekly.some((week) => week.count > 0);
  return (
    <div className="flex flex-col gap-8">
      {side.related.length > 0 && (
        <RailBlock label="相关专区">
          <List label="相关专区" className="-mx-2">
            {side.related.slice(0, 6).map((zone) => <ListRow key={zone.id} to={zonePath(zone)} title={zone.title} />)}
          </List>
        </RailBlock>
      )}
      <Names label="常见药物" names={side.entities.drugs} path={path} />
      <Names label="常见疾病" names={side.entities.diseases} path={path} />
      <Names label="常见机构" names={side.entities.orgs} path={path} />
      {hasWeeks && <Weekly weekly={side.weekly} path={path} now={now} />}
      {side.topics.length > 0 && (
        <RailBlock label="正在进行的热点话题">
          <List label="正在进行的热点话题" className="-mx-2">
            {side.topics.slice(0, 4).map((topic) => <ListRow key={topic.id} to={`/app/frontier/topics/${encodeURIComponent(topic.id)}`} title={topic.title} />)}
          </List>
        </RailBlock>
      )}
      {side.congresses.length > 0 && (
        <RailBlock label="近期会议">
          <List label="近期会议" className="-mx-2">
            {side.congresses.slice(0, 4).map((congress) => (
              <ListRow key={congress.id} to={`/app/frontier/congress/${encodeURIComponent(congress.id)}`} title={congress.name}
                meta={congress.start ? congressDates(congress.start, congress.end || congress.start) : undefined} />
            ))}
          </List>
        </RailBlock>
      )}
    </div>
  );
}

/** Whether the rail has anything to draw, so a page with nothing in it does not leave an empty column. */
export function railHasContent(side: ZoneSide): boolean {
  return side.related.length > 0 || side.entities.drugs.length > 0 || side.entities.diseases.length > 0 || side.entities.orgs.length > 0
    || side.weekly.some((week) => week.count > 0) || side.topics.length > 0 || side.congresses.length > 0;
}
