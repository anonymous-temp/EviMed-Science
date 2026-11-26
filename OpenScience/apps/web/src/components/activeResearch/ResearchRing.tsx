import { Component, lazy, Suspense, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { RingDescribe, RingHandle } from "@/components/charts/ring/RingCanvas";
import type { RingFrame, RingView } from "@/components/charts/ring/ringScene";
import { formatDuration } from "@/lib/format";
import { ROOT_AGENT, rootStage, STAGES, type Observation, type StageKey } from "@/lib/researchObservation";
import { AGENT_WORD, callStateWord, drawingKey, researchRingSpec } from "./researchRing";

const RingCanvas = lazy(() => import("@/components/charts/ring/RingCanvas"));
const FRAME: RingFrame = { left: 24, right: 24, top: 16, bottom: 16 };
const VIEW: RingView = { shown: null, hits: new Set(), selected: null };

class ResearchRingBoundary extends Component<{ onLost: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onLost(); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Mount with the canvas so the first comparison has a handle and never pulses the initial cells. */
function OperationPulses({ ring, operations, live }: { ring: RefObject<RingHandle | null>; operations: ReadonlyMap<string, string | null>; live: boolean }) {
  const before = useRef<ReadonlyMap<string, string | null>>(null);
  useEffect(() => {
    const previous = before.current;
    before.current = operations;
    if (!live || !previous) return;
    for (const [id, from] of operations) {
      if (from !== null && !previous.has(id)) ring.current?.pulse(id, from);
    }
  }, [ring, operations, live]);
  return null;
}

/**
 * Anatomy: seven stage arcs, operations on the rim, and collaborators around the lead researcher.
 * Variants: live, ended, or standby.
 * States: visible work follows the stream, and loss of the renderer returns the observatory to the line.
 * Hit area: cells open operation details, and clusters filter operations by member.
 * Keyboard: the image has a summary and the feed has buttons for operations and member filters.
 * Long content: cluster labels show up to six characters, with the full name in the tooltip.
 * Theme: fixed dark observatory, with the shared star colours.
 * Responsive: the observatory uses the line on narrow screens or when reduced motion is requested.
 * Verification: ResearchObservatory.test.tsx and researchRing.test.ts.
 */
export function ResearchRing({ model, live, counts, onSelectCall, onSelectMember, onLost }: {
  model: Observation;
  live: boolean;
  counts: Record<StageKey, number>;
  onSelectCall?: (id: string) => void;
  onSelectMember?: (id: string) => void;
  onLost: () => void;
}) {
  const ring = useRef<RingHandle>(null);
  const { spec, operations } = useMemo(() => {
    const spec = researchRingSpec(model, { live });
    const drawn = new Set(spec.cells.map(cell => cell.id));
    const members = new Set(spec.clusters.map(cluster => cluster.id));
    const operations = new Map<string, string | null>();
    for (const call of model.calls) {
      const from = members.has(call.agent) ? call.agent : "centre";
      operations.set(call.id, call.state === "running" && drawn.has(call.id) ? from : null);
    }
    return { spec, operations };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the observation is folded in place and changes on every frame; the drawing key says when the picture does (`drawingKey`).
  }, [drawingKey(model, live)]);

  const current = STAGES.find(stage => stage.key === rootStage(model));
  const summary = [
    current && live ? `正在${current.label}` : null,
    ...STAGES.filter(stage => counts[stage.key] > 0).map(stage => `${stage.label} ${counts[stage.key]} 次`),
    spec.clusters.length ? `协作成员 ${spec.clusters.length} 位` : null,
  ].filter(Boolean).join("，");
  const label = `研究流程：${summary || "等待第一个操作"}`;

  const describe: RingDescribe = hit => {
    switch (hit.kind) {
      case "cell": {
        const call = model.calls.find(item => item.id === hit.id);
        if (!call) return null;
        const stage = STAGES.find(item => item.key === call.stage)?.label ?? "操作";
        const member = call.agent === ROOT_AGENT ? "主研究员" : model.agents.get(call.agent)?.label || "协作成员";
        return { title: call.label, facts: [stage, member, callStateWord(call.state), formatDuration(call.durationMs) || "—"] };
      }
      case "cluster": {
        const member = model.agents.get(hit.id);
        return member ? { title: member.label || "协作成员", facts: [AGENT_WORD[member.state], `${member.calls} 次操作`] } : null;
      }
      case "segment": {
        const stage = STAGES.find(item => item.key === hit.id);
        return stage ? { title: stage.label, facts: [counts[stage.key] ? `${counts[stage.key]} 次` : "—"] } : null;
      }
      case "centre":
        return { title: "主研究员", facts: current ? [live ? `正在${current.label}` : current.label] : [] };
    }
  };

  return <div className="obs-ringbox" data-theme="dark">
    <ResearchRingBoundary onLost={onLost}>
      <Suspense fallback={<div role="img" aria-label={label} />}>
        <RingCanvas
          handle={ring} spec={spec} view={VIEW} moving={live} frame={FRAME} label={label} describe={describe} onLost={onLost}
          onOpen={hit => {
            if (hit.kind === "cell") onSelectCall?.(hit.id);
            if (hit.kind === "cluster") onSelectMember?.(hit.id);
          }}
        />
        <OperationPulses ring={ring} operations={operations} live={live} />
      </Suspense>
    </ResearchRingBoundary>
  </div>;
}
