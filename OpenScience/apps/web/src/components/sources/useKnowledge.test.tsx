import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeStatus } from "@/lib/sourceClient";
import statusCompiled from "./knowledgeFixtures/status-compiled.json";
import { roundKey, useKnowledgeStatus, useKnowledgeTree } from "./useKnowledge";

const mocks = vi.hoisted(() => ({ status: vi.fn(), tree: vi.fn() }));
vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()), getKnowledgeStatus: mocks.status, getKnowledgeTree: mocks.tree }));

const compiled = statusCompiled as unknown as KnowledgeStatus;
const compiling = { ...compiled, state: "compiling", stage: { tree: "wiki", step: "wiki", task: null, status: "running", startedAt: "2026-10-13T12:00:00Z" } } as KnowledgeStatus;

describe("useKnowledgeStatus", () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.status.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it("asks again every few seconds while a round is under way, and stops when it has ended", async () => {
    // Each answer is a new object, as a read over the wire is.
    mocks.status.mockResolvedValueOnce({ ...compiling }).mockResolvedValueOnce({ ...compiling }).mockImplementation(async () => ({ ...compiled }));
    const { result } = renderHook(() => useKnowledgeStatus("p1", true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.status?.state).toBe("compiling");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mocks.status).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(result.current.status?.state).toBe("compiled");
    const calls = mocks.status.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.status).toHaveBeenCalledTimes(calls);
  });

  it("asks nothing where the deployment does not compile, and leaves the status as it was when a read fails", async () => {
    renderHook(() => useKnowledgeStatus("p1", false));
    expect(mocks.status).not.toHaveBeenCalled();
    mocks.status.mockResolvedValueOnce(compiled).mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useKnowledgeStatus("p1", true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.status?.state).toBe("compiled");
    act(() => result.current.refresh());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.status?.state).toBe("compiled");
  });

  it("waits for a slow status request before scheduling another poll", async () => {
    let finish: (value: KnowledgeStatus) => void = () => {};
    mocks.status.mockResolvedValueOnce(compiling).mockImplementationOnce(() => new Promise<KnowledgeStatus>((resolve) => { finish = resolve; })).mockResolvedValue(compiling);
    const { result, unmount } = renderHook(() => useKnowledgeStatus("p1", true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mocks.status).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(mocks.status).toHaveBeenCalledTimes(2);
    await act(async () => { finish(compiled); });
    expect(result.current.status?.state).toBe("compiled");
    unmount();
  });

  it("names what a round left, so the tree is read again when it changes", () => {
    expect(roundKey(null)).toBe("");
    expect(roundKey(compiled)).not.toBe(roundKey({ ...compiled, round: compiled.round + 1 }));
  });
});

describe("knowledge scope isolation", () => {
  it("clears the previous project tree while the new project is loading or fails", async () => {
    mocks.tree.mockResolvedValueOnce({ pages: [{ title: "A" }] }).mockRejectedValueOnce(new Error("B unavailable"));
    const { result, rerender } = renderHook(({ id }) => useKnowledgeTree(id, true, ""), { initialProps: { id: "A" } });
    await act(async () => {});
    expect(result.current.tree).not.toBeNull();
    rerender({ id: "B" });
    expect(result.current.tree).toBeNull();
    await act(async () => {});
    expect(result.current.tree).toBeNull();
    expect(result.current.failed).toBe(true);
  });
  it("continues polling after one busy-status request fails", async () => {
    vi.useFakeTimers();
    mocks.status.mockReset().mockResolvedValueOnce(compiling).mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(compiled);
    const { result, unmount } = renderHook(() => useKnowledgeStatus("p1", true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(result.current.status?.state).toBe("compiled");
    unmount();
    vi.useRealTimers();
  });
});
