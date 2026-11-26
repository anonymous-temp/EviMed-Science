import { workStateLabel } from "@evimed/domain";
import type { RingCell, RingSpec } from "@/components/charts/ring/ringModel";
import { STAGES, stageCounts, type ObservedAgent, type ObservedCall, type Observation, type StageKey } from "@/lib/researchObservation";

const STAGE_TONE: Record<StageKey, string> = {
  plan: "about", search: "fact", read: "document", analyze: "decision", verify: "method", write: "preference", deliver: "you",
};
const CELL_LIMIT = 60;
const CALL_STATE: Record<ObservedCall["state"], RingCell["state"]> = { running: "running", error: "error", done: "current" };
const CALL_BRIGHT: Record<ObservedCall["state"], number> = { running: 1, error: 0.9, done: 0.75 };

/** 「待命」 names the wait for a member's next call. */
export const AGENT_WORD: Record<ObservedAgent["state"], string> = {
  running: workStateLabel("running"), idle: "待命", done: workStateLabel("done"), failed: workStateLabel("failed"), canceled: workStateLabel("stopped"), unknown: "待命",
};

export function callStateWord(state: ObservedCall["state"]): string {
  return workStateLabel(state === "error" ? "failed" : state);
}

const callTime = (call: ObservedCall) => {
  const at = Date.parse(call.at);
  return Number.isFinite(at) ? at : null;
};

/**
 * What the ring draws of an observation, as one string: the stage counts, each drawn operation's state, stage and duration, each member's
 * stage, state, count and name, and whether the run is live. The observation is folded in place and bumps its version on every frame —
 * the reasoning streams several a second — and a scene rebuilt for each would clear its sparks before they land, so the ring is rebuilt
 * only when this changes.
 */
export function drawingKey(model: Observation, live: boolean): string {
  const counts = stageCounts(model);
  return [
    live ? "live" : "still",
    STAGES.map(({ key }) => counts[key]).join(","),
    model.calls.filter(call => call.stage).map(call => `${call.id}:${call.seq}:${call.state}:${call.stage}:${call.durationMs ?? ""}`).join(","),
    [...model.agents.values()].filter(agent => !agent.root).map(agent => `${agent.id}:${agent.stage ?? ""}:${agent.state}:${agent.calls}:${agent.label ?? ""}`).join(","),
  ].join("|");
}

/** Draw recent operations as cells and keep the counts from the whole run. */
export function researchRingSpec(model: Observation, { live }: { live: boolean }): RingSpec {
  const counts = stageCounts(model);
  const members = [...model.agents.values()].filter(agent => !agent.root);
  return {
    segments: STAGES.map(({ key, label, code }) => ({ id: key, label, code, count: counts[key], tone: STAGE_TONE[key] })),
    cells: STAGES.flatMap(({ key }) => model.calls
      .filter(call => call.stage === key)
      .sort((left, right) => right.seq - left.seq || (callTime(right) ?? -Infinity) - (callTime(left) ?? -Infinity))
      .slice(0, CELL_LIMIT)
      .map(call => ({
        id: call.id, segment: key, order: call.seq, at: callTime(call),
        length: call.durationMs === undefined || !Number.isFinite(call.durationMs) || call.durationMs < 0
          ? 0.6 : 0.25 + 0.75 * Math.min(1, Math.log10(1 + call.durationMs / 1000) / 2),
        state: CALL_STATE[call.state], bright: CALL_BRIGHT[call.state], tone: STAGE_TONE[key], spark: call.state === "running",
      }))),
    clusters: members.map(agent => ({
      id: agent.id, segment: agent.stage, tone: agent.stage ? STAGE_TONE[agent.stage] : "hub",
      mass: Math.min(120, 12 + 4 * agent.calls), label: Array.from(agent.label || "协作成员").slice(0, 6).join(""),
      live: agent.state === "running",
    })),
    links: members.map(agent => ({
      id: `link:${agent.id}`, from: agent.id, to: "centre", tone: "line-relates", strength: 0.5, flow: live && agent.state === "running",
    })),
    particlesPerCell: 2,
    centre: { label: "主研究员", tone: "you" },
    live,
  };
}
