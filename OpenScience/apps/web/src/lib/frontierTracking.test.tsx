import { act, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionGeneration } from "./sessionLifecycle";
import {
  flushFrontierEvents,
  trackFrontier,
  frontierArrival,
  pendingFrontierEvents,
  resetFrontierTracking,
  serveFrontierList,
  trackFrontierItemAction,
  useFrontierListTracking,
  useFrontierReadTracking,
} from "./frontierTracking";

const { meMock, actor, requestHeaders } = vi.hoisted(() => ({
  meMock: vi.fn<typeof import("./apiClient").fetchWebMe>(),
  actor: { current: null as import("./apiClient").VerifiedWebActor | null },
  requestHeaders: { "X-Open-Science-Project": "default", "X-Open-Science-CSRF": "csrf-token" },
}));

vi.mock("./apiClient", async (original) => ({
  ...await original<typeof import("./apiClient")>(),
  webApiBase: "",
  getWebApiRequestHeaders: () => requestHeaders,
  getVerifiedWebActor: () => actor.current?.generation === sessionGeneration() ? actor.current : null,
  fetchWebMe: (options?: Parameters<typeof import("./apiClient").fetchWebMe>[0]) => {
    const generation = sessionGeneration();
    return meMock(options).then(me => {
      if (generation === sessionGeneration() && me?.user?.id && me.tenant?.id && me.csrfToken) {
        actor.current = { generation, userId: me.user.id, tenantId: me.tenant.id, csrf: me.csrfToken };
      }
      return me;
    });
  },
}));

const LIST = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** An IntersectionObserver the test drives: `show(element, ratio)` reports one element at a ratio. */
class FakeObserver {
  static instances: FakeObserver[] = [];
  observed = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) { FakeObserver.instances.push(this); }
  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() { this.observed.clear(); }
  takeRecords() { return []; }
  report(element: Element, ratio: number) {
    this.callback([{ target: element, intersectionRatio: ratio, isIntersecting: ratio > 0 } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
const show = (element: Element, ratio: number) => act(() => { for (const observer of FakeObserver.instances) if (observer.observed.has(element)) observer.report(element, ratio); });
let visibility: DocumentVisibilityState = "visible";
/** jsdom cannot navigate: a link pressed in a test goes nowhere (the tracking listeners run before this one). */
const stay = (event: MouseEvent) => event.preventDefault();
const setVisibility = (state: DocumentVisibilityState) => act(() => { visibility = state; document.dispatchEvent(new Event("visibilitychange")); });

function Feed({ ids, listId = LIST }: { ids: string[]; listId?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useFrontierListTracking(root, [ids.join(",")]);
  return (
    <div ref={root}>
      <div data-frontier-list="for-you">
        <ul>{ids.map((id) => <li key={id} data-frontier-item={id}><a href={`/app/frontier/items/${id}`}>{id}</a></li>)}</ul>
      </div>
      <div data-frontier-list="hot"><a href="/app/frontier/events/9f3c2a1b4d5e6f70">hot event</a></div>
      <span data-testid={listId} />
    </div>
  );
}

function Reader({ item, language = "zh", expanded = false, starred = false }: { item: string; language?: string; expanded?: boolean; starred?: boolean }) {
  useFrontierReadTracking(item, { language, expanded, url: "https://www.nejm.org/doi/full/10.1056/x", state: { starred, hidden: false } });
  return (
    <article data-frontier-reader="" aria-label="正文">
      <a href="https://www.nejm.org/doi/full/10.1056/x" target="_blank" rel="noreferrer">阅读原文</a>
      <a href="/app/frontier/items/bbbbbbbbbbbb">another report</a>
    </article>
  );
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const ofType = (type: string) => pendingFrontierEvents().filter((event) => event.type === type);

const identity = (id = "user-a", tenantId = "tenant-a", csrfToken = "csrf-token") => ({
  user: { id, name: id, tenantId },
  tenant: { id: tenantId, model: "individual-account" as const, role: "owner" as const },
  csrfToken,
  project: { id: "default", name: "Default" },
  projects: [],
});
const verified = () => act(async () => { await Promise.resolve(); });
const forgetDocument = () => { actor.current = null; resetFrontierTracking(); };
const sessionBoundary = () => window.dispatchEvent(new StorageEvent("storage", { key: "open-science:web-session-sync", newValue: '{"kind":"started"}' }));

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  forgetDocument();
  requestHeaders["X-Open-Science-CSRF"] = "csrf-token";
  meMock.mockReset();
  meMock.mockResolvedValue(identity());
  FakeObserver.instances = [];
  visibility = "visible";
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { accepted: 1, duplicates: 0, dropped: {} } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  document.addEventListener("click", stay);
});
afterEach(() => {
  document.removeEventListener("click", stay);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("impressions: seen, not rendered", () => {
  it("counts a card half in view for one continuous second, with its list, slot and position, once", () => {
    serveFrontierList("for-you", LIST, [{ id: "aaaaaaaaaaaa", slot: "personal" }, { id: "bbbbbbbbbbbb", slot: "explore" }]);
    const { container } = render(<Feed ids={["aaaaaaaaaaaa", "bbbbbbbbbbbb"]} />);
    const [first, second] = container.querySelectorAll("[data-frontier-item]");
    show(first, 0.6);
    show(second, 0.3);
    act(() => { vi.advanceTimersByTime(999); });
    expect(ofType("impression")).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(1); });
    expect(ofType("impression").map((event) => [event.item, event.surface, event.list, event.slot, event.position, event.value]))
      .toEqual([["aaaaaaaaaaaa", "for-you", LIST, "personal", 0, 1000]]);
    show(second, 0.7);
    act(() => { vi.advanceTimersByTime(400); });
    show(second, 0.4);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(ofType("impression"), "scrolled past in under a second: not seen").toHaveLength(1);
    show(first, 0);
    show(first, 0.9);
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(ofType("impression"), "once per list and item").toHaveLength(1);
  });

  it("stops the clock in a hidden tab and starts it again for what is still in view", () => {
    serveFrontierList("for-you", LIST, [{ id: "aaaaaaaaaaaa", slot: "explore" }]);
    const { container } = render(<Feed ids={["aaaaaaaaaaaa"]} />);
    const card = container.querySelector("[data-frontier-item]")!;
    show(card, 1);
    act(() => { vi.advanceTimersByTime(600); });
    setVisibility("hidden");
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(ofType("impression"), "a background tab sees nothing").toHaveLength(0);
    setVisibility("visible");
    act(() => { vi.advanceTimersByTime(999); });
    expect(ofType("impression"), "the second starts again, continuous").toHaveLength(0);
    act(() => { vi.advanceTimersByTime(1); });
    expect(ofType("impression")).toHaveLength(1);
  });

  it("an event row of a list counts too, by its event id", () => {
    serveFrontierList("hot", LIST, [{ id: "9f3c2a1b4d5e6f70", kind: "event" }]);
    const { getByText } = render(<Feed ids={[]} />);
    show(getByText("hot event"), 1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(ofType("impression").map((event) => [event.event, event.item, event.surface, event.list])).toEqual([["9f3c2a1b4d5e6f70", null, "hot", LIST]]);
  });
});

describe("opens join the list and hand their view to the reading page", () => {
  it("an open carries list, slot and position, and the reading page carries its view on: dwell on hide, read to the end", async () => {
    serveFrontierList("for-you", LIST, [{ id: "aaaaaaaaaaaa", slot: "personal" }, { id: "cccccccccccc", slot: "explore" }]);
    const feed = render(<Feed ids={["aaaaaaaaaaaa", "cccccccccccc"]} />);
    fireEvent.click(feed.getByText("cccccccccccc"));
    const [open] = ofType("open");
    expect([open.item, open.surface, open.list, open.slot, open.position]).toEqual(["cccccccccccc", "for-you", LIST, "explore", 1]);
    expect(open.view).toMatch(/^view_/);
    feed.unmount();
    const reader = render(<Reader item="cccccccccccc" />);
    expect(ofType("open"), "the list's open is the open: no second one").toHaveLength(1);
    await verified();
    // Ten seconds of reading with a scroll, then the tab is switched away.
    act(() => { vi.advanceTimersByTime(5_000); });
    fireEvent.scroll(document);
    act(() => { vi.advanceTimersByTime(5_000); });
    setVisibility("hidden");
    // The kept-alive request carries the dwell. Its IDs remain queued until an acknowledged retry.
    expect(ofType("dwell")).toHaveLength(1);
    const sent = fetchMock.mock.calls.flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: Array<{ type: string; value?: number; view?: string; surface: string }> }).events);
    const reported = sent.filter((event) => event.type === "dwell");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ surface: "reader", view: open.view, value: 10_000 });
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: "POST", keepalive: true });
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get("X-Open-Science-CSRF")).toBe("csrf-token");
    reader.unmount();
  });

  it("a reading page reached by address opens itself as direct; idle time does not count; the language switch, the body opened and a star are its events", () => {
    const reader = render(<Reader item="dddddddddddd" />);
    const [open] = ofType("open");
    expect([open.surface, open.list]).toEqual(["direct", null]);
    // Five idle minutes in a visible tab: three count (FRONTIER_DWELL.idleMs).
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    reader.rerender(<Reader item="dddddddddddd" language="original" expanded starred />);
    expect(ofType("toggle-translation").map((event) => event.detail)).toEqual(["original"]);
    expect(ofType("expand-body")).toHaveLength(1);
    expect(ofType("star").map((event) => [event.surface, event.view])).toEqual([["reader", open.view]]);
    reader.unmount();
    expect(ofType("dwell").map((event) => event.value)).toEqual([180_000]);
  });

  it("the original and another report followed from the reading page; an action from elsewhere names the reading page open", () => {
    const reader = render(<Reader item="eeeeeeeeeeee" />);
    const view = ofType("open")[0].view;
    fireEvent.click(reader.getByText("阅读原文"));
    fireEvent.click(reader.getByText("another report"));
    expect(ofType("open-original").map((event) => event.view)).toEqual([view]);
    expect(ofType("related-open").map((event) => event.detail)).toEqual(["item"]);
    expect(ofType("open").map((event) => [event.item, event.surface])).toEqual([["eeeeeeeeeeee", "direct"], ["bbbbbbbbbbbb", "reader"]]);
    trackFrontierItemAction("share", "eeeeeeeeeeee", { detail: "markdown" });
    expect(ofType("share").map((event) => [event.surface, event.view, event.detail])).toEqual([["reader", view, "markdown"]]);
    reader.unmount();
    trackFrontierItemAction("research", "eeeeeeeeeeee");
    expect(ofType("research").map((event) => [event.surface, event.view]), "the reading page gone: no view any more").toEqual([["direct", null]]);
  });
});

describe("push: a reading page reached from a notification (G12, 2026-10-25)", () => {
  function ReaderFrom({ item, arrival }: { item: string; arrival?: "push" | null }) {
    useFrontierReadTracking(item, { arrival });
    return <article data-frontier-reader="" aria-label="正文" />;
  }

  it("reads only the closed marker a notification's link carries", () => {
    expect(frontierArrival("?view=daily&day=2026-09-23&from=push")).toBe("push");
    expect(frontierArrival(new URLSearchParams("item=aaaaaaaaaaaa&from=push"))).toBe("push");
    for (const search of ["", "?from=direct", "?from=Push", "?from=push%20", "?src=push", "?from=daily"]) expect(frontierArrival(search), search).toBeNull();
  });

  it("a page no list handed opens as push when its address carries the marker, and as direct otherwise", () => {
    const pushed = render(<ReaderFrom item="aaaaaaaaaaaa" arrival="push" />);
    expect(ofType("open").map((event) => [event.item, event.surface, event.list, event.view?.slice(0, 5)])).toEqual([["aaaaaaaaaaaa", "push", null, "view_"]]);
    pushed.unmount();
    const direct = render(<ReaderFrom item="bbbbbbbbbbbb" arrival={null} />);
    expect(ofType("open").map((event) => [event.item, event.surface])).toEqual([["aaaaaaaaaaaa", "push"], ["bbbbbbbbbbbb", "direct"]]);
    direct.unmount();
  });

  it("a page a list handed keeps the list's open: the marker never adds a second one", () => {
    serveFrontierList("for-you", LIST, [{ id: "cccccccccccc", slot: "personal" }]);
    const feed = render(<Feed ids={["cccccccccccc"]} />);
    fireEvent.click(feed.getByText("cccccccccccc"));
    feed.unmount();
    const reader = render(<ReaderFrom item="cccccccccccc" arrival="push" />);
    expect(ofType("open").map((event) => event.surface)).toEqual(["for-you"]);
    reader.unmount();
  });

  it("a notification's card is the place of the open (surface push, position 0) and counts no impression: nothing on it is scrolled", () => {
    function Linked() {
      const root = useRef<HTMLDivElement>(null);
      useFrontierListTracking(root, []);
      return (
        <div ref={root}>
          <ul data-frontier-list="push"><li data-frontier-item="dddddddddddd"><a href="/app/frontier/items/dddddddddddd">linked</a></li></ul>
        </div>
      );
    }
    const linked = render(<Linked />);
    show(linked.container.querySelector("[data-frontier-item]")!, 1);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(ofType("impression")).toHaveLength(0);
    fireEvent.click(linked.getByText("linked"));
    expect(ofType("open").map((event) => [event.item, event.surface, event.position, event.list])).toEqual([["dddddddddddd", "push", 0, null]]);
    linked.unmount();
  });
});

describe("delivery", () => {
  it("sends a batch a moment after the last event, idempotent ids, and waits out a 429's Retry-After", async () => {
    serveFrontierList("feed", LIST, [{ id: "aaaaaaaaaaaa", slot: "editorial" }]);
    trackFrontierItemAction("star", "aaaaaaaaaaaa");
    expect(fetchMock).not.toHaveBeenCalled();
    await verified();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "30" } }));
    await act(async () => { vi.advanceTimersByTime(4_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { events: Array<{ id: string; list: string; slot: string; surface: string }> };
    expect(first.events[0]).toMatchObject({ surface: "feed", list: LIST, slot: "editorial" });
    expect(pendingFrontierEvents(), "kept for the retry").toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(29_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1_500); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as { events: Array<{ id: string }> };
    expect(second.events[0].id, "the same id: the server keeps it once").toBe(first.events[0].id);
    await act(async () => { await Promise.resolve(); });
    expect(pendingFrontierEvents()).toHaveLength(0);
  });

  it("a closing page sends by beacon, its token in a text/plain body; nothing the validator refuses is queued", async () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    trackFrontierItemAction("hide", "aaaaaaaaaaaa", { surface: "feed", detail: "not-a-reason" });
    expect(pendingFrontierEvents(), "a reason outside the closed list is never sent").toHaveLength(0);
    trackFrontierItemAction("hide", "aaaaaaaaaaaa", { surface: "feed", detail: "promotional" });
    await verified();
    flushFrontierEvents("unload");
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0] as unknown as [string, Blob];
    expect(url).toBe("/api/frontier/events");
    expect(blob.type.toLowerCase()).toBe("text/plain;charset=utf-8");
    vi.useRealTimers();
    // jsdom's Blob has no text(): read it as a browser's FileReader would.
    const text = await new Promise<string>((resolve) => { const file = new FileReader(); file.onload = () => resolve(String(file.result)); file.readAsText(blob); });
    const body = JSON.parse(text) as { csrf: string; events: Array<{ detail: string; device: string; session: string }> };
    expect(body.csrf).toBe("csrf-token");
    expect(body.events[0]).toMatchObject({ detail: "promotional" });
    expect(body.events[0].device).toMatch(/^(narrow|wide)$/);
    expect(body.events[0].session).toMatch(/^ses_/);
    expect(Object.keys(body.events[0]).sort(), "no URL, no text, nothing personal: closed words, ids and numbers").toEqual(["at", "detail", "device", "id", "item", "session", "surface", "type"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingFrontierEvents()).toHaveLength(1);
  });
});

it("drops A tracking and cannot retry or acknowledge it after an external account change", async () => {
  let rejectOld: ((reason?: unknown) => void) | null = null;
  fetchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  trackFrontierItemAction("star", "aaaaaaaaaaaa");
  await verified();
  flushFrontierEvents();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal;
  window.dispatchEvent(new StorageEvent("storage", { key: "open-science:web-session-sync", newValue: '{"kind":"started"}' }));
  expect(signal?.aborted).toBe(true);
  expect(pendingFrontierEvents()).toHaveLength(0);
  expect(sessionStorage.getItem("evimed.frontier.events")).toBeNull();
  trackFrontierItemAction("star", "bbbbbbbbbbbb");
  await act(async () => { (rejectOld as unknown as (reason?: unknown) => void)(new Error("late")); await Promise.resolve(); });
  expect(pendingFrontierEvents()).toHaveLength(1);
  await act(async () => { vi.advanceTimersByTime(4000); await Promise.resolve(); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const sent = String((fetchMock.mock.calls[1][1] as RequestInit).body);
  expect(sent).toContain("bbbbbbbbbbbb");
  expect(sent).not.toContain("aaaaaaaaaaaa");
});

it("does not requeue a previous reader's dwell during unmount after an account change", () => {
  const view = render(<Reader item="aaaaaaaaaaaa" />);
  act(() => { vi.advanceTimersByTime(2000); });
  window.dispatchEvent(new StorageEvent("storage", { key: "open-science:web-session-sync", newValue: '{"kind":"started"}' }));
  view.unmount();
  expect(pendingFrontierEvents()).toHaveLength(0);
  act(() => { vi.advanceTimersByTime(5000); });
  expect(fetchMock).not.toHaveBeenCalled();
});

describe("account-bound storage", () => {
  const key = "evimed.frontier.events";
  const saved = () => JSON.parse(sessionStorage.getItem(key) ?? "null") as {
    tenantId: string; userId: string; events: ReturnType<typeof pendingFrontierEvents>;
  };
  const star = (item: string) => trackFrontier({ type: "star", surface: "feed", item });

  it("persists the first event synchronously when the shell already verified /me", async () => {
    actor.current = { generation: sessionGeneration(), tenantId: "tenant-a", userId: "user-a", csrf: "csrf-token" };
    star("aaaaaaaaaaaa");
    expect(meMock).not.toHaveBeenCalled();
    const [first] = pendingFrontierEvents();
    expect(saved().events).toEqual([first]);

    forgetDocument();
    meMock.mockRejectedValueOnce(new TypeError("offline"));
    flushFrontierEvents();
    await verified();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved().events).toEqual([first]);
    await act(async () => { vi.advanceTimersByTime(4_000); });
    expect(meMock).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain(first.id);
    expect(saved().events).toEqual([]);
  });

  it("adopts a shell snapshot while the queue's own me is slow", async () => {
    let resolveMe!: (me: ReturnType<typeof identity>) => void;
    meMock.mockImplementationOnce(() => new Promise(resolve => { resolveMe = resolve; }));
    star("aaaaaaaaaaaa");
    actor.current = { generation: sessionGeneration(), tenantId: "tenant-a", userId: "user-a", csrf: "csrf-token" };
    star("bbbbbbbbbbbb");
    expect(meMock).toHaveBeenCalledTimes(1);
    expect(saved().events.map(event => event.item)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    resolveMe(identity());
    await verified();
    expect(pendingFrontierEvents()).toHaveLength(2);
  });

  it.each(["beacon", "fetch"])("does not reoffer in-flight IDs at hide via %s", async transport => {
    const beacon = vi.fn(() => transport === "beacon");
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    star("aaaaaaaaaaaa");
    await verified();
    const [first] = pendingFrontierEvents();
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    flushFrontierEvents();
    flushFrontierEvents("unload");
    expect(beacon).not.toHaveBeenCalled();
    star("bbbbbbbbbbbb");
    const second = pendingFrontierEvents()[1];
    flushFrontierEvents("unload");
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(saved().events).toEqual([first, second]);
    if (transport === "fetch") {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1][1]?.body)).toContain(second.id);
      expect(String(fetchMock.mock.calls[1][1]?.body)).not.toContain(first.id);
    } else expect(fetchMock).toHaveBeenCalledTimes(1);

    forgetDocument();
    flushFrontierEvents();
    await verified();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).toContain(first.id);
    expect(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).toContain(second.id);
    expect(saved().events).toEqual([]);
    if (transport === "beacon") {
      vi.useRealTimers();
      const [, body] = beacon.mock.calls[0] as unknown as [string, Blob];
      const text = await new Promise<string>(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(body);
      });
      expect(text).toContain(second.id);
      expect(text).not.toContain(first.id);
    }
  });

  it("restores after a same-account reload, merges new events, and retries the original IDs", async () => {
    star("aaaaaaaaaaaa");
    await verified();
    const [first] = pendingFrontierEvents();
    expect(saved()).toMatchObject({ tenantId: "tenant-a", userId: "user-a", events: [first] });
    expect(sessionStorage.getItem(key)).not.toContain("csrf-token");

    forgetDocument();
    let resolveMe!: (me: ReturnType<typeof identity>) => void;
    meMock.mockImplementationOnce(() => new Promise(resolve => { resolveMe = resolve; }));
    star("bbbbbbbbbbbb");
    const newId = pendingFrontierEvents()[0].id;
    flushFrontierEvents();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved().events.map(event => event.id)).toEqual([first.id]);
    resolveMe(identity());
    await verified();

    expect(pendingFrontierEvents().map(event => [event.id, event.session])).toEqual([[first.id, first.session], [newId, first.session]]);
    await act(async () => { vi.advanceTimersByTime(4_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pendingFrontierEvents()).toHaveLength(0);
    expect(saved().events).toEqual([]);
  });

  it.each([["user-b", "tenant-a"], ["user-a", "tenant-b"]])("does not restore another account or tenant (%s, %s)", async (user, tenant) => {
    star("aaaaaaaaaaaa");
    await verified();
    const [old] = pendingFrontierEvents();
    forgetDocument();
    requestHeaders["X-Open-Science-CSRF"] = "csrf-b";
    meMock.mockResolvedValue(identity(user, tenant, "csrf-b"));
    star("bbbbbbbbbbbb");
    await verified();
    expect(saved().events.map(event => event.item)).toEqual(["bbbbbbbbbbbb"]);
    expect(saved().events[0].session).not.toBe(old.session);
    flushFrontierEvents("unload");
    expect(String(fetchMock.mock.calls[0][1]?.body)).not.toContain("aaaaaaaaaaaa");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("X-Open-Science-CSRF")).toBe("csrf-b");
  });

  it("ignores a stale identity completion after a session boundary", async () => {
    let resolveOld!: (me: ReturnType<typeof identity>) => void;
    meMock.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    star("aaaaaaaaaaaa");
    sessionBoundary();
    requestHeaders["X-Open-Science-CSRF"] = "csrf-b";
    meMock.mockResolvedValue(identity("user-b", "tenant-b", "csrf-b"));
    star("bbbbbbbbbbbb");
    resolveOld(identity());
    await verified();
    flushFrontierEvents();
    expect(saved()).toMatchObject({ tenantId: "tenant-b", userId: "user-b" });
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain("bbbbbbbbbbbb");
    expect(String(fetchMock.mock.calls[0][1]?.body)).not.toContain("aaaaaaaaaaaa");
  });

  it("does not adopt provisional events when /me verified a different credential before the boundary arrived", async () => {
    meMock.mockResolvedValue(identity("user-b", "tenant-b", "csrf-b"));
    star("aaaaaaaaaaaa");
    await verified();
    requestHeaders["X-Open-Science-CSRF"] = "csrf-b";
    star("cccccccccccc");
    flushFrontierEvents();
    flushFrontierEvents("unload");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved()).toBeNull();
    sessionBoundary();
    star("bbbbbbbbbbbb");
    await verified();
    flushFrontierEvents();
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain("bbbbbbbbbbbb");
    expect(String(fetchMock.mock.calls[0][1]?.body)).not.toMatch(/aaaaaaaaaaaa|cccccccccccc/u);
  });

  it("rejects the legacy ownerless format", async () => {
    star("aaaaaaaaaaaa");
    const [old] = pendingFrontierEvents();
    await verified();
    forgetDocument();
    sessionStorage.setItem(key, JSON.stringify([old]));
    sessionStorage.setItem("evimed.frontier.session", JSON.stringify({ id: old.session, at: Date.now() }));
    sessionStorage.setItem("evimed.frontier.open", JSON.stringify({ item: "bbbbbbbbbbbb", view: "view_legacy", at: Date.now() }));
    const reader = render(<Reader item="bbbbbbbbbbbb" />);
    await verified();
    expect(saved().events).toHaveLength(1);
    expect(saved().events[0]).toMatchObject({ item: "bbbbbbbbbbbb", type: "open", surface: "direct" });
    expect(saved().events[0].session).not.toBe(old.session);
    expect(saved().events[0].view).not.toBe("view_legacy");
    reader.unmount();
  });

  it("joins a saved open and reader only after the same owner is verified", async () => {
    const feed = render(<Feed ids={["cccccccccccc"]} />);
    await verified();
    fireEvent.click(feed.getByText("cccccccccccc"));
    const [original] = ofType("open");
    feed.unmount();
    forgetDocument();
    const reader = render(<Reader item="cccccccccccc" />);
    expect(ofType("open")[0].view).not.toBe(original.view);
    await verified();
    trackFrontierItemAction("star", "cccccccccccc");
    expect(ofType("open").map(event => event.id)).toEqual([original.id]);
    expect(ofType("star")[0].view).toBe(original.view);
    reader.unmount();
  });

  it("does not reuse the saved open after switching identities", async () => {
    const feed = render(<Feed ids={["cccccccccccc"]} />);
    await verified();
    fireEvent.click(feed.getByText("cccccccccccc"));
    const [original] = ofType("open");
    feed.unmount();
    forgetDocument();
    requestHeaders["X-Open-Science-CSRF"] = "csrf-b";
    meMock.mockResolvedValue(identity("user-b", "tenant-b", "csrf-b"));
    const reader = render(<Reader item="cccccccccccc" />);
    await verified();
    expect(ofType("open")).toHaveLength(1);
    expect(ofType("open")[0].view).not.toBe(original.view);
    reader.unmount();
  });

  it("pins the verified CSRF token even if shared headers change before the boundary", async () => {
    star("aaaaaaaaaaaa");
    await verified();
    requestHeaders["X-Open-Science-CSRF"] = "csrf-b";
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    flushFrontierEvents();
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("X-Open-Science-CSRF")).toBe("csrf-token");
    await verified();
    expect(saved().events).toEqual([]);
  });

  it("keeps unacknowledged unload events in storage for the same id to be retried", async () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    star("aaaaaaaaaaaa");
    await verified();
    const [first] = pendingFrontierEvents();
    flushFrontierEvents("unload");
    flushFrontierEvents("unload");
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(saved().events).toEqual([first]);
    forgetDocument();
    flushFrontierEvents();
    await verified();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain(first.id);
    expect(saved().events).toEqual([]);
  });

  it("retains Retry-After across reload and does not let unload bypass it", async () => {
    star("aaaaaaaaaaaa");
    await verified();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "30" } }));
    flushFrontierEvents();
    await verified();
    forgetDocument();
    flushFrontierEvents();
    await verified();
    flushFrontierEvents("unload");
    await act(async () => { vi.advanceTimersByTime(29_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pendingFrontierEvents()).toHaveLength(0);
  });

  it("retries identity and sends from memory when storage is unavailable", async () => {
    meMock.mockRejectedValueOnce(new TypeError("offline"));
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
    try {
      star("aaaaaaaaaaaa");
      await verified();
      flushFrontierEvents("unload");
      expect(fetchMock).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(4_000); });
      expect(meMock).toHaveBeenCalledTimes(2);
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(pendingFrontierEvents()).toHaveLength(0);
    } finally {
      set.mockRestore();
    }
  });
});
