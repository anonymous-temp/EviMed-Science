import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyRecord, nativeFile } from "@/components/memory/__fixtures__/memoryProfiles";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); window.localStorage.clear(); window.sessionStorage.clear(); });
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json" } });
const refusal = (status: number, code: string) => new Response(JSON.stringify({ error: "refused", code, requestId: "request-1" }), { status, headers: { "Content-Type": "application/json" } });

async function client(answer: (url: string, init?: RequestInit) => Response) {
  vi.resetModules();
  vi.stubEnv("VITE_OPEN_SCIENCE_API_URL", "/api");
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
    String(url).endsWith("/me") ? json({ csrfToken: "csrf-test" }) : answer(String(url), init));
  const api = await import("./apiClient");
  const errors = await import("./memoryErrors");
  const memory = await import("./memoryClient");
  return { api, errors, memory, calls: () => fetch.mock.calls.filter(([url]) => !String(url).endsWith("/me")) };
}
const sent = (init?: RequestInit) => JSON.parse(String(init?.body));

describe("saving a memory", () => {
  // The control plane refuses a summary and an importance on a memory kept as a file, by name: a click must never fail on a field the page itself added.
  it("sends a memory kept as a file only what it can take, with the version it was read at", async () => {
    const file = nativeFile("回答结构", "- 先给结论。");
    const { api, calls } = await client(() => json(file));
    await api.updateStructuredMemory(file, { value: "- 先给结论。", summary: "- 先给结论。", importance: 1, status: "active" });
    const [, init] = calls()[0];
    expect(init?.method).toBe("PATCH");
    expect(sent(init)).toEqual({ value: "- 先给结论。", status: "active", expectedVersion: 4711 });
  });

  it("leaves the older engine's save as it was", async () => {
    const record = legacyRecord();
    const { api, calls } = await client(() => json(record));
    await api.updateStructuredMemory(record, { value: "新的说法", summary: "新的说法" });
    expect(sent(calls()[0][1])).toEqual({ value: "新的说法", summary: "新的说法", expectedVersion: 2 });
  });

  it("tells a raced save from other refusals, and the service being down from either", async () => {
    const { api, errors } = await client(() => refusal(409, "memory_conflict"));
    const raced = await api.updateStructuredMemory(nativeFile("回答结构", "- x"), { value: "- y" }).catch((error: unknown) => error);
    expect(errors.isMemoryConflict(raced)).toBe(true);
    expect(errors.isMemoryServiceUnavailable(raced)).toBe(false);
    const down = await client(() => refusal(503, "memory_engine_unavailable"));
    const gone = await down.api.fetchMemoryProfile().catch((error: unknown) => error);
    expect(down.errors.isMemoryServiceUnavailable(gone)).toBe(true);
    expect(down.errors.isMemoryConflict(gone)).toBe(false);
    expect(down.api.webErrorMessage(gone)).toContain("记忆服务暂时不可用");
  });
});

describe("remembering from the page", () => {
  it("hands over the words, with the project when there is one, and answers the row to show", async () => {
    const pending = { id: "p1", text: "以后报告先给结论。", at: "2026-10-13T06:00:00Z", state: "pending" };
    const { memory, calls } = await client(() => json({ pending }));
    expect(await memory.rememberMemory("以后报告先给结论。")).toEqual({ pending });
    expect(sent(calls()[0][1])).toEqual({ text: "以后报告先给结论。" });
    await memory.rememberMemory("周五前出方案", "prj_1");
    expect(sent(calls()[1][1])).toEqual({ text: "周五前出方案", projectId: "prj_1" });
  });
});
