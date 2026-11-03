import { describe, expect, it } from "vitest";
import type { RunStreamEvent } from "./runEvents";
import { callDetail, callLabel, emptyObservation, foldObservation, GOAL_MACHINERY_WORDS, isGoalMachineryCall, namesGoalMachinery, partialStream, rootStage, ROOT_AGENT, seedObservation, stageCounts, stageOfCall, type Observation } from "./researchObservation";

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
  describe("the long-goal machinery", () => {
    it("knows a shell call that runs LoopX's command, reads its directory or sets its variables, by those tokens alone", () => {
      for (const command of ["loopx --registry /home/user/.loopx/registry.json status", "cd ~/.loopx/ && ls", "LOOPX_HOME=/tmp/x node run.js", "export LOOPX_AGENT_ID=a1", "npx loopx goal pause", "/usr/local/bin/loopx status", "(loopx status)", "cat .loopx/state.json", "LOOPX --help"]) {
        expect(isGoalMachineryCall("bash", { command }), command).toBe(true);
      }
      expect(isGoalMachineryCall("mcp__shell__exec", { cmd: ["bash", "-lc", "loopx status"] })).toBe(true);
      expect(isGoalMachineryCall("terminal", { command: "loopx goalbar read" })).toBe(true);
    });
    it("leaves research alone: other shell commands, other tools, and names that only begin with the word", () => {
      for (const command of ["python analysis/pool.py --studies 12", "echo hello", "ls -la output/", "grep -n loopxlike notes.md", "cat skills/loopx-project/SKILL.md", "pip install loopx2"]) {
        expect(isGoalMachineryCall("bash", { command }), command).toBe(false);
      }
      // Not a shell: whatever it names is not a command that was run.
      expect(isGoalMachineryCall("write", { path: ".loopx/notes.md", command: "loopx status" })).toBe(false);
      expect(isGoalMachineryCall("web_search", { query: "loopx" })).toBe(false);
      expect(isGoalMachineryCall("bash", null)).toBe(false);
      expect(isGoalMachineryCall("bash", { command: 42 })).toBe(false);
    });
    it("keeps such a call and its result out of the feed and out of every count, and counts the research around it", () => {
      const machinery = { command: "loopx --registry /home/user/.loopx/r.json goal status" };
      const model = fold([call(1, "a", "web_search", { query: "q" }), call(2, "m", "bash", machinery), result(3, "m", "bash"), call(4, "n", "bash", { command: "cd .loopx/ && cat todo.json" }),
        result(5, "n", "bash", "error"), result(6, "a", "web_search"), call(7, "b", "bash", { command: "python run.py" })]);
      expect(model.calls.map(item => item.id)).toEqual(["root:b", "root:a"]);
      expect(model.callCount).toBe(2);
      expect(model.stageCounts).toMatchObject({ search: 1, analyze: 1 });
      expect(model.rootStage).toBe("analyze");
      // The frames still moved the stream along.
      expect(model.lastSeq).toBe(7);
    });
    it("pairs a machinery call with its result by the session and call id, as a research call is paired", () => {
      const model = fold([call(1, "x", "bash", { command: "loopx status" }, { sessionId: "c1", child: true }), result(2, "x", "bash", "completed", { sessionId: "c1", child: true }),
        // Another session's call with the same id is not that call.
        result(3, "x", "bash", "completed", { sessionId: "root" })]);
      expect(model.calls.map(item => item.id)).toEqual(["root:x"]);
      expect(model.agents.has("c1")).toBe(false);
    });
    it("empties the thinking line while the reasoning names the machinery, and gives it back once the words are behind it", () => {
      const delta = (seq: number, text: string) => frame(seq, "run/event", { sessionId: "root", event: { type: "assistant/delta", kind: "reasoning", text } });
      const model = fold([delta(1, "先看两项试验的终点。")]);
      expect(model.thought).toBe("先看两项试验的终点。");
      foldObservation(model, delta(2, " 现在调用 LoopX 写回进度"));
      expect(model.thought).toBe("");
      foldObservation(model, delta(3, "，然后继续。"));
      expect(model.thought).toBe("");
      // The raw tail goes on collecting; once the words have left its window the line comes back.
      foldObservation(model, delta(4, "核".repeat(300)));
      expect(model.thought).toBe("核".repeat(280));
    });
    it("names the machinery without regard to case, from one list", () => {
      expect(GOAL_MACHINERY_WORDS).toEqual(["loopx", "todo_", "quota", "writeback", "settlement"]);
      for (const text of ["LoopX is ready", "calling TODO_write now", "the Quota is spent", "WriteBack failed", "after Settlement"]) expect(namesGoalMachinery(text), text).toBe(true);
      expect(namesGoalMachinery("先比较两项试验的终点，再合并。")).toBe(false);
      expect(namesGoalMachinery("todo list")).toBe(false);
    });
  });
  it("keeps when the newest frame happened, from the frame's own time and never backwards", () => {
    expect(emptyObservation().lastEventAt).toBeNull();
    const model = fold([frame(5, "run/state", { state: "running" })]);
    expect(model.lastEventAt).toBe(Date.parse("2026-10-28T01:05:00Z"));
    foldObservation(model, frame(3, "run/state", { state: "running" }));
    expect(model.lastEventAt).toBe(Date.parse("2026-10-28T01:05:00Z"));
    foldObservation(model, call(9, "a", "web_search"));
    expect(model.lastEventAt).toBe(Date.parse("2026-10-28T01:09:00Z"));
  });
  it("falls back to now for a frame that carries no usable time", () => {
    const before = Date.now();
    const model = fold([{ seq: 1, type: "run/state", time: "", state: "running" }]);
    expect(model.lastEventAt).toBeGreaterThanOrEqual(before);
    expect(model.lastEventAt).toBeLessThanOrEqual(Date.now());
  });
});
