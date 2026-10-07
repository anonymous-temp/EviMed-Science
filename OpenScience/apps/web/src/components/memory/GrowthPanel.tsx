import { TrendingUp } from "lucide-react";
import { fetchMemoryGrowth, fetchMemoryLearned, type MemoryLearnedItem } from "@/lib/memoryClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { CapsuleGrowth } from "@/components/capsule/CapsuleGrowth";
import { GROWTH_DEFAULT_WIDTH, growthView } from "@/components/capsule/growthModel";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { List, ListRow } from "@/components/ui/ListRow";
import { GroupHeader, MemoryListRow } from "./MemoryRows";

/**
 * A calendar day (「2026-09-22」, already in the researcher's zone) as 「9月22日」, with the year when it is not this one. Read
 * from its parts: parsing it as a date would put it in UTC, and a day west of Greenwich would read as the one before.
 */
export function calendarDay(day: string, now: Date = new Date()): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return "";
  return year === now.getFullYear() ? `${month}月${date}日` : `${year}年${month}月${date}日`;
}

/** What a day's row says: what was learned, with the title it was learned under. */
function sentence(item: MemoryLearnedItem): string {
  return item.kind === "start" ? "开始记住你" : `${item.kind === "improved" ? "改进" : "学会"}：${item.title}`;
}

/**
 * 「成长」, the fourth tab (2026-10-07 plan §3.2): the line of how much the
 * capsule has come to hold — the one chart this list page may carry
 * (`CapsuleGrowth`) — and under it, day by day, what was learned when.
 *
 * Both reads are made when the tab is opened, not with the page: the line
 * counts every row the account has, and a researcher who came for their
 * preferences should not wait for it. Each can fail without the other — the
 * list is still true without the line — and one error line with 重试 says so.
 *
 * A row that is a method or a handbook opens its drawer, as every row does;
 * the beginning, and anything this page cannot find in its lists (a method
 * stopped since), is text.
 */
export function GrowthPanel({ canOpen, onOpen }: {
  /** Whether a method or handbook of this id is on the page, so its row can open it. */
  canOpen: (what: "method" | "handbook", id: string) => boolean;
  onOpen: (what: "method" | "handbook", id: string) => void;
}) {
  const { data, failed, reload } = useCapsuleData(async () => {
    const [growth, learned] = await Promise.all([fetchMemoryGrowth().catch(() => null), fetchMemoryLearned().catch(() => null)]);
    return { growth, learned };
  });
  if (data === null) return failed ? <LoadError message="暂时读不到成长记录。" onRetry={reload} /> : <RunsSkeleton filter={false} />;
  const days = data.learned?.days ?? [];
  const unread = data.growth === null || data.learned === null;
  return (
    <div className="space-y-6">
      {(unread || failed) && <LoadError message="没有读到全部成长记录。" onRetry={reload} />}
      <CapsuleGrowth growth={data.growth} />
      {days.length > 0 ? (
        <div className="space-y-6">
          {days.map((entry) => (
            <section key={entry.day}>
              <GroupHeader>{calendarDay(entry.day)}</GroupHeader>
              <List label={`${calendarDay(entry.day)}学到的`}>
                {entry.items.map((item) => (item.what && item.id && canOpen(item.what, item.id)
                  ? <MemoryListRow key={`${item.kind}:${item.id}`} title={sentence(item)} onOpen={() => onOpen(item.what as "method" | "handbook", item.id as string)} />
                  : <ListRow key={`${item.kind}:${item.id ?? "start"}`} title={sentence(item)} />))}
              </List>
            </section>
          ))}
        </div>
      ) : !unread && !growthView(data.growth, GROWTH_DEFAULT_WIDTH) ? (
        <EmptyState icon={TrendingUp} title="还没有成长记录" description="学会的做法和经验，会按天出现在这里。" />
      ) : null}
    </div>
  );
}
