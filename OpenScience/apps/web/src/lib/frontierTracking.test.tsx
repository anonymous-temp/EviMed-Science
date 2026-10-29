import { act, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushFrontierEvents,
  frontierArrival,
  pendingFrontierEvents,
  resetFrontierTracking,
  serveFrontierList,
  trackFrontierItemAction,
  useFrontierListTracking,
  useFrontierReadTracking,
} from "./frontierTracking";

vi.mock("./apiClient", async (original) => ({
  ...await original<typeof import("./apiClient")>(),
  webApiBase: "",
  getWebApiRequestHeaders: () => ({ "X-Open-Science-Project": "default", "X-Open-Science-CSRF": "csrf-token" }),
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
      <a href="https://www.nejm.org/doi/full/10.1056/x" target="_blank" rel="noreferrer">打开原文</a>
      <a href="/app/frontier/items/bbbbbbbbbbbb">another report</a>
    </article>
  );
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const ofType = (type: string) => pendingFrontierEvents().filter((event) => event.type === type);

beforeEach(() => {
  vi.useFakeTimers();
  resetFrontierTracking();
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
  it("an open carries list, slot and position, and the reading page carries its view on: dwell on hide, read to the end", () => {
    serveFrontierList("for-you", LIST, [{ id: "aaaaaaaaaaaa", slot: "personal" }, { id: "cccccccccccc", slot: "explore" }]);
    const feed = render(<Feed ids={["aaaaaaaaaaaa", "cccccccccccc"]} />);
    fireEvent.click(feed.getByText("cccccccccccc"));
    const [open] = ofType("open");
    expect([open.item, open.surface, open.list, open.slot, open.position]).toEqual(["cccccccccccc", "for-you", LIST, "explore", 1]);
    expect(open.view).toMatch(/^view_/);
    feed.unmount();
    const reader = render(<Reader item="cccccccccccc" />);
    expect(ofType("open"), "the list's open is the open: no second one").toHaveLength(1);
    // Ten seconds of reading with a scroll, then the tab is switched away.
    act(() => { vi.advanceTimersByTime(5_000); });
    fireEvent.scroll(document);
    act(() => { vi.advanceTimersByTime(5_000); });
    setVisibility("hidden");
    // The hide reported the dwell and flushed the queue at once: what was sent is what counts.
    expect(pendingFrontierEvents()).toHaveLength(0);
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
    fireEvent.click(reader.getByText("打开原文"));
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
    expect(pendingFrontierEvents()).toHaveLength(0);
  });
});
