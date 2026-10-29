import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Newspaper, RotateCw, Search, X } from "lucide-react";
import { isSubmitKey } from "@/lib/compositionKeys";
import {
  fetchZoneItems,
  zoneItemFeedback,
  type ZoneDetail,
  type ZoneItemsPage,
  type ZoneItemsWindow,
  type ZoneRole,
} from "@/lib/evidenceTopicClient";
import {
  frontierErrorMessage,
  hideFrontierItem,
  starFrontierItem,
  unhideFrontierItem,
  unstarFrontierItem,
  type FrontierItem,
} from "@/lib/frontierClient";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { Button } from "@/components/ui/Button";
import type { ToolbarProps } from "@/components/ui/Toolbar";
import { FrontierCard } from "../FrontierCard";
import { FrontierSkeleton } from "../FrontierSkeleton";
import { dayHeading, feedDayKey, groupByDay } from "../frontierText";
import {
  DEFAULT_WINDOW,
  WIDER_WINDOW,
  WINDOW_OPTIONS,
  inWeek,
  roleOptions,
  weekLabel,
  weekWindow,
  type ZoneItemsView,
} from "./zoneText";

/** How long 「不属于这个专区」 can be taken back before it is sent: the toast that offers it stays for ten seconds. */
export const NOT_IN_UNDO_MS = 8_000;
/** A week chosen on the chart is found by reading on, a page at a time; past this many pages the reader asks for more themselves. */
const WEEK_PAGES_MAX = 8;

type Status = "loading" | "ready" | "error";

interface Loaded {
  items: FrontierItem[];
  roleCounts: ZoneItemsPage["roleCounts"];
  nextCursor: string | null;
  total: number | null;
}

/** What the tab asks the server for: the filters the address holds, and the window the tab is on. */
interface Query {
  role: ZoneRole | null;
  picked: boolean;
  window: ZoneItemsWindow;
  q: string;
}

export interface ZoneItems {
  status: Status;
  error: string | null;
  /** The rows drawn: what the server sent, less what the reader hid, cut to the chosen week. */
  rows: FrontierItem[];
  roleCounts: ZoneItemsPage["roleCounts"];
  total: number | null;
  /** The window the list is on: the reader's, or — while they chose none — the last 30 days, wider while that holds nothing. */
  window: ZoneItemsWindow;
  hasMore: boolean;
  loadingMore: boolean;
  reload: () => void;
  more: () => void;
  star: (item: FrontierItem) => void;
  hide: (item: FrontierItem) => void;
  notIn: (item: FrontierItem) => void;
}

/**
 * A zone's 动态 list. The filters are the address's (`view`); this reads the server's pages under them, one cursor at a time, and owns
 * what happens to a row: ☆, 「不感兴趣」 and 「不属于这个专区」.
 *
 * Hidden knowledge:
 *
 * - **A tab the reader opened without choosing a window opens on 30 days, and widens while that holds nothing** (30 → 90 → all; plan
 *   4.3.7): a quiet zone is not an empty page. A window the reader chose is never widened.
 * - **The server filters by window only, so a bar of the weekly chart asks for the narrowest window that holds its week and the list is
 *   cut to the week here.** The list reads on, a page at a time, until it is past the week or out of pages (at most `WEEK_PAGES_MAX`).
 * - **「不属于这个专区」 leaves the list at once and is sent after `NOT_IN_UNDO_MS`**: the server has no way to take it back (an excluded
 *   pair stays excluded), so 撤销 is the row coming back before the word is sent. A reader who leaves the page sends it on the way out.
 */
export function useZoneItems(zone: Pick<ZoneDetail, "id" | "canEdit">, view: ZoneItemsView, enabled: boolean): ZoneItems {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ items: [], roleCounts: {}, nextCursor: null, total: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  // The window the tab widened itself to while the reader had chosen none — valid for the choices it was made under only.
  const choice = `${zone.id}|${view.role ?? ""}|${view.picked ? 1 : 0}|${view.window ?? ""}|${view.q}|${view.week ?? ""}`;
  const [widened, setWidened] = useState<{ choice: string; window: ZoneItemsWindow } | null>(null);
  const window: ZoneItemsWindow = view.week ? weekWindow(view.week) : (view.window ?? (widened?.choice === choice ? widened.window : null) ?? DEFAULT_WINDOW);
  const query: Query = useMemo(() => ({ role: view.role, picked: view.picked, window, q: view.q }), [view.role, view.picked, window, view.q]);
  const key = `${zone.id}|${query.role ?? ""}|${query.picked ? 1 : 0}|${query.window}|${query.q}`;
  const generation = useRef(0);
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; send: () => void }>());

  useEffect(() => {
    if (!enabled) return undefined;
    const mine = ++generation.current;
    setStatus("loading");
    setError(null);
    fetchZoneItems(zone.id, { role: query.role, picked: query.picked, window: query.window, q: query.q }).then(
      (page) => {
        if (mine !== generation.current) return;
        const wider = WIDER_WINDOW[query.window];
        // Nothing in a window the reader did not choose: look further back before saying the zone is empty.
        if (page.items.length === 0 && view.window === null && !view.week && !query.q && !query.role && !query.picked && wider) {
          setWidened({ choice, window: wider });
          return;
        }
        setLoaded({ items: page.items, roleCounts: page.roleCounts, nextCursor: page.nextCursor, total: page.total });
        setRemoved(new Set());
        setStatus("ready");
      },
      (caught: unknown) => {
        if (mine !== generation.current) return;
        setError(frontierErrorMessage(caught));
        setStatus("error");
      },
    );
    return () => { generation.current += 1; };
  // `key` stands for the query; `choice` for what the reader chose (a window nobody chose may be widened); `attempt` is their retry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, choice, attempt]);

  const more = useCallback(() => {
    if (!loaded.nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    fetchZoneItems(zone.id, { role: query.role, picked: query.picked, window: query.window, q: query.q, cursor: loaded.nextCursor }).then(
      (page) => {
        if (mine !== generation.current) return;
        setLoaded((current) => ({
          items: [...current.items, ...page.items.filter((item) => !current.items.some((have) => have.id === item.id))],
          roleCounts: current.roleCounts, nextCursor: page.nextCursor, total: page.total ?? current.total,
        }));
      },
      (caught: unknown) => { if (mine === generation.current) toast.error(frontierErrorMessage(caught)); },
    ).finally(() => { if (mine === generation.current) setLoadingMore(false); });
  }, [zone.id, query, loaded.nextCursor, loadingMore]);

  const rows = useMemo(() => {
    const kept = loaded.items.filter((item) => !removed.has(item.id) && !item.state.hidden);
    return view.week ? kept.filter((item) => inWeek(item, view.week!)) : kept;
  }, [loaded.items, removed, view.week]);

  // A week chosen on the chart: read on until the list is past it.
  const weekPages = useRef(0);
  useEffect(() => { weekPages.current = 0; }, [key, view.week]);
  useEffect(() => {
    if (!enabled || !view.week || status !== "ready" || loadingMore || !loaded.nextCursor || weekPages.current >= WEEK_PAGES_MAX) return;
    const last = loaded.items[loaded.items.length - 1];
    const day = last ? feedDayKey(last.timelineAt) : null;
    if (day !== null && day >= view.week) {
      weekPages.current += 1;
      more();
    }
  }, [enabled, view.week, status, loadingMore, loaded, more]);

  const replace = (item: FrontierItem) => setLoaded((current) => ({ ...current, items: current.items.map((entry) => (entry.id === item.id ? item : entry)) }));
  const star = (item: FrontierItem) => {
    void (item.state.starred ? unstarFrontierItem(item.id) : starFrontierItem(item.id)).then(
      (state) => replace({ ...item, state }),
      (caught: unknown) => toast.error(frontierErrorMessage(caught)),
    );
  };
  const hide = (item: FrontierItem) => {
    void hideFrontierItem(item.id).then(
      (state) => {
        replace({ ...item, state });
        toast.success("已隐藏", {
          action: {
            label: "撤销",
            onClick: () => { void unhideFrontierItem(item.id).then((back) => replace({ ...item, state: back }), (caught: unknown) => toast.error(frontierErrorMessage(caught))); },
          },
        });
      },
      (caught: unknown) => toast.error(frontierErrorMessage(caught)),
    );
  };
  const notIn = (item: FrontierItem) => {
    setRemoved((current) => new Set(current).add(item.id));
    const send = () => {
      const entry = pending.current.get(item.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.current.delete(item.id);
      zoneItemFeedback(zone.id, item.id, "not-in").catch((caught: unknown) => {
        setRemoved((current) => { const next = new Set(current); next.delete(item.id); return next; });
        toast.error(frontierErrorMessage(caught));
      });
    };
    pending.current.set(item.id, { timer: setTimeout(send, NOT_IN_UNDO_MS), send });
    toast.success(zone.canEdit ? "已从这个专区移出" : "已反馈：这条不属于这个专区", {
      action: {
        label: "撤销",
        onClick: () => {
          const entry = pending.current.get(item.id);
          if (entry) clearTimeout(entry.timer);
          pending.current.delete(item.id);
          setRemoved((current) => { const next = new Set(current); next.delete(item.id); return next; });
        },
      },
    });
  };
  // Leaving the page sends what is still waiting: the reader's word stands.
  useEffect(() => {
    const waiting = pending.current;
    return () => { [...waiting.values()].forEach((entry) => entry.send()); };
  }, []);

  return {
    status, error, rows, roleCounts: loaded.roleCounts, total: loaded.total, window,
    hasMore: loaded.nextCursor !== null, loadingMore,
    reload: () => setAttempt((value) => value + 1), more, star, hide, notIn,
  };
}

/* -------------------------------------------------------------------- toolbar */

/**
 * The 动态 tab's one row of controls, through the page's `toolbar` slot: the kinds of item with their counts (a kind with none is not
 * offered), 精选 or 全部, the time window, the chosen week as a mark that lets go with a press, and a search that commits a moment after
 * typing stops — never in the middle of an IME composition — or at Enter.
 */
export function useItemsToolbar({ view, set, items, count }: {
  view: ZoneItemsView;
  set: (patch: Partial<ZoneItemsView>) => void;
  items: Pick<ZoneItems, "roleCounts" | "total" | "window">;
  /** What the list holds now, for the count after the search: the rows of the week, else the server's total. */
  count: number | null;
}): ToolbarProps {
  const [text, setText] = useState(view.q);
  const composing = useRef(false);
  const [composed, setComposed] = useState(0);
  // The address changed it (a name in the rail was pressed): the box says what is searched for.
  useEffect(() => { setText(view.q); }, [view.q]);
  useEffect(() => {
    const word = text.trim();
    if (composing.current || word === view.q) return undefined;
    const timer = setTimeout(() => set({ q: word }), 300);
    return () => clearTimeout(timer);
  }, [text, composed, view.q, set]);
  const roleTotal = Object.values(items.roleCounts).reduce((sum, n) => sum + (n ?? 0), 0);
  const clear = () => { setText(""); set({ role: null, picked: false, window: null, q: "", week: null }); };
  return {
    label: "专区动态筛选",
    filters: [
      {
        kind: "chips", label: "类型", scroll: true,
        options: roleOptions(items.roleCounts, roleTotal > 0 ? roleTotal : null),
        value: view.role ?? "",
        onChange: (value) => set({ role: (value || null) as ZoneRole | null }),
      },
      {
        kind: "chips", label: "范围", neutral: "all",
        options: [{ value: "all", label: "全部" }, { value: "picked", label: "精选" }],
        value: view.picked ? "picked" : "all",
        onChange: (value) => set({ picked: value === "picked" }),
      },
      {
        kind: "chips", label: "时间", neutral: DEFAULT_WINDOW,
        options: WINDOW_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
        value: items.window,
        onChange: (value) => set({ window: value as ZoneItemsWindow }),
      },
      ...(view.week ? [{
        kind: "toggle" as const, label: weekLabel(view.week), pressed: true, icon: X, iconEnd: true, pinned: true,
        onChange: () => set({ week: null }),
      }] : []),
    ],
    search: {
      label: "搜索当前专区的动态",
      value: text,
      maxLength: 200,
      onChange: setText,
      onClear: () => { setText(""); set({ q: "" }); },
      inputProps: {
        onKeyDown: (event) => { if (isSubmitKey(event)) { event.preventDefault(); set({ q: text.trim() }); } },
        onCompositionStart: () => { composing.current = true; },
        onCompositionEnd: (event) => { composing.current = false; setText(event.currentTarget.value); setComposed((value) => value + 1); },
      },
    },
    summary: count !== null ? `共 ${count.toLocaleString("zh-CN")} 条` : undefined,
    onClear: clear,
  };
}

/* ----------------------------------------------------------------------- list */

/**
 * The 动态 list: the feed's cards under the Beijing day they belong to, the zone's own entry in each card's ⋯ (「不属于这个专区」), and
 * its four states — a skeleton, an empty list that says where to go from it, an error with 重试, and the content with 「加载更多」.
 */
export function ZoneItemsList({ zone, view, items, onClear }: {
  zone: Pick<ZoneDetail, "id" | "title" | "canEdit">;
  view: ZoneItemsView;
  items: ZoneItems;
  /** Takes the filters and the search away: the way on from a list they emptied. */
  onClear: () => void;
}) {
  const days = useMemo(() => (view.q ? [] : groupByDay(items.rows)), [items.rows, view.q]);
  if (items.status === "error" && items.rows.length === 0) return <LoadError message={items.error ?? "暂时读不到动态，请稍后重试。"} onRetry={items.reload} />;
  if (items.status === "loading" && items.rows.length === 0) return <FrontierSkeleton />;
  const filtered = Boolean(view.role || view.picked || view.q || view.week || view.window);
  if (items.rows.length === 0 && !items.hasMore) {
    return view.q ? (
      <EmptyState icon={Search} title={`没有找到和“${view.q}”相关的动态`} action={<Button variant="secondary" onClick={onClear}>清除搜索</Button>} />
    ) : filtered ? (
      <EmptyState icon={Newspaper} title="没有结果" action={<Button variant="secondary" onClick={onClear}>清除筛选</Button>} />
    ) : (
      <EmptyState icon={Newspaper} title="正在为这个专区搜集内容，通常几分钟内出现第一批"
        action={<Button variant="secondary" onClick={items.reload}><RotateCw size={16} aria-hidden="true" />重新加载</Button>} />
    );
  }
  const card = (item: FrontierItem, grouped: boolean) => (
    <FrontierCard key={item.id} item={item} grouped={grouped} markSelected={!view.picked} backLabel={zone.title}
      onStar={items.star} onHide={items.hide}
      extraActions={[{ label: "不属于这个专区", onSelect: () => items.notIn(item) }]} />
  );
  return (
    <section id="zone-items-list" aria-label="专区动态" className="isolate space-y-8">
      {view.q ? (
        <ul aria-label="搜索结果">{items.rows.map((item) => card(item, false))}</ul>
      ) : days.map((group, index) => {
        const whole = index < days.length - 1 || !items.hasMore;
        return (
          <section key={group.key} aria-labelledby={`zone-day-${group.key}`}>
            <div data-day-heading="" className="sticky top-[var(--page-chrome-h,0px)] z-sticky -mx-1 flex items-center gap-3 bg-bg px-1 py-2">
              <h2 id={`zone-day-${group.key}`} className="flex min-w-0 flex-1 items-baseline gap-1">
                <span className="text-body font-semibold leading-6 text-text">{dayHeading(group, false)}</span>
                {whole && <span className="text-caption tabular-nums text-text-3">· {group.items.length} 条</span>}
              </h2>
            </div>
            <ul>{group.items.map((item) => card(item, true))}</ul>
          </section>
        );
      })}
      {items.hasMore && <Button variant="secondary" loading={items.loadingMore} onClick={items.more}>加载更多</Button>}
    </section>
  );
}
