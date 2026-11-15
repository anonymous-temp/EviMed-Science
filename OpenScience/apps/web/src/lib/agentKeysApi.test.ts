import { afterEach, describe, expect, it, vi } from "vitest";
async function client() {
  vi.resetModules(); vi.stubEnv("VITE_OPEN_SCIENCE_API_URL", "/api");
  return import("./apiClient");
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("agent key browser client", () => {
  it("checks the public enable switch before listing session-authenticated keys", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({ openapi: "3.1.0" })).mockResolvedValueOnce(response({ data: { keys: [], scopes: ["memory.read"] } }));
    const api = await client(); expect(await api.fetchWebAgentKeys()).toEqual({ keys: [], scopes: ["memory.read"] });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/agent-memory/v1/openapi.json", "/api/agent-keys"]);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ credentials: "include", cache: "no-store" });
  });
  it("propagates the named disabled state without listing or creating keys", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ code: "agent_memory_disabled", error: "disabled" }, 503));
    const api = await client(); await expect(api.fetchWebAgentKeys()).rejects.toMatchObject({ code: "agent_memory_disabled", status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("creates and revokes with browser session and CSRF, keeps the one-time secret out of storage", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({ data: { csrfToken: "csrf-fixture" } })).mockResolvedValueOnce(response({ data: { id: "agk/a", key: "evk_once" } }, 201)).mockResolvedValueOnce(response({ data: { id: "agk/a", revokedAt: "today" } }));
    const storage = vi.spyOn(Storage.prototype, "setItem"); const api = await client();
    expect(await api.createWebAgentKey({ name: "DSH", scopes: ["memory.read", "memory.write"] })).toMatchObject({ key: "evk_once" });
    await api.revokeWebAgentKey("agk/a");
    expect(fetcher.mock.calls[1][0]).toBe("/api/agent-keys");
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "include", cache: "no-store", body: JSON.stringify({ name: "DSH", scopes: ["memory.read", "memory.write"] }) });
    expect(fetcher.mock.calls[2][0]).toBe("/api/agent-keys/agk%2Fa");
    for (const [, init] of fetcher.mock.calls.slice(1)) expect(new Headers(init?.headers).get("X-Open-Science-CSRF")).toBe("csrf-fixture");
    expect(storage.mock.calls.some(([, value]) => String(value).includes("evk_once"))).toBe(false);
  });
});
