import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCircle2 } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { Button, buttonClasses, type ButtonVariant } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { inboxErrorMessage, listInbox, markInboxRead, resolveInboxItem, type InboxItem } from "@/lib/inboxClient";

const TYPE_LABEL = { review: "需要审阅", question: "等待回答", notify: "通知" } as const;

export function InboxPage() {
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
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
    } catch (caught) {
      if (current === generation.current) { setItems([]); setError(inboxErrorMessage(caught)); }
    }
  }, [filter]);

  useEffect(() => {
    const requests = generation;
    void reload();
    return () => { requests.current++; };
  }, [reload]);

  const update = async (item: InboxItem, operation: () => Promise<InboxItem>) => {
    if (busyId) return;
    const current = generation.current;
    const currentFilter = filter;
    const mutation = ++mutationGeneration.current;
    setBusyId(item.id);
    setError(null);
    try {
      const saved = await operation();
      if (current !== generation.current || currentFilter !== filter) return;
      setItems((existing) => currentFilter === "unread" && saved.readAt
        ? existing?.filter((candidate) => candidate.id !== saved.id) ?? []
        : existing?.map((candidate) => candidate.id === saved.id ? saved : candidate) ?? []);
    } catch (caught) {
      if (current === generation.current && mutation === mutationGeneration.current) setError(inboxErrorMessage(caught));
    } finally {
      if (current === generation.current && mutation === mutationGeneration.current) setBusyId(null);
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

  return <div className="h-full overflow-y-auto">
    <main className="mx-auto w-full max-w-content space-y-5 px-6 py-8">
      <header><h1 className="font-serif text-title text-text">收件箱</h1><p className="mt-2 text-ui text-muted">审阅和提问排在前面；普通通知随后显示。</p></header>
      <SegmentedControl value={filter} onChange={(value) => setFilter(value)} aria-label="消息筛选"
        options={[{ value: "all", label: "全部" }, { value: "unread", label: "未读" }]} />
      {error && <div role="alert" className="flex items-center justify-between gap-3 rounded-card border border-error/30 bg-surface p-3 text-ui text-error">
        <span>{error}</span><Button size="sm" variant="ghost" onClick={() => void reload()}>重试</Button>
      </div>}
      {items === null ? <MemorySkeleton /> : items.length === 0 ? <EmptyState icon={Bell}
        title={filter === "unread" ? "没有未读消息" : "收件箱为空"}
        description={filter === "unread" ? "新的研究结果和待决事项会显示在这里。" : "完成研究、需要你决定或回答时，系统会在这里通知。"} />
        : <div className="space-y-3">{items.map((item) => <InboxCard key={item.id} item={item} busy={busyId === item.id}
          onRead={() => update(item, () => markInboxRead(item.id, item.revision))}
          onResolve={(actionId) => update(item, () => resolveInboxItem(item.id, actionId, item.revision))} />)}
          {cursor && <Button variant="ghost" loading={loadingMore} onClick={() => void loadMore()}>加载更多</Button>}
        </div>}
    </main>
  </div>;
}

function InboxCard({ item, busy, onRead, onResolve }: {
  item: InboxItem; busy: boolean; onRead: () => Promise<void>; onResolve: (actionId: string) => Promise<void>;
}) {
  const completed = Boolean(item.resolvedAt);
  const availableActions = item.actions.filter((action) => !completed || (item.source?.type === "digest" && action.id === "open"));
  return <Card>
    <article className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><span className="text-caption font-medium text-accent">{TYPE_LABEL[item.noticeType]}</span>
          {item.count > 1 && <span className="text-caption text-muted">合并 {item.count} 条</span>}</div>
        {completed && <span className="flex items-center gap-1 text-caption text-ok"><CheckCircle2 size={13} />已处理</span>}
      </div>
      <div><h2 className="text-body font-medium text-text">{item.title}</h2><p className="mt-1 whitespace-pre-wrap text-ui text-muted">{item.body}</p></div>
      {availableActions.length > 0 && <div className="flex flex-wrap gap-2">{availableActions.map((action) => {
        const variant: ButtonVariant = action.style === "danger" ? "danger" : action.style === "primary" ? "primary" : "ghost";
        if (item.source?.type === "digest" && action.id === "open") {
          return <a key={action.id} className={buttonClasses({ size: "sm", variant })}
            href={`/app/autopilot?digest=${encodeURIComponent(item.source.id)}`}>{action.label}</a>;
        }
        return <Button key={action.id} size="sm" variant={variant} loading={busy} onClick={() => void onResolve(action.id)}>{action.label}</Button>;
      })}</div>}
      {!item.readAt && item.actions.length === 0 && <Button size="sm" variant="ghost" loading={busy} onClick={() => void onRead()}>标为已读</Button>}
    </article>
  </Card>;
}
