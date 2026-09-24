import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check, CheckCheck, ShieldAlert } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { FilterChips } from "@/components/ui/FilterChips";
import { IconButton } from "@/components/ui/IconButton";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Tag";
import { InboxBody } from "@/components/inbox/InboxBody";
import {
  announceInboxChanged,
  inboxErrorMessage,
  listInbox,
  markAllInboxRead,
  markInboxRead,
  resolveInboxItem,
  type InboxAction,
  type InboxItem,
} from "@/lib/inboxClient";
import { inboxWhen, orderInbox, severityOf } from "@/lib/inboxGroups";
import { splitNoticeBody } from "@/lib/qualityNotices";
import { useOperator } from "@/lib/useOperator";
import { cn } from "@/lib/cn";

type Filter = "all" | "unread";

/** What a notice still asks of the reader, in two characters (2026-09-23 inventory §1.9). */
const WAITING: Record<string, string> = { question: "待回答", review: "待核对" };

/**
 * The inbox (contract C1): one list, in the column every page shares.
 *
 * A notice is a row — unread dot, title, one line of what happened, time —
 * and the whole row opens it: a notice that names a conversation, a daily or a
 * memory goes there, and reading it marks it read; one that names nothing
 * opens in place. 「标为已读」 appears on hover, a decision the notice asks
 * for is in its 「⋯」. Unread clinical-safety findings stay above everything,
 * the one class allowed to interrupt.
 *
 * What it no longer is (2026-09-23 plan §5.8): a card with two buttons per
 * notice, a segmented control, day headings, a subtitle about when it
 * notifies, and 「自动运行 N 条」 — an evaluation writes no notice any more and
 * a proactive result is an ordinary one, so every item the list route returns
 * is rendered as a row and no grouping field is read.
 */
export function InboxPage() {
  const operator = useOperator();
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unreadTotal, setUnreadTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const generation = useRef(0);
  const mutationGeneration = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    setItems(null);
    setLoadingMore(false);
    setBusyId(null);
    mutationGeneration.current++;
    setError(null);
    try {
      const page = await listInbox({ unread: filter === "unread" });
      if (current !== generation.current) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setUnreadTotal(typeof page.unreadTotal === "number" ? page.unreadTotal : null);
    } catch (caught) {
      if (current === generation.current) { setItems([]); setError(inboxErrorMessage(caught)); }
    }
  }, [filter]);

  useEffect(() => {
    const requests = generation;
    void reload();
    return () => { requests.current++; };
  }, [reload]);

  const applySaved = (saved: InboxItem, currentFilter: Filter) => {
    setItems((existing) => currentFilter === "unread" && saved.readAt
      ? existing?.filter((candidate) => candidate.id !== saved.id) ?? []
      : existing?.map((candidate) => candidate.id === saved.id ? saved : candidate) ?? []);
  };

  const update = async (item: InboxItem, operation: () => Promise<InboxItem>) => {
    if (busyId) return;
    const current = generation.current;
    const currentFilter = filter;
    const mutation = ++mutationGeneration.current;
    const wasUnread = !item.readAt;
    setBusyId(item.id);
    setError(null);
    try {
      const saved = await operation();
      if (current !== generation.current || currentFilter !== filter) return;
      applySaved(saved, currentFilter);
      if (wasUnread && saved.readAt) {
        setUnreadTotal((count) => (count == null ? count : Math.max(0, count - 1)));
        announceInboxChanged();
      }
    } catch (caught) {
      if (current === generation.current && mutation === mutationGeneration.current) setError(inboxErrorMessage(caught));
    } finally {
      if (current === generation.current && mutation === mutationGeneration.current) setBusyId(null);
    }
  };

  /**
   * Opening a notice reads it: the researcher has gone to look. Not awaited —
   * a navigation must not wait on the inbox — and a failure only leaves the
   * item unread, which is what it was.
   */
  const readOnOpen = (item: InboxItem) => {
    if (item.readAt) return;
    void markInboxRead(item.id, item.revision)
      .then((saved) => {
        applySaved(saved, filter);
        setUnreadTotal((count) => (count == null ? count : Math.max(0, count - 1)));
        announceInboxChanged();
      })
      .catch(() => undefined);
  };

  const readAll = async () => {
    setMarkingAll(true);
    setError(null);
    try {
      await markAllInboxRead();
      announceInboxChanged();
      await reload();
    } catch (caught) {
      setError(inboxErrorMessage(caught));
    } finally {
      setMarkingAll(false);
    }
  };

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const requestedCursor = cursor;
    const requestedFilter = filter;
    const current = generation.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listInbox({ unread: requestedFilter === "unread", cursor: requestedCursor });
      if (current !== generation.current || requestedFilter !== filter || requestedCursor !== cursor) return;
      setItems((existing) => {
        const known = new Set((existing ?? []).map((item) => item.id));
        return [...(existing ?? []), ...page.items.filter((item) => !known.has(item.id))];
      });
      setCursor(page.nextCursor);
    } catch (caught) {
      if (current === generation.current) setError(inboxErrorMessage(caught));
    } finally {
      if (current === generation.current) setLoadingMore(false);
    }
  };

  const order = items ? orderInbox(items) : null;
  const hasUnread = unreadTotal != null ? unreadTotal > 0 : (items ?? []).some((item) => !item.readAt);

  const row = (item: InboxItem) => (
    <InboxRow
      key={item.id}
      item={item}
      operator={operator}
      busy={busyId === item.id}
      open={openId === item.id}
      onToggle={() => { setOpenId((current) => (current === item.id ? null : item.id)); readOnOpen(item); }}
      onRead={() => void update(item, () => markInboxRead(item.id, item.revision))}
      onResolve={(actionId) => void update(item, () => resolveInboxItem(item.id, actionId, item.revision))}
      onOpened={readOnOpen}
    />
  );

  return (
    <PageShell
      title="收件箱"
      actions={(
        <Button variant="text" loading={markingAll} disabled={!hasUnread} onClick={() => void readAll()}>
          {!markingAll && <CheckCheck size={16} aria-hidden="true" />}全部已读
        </Button>
      )}
    >
      <FilterChips
        label="消息筛选"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "全部" },
          { value: "unread", label: "未读", ...(unreadTotal ? { count: unreadTotal } : {}) },
        ]}
      />
      {error && <LoadError className="mt-4" message={error} onRetry={() => void reload()} />}
      <div className="mt-4">
        {items === null || order === null ? <RunsSkeleton filter={false} />
          : items.length === 0 ? (!error && <EmptyState icon={Bell} title={filter === "unread" ? "没有未读消息" : "收件箱为空"} />)
            : (
              <>
                {order.pinned.length > 0 && (
                  <section aria-labelledby="inbox-pinned" className="mb-4">
                    <h2 id="inbox-pinned" className="mb-1 flex items-center gap-1.5 px-2 text-caption font-medium text-danger-strong">
                      <ShieldAlert size={16} aria-hidden="true" />涉及临床安全 · 未读 {order.pinned.length} 条
                    </h2>
                    <List label="涉及临床安全">{order.pinned.map(row)}</List>
                  </section>
                )}
                {order.rest.length > 0 && <List label="消息">{order.rest.map(row)}</List>}
                {cursor && (
                  <Button variant="secondary" className="mt-4" loading={loadingMore} onClick={() => void loadMore()}>加载更多</Button>
                )}
              </>
            )}
      </div>
    </PageShell>
  );
}

/** Where an item's action goes when it is navigation rather than a decision. */
function actionHref(item: InboxItem, action: InboxAction): string | null {
  if (action.id !== "open" || !item.source) return null;
  // A digest is either an autopilot briefing or the frontier daily of a day;
  // the daily names itself `frontier-daily:<YYYY-MM-DD>`, the key it is pushed
  // under, and opens on that issue.
  const frontierDay = item.source.type === "digest" ? /^frontier-daily:(\d{4}-\d{2}-\d{2})$/.exec(item.source.id)?.[1] : undefined;
  if (frontierDay) return `/app/frontier?view=daily&day=${frontierDay}`;
  if (item.source.type === "digest") return `/app/autopilot?digest=${encodeURIComponent(item.source.id)}`;
  // A notice names a run, and a run is read in the conversation it happened in.
  // Only the ledger knows which conversation that is, so this stays the run's
  // own address and `RunRedirect` resolves it (router.tsx).
  if (item.source.type === "run") return `/app/runs?run=${encodeURIComponent(item.source.id)}`;
  // A memory's confirm, correct and delete controls are on its own page.
  if (item.source.type === "memory") return `/app/memory?record=${encodeURIComponent(item.source.id)}`;
  return null;
}

function InboxRow({ item, operator, busy, open, onToggle, onRead, onResolve, onOpened }: {
  item: InboxItem;
  operator: boolean;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onRead: () => void;
  onResolve: (actionId: string) => void;
  onOpened: (item: InboxItem) => void;
}) {
  const unread = !item.readAt;
  const safety = severityOf(item) === "safety";
  const resolved = Boolean(item.resolvedAt);
  const openAction = item.actions.find((action) => actionHref(item, action) != null);
  const href = openAction ? actionHref(item, openAction) : null;
  // A decision disappears once made; the way to what the notice names does not.
  const decisions = resolved ? [] : item.actions.filter((action) => actionHref(item, action) == null);
  const waiting = !resolved && (unread || decisions.length > 0) ? WAITING[item.noticeType] : undefined;
  const decided = resolved && item.resolution != null && item.resolution.actionId !== "open";
  const body = splitNoticeBody(item.body);
  const hasBody = body.lines.length > 0 || (operator && body.technical.length > 0);
  return (
    <ListRow
      leading={(
        <span
          aria-hidden="true"
          className={cn("mt-2 h-1.5 w-1.5 self-start rounded-full", unread && (safety ? "bg-danger" : "bg-accent"))}
        />
      )}
      title={<>{item.title}{unread && <span className="sr-only">（未读）</span>}</>}
      to={href ?? undefined}
      onOpen={href ? () => onOpened(item) : onToggle}
      expanded={href ? undefined : open}
      unread={unread}
      muted={!unread}
      meta={hasBody ? <InboxBody body={item.body} open={!href && open} operator={operator} /> : undefined}
      trailing={(
        <>
          {waiting && <Tag>{waiting}</Tag>}
          {decided && <span>已处理</span>}
          <time dateTime={item.createdAt} className="tabular-nums">{inboxWhen(item.createdAt)}</time>
        </>
      )}
      actions={unread ? <IconButton icon={Check} label="标为已读" size="sm" disabled={busy} onClick={onRead} /> : undefined}
      menu={decisions.length > 0 ? (
        <Menu
          label="处理"
          items={decisions.map((action) => ({
            label: action.label,
            destructive: action.style === "danger",
            disabled: busy,
            onSelect: () => onResolve(action.id),
          }))}
        />
      ) : undefined}
    />
  );
}
