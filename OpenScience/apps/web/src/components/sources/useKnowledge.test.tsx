import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeStatus } from "@/lib/sourceClient";
import statusCompiled from "./knowledgeFixtures/status-compiled.json";
import { roundKey, useKnowledgeStatus } from "./useKnowledge";

const mocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()), getKnowledgeStatus: mocks.status }));

const compiled = statusCompiled as unknown as KnowledgeStatus;
const compiling = { ...compiled, state: "compiling", stage: { tree: "wiki", step: "wiki", task: null, status: "running", startedAt: "2026-10-13T12:00:00Z" } } as KnowledgeStatus;

describe("useKnowledgeStatus", () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.status.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it("asks again every few seconds while a round is under way, and stops when it has ended", async () => {
    mocks.status.mockResolvedValueOnce(compiling).mockResolvedValueOnce(compiling).mockResolvedValue(compiled);
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

  it("names what a round left, so the tree is read again when it changes", () => {
    expect(roundKey(null)).toBe("");
    expect(roundKey(compiled)).not.toBe(roundKey({ ...compiled, round: compiled.round + 1 }));
  });
});
