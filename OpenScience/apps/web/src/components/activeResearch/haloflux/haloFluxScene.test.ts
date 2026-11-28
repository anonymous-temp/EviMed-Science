import { describe, expect, it } from "vitest";
import { emptyObservation, ROOT_AGENT, type ObservedCall } from "@/lib/researchObservation";
import { previewScene, researchScene, type SceneInput } from "./haloFluxScene";

const call = (n: number, extra: Partial<ObservedCall> = {}): ObservedCall => ({
  id: `root:${n}`, agent: ROOT_AGENT, tool: "kb_search", label: "检索知识库", detail: `“query ${n}”`, stage: "search", state: "done",
  at: `2026-11-28T01:${String(n).padStart(2, "0")}:00Z`, durationMs: 2000, seq: n, ...extra,
});

function input(calls: ObservedCall[], extra: Partial<SceneInput> = {}): SceneInput {
  const model = emptyObservation();
  model.calls = [...calls].reverse();
  model.callCount = calls.length;
  model.agents.set(ROOT_AGENT, { id: ROOT_AGENT, root: true, state: "running", stage: "search", calls: calls.length });
  model.agents.set("child", { id: "child", root: false, label: "文献研究员", state: "running", stage: "read", calls: 0 });
  return {
    title: "围术期康复研究", status: "实时", clock: "00:10:00", live: true, active: true, waiting: false, model,
    counts: { plan: 0, search: calls.length, read: 0, analyze: 0, verify: 0, write: 0, deliver: 0 },
    memberName: id => (id === ROOT_AGENT ? "主研究员" : "文献研究员"),
    metrics: { requests: 12, tokensIn: 18000, tokensOut: 6000, toolTotal: calls.length, sources: { searched: 26, fullText: 8, included: 8 }, claims: { total: 4, verified: 3 }, cost: 0.36 },
    deliverables: [], files: { written: [], presented: [], unverified: [] }, pinned: null,
    startedMs: Date.parse("2026-11-28T01:00:00Z"), endedMs: null, now: Date.parse("2026-11-28T01:10:00Z"), ...extra,
  };
}

describe("HaloFlux console scene", () => {
  it("reads every counter, line and panel from the round, never a tool's name", () => {
    const scene = researchScene(input([call(1), call(2, { state: "running", durationMs: undefined, stage: "read", label: "获取全文", detail: "" })]));
    expect(scene.kpis.map(kpi => [kpi.label, kpi.value, kpi.ratio])).toEqual([
      ["模型调用", "12", null], ["Token 吞吐", "2.4万", null], ["研究操作", "2", 0.5], ["文献纳入", "8", 8 / 26], ["结论核对", "3/4", 0.75], ["消耗", "0.36", null],
    ]);
    expect(scene.feed.map(line => `${line.n} ${line.verb} ${line.text}`)).toEqual(["001 search 检索知识库 “query 1” · 主研究员", "002 read 获取全文 · 主研究员"]);
    expect(scene.code.map(line => [line.name, line.fn, line.arg, line.result, line.running])).toEqual([
      ["命中", "检索知识库", "“query 1”", "已完成", false], ["原文", "获取全文", "", "", true],
    ]);
    expect(scene.status).toEqual({ big: "2 项研究操作 · 阅读", small: "主研究员 · 1 位协作成员 · 实时" });
    expect(scene.reasoning.mode).toBe("call");
    expect(scene.stageNow).toBe(2);
    expect(scene.ops.map(op => [op.stage, op.state])).toEqual([[1, "done"], [2, "running"]]);
    expect(scene.agents.map(agent => [agent.no, agent.role, agent.working])).toEqual([["01", "主研究员", true], ["02", "文献研究员", true]]);
    expect(JSON.stringify(scene)).not.toContain("kb_search");
    expect([...scene.words!.head, ...scene.words!.code, ...scene.words!.numbers].every(word => /^[\x20-\x7e]+$/.test(word))).toBe(true);
    expect(scene.energy).toBe(1);
  });

  it("shows the pinned operation alone, else turns through the newest; a delivered file pulses as a delivery", () => {
    const calls = [call(1), call(2), call(3, { stage: "deliver", label: "交付文件", tool: "present", detail: "report.md" })];
    const following = researchScene(input(calls));
    expect(following.callouts.map(item => item.kicker)).toEqual(["DELIVER · 交付文件", "SEARCH · 检索知识库", "SEARCH · 检索知识库"]);
    expect(following.pulse).toEqual({ key: "root:3:done", kind: "deliver" });
    const pinned = researchScene(input(calls, { pinned: calls[0] }));
    expect(pinned.callouts).toEqual([{ id: "root:1", kicker: "SEARCH · 检索知识库", value: "“query 1”" }]);
    expect(researchScene(input([call(1, { state: "error" })])).pulse?.kind).toBe("error");
  });

  it("routes the plan's tasks, else the round's files, and calms down once the round ends", () => {
    const planned = researchScene(input([call(1)], {
      deliverables: [{ id: "d1", title: "检索策略", status: "delivered" }, { id: "d2", title: "证据表", status: "submitted" }, { id: "d3", title: "综述", status: "rejected" }] as SceneInput["deliverables"],
    }));
    expect(planned.routes.rows.map(row => [row.name, row.cells.join(",")])).toEqual([["证据表", "done,on,"], ["综述", "done,pk,"], ["检索策略", "done,done,done"]]);
    expect(planned.status.big).toBe("1 / 3 项任务 · 2 待完成");
    const ended = researchScene(input([call(1)], {
      live: false, active: false, status: "已完成", endedMs: Date.parse("2026-11-28T01:42:00Z"),
      files: { written: ["outputs/a.md", "outputs/b.md"], presented: ["outputs/a.md"], unverified: ["outputs/b.md"] },
    }));
    expect(ended.routes.head).toEqual(["产出", "写入", "交付", "核对"]);
    expect(ended.routes.rows.map(row => [row.name, row.cells.join(",")])).toEqual([["a.md", "done,done,done"], ["b.md", "done,on,pk"]]);
    expect(ended.energy).toBe(0);
    expect(ended.reasoning).toEqual({ mode: "idle", thought: "" });
    expect(ended.captions.signals).toBe("全程 42 分钟");
    expect(ended.stageNow).toBe(-1);
  });

  it("stands by with counters that say nothing was reported", () => {
    const scene = previewScene();
    expect(scene.kpis.every(kpi => kpi.value === "—")).toBe(true);
    expect(scene.words).toBeNull();
    expect(scene.energy).toBe(0);
  });
});
