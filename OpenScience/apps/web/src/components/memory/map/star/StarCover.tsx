import { lazy, Suspense, useMemo, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { StarBoundary } from "./StarBoundary";
import type { StarFamily } from "./starModel";
import { packSky } from "./starModel";
import { useStarAllowed } from "./starSupport";

const StarCanvas = lazy(() => import("./StarCanvas"));
const NOTHING: ReadonlySet<string> = new Set();
const NO_FAMILY: ReadonlySet<StarFamily> = new Set();
const SHOWN_FROM = 3;

/**
 * The cover of a shared pack: what the sender is handing over, as a small sky over the entries the page lists. It is there to be looked at and adds nothing to read, so whoever cannot
 * draw it (`useStarAllowed`), a pack of a mark or two, and a picture that lost its context lose nothing: the 工作方式卡 and the list stay. A mark is named when pointed at and opens
 * nothing, because the entry is under it in the list.
 */
export function StarCover({ entries, sender }: { entries: ReadonlyArray<{ id: string; factKind: string; text: string }>; sender: string | null }) {
  const allowed = useStarAllowed();
  const [lost, setLost] = useState(false);
  const [rotating, setRotating] = useState(true);
  const sky = useMemo(() => packSky(entries, sender), [entries, sender]);
  const shown = useMemo(() => new Set(sky.nodes.map((node) => node.id)), [sky]);
  const [now] = useState(() => Date.now());
  if (!allowed || lost || entries.length < SHOWN_FROM) return null;
  return (
    <section data-theme="dark" data-chart="stars" className="relative isolate h-64 overflow-hidden rounded-card border border-border bg-star-ground text-text">
      <StarBoundary onFailed={() => setLost(true)}>
        <Suspense fallback={null}>
          <StarCanvas
            handle={null} nodes={sky.nodes} edges={sky.edges} now={now} shown={shown} hits={NOTHING} selected={null} hiddenFamilies={NO_FAMILY} rotating={rotating}
            label={`${sender ?? "对方"}交给你的 ${entries.length} 条内容，排成一片星空；同样的内容在下面的列表里。`} onOpen={() => undefined} onLost={() => setLost(true)}
          />
        </Suspense>
      </StarBoundary>
      <div className="absolute right-2 top-2 rounded-card border border-faint bg-star-panel p-1 backdrop-blur-md">
        <Button size="sm" variant="text" aria-pressed={rotating} onClick={() => setRotating((value) => !value)}>
          {rotating ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}{rotating ? "暂停转动" : "缓慢转动"}
        </Button>
      </div>
    </section>
  );
}
