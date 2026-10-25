import { useEffect, useRef, type RefObject } from "react";
import {
  FRONTIER_ARRIVAL,
  FRONTIER_DWELL,
  FRONTIER_IMPRESSION,
  FRONTIER_INTERACTION_BATCH,
  FRONTIER_LIST_SURFACES,
  FRONTIER_READ_DEPTHS,
  FRONTIER_SESSION_IDLE_MS,
  frontierInteraction,
  type FrontierInteraction,
} from "@evimed/domain";
import { getWebApiRequestHeaders, webApiBase, WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT } from "./apiClient";

/**
 * What a reader of 「前沿动态」 saw and did, reported to the control plane (ct-track, 2026-10-24). The owner: ranking and cold
 * start are the server's; the page carries tracking, done properly. Nothing here draws anything.
 *
 * Hidden knowledge:
 *
 * - **Seen, not rendered.** A card or a row counts as an impression once at least half of it was in view for one continuous
 *   second in a visible tab (`FRONTIER_IMPRESSION`, the MRC/IAB floor): an IntersectionObserver at 0.5, a one-second timer per
 *   element, every timer stopped when the tab is hidden and started again for what is still in view when it comes back. Once
 *   per list and item.
 * - **Joinable to what was served.** A list the page shows sits in a `[data-frontier-list="<surface>"]` container; each list
 *   answer's `listId` and slots are registered (`serveFrontierList`), so an impression and an open carry the list id, the slot
 *   and the position the entry is displayed at. An open also makes a `view` id and hands it to the reading page, whose dwell,
 *   read depth and actions carry it: they join the open, and through it the list.
 * - **Dwell survives tab switches and closes.** The reading page counts visible time while the reader is not idle
 *   (`FRONTIER_DWELL.idleMs` with no scroll, key, pointer or touch stops the clock) and reports it on `visibilitychange` to
 *   hidden (the last moment a browser reliably lets a page speak), on `pagehide`, and on leaving the page; a page restored from
 *   the back/forward cache (`pageshow` with `persisted`) starts again.
 * - **Delivery.** Events queue in memory and in this tab's `sessionStorage`, flush in batches of at most 50 a few seconds
 *   after the last one (`fetch(…, { keepalive: true })` with the CSRF header, its answer read), and on hide or page hide at
 *   once — with `navigator.sendBeacon` and a `text/plain` body carrying the token, or a kept-alive request where a beacon
 *   cannot be queued. The server is idempotent on each
 *   event's id, so a retry or a re-send after a reload never counts twice. A refused batch (other than 429 and 5xx) is
 *   dropped; a 429 waits for `Retry-After`; a failure backs off. Signing out empties the queue.
 * - **Nothing personal.** No URL, no query text, no free text: closed words, public ids, numbers, the layout class and a
 *   random session id this tab rotates after 30 idle minutes (`FRONTIER_SESSION_IDLE_MS`). Every event passes the same
 *   validator the server uses before it is queued.
 *
 * @module frontierTracking
 */

export type FrontierTrackSurface = FrontierInteraction["surface"];

/**
 * How the reader arrived, when the address says so: `push` for a link a notification carried here (`frontierNoticeHref` ends each in
 * `from=push`), else null. A reading page reached that way without a list opens as `push`, not `direct` (G12, 2026-10-25).
 */
export function frontierArrival(search: string | URLSearchParams): "push" | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return params.get(FRONTIER_ARRIVAL.param) === FRONTIER_ARRIVAL.push ? "push" : null;
}
export type FrontierTrackSlot = NonNullable<FrontierInteraction["slot"]>;
type TrackInput = Partial<Omit<FrontierInteraction, "id" | "at" | "session" | "device">> & Pick<FrontierInteraction, "type" | "surface">;

const QUEUE_KEY = "evimed.frontier.events";
const SESSION_KEY = "evimed.frontier.session";
const OPEN_KEY = "evimed.frontier.open";
/** The most events kept waiting; the oldest go first past it (a tab offline for long). */
const QUEUE_MAX = 200;
/** A quiet moment before a batch goes; a full batch goes at once. */
const FLUSH_DELAY_MS = 4_000;
const FLUSH_AT = 20;
/** Backoff after a failed send, doubling to its ceiling. */
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
/** An open handed to the reading page counts for the item it names within this long. */
const OPEN_HANDOFF_MS = 60_000;
/** The dwell clock is moved at least this often while a reading page is open. */
const DWELL_TICK_MS = 15_000;
const ITEM_PATH = /\/frontier\/items\/([^/?#]+)/;
const EVENT_PATH = /\/frontier\/events\/([^/?#]+)/;

let queue: FrontierInteraction[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 0;
let blockedUntil = 0;
let sending = false;
let restored = false;
/** Counts the page keeps for its own tests and a curious developer: sent, dropped by reason. */
export const frontierTrackingCounters = { queued: 0, sent: 0, dropped: 0, invalid: 0 };

/* ------------------------------------------------------------------ plumbing */

function storage(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}

function randomId(prefix: string): string {
  const cryptoApi = typeof crypto === "undefined" ? null : crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return `${prefix}_${cryptoApi.randomUUID().replace(/-/g, "")}`;
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** This tab's session id, rotated after 30 minutes with nothing reported. */
function sessionId(now: number): string {
  const store = storage();
  try {
    const current = JSON.parse(store?.getItem(SESSION_KEY) ?? "null") as { id?: unknown; at?: unknown } | null;
    if (current && typeof current.id === "string" && typeof current.at === "number" && now - current.at < FRONTIER_SESSION_IDLE_MS) {
      store?.setItem(SESSION_KEY, JSON.stringify({ id: current.id, at: now }));
      return current.id;
    }
  } catch { /* a session that cannot be read is a new one */ }
  const id = randomId("ses");
  try { store?.setItem(SESSION_KEY, JSON.stringify({ id, at: now })); } catch { /* kept for this event only */ }
  return id;
}

function device(): "narrow" | "wide" {
  return typeof window !== "undefined" && window.innerWidth >= 1024 ? "wide" : "narrow";
}

function persist() {
  try { storage()?.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch { /* the queue stays in memory */ }
}

function restore() {
  if (restored) return;
  restored = true;
  try {
    const stored = JSON.parse(storage()?.getItem(QUEUE_KEY) ?? "[]") as unknown[];
    const now = Date.now();
    const kept = Array.isArray(stored) ? stored.flatMap((raw) => { const result = frontierInteraction(raw, { now }); return result.ok ? [result.event] : []; }) : [];
    const known = new Set(queue.map((event) => event.id));
    queue = [...kept.filter((event) => !known.has(event.id)), ...queue].slice(-QUEUE_MAX);
  } catch { /* nothing to restore */ }
  if (typeof window !== "undefined") {
    const clear = () => { queue = []; persist(); };
    window.addEventListener(WEB_SESSION_ENDED_EVENT, clear);
    // A new sign-in in this tab starts from nothing: nothing of another account's queue is sent under this one.
    window.addEventListener(WEB_SESSION_STARTED_EVENT, clear);
    window.addEventListener("pagehide", () => flushFrontierEvents("unload"));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushFrontierEvents("unload"); });
  }
  if (queue.length) schedule();
}

/** An event as it travels: the fields it has, none of the empty ones (the server reads an absent field as none). */
function wire(batch: readonly FrontierInteraction[]): Array<Partial<FrontierInteraction>> {
  return batch.map((event) => Object.fromEntries(Object.entries(event).filter(([, value]) => value !== null)) as Partial<FrontierInteraction>);
}

function eventsUrl(): string {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  return `${root}/frontier/events`;
}

function schedule(delay = queue.length >= FLUSH_AT ? 0 : FLUSH_DELAY_MS) {
  if (timer) clearTimeout(timer);
  const wait = Math.max(delay, blockedUntil - Date.now(), 0);
  timer = setTimeout(() => { timer = null; flushFrontierEvents("normal"); }, wait);
}

/**
 * Queue one event: its id, time, session and layout are filled in, it is checked by the server's own validator (what would be
 * refused is not sent), and a batch is scheduled.
 */
export function trackFrontier(input: TrackInput): void {
  restore();
  const now = Date.now();
  const candidate = { ...input, id: randomId("evt"), at: now, session: sessionId(now), device: device() };
  const result = frontierInteraction(Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined && value !== null)), { now });
  if (!result.ok) { frontierTrackingCounters.invalid += 1; return; }
  queue.push(result.event);
  frontierTrackingCounters.queued += 1;
  if (queue.length > QUEUE_MAX) { frontierTrackingCounters.dropped += queue.length - QUEUE_MAX; queue = queue.slice(-QUEUE_MAX); }
  persist();
  schedule();
}

/**
 * Send what is queued. `unload`: the page is being hidden or left — send now, with a request the browser keeps alive (or a
 * beacon), and expect no answer; `normal`: one batch, its answer read, the rest scheduled.
 */
export function flushFrontierEvents(mode: "normal" | "unload" = "normal"): void {
  restore();
  if (!queue.length || (mode === "normal" && (sending || Date.now() < blockedUntil))) return;
  if (timer) { clearTimeout(timer); timer = null; }
  const headers = getWebApiRequestHeaders();
  const csrf = headers["X-Open-Science-CSRF"];
  if (mode === "unload") {
    // Everything, in batches, now: the page may not get another turn.
    while (queue.length) {
      const batch = queue.slice(0, FRONTIER_INTERACTION_BATCH.maxEvents);
      if (!sendNow(batch, headers, csrf)) break;
      queue = queue.slice(batch.length);
      frontierTrackingCounters.sent += batch.length;
    }
    persist();
    return;
  }
  const batch = queue.slice(0, FRONTIER_INTERACTION_BATCH.maxEvents);
  sending = true;
  let request: Promise<Response>;
  try {
    request = fetch(eventsUrl(), { method: "POST", keepalive: true, credentials: "include", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ events: wire(batch) }) });
  } catch {
    sending = false;
    backoff();
    return;
  }
  request.then((response) => {
    sending = false;
    const sent = new Set(batch.map((event) => event.id));
    if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
      // Kept, or refused for good (a malformed batch, no session): either way it is not sent again.
      queue = queue.filter((event) => !sent.has(event.id));
      if (response.ok) frontierTrackingCounters.sent += batch.length; else frontierTrackingCounters.dropped += batch.length;
      retryMs = 0;
      persist();
      if (queue.length) schedule(0);
      return;
    }
    const retryAfter = Number(response.headers.get("Retry-After"));
    if (response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) { blockedUntil = Date.now() + retryAfter * 1000; schedule(); return; }
    backoff();
  }, () => { sending = false; backoff(); });
}

function backoff() {
  retryMs = Math.min(RETRY_MAX_MS, retryMs ? retryMs * 2 : RETRY_BASE_MS);
  blockedUntil = Date.now() + retryMs;
  schedule();
}

/**
 * One batch sent without waiting for its answer, as a page that is going away must: a beacon (a `text/plain` body carrying the
 * token — the browser's most reliable channel at this moment), else a kept-alive request with the header.
 */
function sendNow(batch: FrontierInteraction[], headers: Record<string, string>, csrf: string | undefined): boolean {
  if (csrf && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      if (navigator.sendBeacon(eventsUrl(), new Blob([JSON.stringify({ events: wire(batch), csrf })], { type: "text/plain;charset=UTF-8" }))) return true;
    } catch { /* the request below */ }
  }
  try {
    void fetch(eventsUrl(), { method: "POST", keepalive: true, credentials: "include", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ events: wire(batch) }) }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Forget the queue and the registries (tests). */
export function resetFrontierTracking(): void {
  queue = [];
  if (timer) clearTimeout(timer);
  timer = null;
  retryMs = 0;
  blockedUntil = 0;
  sending = false;
  served.clear();
  seen.clear();
  lastSurface.clear();
  reader = null;
  try { storage()?.removeItem(QUEUE_KEY); storage()?.removeItem(OPEN_KEY); storage()?.removeItem(SESSION_KEY); } catch { /* nothing kept */ }
}

/** What is queued (tests). */
export function pendingFrontierEvents(): readonly FrontierInteraction[] { return queue; }

/* ------------------------------------------------------------------ what was served */

interface Served { listId: string | null; slot: FrontierTrackSlot | null; rank: number }
/** surface → (`item:<id>` | `event:<id>`) → the last list that served it there. */
const served = new Map<string, Map<string, Served>>();
/** Impressions already reported, per list (or surface) and target. */
const seen = new Set<string>();
/** The surface each item was last served on: where an action from a card names it (`trackFrontierItemAction` without a surface). */
const lastSurface = new Map<string, FrontierTrackSurface>();

/**
 * Register a list answer: its id and each entry's slot, in served order from `offset` (a feed's later pages continue it).
 * Impressions and opens of these entries on this surface carry them.
 */
export function serveFrontierList(surface: FrontierTrackSurface, listId: string | null | undefined,
  entries: ReadonlyArray<{ id: string; kind?: "item" | "event"; slot?: FrontierTrackSlot | null }>, { offset = 0 }: { offset?: number } = {}): void {
  const table = served.get(surface) ?? new Map<string, Served>();
  entries.forEach((entry, index) => {
    table.set(`${entry.kind ?? "item"}:${entry.id}`, { listId: listId ?? null, slot: entry.slot ?? null, rank: offset + index });
    if ((entry.kind ?? "item") === "item") lastSurface.set(entry.id, surface);
  });
  if (lastSurface.size > 5_000) lastSurface.clear();
  served.set(surface, table);
  if (served.size > 50 || table.size > 2_000) for (const [key] of [...table].slice(0, table.size - 1_500)) table.delete(key);
}

function servedFor(surface: string, key: string): Served | null {
  return served.get(surface)?.get(key) ?? null;
}

/* ------------------------------------------------------------------ lists: impressions and opens */

interface Target { kind: "item" | "event"; id: string }

function targetOf(element: Element): Target | null {
  const item = (element as HTMLElement).dataset?.frontierItem;
  if (item) return { kind: "item", id: item };
  const href = element.getAttribute("href") ?? "";
  const itemMatch = ITEM_PATH.exec(href);
  if (itemMatch) return { kind: "item", id: decodeURIComponent(itemMatch[1]) };
  const eventMatch = EVENT_PATH.exec(href);
  if (eventMatch) return { kind: "event", id: decodeURIComponent(eventMatch[1]) };
  return null;
}

const TRACKED = "[data-frontier-item], a[href*='/frontier/items/'], a[href*='/frontier/events/']";

/** The entries of a list container in display order, each once, with their position. */
function entriesOf(container: Element): Array<{ element: Element; target: Target; position: number }> {
  const out: Array<{ element: Element; target: Target; position: number }> = [];
  const keys = new Set<string>();
  for (const element of container.querySelectorAll(TRACKED)) {
    // A card's own links are the card; a nested list is its own.
    if (element.tagName === "A" && element.closest("[data-frontier-item]")) continue;
    if (element.closest("[data-frontier-list]") !== container) continue;
    const target = targetOf(element);
    if (!target) continue;
    const key = `${target.kind}:${target.id}`;
    if (keys.has(key)) continue;
    keys.add(key);
    out.push({ element, target, position: out.length });
  }
  return out;
}

function listContext(container: Element, target: Target, position: number) {
  const surface = (container as HTMLElement).dataset.frontierList as FrontierTrackSurface;
  const known = servedFor(surface, `${target.kind}:${target.id}`);
  const fallback = (container as HTMLElement).dataset.frontierListId || null;
  return { surface, list: known?.listId ?? fallback, slot: known?.slot ?? null, position };
}

/** Hand an open's view id to the reading page it leads to. */
function handOpen(item: string, view: string) {
  try { storage()?.setItem(OPEN_KEY, JSON.stringify({ item, view, at: Date.now() })); } catch { /* the reading page makes its own */ }
}

function takeOpen(item: string): string | null {
  try {
    const stored = JSON.parse(storage()?.getItem(OPEN_KEY) ?? "null") as { item?: unknown; view?: unknown; at?: unknown } | null;
    storage()?.removeItem(OPEN_KEY);
    if (stored && stored.item === item && typeof stored.view === "string" && typeof stored.at === "number" && Date.now() - stored.at < OPEN_HANDOFF_MS) return stored.view;
  } catch { /* none */ }
  return null;
}

/**
 * Impressions and opens of every list under `root` (`[data-frontier-list]` containers): observed again whenever `deps` change
 * (a page loaded, a view switched). Mount once per page.
 */
export function useFrontierListTracking(root: RefObject<HTMLElement | null>, deps: readonly unknown[]): void {
  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const open = (event: MouseEvent) => {
      if (event.type === "auxclick" && event.button !== 1) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      const container = anchor?.closest("[data-frontier-list]");
      if (!anchor || !container) return;
      const target = targetOf(anchor);
      if (!target) return;
      const entry = entriesOf(container).find((candidate) => candidate.target.kind === target.kind && candidate.target.id === target.id);
      const context = listContext(container, target, entry?.position ?? 0);
      const view = target.kind === "item" ? randomId("view") : null;
      trackFrontier({ type: "open", ...context, ...(target.kind === "item" ? { item: target.id, view } : { event: target.id }) });
      if (view) handOpen(target.id, view);
    };
    element.addEventListener("click", open, true);
    element.addEventListener("auxclick", open, true);
    return () => { element.removeEventListener("click", open, true); element.removeEventListener("auxclick", open, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ref's element is read when the page's content changes
  }, deps);

  useEffect(() => {
    const element = root.current;
    if (!element || typeof IntersectionObserver === "undefined") return undefined;
    const contexts = new Map<Element, { key: string; target: Target; context: ReturnType<typeof listContext> }>();
    for (const container of element.querySelectorAll("[data-frontier-list]")) {
      // `push` marks where an open came from (a notification's card), not a list a reader scrolls: nothing is seen on it.
      if (!FRONTIER_LIST_SURFACES.includes((container as HTMLElement).dataset.frontierList as FrontierTrackSurface)) continue;
      for (const { element: entry, target, position } of entriesOf(container)) {
        const context = listContext(container, target, position);
        contexts.set(entry, { key: `${context.list ?? context.surface}:${target.kind}:${target.id}`, target, context });
      }
    }
    const visible = new Set<Element>();
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const stop = (entry: Element) => { const pending = timers.get(entry); if (pending) clearTimeout(pending); timers.delete(entry); };
    const start = (entry: Element) => {
      const known = contexts.get(entry);
      if (!known || seen.has(known.key) || timers.has(entry) || document.visibilityState !== "visible") return;
      timers.set(entry, setTimeout(() => {
        timers.delete(entry);
        if (!visible.has(entry) || document.visibilityState !== "visible" || seen.has(known.key)) return;
        seen.add(known.key);
        if (seen.size > 5_000) seen.clear();
        trackFrontier({ type: "impression", ...known.context, value: FRONTIER_IMPRESSION.minMs,
          ...(known.target.kind === "item" ? { item: known.target.id } : { event: known.target.id }) });
      }, FRONTIER_IMPRESSION.minMs));
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= FRONTIER_IMPRESSION.minRatio) { visible.add(entry.target); start(entry.target); }
        else { visible.delete(entry.target); stop(entry.target); }
      }
    }, { threshold: [0, FRONTIER_IMPRESSION.minRatio] });
    for (const entry of contexts.keys()) observer.observe(entry);
    const onVisibility = () => {
      if (document.visibilityState === "visible") for (const entry of visible) start(entry);
      else for (const entry of [...timers.keys()]) stop(entry);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const entry of [...timers.keys()]) stop(entry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-observed when the page's content changes
  }, deps);
}

/* ------------------------------------------------------------------ the reading page */

/** The reading page open now: its item and view, so an action taken on it says so. */
let reader: { item: string; view: string } | null = null;

function readerRoot(): Element | null {
  if (typeof document === "undefined") return null;
  return document.querySelector("[data-frontier-reader]") ?? document.querySelector("article[aria-label='正文']");
}

/**
 * The reading page's tracking, one line in its component: the open (handed from the list, or `direct`), visible engaged dwell
 * on hide / page hide / leaving, read depth of the body (25/50/75/100) and the end reached, the language switch, the body
 * opened, a star or a hide, the original followed, another report opened. Hooks onto `[data-frontier-reader]`.
 */
export function useFrontierReadTracking(itemId: string | null | undefined, { language, expanded, url, state, arrival }: {
  language?: string; expanded?: boolean; url?: string | null; state?: { starred?: boolean; hidden?: boolean };
  /** How the page was reached when its address says so (`frontierArrival`): the open of a page no list handed is then `push`. */
  arrival?: "push" | null;
} = {}): void {
  const viewRef = useRef<string | null>(null);
  const urlRef = useRef(url ?? null);
  urlRef.current = url ?? null;
  const arrivalRef = useRef(arrival ?? null);
  arrivalRef.current = arrival ?? null;

  useEffect(() => {
    if (!itemId) return undefined;
    const handed = takeOpen(itemId);
    const view = handed ?? randomId("view");
    viewRef.current = view;
    reader = { item: itemId, view };
    if (!handed) trackFrontier({ type: "open", surface: arrivalRef.current === "push" ? "push" : "direct", item: itemId, view });
    const base = { surface: "reader" as const, item: itemId, view };
    let visibleNow = typeof document === "undefined" || document.visibilityState === "visible";
    let lastTick = Date.now();
    let lastActivity = lastTick;
    let engaged = 0;
    const account = (at: number) => {
      if (visibleNow) {
        const to = Math.min(at, lastActivity + FRONTIER_DWELL.idleMs);
        if (to > lastTick) engaged += to - lastTick;
      }
      lastTick = at;
    };
    const report = (unload: boolean) => {
      account(Date.now());
      const value = Math.min(Math.round(engaged), FRONTIER_DWELL.maxReportMs);
      engaged = 0;
      if (value >= 1) trackFrontier({ type: "dwell", ...base, value });
      if (unload) flushFrontierEvents("unload");
    };
    const reached = new Set<number>();
    let ended = false;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const body = readerRoot();
      if (!body || typeof window === "undefined") return;
      const rect = body.getBoundingClientRect();
      if (rect.height <= 0) return;
      const depth = Math.max(0, Math.min(1, (window.innerHeight - rect.top) / rect.height)) * 100;
      for (const mark of FRONTIER_READ_DEPTHS) {
        if (depth + 0.5 >= mark && !reached.has(mark)) { reached.add(mark); trackFrontier({ type: "read-depth", ...base, value: mark }); }
      }
      if (!ended && depth >= 99.5) { ended = true; trackFrontier({ type: "reach-end", ...base }); }
    };
    const activity = () => { account(Date.now()); lastActivity = lastTick; };
    const onScroll = () => { activity(); if (!frame) frame = requestAnimationFrame(measure); };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") { report(true); visibleNow = false; return; }
      visibleNow = true;
      lastTick = Date.now();
      lastActivity = lastTick;
    };
    const onPageHide = () => { report(true); visibleNow = false; };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) { visibleNow = true; lastTick = Date.now(); lastActivity = lastTick; } };
    const onClick = (event: MouseEvent) => {
      activity();
      if (event.type === "auxclick" && event.button !== 1) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor || anchor.closest("[data-frontier-list]")) return;
      const href = anchor.getAttribute("href") ?? "";
      if (urlRef.current && href === urlRef.current) { trackFrontier({ type: "open-original", ...base }); return; }
      const target = targetOf(anchor);
      if (!target || (target.kind === "item" && target.id === itemId)) return;
      trackFrontier({ type: "related-open", ...base, detail: target.kind });
      if (target.kind === "item") {
        const next = randomId("view");
        trackFrontier({ type: "open", surface: "reader", item: target.id, view: next });
        handOpen(target.id, next);
      }
    };
    const tick = setInterval(() => account(Date.now()), DWELL_TICK_MS);
    // The body's first layout, and a body already shorter than the window, are measured once they settle.
    const settle = setTimeout(measure, FRONTIER_IMPRESSION.minMs);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    for (const type of ["pointerdown", "keydown", "touchstart", "wheel"] as const) window.addEventListener(type, activity, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    return () => {
      report(false);
      clearInterval(tick);
      clearTimeout(settle);
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      for (const type of ["pointerdown", "keydown", "touchstart", "wheel"] as const) window.removeEventListener(type, activity);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onClick, true);
      if (reader?.view === view) reader = null;
      viewRef.current = null;
    };
  }, [itemId]);

  // What changes on the page after it opened: the language, the body opened, a star, a hide.
  const previous = useRef({ language, expanded, starred: state?.starred, hidden: state?.hidden, item: itemId });
  useEffect(() => {
    const before = previous.current;
    previous.current = { language, expanded, starred: state?.starred, hidden: state?.hidden, item: itemId };
    const view = viewRef.current;
    if (!itemId || !view || before.item !== itemId) return;
    const base = { surface: "reader" as const, item: itemId, view };
    if (language && before.language && language !== before.language && (language === "zh" || language === "original")) {
      trackFrontier({ type: "toggle-translation", ...base, detail: language });
    }
    if (expanded && !before.expanded) trackFrontier({ type: "expand-body", ...base });
    if (state?.starred !== undefined && before.starred !== undefined && state.starred !== before.starred) trackFrontier({ type: state.starred ? "star" : "unstar", ...base });
    if (state?.hidden && before.hidden === false) trackFrontier({ type: "hide", ...base });
  }, [itemId, language, expanded, state?.starred, state?.hidden]);
}

/* ------------------------------------------------------------------ actions anywhere */

/**
 * An action on an item, wherever it was taken: on the reading page open now it carries that view; from a list it carries the
 * list, slot and position the item was served at on `surface` — or, not given, on the surface it was last served on.
 */
export function trackFrontierItemAction(type: "star" | "unstar" | "hide" | "unhide" | "share" | "research" | "save" | "open-original", itemId: string,
  { surface, detail }: { surface?: FrontierTrackSurface; detail?: string } = {}): void {
  if (reader?.item === itemId) {
    trackFrontier({ type, surface: "reader", item: itemId, view: reader.view, ...(detail ? { detail } : {}) });
    return;
  }
  const where = surface ?? lastSurface.get(itemId) ?? null;
  const known = where ? servedFor(where, `item:${itemId}`) : null;
  trackFrontier({ type, surface: where ?? "direct", item: itemId, ...(detail ? { detail } : {}),
    ...(known ? { list: known.listId, slot: known.slot, position: known.rank } : {}) });
}

/** Which control of a list moved — never what it was set to. */
export function trackFrontierFilter(control: string, surface: FrontierTrackSurface): void {
  trackFrontier({ type: "filter-change", surface, detail: control });
}

/** The onboarding card: shown (once a session), finished, or skipped at a step. */
export function trackFrontierOnboarding(type: "onboarding-shown" | "onboarding-done" | "onboarding-skipped", detail?: string): void {
  if (type === "onboarding-shown") {
    const key = "evimed.frontier.onboarding-shown";
    try { if (storage()?.getItem(key)) return; storage()?.setItem(key, "1"); } catch { /* reported again, at worst */ }
  }
  trackFrontier({ type, surface: "for-you", ...(detail ? { detail } : {}) });
}
