import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { RingDescribe } from "@/components/charts/ring/RingCanvas";
import type { RingFrame, RingView } from "@/components/charts/ring/ringScene";
import { useRingAllowed } from "@/components/charts/ring/ringSupport";
import { StarBoundary } from "./StarBoundary";
import { memoryRingSpec } from "./memoryRing";
import { packSky } from "./starModel";

const RingCanvas = lazy(() => import("@/components/charts/ring/RingCanvas"));
const NOTHING: ReadonlySet<string> = new Set();
const SHOWN_FROM = 3;
const FRAME: RingFrame = { left: 0, right: 0, top: 8, bottom: 8 };
const VIEW: RingView = { shown: null, hits: NOTHING, selected: null };

/**
 * The cover of a shared pack: what the sender is handing over, as a small ring over the entries the page lists — a cell an entry in its kind's
 * segment, the sender at the centre. It is there to be looked at and adds nothing to read, so whoever cannot draw it (`useRingAllowed`), a pack of
 * a mark or two, and a picture that lost its context lose nothing: the 工作方式卡 and the list stay. A cell is named when pointed at and opens
 * nothing, because the entry is under it in the list.
 */
export function StarCover({ entries, sender }: { entries: ReadonlyArray<{ id: string; factKind: string; text: string }>; sender: string | null }) {
  const allowed = useRingAllowed();
  const [lost, setLost] = useState(false);
  const [moving, setMoving] = useState(true);
  const sky = useMemo(() => packSky(entries, sender), [entries, sender]);
  const [now] = useState(() => Date.now());
  const spec = useMemo(() => memoryRingSpec(sky.nodes, sky.edges, { by: "kind", now }), [sky, now]);
  const describe = useCallback<RingDescribe>((hit) => {
    if (hit.kind === "cell") {
      const node = sky.nodes.find((item) => item.id === hit.id);
      return node ? { title: node.label, facts: [] } : null;
    }
    if (hit.kind === "segment") {
      const segment = spec.segments.find((item) => item.id === hit.id);
      return segment ? { title: segment.label, facts: [] } : null;
    }
    return hit.kind === "centre" ? { title: spec.centre.label, facts: [] } : null;
  }, [sky, spec]);
  if (!allowed || lost || entries.length < SHOWN_FROM) return null;
  return (
    <section data-theme="dark" data-chart="stars" className="relative isolate h-64 overflow-hidden rounded-card border border-border bg-star-ground text-text">
      <StarBoundary onFailed={() => setLost(true)}>
        <Suspense fallback={null}>
          <RingCanvas
            handle={null} spec={spec} view={VIEW} moving={moving} frame={FRAME}
            label={`${sender ?? "对方"}交给你的 ${entries.length} 条内容，排成一圈星环；同样的内容在下面的列表里。`} describe={describe} onOpen={() => undefined} onLost={() => setLost(true)}
          />
        </Suspense>
      </StarBoundary>
      <div className="absolute right-2 top-2 rounded-card border border-faint bg-star-panel p-1 backdrop-blur-md">
        <Button size="sm" variant="text" data-text-action="view" aria-pressed={!moving} onClick={() => setMoving((value) => !value)}>
          {moving ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}{moving ? "暂停流动" : "继续流动"}
        </Button>
      </div>
    </section>
  );
}
