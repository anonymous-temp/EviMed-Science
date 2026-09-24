import type { ReactNode } from "react";
import { ArrowUp, Filter, Newspaper, Search } from "lucide-react";
import type { FrontierItem } from "@/lib/frontierClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { Button } from "@/components/ui/Button";
import { FrontierSkeleton } from "./FrontierSkeleton";
import { groupByDay } from "./frontierText";

/** A page of the feed as it is on screen, with the query it answers and when it was read. */
export interface Listing {
  key: string;
  items: FrontierItem[];
  nextCursor: string | null;
  version: string | null;
  loadedAt: number;
}

/** 「有 N 条新的」 says 「N+」 from a full page on. */
export const FEED_PAGE_SIZE = 30;

/**
 * The feed itself (plan 2026-09-23 §6.2): its four states, 「有 N 条新的」, the
 * day groups and 「加载更多」. A day is headed by its date and, once the whole
 * day is on screen, how many items it holds — the last day may continue on
 * the next page, so its count waits. Search results are one list in
 * relevance or time order, so they are not cut into days.
 */
export function FeedList({
  view, q, filtered, listing, error, fresh, firstRun, loadingMore, renderItem,
  onRetry, onFresh, onMore, onAll,
}: {
  view: "selected" | "all";
  q: string;
  filtered: boolean;
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
}) {
  if (!listing) {
    return error ? <LoadError message={error} onRetry={onRetry} /> : <FrontierSkeleton />;
  }
  const days = q ? [] : groupByDay(listing.items);
  return (
    <div id="frontier-list-top" className="space-y-8">
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
      {listing.items.length === 0 ? (
        q ? <EmptyState icon={Search} title={`没有找到和「${q}」相关的动态`} />
          : filtered ? <EmptyState icon={Filter} title="没有结果" />
            : firstRun || view === "all" ? <EmptyState icon={Newspaper} title="暂无内容" />
              : <EmptyState icon={Newspaper} title="暂无精选" action={<Button variant="secondary" onClick={onAll}>看全部</Button>} />
      ) : q ? (
        <section aria-label="搜索结果">
          <ul>{listing.items.map((item) => renderItem(item, false))}</ul>
        </section>
      ) : days.map((group, index) => {
        const whole = index < days.length - 1 || !listing.nextCursor;
        return (
          <section key={group.key} aria-labelledby={`frontier-day-${group.key}`}>
            <h2 id={`frontier-day-${group.key}`} className="flex items-baseline gap-2">
              <span className="text-body font-semibold leading-6 text-text">{group.label}</span>
              {whole && <span className="text-caption tabular-nums text-text-3">{group.items.length} 条</span>}
            </h2>
            <ul>{group.items.map((item) => renderItem(item, true))}</ul>
          </section>
        );
      })}
      {listing.nextCursor && <Button variant="secondary" loading={loadingMore} onClick={onMore}>加载更多</Button>}
    </div>
  );
}
