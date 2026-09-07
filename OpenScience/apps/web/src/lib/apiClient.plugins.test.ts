import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); window.localStorage.clear(); window.sessionStorage.clear(); });
const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });

describe("project plugin API", () => {
  it("binds paths and headers to the requested project and uses CSRF for all mutations", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_OPEN_SCIENCE_API_URL", "https://science.example/api");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/me") ? json({ csrfToken: "csrf-test" }) : json({ plugins: [], items: [] }));
    const client = await import("./apiClient");
    client.setWebProjectId("other-project");
    const signal = new AbortController().signal;
    expect(await client.listWebPlugins("alpha", signal)).toEqual([]);
    await client.saveWebPlugin("alpha", "dsh-cite", { expectedRevision: 0, enabled: false, settings: { timeoutMs: 4000 } }, signal);
    expect(await client.listWebPluginRevisions("alpha", "dsh-cite", signal)).toEqual([]);
    await client.rollbackWebPlugin("alpha", "dsh-cite", { expectedRevision: 1, targetRevision: 0 }, signal);
    await client.retryWebPlugin("alpha", "dsh-cite", signal);
    await client.removeWebPlugin("alpha", "dsh-cite", { expectedRevision: 2 }, signal);
    const calls = fetch.mock.calls.filter(([url]) => !String(url).endsWith("/me"));
    expect(calls.map(([url]) => url)).toEqual([
      "https://science.example/api/projects/alpha/plugins",
      "https://science.example/api/projects/alpha/plugins/dsh-cite",
      "https://science.example/api/projects/alpha/plugins/dsh-cite/revisions",
      "https://science.example/api/projects/alpha/plugins/dsh-cite/rollback",
      "https://science.example/api/projects/alpha/plugins/dsh-cite/retry",
      "https://science.example/api/projects/alpha/plugins/dsh-cite",
    ]);
    expect(calls.map(([, init]) => init?.method)).toEqual(["GET", "PUT", "GET", "POST", "POST", "DELETE"]);
    for (const [, init] of calls) {
      expect(new Headers(init?.headers).get("X-Open-Science-Project")).toBe("alpha");
      expect(init?.signal).toBe(signal);
      expect(init?.credentials).toBe("include");
      if (init?.method !== "GET") expect(new Headers(init?.headers).get("X-Open-Science-CSRF")).toBe("csrf-test");
    }
    expect(calls.map(([, init]) => init?.body)).toEqual([undefined, JSON.stringify({ expectedRevision: 0, enabled: false, settings: { timeoutMs: 4000 } }), undefined, JSON.stringify({ expectedRevision: 1, targetRevision: 0 }), "{}", JSON.stringify({ expectedRevision: 2 })]);
  });

  it("addresses whichever plugin the caller names, without forwarding anything else", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_OPEN_SCIENCE_API_URL", "/api");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/me") ? json({ csrfToken: "csrf-test" }) : json({ plugins: [], items: [] }));
    const client = await import("./apiClient");
    // Named fields only: whatever else a caller carries stays here rather than
    // becoming a request the server refuses for a reason nobody can read.
    await client.saveWebPlugin("alpha", "dsh-notes", { expectedRevision: 0, enabled: true, settings: {}, userId: "other" } as unknown as { expectedRevision: number; enabled: boolean; settings: Record<string, number> });
    await client.listWebPluginRevisions("alpha", "a/b");
    await client.removeWebPlugin("alpha", "dsh-notes", { expectedRevision: 1, purge: true } as unknown as { expectedRevision: number });
    const calls = fetch.mock.calls.filter(([url]) => !String(url).endsWith("/me"));
    expect(calls.map(([url]) => url)).toEqual([
      "/api/projects/alpha/plugins/dsh-notes",
      "/api/projects/alpha/plugins/a%2Fb/revisions",
      "/api/projects/alpha/plugins/dsh-notes",
    ]);
    expect(calls[0][1]?.body).toBe(JSON.stringify({ expectedRevision: 0, enabled: true, settings: {} }));
    expect(calls[2][1]?.body).toBe(JSON.stringify({ expectedRevision: 1 }));
  });

  it("propagates conflict metadata for deliberate reload and retry", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_OPEN_SCIENCE_API_URL", "/api");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/me") ? json({ csrfToken: "csrf-test" }) : new Response(JSON.stringify({ error: "conflict", code: "product_revision_conflict", requestId: "request-1" }), { status: 409, headers: { "Content-Type": "application/json" } }));
    const client = await import("./apiClient");
    await expect(client.saveWebPlugin("alpha", "dsh-cite", { expectedRevision: 0, enabled: true, settings: { timeoutMs: 4000 } })).rejects.toMatchObject({ status: 409, code: "product_revision_conflict", requestId: "request-1" });
    await expect(client.removeWebPlugin("alpha", "dsh-cite", { expectedRevision: 0 })).rejects.toMatchObject({ status: 409, code: "product_revision_conflict" });
  });
});
