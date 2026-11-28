import { useCallback, useEffect, useRef, useState } from "react";

/**
 * HALOFLUX's background music (lab.html BGM): "Synthwave 421k" by The Cynic Project, CC0. Upstream plays it from the first gesture;
 * on a research page it stays off until the reader presses the button, which also satisfies the browser's gesture rule. The rest is
 * upstream's: a fade in and out, a perceptual volume curve, a Web Audio gain where an element's volume is read-only (iOS), a pause
 * while the tab is hidden, and the choice remembered in this browser.
 */
const KEY = "evimed.haloflux.music";
const SRC = `${import.meta.env.BASE_URL}static/haloflux/sw421k.mp3`;

/** The volume is remembered; the music itself always starts off. */
function savedVolume(): number {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null") as { volume?: unknown } | null;
    return typeof saved?.volume === "number" ? Math.max(0, Math.min(100, saved.volume)) : 60;
  } catch { return 60; }
}

export type HaloFluxMusic = ReturnType<typeof useHaloFluxMusic>;

export function useHaloFluxMusic() {
  const [state, setState] = useState(() => ({ on: false, volume: savedVolume() }));
  const [unavailable, setUnavailable] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const gain = useRef<GainNode | null>(null);
  const context = useRef<AudioContext | null>(null);
  const fade = useRef(0);
  const want = useRef(state);
  want.current = state;

  const target = (volume: number) => Math.pow(volume / 100, 1.6);
  const getV = () => gain.current ? gain.current.gain.value : audio.current?.volume ?? 0;
  const setV = (v: number) => { const x = Math.max(0, Math.min(1, v)); if (gain.current) gain.current.gain.value = x; else if (audio.current) audio.current.volume = x; };
  const fadeTo = useCallback((to: number, ms: number, done?: () => void) => {
    cancelAnimationFrame(fade.current);
    const from = getV(), t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      setV(from + (to - from) * k);
      if (k < 1) fade.current = requestAnimationFrame(step); else done?.();
    };
    fade.current = requestAnimationFrame(step);
  }, []);

  const element = () => {
    if (audio.current) return audio.current;
    const au = new Audio();
    au.loop = true; au.preload = "auto"; au.src = SRC;
    au.setAttribute("playsinline", "");
    au.addEventListener("error", () => { setUnavailable(true); setState(current => ({ ...current, on: false })); });
    // An element whose volume cannot be set (iOS) is turned up and down through a gain node instead.
    const readOnly = (() => { try { au.volume = 0.5; const ro = Math.abs(au.volume - 0.5) > 0.01; au.volume = 1; return ro; } catch { return true; } })();
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (readOnly && AC) {
      try {
        const ctx = new AC(), node = ctx.createGain(); node.gain.value = 0;
        ctx.createMediaElementSource(au).connect(node); node.connect(ctx.destination);
        context.current = ctx; gain.current = node;
      } catch { context.current = null; gain.current = null; }
    }
    audio.current = au;
    return au;
  };

  const play = useCallback(() => {
    const au = element();
    void context.current?.resume();
    setV(0);
    au.play().then(() => fadeTo(target(want.current.volume), 900)).catch(() => setState(current => ({ ...current, on: false })));
  }, [fadeTo]);
  const stop = useCallback(() => { const au = audio.current; if (au) fadeTo(0, 400, () => au.pause()); }, [fadeTo]);

  const save = (next: { on: boolean; volume: number }) => { try { localStorage.setItem(KEY, JSON.stringify({ volume: next.volume })); } catch { /* the choice is only for this visit */ } };
  const toggle = useCallback(() => {
    setUnavailable(false);
    const next = { ...want.current, on: !want.current.on };
    save(next); setState(next);
    // Inside the click, so the browser lets it play.
    if (next.on) play(); else stop();
  }, [play, stop]);
  const setVolume = useCallback((volume: number) => {
    const next = { ...want.current, volume };
    save(next); setState(next);
    cancelAnimationFrame(fade.current);
    if (audio.current && !audio.current.paused) setV(target(volume));
  }, []);

  useEffect(() => {
    const hidden = () => {
      const au = audio.current;
      if (!au) return;
      if (document.hidden) { cancelAnimationFrame(fade.current); au.pause(); }
      else if (want.current.on) play();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      cancelAnimationFrame(fade.current);
      audio.current?.pause();
      void context.current?.close();
      audio.current = null; context.current = null; gain.current = null;
    };
  }, [play]);

  return { on: state.on, volume: state.volume, unavailable, toggle, setVolume };
}
