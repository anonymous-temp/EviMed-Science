import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); window.localStorage.clear(); window.sessionStorage.clear(); });
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json" } });
const refusal = (status: number, code: string) => new Response(JSON.stringify({ error: "refused", code, requestId: "request-1" }), { status, headers: { "Content-Type": "application/json" } });

/** The client against a control plane at `/api`, with `answer` for everything but the CSRF read. */
async function client(answer: (url: string, init?: RequestInit) => Response) {
  vi.resetModules();
  vi.stubEnv("VITE_OPEN_SCIENCE_API_URL", "/api");
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
    String(url).endsWith("/me") ? json({ csrfToken: "csrf-test" }) : answer(String(url), init));
  const api = await import("./apiClient");
  /** The calls that are not the CSRF read. */
  const calls = () => fetch.mock.calls.filter(([url]) => !String(url).endsWith("/me"));
  return { api, fetch, calls };
}
const query = (url: unknown) => new URL(String(url), "https://science.example").searchParams;

describe("the simulated wallet's API", () => {
  it("asks for every tool's estimate in one read, and gives back what the route answered", async () => {
    const answer = { currency: "CNY", simulated: true, items: [{ capabilityId: "adr-analysis", basis: "history", low: 4, high: 8, samples: 5, binding: false }] };
    const { api, fetch, calls } = await client(() => json(answer));
    expect(await api.fetchWebResearchEstimates(["adr-analysis", "meta-analysis", "peer-review"])).toEqual(answer);
    // A read: one request, and no CSRF round trip before it.
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = calls()[0];
    expect(new URL(String(url), "https://science.example").pathname).toBe("/api/account/allowance/estimates");
    expect([...query(url).keys()]).toEqual(["capabilities"]);
    expect(query(url).get("capabilities")).toBe("adr-analysis,meta-analysis,peer-review");
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.credentials).toBe("include");
  });

  // The route refuses the whole list for a repeated id or for more than forty,
  // and then no tool has an estimate: the list goes out unique and within it.
  it("names each tool once and no more than the route takes, in the order given", async () => {
    const { api, calls } = await client(() => json({ currency: "CNY", simulated: true, items: [] }));
    const many = Array.from({ length: 45 }, (_, index) => `tool-${index}`);
    await api.fetchWebResearchEstimates(["tool-0", "tool-1", "tool-0", ...many]);
    const asked = query(calls()[0][0]).get("capabilities")?.split(",") ?? [];
    expect(asked).toHaveLength(40);
    expect(new Set(asked).size).toBe(40);
    expect(asked).toEqual(many.slice(0, 40));
  });

  it("reads the simulated orders a page at a time, from the cursor it is given", async () => {
    const page = { simulated: true, currency: "CNY", items: [], nextCursor: null };
    const { api, calls } = await client(() => json(page));
    expect(await api.fetchWebSimulatedOrders()).toEqual(page);
    await api.fetchWebSimulatedOrders("next/page+1");
    const [first, second] = calls().map(([url]) => url);
    expect(new URL(String(first), "https://science.example").pathname).toBe("/api/simulated-wallet/orders");
    expect(Object.fromEntries(query(first))).toEqual({ limit: "20" });
    // The cursor is the server's own string, carried back byte for byte.
    expect(Object.fromEntries(query(second))).toEqual({ limit: "20", cursor: "next/page+1" });
  });

  it("tops up with a POST naming the package and the request, and nothing else, under CSRF", async () => {
    const applied = { simulated: true, order: { id: "ord_1", packageId: "topup-100", title: "模拟充值", amount: 100, at: "2026-10-04T08:00:00.000Z", status: "paid" }, available: 300, duplicate: false };
    const { api, calls } = await client(() => json(applied, 201));
    expect(await api.topUpWebSimulatedWallet("topup-100", "request_identity-1")).toEqual(applied);
    expect(calls()).toHaveLength(1);
    const [url, init] = calls()[0];
    expect(url).toBe("/api/simulated-wallet/topups");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ packageId: "topup-100", requestId: "request_identity-1" }));
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Open-Science-CSRF")).toBe("csrf-test");
    expect(init?.credentials).toBe("include");
  });

  // A request id the control plane has already applied is answered 200 with the
  // same order and `duplicate: true`: an answer, not a failure.
  it("gives back a repeated request's answer as it is, marked a duplicate", async () => {
    const repeated = { simulated: true, order: { id: "ord_1", packageId: "topup-100", title: "模拟充值", amount: 100, at: "2026-10-04T08:00:00.000Z", status: "paid" }, available: 300, duplicate: true };
    const { api } = await client(() => json(repeated, 200));
    expect(await api.topUpWebSimulatedWallet("topup-100", "request_identity-1")).toEqual(repeated);
  });

  it.each([
    [404, "simulated_wallet_not_enabled"],
    [400, "simulated_wallet_request_invalid"],
    [503, "evimed_credits_unreachable"],
  ])("raises a refused top-up (%s %s) with its code, worded by the dictionary", async (status, code) => {
    const { api } = await client(() => refusal(status, code));
    const caught = await api.topUpWebSimulatedWallet("topup-100", "request_identity-1").then(() => null, (error: unknown) => error);
    expect(caught).toBeInstanceOf(api.WebApiError);
    expect(caught).toMatchObject({ status, code, requestId: "request-1" });
    const { knownErrorCodeMessage } = await import("@evimed/domain");
    // The registry has a sentence for the code, and that sentence is what a page shows.
    expect(knownErrorCodeMessage(code)).toBeTruthy();
    expect(api.webErrorMessage(caught)).toBe(knownErrorCodeMessage(code));
  });

  // What a start refused by the simulated allowance says, wherever it surfaces:
  // the dictionary's sentence for that code, which names the simulation and is
  // not the real wallet's.
  it("words a start the simulated allowance refused as simulated, not as the real wallet's refusal", async () => {
    const { api } = await client(() => json(null));
    const { knownErrorCodeMessage } = await import("@evimed/domain");
    const sentence = api.webErrorMessage(new api.WebApiError("refused", { status: 402, code: "simulated_credits_exhausted" }));
    expect(sentence).toBe(knownErrorCodeMessage("simulated_credits_exhausted"));
    expect(sentence).toContain("模拟");
    expect(sentence).not.toBe(api.webErrorMessage(new api.WebApiError("refused", { status: 402, code: "credits_exhausted" })));
  });

  it("asks nothing where there is no control plane", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_OPEN_SCIENCE_API_URL", "");
    const fetch = vi.spyOn(globalThis, "fetch");
    const api = await import("./apiClient");
    await expect(api.fetchWebResearchEstimates(["adr-analysis"])).rejects.toBeInstanceOf(api.BackendUnavailableError);
    await expect(api.fetchWebSimulatedOrders()).rejects.toBeInstanceOf(api.BackendUnavailableError);
    await expect(api.topUpWebSimulatedWallet("topup-100", "request_identity-1")).rejects.toBeInstanceOf(api.BackendUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
