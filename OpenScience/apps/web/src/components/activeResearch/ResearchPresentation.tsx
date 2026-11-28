import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Waves } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { Toolbar } from "@/components/ui/Toolbar";
import { ResultModalSurface, useResultModalFocus } from "@/components/workspace/WorkspaceResultActivity";
import { isTopFocusLayer } from "@/lib/focusTrap";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { HaloFluxConsole } from "./haloflux/HaloFluxConsole";
import type { HfScene } from "./haloflux/haloFluxScene";
import { useHaloFluxMusic } from "./haloflux/useHaloFluxMusic";

export type ObservationView = "flow" | "halo";
export interface ObservationPosition {
  view: ObservationView;
  expanded: boolean;
  member: string;
  callId: string | null;
}

const VIEWS = [
  { value: "flow" as const, label: "研究流程" },
  { value: "halo" as const, label: "研究光环" },
];

/**
 * The observatory's two views of one round. 「研究流程」 is for reading it: the stage ring, the operations and their detail.
 * 「研究光环」 is for watching it: HALOFLUX's lab console with every counter and panel fed by the round, and 「全屏观测」 is that
 * console as upstream draws it, filling the screen. The toolbar's motion switch and the music carry into full screen.
 */
export function ResearchPresentation({ view, setView, expanded, setExpanded, scene, children }: {
  view: ObservationView; setView: (view: ObservationView) => void;
  expanded: boolean; setExpanded: (expanded: boolean) => void;
  scene: HfScene; children: ReactNode;
}) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [motionWanted, setMotion] = useState(true);
  const motion = motionWanted && !reduced;
  const music = useHaloFluxMusic();
  const panelId = useId();
  const expand = useRef<HTMLButtonElement>(null);
  const { on: musicOn, toggle: toggleMusic } = music;
  // The music belongs to the console: leaving it stops the music.
  useEffect(() => { if (view !== "halo" && musicOn) toggleMusic(); }, [view, musicOn, toggleMusic]);

  const motionButton = view === "halo" && !reduced && <IconButton size="sm" icon={Waves} label="光环动效"
    active={motionWanted} aria-pressed={motionWanted} onClick={() => setMotion(enabled => !enabled)} />;
  const close = () => setExpanded(false);
  return <>
    <div className="obs-scene-toolbar" data-theme="dark">
      <Toolbar label="观测图形" views={{ label: "观测视图", items: VIEWS, value: view, panelId,
        onChange: value => setView(value === "halo" ? "halo" : "flow") }}
        actions={view === "halo" && <div className="obs-scene-actions">{motionButton}
          <button type="button" ref={expand} className="obs-expand" onClick={() => setExpanded(true)}><Maximize2 size={16} aria-hidden="true" />全屏观测</button>
        </div>} />
    </div>
    <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-tab-${view}`} data-theme="dark">
      {view === "flow" ? children : !expanded && <HaloFluxConsole scene={scene} mode="inline" motion={motion} music={music} />}
    </div>
    {expanded && view === "halo" && <FullScreen onClose={close} restoreFocus={() => expand.current?.focus({ preventScroll: true })}>
      {(titleId, exitRef) => <HaloFluxConsole scene={scene} mode="full" motion={motion} music={music} onExit={close} exitRef={exitRef} titleId={titleId} />}
    </FullScreen>}
  </>;
}

/** The app's modal focus layer handles Escape, Tab and workspace suspension; the console's title names the dialog. */
function FullScreen({ children, onClose, restoreFocus }: {
  children: (titleId: string, exitRef: RefObject<HTMLButtonElement | null>) => ReactNode; onClose: () => void; restoreFocus: () => void;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const exit = useRef<HTMLButtonElement>(null);
  const restore = useRef(restoreFocus);
  const modal = useResultModalFocus(panel, "dialog", () => exit.current, onClose);
  useEffect(() => { const focus = restore.current; return () => focus(); }, []);
  useEffect(() => {
    const element = panel.current;
    if (!element || modal.suspended) return;
    // A canvas retry can remove the focused control. Keep the shell from taking its next key.
    const observer = new MutationObserver(() => {
      if (document.activeElement === document.body && document.hasFocus() && isTopFocusLayer(element)) exit.current?.focus({ preventScroll: true });
    });
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "hidden"] });
    return () => observer.disconnect();
  }, [modal.suspended]);
  return createPortal(<ResultModalSurface scoped={modal.scoped} suspended={modal.suspended}>
    <div ref={panel} tabIndex={-1} onFocus={modal.onFocus} role="dialog" aria-modal="true" aria-labelledby={id} className="obs-focus" data-theme="dark">
      {children(id, exit)}
    </div>
  </ResultModalSurface>, document.body);
}
