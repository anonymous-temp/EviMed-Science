import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downloadEvimedFullText, exportEvimedSearchRecords, readEvimedFullTextOffer, readEvimedFullTextStatus, readEvimedSearchCitations, readEvimedSearchDetail, readEvimedSearchFacets, requestEvimedFullText, searchEvimed, setEvimedSearchCollection, type EvimedFullTextOffer } from "./evimedSearchClient";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/productClient", () => ({ productRequest: request }));
beforeEach(() => { request.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("keeps search and detail requests without a signal compatible", () => {
  const input = { query: "diabetes", page: 1, pageSize: 10, filters: {} };
  searchEvimed("literature", input);
  expect(request).toHaveBeenLastCalledWith("/evimed-search/literature/search", "POST", input);
  readEvimedSearchDetail("guidelines", "opaque-reference");
  expect(request).toHaveBeenLastCalledWith("/evimed-search/guidelines/detail", "POST", { detailRef: "opaque-reference" });
  const filters = { query: "diabetes", filters: { articleType: ["2"], startYear: 2020 } };
  readEvimedSearchFacets("literature", filters);
  expect(request).toHaveBeenLastCalledWith("/evimed-search/literature/facets", "POST", filters);
});

it("forwards each caller's cancellation signal for search and detail", () => {
  const search = new AbortController();
  const detail = new AbortController();
  const input = { query: "diabetes", page: 2, pageSize: 10, filters: {} };
  searchEvimed("trials", input, search.signal);
  expect(request).toHaveBeenLastCalledWith("/evimed-search/trials/search", "POST", input, { signal: search.signal });
  readEvimedSearchDetail("drugs", "opaque-reference", detail.signal);
  expect(request).toHaveBeenLastCalledWith("/evimed-search/drugs/detail", "POST", { detailRef: "opaque-reference" }, { signal: detail.signal });
  const facets = new AbortController();
  readEvimedSearchFacets("guidelines", { query: "diabetes", filters: { sType: ["0"] } }, facets.signal);
  expect(request).toHaveBeenLastCalledWith("/evimed-search/guidelines/facets", "POST", { query: "diabetes", filters: { sType: ["0"] } }, { signal: facets.signal });
});

it("does not translate a cancelled product request into a search failure", async () => {
  const cancelled = new DOMException("The operation was aborted.", "AbortError");
  request.mockRejectedValue(cancelled);
  await expect(searchEvimed("literature", { query: "study", page: 1, pageSize: 10, filters: {} }, new AbortController().signal)).rejects.toBe(cancelled);
  await expect(readEvimedSearchDetail("literature", "opaque-reference", new AbortController().signal)).rejects.toBe(cancelled);
  await expect(readEvimedSearchFacets("literature", { query: "study", filters: {} }, new AbortController().signal)).rejects.toBe(cancelled);
});

it("uses signed action references and forwards cancellation for collection, citations, export and full text", () => {
  const controller = new AbortController();
  setEvimedSearchCollection("guidelines", "opaque-action", true, controller.signal);
  expect(request).toHaveBeenLastCalledWith("/evimed-search/guidelines/collection", "POST", { actionRef: "opaque-action", collected: true }, { signal: controller.signal });
  readEvimedSearchCitations("literature", ["opaque-action"], 5);
  expect(request).toHaveBeenLastCalledWith("/evimed-search/literature/citations", "POST", { actionRefs: ["opaque-action"], format: 5 });
  exportEvimedSearchRecords("literature", ["opaque-action"], 1);
  expect(request).toHaveBeenLastCalledWith("/evimed-search/literature/export", "POST", { actionRefs: ["opaque-action"], format: 1 });
  readEvimedFullTextStatus("drugs", "opaque-action");
  expect(request).toHaveBeenLastCalledWith("/evimed-search/drugs/fulltext-status", "POST", { actionRef: "opaque-action" });
  readEvimedFullTextOffer("drugs", "opaque-action");
  expect(request).toHaveBeenLastCalledWith("/evimed-search/drugs/fulltext-offer", "POST", { actionRef: "opaque-action" });
  requestEvimedFullText("drugs", "opaque-action");
  expect(request).toHaveBeenLastCalledWith("/evimed-search/drugs/fulltext-request", "POST", { actionRef: "opaque-action" });
});

const offer: EvimedFullTextOffer = { offerRef: "sealed-offer", filename: "study.pdf", status: 2, url: "https://files.evimed.test/original.pdf", canRequest: false, canDownload: true, daily: 1, permanent: 0, unlimited: false, kind: "free", amount: 0 };

it("validates a public PDF without account credentials before confirming the disclosed allowance", async () => {
  vi.stubGlobal("Blob", NodeBlob);
  const fetchFile = vi.fn(async () => {
    expect(request).not.toHaveBeenCalled();
    return new Response("%PDF-1.7\nSynthetic original");
  });
  vi.stubGlobal("fetch", fetchFile);
  request.mockResolvedValue({ approved: true });
  const file = await downloadEvimedFullText("literature", offer);
  expect(fetchFile).toHaveBeenCalledWith(new URL(offer.url!), { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: expect.any(AbortSignal) });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith("/evimed-search/literature/fulltext-confirm", "POST", { offerRef: "sealed-offer" });
  expect(file.filename).toBe("study.pdf"); expect(file.blob.type).toBe("application/pdf");
});

it("does not consume an allowance for HTML, oversized files or cancelled downloads", async () => {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>error %PDF-1.7</html>")));
  await expect(downloadEvimedFullText("literature", offer)).rejects.toMatchObject({ code: "evimed_search_download_unavailable" });
  expect(request).not.toHaveBeenCalled();
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { "content-length": String(50 * 1024 * 1024 + 1) } })));
  await expect(downloadEvimedFullText("literature", offer)).rejects.toMatchObject({ code: "evimed_search_download_too_large" });
  expect(cancel).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  const controller = new AbortController(); controller.abort();
  await expect(downloadEvimedFullText("literature", offer, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(request).not.toHaveBeenCalled();
});

it("never returns a savable file if allowance confirmation is refused or fails", async () => {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-1.7\nSynthetic original")));
  request.mockResolvedValueOnce({ approved: false });
  await expect(downloadEvimedFullText("literature", offer)).rejects.toMatchObject({ code: "evimed_search_download_unavailable" });
  request.mockRejectedValueOnce(new Error("Unknown confirmation outcome"));
  await expect(downloadEvimedFullText("literature", offer)).rejects.toThrow("Unknown confirmation outcome");
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["headers", "body"])("times out a stalled public PDF %s after 120 seconds without confirming an allowance", async phase => {
  vi.useFakeTimers();
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => {
    const downloadSignal = options.signal!;
    if (phase === "headers") return new Promise((_resolve, reject) => downloadSignal.addEventListener("abort", () => reject(new DOMException("The fetch was aborted.", "AbortError")), { once: true }));
    return Promise.resolve(new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode("%PDF-1.7\n"));
      downloadSignal.addEventListener("abort", () => stream.error(new DOMException("The body was aborted.", "AbortError")), { once: true });
    } })));
  }));
  const pending = expect(downloadEvimedFullText("literature", offer)).rejects.toMatchObject({ code: "evimed_search_timeout", status: 504 });
  await vi.advanceTimersByTimeAsync(120_000);
  await pending;
  expect(request).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("forwards user cancellation during download and removes its timer and listener", async () => {
  vi.useFakeTimers();
  const external = new AbortController();
  const remove = vi.spyOn(external.signal, "removeEventListener");
  vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }))));
  const pending = expect(downloadEvimedFullText("literature", offer, external.signal)).rejects.toMatchObject({ name: "AbortError" });
  external.abort();
  await pending;
  expect(request).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it("clears the public download timer before allowance confirmation", async () => {
  vi.useFakeTimers(); vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-1.7\nSynthetic original")));
  request.mockImplementation(async () => {
    expect(vi.getTimerCount()).toBe(0);
    return { approved: true };
  });
  await downloadEvimedFullText("literature", offer);
  expect(vi.getTimerCount()).toBe(0);
});
