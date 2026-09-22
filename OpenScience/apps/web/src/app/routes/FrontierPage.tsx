import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ArrowUp, Clock3, Filter, Newspaper, Search } from "lucide-react";
import { getWebProjectId } from "@/lib/apiClient";
import {
  fetchFrontierForYou,
  fetchFrontierHot,
  fetchFrontierStatus,
  frontierAbsence,
  frontierErrorMessage,
  FRONTIER_LANES,
  FRONTIER_SPECIALTIES,
  FRONTIER_WINDOWS,
  hideFrontierItem,
  listFrontierItems,
  markFrontierItemRead,
  saveFrontierItemToLibrary,
  starFrontierItem,
  unhideFrontierItem,
  unstarFrontierItem,
  useFrontierFeature,
  type FrontierForYou,
  type FrontierHotEvent,
  type FrontierItem,
  type FrontierItemState,
  type FrontierItemsQuery,
  type FrontierStatus,
  type FrontierWindow,
} from "@/lib/frontierClient";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FrontierSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { DailyArchive, DailyIssue, useFrontierDaily } from "@/components/frontier/DailyView";
import { ForYouBlock } from "@/components/frontier/ForYouBlock";
import { FrontierCard } from "@/components/frontier/FrontierCard";
import { FrontierFilters, type FrontierFilterValue } from "@/components/frontier/FrontierFilters";
import { AiMinuteCard, HotList, HotRailCard, SafetyRailCard, type SafetyRail } from "@/components/frontier/FrontierRail";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { SourcesDisclosure } from "@/components/frontier/SourcesDisclosure";
import { clockOrDate, groupByDay } from "@/components/frontier/frontierText";

type PageView = "selected" | "hot" | "daily" | "all";

const VIEWS: { value: PageView; label: string }[] = [
  { value: "selected", label: "精选" },
  { value: "hot", label: "热点" },
  { value: "daily", label: "日报" },
  { value: "all", label: "全部" },
];

/** One page of the feed; the server caps it at 50 and defaults to 30. */
const PAGE_SIZE = 30;
/** 「有 N 条新的」 asks this often (plan §10.5.2): almost every answer is an empty 304. */
const STATUS_POLL_MS = 120_000;
/** A plugin in one of these states means the list is the last one read. */
const STALE_PLUGIN = new Set(["unreachable", "degraded", "incompatible"]);

function readView(value: string | null): PageView {
  return value === "hot" || value === "daily" || value === "all" ? value : "selected";
}
function readKey(value: string | null, table: readonly { key: string }[]): string {
  return value && table.some((entry) => entry.key === value) ? value : "";
}
function readWindow(value: string | null): FrontierWindow | "" {
  return FRONTIER_WINDOWS.includes(value as FrontierWindow) ? value as FrontierWindow : "";
}
function readDay(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** A page of the feed as it is on screen, with the query it answers and when it was read. */
interface Listing {
  key: string;
  items: FrontierItem[];
  nextCursor: string | null;
  version: string | null;
  loadedAt: number;
}

/**
 * 「前沿动态」 (plan ch.4): one page, four views on one control — 精选, 热点,
 * 日报, 全部 — with a server-side search box, the filter row, 「与你相关」, the
 * day-grouped feed and a rail of 今日热点, 安全警示 and 「AI 一分钟」, and the
 * public list of sources folded at the foot.
 *
 * Hidden knowledge:
 *
 *  - Everything that describes the reader's position lives in the URL
 *    (`?view=&q=&lane=&specialty=&window=&starred=&day=`), so a notification's
 *    link (`?view=daily&day=…`), Back and a shared address all land on the
 *    same screen.
 *  - Searching widens to 全部 (plan §4.2) and says which results are 精选; the
 *    view the reader searched from comes back when the box is cleared.
 *  - The list is a keyset page, not a snapshot. `/status` is polled every two
 *    minutes; when its content version moves past the list's, page one is read
 *    again quietly and 「有 N 条新的」 counts only what is new above the top of
 *    the list — the same filters, so the number is the reader's, not the
 *    site's. A stale cursor restarts from page one (`restarted`).
 *  - The last page read for each query is kept for this visit. A refresh that
 *    fails leaves it on screen under 「暂时读不到，下面是上次读到的内容」
 *    rather than replacing it with an error, and coming back to a filter shows
 *    its last page at once while the fresh one is read.
 *  - Nothing of wave two is assumed to exist: 与你相关, 热点, 日报, the event
 *    page, 存入知识库 and 中文摘要 each hide or say 「还在准备」 on the server's
 *    404, and the rest of the page is unaffected. 存入知识库 is not even shown
 *    until `/status` names it among the deployment's `capabilities`.
 */
export function FrontierPage() {
  const feature = useFrontierFeature();
  const [off, setOff] = useState(false);
  const turnOff = useCallback(() => setOff(true), []);
  if (feature === "off" || off) return <FrontierOffPage />;
  return <FrontierFeed ready={feature === "on" || feature === "error"} onOff={turnOff} />;
}

function FrontierFeed({ ready, onOff }: { ready: boolean; onOff: () => void }) {
  const [params, setParams] = useSearchParams();
  const view = readView(params.get("view"));
  const listingView = view === "selected" || view === "all";
  const q = (params.get("q") ?? "").trim();
  const lane = readKey(params.get("lane"), FRONTIER_LANES);
  const specialty = readKey(params.get("specialty"), FRONTIER_SPECIALTIES);
  const starred = params.get("starred") === "1";
  const windowFilter = view === "all" ? readWindow(params.get("window")) : "";
  const day = readDay(params.get("day"));
  const filtered = Boolean(lane || specialty || starred || windowFilter);

  const query = useMemo<FrontierItemsQuery>(() => ({
    view: view === "all" ? "all" : "selected",
    lane: lane || null,
    specialty: specialty || null,
    window: windowFilter || null,
    q: q || null,
    starred,
  }), [view, lane, specialty, windowFilter, q, starred]);
  const key = JSON.stringify(query);

  /* ------------------------------------------------------------- status */

  const [status, setStatus] = useState<FrontierStatus | null>(null);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const poll = () => {
      fetchFrontierStatus().then(
        (next) => { if (active) setStatus(next); },
        (error: unknown) => {
          // Only the module being off changes the page; any other failure
          // leaves the last status in place and the next poll asks again.
          if (active && frontierAbsence(error) === "off") onOff();
        },
      );
    };
    poll();
    const timer = setInterval(() => { if (!document.hidden) poll(); }, STATUS_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [ready, onOff]);

  /* ---------------------------------------------------------------- list */

  const [listing, setListing] = useState<Listing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fresh, setFresh] = useState<{ count: number; listing: Listing } | null>(null);
  const cache = useRef(new Map<string, Listing>());
  const generation = useRef(0);
  /** The content version the list on screen was read at, or the last one checked. */
  const seenVersion = useRef<string | null>(null);

  const show = useCallback((next: Listing) => {
    cache.current.set(next.key, next);
    seenVersion.current = next.version;
    setListing(next);
    setFresh(null);
  }, []);

  const loadList = useCallback(async (keepOnScreen: boolean) => {
    const current = ++generation.current;
    if (!keepOnScreen) setListing(cache.current.get(key) ?? null);
    setListError(null);
    setFresh(null);
    try {
      const page = await listFrontierItems({ ...query, limit: PAGE_SIZE });
      if (current !== generation.current) return;
      show({ key, items: page.items, nextCursor: page.nextCursor, version: page.version, loadedAt: Date.now() });
    } catch (error) {
      if (current !== generation.current) return;
      if (frontierAbsence(error) === "off") { onOff(); return; }
      setListError(frontierErrorMessage(error));
    }
  }, [key, query, show, onOff]);

  useEffect(() => {
    if (!ready || !listingView) return;
    void loadList(false);
  }, [ready, listingView, loadList]);

  /** The list on screen and its cached copy, changed together. */
  const patchListing = useCallback((change: (current: Listing) => Listing) => {
    setListing((current) => {
      if (!current) return current;
      const next = change(current);
      cache.current.set(next.key, next);
      return next;
    });
  }, []);

  const loadMore = async () => {
    if (!listing?.nextCursor || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const page = await listFrontierItems({ ...query, cursor: listing.nextCursor, limit: PAGE_SIZE });
      if (current !== generation.current) return;
      if (page.restarted) {
        show({ key, items: page.items, nextCursor: page.nextCursor, version: page.version, loadedAt: Date.now() });
        toast.success("列表有更新，已从第一页重新加载。");
        scrollToListTop();
        return;
      }
      patchListing((list) => {
        const known = new Set(list.items.map((item) => item.id));
        return { ...list, items: [...list.items, ...page.items.filter((item) => !known.has(item.id))], nextCursor: page.nextCursor };
      });
    } catch (error) {
      if (current === generation.current) toast.error(frontierErrorMessage(error));
    } finally {
      if (current === generation.current) setLoadingMore(false);
    }
  };

  // 「有 N 条新的」: only when the content moved past the list on screen, and
  // only what is new above its top — counted with the reader's own filters.
  const contentVersion = status?.versions.content ?? null;
  useEffect(() => {
    if (!listing || listing.key !== key || q || !contentVersion || contentVersion === seenVersion.current) return;
    let active = true;
    const current = generation.current;
    listFrontierItems({ ...query, limit: PAGE_SIZE }).then((page) => {
      if (!active || current !== generation.current) return;
      seenVersion.current = contentVersion;
      const known = new Set(listing.items.map((item) => item.id));
      const top = listing.items[0] ? Date.parse(listing.items[0].timelineAt) : 0;
      const count = page.items.filter((item) => !known.has(item.id) && Date.parse(item.timelineAt) >= top).length;
      if (count > 0) {
        setFresh({ count, listing: { key, items: page.items, nextCursor: page.nextCursor, version: page.version, loadedAt: Date.now() } });
      }
    }, () => { /* a hint, not a read: it is asked again when the list or the version next changes */ });
    return () => { active = false; };
  }, [contentVersion, listing, key, q, query]);

  /* ----------------------------------------------------- item actions */

  const setItemState = useCallback((itemId: string, state: Partial<FrontierItemState>) => {
    patchListing((list) => ({ ...list, items: list.items.map((item) => (item.id === itemId ? { ...item, state: { ...item.state, ...state } } : item)) }));
  }, [patchListing]);

  const toggleStar = async (item: FrontierItem) => {
    const next = !item.state.starred;
    setItemState(item.id, { starred: next });
    try {
      setItemState(item.id, await (next ? starFrontierItem(item.id) : unstarFrontierItem(item.id)));
    } catch (error) {
      setItemState(item.id, { starred: !next });
      toast.error(frontierErrorMessage(error));
    }
  };

  const hide = (item: FrontierItem) => {
    const index = listing?.items.findIndex((entry) => entry.id === item.id) ?? -1;
    if (index < 0) return;
    const restore = () => patchListing((list) => (list.items.some((entry) => entry.id === item.id) ? list : {
      ...list,
      items: [...list.items.slice(0, index), { ...item, state: { ...item.state, hidden: false } }, ...list.items.slice(index)],
    }));
    patchListing((list) => ({ ...list, items: list.items.filter((entry) => entry.id !== item.id) }));
    const hidden = hideFrontierItem(item.id).then(() => true, (error: unknown) => {
      restore();
      toast.error(frontierErrorMessage(error));
      return false;
    });
    toast.success("已隐藏", {
      action: {
        label: "撤销",
        onClick: () => {
          restore();
          void hidden
            .then((done) => (done ? unhideFrontierItem(item.id) : null))
            .catch((error: unknown) => toast.error(frontierErrorMessage(error)));
        },
      },
    });
  };

  // 存入知识库 is offered once `/status` says this deployment can save (its
  // `capabilities`); a server that answers the route 404 anyway says so once,
  // and the action leaves every card for the rest of the visit.
  const [saveRefused, setSaveRefused] = useState(false);
  const saveOffered = status?.capabilities.saveToLibrary === true && !saveRefused;
  const [savingId, setSavingId] = useState<string | null>(null);
  const save = async (item: FrontierItem) => {
    if (savingId) return;
    setSavingId(item.id);
    try {
      const saved = await saveFrontierItemToLibrary(item.id, getWebProjectId());
      if (!saved) {
        setSaveRefused(true);
        toast.error("存入知识库还在准备，暂时用不了。");
        return;
      }
      // What was saved, said as it is (plan §4.7: 「并如实告知」).
      toast.success(saved.kind === "pdf"
        ? "已存入知识库：开放获取的全文 PDF，正在解析。"
        : saved.note ? `已存入知识库：${saved.note}` : "已存入知识库：这篇没有开放获取的全文，存的是题录和链接。");
    } catch (error) {
      toast.error(frontierErrorMessage(error));
    } finally {
      setSavingId(null);
    }
  };

  // Following a link to the original is reading it. Not awaited, and a
  // failure only leaves the item unread, which is what it was.
  const opened = (item: FrontierItem) => {
    if (item.state.read) return;
    setItemState(item.id, { read: true });
    markFrontierItemRead(item.id).catch(() => undefined);
  };

  /* --------------------------------------------- the blocks around it */

  // 「与你相关」 is asked for once, in 精选, and only when `/status` says
  // personalisation is not off for this deployment (memory off, or the second
  // wave not there yet): with it off the block does not exist, so there is
  // nothing to ask.
  const personalization = status?.personalization ?? null;
  const [forYou, setForYou] = useState<FrontierForYou | null>(null);
  const forYouAsked = useRef(false);
  useEffect(() => {
    if (!ready || view !== "selected" || forYouAsked.current || personalization === null || personalization === "off") return;
    forYouAsked.current = true;
    fetchFrontierForYou().then(setForYou, () => { /* a block that cannot be read is a block not shown */ });
  }, [ready, view, personalization]);

  // Read once for the rail and the 热点 view alike, and again when the hot
  // list's own version moves. `events: null` is a server without the route.
  const hotVersion = status?.versions.hot ?? null;
  const needHot = view !== "daily";
  const [hot, setHot] = useState<{ events: FrontierHotEvent[] | null; error: string | null } | null>(null);
  const [hotAttempt, setHotAttempt] = useState(0);
  useEffect(() => {
    if (!ready || !needHot) return;
    let active = true;
    fetchFrontierHot().then(
      (events) => { if (active) setHot({ events, error: null }); },
      (error: unknown) => { if (active) setHot((current) => ({ events: current?.events ?? null, error: frontierErrorMessage(error) })); },
    );
    return () => { active = false; };
  }, [ready, needHot, hotVersion, hotAttempt]);

  const [safety, setSafety] = useState<SafetyRail>("loading");
  useEffect(() => {
    if (!ready) return;
    let active = true;
    // Official safety notices from every lane: an alert is selected whatever
    // its score, but its lane is the screening model's pick among its
    // source's lanes, so the rail asks for alerts, not for a lane.
    listFrontierItems({ view: "all", safety: true, window: "7d", limit: 50 }).then(
      (page) => { if (active) setSafety(page.items.filter((item) => item.safetyAlert)); },
      () => { if (active) setSafety("failed"); },
    );
    return () => { active = false; };
  }, [ready]);

  // The daily view always asks, so it can tell 「还在准备」 from 「还没有出」;
  // the rail's 「AI 一分钟」 asks only once `/status` names a finished issue.
  const daily = useFrontierDaily(view === "daily" ? day : null, ready && (view === "daily" || Boolean(status?.lastDailyDay)));

  /* ------------------------------------------------------ navigation */

  // The box, debounced into `?q=`, and never mid-composition: pinyin is not a
  // query. `composed` re-arms the debounce when an IME commits a value the
  // last `change` event already carried.
  const [draft, setDraft] = useState(q);
  const [composed, setComposed] = useState(0);
  const composing = useRef(false);
  /** The view a search was started from, restored when the box is cleared. */
  const searchOrigin = useRef<PageView | null>(null);

  const setView = (next: PageView) => {
    const updated = new URLSearchParams(params);
    if (next === "selected") updated.delete("view"); else updated.set("view", next);
    // A view is a fresh look: the search belongs to the view it was typed in.
    updated.delete("q");
    updated.delete("day");
    if (next !== "all") updated.delete("window");
    searchOrigin.current = null;
    setParams(updated);
  };

  const setFilters = (change: Partial<FrontierFilterValue>) => {
    const updated = new URLSearchParams(params);
    const assign = (name: string, value: string | boolean | undefined) => {
      if (value === undefined) return;
      if (value === "" || value === false) updated.delete(name);
      else updated.set(name, value === true ? "1" : value);
    };
    assign("lane", change.lane);
    assign("specialty", change.specialty);
    assign("starred", change.starred);
    assign("window", change.window);
    setParams(updated, { replace: true });
  };

  useEffect(() => { setDraft(q); }, [q]);
  useEffect(() => {
    const text = draft.trim().slice(0, 200);
    if (composing.current || text === q) return;
    const timer = setTimeout(() => {
      const updated = new URLSearchParams(params);
      if (text) {
        if (!q) searchOrigin.current = view;
        updated.set("q", text);
        updated.set("view", "all");
        updated.delete("day");
      } else {
        updated.delete("q");
        const origin = searchOrigin.current;
        searchOrigin.current = null;
        if (origin && origin !== "all") {
          if (origin === "selected") updated.delete("view"); else updated.set("view", origin);
          updated.delete("window");
        }
      }
      setParams(updated, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, composed, q, params, setParams, view]);

  /* ---------------------------------------------------------- render */

  const enabledSources = status?.sources.enabled ?? 0;
  const definition = `EviMed 每天替你读${enabledSources > 0 ? ` ${enabledSources} 个` : ""}医学与 AI 信源，只留下值得看的。每条都标明来源和证据类型，点开就是原文。`;
  const staleAt = status && STALE_PLUGIN.has(status.plugin.state) ? status.plugin.lastPullAt ?? status.lastPublishedAt : null;

  const main = (() => {
    if (view === "hot") {
      if (!hot) return <FrontierSkeleton />;
      if (hot.error && !hot.events) return <LoadError message={hot.error} onRetry={() => setHotAttempt((value) => value + 1)} />;
      return <HotList events={hot.events} />;
    }
    if (view === "daily") return <DailyIssue state={daily} />;
    return (
      <>
        {view === "selected" && !q && !filtered && <ForYouBlock forYou={forYou} />}
        <FeedList
          view={view}
          q={q}
          filtered={filtered}
          listing={listing && listing.key === key ? listing : null}
          error={listError}
          fresh={fresh?.count ?? 0}
          firstRun={status ? status.lastPublishedAt === null : true}
          loadingMore={loadingMore}
          saveOffered={saveOffered}
          savingId={savingId}
          onRetry={() => void loadList(true)}
          onFresh={() => { if (fresh) { show(fresh.listing); scrollToListTop(); } }}
          onMore={() => void loadMore()}
          onAll={() => setView("all")}
          onStar={(item) => void toggleStar(item)}
          onHide={hide}
          onSave={(item) => void save(item)}
          onOpened={opened}
        />
      </>
    );
  })();

  const rail = view === "daily" && daily.index && daily.index.length > 0
    ? <DailyArchive index={daily.index} current={daily.issue?.day ?? null} onOpen={(next) => {
      const updated = new URLSearchParams(params);
      updated.set("view", "daily");
      updated.set("day", next);
      setParams(updated);
    }} />
    : (
      <>
        {view !== "hot" && <HotRailCard events={hot?.events ?? null} onOpenAll={() => setView("hot")} />}
        <SafetyRailCard items={safety} />
        {view !== "daily" && <AiMinuteCard text={daily.issue?.aiMinute ?? null} onOpenDaily={() => setView("daily")} />}
      </>
    );

  return (
    <PageShell title="前沿动态" description={definition} width="wide" contentClassName="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl aria-label="视图" value={view} onChange={setView} options={VIEWS} />
          {staleAt && (
            <span className="inline-flex items-center gap-1 text-caption text-muted">
              <Clock3 size={14} aria-hidden="true" />最近更新于 {clockOrDate(staleAt)}
            </span>
          )}
          <div className="relative w-full sm:ml-auto sm:w-72">
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              type="search"
              aria-label="搜索前沿动态"
              placeholder="搜标题、药名、疾病或机构"
              value={draft}
              maxLength={200}
              className="pl-9"
              onChange={(event) => setDraft(event.target.value)}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={(event) => { composing.current = false; setDraft(event.currentTarget.value); setComposed((value) => value + 1); }}
            />
          </div>
        </div>
        {listingView && (
          <FrontierFilters
            value={{ lane, specialty, starred, window: windowFilter }}
            showWindow={view === "all"}
            onChange={setFilters}
          />
        )}
      </div>

      <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1 space-y-4">{ready ? main : <FrontierSkeleton />}</div>
        <aside aria-label="侧栏" className="space-y-4 xl:w-72 xl:shrink-0">{ready ? rail : null}</aside>
      </div>

      <SourcesDisclosure />
    </PageShell>
  );
}

function scrollToListTop() {
  document.getElementById("frontier-list-top")?.scrollIntoView({ block: "start" });
}

/**
 * The feed itself: its four states (plan §4.11), the day groups, 「有 N 条新的」
 * and 「加载更多」. Search results are one list in relevance order, so they are
 * not cut into days.
 */
function FeedList({
  view, q, filtered, listing, error, fresh, firstRun, loadingMore, saveOffered, savingId,
  onRetry, onFresh, onMore, onAll, onStar, onHide, onSave, onOpened,
}: {
  view: "selected" | "all";
  q: string;
  filtered: boolean;
  listing: Listing | null;
  error: string | null;
  fresh: number;
  firstRun: boolean;
  loadingMore: boolean;
  saveOffered: boolean;
  savingId: string | null;
  onRetry: () => void;
  onFresh: () => void;
  onMore: () => void;
  onAll: () => void;
  onStar: (item: FrontierItem) => void;
  onHide: (item: FrontierItem) => void;
  onSave: (item: FrontierItem) => void;
  onOpened: (item: FrontierItem) => void;
}) {
  if (!listing) {
    return error ? <LoadError message={error} onRetry={onRetry} /> : <FrontierSkeleton />;
  }
  const markSelected = view === "all" || Boolean(q);
  const card = (item: FrontierItem) => (
    <li key={item.id}>
      <FrontierCard item={item} markSelected={markSelected} onStar={onStar} onHide={onHide}
        onSave={saveOffered ? onSave : undefined} saving={savingId === item.id} onOpened={onOpened} />
    </li>
  );
  const days = q ? [] : groupByDay(listing.items);
  return (
    <div id="frontier-list-top" className="space-y-4">
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 text-ui text-text">
          <span className="min-w-0 flex-1">暂时读不到，下面是上次读到的内容（更新于 {clockOrDate(new Date(listing.loadedAt).toISOString())}）。</span>
          <Button size="sm" variant="ghost" onClick={onRetry}>重试</Button>
        </div>
      )}
      {fresh > 0 && (
        <button type="button" onClick={onFresh}
          className="flex w-full items-center justify-center gap-1.5 rounded-card border border-border bg-surface-1 py-2 text-ui text-link transition-colors duration-fast hover:bg-surface-2">
          <ArrowUp size={14} aria-hidden="true" />有 {fresh >= PAGE_SIZE ? `${fresh}+` : fresh} 条新的
        </button>
      )}
      {listing.items.length === 0 ? (
        q ? <EmptyState icon={Search} title={`没有找到和「${q}」相关的动态`} description="换个药名、疾病或机构试试。" className="rounded-card border border-dashed border-border" />
          : filtered ? <EmptyState icon={Filter} title="这个条件下暂时没有，换个栏目或时间范围。" className="rounded-card border border-dashed border-border" />
            : firstRun || view === "all" ? <EmptyState icon={Newspaper} title="正在读第一批信源，大约 20 分钟后这里会有内容。" className="rounded-card border border-dashed border-border" />
              : <EmptyState icon={Newspaper} title="精选还在编" description="已经读到的动态都在「全部」里。" className="rounded-card border border-dashed border-border"
                action={<Button variant="ghost" onClick={onAll}>看全部</Button>} />
      ) : q ? (
        <section aria-label="搜索结果" className="space-y-2">
          <p className="text-caption text-muted">在全部动态里搜「{q}」，精选的已标出。</p>
          <ul className="space-y-3">{listing.items.map(card)}</ul>
        </section>
      ) : days.map((group, index) => {
        // The last day may continue on the next page; its count waits until it is whole.
        const whole = index < days.length - 1 || !listing.nextCursor;
        return (
          <section key={group.key} aria-labelledby={`frontier-day-${group.key}`}>
            <h2 id={`frontier-day-${group.key}`} className="mb-2 text-caption font-medium text-muted">
              {group.label}{whole && ` · ${group.items.length} 条${view === "selected" ? "精选" : ""}`}
            </h2>
            <ul className="space-y-3">{group.items.map(card)}</ul>
          </section>
        );
      })}
      {listing.nextCursor && (
        <Button variant="ghost" loading={loadingMore} onClick={onMore}>加载更多</Button>
      )}
    </div>
  );
}
