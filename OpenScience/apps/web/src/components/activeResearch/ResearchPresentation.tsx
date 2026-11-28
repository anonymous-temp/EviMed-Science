import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FormDialog } from "@/components/ui/FormDialog";
import { Button } from "@/components/ui/Button";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { ROOT_AGENT, STAGES, type Observation, type ObservedCall } from "@/lib/researchObservation";
import { formatClock } from "@/lib/format";
import { HaloFluxCanvas } from "./HaloFluxCanvas";

interface Props {
  title: string;
  model?: Observation;
  ended?: boolean;
  active?: boolean;
  status?: string;
  renderDetail?: (call: ObservedCall, who: string) => ReactNode;
  renderFiles?: (close: () => void) => ReactNode;
}

export function ResearchPresentation({ title, model, ended, active, status, renderDetail, renderFiles, open, setOpen }: Props & {
  open: boolean; setOpen: (open: boolean) => void;
}) {
  return <>
    <button type="button" className="obs-file" data-text-action="view" onClick={() => setOpen(true)}>{model ? "研究光环演示" : "预览研究光环"}</button>
    {open && createPortal(<FormDialog title={title} onClose={() => setOpen(false)} className="fixed inset-0 !max-w-none !rounded-none">
      <PresentationBody model={model} ended={ended} active={active} status={status} renderDetail={renderDetail}
        files={renderFiles?.(() => setOpen(false))} />
    </FormDialog>, document.body)}
  </>;
}

function PresentationBody({ model, ended, active, status, renderDetail, files }: Omit<Props, "title" | "renderFiles"> & { files?: ReactNode }) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [paused, setPaused] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  // The fold inserts new calls at the front and updates results in place. Reverse that window
  // for playback, keeping concurrent calls in observed opening order even if they finish out of order.
  const calls = model ? [...model.calls].reverse() : [];
  const index = choice ? calls.findIndex(call => call.id === choice) : -1;
  const position = index >= 0 ? index : ended ? 0 : Math.max(0, calls.length - 1);
  const call = calls[position];
  const next = calls[position + 1]?.id;
  useEffect(() => {
    if (!playing) return;
    if (!next) { setPlaying(false); return; }
    let timer: number;
    function schedule() {
      window.clearTimeout(timer);
      if (!document.hidden) timer = window.setTimeout(() => setChoice(next ?? null), 1800);
    }
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [playing, next]);
  const phase = STAGES.find(stage => stage.key === call?.stage);
  const member = call?.agent === ROOT_AGENT ? "主研究员" : model?.agents.get(call?.agent ?? "")?.label || "协作成员";
  const replay = () => {
    if (playing) { setPlaying(false); return; }
    if (!next && calls[0]) setChoice(calls[0].id);
    setPlaying(true);
  };
  const moving = !reduced && !paused && (!model || (ended ? playing : !!active));
  return <div className="obs-halo-content mx-auto max-w-7xl space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2 text-ui text-text-2">
      <span>{model ? status : "效果预览 · 模拟纹理"}</span>
      {!reduced && <Button size="sm" variant="text" aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? "开启动效" : "关闭动效"}</Button>}
    </div>
    <HaloFluxCanvas preview={!model} moving={moving} signal={call ? call.id + ":" + call.seq : ""} label={phase?.code || (model ? "ACTIVITY" : "HALOFLUX")} caption={model ? call?.label : "光环预览"} />
    {model && <>
      {call ? <>
        <div className="flex flex-wrap items-center gap-3 text-ui text-text-2">
          {ended && calls.length > 1 && <Button size="sm" onClick={replay}>{playing ? "暂停回放" : "回放操作"}</Button>}
          <label className="flex min-w-0 flex-1 items-center gap-2">最近操作
            <select className="min-w-0 flex-1 rounded border border-control bg-surface p-1 text-text" value={call.id}
              onChange={event => { setPlaying(false); setChoice(event.target.value); }}>
              {calls.map((item, i) => <option key={item.id} value={item.id}>{i + 1} · {formatClock(item.at)} · {item.label}</option>)}
            </select>
          </label>
          {!ended && choice && <Button size="sm" variant="text" onClick={() => setChoice(null)}>跟随最新</Button>}
        </div>
        <p className="text-caption text-text-2">{[phase?.label, member, formatClock(call.at)].filter(Boolean).join(" · ")}</p>
        {renderDetail?.(call, member)}
      </> : <p className="text-ui text-text-2">{ended ? "本轮没有可回放的操作记录" : "等待研究操作"}</p>}
      {files}
    </>}
  </div>;
}
