import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowUp, Filter, Newspaper, Search } from "lucide-react";
import type { FrontierItem } from "@/lib/frontierClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { Button, buttonClasses } from "@/components/ui/Button";
import { FilterChip } from "@/components/ui/FilterChips";
import type { ToolbarAction } from "@/components/ui/Toolbar";
import { FrontierSkeleton } from "./FrontierSkeleton";
import { dayHeading, groupByDay } from "./frontierText";

/** A page of the feed as it is on screen, with the query it answers and when it was read. */
export interface Listing {
  key: string;
  items: FrontierItem[];
  nextCursor: string | null;
  version: string | null;
  loadedAt: number;
  /** A search whose words matched nothing: the items are the nearest by meaning. */
  related?: boolean;
}

/** 「有 N 条新的」 says 「N+」 from a full page on. */
export const FEED_PAGE_SIZE = 30;

/**
 * The feed itself (plan 2026-09-23 §6.2): its four states, 「有 N 条新的」, the
 * day groups and 「加载更多」. A day is headed by its date — 「今天 · 10月23日
 * 周四 · 11 条」 — and, once the whole day is on screen, how many items it holds
 * (the last day may continue on the next page, so its count waits); the heading
 * stays under the page's band while its day scrolls by. Search results are one
 * list in relevance or time order, so they are not cut into days, and each card
 * says its own date.
 *
 * The list is a stacking context of its own (`isolate`): a sticky heading rises
 * over the cards under it, and the band rises over both.
 *
 * 只看未读 is a toggle at the right end of the first day's heading (`unread`), as
 * AIHOT's timeline has it — not one more filter on the band (owner, 2026-10-25);
 * while it empties the list it stays above the empty state. A search's results
 * open with 「关注“<词>”」 (`followSearch`), which makes the words a topic follow.
 */
export function FeedList({
  view, q, filtered, empty, listing, error, fresh, firstRun, loadingMore, renderItem,
  onRetry, onFresh, onMore, onAll, onClear, unread, followSearch,
}: {
  view: "selected" | "all";
  q: string;
  /** A filter or one narrowed follow is set: an empty list means it excluded everything. */
  filtered: boolean;
  /** What an empty list says when nothing excluded anything (the 关注 view: nothing new). */
  empty?: string;
  listing: Listing | null;
  error: string | null;
  fresh: number;
  firstRun: boolean;
  loadingMore: boolean;
  /** One card; `grouped` is whether it sits in a day group. */
  renderItem: (item: FrontierItem, grouped: boolean) => ReactNode;
  onRetry: () => void;
  onFresh: () => void;
  onMore: () => void;
  onAll: () => void;
  /** Take the search and the filters away: the way on from a list they emptied. */
  onClear: () => void;
  /** 只看未读, on the first day's heading. */
  unread?: { pressed: boolean; onChange: (pressed: boolean) => void };
  /** A search's 「关注“<词>”」 (or 「已关注“<词>”」). */
  followSearch?: ToolbarAction | null;
}) {
  if (!listing) {
    return error ? <LoadError message={error} onRetry={onRetry} /> : <FrontierSkeleton />;
  }
  const days = q ? [] : groupByDay(listing.items);
  const unreadToggle = unread && (
    <FilterChip pressed={unread.pressed} className="shrink-0" onClick={() => unread.onChange(!unread.pressed)}>只看未读</FilterChip>
  );
  return (
    // A block of its own (the walk judges a control against the content of its block): 只看未读 above a list it emptied is the list's
    // control, not one standing under 精选's safety strip.
    <section id="frontier-list-top" className="isolate space-y-8">
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-ui text-text-2">
          <span>未能刷新</span>
          <Button variant="secondary" onClick={onRetry}>重试</Button>
        </div>
      )}
      {fresh > 0 && (
        <Button variant="secondary" className="w-full" onClick={onFresh}>
          <ArrowUp size={16} aria-hidden="true" />有 {fresh >= FEED_PAGE_SIZE ? `${fresh}+` : fresh} 条新的
        </Button>
      )}
      {listing.items.length === 0 && !q && unread?.pressed && <div className="flex justify-end">{unreadToggle}</div>}
      {listing.items.length === 0 ? (
        // An empty list always says where to go from it (DESIGN.md rule 8): out of a search or a filter, to the full list, or to the zones.
        q ? <EmptyState icon={Search} title={`没有找到和“${q}”相关的动态`} action={<Button variant="secondary" onClick={onClear}>清除搜索</Button>} />
          : filtered ? <EmptyState icon={Filter} title="没有结果" action={<Button variant="secondary" onClick={onClear}>清除筛选</Button>} />
            : empty ? <EmptyState icon={Newspaper} title={empty} action={<Button variant="secondary" onClick={onAll}>看全部动态</Button>} />
              : firstRun || view === "all"
                ? <EmptyState icon={Newspaper} title="暂无内容" action={<Link to="/app/frontier?view=zones" className={buttonClasses({ variant: "secondary" })}>看证据专区</Link>} />
                : <EmptyState icon={Newspaper} title="暂无精选" action={<Button variant="secondary" onClick={onAll}>看全部</Button>} />
      ) : q ? (
        <section aria-label="搜索结果">
          {(listing.related || followSearch) && (
            <div className="mb-2 flex items-center gap-3">
              {listing.related && <p className="min-w-0 flex-1 text-ui text-text-3">没有找到包含“{q}”的动态，下面是意思相近的内容</p>}
              {followSearch && (
                <Button variant="text" size="sm" className="ml-auto shrink-0 text-accent" disabled={followSearch.disabled} onClick={followSearch.onClick}>
                  {followSearch.label}
                </Button>
              )}
            </div>
          )}
          <ul>{listing.items.map((item) => renderItem(item, false))}</ul>
        </section>
      ) : days.map((group, index) => {
        const whole = index < days.length - 1 || !listing.nextCursor;
        return (
          <section key={group.key} aria-labelledby={`frontier-day-${group.key}`}>
            <div data-day-heading="" className="sticky top-[var(--page-chrome-h,0px)] z-sticky -mx-1 flex items-center gap-3 bg-bg px-1 py-2">
              <h2 id={`frontier-day-${group.key}`} className="flex min-w-0 flex-1 items-baseline gap-1">
                <span className="text-body font-semibold leading-6 text-text">{dayHeading(group, false)}</span>
                {whole && <span className="text-caption tabular-nums text-text-3">· {group.items.length} 条</span>}
              </h2>
              {index === 0 && unreadToggle}
            </div>
            <ul>{group.items.map((item) => renderItem(item, true))}</ul>
          </section>
        );
      })}
      {listing.nextCursor && <Button variant="secondary" loading={loadingMore} onClick={onMore}>加载更多</Button>}
    </section>
  );
}
