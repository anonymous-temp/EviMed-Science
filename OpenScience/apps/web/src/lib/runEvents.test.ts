import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSseChunk, subscribeRunEvents, type RunStreamEvent } from "./runEvents";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function frame(seq: number, type: string, data: Record<string, unknown> = {}): string {
  return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq, time: "2026-09-18T00:00:00.000Z", ...data })}\n\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("parseSseChunk", () => {
  it("emits whole events, skips heartbeats, and returns the partial tail", () => {
    const seen: RunStreamEvent[] = [];
    const whole = `: open\n\n${frame(1, "run/state", { state: "running" })}: ping\n\n`;
    const partial = frame(2, "deliverable/update", { id: "d1" }).slice(0, 20);
    const rest = parseSseChunk(whole + partial, (event) => seen.push(event));
    expect(seen).toEqual([{ seq: 1, time: "2026-09-18T00:00:00.000Z", type: "run/state", state: "running" }]);
    expect(rest).toBe(partial);
  });

  it("drops a malformed frame without losing the next one", () => {
    const seen: RunStreamEvent[] = [];
    parseSseChunk(`event: x\ndata: {not json\n\n${frame(3, "tool/call", { tool: "literature_search" })}`, (event) => seen.push(event));
    expect(seen.map((event) => event.seq)).toEqual([3]);
    expect(seen[0].tool).toBe("literature_search");
  });
});

describe("subscribeRunEvents", () => {
  it("delivers events split across chunks, then resumes after the last seq", async () => {
    const body = frame(1, "run/state", { state: "running" }) + frame(2, "tool/call", { tool: "guideline_search" });
    const calls: string[] = [];
    let resolveSecond: () => void = () => {};
    const second = new Promise<void>((resolve) => { resolveSecond = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) return new Response(streamOf([body.slice(0, 37), body.slice(37)]), { status: 200 });
      resolveSecond();
      return new Response(null, { status: 404 });
    }));
    const seen: number[] = [];
    const stop = subscribeRunEvents("run_1", (event) => seen.push(event.seq), { backoffMs: [1] });
    await second;
    stop();
    expect(seen).toEqual([1, 2]);
    expect(calls[0]).toMatch(/\/api\/runs\/run_1\/events$/);
    expect(calls[1]).toMatch(/\/api\/runs\/run_1\/events\?since=2$/);
  });

  it("sends the project header and stops on 404 without reconnecting", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    subscribeRunEvents("run_gone", () => {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const headers = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(new Headers(headers.headers).has("X-Open-Science-Project")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
