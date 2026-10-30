import { describe, expect, it } from "vitest";
import type { RunStreamEvent } from "./runEvents";
import { callDetail, callLabel, emptyObservation, foldObservation, partialStream, rootStage, ROOT_AGENT, seedObservation, stageCounts, stageOfCall, type Observation } from "./researchObservation";

const frame = (seq: number, type: string, fields: Record<string, unknown> = {}): RunStreamEvent => ({ seq, type, time: `2026-10-28T01:${String(seq).padStart(2, "0")}:00Z`, ...fields });
const fold = (frames: RunStreamEvent[], seed?: unknown): Observation => {
  const model = emptyObservation();
  if (seed) seedObservation(model, seed);
  for (const item of frames) foldObservation(model, item);
  return model;
};
const call = (seq: number, callId: string, tool: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  frame(seq, "run/event", { sessionId: "root", ...extra, event: { type: "tool/call", callId, tool, input, narration: "" } });
const result = (seq: number, callId: string, tool: string, status = "completed", extra: Record<string, unknown> = {}) =>
  frame(seq, "run/event", { sessionId: "root", ...extra, event: { type: "tool/result", callId, tool, status, output: "out", durationMs: 1200 } });
const aggregate = (children: unknown[], updatedAt = "2026-10-28T01:10:00Z") => ({ updatedAt, children, deliverables: [], phaseCounts: {} });

describe("research observation", () => {
  it("places a call on the research line by its tool's name", () => {
    expect(stageOfCall("mcp__evimed__literature_search", { query: "x" })).toBe("search");
    expect(stageOfCall("literature_search", { pmids: ["1"] })).toBe("read");
    expect(stageOfCall("web_read")).toBe("read");
    expect(stageOfCall("bash", { command: "python run.py" })).toBe("analyze");
    expect(stageOfCall("write", { path: "notes/x.md" })).toBe("write");
    expect(stageOfCall("todo")).toBe("plan");
    expect(stageOfCall("present")).toBe("deliver");
    expect(stageOfCall("evimed_claim_upsert")).toBe("verify");
    expect(stageOfCall("something_new")).toBeNull();
    // The server's own label wins over the local table.
    expect(stageOfCall("bash", {}, "claims")).toBe("verify");
  });
  it("says what a call did in the reader's words, and what it touched", () => {
    expect(callLabel("mcp__evimed__literature_search", "search")).toBe("文献检索");
    expect(callLabel("something_new", "analyze")).toBe("分析操作");
    expect(callLabel("something_new", null)).toBe("执行操作");
    expect(callDetail({ query: "SGLT2  heart failure" })).toBe("“SGLT2 heart failure”");
    expect(callDetail({ url: "https://www.nejm.org/doi/full/10.1056/x" })).toBe("www.nejm.org/doi/full/10.1056/x");
    expect(callDetail({ path: "/workspace/analysis/pool.py" })).toBe("analysis/pool.py");
    expect(callDetail({ command: "python a.py\nrm -rf tmp" })).toBe("python a.py");
    expect(callDetail({ pmids: ["1", "2"] })).toBe("2 篇文献");
    expect(callDetail({ query: "ignored" }, "检索相关试验")).toBe("检索相关试验");
  });
  it("folds a call and its result into one operation, counted once", () => {
    const model = fold([call(1, "a", "literature_search", { query: "q" }), result(2, "a", "literature_search")]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]).toMatchObject({ state: "done", durationMs: 1200, stage: "search", label: "文献检索", detail: "“q”", input: { query: "q" }, output: "out" });
    expect(model.callCount).toBe(1);
    expect(model.stageCounts.search).toBe(1);
    const failed = fold([call(1, "a", "web_read"), result(2, "a", "web_read", "error")]);
    expect(failed.calls[0].state).toBe("error");
  });
  it("moves the orchestrator and each delegated session to the stage of its last call", () => {
    const model = fold([
      frame(1, "run/event", { sessionId: "root", event: { type: "subagent/started", childSessionId: "c1", label: "文献检索员", parentSessionId: "root" } }),
      call(2, "a", "literature_search"),
      call(3, "b", "bash", { command: "python" }, { sessionId: "c1", child: true }),
      call(4, "c", "write", { path: "report.md" }),
    ]);
    expect(rootStage(model)).toBe("write");
    expect(model.agents.get("c1")).toMatchObject({ label: "文献检索员", stage: "analyze", calls: 1, state: "running", parent: "root" });
    expect(model.calls.map(item => item.agent)).toEqual([ROOT_AGENT, "c1", ROOT_AGENT]);
  });
  it("names a session that made a call without inventing its lifecycle", () => {
    const model = fold([call(1, "x", "fetch", {}, { sessionId: "c", child: true })]);
    expect(model.agents.get("c")).toMatchObject({ state: "unknown" });
    expect(model.agents.get("c")?.parent).toBeUndefined();
    expect(model.calls[0].state).toBe("running");
  });
  it("never counts a stage lower than the run's own aggregate", () => {
    const model = fold([frame(1, "run/progress", { progress: { deliverables: [], phaseCounts: { search: 9, screen: 2, fulltext: 3, claims: 4, write: 1, deliver: 0 }, currentPhase: "claims", sources: {}, claims: {} } }), call(2, "a", "literature_search")]);
    expect(stageCounts(model)).toMatchObject({ search: 9, read: 5, verify: 4, write: 1, deliver: 0, plan: 0 });
    expect(rootStage(fold([frame(1, "run/progress", { progress: { deliverables: [], phaseCounts: {}, currentPhase: "fulltext", sources: {}, claims: {} } })]))).toBe("read");
  });
  it("keeps a newer settled member state when older events are replayed", () => {
    const old = frame(1, "run/event", { sessionId: "root", event: { type: "subagent/started", childSessionId: "c", label: "检索" } });
    const model = fold([old], aggregate([{ childSessionId: "c", state: "done" }]));
    expect(model.agents.get("c")).toMatchObject({ state: "done", label: "检索" });
  });
  it("does not treat a replayed old start as a new running member", () => {
    const replay = { ...frame(1, "run/event", { event: { type: "subagent/started", childSessionId: "c", label: "检索" } }), time: "2026-10-28T01:20:00Z" };
    expect(fold([replay], aggregate([{ childSessionId: "c", state: "done" }])).agents.get("c")?.state).toBe("unknown");
    const settled = { ...frame(2, "run/progress", aggregate([{ childSessionId: "c", state: "running" }], "2026-10-28T01:21:00Z")), time: "2026-10-28T01:21:00Z" };
    expect(fold([replay, settled], aggregate([{ childSessionId: "c", state: "done" }])).agents.get("c")?.state).toBe("running");
  });
  it("does not mark a resumed member complete from a replayed old ending", () => {
    const seed = aggregate([{ childSessionId: "c", state: "running" }]);
    const end = { ...frame(1, "subagent/update", { childSessionId: "c", status: "completed" }), time: "2026-10-28T01:20:00Z" };
    const repeated = { ...frame(2, "subagent/update", { childSessionId: "c", status: "completed" }), time: "2026-10-28T01:21:00Z" };
    expect(fold([end, repeated], seed).agents.get("c")?.state).toBe("unknown");
    const settled = { ...frame(3, "run/progress", aggregate([{ childSessionId: "c", state: "running" }], "2026-10-28T01:22:00Z")), time: "2026-10-28T01:22:00Z" };
    expect(fold([end, repeated, settled], seed).agents.get("c")?.state).toBe("running");
  });
  it.each(["aborted", "blocked", "max-tokens", "interrupted"])("treats %s as a conflicting terminal status", (endKind) => {
    const end = { ...frame(1, "subagent/update", { childSessionId: "c", status: endKind }), time: "2026-10-28T01:20:00Z" };
    expect(fold([end], aggregate([{ childSessionId: "c", state: "running" }])).agents.get("c")?.state).toBe("unknown");
  });
  it("marks a stream that starts after the first event as partial", () => {
    expect(partialStream(fold([frame(40, "run/state", { state: "running" })]))).toBe(true);
    expect(partialStream(fold([frame(1, "run/state", { state: "running" })]))).toBe(false);
  });
  it("keeps the latest words of the orchestrator's thinking, and none of a member's", () => {
    const delta = (seq: number, text: string, extra: Record<string, unknown> = {}) => frame(seq, "run/event", { sessionId: "root", ...extra, event: { type: "assistant/delta", kind: "reasoning", text } });
    const model = fold([delta(1, "先比较两项试验的终点，"), delta(2, "再合并。"), delta(3, "成员的话", { sessionId: "c", child: true })]);
    expect(model.thought).toBe("先比较两项试验的终点，再合并。");
    const long = fold([delta(1, "长".repeat(400))]);
    expect(long.thought.length).toBe(280);
  });
  it("keeps a bounded window of operations while counting all of them", () => {
    const model = fold(Array.from({ length: 150 }, (_, index) => call(index + 1, `c${index}`, "web_search")));
    expect(model.calls).toHaveLength(120);
    expect(model.callCount).toBe(150);
    expect(model.stageCounts.search).toBe(150);
    expect(model.calls[0].id).toBe("root:c149");
  });
});
