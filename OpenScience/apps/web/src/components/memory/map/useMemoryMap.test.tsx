import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapQuery, MemoryMap } from "@/lib/memoryMapClient";
import { useMemoryMap } from "./useMemoryMap";

const { fetchMemoryMap, refreshTopics } = vi.hoisted(() => ({ fetchMemoryMap: vi.fn(), refreshTopics: vi.fn() }));
vi.mock("@/lib/memoryMapClient", () => ({ fetchMemoryMap, refreshTopics }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function documentFor(projectId: string): MemoryMap {
  return {
    version: 1, scope: { projectId, range: { from: null, to: "2026-10-19", unit: "month" }, timeZone: "Asia/Shanghai", focus: null, depth: null },
    status: { topics: "ready" }, summary: { memories: 1, documents: 0, methods: 0, projects: 1, needsLook: 0, since: null },
    facets: { projects: [], kinds: [], topics: [], dimensions: [] }, nodes: [], edges: [], buckets: { unit: "day", series: [] },
    lanes: [], events: [], truncated: { nodes: 0, edges: 0 }, missing: [],
  };
}
const query = (projectId: string): MapQuery => ({ projectId, range: "all", focus: null, depth: 1 });
function pendingDocument() {
  let resolve!: (value: MemoryMap) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<MemoryMap>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("memory map selection ownership", () => {
  it("does not display the previous project's document while the next project is loading or fails", async () => {
    const next = pendingDocument();
    fetchMemoryMap.mockResolvedValueOnce(documentFor("first")).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook((value: MapQuery) => useMemoryMap(value), { initialProps: query("first") });
    await waitFor(() => expect(result.current.doc?.scope.projectId).toBe("first"));
    rerender(query("second"));
    expect(result.current.doc).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => { next.reject(new Error("unavailable")); });
    expect(result.current.doc).toBeNull();
    expect(result.current.failed).toBe(true);
  });

  it("retains the same scope's readable document on a failed refresh", async () => {
    fetchMemoryMap.mockResolvedValueOnce(documentFor("first")).mockRejectedValueOnce(new Error("unavailable"));
    const { result } = renderHook(() => useMemoryMap(query("first")));
    await waitFor(() => expect(result.current.doc?.scope.projectId).toBe("first"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.doc?.scope.projectId).toBe("first");
  });

  it("ignores an earlier selection's response after a later one has completed", async () => {
    const first = pendingDocument();
    fetchMemoryMap.mockReturnValueOnce(first.promise).mockResolvedValueOnce(documentFor("second"));
    const { result, rerender } = renderHook((value: MapQuery) => useMemoryMap(value), { initialProps: query("first") });
    rerender(query("second"));
    await waitFor(() => expect(result.current.doc?.scope.projectId).toBe("second"));
    await act(async () => { first.resolve(documentFor("first")); });
    expect(result.current.doc?.scope.projectId).toBe("second");
  });
});
