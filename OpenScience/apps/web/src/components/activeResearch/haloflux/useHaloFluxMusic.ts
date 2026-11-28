import { useCallback, useEffect, useRef, useState } from "react";

/**
 * HALOFLUX's background music (lab.html BGM): "Synthwave 421k" by The Cynic Project, CC0. Upstream plays it from the first gesture;
 * on a research page it stays off until the reader presses the button, which also satisfies the browser's gesture rule. The rest is
 * upstream's: a fade in and out, a perceptual volume curve, a Web Audio gain where an element's volume is read-only (iOS), a pause
 * while the tab is hidden, and the volume remembered in this browser.
 *
 * The control plane serves the track as a plain file (no byte ranges, a generic type). Chromium and Firefox stream that into a
 * media element; a browser that refuses it gets the same track fetched once and decoded into a looping Web Audio buffer.
 */
const KEY = "evimed.haloflux.music";
const SRC = `${import.meta.env.BASE_URL}static/haloflux/sw421k.mp3`;
type Context = typeof AudioContext;

/** The volume is remembered; the music itself always starts off. */
function savedVolume(): number {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null") as { volume?: unknown } | null;
    return typeof saved?.volume === "number" ? Math.max(0, Math.min(100, saved.volume)) : 60;
  } catch { return 60; }
}

const audioContextClass = (): Context | undefined =>
  typeof window === "undefined" ? undefined : window.AudioContext ?? (window as unknown as { webkitAudioContext?: Context }).webkitAudioContext;

export type HaloFluxMusic = ReturnType<typeof useHaloFluxMusic>;

export function useHaloFluxMusic() {
  const [state, setState] = useState(() => ({ on: false, volume: savedVolume() }));
  const [unavailable, setUnavailable] = useState(false);
  const want = useRef(state);
  want.current = state;
  const audio = useRef<HTMLAudioElement | null>(null);
  const context = useRef<AudioContext | null>(null);
  const gain = useRef<GainNode | null>(null);
  /** Set once the media element failed: the decoded track and the node playing it. */
  const decoded = useRef<{ buffer: Promise<AudioBuffer> | null; source: AudioBufferSourceNode | null } | null>(null);
  const routed = useRef(false);
  const fade = useRef(0);

  const target = (volume: number) => Math.pow(volume / 100, 1.6);
  const getV = () => gain.current && (routed.current || decoded.current) ? gain.current.gain.value : audio.current?.volume ?? 0;
  const setV = (v: number) => {
    const x = Math.max(0, Math.min(1, v));
    if (gain.current && (routed.current || decoded.current)) gain.current.gain.value = x;
    else if (audio.current) audio.current.volume = x;
  };
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

  const off = useCallback((why: "refused" | "unavailable") => {
    if (why === "unavailable") setUnavailable(true);
    setState(current => ({ ...current, on: false }));
  }, []);

  /** Created and resumed inside the click, so iOS lets it sound later. */
  const ensureContext = () => {
    const AC = audioContextClass();
    if (!context.current && AC) {
      try {
        const ctx = new AC(), node = ctx.createGain();
        node.gain.value = 0; node.connect(ctx.destination);
        context.current = ctx; gain.current = node;
      } catch { context.current = null; gain.current = null; }
    }
    void context.current?.resume().catch(() => {});
    return context.current;
  };

  const playDecoded = useCallback(async () => {
    const ctx = context.current, node = gain.current;
    if (!ctx || !node) { off("unavailable"); return; }
    const track = decoded.current ?? (decoded.current = { buffer: null, source: null });
    track.buffer ??= fetch(SRC).then(response => {
      if (!response.ok) throw new Error(`music ${response.status}`);
      return response.arrayBuffer();
    }).then(bytes => ctx.decodeAudioData(bytes));
    try {
      const buffer = await track.buffer;
      if (!want.current.on) return;
      track.source?.stop(); track.source?.disconnect();
      const source = ctx.createBufferSource();
      source.buffer = buffer; source.loop = true; source.connect(node); source.start();
      track.source = source;
      await ctx.resume();
      node.gain.value = 0;
      fadeTo(target(want.current.volume), 900);
    } catch {
      track.buffer = null;
      off("unavailable");
    }
  }, [fadeTo, off]);

  const element = () => {
    if (audio.current) return audio.current;
    const au = new Audio();
    au.loop = true; au.preload = "auto"; au.src = SRC;
    au.setAttribute("playsinline", "");
    au.addEventListener("error", () => {
      // The element cannot read the file: decode it instead, once.
      if (decoded.current) return;
      au.pause(); au.removeAttribute("src");
      decoded.current = { buffer: null, source: null };
      if (want.current.on) void playDecoded();
    });
    // An element whose volume cannot be set (iOS) is turned up and down through the gain node instead.
    const readOnly = (() => { try { au.volume = 0.5; const ro = Math.abs(au.volume - 0.5) > 0.01; au.volume = 1; return ro; } catch { return true; } })();
    if (readOnly && context.current && gain.current) {
      try { context.current.createMediaElementSource(au).connect(gain.current); routed.current = true; } catch { routed.current = false; }
    }
    audio.current = au;
    return au;
  };

  const play = useCallback(() => {
    ensureContext();
    if (decoded.current) { void playDecoded(); return; }
    const au = element();
    setV(0);
    au.play().then(() => fadeTo(target(want.current.volume), 900)).catch((error: unknown) => {
      if (decoded.current) return; // the error listener took over
      if ((error as { name?: string } | null)?.name === "NotAllowedError") { off("refused"); return; }
      decoded.current = { buffer: null, source: null };
      void playDecoded();
    });
    // `element` and `ensureContext` only touch refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeTo, off, playDecoded]);

  const stop = useCallback(() => {
    fadeTo(0, 400, () => {
      const source = decoded.current?.source;
      if (source) { source.stop(); source.disconnect(); decoded.current!.source = null; }
      audio.current?.pause();
    });
  }, [fadeTo]);

  const save = (volume: number) => { try { localStorage.setItem(KEY, JSON.stringify({ volume })); } catch { /* the choice is only for this visit */ } };
  const toggle = useCallback(() => {
    setUnavailable(false);
    const next = { ...want.current, on: !want.current.on };
    want.current = next;
    setState(next);
    // Inside the click, so the browser lets it play.
    if (next.on) play(); else stop();
  }, [play, stop]);
  const setVolume = useCallback((volume: number) => {
    const next = { ...want.current, volume };
    want.current = next;
    save(volume); setState(next);
    cancelAnimationFrame(fade.current);
    if (next.on) setV(target(volume));
  }, []);

  useEffect(() => {
    const visibility = () => {
      if (!want.current.on) return;
      if (document.hidden) {
        cancelAnimationFrame(fade.current);
        audio.current?.pause();
        void context.current?.suspend().catch(() => {});
      } else {
        void context.current?.resume().catch(() => {});
        if (!decoded.current) play();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      cancelAnimationFrame(fade.current);
      audio.current?.pause();
      decoded.current?.source?.stop();
      void context.current?.close().catch(() => {});
      audio.current = null; context.current = null; gain.current = null; decoded.current = null; routed.current = false;
    };
  }, [play]);

  return { on: state.on, volume: state.volume, unavailable, toggle, setVolume };
}
