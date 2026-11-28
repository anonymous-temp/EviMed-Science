import { useEffect, useRef, useState } from "react";
import type { createHaloFlux } from "@/vendor/haloflux/stage.js";

/** The graphic owns no event subscription. A changed operation or result gives it one beat. */
export function HaloFluxCanvas({ preview, moving, signal, label, caption }: {
  preview: boolean; moving: boolean; signal: string; label: string; caption?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const callout = useRef<HTMLDivElement>(null);
  const controls = useRef<() => void>(null);
  const state = useRef({ moving, signal, label });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    state.current = { moving, signal, label };
    controls.current?.();
  }, [moving, signal, label]);

  useEffect(() => {
    const element = canvas.current;
    const annotation = callout.current;
    if (!element || !annotation) return;
    let closed = false, visible = true, sized = false, dirty = true;
    let painter: ReturnType<typeof createHaloFlux> | undefined;
    let pending = 0, previous = 0, lastSignal = "";
    function stop() { if (pending) cancelAnimationFrame(pending); pending = 0; previous = 0; }
    function fail() { closed = true; stop(); setFailed(true); }
    function schedule() {
      if (!painter || closed || document.hidden || !visible) { stop(); return; }
      if (!pending && (dirty || state.current.moving || lastSignal !== state.current.signal)) pending = requestAnimationFrame(frame);
    }
    function frame(now: number) {
      pending = 0;
      if (!painter || closed || document.hidden || !visible) return;
      try {
        if (dirty) {
          if (element!.clientWidth < 20 || element!.clientHeight < 20) return;
          painter.resize();
          sized = true;
        }
        const current = state.current;
        const changed = lastSignal !== current.signal;
        if (changed) { painter.signal(current.label, current.moving); lastSignal = current.signal; }
        if (sized && (dirty || changed || (current.moving && now - previous >= 32))) {
          painter.draw(current.moving && previous ? Math.min(0.05, (now - previous) / 1000) : 0);
          previous = now;
        }
        dirty = false;
        schedule();
      } catch { fail(); }
    }
    const resize = new ResizeObserver(() => { dirty = true; schedule(); });
    resize.observe(element);
    const viewport = typeof IntersectionObserver === "function" ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; schedule(); }) : null;
    viewport?.observe(element);
    document.addEventListener("visibilitychange", schedule);
    controls.current = schedule;
    void import("@/vendor/haloflux/stage.js").then(({ createHaloFlux }) => {
      if (closed) return;
      painter = createHaloFlux(element, preview, annotation);
      schedule();
    }).catch(() => { if (!closed) fail(); });
    return () => {
      closed = true; stop(); controls.current = null;
      resize.disconnect(); viewport?.disconnect();
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [preview]);

  return <div className="obs-halo-stage">
    <canvas ref={canvas} aria-hidden="true" className={failed ? "invisible" : undefined} />
    <div ref={callout} hidden={failed || !caption} className="obs-halo-note" aria-hidden="true"><b>{label}</b><span>{caption}</span></div>
    {failed && <p role="status">当前设备无法绘制光环</p>}
  </div>;
}
