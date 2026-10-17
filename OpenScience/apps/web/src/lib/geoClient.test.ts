import { beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("./productClient", () => ({ productRequest: network.productRequest }));

import { exportGeo, getGeoProgrammeRuns, runGeoStep } from "./geoClient";

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
    const runs = await getGeoProgrammeRuns("geo_1");
    expect(network.productRequest).toHaveBeenCalledWith("/geo/projects/geo_1/runs");
    expect(runs.map((run) => [run.sessionId, run.label, run.state])).toEqual([["s_1", "写第 2 批稿件", "running"], ["s_2", "生成周报", "finished"], ["s_3", "后台分析", "stopped"]]);
    expect(runs[0].at).toBe("2 分钟前");
    expect(runs[1].at).toMatch(/^(2026-09-14|9月14日)$/);
    expect(runs[2].at).toBeNull();
    // Nothing the page would print is an id.
    expect(JSON.stringify(runs)).not.toMatch(/run_|geo:/);
    network.productRequest.mockResolvedValue({});
    expect(await getGeoProgrammeRuns("geo_1")).toEqual([]);
  });
});
