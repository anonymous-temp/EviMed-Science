import { FRONTIER_LEAVING, readFrontierPosition, type FrontierReadingPosition } from "@/components/frontier/frontierReadingState";
import { WeeklyView } from "@/components/frontier/WeeklyView";
import { FrontierLinkedItem } from "@/components/frontier/FrontierLinkedItem";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { getWebProjectId } from "@/lib/apiClient";
import {
  fetchFrontierForYou,
  fetchFrontierHotBoard,
  fetchFrontierStatus,
  frontierAbsence,
  frontierErrorMessage,
  FRONTIER_LANES,
  FRONTIER_FOLLOWS_CHANGED,
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
  type FrontierHotWindow,
  type FrontierItem,
  type FrontierItemState,
  type FrontierItemsQuery,
  type FrontierStatus,
  type FrontierWindow,
} from "@/lib/frontierClient";
import { toast } from "@/lib/toast";
import { PageShell } from "@/components/layout/PageShell";
import { SearchInput } from "@/components/ui/SearchInput";
import { FilterChips } from "@/components/ui/FilterChips";
import { FrontierNavigation } from "@/components/frontier/FrontierNavigation";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { DailyIssue, useFrontierDaily } from "@/components/frontier/DailyView";
import { FeedList, FEED_PAGE_SIZE, type Listing } from "@/components/frontier/FrontierFeed";
import { FrontierCard } from "@/components/frontier/FrontierCard";
import { FrontierFilters, type FrontierFilterValue } from "@/components/frontier/FrontierFilters";
import { HotBoard, HotCard, isHotWindow, type HotState } from "@/components/frontier/FrontierHot";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { ForYouView, type ForYouState } from "@/components/frontier/ForYouView";
import { SafetyStrip, recentAlerts, type SafetyAlerts } from "@/components/frontier/SafetyStrip";
import { SourcesLink } from "@/components/frontier/SourcesList";
import { FollowedEvidenceZones } from "@/components/frontier/FollowedEvidenceZones";
import { FrontierFollows } from "@/components/frontier/FrontierFollows";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { stamp, type CardTag } from "@/components/frontier/frontierText";

type PageView = "selected" | "hot" | "daily" | "all" | "foryou" | "following" | "weekly";

const VIEWS: readonly TabItem<PageView>[] = [
  { value: "selected", label: "精选" },
  { value: "hot", label: "热榜" },
  { value: "all", label: "全部" },
  { value: "foryou", label: "与我相关" },
];

/** 「有 N 条新的」 asks this often (plan §10.5.2): almost every answer is an empty 304. */
const STATUS_POLL_MS = 120_000;
/** A plugin in one of these states means the list is the last one read. */
const STALE_PLUGIN = new Set(["unreachable", "degraded", "incompatible"]);

/** The view a link names. Every older address — `?view=hot` (the 热点 of before), `daily`, `all` — still lands where it did. */
function readView(value: string | null): PageView {
  return value === "hot" || value === "daily" || value === "all" || value === "foryou" || value === "following" || value === "weekly" ? value : "selected";
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

/**
 * 「前沿动态」 (plan 2026-09-23 §6): one page with feed, digest, recommendation and follow views —
 * 精选, 热榜, 日报, 全部, 与我相关 and 关注 — with a server-side search at the right of
 * the title. 精选 opens with the safety strip and 当前热点 above the feed by
 * day; 全部 ends with the list of sources; there is no right rail any more
 * (its hot list is the card, its safety list the strip, its AI minute lives
 * in the daily).
 *
 * Hidden knowledge:
 *
 *  - Everything that describes the reader's position lives in the URL
 *    (`?view=&q=&lane=&specialty=&window=&starred=&sort=&day=`), so a
 *    notification's link (`?view=daily&day=…`), Back and a shared address all
 *    land on the same screen. `window` is the 全部 view's time range there and
 *    the 热榜's ranking (`week`, `month`) here; a view change clears it.
 *  - Searching widens to 全部 (plan §4.2); the dot marks which results are
 *    精选, and the view the reader searched from comes back when the box is
 *    cleared.
 *  - The list is a keyset page, not a snapshot. `/status` is polled every two
 *    minutes; when its content version moves past the list's, page one is read
 *    again quietly and 「有 N 条新的」 counts only what is new above the top of
 *    the list — the same filters, so the number is the reader's, not the
 *    site's. A stale cursor restarts from page one, silently.
 *  - The last page read for each query is kept for this visit. A refresh that
 *    fails leaves it on screen under 「未能刷新」 rather than replacing it with
 *    an error, and coming back to a filter shows its last page at once while
 *    the fresh one is read.
 *  - Nothing of the second wave is assumed to exist: 热榜, 日报, 与我相关, the
 *    event page, 存入知识库 and the abstract each hide or say so on the
 *    server's 404, and the rest of the page is unaffected. A field the server
 *    does not send yet (a heat, a score, a trend) hides the element that
 *    would show it.
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
  const location = useLocation();
  const restore = useRef(readFrontierPosition((location.state as { frontierReading?: unknown } | null)?.frontierReading));
  const pages = useRef(1);
  const [expanded, setExpanded] = useState<string[]>(restore.current?.query === params.toString() ? restore.current.expanded ?? [] : []);
  const pageRoot = useRef<HTMLDivElement>(null);
  const restoreObserver = useRef<ResizeObserver | null>(null);
  useEffect(() => () => restoreObserver.current?.disconnect(), []);
  const view = readView(params.get("view"));
  const follow = view === "following" ? params.get("follow") ?? "all" : null;
  const [manageFollows, setManageFollows] = useState(false);
  const listingView = view === "selected" || view === "all" || (view === "following" && Boolean(follow));
  const q = (params.get("q") ?? "").trim();
  const lane = readKey(params.get("lane"), FRONTIER_LANES);
  const specialty = readKey(params.get("specialty"), FRONTIER_SPECIALTIES);
  const starred = params.get("starred") === "1";
  const windowFilter = view === "all" ? readWindow(params.get("window")) : "";
  const hotWindowParam = params.get("window");
  const hotWindow: FrontierHotWindow = view === "hot" && isHotWindow(hotWindowParam) ? hotWindowParam : "current";
  const byTime = Boolean(q) && params.get("sort") === "time";
  const day = readDay(params.get("day"));
  const filtered = Boolean(lane || specialty || starred || windowFilter || follow);

  const query = useMemo<FrontierItemsQuery>(() => ({
    view: view === "all" || view === "following" ? "all" : "selected",
    follow,
    lane: lane || null,
    specialty: specialty || null,
    window: windowFilter || null,
    q: q || null,
    starred,
    ...(byTime ? { sort: "time" as const } : {}),
  }), [view, follow, lane, specialty, windowFilter, q, starred, byTime]);
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
      const page = await listFrontierItems({ ...query, limit: FEED_PAGE_SIZE });
      if (current !== generation.current) return;
      let restored = page;
      const position = restore.current;
      if (position?.query === params.toString()) {
        let restoredPages = 1;
        for (let index = 1; index < position.pages && restored.nextCursor; index++) {
          const next = await listFrontierItems({ ...query, cursor: restored.nextCursor, limit: FEED_PAGE_SIZE });
          if (current !== generation.current) return;
          if (next.restarted) { restored = next; restoredPages = 1; break; }
          const known = new Set(restored.items.map((item) => item.id));
          restored = { ...next, items: [...restored.items, ...next.items.filter((item) => !known.has(item.id))] };
          restoredPages += 1;
        }
        pages.current = restoredPages;
        requestAnimationFrame(() => {
          if (current !== generation.current) return;
          const scroller = pageRoot.current?.querySelector<HTMLElement>(".overflow-y-auto");
          if (!scroller) return;
          scroller.scrollTop = position.scroll;
          if (scroller.scrollTop < position.scroll && typeof ResizeObserver !== "undefined") {
            restoreObserver.current?.disconnect();
            const observer = new ResizeObserver(() => {
              if (current !== generation.current) { observer.disconnect(); return; }
              scroller.scrollTop = position.scroll;
              if (scroller.scrollTop >= position.scroll) observer.disconnect();
            });
            if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
            restoreObserver.current = observer;
          }
        });
        restore.current = undefined;
      } else pages.current = 1;
      show({ key, items: restored.items, nextCursor: restored.nextCursor, version: restored.version, loadedAt: Date.now() });
    } catch (error) {
      if (current !== generation.current) return;
      if (frontierAbsence(error) === "off") { onOff(); return; }
      setListError(frontierErrorMessage(error));
    }
  }, [key, query, show, onOff, params]);

  useEffect(() => {
    setLoadingMore(false);
    if (!ready || !listingView) return;
    void loadList(false);
    return () => { generation.current += 1; };
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
      const page = await listFrontierItems({ ...query, cursor: listing.nextCursor, limit: FEED_PAGE_SIZE });
      if (current !== generation.current) return;
      if (page.restarted) {
        pages.current = 1;
        // The list changed under the cursor: page one again, in place.
        show({ key, items: page.items, nextCursor: page.nextCursor, version: page.version, loadedAt: Date.now() });
        scrollToListTop();
        return;
      }
      pages.current += 1;
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
    if (!listingView || !listing || listing.key !== key || q || !contentVersion || contentVersion === seenVersion.current) return;
    let active = true;
    const current = generation.current;
    listFrontierItems({ ...query, limit: FEED_PAGE_SIZE }).then((page) => {
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
  }, [contentVersion, listing, listingView, key, q, query]);

  /* ------------------------------------------------------------ 与我相关 */

  const [forYou, setForYou] = useState<ForYouState>({ kind: "loading" });
  const [forYouAttempt, setForYouAttempt] = useState(0);
  useEffect(() => {
    if (!ready || view !== "foryou") return;
    let active = true;
    fetchFrontierForYou().then(
      (answer: FrontierForYou | null) => { if (active) setForYou({ kind: "ready", forYou: answer }); },
      (error: unknown) => { if (active) setForYou({ kind: "failed", message: frontierErrorMessage(error) }); },
    );
    return () => { active = false; };
  }, [ready, view, forYouAttempt]);

  const patchForYou = useCallback((change: (items: FrontierForYou["items"]) => FrontierForYou["items"]) => {
    setForYou((current) => (current.kind === "ready" && current.forYou
      ? { kind: "ready", forYou: { ...current.forYou, items: change(current.forYou.items) } } : current));
  }, []);

  /* ----------------------------------------------------- item actions */

  const setItemState = useCallback((itemId: string, state: Partial<FrontierItemState>) => {
    const patch = (item: FrontierItem) => (item.id === itemId ? { ...item, state: { ...item.state, ...state } } : item);
    patchListing((list) => ({ ...list, items: list.items.map(patch) }));
    patchForYou((items) => items.map((entry) => ({ ...entry, item: patch(entry.item) })));
  }, [patchListing, patchForYou]);

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
    const listIndex = listing?.items.findIndex((entry) => entry.id === item.id) ?? -1;
    const forYouItems = forYou.kind === "ready" ? forYou.forYou?.items ?? [] : [];
    const forYouIndex = forYouItems.findIndex((entry) => entry.item.id === item.id);
    const restored = { ...item, state: { ...item.state, hidden: false } };
    const restore = () => {
      if (listIndex >= 0) {
        patchListing((list) => (list.items.some((entry) => entry.id === item.id) ? list
          : { ...list, items: [...list.items.slice(0, listIndex), restored, ...list.items.slice(listIndex)] }));
      }
      if (forYouIndex >= 0) {
        const entry = { ...forYouItems[forYouIndex], item: restored };
        patchForYou((items) => (items.some((existing) => existing.item.id === item.id) ? items
          : [...items.slice(0, forYouIndex), entry, ...items.slice(forYouIndex)]));
      }
    };
    patchListing((list) => ({ ...list, items: list.items.filter((entry) => entry.id !== item.id) }));
    patchForYou((items) => items.filter((entry) => entry.item.id !== item.id));
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
        toast.error("暂时不能存入知识库");
        return;
      }
      toast.success("已存入知识库");
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

  // 当前热点 in 精选 and the 热榜 view read the same route; each ranking is
  // read again when the hot list's own version moves. `board: null` is a
  // server without the route.
  const hotVersion = status?.versions.hot ?? null;
  const hotNeeded = view === "hot" || (view === "selected" && !q && !filtered);
  const hotAsked: FrontierHotWindow = view === "hot" ? hotWindow : "current";
  const [hot, setHot] = useState<Partial<Record<FrontierHotWindow, HotState>>>({});
  const [hotAttempt, setHotAttempt] = useState(0);
  useEffect(() => {
    if (!ready || !hotNeeded) return;
    let active = true;
    fetchFrontierHotBoard(hotAsked).then(
      (board) => { if (active) setHot((current) => ({ ...current, [hotAsked]: { board, error: null } })); },
      (error: unknown) => {
        if (active) setHot((current) => ({ ...current, [hotAsked]: { board: current[hotAsked]?.board ?? null, error: frontierErrorMessage(error) } }));
      },
    );
    return () => { active = false; };
  }, [ready, hotNeeded, hotAsked, hotVersion, hotAttempt]);

  // The strip's alerts: the last three days of official safety notices from
  // every lane — an alert's lane is the screening model's pick among its
  // source's lanes, so the strip asks for alerts, not for a lane — cut to its
  // 48 hours here.
  const [safety, setSafety] = useState<SafetyAlerts>("loading");
  const [safetyAttempt, setSafetyAttempt] = useState(0);
  const safetyNeeded = view === "selected";
  useEffect(() => {
    if (!ready || !safetyNeeded) return;
    let active = true;
    listFrontierItems({ view: "all", safety: true, window: "3d", limit: 50 }).then(
      (page) => { if (active) setSafety(recentAlerts(page.items)); },
      () => { if (active) setSafety("failed"); },
    );
    return () => { active = false; };
  }, [ready, safetyNeeded, safetyAttempt]);

  const daily = useFrontierDaily(view === "daily" ? day : null, ready && view === "daily");
  useEffect(() => {
    const changed = () => {
      cache.current.clear();
      setForYouAttempt((value) => value + 1);
      setSafetyAttempt((value) => value + 1);
      if (ready && listingView) void loadList(false);
    };
    window.addEventListener(FRONTIER_FOLLOWS_CHANGED, changed);
    return () => window.removeEventListener(FRONTIER_FOLLOWS_CHANGED, changed);
  }, [ready, listingView, loadList]);


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
    // A view is a fresh look: the search, the day and the time range belong to the view they were chosen in.
    for (const name of ["q", "day", "week", "window", "sort", "follow", "item"]) updated.delete(name);
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
    if (change.byTime !== undefined) {
      if (change.byTime) updated.set("sort", "time"); else updated.delete("sort");
    }
    setParams(updated, { replace: true });
  };

  const setHotWindow = (next: FrontierHotWindow) => {
    const updated = new URLSearchParams(params);
    if (next === "current") updated.delete("window"); else updated.set("window", next);
    setParams(updated, { replace: true });
  };

  const openDay = (next: string) => {
    const updated = new URLSearchParams(params);
    updated.set("view", "daily");
    updated.set("day", next);
    setParams(updated);
  };

  // A #tag narrows the feed: a specialty is a filter, a disease is a search.
  const onTag = (tag: CardTag) => {
    if (tag.kind === "specialty") setFilters({ specialty: tag.key });
    else setDraft(tag.label);
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
        updated.delete("sort");
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

  useEffect(() => {
    const position = restore.current;
    if (!position || position.query !== params.toString() || listingView || !ready) return;
    const settled = view === "hot" ? Boolean(hot[hotWindow]) : view === "daily" ? !daily.loading : view === "foryou" ? forYou.kind !== "loading" : view === "weekly";
    if (!settled) return;
    const frame = requestAnimationFrame(() => {
      const scroller = pageRoot.current?.querySelector<HTMLElement>(".overflow-y-auto");
      if (!scroller) return;
      scroller.scrollTop = position.scroll;
      if (view === "weekly" && scroller.scrollTop < position.scroll && typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(() => {
          scroller.scrollTop = position.scroll;
          if (scroller.scrollTop >= position.scroll) observer.disconnect();
        });
        if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
        restoreObserver.current = observer;
      }
      restore.current = undefined;
    });
    return () => cancelAnimationFrame(frame);
  }, [params, listingView, ready, view, hot, hotWindow, daily.loading, forYou.kind]);

  useEffect(() => {
    const remember = () => {
      const position: FrontierReadingPosition = { query: params.toString(), pages: Math.min(pages.current, 20),
        scroll: pageRoot.current?.querySelector<HTMLElement>(".overflow-y-auto")?.scrollTop ?? 0, expanded };
      const history = window.history.state as { usr?: Record<string, unknown> } | null;
      window.history.replaceState({ ...history, usr: { ...history?.usr, frontierReading: position } }, "");
    };
    window.addEventListener(FRONTIER_LEAVING, remember);
    return () => window.removeEventListener(FRONTIER_LEAVING, remember);
  }, [params, expanded]);

  /* ---------------------------------------------------------- render */

  const staleAt = status && STALE_PLUGIN.has(status.plugin.state) ? status.plugin.lastPullAt ?? status.lastPublishedAt : null;

  const card = (item: FrontierItem, grouped: boolean) => (
    <FrontierCard
      key={item.id}
      item={item}
      grouped={grouped}
      expanded={expanded.includes(item.id)}
      onExpand={() => setExpanded((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}
      markSelected={view !== "selected"}
      onStar={(target) => void toggleStar(target)}
      onHide={hide}
      onSave={saveOffered ? (target) => void save(target) : undefined}
      saving={savingId === item.id}
      onOpened={opened}
      onTag={onTag}
    />
  );

  const feed = (
    <FeedList
      view={view === "all" || view === "following" ? "all" : "selected"}
      q={q}
      filtered={filtered}
      listing={listing && listing.key === key ? listing : null}
      error={listError}
      fresh={fresh?.count ?? 0}
      firstRun={status ? status.lastPublishedAt === null : true}
      loadingMore={loadingMore}
      renderItem={card}
      onRetry={() => void loadList(true)}
      onFresh={() => { if (fresh) { pages.current = 1; show(fresh.listing); scrollToListTop(); } }}
      onMore={() => void loadMore()}
      onAll={() => setView("all")}
    />
  );

  const filters = (
    <FrontierFilters
      value={{ lane, specialty, starred, window: windowFilter, byTime }}
      showWindow={view === "all"}
      searching={Boolean(q)}
      onChange={setFilters}
    />
  );

  const main = (() => {
    switch (view) {
      case "hot":
        return (
          <HotBoard
            state={hot[hotWindow] ?? null}
            window={hotWindow}
            windows={Object.values(hot).some((entry) => Boolean(entry?.board?.takenAt))}
            onWindow={setHotWindow}
            onRetry={() => setHotAttempt((value) => value + 1)}
          />
        );
      case "weekly":
        return <WeeklyView week={readDay(params.get("week"))} onWeek={(week) => {
          const updated = new URLSearchParams(params); updated.set("week", week); setParams(updated);
        }} />;
      case "daily":
        return <DailyIssue state={daily} onDay={openDay} />;
      case "foryou":
        return <ForYouView state={forYou} renderItem={(item) => card(item, false)} onRetry={() => setForYouAttempt((value) => value + 1)} />;
      case "following":
        return <div className="space-y-6">
          <div className="flex items-center gap-2">
            {follow !== "all" && <Button variant="text" onClick={() => setParams((current) => {
              const updated = new URLSearchParams(current); updated.delete("follow"); return updated;
            })}>全部关注</Button>}
            <Button variant="secondary" onClick={() => setManageFollows(true)}>管理关注</Button>
          </div>
          <FollowedEvidenceZones />
          {filters}{feed}
          {manageFollows && <Drawer title="管理关注" onClose={() => setManageFollows(false)}>
            <FrontierFollows selected={follow === "all" ? null : follow} onSelect={(id) => {
              setParams((current) => {
                const updated = new URLSearchParams(current);
                if (id) updated.set("follow", id); else updated.delete("follow");
                return updated;
              });
              setManageFollows(false);
            }} onChanged={() => { cache.current.clear(); void loadList(true); }} />
          </Drawer>}
        </div>;
      case "all":
        return (
          <>
            {filters}
            <div className="mt-6">{feed}</div>
            <div className="mt-8"><SourcesLink count={status?.sources.enabled ?? 0} /></div>
          </>
        );
      default:
        return (
          <>
            <div className="space-y-4">
              {filters}
              <SafetyStrip alerts={safety} onRetry={() => setSafetyAttempt((value) => value + 1)} onOpened={opened} />
              {!q && !filtered && <HotCard events={hot.current?.board?.events ?? []} onOpenAll={() => setView("hot")} />}
            </div>
            <div className="mt-8">{feed}</div>
          </>
        );
    }
  })();

  return (
    <div ref={pageRoot} className="h-full min-h-0"><PageShell
      title="前沿动态"
      meta={staleAt ? `${stamp(staleAt)} 更新` : undefined}
      contentClassName="mt-2"
      actions={(
        <SearchInput
          label="搜索"
          value={draft}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(event) => { composing.current = false; setDraft(event.currentTarget.value); setComposed((value) => value + 1); }}
        />
      )}
    >
      <FrontierNavigation active={view === "following" ? "following" : view === "daily" || view === "weekly" ? "brief" : "feed"} onChange={(section) => setView(section === "feed" ? "selected" : section === "brief" ? "daily" : "following")} />
      {view !== "daily" && view !== "weekly" && view !== "following" && <FilterChips label="动态视图" className="mt-4 [&>div]:overflow-x-auto" options={VIEWS} value={view} onChange={setView} />}
      {(view === "daily" || view === "weekly") && <Tabs label="简报周期" className="mt-4" items={[{ value: "daily", label: "日报" }, { value: "weekly", label: "周报" }]} value={view} onChange={setView} panelId="frontier-view" />}
      {ready && params.get("item") && <FrontierLinkedItem id={params.get("item")!} />}
      <div role={view === "daily" || view === "weekly" ? "tabpanel" : "region"} id="frontier-view" aria-labelledby={view === "daily" || view === "weekly" ? `frontier-view-tab-${view}` : undefined} aria-label={view === "daily" || view === "weekly" ? undefined : view === "following" ? "关注动态" : "动态"} className="mt-5">
        {ready ? main : <FrontierSkeleton />}
      </div>
    </PageShell></div>
  );
}

function scrollToListTop() {
  document.getElementById("frontier-list-top")?.scrollIntoView({ block: "start" });
}
