import { beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("./productClient", () => ({ productRequest: network.productRequest }));

import { exportGeo, getGeoProgrammeRuns, releaseGeoArticle, runGeoStep } from "./geoClient";

beforeEach(() => network.productRequest.mockReset());

describe("starting work, and reading what the programme did", () => {
  it("a press answers that it was taken and the run it started — the client has no session to offer", async () => {
    network.productRequest.mockResolvedValue({ accepted: true, runId: "run_1", step: "evidence" });
    expect(await runGeoStep("geo_1", "evidence")).toEqual({ accepted: true, runId: "run_1", step: "evidence" });
    expect(network.productRequest).toHaveBeenCalledWith("/geo/projects/geo_1/run", "POST", { step: "evidence" });
    network.productRequest.mockResolvedValue({ accepted: true, runId: null, step: null });
    expect((await exportGeo("geo_1", "weekly")).runId).toBeNull();
    expect(network.productRequest).toHaveBeenLastCalledWith("/geo/projects/geo_1/export", "POST", { kind: "weekly" });
  });

  it("the AI-run record is the shared shape: a sentence, a closed state word, a time a list would say", async () => {
    const now = Date.now();
    network.productRequest.mockResolvedValue({ runs: [
      { sessionId: "s_1", runId: "run_1", label: " 写第 2 批稿件 ", state: "running", startedAt: new Date(now - 2 * 60_000).toISOString() },
      { sessionId: "s_2", runId: "run_2", label: "生成周报", state: "finished", startedAt: "2026-09-14T08:00:00.000Z" },
      { sessionId: "s_3", runId: "run_3", label: "", state: "canceled", startedAt: null },
      { sessionId: "", label: "no session" }, { label: "no session either" }, null,
    ] });
    const { runs } = await getGeoProgrammeRuns("geo_1");
    expect(network.productRequest).toHaveBeenCalledWith("/geo/projects/geo_1/runs");
    expect(runs.map((run) => [run.sessionId, run.label, run.state])).toEqual([["s_1", "写第 2 批稿件", "running"], ["s_2", "生成周报", "finished"], ["s_3", "后台分析", "stopped"]]);
    expect(runs[0].at).toBe("2 分钟前");
    expect(runs[1].at).toMatch(/^(2026-09-14|9月14日)$/);
    expect(runs[2].at).toBeNull();
    // Nothing the page would print is an id.
    expect(runs.map(run => run.runId)).toEqual(['run_1', 'run_2', 'run_3']);
    expect(JSON.stringify(runs.map(run => [run.label, run.at]))).not.toMatch(/run_|geo:/);
    network.productRequest.mockResolvedValue({});
    expect(await getGeoProgrammeRuns("geo_1")).toEqual({ runs: [], nextCursor: null });
  });

  it("reads one page of the record at a time: the next only when asked, from the cursor the last one gave", async () => {
    network.productRequest.mockResolvedValueOnce({ runs: [{ sessionId: "s_1", runId: "run_1", label: "生成周报", state: "finished", startedAt: null }], nextCursor: "c_2" })
      .mockResolvedValueOnce({ runs: [{ sessionId: "s_2", runId: "run_2", label: "写稿", state: "finished", startedAt: null }], nextCursor: null });
    const first = await getGeoProgrammeRuns("geo_1");
    expect(network.productRequest).toHaveBeenCalledTimes(1);
    expect(first.nextCursor).toBe("c_2");
    const next = await getGeoProgrammeRuns("geo_1", first.nextCursor);
    expect(network.productRequest).toHaveBeenLastCalledWith("/geo/projects/geo_1/runs?cursor=c_2");
    expect(next).toMatchObject({ runs: [{ sessionId: "s_2" }], nextCursor: null });
  });
});


it("sends the observed immutable article version and digest with a release", async () => {
  network.productRequest.mockResolvedValue({ safety: "released" });
  const observed = { expectedResultVersionId: `rv_${"a".repeat(64)}`, expectedDigest: "a".repeat(64) };
  await releaseGeoArticle("geo_1", "article_1", observed);
  expect(network.productRequest).toHaveBeenCalledWith("/geo/projects/geo_1/articles/article_1/release", "POST", observed);
});
