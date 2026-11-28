import { useEffect, useRef, useState, type Ref } from "react";
import { Minimize2 } from "lucide-react";
import type { createHaloFlux } from "@/vendor/haloflux/stage.js";
import { createPanels } from "./haloFluxPanels";
import type { HfCodeLine, HfScene } from "./haloFluxScene";
import type { HaloFluxMusic } from "./useHaloFluxMusic";
import "./haloflux.css";

type Stage = ReturnType<typeof createHaloFlux>;
type Panels = ReturnType<typeof createPanels>;

/** HALOFLUX's callout turns every 3.6 s, fading for 0.4 s (lab.html CHECKS). */
const CALLOUT_TURN_MS = 3600, CALLOUT_FADE_MS = 400;
/** The workspace types two characters every 70 ms and holds a finished line for six more (lab.html codeTick). */
const TYPE_MS = 70;
/**
 * HALOFLUX assumes a graphics card. Where frames come slower than this (a blocklisted GPU, a virtual machine, a remote desktop), the
 * console steps down — first to one pixel per CSS pixel at 24 frames a second, then to a still redrawn on each change and every few
 * seconds while the round runs — so the page around it keeps answering.
 */
const SLOW_FRAME_MS = 70, VERY_SLOW_FRAME_MS = 250, SAMPLE_FRAMES = 8, SAMPLE_MS = 1500, REDUCED_FPS = 24, STILL_HEARTBEAT_MS = 2500;

/**
 * Anatomy: HALOFLUX's lab console. Full screen: the header (title, six counters), the stage (the light ring, the callout, the status
 * line, music and exit) and eight instrument panels. In the page: the stage and the panels, under the observatory's own counters.
 * States: preview (no research), live (the author's tempo), waiting and ended (the wallpaper edition's calm tempo); a rendering
 * failure keeps every panel and offers a retry.
 * Motion: off under reduced motion or the toolbar's switch — the ring and panels are drawn once per change, nothing types or fades.
 * Responsive: four panels a row, two under 1000 px, a swipe row under 620 px; a portrait phone full screen draws the ring turned.
 * Verification: ResearchObservatory.test.tsx, haloFluxScene.test.ts.
 */
export function HaloFluxConsole({ scene, mode, motion, music, onExit, exitRef, titleId }: {
  scene: HfScene; mode: "inline" | "full"; motion: boolean; music: HaloFluxMusic;
  onExit?: () => void; exitRef?: Ref<HTMLButtonElement>; titleId?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const stageCanvas = useRef<HTMLCanvasElement>(null);
  const callout = useRef<HTMLDivElement>(null);
  const adv = useRef<HTMLCanvasElement>(null), diff = useRef<HTMLCanvasElement>(null), val = useRef<HTMLCanvasElement>(null), idx = useRef<HTMLCanvasElement>(null);
  const engine = useRef<{ stage: Stage; panels: Panels; redraw: () => void } | null>(null);
  const latest = useRef(scene); latest.current = scene;
  const moving = useRef(motion); moving.current = motion;
  const [failed, setFailed] = useState(false);
  const applied = useRef<HfScene | null>(null);

  // One loop for the stage and the four panels, paused when the console is off screen or the tab is hidden.
  useEffect(() => {
    const element = root.current, canvas = stageCanvas.current;
    if (failed || !element || !canvas || !adv.current || !diff.current || !val.current || !idx.current) return;
    const canvases = { adv: adv.current, diff: diff.current, val: val.current, idx: idx.current };
    let closed = false, visible = true, pending = 0, last = 0, sized = false, resizeTimer = 0, heartbeat = 0;
    let quality = 0, drawn = 0, lastStill = 0, stillTimer = 0, sampleFrom = 0;
    const intervals: number[] = [];
    const lite = window.matchMedia?.("(pointer: coarse)").matches || window.innerWidth < 760;
    const fail = () => { if (closed) return; closed = true; cancelAnimationFrame(pending); setFailed(true); };
    const size = () => {
      const current = engine.current;
      if (!current || canvas.clientWidth < 20 || canvas.clientHeight < 20) return false;
      const dpr = quality > 0 ? 1 : Math.min(window.devicePixelRatio || 1, lite ? 1.75 : 2);
      current.stage.resize(dpr); current.panels.resize(dpr); sized = true;
      return true;
    };
    const frame = (now: number) => {
      pending = 0;
      const current = engine.current;
      if (closed || !current || !sized || document.hidden || !visible || !moving.current || quality > 1) { last = 0; return; }
      if (quality === 1 && now - drawn < 1000 / REDUCED_FPS) { pending = requestAnimationFrame(frame); return; }
      try {
        if (last) {
          if (!intervals.length) sampleFrom = now;
          intervals.push(now - last);
          if (intervals.length >= SAMPLE_FRAMES || (intervals.length >= 3 && now - sampleFrom > SAMPLE_MS)) {
            const median = [...intervals].sort((a, b) => a - b)[intervals.length >> 1];
            intervals.length = 0;
            const next = median > VERY_SLOW_FRAME_MS ? 2 : median > (quality ? 1000 / REDUCED_FPS + SLOW_FRAME_MS : SLOW_FRAME_MS) ? quality + 1 : quality;
            if (next !== quality) {
              quality = next;
              if (quality === 1) size();
              if (quality > 1) { last = 0; still(); return; }
            }
          }
        }
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
        last = now; drawn = now;
        current.stage.draw(dt); current.panels.draw(dt);
      } catch { fail(); return; }
      pending = requestAnimationFrame(frame);
    };
    /** Motion off, or a machine too slow for it: a populated still, redrawn when the round changes. */
    const still = () => {
      const current = engine.current;
      if (closed || !current || !sized || document.hidden || !visible) return;
      // At most one still a second: a running round changes every second.
      const wait = lastStill + 1000 - performance.now();
      if (wait > 0) { if (!stillTimer) stillTimer = window.setTimeout(() => { stillTimer = 0; still(); }, wait); return; }
      window.clearTimeout(heartbeat); heartbeat = 0;
      try { const step = moving.current ? 0.25 : 0; current.stage.draw(step); current.panels.draw(step); } catch { fail(); return; }
      lastStill = performance.now();
      if (moving.current && latest.current.live) heartbeat = window.setTimeout(() => { heartbeat = 0; if (visible && !document.hidden) still(); }, STILL_HEARTBEAT_MS);
    };
    const schedule = () => {
      if (quality > 1 || !moving.current) { still(); return; }
      if (!pending && !closed && moving.current && visible && !document.hidden && sized) pending = requestAnimationFrame(frame);
    };
    const redraw = () => { if (moving.current && quality < 2) schedule(); else still(); };
    const resize = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => { try { if (size()) redraw(); } catch { fail(); } }, sized ? 120 : 0);
    });
    const viewport = typeof IntersectionObserver === "function" ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; schedule(); }) : null;
    document.addEventListener("visibilitychange", schedule);
    canvas.addEventListener("contextlost", fail);
    void import("@/vendor/haloflux/stage.js").then(({ createHaloFlux }) => {
      if (closed) return;
      try {
        const stage = createHaloFlux(canvas, { lite, callout: callout.current });
        const panels = createPanels(canvases);
        engine.current = { stage, panels, redraw };
        apply(engine.current, latest.current, null);
        applied.current = latest.current;
        if (size()) {
          // Warm the scene up so a still is never an empty ring.
          if (!moving.current) for (let i = 0; i < 8; i++) { stage.draw(0.15); panels.draw(0.15); }
          redraw();
        }
        resize.observe(element); viewport?.observe(element);
      } catch { fail(); }
    }).catch(fail);
    return () => {
      closed = true; cancelAnimationFrame(pending); window.clearTimeout(resizeTimer); window.clearTimeout(heartbeat); window.clearTimeout(stillTimer); engine.current = null;
      resize.disconnect(); viewport?.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      canvas.removeEventListener("contextlost", fail);
    };
  }, [failed]);

  // The round's changes reach the stage: its tempo, its ring words, its panels, and a beat for each operation.
  useEffect(() => {
    const current = engine.current;
    if (!current) return;
    // The clock moves the scene every second; a still is redrawn only when an operation starts or settles, or the tempo changes.
    const changed = drawnKey(scene) !== drawnKey(applied.current);
    try { apply(current, scene, applied.current); applied.current = scene; if (changed) current.redraw(); } catch { setFailed(true); }
  }, [scene]);
  useEffect(() => { engine.current?.redraw(); }, [motion]);

  const callouts = scene.callouts;
  const turn = useCalloutTurn(callouts.map(item => item.id).join("|"), callouts.length, motion);
  const shown = callouts[turn.index % Math.max(1, callouts.length)];
  const typedLast = useTyping(scene.code.at(-1), motion);

  return <div ref={root} className="hf" data-mode={mode} data-theme="dark" role="group" aria-label="研究光环">
    {mode === "full" && <header className="hf-head">
      <div className="hf-brand"><h1 id={titleId}>{scene.title}</h1><p>{scene.subtitle}</p></div>
      {scene.kpis.map(kpi => <div key={kpi.key} className="hf-kpi">
        <div className="k">{kpi.label}</div>
        <div className={kpi.accent ? "v pink" : "v"}>{kpi.value}{kpi.sub && <small>{kpi.sub}</small>}</div>
        <div className="seg" aria-hidden="true"><i style={{ width: `${Math.round((kpi.ratio ?? 0) * 100)}%` }} /></div>
      </div>)}
    </header>}
    <div className="hf-stage">
      {failed ? <div className="hf-fallback"><p role="status">研究光环暂时无法显示</p>
        <button type="button" className="hf-btn" onClick={() => setFailed(false)}>重新加载光环</button></div>
        : <canvas ref={stageCanvas} aria-hidden="true" />}
      <div ref={callout} className="hf-ov hf-chk" hidden={!shown || failed} data-fade={turn.fading} aria-hidden="true">
        {shown && <><b>{shown.kicker}</b><span>{shown.value}</span></>}
      </div>
      <div className="hf-ov hf-top">
        <div className="hf-music" data-on={music.on}>
          <button type="button" className="hf-btn" aria-pressed={music.on} onClick={music.toggle}>
            <i className="eq" aria-hidden="true"><b /><b /><b /></i>{music.unavailable ? "音乐暂不可用" : music.on ? "BGM ON" : "BGM OFF"}
          </button>
          {music.on && <input type="range" min={0} max={100} step={1} value={music.volume} aria-label="音乐音量" onChange={e => music.setVolume(e.currentTarget.valueAsNumber)} />}
        </div>
        {onExit && <button type="button" ref={exitRef} className="hf-btn" onClick={onExit}><Minimize2 size={16} aria-hidden="true" />退出全屏</button>}
      </div>
      <div className="hf-ov hf-status"><div className="big">{scene.status.big}</div><div className="sm">{scene.status.small}</div></div>
    </div>
    <section className="hf-panels" aria-label="研究仪表">
      <div className="hf-p"><h3>研究动态 / INVESTIGATION FEED</h3>
        {scene.feed.length ? <ol className="hf-feed" aria-label="研究动态">{scene.feed.map(line => <li key={line.id} data-failed={line.failed}>
          <span className="hf-n">{line.n}</span><span className={`hf-vb ${line.tone}`}>{line.verb}</span>{line.text}
        </li>)}</ol> : <p className="hf-quiet">{scene.preview ? "研究开始后，每一步操作会出现在这里" : "等待第一个研究操作"}</p>}
      </div>
      <div className="hf-p"><h3>模型推理 / REASONING</h3><canvas ref={adv} aria-hidden="true" />
        <div className="hf-btns" aria-label={scene.captions.reasoning} role="img">
          <span data-on={scene.reasoning.mode === "think"}>推理</span><span data-on={scene.reasoning.mode === "call"}>操作</span><span data-on={scene.reasoning.mode === "idle"}>空闲</span>
        </div>
        <div className="cap">{scene.reasoning.thought || scene.captions.reasoning}</div>
      </div>
      <div className="hf-p"><h3>操作工作区 / WORKSPACE</h3>
        {scene.code.length ? <div className="hf-code">{scene.code.map((line, i) => <div key={line.id}>
          <span className="ln">{line.n}</span><CodeText line={line} typed={i === scene.code.length - 1 ? typedLast : null} />
        </div>)}</div> : <p className="hf-quiet">{scene.preview ? "每一步的输入与结果会在这里写出" : "等待第一个研究操作"}</p>}
      </div>
      <div className="hf-p"><h3>操作与结果 / RESULTS</h3><canvas ref={diff} aria-hidden="true" /><div className="cap">{scene.captions.results}</div></div>
      <div className="hf-p"><h3>研究任务 / TASKS</h3>
        {scene.routes.rows.length ? <div className="hf-routes" aria-label="研究任务">
          {scene.routes.head.map(head => <span key={head} className="h" aria-hidden="true">{head}</span>)}
          {scene.routes.rows.map(row => <div key={row.id} style={{ display: "contents" }}>
            <span className="nm">{row.name}<span className="sr-only">：{routeWord(row.cells, scene.routes.head)}</span></span>
            {row.cells.map((cell, i) => <span key={i} aria-hidden="true"><span className={`hf-chip ${cell}`}>{scene.routes.head[i + 1]}</span></span>)}
          </div>)}
        </div> : <p className="hf-quiet">{scene.routes.caption}</p>}
        {scene.routes.rows.length > 0 && <div className="cap">{scene.routes.caption}</div>}
      </div>
      <div className="hf-p"><h3>运行信号 / SIGNALS</h3><canvas ref={val} aria-hidden="true" /><div className="cap">{scene.captions.signals}</div></div>
      <div className="hf-p"><h3>成员调度 / DISPATCH</h3>
        {scene.agents.length ? <ul className="hf-agents" data-few={scene.agents.length <= 4} aria-label="成员调度">{scene.agents.map(agent => <li key={agent.id} className="hf-ag">
          <span className="id">{agent.no}</span><span className="rl">{agent.role}</span>
          <span className="cells" aria-hidden="true">{agent.cells.map((color, i) => <i key={i} style={{ background: color }} />)}</span>
          <span className="st" data-working={agent.working}>{agent.state}</span>
        </li>)}</ul> : <p className="hf-quiet">{scene.captions.dispatch}</p>}
        {scene.agents.length > 0 && <div className="cap">{scene.captions.dispatch}</div>}
      </div>
      <div className="hf-p"><h3>阶段索引 / STAGE INDEX</h3><canvas ref={idx} aria-hidden="true" /><div className="cap">{scene.captions.index}</div></div>
    </section>
  </div>;
}

/** What the stage and the drawn panels show, short of the clock. */
function drawnKey(scene: HfScene | null) {
  if (!scene) return "";
  const last = scene.ops.at(-1);
  return `${scene.ops.length}:${last?.state}:${last?.at}:${scene.energy}:${scene.stageNow}:${scene.preview}`;
}

/** What a route row's chips say, for a reader who cannot see them. */
function routeWord(cells: HfScene["routes"]["rows"][number]["cells"], head: HfScene["routes"]["head"]) {
  const failed = cells.indexOf("pk");
  if (failed >= 0) return `${head[failed + 1]}未通过`;
  if (cells[2] === "done") return head[3];
  const on = cells.indexOf("on");
  return on >= 0 ? `${head[on + 1]}中` : head[1];
}

function apply(current: { stage: Stage; panels: Panels }, scene: HfScene, previous: HfScene | null) {
  current.stage.setEnergy(scene.energy);
  const words = JSON.stringify(scene.words);
  if (!previous || words !== JSON.stringify(previous.words)) current.stage.setWords(scene.words ?? undefined);
  current.panels.setData({ ops: scene.ops, window: scene.window, live: scene.live, stageNow: scene.stageNow, stageCounts: scene.stageCounts, activity: scene.energy });
  if (previous && scene.pulse && scene.pulse.key !== previous.pulse?.key) current.stage.pulse(scene.pulse.kind);
}

/** lab.html codeHtml: `name = fn(arg) → result`, cut at the typed length. */
function CodeText({ line, typed }: { line: HfCodeLine; typed: number | null }) {
  const parts: Array<[string, string]> = [["op", `${line.name} = `], ["fn", line.fn], ["op", `(${line.arg})`]];
  if (line.result) parts.push(["re", ` → ${line.result}`]);
  let left = typed ?? Infinity;
  const shown = parts.map(([kind, text]) => { const take = Math.max(0, Math.min(text.length, left)); left -= text.length; return [kind, text.slice(0, take)] as const; });
  const done = typed === null || left >= 0;
  return <>{shown.map(([kind, text], i) => text && <span key={i} className={kind} data-failed={kind === "re" ? line.failed : undefined}>{text}</span>)}
    {(typed !== null && (!done || line.running)) && <span className="hf-caret" aria-hidden="true" />}</>;
}

function useTyping(line: HfCodeLine | undefined, motion: boolean): number | null {
  const text = line ? `${line.name} = ${line.fn}(${line.arg})${line.result ? ` → ${line.result}` : ""}` : "";
  const [typed, setTyped] = useState<{ id: string; chars: number } | null>(null);
  const id = line?.id ?? "";
  useEffect(() => {
    if (!motion || !id) return undefined;
    const timer = window.setInterval(() => setTyped(current => {
      const base = current && current.id === id ? current.chars : 0;
      if (base >= text.length + 6) { window.clearInterval(timer); return current; }
      return { id, chars: base + 2 };
    }), TYPE_MS);
    return () => window.clearInterval(timer);
  }, [id, text.length, motion]);
  if (!motion || !line) return null;
  return typed && typed.id === id ? typed.chars : 0;
}

function useCalloutTurn(key: string, count: number, motion: boolean) {
  const [state, setState] = useState({ key, index: 0, fading: false });
  if (state.key !== key) setState({ key, index: 0, fading: false });
  useEffect(() => {
    if (!motion || count < 2) return undefined;
    let fade = 0;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      setState(current => ({ ...current, fading: true }));
      fade = window.setTimeout(() => setState(current => ({ ...current, index: current.index + 1, fading: false })), CALLOUT_FADE_MS);
    }, CALLOUT_TURN_MS);
    return () => { window.clearInterval(timer); window.clearTimeout(fade); };
  }, [key, count, motion]);
  return state.key === key ? state : { key, index: 0, fading: false };
}
