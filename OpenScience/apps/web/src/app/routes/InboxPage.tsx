import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AlertCircle, Bell, Bot, CheckCheck, CheckCircle2, ShieldAlert } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { Button, buttonClasses, type ButtonVariant } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { PageHeader } from "@/components/layout/PageHeader";
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
import { layoutInbox, severityOf, timeOfDay, type InboxEntry } from "@/lib/inboxGroups";
import { labelFor } from "@/lib/statusLabel";
import { cn } from "@/lib/cn";

// What a notice is, said as what happened rather than as a chore assigned to
// the reader (WP8, 2026-09-20): the inbox records, it does not hand out work.
const TYPE_LABEL: Record<string, string> = { review: "有结论要核对", question: "等待回答", notify: "通知" };

/**
 * The inbox (contract C1, appendix C §3.4).
 *
 * It notifies at three moments — a run finished, something needs you, a
 * conclusion changed — and says the rest quietly. Automated work (evaluation
 * cells, autopilot episodes) is recorded but arrives read and folds away; on
 * 2026-09-17, 29 of the 31 unread items one account held were machine runs.
 * A clinical-safety finding is the one kind allowed to interrupt: unread, it
 * is pinned above everything in the danger colour; every other item is a
 * plain line in its day.
 *
 * Any unread item can be marked read — the most common item, a finished run,
 * carries an 「打开对话」 action and used to have no way to be marked read at
 * all (B §1e) — and 「全部已读」 does the whole inbox in one request.
 */
export function InboxPage() {
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unreadTotal, setUnreadTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
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

  const applySaved = (saved: InboxItem, currentFilter: "all" | "unread") => {
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

  /** A folded line stands for several items; reading it reads each of them. */
  const readMany = async (group: InboxItem[]) => {
    for (const item of group.filter((candidate) => !candidate.readAt)) {
      await update(item, () => markInboxRead(item.id, item.revision));
    }
  };

  /**
   * Following an item's link reads it: the researcher has gone to look. Not
   * awaited — the navigation must not wait on the inbox — and a failure only
   * leaves the item unread, which is what it was.
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
      const { updated } = await markAllInboxRead();
      announceInboxChanged();
      setStatus(updated > 0 ? `已把 ${updated} 条标为已读。` : "没有未读消息。");
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

  const layout = useMemo(() => (items ? layoutInbox(items) : null), [items]);
  const unreadHere = (items ?? []).some((item) => !item.readAt);
  const hasUnread = unreadTotal != null ? unreadTotal > 0 : unreadHere;

  const renderEntry = (entry: InboxEntry) => entry.kind === "completions"
    ? <CompletionsRow key={`completions-${entry.items[0].id}`} items={entry.items}
        busy={entry.items.some((item) => item.id === busyId)}
        onRead={() => void readMany(entry.items)} onOpened={readOnOpen} />
    : <InboxRow key={entry.item.id} item={entry.item} busy={busyId === entry.item.id}
        onRead={() => update(entry.item, () => markInboxRead(entry.item.id, entry.item.revision))}
        onResolve={(actionId) => update(entry.item, () => resolveInboxItem(entry.item.id, actionId, entry.item.revision))}
        onOpened={readOnOpen} />;

  return <div className="h-full overflow-y-auto">
    <div className="mx-auto w-full max-w-content space-y-5 px-6 py-8">
      <PageHeader
        title="收件箱"
        description="研究完成、需要你决定、或者结论有变化时才会通知；涉及临床安全的放在最前。"
        actions={<Button variant="ghost" size="sm" loading={markingAll} disabled={!hasUnread}
          title={hasUnread ? undefined : "没有未读消息"} onClick={() => void readAll()}>
          {!markingAll && <CheckCheck size={16} aria-hidden="true" />}全部已读
        </Button>}
      />
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl value={filter} onChange={(value) => { setStatus(null); setFilter(value); }} aria-label="消息筛选"
          options={[{ value: "all", label: "全部" }, { value: "unread", label: "未读" }]} />
        {unreadTotal != null && unreadTotal > 0 && <span className="text-caption text-muted">{unreadTotal} 条未读</span>}
        <p role="status" className="text-caption text-muted">{status}</p>
      </div>
      {error && <div role="alert" className="flex items-center justify-between gap-3 rounded-card border border-danger bg-danger-soft p-3 text-ui text-danger-strong">
        <span>{error}</span><Button size="sm" variant="ghost" onClick={() => void reload()}>重试</Button>
      </div>}
      {items === null || layout === null ? <MemorySkeleton /> : items.length === 0 ? <EmptyState icon={Bell}
        title={filter === "unread" ? "没有未读消息" : "收件箱为空"}
        description={filter === "unread" ? "新的研究结果和待决事项会显示在这里。" : "研究完成、需要你决定或回答时，这里会通知你。"} />
        : <div className="space-y-6">
          {layout.pinned.length > 0 && (
            <section aria-labelledby="inbox-pinned">
              <h2 id="inbox-pinned" className="mb-2 flex items-center gap-1.5 text-ui font-semibold text-danger-strong">
                <ShieldAlert size={16} aria-hidden="true" />涉及临床安全 · 未读 {layout.pinned.length} 条
              </h2>
              <ul className="space-y-2">{layout.pinned.map((item) => renderEntry({ kind: "item", item }))}</ul>
            </section>
          )}
          {layout.days.map((day) => (
            <section key={day.key} aria-labelledby={`inbox-day-${day.key}`}>
              <h2 id={`inbox-day-${day.key}`} className="mb-2 text-caption font-medium text-muted">{day.label}</h2>
              {day.entries.length > 0 && <ul className="space-y-2">{day.entries.map(renderEntry)}</ul>}
              {day.silent.length > 0 && <SilentFold items={day.silent} className={day.entries.length > 0 ? "mt-2" : undefined} />}
            </section>
          ))}
          {cursor && <Button variant="ghost" loading={loadingMore} onClick={() => void loadMore()}>加载更多</Button>}
        </div>}
    </div>
  </div>;
}

/** Where an item's action goes when it is navigation rather than a decision. */
function actionHref(item: InboxItem, action: InboxAction): string | null {
  if (action.id !== "open" || !item.source) return null;
  // `Link`, not `<a href>`: a bare anchor inside the shell reloaded the whole
  // application to move between two of its own pages (U10).
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

function InboxRow({ item, busy, onRead, onResolve, onOpened }: {
  item: InboxItem;
  busy: boolean;
  onRead: () => Promise<void>;
  onResolve: (actionId: string) => Promise<void>;
  onOpened: (item: InboxItem) => void;
}) {
  const severity = severityOf(item);
  const unread = !item.readAt;
  const completed = Boolean(item.resolvedAt);
  // An `open` action is navigation, not a decision, so it outlives being
  // handled: a notice read yesterday still reaches the run it names. Every
  // other action is a decision and disappears once made.
  const availableActions = item.actions.filter((action) => !completed || actionHref(item, action) != null);
  // A server-merged day of completions says its count in its title
  // (「9月18日完成 3 项研究」); anything else merged says so here.
  const mergedRuns = item.groupKey?.startsWith("run-finished:") ?? false;
  return <li
    className={cn(
      "rounded-card border p-4",
      severity === "safety" ? "border-danger bg-danger-soft" : "border-border bg-surface",
    )}
  >
    <article className="space-y-2" aria-label={item.title}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
        {severity === "safety" && <span className="inline-flex items-center gap-1 font-semibold text-danger-strong">
          <ShieldAlert size={16} aria-hidden="true" />临床安全</span>}
        {severity === "attention" && <span className="inline-flex items-center gap-1 font-medium text-warn-strong">
          <AlertCircle size={16} aria-hidden="true" />{labelFor(TYPE_LABEL, item.noticeType, "值得一看")}</span>}
        {severity === "info" && item.noticeType !== "notify" && <span className="text-muted">{labelFor(TYPE_LABEL, item.noticeType, "通知")}</span>}
        {item.count > 1 && !mergedRuns && <span className="text-muted">合并 {item.count} 条</span>}
        <span className="ml-auto flex items-center gap-2 text-muted">
          {completed && <span className="inline-flex items-center gap-1 text-ok"><CheckCircle2 size={16} aria-hidden="true" />已处理</span>}
          <time dateTime={item.createdAt}>{timeOfDay(item.createdAt)}</time>
        </span>
      </div>
      <h3 className={cn("flex items-center gap-2 text-body text-text", unread ? "font-semibold" : "font-normal")}>
        {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden="true" />}
        <span className="min-w-0">{item.title}</span>
        {unread && <span className="sr-only">（未读）</span>}
      </h3>
      <InboxBody body={item.body} />
      {(availableActions.length > 0 || unread) && <div className="flex flex-wrap gap-2 pt-1">
        {availableActions.map((action) => {
          const variant: ButtonVariant = action.style === "danger" ? "danger" : action.style === "primary" ? "primary" : "ghost";
          const href = actionHref(item, action);
          if (href) {
            return <Link key={action.id} className={buttonClasses({ size: "sm", variant })} to={href}
              onClick={() => onOpened(item)}>{action.label}</Link>;
          }
          return <Button key={action.id} size="sm" variant={variant} loading={busy} onClick={() => void onResolve(action.id)}>{action.label}</Button>;
        })}
        {unread && <Button size="sm" variant="ghost" loading={busy} onClick={() => void onRead()}>标为已读</Button>}
      </div>}
    </article>
  </li>;
}

/**
 * A day's routine completions from before the control plane merged them
 * itself, as one line: 「研究已完成 × 4」, each run one click away.
 */
function CompletionsRow({ items, busy, onRead, onOpened }: {
  items: InboxItem[];
  busy: boolean;
  onRead: () => void;
  onOpened: (item: InboxItem) => void;
}) {
  const unread = items.filter((item) => !item.readAt).length;
  const review = items.filter((item) => item.title !== "研究已完成").length;
  return <li className="rounded-card border border-border bg-surface p-4">
    <article className="space-y-2" aria-label={`研究已完成 × ${items.length}`}>
      <div className="flex items-center gap-2 text-caption text-muted">
        {review > 0 && <span>其中 {review} 项有结论要核对</span>}
        <time className="ml-auto" dateTime={items[0].createdAt}>{timeOfDay(items[0].createdAt)}</time>
      </div>
      <h3 className={cn("flex items-center gap-2 text-body text-text", unread ? "font-semibold" : "font-normal")}>
        {unread > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden="true" />}
        研究已完成 × {items.length}
        {unread > 0 && <span className="sr-only">（{unread} 条未读）</span>}
      </h3>
      <Disclosure summary={<>逐条查看</>}>
        <ul className="space-y-1">
          {items.map((item) => {
            const href = item.source ? `/app/runs?run=${encodeURIComponent(item.source.id)}` : null;
            return <li key={item.id} className="flex items-center gap-2 text-ui">
              <time className="w-12 shrink-0 tabular-nums text-muted" dateTime={item.createdAt}>{timeOfDay(item.createdAt)}</time>
              <span className={cn("min-w-0 flex-1 truncate", !item.readAt && "font-medium")}>{item.title}</span>
              {href && <Link to={href} onClick={() => onOpened(item)} className="shrink-0 text-link hover:underline">打开对话</Link>}
            </li>;
          })}
        </ul>
      </Disclosure>
      {unread > 0 && <Button size="sm" variant="ghost" loading={busy} onClick={onRead}>标为已读</Button>}
    </article>
  </li>;
}

/**
 * Automated work of one day — evaluation cells, autopilot episodes. Recorded,
 * never counted, never pushed; folded, so a batch of forty cells is one line.
 */
function SilentFold({ items, className }: { items: InboxItem[]; className?: string }) {
  return <Disclosure
    className={className}
    summaryClassName="text-caption"
    summary={<span className="inline-flex items-center gap-1"><Bot size={16} aria-hidden="true" />自动运行 {items.length} 条（评测与主动科研，不计入未读）</span>}
  >
    <ul className="space-y-1 pl-5">
      {items.map((item) => {
        const open = item.actions.find((action) => actionHref(item, action) != null);
        const href = open ? actionHref(item, open) : null;
        return <li key={item.id} className="flex items-center gap-2 text-caption text-muted">
          <time className="w-12 shrink-0 tabular-nums" dateTime={item.createdAt}>{timeOfDay(item.createdAt)}</time>
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          {href && open && <Link to={href} className="shrink-0 text-link hover:underline">{open.label}</Link>}
        </li>;
      })}
    </ul>
  </Disclosure>;
}
