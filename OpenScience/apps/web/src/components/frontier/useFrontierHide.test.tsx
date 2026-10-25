import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { useToastStore } from "@/lib/toast";
import { frontierItem } from "./__fixtures__/frontierItems";
import { FRONTIER_HIDE_STRIP, useFrontierHide } from "./useFrontierHide";

const client = vi.hoisted(() => ({
  hideFrontierItem: vi.fn(), unhideFrontierItem: vi.fn(), listFrontierFollows: vi.fn(), addFrontierFollow: vi.fn(), removeFrontierFollow: vi.fn(),
}));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), ...client }));
const tracking = vi.hoisted(() => ({ trackFrontierItemAction: vi.fn(), flushFrontierEvents: vi.fn() }));
vi.mock("@/lib/frontierTracking", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierTracking")>()), ...tracking }));

const item = frontierItem({ id: "item-1", source: { id: "nejm", name: "NEJM" } });
const hiddenState = { starred: false, hidden: true, read: false };

function mount() {
  const onClosed = vi.fn();
  const view = renderHook(() => useFrontierHide({ surface: "feed", onClosed }));
  return { ...view, onClosed };
}
/** Let the promises of a hide settle: the calls are a queue of awaits. */
const settle = () => act(async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
  Object.values(client).forEach((mock) => mock.mockReset());
  Object.values(tracking).forEach((mock) => mock.mockReset());
  useToastStore.setState({ toasts: [] });
  client.hideFrontierItem.mockResolvedValue(hiddenState);
  client.unhideFrontierItem.mockResolvedValue({ ...hiddenState, hidden: false });
  client.listFrontierFollows.mockResolvedValue([]);
  client.removeFrontierFollow.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe("the line a hidden card leaves", () => {
  it("sends the hide at once with no reason, and closes by itself after the wait: the item leaves, one event, no reason", async () => {
    const { result, onClosed } = mount();
    expect(result.current.strip(item.id)).toBeNull();
    act(() => result.current.start(item));
    await settle();
    expect(client.hideFrontierItem).toHaveBeenCalledTimes(1);
    expect(client.hideFrontierItem).toHaveBeenCalledWith("item-1");
    expect(result.current.strip(item.id)).toMatchObject({ noted: false });
    expect(tracking.trackFrontierItemAction).not.toHaveBeenCalled(); // the event waits for the line to close, to carry the reason
    act(() => { vi.advanceTimersByTime(FRONTIER_HIDE_STRIP.waitMs - 1); });
    expect(onClosed).not.toHaveBeenCalled();
    expect(result.current.strip(item.id)).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onClosed).toHaveBeenCalledWith(item);
    expect(result.current.strip(item.id)).toBeNull();
    expect(tracking.trackFrontierItemAction).toHaveBeenCalledTimes(1);
    expect(tracking.trackFrontierItemAction).toHaveBeenCalledWith("hide", "item-1", { surface: "feed" });
    expect(FRONTIER_HIDE_STRIP).toEqual({ waitMs: 8_000, notedMs: 1_500 });
  });

  it("is asked once for an item: a second press while its line stands does nothing", async () => {
    const { result } = mount();
    act(() => result.current.start(item));
    act(() => result.current.start(item));
    await settle();
    expect(client.hideFrontierItem).toHaveBeenCalledTimes(1);
  });

  it("sends the reason after the hide, says it is noted, closes soon after, and the event carries the reason", async () => {
    const { result, onClosed } = mount();
    act(() => result.current.start(item));
    act(() => result.current.strip(item.id)!.onReason("not-my-specialty"));
    expect(result.current.strip(item.id)).toMatchObject({ noted: true });
    await settle();
    expect(client.hideFrontierItem.mock.calls).toEqual([["item-1"], ["item-1", "not-my-specialty"]]);
    expect(client.addFrontierFollow).not.toHaveBeenCalled();
    // A second choice is not taken: the reason is the first.
    act(() => result.current.strip(item.id)!.onReason("promotional"));
    await settle();
    expect(client.hideFrontierItem).toHaveBeenCalledTimes(2);
    act(() => { vi.advanceTimersByTime(FRONTIER_HIDE_STRIP.notedMs); });
    expect(onClosed).toHaveBeenCalledWith(item);
    expect(tracking.trackFrontierItemAction).toHaveBeenCalledWith("hide", "item-1", { surface: "feed", detail: "not-my-specialty" });
    expect(tracking.trackFrontierItemAction).toHaveBeenCalledTimes(1);
  });

  it("closes when the line says it was scrolled out of sight, and the hide stands", async () => {
    const { result, onClosed } = mount();
    act(() => result.current.start(item));
    await settle();
    act(() => result.current.strip(item.id)!.onClose());
    expect(onClosed).toHaveBeenCalledWith(item);
    act(() => { vi.advanceTimersByTime(FRONTIER_HIDE_STRIP.waitMs * 2); });
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(tracking.trackFrontierItemAction).toHaveBeenCalledTimes(1);
    expect(client.unhideFrontierItem).not.toHaveBeenCalled();
  });

  it("takes the hide back on 撤销: the card stays in its list, the item is unhidden, and no hide was ever reported", async () => {
    const { result, onClosed } = mount();
    act(() => result.current.start(item));
    await settle();
    act(() => result.current.strip(item.id)!.onUndo());
    expect(result.current.strip(item.id)).toBeNull();
    await settle();
    expect(client.unhideFrontierItem).toHaveBeenCalledWith("item-1");
    act(() => { vi.advanceTimersByTime(FRONTIER_HIDE_STRIP.waitMs * 2); });
    expect(onClosed).not.toHaveBeenCalled();
    expect(tracking.trackFrontierItemAction).not.toHaveBeenCalled();
  });

  it("does not send a reason that was chosen and taken back before its turn came, and still unhides", async () => {
    const { result } = mount();
    act(() => result.current.start(item));
    act(() => result.current.strip(item.id)!.onReason("low-quality"));
    act(() => result.current.strip(item.id)!.onUndo());
    await settle();
    expect(client.hideFrontierItem.mock.calls).toEqual([["item-1"]]);
    expect(client.unhideFrontierItem).toHaveBeenCalledWith("item-1");
  });

  it("mutes the source for its own reason, and 撤销 removes the mute it made", async () => {
    client.addFrontierFollow.mockResolvedValue({ id: "9", kind: "source", key: "nejm", label: "NEJM", muted: true });
    const { result } = mount();
    act(() => result.current.start(item));
    act(() => result.current.strip(item.id)!.onReason("source"));
    await settle();
    expect(client.hideFrontierItem.mock.calls).toEqual([["item-1"], ["item-1", "source"]]);
    expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "source", key: "nejm", label: "NEJM", muted: true });
    act(() => result.current.strip(item.id)!.onUndo());
    await settle();
    expect(client.unhideFrontierItem).toHaveBeenCalledWith("item-1");
    expect(client.removeFrontierFollow).toHaveBeenCalledWith("9");
  });

  it("leaves a mute the reader already had alone, and gives a follow back as a follow", async () => {
    client.listFrontierFollows.mockResolvedValue([{ id: "3", kind: "source", key: "nejm", label: "NEJM", muted: true }]);
    const first = mount();
    act(() => first.result.current.start(item));
    act(() => first.result.current.strip(item.id)!.onReason("source"));
    await settle();
    act(() => first.result.current.strip(item.id)!.onUndo());
    await settle();
    expect(client.addFrontierFollow).not.toHaveBeenCalled();
    expect(client.removeFrontierFollow).not.toHaveBeenCalled();
    first.unmount();

    client.listFrontierFollows.mockResolvedValue([{ id: "4", kind: "source", key: "nejm", label: "NEJM", muted: false }]);
    client.addFrontierFollow.mockResolvedValue({ id: "4", kind: "source", key: "nejm", label: "NEJM", muted: true });
    const second = mount();
    act(() => second.result.current.start(item));
    act(() => second.result.current.strip(item.id)!.onReason("source"));
    await settle();
    expect(client.addFrontierFollow).toHaveBeenLastCalledWith({ kind: "source", key: "nejm", label: "NEJM", muted: true });
    act(() => second.result.current.strip(item.id)!.onUndo());
    await settle();
    expect(client.addFrontierFollow).toHaveBeenLastCalledWith({ kind: "source", key: "nejm", label: "NEJM", muted: false });
    expect(client.removeFrontierFollow).not.toHaveBeenCalled();
  });

  it("mutes nothing when the follows cannot be read, and says so; the hide and its reason stand", async () => {
    client.listFrontierFollows.mockRejectedValue(new WebApiError("down", { status: 503, code: null }));
    const { result, onClosed } = mount();
    act(() => result.current.start(item));
    act(() => result.current.strip(item.id)!.onReason("source"));
    await settle();
    expect(client.addFrontierFollow).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.map((toast) => toast.tone)).toEqual(["error"]);
    act(() => { vi.advanceTimersByTime(FRONTIER_HIDE_STRIP.notedMs); });
    expect(onClosed).toHaveBeenCalledWith(item);
    expect(tracking.trackFrontierItemAction).toHaveBeenCalledWith("hide", "item-1", { surface: "feed", detail: "source" });
  });

  it("brings the card back with the error when the hide is refused, and sends nothing more for it", async () => {
    client.hideFrontierItem.mockRejectedValue(new WebApiError("down", { status: 503, code: null }));
    const { result, onClosed } = mount();
    act(() => result.current.start(item));
    await settle();
    expect(result.current.strip(item.id)).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(FRONTIER_HIDE_STRIP.waitMs * 2); });
    expect(onClosed).not.toHaveBeenCalled();
    expect(client.unhideFrontierItem).not.toHaveBeenCalled();
    expect(tracking.trackFrontierItemAction).not.toHaveBeenCalled();
  });

  it("tells a reason that could not be sent, and the hide stands without it", async () => {
    client.hideFrontierItem.mockResolvedValueOnce(hiddenState).mockRejectedValueOnce(new WebApiError("down", { status: 503, code: null }));
    const { result, onClosed } = mount();
    act(() => result.current.start(item));
    act(() => result.current.strip(item.id)!.onReason("already-seen"));
    await settle();
    expect(useToastStore.getState().toasts.map((toast) => toast.tone)).toEqual(["error"]);
    act(() => { vi.advanceTimersByTime(FRONTIER_HIDE_STRIP.notedMs); });
    expect(onClosed).toHaveBeenCalledWith(item);
    expect(client.unhideFrontierItem).not.toHaveBeenCalled();
  });

  it("settles the lines still open when the page is hidden: the event, with no reason, and a flush; and not twice when they close", async () => {
    const { result } = mount();
    act(() => result.current.start(item));
    await settle();
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(tracking.trackFrontierItemAction).toHaveBeenCalledWith("hide", "item-1", { surface: "feed" });
    expect(tracking.flushFrontierEvents).toHaveBeenCalledWith("unload");
    act(() => { vi.advanceTimersByTime(FRONTIER_HIDE_STRIP.waitMs); });
    expect(tracking.trackFrontierItemAction).toHaveBeenCalledTimes(1);
  });

  it("reports the hide of a line left open when the page is left", async () => {
    const { result, unmount } = mount();
    act(() => result.current.start(item));
    await settle();
    unmount();
    expect(tracking.trackFrontierItemAction).toHaveBeenCalledWith("hide", "item-1", { surface: "feed" });
  });
});
