import { STAGES } from "@/lib/researchObservation";
import type { HfScene } from "./haloFluxScene";

/**
 * HALOFLUX's four drawn instrument panels (lab.html: ADVECTION / PARTICLE SOLVER, SHARED SCENE / DIFFERENCE FIELD,
 * VALIDATION / SAMPLE BUFFER, METHOD / REFERENCE INDEX), with the same drawing code and palette. Upstream feeds them
 * random waves; here they plot the round: the particle field runs as fast as the round is working, the difference field is
 * every operation and its result, the sample buffer three traces over time, and the index each stage over time.
 * Adapted from https://github.com/Ryder191/haloflux (MIT, RYDER CODE / Ms MAIKEBAIs CAT).
 */

type Panel = HTMLCanvasElement & { x: CanvasRenderingContext2D; w: number; h: number };
export interface PanelCanvases { adv: HTMLCanvasElement; diff: HTMLCanvasElement; val: HTMLCanvasElement; idx: HTMLCanvasElement }
type PanelData = Pick<HfScene, "ops" | "window" | "live" | "stageNow" | "stageCounts"> & { activity: number };

const FONT = '"JetBrains Mono",Consolas,monospace';
const LIVE_SPAN = 10 * 60_000;
const rnd = Math.random;
const rr = (a: number, b: number) => a + rnd() * (b - a);

function fit(c: HTMLCanvasElement, dpr: number): Panel | null {
  const r = c.getBoundingClientRect();
  const x = c.getContext("2d");
  if (!x) return null;
  c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  return Object.assign(c, { x, w: r.width, h: r.height });
}

const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function createPanels(canvases: PanelCanvases) {
  let adv: Panel | null = null, diff: Panel | null = null, val: Panel | null = null, idx: Panel | null = null;
  let T = 0, flowT = 0;
  let advP: Array<{ x: number; y: number; l: number }> = [];
  let data: PanelData = { ops: [], window: null, live: false, stageNow: -1, stageCounts: STAGES.map(() => 0), activity: 0 };
  let traces: number[][] | null = null, traceKey = "";

  /* --- ADVECTION / PARTICLE SOLVER: lab.html drawAdv; the field moves as fast as the round works --- */
  const flow = (x: number, y: number) => Math.sin(x * 0.035 + flowT * 0.6) * Math.cos(y * 0.05 - flowT * 0.4) * Math.PI + Math.sin((x + y) * 0.01 + flowT * 0.2);
  function drawAdv(dt: number) {
    if (!adv) return;
    const x = adv.x, w = adv.w, h = adv.h, k = 0.2 + 0.8 * data.activity;
    flowT += dt * k;
    x.fillStyle = "rgba(14,15,18,0.22)"; x.fillRect(0, 0, w, h);
    x.fillStyle = "rgba(120,125,135,.25)";
    for (let i = 6; i < w; i += 12) for (let j = 6; j < h; j += 12) x.fillRect(i, j, 1, 1);
    x.strokeStyle = "rgba(235,238,244,.7)"; x.lineWidth = 0.8; x.beginPath();
    for (const p of advP) {
      const a = flow(p.x, p.y), nx = p.x + Math.cos(a) * 22 * dt * k, ny = p.y + Math.sin(a) * 22 * dt * k;
      x.moveTo(p.x, p.y); x.lineTo(nx + Math.cos(a) * 2, ny + Math.sin(a) * 2);
      p.x = nx; p.y = ny; p.l -= dt * k;
      if (p.l < 0 || p.x < 0 || p.x > w || p.y < 0 || p.y > h) { p.x = rnd() * w; p.y = rnd() * h; p.l = rr(1, 4); }
    }
    x.stroke();
  }

  /* --- SHARED SCENE / DIFFERENCE FIELD: lab.html drawDiff; one cell per operation, its result beside it, durations below --- */
  function drawDiff() {
    if (!diff) return;
    const x = diff.x, w = diff.w, h = diff.h;
    x.clearRect(0, 0, w, h);
    x.font = `600 8px ${FONT}`; x.textBaseline = "top";
    // Upstream's 22 × 13 field when the round fills it; a smaller round gets fewer, larger cells, so every cell is an operation.
    const n = data.ops.length, cols = Math.max(8, Math.min(22, Math.ceil(Math.sqrt(n * 2)))), rows = Math.max(4, Math.min(13, Math.ceil(n / cols)));
    const gap = 8, mw = (w - gap) / 2, mh = h * 0.68, cw = mw / cols, ch = (mh - 11) / rows;
    const ops = data.ops.slice(-cols * rows);
    for (let m = 0; m < 2; m++) {
      const ox = m * (mw + gap);
      x.fillStyle = "#9a9ea7"; x.fillText(m ? "结果 RESULT" : "操作 OPS", ox, 0);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const op = ops[j * cols + i];
        let v = 0.04, err = 0;
        if (op) {
          v = 0.38 + ((op.stage + 1) / STAGES.length) * 0.45 + 0.06 * Math.sin(i * 0.45 + T * 0.8) * Math.cos(j * 0.5 - T * 0.5);
          if (m && op.state === "error") err = 0.7 + 0.3 * Math.sin(T * 2);
          if (m && op.state === "running") v = 0.85 + 0.15 * Math.sin(T * 6);
        }
        const g = Math.max(0, Math.min(255, v * 210 + 20)) | 0;
        x.fillStyle = err > 0.35 ? `rgba(240,166,198,${0.5 + err * 0.5})` : `rgb(${g},${g},${g + 4})`;
        x.fillRect(ox + i * cw, 11 + j * ch, cw - 0.6, ch - 0.6);
      }
    }
    // Durations on a log scale; the slow tail (10 s and longer) in pink.
    const bins = 28, hist = new Array(bins).fill(0);
    const durations = data.ops.map(op => op.ms).filter((ms): ms is number => ms !== null && ms > 0);
    const lo = Math.log(100), hi = Math.log(Math.max(10_000, ...durations, 1000));
    for (const ms of durations) hist[Math.max(0, Math.min(bins - 1, Math.floor(((Math.log(Math.max(100, ms)) - lo) / (hi - lo)) * bins)))]++;
    const by = mh + 4, bh = h - by, bw = w / bins, mx = Math.max(...hist, 1);
    hist.forEach((v, i) => {
      const hh = v ? (v / mx) * bh * 0.85 + 1 : 1;
      const edge = Math.exp(lo + ((hi - lo) * i) / bins);
      x.fillStyle = edge >= 10_000 ? "#f0a6c6" : "#8a8e97";
      x.fillRect(i * bw, by + bh - hh, bw - 1, hh);
    });
  }

  /* --- VALIDATION / SAMPLE BUFFER: lab.html drawVal; operations, time taken and failures over the round --- */
  function computeTraces(n: number) {
    const { ops, window, live } = data;
    if (!window || n < 2) return null;
    const to = window.to, from = Math.min(to - 60_000, live ? Math.max(window.from, to - LIVE_SPAN) : window.from);
    const step = (to - from) / n;
    const count = new Array(n).fill(0), took = new Array(n).fill(0), tookN = new Array(n).fill(0), failed = new Array(n).fill(0);
    for (const op of ops) {
      const i = Math.floor((op.at - from) / step);
      if (i < 0 || i >= n) continue;
      count[i]++;
      if (op.ms !== null) { took[i] += op.ms; tookN[i]++; }
      if (op.state === "error") failed[i]++;
    }
    const smooth = (values: number[]) => {
      const radius = Math.max(1, Math.round(n / 48));
      return values.map((_, i) => { let s = 0, c = 0; for (let k = -radius; k <= radius; k++) { const v = values[i + k]; if (v !== undefined) { s += v; c++; } } return s / c; });
    };
    const scale = (values: number[]) => { const mx = Math.max(...values, 1e-9); return values.map(v => (v / mx) * 1.6 - 0.8); };
    let spike = 0;
    const spikes = failed.map((f, i) => { spike = f ? 1 : spike * 0.82; return spike * (i % 2 ? 0.9 : -0.9); });
    return [scale(smooth(count)), scale(smooth(took.map((t, i) => (tookN[i] ? t / tookN[i] : 0)))), spikes];
  }
  function drawVal() {
    if (!val) return;
    const x = val.x, w = val.w, h = val.h;
    x.clearRect(0, 0, w, h);
    const lw = 58, n = Math.max(2, Math.floor((w - lw) / 2)), names = ["操作 OPS", "耗时 TIME", "出错 ERR"];
    const key = `${n}:${data.ops.length}:${data.ops.at(-1)?.state ?? ""}:${data.window?.from}:${data.live ? Math.floor((data.window?.to ?? 0) / 2000) : data.window?.to}`;
    if (key !== traceKey) { traces = computeTraces(n); traceKey = key; }
    x.font = `800 8px ${FONT}`; x.textBaseline = "middle";
    const rh = h / 3;
    for (let k = 0; k < 3; k++) {
      const yc = rh * k + rh / 2, series = traces?.[k];
      x.fillStyle = "#9a9ea7"; x.fillText(names[k], 0, yc);
      x.strokeStyle = "#1f2227"; x.lineWidth = 1; x.beginPath(); x.moveTo(lw, yc); x.lineTo(w, yc); x.stroke();
      if (!series) continue;
      const hot = k === 2 && series.slice(-Math.ceil(n / 10)).some(v => Math.abs(v) > 0.2);
      x.strokeStyle = hot ? "#f0a6c6" : "#e6e8ec"; x.lineWidth = 1.1;
      x.beginPath();
      series.forEach((v, i) => { const px = lw + i * 2, py = yc - v * rh * 0.45; if (i) x.lineTo(px, py); else x.moveTo(px, py); });
      x.stroke();
    }
    if (traces) {
      const cxr = lw + (traces[0].length - 1) * 2;
      x.strokeStyle = "rgba(240,166,198,.6)"; x.beginPath(); x.moveTo(cxr, 0); x.lineTo(cxr, h); x.stroke();
    }
  }

  /* --- METHOD / REFERENCE INDEX: lab.html drawIdx; each stage (row) over the round (columns) --- */
  function drawIdx() {
    if (!idx) return;
    const x = idx.x, w = idx.w, h = idx.h;
    x.clearRect(0, 0, w, h);
    x.font = `600 8px ${FONT}`; x.textBaseline = "middle";
    const lx = 46, rx = 34, rows = STAGES.length, cols = 28, cw = (w - lx - rx) / cols, ch = h / rows;
    const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
    const { window } = data;
    if (window) for (const op of data.ops) {
      if (op.stage < 0) continue;
      const i = Math.min(cols - 1, Math.max(0, Math.floor(((op.at - window.from) / (window.to - window.from)) * cols)));
      grid[op.stage][i]++;
    }
    const mx = Math.max(1, ...grid.flat());
    const scan = Math.floor((T * 6) % cols);
    for (let j = 0; j < rows; j++) {
      x.fillStyle = "#9a9ea7"; x.fillText(STAGES[j].code, 0, j * ch + ch / 2);
      for (let i = 0; i < cols; i++) {
        const c = grid[j][i], v = c ? 0.45 + 0.55 * (c / mx) : 0;
        x.fillStyle = v > 0.86 ? "#f0a6c6" : v > 0.7 ? "rgba(240,166,198,.45)" : v > 0.4 ? "#4a4e56" : "#1c1e23";
        if (i === scan) x.fillStyle = v > 0.4 ? "#ffffff" : "#3a3e46";
        x.fillRect(lx + i * cw, j * ch + 1, cw - 1, ch - 2);
      }
      x.fillStyle = j === data.stageNow ? "#f0a6c6" : "#9a9ea7";
      x.fillText(data.stageCounts[j] ? compact(data.stageCounts[j]) : "—", w - rx + 4, j * ch + ch / 2);
    }
  }

  return {
    resize(dpr: number) {
      adv = fit(canvases.adv, dpr); diff = fit(canvases.diff, dpr); val = fit(canvases.val, dpr); idx = fit(canvases.idx, dpr);
      advP = adv ? Array.from({ length: 320 }, () => ({ x: rnd() * adv!.w, y: rnd() * adv!.h, l: rnd() * 3 })) : [];
      traceKey = "";
    },
    setData(next: PanelData) { data = next; },
    draw(dt: number) {
      T += dt;
      drawAdv(dt); drawDiff(); drawVal(); drawIdx();
    },
  };
}
