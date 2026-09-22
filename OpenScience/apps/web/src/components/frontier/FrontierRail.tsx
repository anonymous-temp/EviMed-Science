import { Link } from "react-router";
import { Flame } from "lucide-react";
import type { FrontierHotEvent, FrontierItem } from "@/lib/frontierClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { Card } from "@/components/ui/Card";
import { ago, hotMeta, itemWhen } from "./frontierText";

const eventPath = (id: string) => `/app/frontier/events/${encodeURIComponent(id)}`;

/**
 * 热点 (plan §4.4): the ten events most sources are reporting, by decayed
 * heat — the heat itself is never shown. Each row says its three separate
 * quantities and whether first-hand material is among the reports, and opens
 * the event page. Until the event layer exists the view says so honestly.
 */
export function HotList({ events }: { events: FrontierHotEvent[] | null }) {
  if (events === null) {
    return <EmptyState icon={Flame} title="热点还在准备"
      description="同一件事被多个来源报道时，会在这里合成一个热点，按独立来源数和一手材料排序。" className="rounded-card border border-dashed border-border" />;
  }
  if (events.length === 0) {
    return <EmptyState icon={Flame} title="近 72 小时还没有形成热点" description="单个来源的消息在「精选」和「全部」里。" className="rounded-card border border-dashed border-border" />;
  }
  return (
    <ol aria-label="热点" className="divide-y divide-border rounded-card border border-border bg-surface">
      {events.map((event) => (
        <li key={event.id} className="flex gap-3 px-4 py-3">
          <span className="w-6 shrink-0 text-ui font-semibold tabular-nums text-accent">{event.rank}</span>
          <div className="min-w-0 flex-1">
            <Link to={eventPath(event.id)} className="text-body font-semibold text-text hover:underline">{event.title}</Link>
            {event.latest && <p className="mt-0.5 text-ui text-text-2">{event.latest}</p>}
            <p className="mt-1 text-caption text-muted">
              {hotMeta(event)}
              {event.lastAt && <> · 最近更新 {ago(event.lastAt)}</>}
              {event.status === "settled" && <> · 已收束</>}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 今日热点, top five, in the rail. Absent when there is nothing behind it. */
export function HotRailCard({ events, onOpenAll }: { events: FrontierHotEvent[] | null; onOpenAll: () => void }) {
  if (!events || events.length === 0) return null;
  return (
    <Card title="今日热点" hint="近 72 小时，按独立来源数" padding="p-3">
      <ol className="divide-y divide-faint">
        {events.slice(0, 5).map((event) => (
          <li key={event.id} className="flex gap-2 py-2 first:pt-0">
            <span className="w-5 shrink-0 text-ui font-semibold tabular-nums text-accent">{event.rank}</span>
            <div className="min-w-0">
              <Link to={eventPath(event.id)} className="text-ui text-text hover:underline">{event.title}</Link>
              <p className="text-caption text-muted">{hotMeta(event, true)}</p>
            </div>
          </li>
        ))}
      </ol>
      <button type="button" onClick={onOpenAll} className="mt-2 text-caption text-link hover:underline">看完整热点榜 →</button>
    </Card>
  );
}

/** The rail's safety list: still being read, unreadable, or the week's alerts. */
export type SafetyRail = "loading" | "failed" | FrontierItem[];

/**
 * 安全警示, the last seven days, in the rail. It never depends on heat or on
 * the reader's filters (plan §4.3): an official safety notice is here from the
 * moment it is published. The card is always there — an empty week says so,
 * and so does a list that could not be read, because a missing card would read
 * as 「没有」, which is exactly the fact a pharmacist came to check.
 */
export function SafetyRailCard({ items }: { items: SafetyRail }) {
  return (
    <Card title={<span className="text-danger-strong">安全警示</span>} hint="近 7 天 · 不受热度筛选" padding="p-3">
      {items === "loading" ? (
        <div className="animate-pulse space-y-2" aria-hidden>
          <div className="h-3.5 w-11/12 rounded bg-surface-2" />
          <div className="h-3.5 w-2/3 rounded bg-surface-2" />
        </div>
      ) : items === "failed" ? <p className="text-caption text-muted">安全警示暂时读不到，刷新页面再试。</p>
        : items.length === 0 ? <p className="text-caption text-muted">近 7 天没有新的安全警示。</p> : (
        <ul className="divide-y divide-faint">
          {items.slice(0, 5).map((item) => (
            <li key={item.id} className="flex gap-2 py-2 first:pt-0">
              <span aria-hidden="true" className="w-5 shrink-0 text-ui font-semibold text-danger-strong">!</span>
              <div className="min-w-0">
                <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-ui text-text hover:underline">{item.title}</a>
                <p className="text-caption text-muted">{item.source.name} · {itemWhen(item)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** 「AI 一分钟」 from the latest daily; absent until there is a daily to take it from. */
export function AiMinuteCard({ text, onOpenDaily }: { text: string | null; onOpenDaily: () => void }) {
  if (!text) return null;
  return (
    <Card title="AI 一分钟" hint="写给医生看的" padding="p-3">
      <p className="text-ui text-text-2">{text}</p>
      <button type="button" onClick={onOpenDaily} className="mt-2 text-caption text-link hover:underline">看今天的日报 →</button>
    </Card>
  );
}
