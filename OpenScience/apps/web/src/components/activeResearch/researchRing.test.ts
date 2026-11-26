import { describe, expect, it } from "vitest";
import { emptyObservation, seedObservation, STAGES, ROOT_AGENT, type ObservedCall } from "@/lib/researchObservation";
import { drawingKey, researchRingSpec } from "./researchRing";

const AT = "2026-11-26T12:00:00Z";
const call = (seq: number, extra: Partial<ObservedCall> = {}): ObservedCall => ({
  id: `call-${seq}`, seq, at: AT, agent: ROOT_AGENT, tool: "web_search", label: "网页搜索", detail: "",
  stage: "search", state: "done", ...extra,
});

describe("research ring spec", () => {
  it("keeps all seven stages in order and takes counts from the run aggregate", () => {
    const model = emptyObservation();
    model.stageCounts.plan = 2;
    seedObservation(model, { deliverables: [], phaseCounts: { search: 12, screen: 2, fulltext: 3 } });
    const { segments } = researchRingSpec(model, { live: false });
    expect(segments).toEqual(STAGES.map(({ key, label, code }, index) => ({
      id: key, label, code, count: [2, 12, 5, 0, 0, 0, 0][index],
      tone: ["about", "fact", "document", "decision", "method", "preference", "you"][index],
    })));
  });

  it("places each staged operation in its own cell with its state and elapsed length", () => {
    const model = emptyObservation();
    model.calls = [
      call(1, { state: "running" }),
      call(2, { stage: "read", state: "error", at: "invalid", durationMs: 9_000 }),
      call(3, { stage: "write", durationMs: 200_000 }),
      call(4, { stage: null }),
    ];
    expect(researchRingSpec(model, { live: true }).cells).toEqual([
      { id: "call-1", segment: "search", order: 1, at: Date.parse(AT), length: 0.6, state: "running", bright: 1, tone: "fact", spark: true },
      { id: "call-2", segment: "read", order: 2, at: null, length: 0.625, state: "error", bright: 0.9, tone: "document", spark: false },
      { id: "call-3", segment: "write", order: 3, at: Date.parse(AT), length: 1, state: "current", bright: 0.75, tone: "preference", spark: false },
    ]);
  });

  it("keeps the latest 60 cells per stage without truncating its count", () => {
    const model = emptyObservation();
    model.calls = [
      call(1, { id: "older", at: "2026-11-26T11:59:00Z" }),
      ...Array.from({ length: 60 }, (_, index) => call(index + 1)),
      call(61, { stage: "read" }),
    ];
    model.stageCounts.search = 100;
    const { cells, segments } = researchRingSpec(model, { live: true });
    expect(cells.filter(cell => cell.segment === "search")).toHaveLength(60);
    expect(cells.some(cell => cell.id === "older")).toBe(false);
    expect(cells.some(cell => cell.id === "call-1")).toBe(true);
    expect(cells.some(cell => cell.id === "call-61")).toBe(true);
    expect(segments.find(segment => segment.id === "search")?.count).toBe(100);
  });

  it("places each collaborator by stage and flows only for working members during a live run", () => {
    const model = emptyObservation();
    model.agents.set(ROOT_AGENT, { id: ROOT_AGENT, root: true, stage: "plan", state: "running", calls: 4 });
    model.agents.set("worker", { id: "worker", root: false, stage: "search", state: "running", calls: 30, label: "查找试验登记资料" });
    model.agents.set("idle", { id: "idle", root: false, stage: null, state: "idle", calls: 0 });
    const running = researchRingSpec(model, { live: true });
    expect(running.clusters).toEqual([
      { id: "worker", segment: "search", tone: "fact", mass: 120, label: "查找试验登记", live: true },
      { id: "idle", segment: null, tone: "hub", mass: 12, label: "协作成员", live: false },
    ]);
    expect(running.links).toEqual([
      { id: "link:worker", from: "worker", to: "centre", tone: "line-relates", strength: 0.5, flow: true },
      { id: "link:idle", from: "idle", to: "centre", tone: "line-relates", strength: 0.5, flow: false },
    ]);
    expect(running.centre).toEqual({ label: "主研究员", tone: "you" });
    expect(running.particlesPerCell).toBe(2);
    expect(running.live).toBe(true);

    const ended = researchRingSpec(model, { live: false });
    expect(ended.links.every(link => !link.flow)).toBe(true);
    expect(ended.live).toBe(false);
  });

  it("keeps one drawing key while only the reasoning streams, and a new one when an operation, a member or the run changes", () => {
    const model = emptyObservation();
    model.calls = [call(1, { state: "running" })];
    model.agents.set("m", { id: "m", root: false, stage: "search", state: "running", calls: 1, label: "检索" });
    const before = drawingKey(model, true);
    model.reasoning = "正在比较两篇综述的纳入标准";
    model.thought = model.reasoning;
    expect(drawingKey(model, true)).toBe(before);
    model.calls = [call(1, { state: "done", durationMs: 1_200 })];
    const ended = drawingKey(model, true);
    expect(ended).not.toBe(before);
    model.agents.set("m", { id: "m", root: false, stage: "read", state: "running", calls: 2, label: "检索" });
    expect(drawingKey(model, true)).not.toBe(ended);
    expect(drawingKey(model, false)).not.toBe(drawingKey(model, true));
    // The newest sixty a stage are chosen by sequence: a call that arrives again with a new one is a new picture.
    const placed = drawingKey(model, true);
    model.calls = [call(7, { id: "call-1", state: "done", durationMs: 1_200 })];
    expect(drawingKey(model, true)).not.toBe(placed);
  });
});
