import { beforeEach, expect, it, vi } from "vitest";
import { WebApiError } from "./apiClient";
import { productErrorMessage, productRequest } from "./productClient";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./apiClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("./apiClient")>(), fetchWithWebAuth: mocks.fetch, webApiBase: "",
}));
beforeEach(() => { mocks.fetch.mockReset(); });

it("keeps requests without an abort signal compatible", async () => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data: { ready: true } })));
  await expect(productRequest("/example")).resolves.toEqual({ ready: true });
  expect(mocks.fetch).toHaveBeenCalledWith("/api/example", { method: "GET" });
});

it("passes only the optional abort signal alongside the existing JSON request", async () => {
  const controller = new AbortController();
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data: ["result"] })));
  await expect(productRequest("/example", "POST", { query: "study" }, { signal: controller.signal })).resolves.toEqual(["result"]);
  expect(mocks.fetch).toHaveBeenCalledWith("/api/example", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "study" }), signal: controller.signal,
  });
});

it("preserves cancellation while waiting for fetch", async () => {
  const controller = new AbortController();
  mocks.fetch.mockImplementation((_url, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  }));
  const pending = productRequest("/example", "GET", undefined, { signal: controller.signal });
  const result = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await result;
});

it("preserves an AbortError while parsing the response body", async () => {
  const cancelled = new DOMException("The operation was aborted.", "AbortError");
  mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockRejectedValue(cancelled) });
  await expect(productRequest("/example")).rejects.toBe(cancelled);
});

it("keeps the signal cancellation reason when body reading fails after cancellation", async () => {
  const controller = new AbortController();
  const cancelled = new DOMException("The operation was aborted.", "AbortError");
  mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => { controller.abort(cancelled); throw new TypeError("Body reading stopped"); } });
  await expect(productRequest("/example", "GET", undefined, { signal: controller.signal })).rejects.toBe(cancelled);
});

it("still maps malformed bodies and service refusals to the existing API error", async () => {
  mocks.fetch.mockResolvedValue(new Response("invalid JSON"));
  await expect(productRequest("/example")).rejects.toBeInstanceOf(WebApiError);
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ error: "Unavailable", code: "product_unavailable" }), { status: 503, headers: { "Retry-After": "12" } }));
  await expect(productRequest("/example")).rejects.toMatchObject({ status: 503, code: "product_unavailable", retryAfterSeconds: 12 });
});

it("rejects an old account's delayed response body after a session boundary", async () => {
  let finish: ((value: unknown) => void) | null = null;
  mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve; }) });
  const pending = productRequest("/geo/projects");
  await vi.waitFor(() => expect(finish).not.toBeNull());
  window.dispatchEvent(new StorageEvent("storage", { key: "open-science:web-session-sync", newValue: "changed" }));
  (finish as unknown as (value: unknown) => void)({ data: { name: "old private project" } });
  await expect(pending).rejects.toMatchObject({ name: "StaleSessionError" });
});

it("words an option only an experiment could carry out as that, not as a stale revision", () => {
  expect(productErrorMessage(new WebApiError("refused", { status: 409, code: "evolution_offline_only" }))).toBe("这个选项要做的工作不再在线上进行，请选择其他选项。");
});
