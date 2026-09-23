import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { listReplyChecks, useFrameReplyChecks, type ReplyCheck } from "./replyChecks";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

const check: ReplyCheck = {
  id: "rc_1", runId: "run_1", sessionId: "s1", turnSeq: 12, status: "done", counts: { supported: 1 }, medicines: [], cautions: [],
  verdicts: [{ sentence: "二甲双胍可使 HbA1c 降低约 1% [1]。", verdict: "supported", warning: false, reason: "一致", evidence: "reduced HbA1c", safety: "none", source: { number: 1, title: "Metformin", url: "https://pubmed.ncbi.nlm.nih.gov/1/" } }],
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("the reply checks of a conversation", () => {
  it("asks for one conversation of one project", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { checks: [check] } }));
    expect(await listReplyChecks("p1", "s1")).toEqual([check]);
    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect(url.pathname).toBe("/api/review/replies");
    expect(Object.fromEntries(url.searchParams)).toEqual({ projectId: "p1", sessionId: "s1" });
  });

  it("reads a deployment without the reviewer as nothing to show, not as an error", async () => {
    fetchMock.mockResolvedValue(reply(404, { error: "The independent review is not enabled.", code: "review_not_enabled" }));
    expect(await listReplyChecks("p1", "s1")).toBeNull();
  });

  it("posts the checks into the frame once, and again only when they change", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(reply(200, { data: { checks: [check] } }))
      .mockResolvedValueOnce(reply(200, { data: { checks: [check] } }))
      .mockResolvedValueOnce(reply(200, { data: { checks: [{ ...check, id: "rc_2", turnSeq: 20 }, check] } }));
    const post = vi.fn();
    renderHook(() => useFrameReplyChecks({ projectId: "p1", sessionId: "s1", enabled: true, post, pollMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toEqual({ sessionId: "s1", checks: [check] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("does not ask while the frame is not listening", async () => {
    renderHook(() => useFrameReplyChecks({ projectId: "p1", sessionId: "s1", enabled: false, post: vi.fn() }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
