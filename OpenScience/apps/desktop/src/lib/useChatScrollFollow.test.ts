import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ThreadBlock } from "@ai4s/shared";
import { FOLLOW_BOTTOM_PX, useChatScrollFollow } from "./useChatScrollFollow";

/** A scroll container with fake layout metrics (jsdom reports all zeros). */
function fakeScroller({ scrollHeight = 1000, clientHeight = 400, scrollTop = 0 } = {}) {
  const el = document.createElement("div");
  let top = scrollTop;
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = v;
    },
    configurable: true,
  });
  return {
    el,
    get top() {
      return top;
    },
  };
}

const scrollEvent = (el: HTMLElement) =>
  ({ currentTarget: el }) as React.UIEvent<HTMLElement>;

const user = (text: string): ThreadBlock => ({ kind: "user", text });
const agent = (markdown: string): ThreadBlock => ({ kind: "agent", markdown });
const tool = (title: string): ThreadBlock => ({ kind: "tool-call", title, status: "running" });

function renderFollow(
  scroller: ReturnType<typeof fakeScroller>,
  initial: { restoreKey?: string; ready?: boolean; blocks?: ThreadBlock[]; working?: boolean } = {},
) {
  const ref = { current: scroller.el };
  return renderHook(
    ({ restoreKey, ready, blocks, working }) =>
      useChatScrollFollow(ref, { restoreKey, ready, blocks, working }),
    {
      initialProps: {
        restoreKey: initial.restoreKey ?? "chat:s1",
        ready: initial.ready ?? true,
        blocks: initial.blocks ?? ([] as ThreadBlock[]),
        working: initial.working ?? false,
      },
    },
  );
}

describe("useChatScrollFollow", () => {
  it("pins the tail to the bottom while the user is near it", () => {
    const scroller = fakeScroller({ scrollTop: 600 }); // exactly at the bottom
    const { result, rerender } = renderFollow(scroller, { blocks: [user("hi")] });

    // The first commit belongs to scrollMemory's restore — no auto scroll yet.
    expect(scroller.top).toBe(600);

    rerender({ restoreKey: "chat:s1", ready: true, blocks: [user("hi"), agent("hello")], working: false });
    expect(scroller.top).toBe(1000); // scrollHeight — pinned to the tail
    expect(result.current.following).toBe(true);
    expect(result.current.newCount).toBe(0);

    // The working indicator appearing also re-pins (content grew meanwhile).
    scroller.el.scrollTop = 700;
    Object.defineProperty(scroller.el, "scrollHeight", { value: 1200, configurable: true });
    rerender({ restoreKey: "chat:s1", ready: true, blocks: [user("hi"), agent("hello")], working: true });
    expect(scroller.top).toBe(1200);
  });

  it("does not scroll an empty draft landing page when only its metadata changes", () => {
    const scroller = fakeScroller({ scrollTop: 0 });
    const { rerender } = renderFollow(scroller, { blocks: undefined });

    // Specialty-agent metadata can resolve after the first render while the
    // conversation is still empty. That is not a new chat tail and must not
    // hide the specialty header/onboarding by jumping to the bottom.
    rerender({ restoreKey: "chat:s1", ready: true, blocks: [], working: false });

    expect(scroller.top).toBe(0);
  });

  it("pauses the follow when the user scrolls up and counts new conversation messages", () => {
    const scroller = fakeScroller({ scrollTop: 600 });
    const base = [user("hi"), agent("hello")];
    const { result, rerender } = renderFollow(scroller, { blocks: base });

    // User scrolls up mid-thread: 1000 - 100 - 400 > threshold.
    scroller.el.scrollTop = 100;
    act(() => result.current.handleScroll(scrollEvent(scroller.el)));
    expect(result.current.following).toBe(false);

    const grown = [...base, tool("search"), agent("one"), tool("read"), agent("two")];
    rerender({ restoreKey: "chat:s1", ready: true, blocks: grown, working: false });
    expect(scroller.top).toBe(100); // never yanked down
    // Only user/agent messages count — tool steps are not "new messages".
    expect(result.current.newCount).toBe(2);

    act(() => result.current.backToBottom());
    expect(scroller.top).toBe(1000);
    expect(result.current.following).toBe(true);
    expect(result.current.newCount).toBe(0);
  });

  it("stands down on the restore commit so a remembered mid-thread position survives", () => {
    const scroller = fakeScroller({ scrollTop: 0 });
    const { result, rerender } = renderFollow(scroller, { ready: false, blocks: undefined });

    // History arrives (ready flips) and scrollMemory restores a mid position.
    scroller.el.scrollTop = 100;
    const history = [user("q"), agent("a1"), agent("a2")];
    rerender({ restoreKey: "chat:s1", ready: true, blocks: history, working: false });
    expect(scroller.top).toBe(100); // the restore owns this commit

    // The restore's scroll event marks the position as "not at bottom"…
    act(() => result.current.handleScroll(scrollEvent(scroller.el)));
    expect(result.current.following).toBe(false);
    // …and later streaming counts new messages instead of yanking down.
    rerender({ restoreKey: "chat:s1", ready: true, blocks: [...history, agent("a3")], working: false });
    expect(scroller.top).toBe(100);
    expect(result.current.newCount).toBe(1);
  });

  it("treats a position within FOLLOW_BOTTOM_PX of the tail as still following", () => {
    const scroller = fakeScroller({ scrollTop: 600 });
    const { result } = renderFollow(scroller, { blocks: [user("hi")] });
    scroller.el.scrollTop = 1000 - 400 - (FOLLOW_BOTTOM_PX - 1); // 1px inside the threshold
    act(() => result.current.handleScroll(scrollEvent(scroller.el)));
    expect(result.current.following).toBe(true);
    scroller.el.scrollTop = 1000 - 400 - (FOLLOW_BOTTOM_PX + 1); // 1px outside
    act(() => result.current.handleScroll(scrollEvent(scroller.el)));
    expect(result.current.following).toBe(false);
  });

  it("resets follow state for a different conversation", () => {
    const scroller = fakeScroller({ scrollTop: 100 });
    const { result, rerender } = renderFollow(scroller, { blocks: [user("hi")] });
    act(() => result.current.handleScroll(scrollEvent(scroller.el)));
    expect(result.current.following).toBe(false);

    rerender({ restoreKey: "chat:s2", ready: true, blocks: [user("other")], working: false });
    expect(result.current.following).toBe(true);
    expect(result.current.newCount).toBe(0);
    // The restore commit of the new conversation is not auto-scrolled either.
    expect(scroller.top).toBe(100);
  });
});
