import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Tag, type TagTone } from "@/components/ui/Tag";
import { EmptyState } from "@/components/cards/EmptyState";
import { FrontierSkeleton } from "./FrontierSkeleton";
import { useEvidenceScope } from "./useEvidenceScope";
import {
  evidenceUpkeepErrorMessage,
  fetchEvidenceChanges,
  type EvidenceChangeEntry,
} from "@/lib/evidenceUpkeepClient";

const day = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("zh-CN", { year: "numeric", month: "numeric", day: "numeric" });
};
/** A correction or a withdrawal is the entry a reader should not miss; the rest is history. */
const tone = (category: EvidenceChangeEntry["category"]): TagTone =>
  category === "withdrawal" || category === "correction" ? "warn" : "neutral";

/**
 * 变更记录 — the public history of a zone (or of one of its cards): what changed, when, why it did, and what made it change. Every entry is a
 * sentence the server made from facts; the list only grows. Not mounted by itself: the zone page and the reading page place it.
 */
export function EvidenceChangeLog({ zoneId, cardId, pageSize = 20 }: { zoneId: string; cardId?: string; pageSize?: number }) {
  const [entries, setEntries] = useState<EvidenceChangeEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const capture = useEvidenceScope(`${zoneId}:${cardId ?? ""}:${attempt}`);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchEvidenceChanges(zoneId, { cardId, limit: pageSize })
      .then((page) => {
        if (!active) return;
        setEntries(page.items);
        setNext(page.nextBefore);
      })
      .catch((reason) => {
        if (active) setError(evidenceUpkeepErrorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [zoneId, cardId, pageSize, attempt]);
  const loadMore = () => {
    if (!next || more) return;
    const current = capture();
    setMore(true);
    setError(null);
    fetchEvidenceChanges(zoneId, { cardId, before: next, limit: pageSize })
      .then((page) => {
        if (!current()) return;
        setEntries((previous) => [...previous, ...page.items]);
        setNext(page.nextBefore);
      })
      .catch((reason) => current() && setError(evidenceUpkeepErrorMessage(reason)))
      .finally(() => current() && setMore(false));
  };
  if (loading) return <FrontierSkeleton />;
  if (error && !entries.length)
    return (
      <EmptyState
        title={error}
        action={
          <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
            重试
          </Button>
        }
      />
    );
  if (!entries.length) return <EmptyState title="还没有变更记录" description="更正、更新和撤回都会记在这里，只增不改。" />;
  return (
    <section aria-label="变更记录" className="max-w-measure-body">
      <ol className="divide-y divide-border">
        {entries.map((entry) => (
          <li key={entry.id} className="space-y-1 py-3">
            <div className="flex flex-wrap items-center gap-2 text-caption text-muted">
              <time dateTime={entry.occurredAt}>{day(entry.occurredAt)}</time>
              <Tag tone={tone(entry.category)}>{entry.categoryLabel}</Tag>
              <span>由{entry.triggerLabel}触发</span>
              {!cardId && entry.cardTitle && <span className="truncate">{entry.cardTitle}</span>}
            </div>
            <p className="text-ui text-text">{entry.summary}</p>
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="mt-3 text-ui text-error">
          {error}
        </p>
      )}
      {next && (
        <div className="mt-3">
          <Button variant="text" loading={more} onClick={loadMore}>
            查看更早的记录
          </Button>
        </div>
      )}
    </section>
  );
}
