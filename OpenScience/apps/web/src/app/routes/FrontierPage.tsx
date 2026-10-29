import { FRONTIER_LEAVING, readFrontierPosition, rememberFrontierPosition, type FrontierReadingPosition } from "@/components/frontier/frontierReadingState";
import { WeeklyView, useFrontierWeekly } from "@/components/frontier/WeeklyView";
import { FrontierLinkedItem } from "@/components/frontier/FrontierLinkedItem";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { getWebProjectId } from "@/lib/apiClient";
import {
  fetchFrontierForYou,
  fetchFrontierHotBoard,
  fetchFrontierStatus,
  frontierAbsence,
  frontierErrorMessage,
  FRONTIER_LANES,
  FRONTIER_SPECIALTIES,
  FRONTIER_FOLLOWS_CHANGED,
  FRONTIER_WINDOWS,
  listFrontierItems,
  markFrontierFollowSeen,
  markFrontierItemRead,
  saveFrontierItemToLibrary,
  starFrontierItem,
  unstarFrontierItem,
  useFrontierFeature,
  type FrontierForYou,
  type FrontierHotWindow,
  type FrontierItem,
  type FrontierItemState,
  type FrontierItemsPage,
  type FrontierItemsQuery,
  type FrontierStatus,
  type FrontierTagRef,
  type FrontierTrackSegment,
  type FrontierWindow,
} from "@/lib/frontierClient";
import { serveFrontierList, trackFrontierFilter, trackFrontierItemAction, useFrontierListTracking, type FrontierTrackSurface } from "@/lib/frontierTracking";
import { toast } from "@/lib/toast";
import { PageShell } from "@/components/layout/PageShell";
import { frontierHeaderActions, frontierToolbar, type FollowChoice, type PageView } from "@/components/frontier/FrontierControls";
import { DailyIssue, dailyControls, useFrontierDaily } from "@/components/frontier/DailyView";
import { FeedList, FEED_PAGE_SIZE, type Listing } from "@/components/frontier/FrontierFeed";
import { FrontierCard } from "@/components/frontier/FrontierCard";
import { useFrontierHide } from "@/components/frontier/useFrontierHide";
import { NO_FILTERS, readChannel, readEvidence, readIndustryKind, readSpecialties, readTag, specialtyLabel, type FrontierFilterValue } from "@/components/frontier/FrontierFilters";
import { rememberTagName, useFollowSet, useHotTags, useTagFollow, useTagName, useTagSuggestions } from "@/components/frontier/useFrontierTags";
import { HotBoard, HotCard, isHotWindow, type HotState } from "@/components/frontier/FrontierHot";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { ForYouView, type ForYouState } from "@/components/frontier/ForYouView";
import { SafetyStrip, foldedIntoStrip, recentAlerts, type SafetyAlerts } from "@/components/frontier/SafetyStrip";
import { SourcesLink } from "@/components/frontier/SourcesList";
import { FollowList, FollowingView, followAnswers, followChoiceLabel, followChoiceParam, readFollowChoice, useFollowing } from "@/components/frontier/FollowingView";
import { useNarrow } from "@/lib/useMediaQuery";
import type { FrontierPrefs } from "@/lib/frontierPrefs";
import { FrontierFollows } from "@/components/frontier/FrontierFollows";
import { Drawer } from "@/components/ui/Drawer";
import { ZoneDirectoryBody, readZoneView, useZoneDirectory, zoneDirectoryControls } from "@/components/frontier/EvidenceZoneDirectory";
import type { ZoneDirectoryView } from "@/lib/evidenceTopicClient";
import { ZoneEditorDrawer, type ZoneEditorSeed } from "@/components/frontier/ZoneEditorDrawer";
import { ZoneLeadLine } from "@/components/frontier/ZoneLeadLine";
import { readNewZone, zonePath } from "@/components/frontier/zoneLinks";
import { CongressNowLine, TrackBody, readTrackSegment, trackControls, useFrontierApprovals, useFrontierCongresses, useFrontierGuidelines } from "@/components/frontier/FrontierTrackView";

/** 「有 N 条新的」 asks this often (plan §10.5.2): almost every answer is an empty 304. */
const STATUS_POLL_MS = 120_000;

/** The control of the list each filter is, as a `filter-change` names it — never what it was set to (frontierTracking). */
const FILTER_CONTROLS: Record<keyof FrontierFilterValue, string> = { channel: "channel", lane: "lane", specialties: "specialty", tag: "tag", evidence: "evidence",
  industryKind: "kind", starred: "starred", unread: "unread", window: "window", byTime: "sort" };

/** The views whose list the feed's filters narrow: a tag chosen anywhere else opens 全部 with it. */
const FEED_VIEWS: ReadonlySet<PageView> = new Set(["selected", "all", "following"]);

/**
 * The view a link names. Every older address — `?view=hot` (the 热点 of before), `daily`, `all` — still lands where it did, and
 * `?view=foryou` lands on 关注's first entry, 与我相关 (owner, 2026-10-25).
 */
function readView(value: string | null): PageView {
  if (value === "foryou") return "following";
  return value === "hot" || value === "daily" || value === "all" || value === "following" || value === "weekly" || value === "zones" || value === "track" ? value : "selected";
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
 * 精选, 全部, 证据专区, 热榜, 与我相关, 关注 and 简报 (the daily and the weekly). 证据专区 is a view
 * like the others since 2026-10-22 (`?view=zones&scope=mine|community&zoneSpecialty=`; the owner: it opened as a separate page; a topic
 * directory of zones of two or three keywords since 2026-10-29, with 「新建专区」 in a drawer that `?new=1&fromItem=` also opens),
 * and `/app/frontier/zones` hands its links over to it. The views are one row of tabs and the controls of
 * the open view, with the server-side search, sit at that row's right (`frontierToolbar`; plan
 * 2026-10-07 §4) in the shell's sticky band, so they stay at the top of a six-thousand-pixel feed
 * (R19, audit D C1d). 精选 opens with the safety strip and 当前热点
 * above the feed by day; 全部 ends with the list of sources; there is no right rail any more
 * (its hot list is the card, its safety list the strip, its AI minute lives in the daily).
 *
 * Hidden knowledge:
 *
 *  - Everything that describes the reader's position lives in the URL
 *    (`?view=&q=&lane=&kind=&specialty=a,b&tag=&channel=&evidence=&window=&starred=1&unread=1&sort=&day=&scope=&zoneSpecialty=`), so a
 *    notification's link (`?view=daily&day=…`), Back and a shared address all
 *    land on the same screen. `window` is the 全部 view's time range there and
 *    the 热榜's ranking (`week`, `month`) here; a view change clears it. An older
 *    link's single `specialty=` still reads, and a retired specialty reads as its
 *    successor (`readSpecialties`).
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
  // What a digest (日报, 周报) has opened of itself, kept for the way back.
  const [expanded, setExpanded] = useState<string[]>(restore.current?.query === params.toString() ? restore.current.expanded ?? [] : []);
  const pageRoot = useRef<HTMLDivElement>(null);
  const restoreObserver = useRef<ResizeObserver | null>(null);
  useEffect(() => () => restoreObserver.current?.disconnect(), []);
  const narrow = useNarrow();
  const view = readView(params.get("view"));
  // An older link to 与我相关 (`?view=foryou`) is written as the entry of 关注 it now is, in place.
  const legacyForYou = params.get("view") === "foryou";
  useEffect(() => {
    if (!legacyForYou) return;
    setParams((current) => {
      const updated = new URLSearchParams(current);
      updated.set("view", "following");
      updated.set("follow", "foryou");
      return updated;
    }, { replace: true });
  }, [legacyForYou, setParams]);
  const followParam = params.get("follow");
  const choice: FollowChoice | null = useMemo(() => (view === "following" ? readFollowChoice(followParam) : null), [view, followParam]);
  /** The server's `follow`: the whole of the follows or one of them; 与我相关 and a zone are not lists of items. */
  const follow = choice?.kind === "all" ? "all" : choice?.kind === "follow" ? choice.id : null;
  const forYouOpen = choice?.kind === "foryou";
  const [manageFollows, setManageFollows] = useState(false);
  // 「管理关注」 is about the view it was opened from: a link in it to another view (证据专区's 我关注的) closes it.
  useEffect(() => { setManageFollows(false); }, [view]);
  // The 关注 feed is asked for only once the reader follows something to put in it (one narrowed follow is its own proof).
  const following = useFollowing(ready && view === "following");
  // Opening one follow's feed is looking at what is new in it: the server forgets the count (c3-watch, 2026-10-25).
  const openedFollow = ready && choice?.kind === "follow" ? choice.id : null;
  useEffect(() => { if (openedFollow) void markFrontierFollowSeen(openedFollow); }, [openedFollow]);
  const listingView = view === "selected" || view === "all"
    || (view === "following" && (choice?.kind === "follow" || (choice?.kind === "all" && following.topics.length > 0)));
  const q = (params.get("q") ?? "").trim();
  const channel = readChannel(params.get("channel"));
  const lane = readKey(params.get("lane"), FRONTIER_LANES);
  const specialtyParam = params.get("specialty");
  const specialties = useMemo(() => readSpecialties(specialtyParam), [specialtyParam]);
  const tag = readTag(params.get("tag"));
  const evidence = readEvidence(params.get("evidence"));
  const industryKind = readIndustryKind(params.get("kind"));
  const starred = params.get("starred") === "1";
  const unread = params.get("unread") === "1";
  const windowFilter = view === "all" ? readWindow(params.get("window")) : "";
  const hotWindowParam = params.get("window");
  const hotWindow: FrontierHotWindow = view === "hot" && isHotWindow(hotWindowParam) ? hotWindowParam : "current";
  const byTime = Boolean(q) && params.get("sort") === "time";
  const day = readDay(params.get("day"));
  const zoneView = readZoneView(params.get("scope"));
  const zoneSpecialty = readKey(params.get("zoneSpecialty"), FRONTIER_SPECIALTIES);
  // 追踪 (c3-track 2026-10-25): its segment and the one filter of that segment, in the address.
  const trackSegment = readTrackSegment(params.get("segment"));
  const trackAgency = /^[a-z-]{2,24}$/.test(params.get("agency") ?? "") ? params.get("agency")! : "";
  // 指南's specialty has its own parameter: `specialty` is the feed's 「筛选」, kept across views.
  const trackSpecialty = readKey(params.get("guidelineSpecialty"), FRONTIER_SPECIALTIES);
  // 「没有结果」 means a filter or a narrowed follow excluded everything; the whole of the follows is not a filter.
  // A typed follow that has matched nothing (yet) is not a filter that excluded everything: it says what it is waiting for (c3-watch).
  const typedFollow = choice?.kind === "follow" ? following.topics.find((entry) => entry.id === choice.id && entry.kind === "query") : undefined;
  const filtered = Boolean(channel || lane || specialties.length || tag || evidence || industryKind || starred || unread || windowFilter || (choice?.kind === "follow" && !typedFollow));
  /** Where the list on screen is, as its events name it (frontierTracking): the feed, a search or the follows. */
  const listSurface: FrontierTrackSurface = q ? "search" : view === "following" ? "follows" : "feed";
  /** Where a card's star or hide is taken: 与我相关 or the list. */
  const cardSurface: FrontierTrackSurface = forYouOpen ? "for-you" : listSurface;

  const query = useMemo<FrontierItemsQuery>(() => ({
    view: view === "all" || view === "following" ? "all" : "selected",
    follow,
    channel: channel || null,
    lane: lane || null,
    specialties,
    tag: tag || null,
    evidence: evidence || null,
    industryKind: industryKind || null,
    window: windowFilter || null,
    q: q || null,
    starred,
    unread,
    ...(byTime ? { sort: "time" as const } : {}),
  }), [view, follow, channel, lane, specialties, tag, evidence, industryKind, windowFilter, q, starred, unread, byTime]);
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
  const [fresh, setFresh] = useState<{ count: number; listing: Listing; page: FrontierItemsPage } | null>(null);
  const cache = useRef(new Map<string, Listing>());
  const generation = useRef(0);
  /** The content version the list on screen was read at, or the last one checked. */
  const seenVersion = useRef<string | null>(null);

  /** What a list answer served, registered for its impressions and opens: its list id and each entry's slot, from `offset`. */
  const serve = useCallback((surface: FrontierTrackSurface, page: FrontierItemsPage, offset = 0) => {
    serveFrontierList(surface, page.listId, page.items.map((item) => ({ id: item.id, slot: page.slots?.[item.id] ?? null })), { offset });
  }, []);

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
      serve(listSurface, page);
      let restored = page;
      const position = restore.current;
      if (position?.query === params.toString()) {
        let restoredPages = 1;
        for (let index = 1; index < position.pages && restored.nextCursor; index++) {
          const next = await listFrontierItems({ ...query, cursor: restored.nextCursor, limit: FEED_PAGE_SIZE });
          if (current !== generation.current) return;
          if (next.restarted) { restored = next; restoredPages = 1; serve(listSurface, next); break; }
          serve(listSurface, next, restored.items.length);
          const known = new Set(restored.items.map((item) => item.id));
          restored = { ...next, related: restored.related, items: [...restored.items, ...next.items.filter((item) => !known.has(item.id))] };
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
      show({ key, items: restored.items, nextCursor: restored.nextCursor, version: restored.version, loadedAt: Date.now(), related: restored.related });
    } catch (error) {
      if (current !== generation.current) return;
      if (frontierAbsence(error) === "off") { onOff(); return; }
      setListError(frontierErrorMessage(error));
    }
  }, [key, query, show, onOff, params, serve, listSurface]);

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
        serve(listSurface, page);
        show({ key, items: page.items, nextCursor: page.nextCursor, version: page.version, loadedAt: Date.now(), related: page.related });
        scrollToListTop();
        return;
      }
      pages.current += 1;
      serve(listSurface, page, listing.items.length);
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
      // An item can arrive with an older timeline instant than the list's top (it sits at its source's own time), so what is new is
      // told by when we published it: against the newest publication on screen.
      const arrived = (item: { visibleAt: string | null; timelineAt: string }) => Date.parse(item.visibleAt ?? item.timelineAt);
      const top = listing.items.reduce((newest, item) => Math.max(newest, arrived(item) || 0), 0);
      const count = page.items.filter((item) => !known.has(item.id) && arrived(item) >= top).length;
      if (count > 0) {
        setFresh({ count, page, listing: { key, items: page.items, nextCursor: page.nextCursor, version: page.version, loadedAt: Date.now(), related: page.related } });
      }
    }, () => { /* a hint, not a read: it is asked again when the list or the version next changes */ });
    return () => { active = false; };
  }, [contentVersion, listing, listingView, key, q, query]);

  /* ------------------------------------------------------------ 与我相关 */

  const [forYou, setForYou] = useState<ForYouState>({ kind: "loading" });
  const [forYouAttempt, setForYouAttempt] = useState(0);
  useEffect(() => {
    if (!ready || !forYouOpen) return;
    let active = true;
    fetchFrontierForYou().then(
      (answer: FrontierForYou | null) => {
        if (!active) return;
        if (answer) serveFrontierList("for-you", answer.listId, answer.items.map((entry) => ({ id: entry.item.id, slot: entry.slot ?? null })));
        setForYou({ kind: "ready", forYou: answer });
      },
      (error: unknown) => { if (active) setForYou({ kind: "failed", message: frontierErrorMessage(error) }); },
    );
    return () => { active = false; };
  }, [ready, forYouOpen, forYouAttempt]);

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
      trackFrontierItemAction(next ? "star" : "unstar", item.id, { surface: cardSurface });
    } catch (error) {
      setItemState(item.id, { starred: !next });
      toast.error(frontierErrorMessage(error));
    }
  };

  // 「不感兴趣」: the card goes at once and one line stands in its place to ask why (useFrontierHide); the item leaves the list when the
  // line closes, and 撤销 is the card coming back where it was.
  const hideStrips = useFrontierHide({
    surface: cardSurface,
    onClosed: (item) => {
      patchListing((list) => ({ ...list, items: list.items.filter((entry) => entry.id !== item.id) }));
      patchForYou((items) => items.filter((entry) => entry.item.id !== item.id));
    },
  });

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
      trackFrontierItemAction("save", item.id, { surface: cardSurface });
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
      (board) => {
        if (!active) return;
        if (board) serveFrontierList("hot", board.listId, board.events.map((event) => ({ id: event.id, kind: "event" as const, slot: null })));
        setHot((current) => ({ ...current, [hotAsked]: { board, error: null } }));
      },
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
      (page) => {
        if (!active) return;
        serve("safety", page);
        setSafety(recentAlerts(page.items));
      },
      () => { if (active) setSafety("failed"); },
    );
    return () => { active = false; };
  }, [ready, safetyNeeded, safetyAttempt, serve]);

  const daily = useFrontierDaily(view === "daily" ? day : null, ready && view === "daily");
  const week = readDay(params.get("week"));
  const weekly = useFrontierWeekly(week, ready && view === "weekly");
  // What an issue served: its list id and each item's slot, in the order it shows them (lead, safety, sections).
  useEffect(() => {
    for (const [surface, issue] of [["daily", daily.issue], ["weekly", weekly.issue]] as const) {
      if (!issue?.listId) continue;
      const shown = [issue.lead?.item, ...issue.safety, ...issue.sections.flatMap((section) => section.items)].filter((item): item is FrontierItem => Boolean(item));
      serveFrontierList(surface, issue.listId, shown.map((item) => ({ id: item.id, slot: issue.slots?.[item.id] ?? null })));
    }
  }, [daily.issue, weekly.issue]);
  // 证据专区: the directory, read while its view is open; the search box searches the zones there.
  const zones = useZoneDirectory({
    view: zoneView,
    specialty: zoneSpecialty,
    query: view === "zones" ? q : "",
    enabled: ready && view === "zones",
  });
  // The editor of 我的专区 (「新建专区」), over whichever view is open: the header's action, a search for a group's name, a card's
  // ⋯ (`?new=1`, below) and 管理关注 open it. A saved zone opens on its own page.
  const navigate = useNavigate();
  const [editor, setEditor] = useState<{ seed?: ZoneEditorSeed } | null>(null);
  // 追踪: the open segment's list, read while the view is open.
  const approvals = useFrontierApprovals(ready && view === "track" && trackSegment === "approvals", trackAgency);
  const guidelines = useFrontierGuidelines(ready && view === "track" && trackSegment === "guidelines", trackSpecialty);
  const congresses = useFrontierCongresses(ready && view === "track" && trackSegment === "congresses");
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
    if (next !== view) trackFrontierFilter("view", listSurface);
    const updated = new URLSearchParams(params);
    if (next === "selected") updated.delete("view"); else updated.set("view", next);
    // A view is a fresh look: the search, the day, the time range and the zones' scope belong to the view they were chosen in.
    for (const name of ["q", "day", "week", "window", "sort", "follow", "item", "scope", "zoneSpecialty", "request", "segment", "agency", "guidelineSpecialty"]) updated.delete(name);
    searchOrigin.current = null;
    setParams(updated);
  };

  // 追踪's segment and its one filter: the segment is a place (Back returns to the one before), the filter a narrowing (it replaces).
  const setTrackSegment = (next: FrontierTrackSegment) => {
    if (next === trackSegment) return;
    trackFrontierFilter("view", "track");
    const updated = new URLSearchParams(params);
    if (next === "approvals") updated.delete("segment"); else updated.set("segment", next);
    updated.delete("agency");
    updated.delete("specialty");
    setParams(updated);
  };
  const setTrackFilter = (name: "agency" | "guidelineSpecialty", value: string) => {
    trackFrontierFilter(name === "guidelineSpecialty" ? "specialty" : name, "track");
    const updated = new URLSearchParams(params);
    if (value) updated.set(name, value); else updated.delete(name);
    setParams(updated, { replace: true });
  };

  const setZoneView = (next: ZoneDirectoryView) => {
    if (next !== zoneView) trackFrontierFilter("view", listSurface);
    const updated = new URLSearchParams(params);
    if (next === "recommended") updated.delete("scope"); else updated.set("scope", next);
    setParams(updated, { replace: true });
  };
  const setZoneSpecialty = (next: string) => {
    trackFrontierFilter("specialty", listSurface);
    const updated = new URLSearchParams(params);
    if (next) updated.set("zoneSpecialty", next); else updated.delete("zoneSpecialty");
    setParams(updated, { replace: true });
  };

  // 「以此新建专区」 from another page (a card's or the reader's ⋯, `?view=zones&new=1&fromItem=…`): the editor opens on that seed and the
  // address lets go of it, so Back and a reload do not open it again.
  const paramsKey = params.toString();
  const newZone = useMemo(() => readNewZone(new URLSearchParams(paramsKey)), [paramsKey]);
  useEffect(() => {
    if (!newZone) return;
    setEditor({ seed: newZone });
    setParams((current) => {
      const updated = new URLSearchParams(current);
      for (const name of ["new", "fromItem", "base", "text", "generate"]) updated.delete(name);
      return updated;
    }, { replace: true });
  }, [newZone, setParams]);
  const openEditor = useCallback((seed?: ZoneEditorSeed) => setEditor({ seed }), []);

  const setFilters = (change: Partial<FrontierFilterValue>) => {
    const current: FrontierFilterValue = { channel, lane, specialties, tag, evidence, industryKind, starred, unread, window: windowFilter, byTime };
    for (const [name, value] of Object.entries(change) as Array<[keyof FrontierFilterValue, unknown]>) {
      if (value !== undefined && JSON.stringify(value) !== JSON.stringify(current[name]) && FILTER_CONTROLS[name]) trackFrontierFilter(FILTER_CONTROLS[name], listSurface);
    }
    const updated = new URLSearchParams(params);
    const assign = (name: string, value: string | boolean | undefined) => {
      if (value === undefined) return;
      if (value === "" || value === false) updated.delete(name);
      else updated.set(name, value === true ? "1" : value);
    };
    assign("channel", change.channel);
    assign("lane", change.lane);
    if (change.specialties !== undefined) assign("specialty", change.specialties.join(","));
    assign("tag", change.tag);
    assign("evidence", change.evidence);
    assign("kind", change.industryKind);
    assign("starred", change.starred);
    assign("unread", change.unread);
    assign("window", change.window);
    if (change.byTime !== undefined) {
      if (change.byTime) updated.set("sort", "time"); else updated.delete("sort");
    }
    setParams(updated, { replace: true });
  };

  const setHotWindow = (next: FrontierHotWindow) => {
    if (next !== hotWindow) trackFrontierFilter("window", "hot");
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

  /**
   * A #tag — a card's, a suggestion's — narrows the feed to it, and only that (it never opens the item): in a feed view the tag joins
   * its filters; anywhere else (与我相关, a search) it opens 全部 with it. The search lets go, and the view it began in comes back.
   */
  const chooseTag = (chosen: FrontierTagRef) => {
    trackFrontierFilter("tag", forYouOpen ? "for-you" : listSurface);
    rememberTagName(chosen.slug, chosen.name);
    const updated = new URLSearchParams(params);
    const origin = searchOrigin.current;
    searchOrigin.current = null;
    // 与我相关 is the server's ranking, which no filter narrows: a tag chosen there opens 全部 with it.
    const target: PageView = q ? (origin && FEED_VIEWS.has(origin) ? origin : "all") : FEED_VIEWS.has(view) && !forYouOpen ? view : "all";
    for (const name of ["q", "sort", "day", "week", "item", "scope", "zoneSpecialty", "request"]) updated.delete(name);
    if (target === "selected") updated.delete("view"); else updated.set("view", target);
    if (target !== "all") updated.delete("window");
    if (target !== "following") updated.delete("follow");
    updated.set("tag", chosen.slug);
    setDraft("");
    setParams(updated, { replace: target === view });
  };
  // A tag merged into another reads as that one: the address follows it.
  const onTagMerged = useCallback((slug: string) => setParams((current) => {
    const updated = new URLSearchParams(current);
    updated.set("tag", slug);
    return updated;
  }, { replace: true }), [setParams]);
  const tagName = useTagName(tag, onTagMerged);
  const tagFollow = useTagFollow(tag, tagName);
  const hotTags = useHotTags(FEED_VIEWS.has(view) ? specialties : []);
  // Whether the reader follows a chosen specialty (「筛选」's 关注) or a search's words (「关注“<词>”」): read while either is on screen.
  const bandFollows = useFollowSet(ready && (specialties.length > 0 || (Boolean(q) && view !== "zones")));
  const suggestions = useTagSuggestions(draft, ready && view !== "zones" && !composing.current);

  /** What the box holds, as the address's search: at once on Enter, a moment after the typing stops otherwise. */
  const commitSearch = useCallback((raw: string) => {
    const text = raw.trim().slice(0, 200);
    if (text === q) return;
    const updated = new URLSearchParams(params);
    if (view === "zones") {
      // The zones' own search: it stays in 证据专区.
      if (text) updated.set("q", text); else updated.delete("q");
    } else if (text) {
      // A search's words never leave the page: only that one ran.
      trackFrontierFilter("search", "search");
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
  }, [params, q, setParams, view]);

  useEffect(() => { setDraft(q); }, [q]);
  useEffect(() => {
    if (composing.current || draft.trim().slice(0, 200) === q) return;
    const timer = setTimeout(() => commitSearch(draft), 300);
    return () => clearTimeout(timer);
  }, [draft, composed, q, commitSearch]);

  useEffect(() => {
    const position = restore.current;
    if (!position || position.query !== params.toString() || listingView || !ready) return;
    const settled = view === "hot" ? Boolean(hot[hotWindow]) : view === "daily" ? !daily.loading
      : view === "following" ? (forYouOpen ? forYou.kind !== "loading" : !following.loading)
        : view === "track" ? (trackSegment === "approvals" ? approvals.state.kind !== "loading" : trackSegment === "guidelines" ? guidelines.state.kind !== "loading" : congresses.kind !== "loading")
          : view === "zones" ? !zones.loading : view === "weekly";
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
  }, [params, listingView, ready, view, hot, hotWindow, daily.loading, forYou.kind, zones.loading, forYouOpen, following.loading, trackSegment, approvals.state.kind, guidelines.state.kind, congresses.kind]);

  useEffect(() => {
    const remember = () => {
      const position: FrontierReadingPosition = { query: params.toString(), pages: Math.min(pages.current, 20),
        scroll: pageRoot.current?.querySelector<HTMLElement>(".overflow-y-auto")?.scrollTop ?? 0, expanded };
      const history = window.history.state as { usr?: Record<string, unknown> } | null;
      window.history.replaceState({ ...history, usr: { ...history?.usr, frontierReading: position } }, "");
    };
    window.addEventListener(FRONTIER_LEAVING, remember);
    return () => window.removeEventListener(FRONTIER_LEAVING, remember);
  }, [params, expanded, view]);

  // What is seen and opened in every list on the page (frontierTracking): observed again whenever what it shows changes.
  useFrontierListTracking(pageRoot, [listing, view, forYou, hot, daily.issue, weekly.issue, safety, ready, approvals.rows, guidelines.rows]);

  /* ---------------------------------------------------------- render */

  const card = (item: FrontierItem, grouped: boolean) => (
    <FrontierCard
      key={item.id}
      item={item}
      grouped={grouped}
      markSelected={view !== "selected"}
      onStar={(target) => void toggleStar(target)}
      onHide={hideStrips.start}
      hideStrip={hideStrips.strip(item.id)}
      onSave={saveOffered ? (target) => void save(target) : undefined}
      saving={savingId === item.id}
      onOpened={opened}
      onTag={chooseTag}
    />
  );
  const clearFilters = () => setFilters({ ...NO_FILTERS, byTime: false });
  // A search's words as a topic follow (owner, 2026-10-25), offered once it is known whether they are followed already.
  const searchFollowed = q ? bandFollows.followed("topic", q) : null;
  const searchFollow = q && searchFollowed !== null ? {
    label: searchFollowed ? `已关注“${q}”` : `关注“${q}”`,
    disabled: searchFollowed || bandFollows.pending("topic", q),
    onClick: () => bandFollows.follow("topic", q, q),
  } : null;

  /** The address of one entry of 关注: its filters kept, the search, the day and an open item let go of. */
  const followHref = (entry: FollowChoice) => {
    const updated = new URLSearchParams(params);
    updated.set("view", "following");
    updated.set("follow", followChoiceParam(entry));
    for (const name of ["q", "sort", "day", "week", "window", "item", "scope", "zoneSpecialty", "request"]) updated.delete(name);
    return `/app/frontier?${updated.toString()}`;
  };
  const showAllFollows = () => setParams((current) => {
    const updated = new URLSearchParams(current); updated.set("follow", "all"); return updated;
  });
  const followList = (onPick?: () => void, onManage?: () => void) => choice && (
    <FollowList state={following} choice={choice} hrefFor={followHref} onManage={onManage ?? (() => setManageFollows(true))} titled={Boolean(onPick)}
      onCreateZone={() => { onPick?.(); openEditor(); }}
      onPick={() => { trackFrontierFilter("follow", "follows"); onPick?.(); }} />
  );
  // The onboarding card's answer becomes the first follows; then the view and 与我相关 are read again.
  const answered = (answer: FrontierPrefs | undefined) => {
    void followAnswers(answer, following.topics).finally(() => {
      following.retry();
      setForYouAttempt((value) => value + 1);
    });
  };
  const narrowedLabel = choice && following ? followChoiceLabel(choice, following) : null;

  // Over the results, a lead to the zones the words belong to: a search names one, a chosen tag is in some (ZoneLeadLine).
  const zoneLead = q && view === "all"
    ? <ZoneLeadLine kind="search" query={q} onCreate={(text) => openEditor({ text, generate: true })} />
    : tag && listingView ? <ZoneLeadLine kind="tag" query={tagName} /> : null;
  const feed = (
    <>{zoneLead}<div data-frontier-list={listSurface} className="contents"><FeedList
      view={view === "all" || view === "following" ? "all" : "selected"}
      q={q}
      filtered={filtered}
      listing={listing && listing.key === key ? listing : null}
      error={listError}
      fresh={fresh?.count ?? 0}
      empty={view === "following" ? (typedFollow ? `暂时没有匹配“${typedFollow.label}”的动态，有新的会出现在这里` : "关注的内容暂时没有新动态") : undefined}
      firstRun={status ? status.lastPublishedAt === null : true}
      loadingMore={loadingMore}
      renderItem={card}
      onRetry={() => void loadList(true)}
      onFresh={() => { if (fresh) { pages.current = 1; serve(listSurface, fresh.page); show(fresh.listing); scrollToListTop(); } }}
      onMore={() => void loadMore()}
      onAll={() => setView("all")}
      onClear={() => { clearFilters(); setDraft(""); }}
      unread={{ pressed: unread, onChange: (next) => setFilters({ unread: next }) }}
      followSearch={searchFollow}
      // 精选 leaves a title-only safety alert to the strip above it (owner, 2026-10-27); 全部 and 关注 draw every item.
      omit={view === "selected" ? foldedIntoStrip : undefined}
    /></div></>
  );

  const openWeek = (next: string) => setParams((current) => {
    const updated = new URLSearchParams(current); updated.set("week", next); return updated;
  });
  const toolbar = frontierToolbar({
    view,
    onView: setView,
    filters: { channel, lane, specialties, tag, evidence, industryKind, starred, unread, window: windowFilter, byTime },
    onFilters: setFilters,
    showWindow: view === "all",
    searching: Boolean(q),
    tag: tag ? { slug: tag, name: tagName, followed: tagFollow.followed, following: tagFollow.following, onFollow: tagFollow.follow } : null,
    hotTags,
    search: {
      label: "搜索",
      value: draft,
      maxLength: 200,
      onChange: setDraft,
      onClear: () => setDraft(""),
      onSubmit: () => commitSearch(draft),
      // Typing offers the tags whose name holds the words; choosing one narrows the feed to it, and Enter still searches the words.
      suggestions: view === "zones" ? undefined : {
        label: "标签建议",
        items: suggestions.map((entry) => ({ value: entry.slug, label: `#${entry.name}` })),
        onPick: (slug) => {
          const picked = suggestions.find((entry) => entry.slug === slug);
          if (picked) chooseTag(picked);
        },
      },
      inputProps: {
        onCompositionStart: () => { composing.current = true; },
        onCompositionEnd: (event) => { composing.current = false; setDraft(event.currentTarget.value); setComposed((value) => value + 1); },
      },
    },
    specialtyFollow: (key) => {
      const followed = bandFollows.followed("specialty", key);
      return followed === null ? null : {
        label: followed ? "已关注" : "关注", disabled: followed || bandFollows.pending("specialty", key),
        onClick: () => bandFollows.follow("specialty", key, specialtyLabel(key)),
      };
    },
    hot: {
      window: hotWindow,
      board: hot[hotWindow]?.board ?? null,
      windows: Object.values(hot).some((entry) => Boolean(entry?.board?.takenAt)),
      onWindow: setHotWindow,
    },
    following: {
      // The feed's filters belong to a list of items: the whole of the follows (once there is one) or the one narrowed to.
      feed: listingView && view === "following",
      // On a phone the list of follows is in the sheet, so the one the list is narrowed to is said on the row.
      token: narrow && narrowedLabel ? { label: `只看：${narrowedLabel}`, onRemove: showAllFollows } : null,
      followList: narrow ? (close) => followList(close, () => { close(); setManageFollows(true); }) : undefined,
    },
    issue: dailyControls(view === "weekly" ? weekly : daily, { weekly: view === "weekly", onDay: view === "weekly" ? openWeek : openDay, beside: !narrow }),
    track: {
      filters: trackControls({ segment: trackSegment, onSegment: setTrackSegment, agency: trackAgency, onAgency: (next) => setTrackFilter("agency", next), approvals: approvals.state,
        specialty: trackSpecialty, onSpecialty: (next) => setTrackFilter("guidelineSpecialty", next), guidelines: guidelines.state }),
    },
    zones: {
      ...zoneDirectoryControls({ view: zoneView, onView: setZoneView, specialty: zoneSpecialty, onSpecialty: setZoneSpecialty, directory: zones }),
    },
    onClear: () => { clearFilters(); setDraft(""); },
    onReset: () => setFilters(NO_FILTERS),
  });

  const main = (() => {
    switch (view) {
      case "hot":
        return (
          <>
            <CongressNowLine />
            <div data-frontier-list="hot" className="contents"><HotBoard state={hot[hotWindow] ?? null} onRetry={() => setHotAttempt((value) => value + 1)} /></div>
          </>
        );
      case "track":
        return (
          <TrackBody segment={trackSegment} approvals={approvals} agency={trackAgency} onAgency={(next) => setTrackFilter("agency", next)}
            guidelines={guidelines} specialty={trackSpecialty} onSpecialty={(next) => setTrackFilter("guidelineSpecialty", next)} congresses={congresses} />
        );
      case "weekly":
        return <div data-frontier-list="weekly" className="contents"><WeeklyView expansion={{ ids: expanded, onExpand: (id) => setExpanded((current) => [...new Set([...current, id])]) }} state={weekly} onWeek={openWeek} /></div>;
      case "daily":
        return <div data-frontier-list="daily" className="contents"><DailyIssue expansion={{ ids: expanded, onExpand: (id) => setExpanded((current) => [...new Set([...current, id])]) }} state={daily} onDay={openDay} /></div>;
      case "following":
        return (
          <FollowingView state={following} choice={choice ?? { kind: "foryou" }} list={narrow ? null : followList()} feed={feed}
            onAdd={() => setManageFollows(true)} onAnswered={answered}
            forYou={<ForYouView state={forYou} renderItem={(item) => card(item, false)} onRetry={() => setForYouAttempt((value) => value + 1)} onOnboarded={answered} />} />
        );
      case "zones":
        return (
          <ZoneDirectoryBody state={zones} query={q} onCreate={(text, generate) => openEditor(text ? { text, ...(generate ? { generate } : {}) } : undefined)}
            onClearFilters={() => { setDraft(""); if (zoneSpecialty) setZoneSpecialty(""); }}
            from={{ to: `/app/frontier?${params.toString()}`, label: "证据专区" }} />
        );
      case "all":
        return (
          <>
            {feed}
            <div className="mt-8"><SourcesLink count={status?.sources.enabled ?? 0} /></div>
          </>
        );
      default:
        return (
          <>
            {/* A column with a gap, not space-y: the two wrappers are `contents`, and a margin on a box that draws nothing never shows (the strip
              * sat on the hot card's edge). The gap falls between what they draw. */}
            <div className="flex flex-col gap-4">
              <div data-frontier-list="safety" className="contents"><SafetyStrip alerts={safety} onRetry={() => setSafetyAttempt((value) => value + 1)} onOpened={opened} /></div>
              {!q && !filtered && <div data-frontier-list="hot" className="contents"><HotCard events={hot.current?.board?.events ?? []} onOpenAll={() => setView("hot")} /></div>}
            </div>
            <div className="mt-8">{feed}</div>
          </>
        );
    }
  })();

  return (
    <div ref={pageRoot} className="h-full min-h-0"><PageShell
      title="前沿动态"
      actionPlan={frontierHeaderActions(view, zones.canCreate ? () => openEditor() : null)}
      toolbar={toolbar}
    >
      {ready && params.get("item") && (
        <FrontierLinkedItem id={params.get("item")!} onClose={() => setParams((current) => {
          const updated = new URLSearchParams(current); updated.delete("item"); return updated;
        }, { replace: true })} />
      )}
      {ready ? main : <FrontierSkeleton />}
      {manageFollows && <Drawer title="管理关注" onClose={() => setManageFollows(false)}>
        <FrontierFollows onCreateZone={() => { setManageFollows(false); openEditor(); }} selected={choice?.kind === "follow" ? choice.id : null} onSelect={(id) => {
          trackFrontierFilter("follow", "follows");
          setParams((current) => {
            const updated = new URLSearchParams(current);
            updated.set("view", "following");
            // A follow chosen opens it; one taken away (removed, muted) leaves the whole of the follows.
            updated.set("follow", id ?? "all");
            return updated;
          });
          setManageFollows(false);
        }} onChanged={() => { cache.current.clear(); if (listingView) void loadList(true); }} />
      </Drawer>}
      {editor && (
        <ZoneEditorDrawer
          mode="create"
          seed={editor.seed}
          onClose={() => setEditor(null)}
          onSaved={(zone) => {
            setEditor(null);
            rememberFrontierPosition();
            navigate(zonePath(zone), { state: { evidenceFrom: { to: `/app/frontier?${params.toString()}`, label: "证据专区" } } });
          }}
        />
      )}
    </PageShell></div>
  );
}

function scrollToListTop() {
  document.getElementById("frontier-list-top")?.scrollIntoView({ block: "start" });
}
