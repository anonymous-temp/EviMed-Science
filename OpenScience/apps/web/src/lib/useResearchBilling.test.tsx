import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT, WebApiError, webErrorMessage } from "@/lib/apiClient";
import { forgetResearchBilling, useResearchBilling } from "./useResearchBilling";

const mocks = vi.hoisted(() => ({ allowance: vi.fn() }));
// The error dictionary is the real one: a failed read is worded by it.
vi.mock("@/lib/apiClient", async (original) => ({
  ...(await original<typeof import("@/lib/apiClient")>()),
  fetchWebResearchAllowance: mocks.allowance,
}));

/** `/api/account/allowance` as the server writes it, billing off and on. */
const off = {
  enabled: false, currency: "CNY", status: "disabled", available: null, held: null, balances: null, membership: null,
  month: { since: "2026-10-01T00:00:00.000Z", paid: 0, pending: 0 },
  commerce: { rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null },
};
const on = { ...off, enabled: true, status: "ready", available: 20 };
const refused = new WebApiError("HTTP 503", { status: 503, code: "runtime_unavailable" });

/** A read the test answers when it chooses to. */
function pending() {
  let resolve!: (value: object) => void;
  const promise = new Promise<object>((res) => { resolve = res; });
  return { promise, resolve };
}
const settle = () => act(async () => {});

beforeEach(() => {
  mocks.allowance.mockReset();
  forgetResearchBilling();
});

describe("useResearchBilling", () => {
  it("reads as off until the deployment says billing is on", async () => {
    const read = pending();
    mocks.allowance.mockReturnValue(read.promise);
    const { result } = renderHook(() => useResearchBilling());
    expect(result.current.enabled).toBe(false);
    expect(result.current.allowance).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => { read.resolve(on); });
    expect(result.current.enabled).toBe(true);
    expect(result.current.allowance).toEqual(on);
    expect(result.current.loading).toBe(false);
  });

  it("stays off when the deployment says it does not bill research", async () => {
    mocks.allowance.mockResolvedValue(off);
    const { result } = renderHook(() => useResearchBilling());
    await settle();
    expect(result.current.enabled).toBe(false);
    expect(result.current.allowance).toEqual(off);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("answers every surface that asks while the read is on its way with that one read", async () => {
    const read = pending();
    mocks.allowance.mockReturnValue(read.promise);
    const label = renderHook(() => useResearchBilling());
    const section = renderHook(() => useResearchBilling({ fresh: true }));
    const button = renderHook(() => useResearchBilling());
    expect(mocks.allowance).toHaveBeenCalledTimes(1);
    await act(async () => { read.resolve(on); });
    for (const surface of [label, section, button]) expect(surface.result.current.enabled).toBe(true);
    expect(mocks.allowance).toHaveBeenCalledTimes(1);
  });

  it("keeps the answer for a surface that opens later, which asks nothing", async () => {
    mocks.allowance.mockResolvedValue(on);
    renderHook(() => useResearchBilling());
    await settle();
    const later = renderHook(() => useResearchBilling());
    // The answer is there on its first render, so a label never flashes the other name.
    expect(later.result.current.enabled).toBe(true);
    expect(later.result.current.loading).toBe(false);
    await settle();
    expect(mocks.allowance).toHaveBeenCalledTimes(1);
  });

  it("is asked again by a surface that shows the numbers, which is loading, and holds the answer for its wording, meanwhile", async () => {
    mocks.allowance.mockResolvedValueOnce(on);
    const label = renderHook(() => useResearchBilling());
    await settle();
    const read = pending();
    mocks.allowance.mockReturnValueOnce(read.promise);
    const section = renderHook(() => useResearchBilling({ fresh: true }));
    expect(mocks.allowance).toHaveBeenCalledTimes(2);
    // From its first render, so the held numbers are not drawn for a frame before the read that replaces them.
    expect(section.result.current.loading).toBe(true);
    expect(section.result.current.enabled).toBe(true);
    expect(section.result.current.allowance?.available).toBe(20);
    expect(label.result.current.enabled).toBe(true);
    await act(async () => { read.resolve({ ...on, available: 35 }); });
    expect(section.result.current.loading).toBe(false);
    expect(section.result.current.allowance?.available).toBe(35);
    expect(label.result.current.allowance?.available).toBe(35);
  });

  it("is loading from its very first render when it is about to ask, so held numbers are never drawn for a frame first", async () => {
    mocks.allowance.mockResolvedValueOnce(on);
    renderHook(() => useResearchBilling());
    await settle();
    mocks.allowance.mockReturnValueOnce(pending().promise);
    const seen: boolean[] = [];
    renderHook(() => {
      const billing = useResearchBilling({ fresh: true });
      seen.push(billing.loading);
      return billing;
    });
    // Every frame this surface drew, and the first is already waiting.
    expect(seen[0]).toBe(true);
    expect(seen).not.toContain(false);
  });

  it("never asks again once the deployment has said it does not bill, whoever opens", async () => {
    mocks.allowance.mockResolvedValue(off);
    renderHook(() => useResearchBilling());
    await settle();
    const section = renderHook(() => useResearchBilling({ fresh: true }));
    await settle();
    expect(mocks.allowance).toHaveBeenCalledTimes(1);
    expect(section.result.current.enabled).toBe(false);
    expect(section.result.current.loading).toBe(false);
    expect(section.result.current.error).toBeNull();
  });

  it("reports a failed read to the surface that waited, reads as off, and keeps nothing", async () => {
    mocks.allowance.mockRejectedValueOnce(refused);
    const section = renderHook(() => useResearchBilling({ fresh: true }));
    await settle();
    expect(section.result.current.error).toBe(webErrorMessage(refused));
    expect(section.result.current.loading).toBe(false);
    expect(section.result.current.enabled).toBe(false);
    expect(section.result.current.allowance).toBeNull();
    // A failure is not an answer: the next surface to open asks again.
    mocks.allowance.mockResolvedValueOnce(on);
    const next = renderHook(() => useResearchBilling());
    await settle();
    expect(mocks.allowance).toHaveBeenCalledTimes(2);
    expect(next.result.current.enabled).toBe(true);
    expect(next.result.current.error).toBeNull();
  });

  it("retries on demand, and every surface follows the answer that comes", async () => {
    mocks.allowance.mockRejectedValueOnce(refused);
    const label = renderHook(() => useResearchBilling());
    const section = renderHook(() => useResearchBilling({ fresh: true }));
    await settle();
    expect(section.result.current.error).not.toBeNull();
    const retry = pending();
    mocks.allowance.mockReturnValueOnce(retry.promise);
    act(() => { section.result.current.reload(); });
    // The error is cleared and the surface is waiting again while the retry is on its way.
    expect(section.result.current.error).toBeNull();
    expect(section.result.current.loading).toBe(true);
    await act(async () => { retry.resolve(on); });
    expect(section.result.current.error).toBeNull();
    expect(section.result.current.loading).toBe(false);
    expect(section.result.current.enabled).toBe(true);
    expect(label.result.current.enabled).toBe(true);
    expect(mocks.allowance).toHaveBeenCalledTimes(2);
  });

  it("keeps the answer it holds when a later read fails, so a label does not change its name", async () => {
    mocks.allowance.mockResolvedValueOnce(on);
    const label = renderHook(() => useResearchBilling());
    await settle();
    mocks.allowance.mockRejectedValueOnce(refused);
    const section = renderHook(() => useResearchBilling({ fresh: true }));
    await settle();
    expect(section.result.current.error).toBe(webErrorMessage(refused));
    expect(section.result.current.enabled).toBe(true);
    expect(label.result.current.enabled).toBe(true);
  });

  it.each([["ends", WEB_SESSION_ENDED_EVENT], ["starts", WEB_SESSION_STARTED_EVENT]])("forgets the answer when a session %s: it was about another account", async (_, event) => {
    mocks.allowance.mockResolvedValueOnce(on);
    const surface = renderHook(() => useResearchBilling());
    await settle();
    expect(surface.result.current.enabled).toBe(true);
    await act(async () => { window.dispatchEvent(new Event(event)); });
    expect(surface.result.current.allowance).toBeNull();
    expect(surface.result.current.enabled).toBe(false);
    surface.unmount();
    // The next account's surface asks for itself.
    mocks.allowance.mockResolvedValueOnce(off);
    const next = renderHook(() => useResearchBilling());
    await settle();
    expect(mocks.allowance).toHaveBeenCalledTimes(2);
    expect(next.result.current.enabled).toBe(false);
    expect(next.result.current.allowance).toEqual(off);
  });

  it("drops a read that was still on its way when the account changed", async () => {
    const read = pending();
    mocks.allowance.mockReturnValueOnce(read.promise);
    const surface = renderHook(() => useResearchBilling());
    await act(async () => { window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT)); });
    await act(async () => { read.resolve(on); });
    expect(surface.result.current.allowance).toBeNull();
    expect(surface.result.current.enabled).toBe(false);
  });
});
