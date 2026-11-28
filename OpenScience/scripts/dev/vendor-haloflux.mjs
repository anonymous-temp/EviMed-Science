#!/usr/bin/env node
/**
 * Rebuilds apps/web/src/vendor/haloflux/stage.js from an upstream HALOFLUX checkout.
 *
 *   git clone https://github.com/Ryder191/haloflux /tmp/haloflux
 *   git -C /tmp/haloflux checkout <deps-version.json → $visualizations.haloflux.commit>
 *   node scripts/dev/vendor-haloflux.mjs /tmp/haloflux
 *
 * The stage is lab.html's MAIN STAGE section, unchanged except for the edits listed in EDITS: the page's globals become
 * a factory over a host canvas, its timers run on the host's clock, the portrait rotation and the lighter particle load
 * come from mobile.html, and the ring's data vocabulary and beat energy can be set by the host. Every edit must apply
 * exactly as often as stated, so an upstream change that moves the code fails here instead of drawing something else.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = process.argv[2];
if (!root) { console.error("usage: vendor-haloflux.mjs <haloflux checkout>"); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(readFileSync(join(here, "../../deps-version.json"), "utf8"));
const pin = pins.$visualizations?.haloflux?.commit;
const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (pin && head !== pin) { console.error(`checkout is ${head}, deps-version.json pins ${pin}`); process.exit(1); }

const lab = readFileSync(join(root, "lab.html"), "utf8").split("\n");
const at = (text, from = 0) => {
  const index = lab.findIndex((line, i) => i >= from && line.startsWith(text));
  if (index < 0) throw new Error(`lab.html no longer has a line starting ${JSON.stringify(text)}`);
  return index;
};
const start = at("const TAU = Math.PI * 2");
const callout = at("function drawCallout()");
const end = lab.findIndex((line, i) => i > callout && line === "}");
let body = lab.slice(start, end + 1).join("\n");

/** [what, from, to, times] — `from` may be a RegExp. */
const EDITS = [
  ["panel helpers stay in panels.js", /\nfunction mk\(w, h\) \{[\s\S]*?\n\}\nfunction fit\(c\) \{[\s\S]*?\n\}\n/, "\n", 1],
  ["the host owns the canvas", "const stage = document.getElementById('stage'); let S = stage.getContext('2d');", "let S = stage.getContext('2d');", 1],
  ["the host sets the pixel ratio", "let DPR = Math.min(window.devicePixelRatio || 1, 2);", "let DPR = 1;", 1],
  ["the console's parameter table is not shipped", /\/\* ---------- live configuration \(driven by the console\) ---------- \*\/\n\/\/ \[key[^\n]*\nconst PARAMS = \[[\s\S]*?\n\];\n/, "", 1],
  ["the unused token list", /const TOK = \[[\s\S]*?\];\n/, "", 1],
  ["the callout text belongs to the host", /const CHECKS = \[[\s\S]*?const chkEl = document\.getElementById\('chk'\);\n/, "", 1],
  // mobile.html: portrait phones draw the scene rotated -90°.
  ["portrait rotation (mobile.html)", "const FS = 0.5; let farC; // far-layer buffer (depth of field)",
    "const FS = 0.5; let farC; // far-layer buffer (depth of field)\nlet ROT = false, SW = 0, SH = 0;   // portrait phones: scene is drawn rotated -90° (mobile.html)\nfunction setXf(ctx, d, z, tx, ty) {\n  if (ROT && ctx === S_MAIN) ctx.setTransform(0, -d * z, d * z, 0, ty, SH * d - tx);\n  else ctx.setTransform(d * z, 0, 0, d * z, tx, ty);\n}", 1],
  ["camT (mobile.html)", "function camT(ctx, d) { ctx.setTransform(d * cam.z, 0, 0, d * cam.z, d * (W / 2 - cam.x * cam.z), d * (H / 2 - cam.y * cam.z)); }",
    "function camT(ctx, d) { setXf(ctx, d, cam.z, d * (W / 2 - cam.x * cam.z), d * (H / 2 - cam.y * cam.z)); }", 1],
  ["camTk (mobile.html)", "  ctx.setTransform(d * z, 0, 0, d * z, d * (W / 2 - x * z), d * (H / 2 - y * z));", "  setXf(ctx, d, z, d * (W / 2 - x * z), d * (H / 2 - y * z));", 1],
  ["resizeStage (mobile.html)", "  W = r.width; H = r.height;\n  stage.width = W * DPR; stage.height = H * DPR;\n  cx = W * 0.07; cy = H * 0.5;",
    "  ROT = r.height > r.width * 1.05; SW = r.width; SH = r.height;\n  W = ROT ? r.height : r.width; H = ROT ? r.width : r.height;\n  stage.width = SW * DPR; stage.height = SH * DPR;\n  cx = W * (ROT ? -0.1 : 0.07); cy = H * 0.5;", 1],
  ["screen transforms (mobile.html)", "S.setTransform(DPR, 0, 0, DPR, 0, 0)", "setXf(S, DPR, 1, 0, 0)", 5],
  ["phones: fewer particles, same look (mobile.html)", "if (BAKED_MINE) PRESETS.MINE = { ...BASE, ...BAKED_MINE };",
    "if (BAKED_MINE) PRESETS.MINE = { ...BASE, ...BAKED_MINE };\nconst MOBILE_K = { runnerCount: 0.5, flyerCount: 0.55, burstSize: 0.75, bokeh: 0.6 };\nif (lite) for (const p of Object.values(PRESETS)) for (const k in MOBILE_K) p[k] = k === 'runnerCount' || k === 'bokeh' ? Math.round(p[k] * MOBILE_K[k]) : +(p[k] * MOBILE_K[k]).toFixed(2);", 1],
  // Timers follow the host's clock, so a paused or closed stage leaves nothing behind.
  ["comet bursts on the stage clock", "setTimeout(spawnComet, i * rr(30, 90))", "schedule(spawnComet, i * rr(30, 90))", 1],
  ["fly bursts on the stage clock", "setTimeout(spawnFlyBurst, i * rr(20, 120))", "schedule(spawnFlyBurst, i * rr(20, 120))", 1],
  // The ring's micro panels print the host's words and numbers when it has some.
  ["ring headers", "c.fillText(pick(HEAD), x0, y)", "c.fillText(pick(WORDS.head || HEAD), x0, y)", 1],
  ["ring code words", "const w = pick(CODE_T);", "const w = pick(WORDS.code || CODE_T);", 1],
  ["ring keys", "c.fillText(pick(KEYS), x0, y)", "c.fillText(pick(WORDS.keys || KEYS), x0, y)", 1],
  ["ring numbers", "const fmtNum = () => {", "const fmtNum = () => WORDS.numbers && rnd() < 0.7 ? pick(WORDS.numbers) : fmtUp();\nconst fmtUp = () => {", 1],
  ["callout follows the host element", /function drawCallout\(\) \{\n[\s\S]*?\n\}$/,
    "function drawCallout() {\n  if (!callout || callout.hidden) return;\n  callout.style.display = ROT ? 'none' : '';\n  if (ROT) return;\n  const a = -thS * 0.32;\n  const anchor = toScreen(cx + Math.cos(a) * (RO + 30), cy + Math.sin(a) * (RO + 30));\n  const box = toScreen(cx + Math.cos(a) * (RO + 30) + 120, cy + Math.sin(a) * (RO + 30) - 40);\n  const bx = Math.min(W - callout.offsetWidth - 8, Math.max(8, box.x)), by = Math.min(H - callout.offsetHeight - 8, Math.max(40, box.y));\n  callout.style.transform = `translate(${bx}px,${by}px)`;\n  S.strokeStyle = 'rgba(230,233,238,.55)'; S.lineWidth = 0.8;\n  S.beginPath(); S.moveTo(anchor.x, anchor.y); S.lineTo(bx, by + 12); S.stroke();\n  S.fillStyle = '#fff'; S.fillRect(anchor.x - 1.5, anchor.y - 1.5, 3, 3);\n}", 1],
  // ESLint's no-unused-expressions: the same branches as statements.
  ["statement form", "s ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);", "if (s) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);", 1],
  ["statement form", "i ? c.lineTo(lx, ly) : c.moveTo(lx, ly);", "if (i) c.lineTo(lx, ly); else c.moveTo(lx, ly);", 1],
  ["statement form", "xx === x0 ? c.moveTo(xx, yy) : c.lineTo(xx, yy);", "if (xx === x0) c.moveTo(xx, yy); else c.lineTo(xx, yy);", 1],
  ["unused locals", "let curves = [], runners = [], comets = [], cards = [], wedges = [], pulses = [];", "let curves = [], runners = [], comets = [], wedges = [], pulses = [];", 1],
  ["unused locals", "let webRot = 0, ringRot = 0, ringVel = 0, OSTEP = 0.0038;", "let webRot = 0, ringRot = 0, OSTEP = 0.0038;", 1],
  ["unused locals", "const HAZE_COL = ['196,180,252', '242,242,252', '190,222,222'];\n", "", 1],
];
for (const [what, from, to, times] of EDITS) {
  const found = typeof from === "string" ? body.split(from).length - 1 : (body.match(new RegExp(from.source, from.flags.includes("g") ? from.flags : from.flags + "g")) ?? []).length;
  if (found !== times) throw new Error(`${what}: expected ${times}, found ${found}`);
  body = typeof from === "string" ? body.split(from).join(to) : body.replace(from, to);
}

const out = `/*! HALOFLUX by RYDER CODE / Ms MAIKEBAIs CAT (https://github.com/Ryder191/haloflux), MIT — /licenses/HALOFLUX.txt.
 * Generated by scripts/dev/vendor-haloflux.mjs from lab.html at commit ${head}; do not edit by hand.
 */
/* eslint-disable */
/**
 * @param {HTMLCanvasElement} stage
 * @param {{ lite?: boolean, callout?: HTMLElement | null }} [options]
 */
export function createHaloFlux(stage, options = {}) {
const lite = !!options.lite, callout = options.callout || null;
let T = 0;
const queued = [];
function schedule(fn, ms) { queued.push({ fn, at: T + ms / 1000 }); }
/** Words and numbers from the host for the ring's micro panels; upstream's own vocabulary otherwise. */
let WORDS = {};

${body}

/* ---------- host interface (EviMed) ---------- */
const CALM = { tempo: 0.6, ringSpeed: 0.6 };   // the wallpaper edition's calm defaults (wallpaper/project.json)
const FULL = { tempo: C.tempo, ringSpeed: C.ringSpeed };
let energy = 1, energyTo = 1;
return {
  /** Re-measures the canvas; dpr is the host's pixel ratio. */
  resize(dpr) { DPR = dpr; resizeStage(); },
  /** 0 = the wallpaper's calm tempo, 1 = the author's default; eased over about a second. */
  setEnergy(value) { energyTo = Math.max(0, Math.min(1, value)); },
  /** { head, code, keys, numbers }: arrays of strings, or undefined for upstream's own. Re-renders the panels as the ring turns. */
  setWords(words) { WORDS = words || {}; for (const s of slots) if (rnd() < 0.5) s.c = null; },
  /** A real event: an extra beat; a delivered file also sends a burst of flyers out of the ring. */
  pulse(kind) {
    if (!slots.length) return;
    sinceBeat = 0; beatN++; onBeat();
    flashSlotAt(rr(-thV * 0.6, thV * 0.6));
    if (kind === 'deliver') for (let i = 0; i < 3; i++) schedule(spawnFlyBurst, i * 140);
  },
  draw(seconds) {
    T += seconds;
    energy += (energyTo - energy) * Math.min(1, seconds * 1.5);
    C.tempo = CALM.tempo + (FULL.tempo - CALM.tempo) * energy;
    C.ringSpeed = CALM.ringSpeed + (FULL.ringSpeed - CALM.ringSpeed) * energy;
    for (let i = queued.length - 1; i >= 0; i--) if (queued[i].at <= T) queued.splice(i, 1)[0].fn();
    drawStage(seconds);
  },
};
}
`;
const target = join(here, "../../apps/web/src/vendor/haloflux/stage.js");
writeFileSync(target, out);
console.log(`wrote ${target} (${out.length} bytes) from ${head}`);
