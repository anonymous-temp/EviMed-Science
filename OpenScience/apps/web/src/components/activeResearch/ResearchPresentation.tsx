import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Activity, ArrowLeft, ChevronLeft, ChevronRight, Maximize2, Pause, Play, Radio, Waves } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { Toolbar } from "@/components/ui/Toolbar";
import { ResultModalSurface, useResultModalFocus } from "@/components/workspace/WorkspaceResultActivity";
import { isTopFocusLayer } from "@/lib/focusTrap";
import { formatClock } from "@/lib/format";
import { STAGES, type ObservedCall } from "@/lib/researchObservation";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { HaloFluxCanvas } from "./HaloFluxCanvas";

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

interface RunSelection {
  /** Newest first, within the member filter also used by the operations feed. */
  calls: ObservedCall[];
  call: ObservedCall | null;
  pinned: boolean;
  select: (id: string | null) => void;
  member: string;
  ended: boolean;
  live: boolean;
  active: boolean;
  status: string;
  inspector: ReactNode;
  files: ReactNode;
}

/** The reader chooses one graphic. Inline and expanded views share the observatory's selected operation. */
export function ResearchPresentation({ title, view, setView, expanded, setExpanded, run, children }: {
  title: string; view: ObservationView; setView: (view: ObservationView) => void;
  expanded: boolean; setExpanded: (expanded: boolean) => void;
  run?: RunSelection; children: ReactNode;
}) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [motion, setMotion] = useState(true);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const panelId = useId();
  const expand = useRef<HTMLButtonElement>(null);
  const call = run?.call;
  const calls = run?.calls;
  const count = calls?.length ?? 0;
  const index = call && calls ? calls.indexOf(call) : -1;
  const position = count - index;
  const nextId = calls?.[index - 1]?.id;
  const playing = view === "halo" && !!run?.ended && !!call && playingId === call.id;
  const select = run?.select;

  useEffect(() => {
    if (!playingId) return;
    if (!playing || !nextId || !select) { setPlayingId(null); return; }
    let timer: number;
    const advance = () => { select(nextId); setPlayingId(nextId); };
    const schedule = () => {
      window.clearTimeout(timer);
      if (!document.hidden) timer = window.setTimeout(advance, 2400);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [playingId, playing, nextId, select]);

  const seek = (id: string | null) => { setPlayingId(null); select?.(id); };
  const replay = () => {
    if (playing) { setPlayingId(null); return; }
    const start = index === 0 ? calls?.[count - 1] : call;
    if (start) { select?.(start.id); setPlayingId(start.id); }
  };
  const phase = STAGES.find(stage => stage.key === call?.stage);
  const moving = motion && !reduced && (!run || playing || (run.active && !run.pinned && !!call));
  const motionButton = view === "halo" && !reduced && <IconButton size="sm" icon={Waves} label="光环动效"
    active={motion} aria-pressed={motion} onClick={() => setMotion(enabled => !enabled)} />;
  const graphic = <div className="obs-halo-instrument">
    <HaloFluxCanvas preview={!run} moving={moving} signal={call ? call.id + ":" + call.seq : ""}
      label={phase?.code || (run ? "ACTIVITY" : "HALOFLUX")} caption={call?.label || (run ? undefined : "光环预览")} />
    {call && run && calls ? <div className="obs-transport">
      <div className="obs-transport-heading">
        <strong>{call.detail || call.label}</strong>
        <span>{[phase?.label, run.member, formatClock(call.at)].filter(Boolean).join(" · ")}</span>
        {run.live && <button type="button" className="obs-follow" aria-pressed={!run.pinned}
          onClick={() => seek(run.pinned ? null : call.id)}><Radio size={16} aria-hidden="true" />跟随最新</button>}
      </div>
      <div className="obs-transport-controls">
        {run.ended && count > 1 && <button type="button" className="obs-play" onClick={replay}>
          {playing ? <Pause size={16} /> : <Play size={16} />}{playing ? "暂停回放" : "回放操作"}
        </button>}
        <IconButton size="sm" icon={ChevronLeft} label="上一个操作" disabled={position <= 1} onClick={() => seek(calls[index + 1].id)} />
        <input type="range" aria-label="浏览操作" aria-valuetext={`第 ${position} 项，共 ${count} 项，${call.label}`}
          min={1} max={count} value={position} disabled={count === 1} onChange={e => seek(calls[count - e.currentTarget.valueAsNumber].id)} />
        <IconButton size="sm" icon={ChevronRight} label="下一个操作" disabled={!nextId} onClick={() => { if (nextId) seek(nextId); }} />
        <span className="obs-position">{position} / {count}</span>
      </div>
    </div> : <p className="obs-scene-empty">{run ? (run.ended ? "本轮没有可回放的操作记录" : "等待研究操作") : "示例动画"}</p>}
  </div>;
  const close = () => setExpanded(false);
  return <>
    <div className="obs-scene-toolbar" data-theme="dark" hidden={expanded}>
      <Toolbar label="观测图形" views={{ label: "观测视图", items: VIEWS, value: view, panelId,
        onChange: value => setView(value === "halo" ? "halo" : "flow") }}
        actions={view === "halo" && <div className="obs-scene-actions">{motionButton}
          <button type="button" ref={expand} className="obs-expand" onClick={() => setExpanded(true)}><Maximize2 size={16} aria-hidden="true" />全屏观测</button>
        </div>} />
    </div>
    {!expanded && <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-tab-${view}`} data-theme="dark">{view === "flow" ? children : graphic}</div>}
    {expanded && <FocusView title={title} status={run?.status} active={run?.active} onClose={close} restoreFocus={() => expand.current?.focus({ preventScroll: true })} actions={motionButton}>
      <div className={run ? "obs-focus-layout" : "obs-focus-preview"}>
        {graphic}
        {run && <aside className="obs-focus-inspect">
          {count > 0 && <label className="obs-jump">操作记录
            <select value={call?.id ?? ""} onChange={e => seek(e.target.value)}>
              {calls?.map((item, i) => <option key={item.id} value={item.id}>{count - i} · {formatClock(item.at)} · {item.label}{item.detail ? ` · ${item.detail}` : ""}</option>)}
            </select>
          </label>}
          {run.inspector}
          {run.files}
        </aside>}
      </div>
    </FocusView>}
  </>;
}

/** The app's modal focus layer handles Escape, Tab and workspace suspension. */
function FocusView({ title, status, active, actions, children, onClose, restoreFocus }: {
  title: string; status?: string; active?: boolean; actions: ReactNode; children: ReactNode; onClose: () => void; restoreFocus: () => void;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const restore = useRef(restoreFocus);
  const modal = useResultModalFocus(panel, "dialog", () => back.current, onClose);
  useEffect(() => { const focus = restore.current; return () => focus(); }, []);
  useEffect(() => {
    const element = panel.current;
    if (!element || modal.suspended) return;
    // A completed round or a canvas retry can remove the focused control. Keep the shell from taking its next key.
    const observer = new MutationObserver(() => {
      if (document.activeElement === document.body && document.hasFocus() && isTopFocusLayer(element)) {
        back.current?.focus({ preventScroll: true });
      }
    });
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "hidden"] });
    return () => observer.disconnect();
  }, [modal.suspended]);
  return createPortal(<ResultModalSurface scoped={modal.scoped} suspended={modal.suspended}>
    <div ref={panel} tabIndex={-1} onFocus={modal.onFocus} role="dialog" aria-modal="true" aria-labelledby={id}
      className="obs-focus" data-theme="dark">
      <header className="obs-focus-bar">
        <button ref={back} type="button" className="obs-back" onClick={onClose}><ArrowLeft size={16} aria-hidden="true" />返回观测舱</button>
        {actions}
      </header>
      <div className="obs-focus-page">
        <div className="obs-focus-heading"><h2 id={id}>{title}</h2>
          {status && <span role="status" className="obs-focus-status" data-active={active}><Activity size={16} aria-hidden="true" />{status}</span>}
        </div>
        {children}
      </div>
    </div>
  </ResultModalSurface>, document.body);
}
