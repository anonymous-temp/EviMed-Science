import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { unitHash } from "@/components/charts/map/layout";
import {
  RING, TAU, along, cellReach, layoutRing, linkPath, neighbourhood, placeLabels, polar, replayStart, ringHit, sparkPath,
  type Point, type RingCell, type RingHit, type RingLayout, type RingSpec,
} from "./ringModel";

/**
 * A ring picture's painting, and nothing about what it means: `ringModel.ts` decides where, an adapter decides what, this draws, and
 * `RingCanvas.tsx` holds it in the page. Its own chunk with three.js and the post-processing passes, so nobody who does not open a ring
 * pays for them.
 *
 * Hidden knowledge:
 *
 * - **Pixels, not a camera.** An orthographic camera in CSS pixels, the ring's group scaled to its radius: a pointer's place is the ring's
 *   place with no ray, a label sits where the model says, and a frame of panels round the ring (full screen) only moves its centre.
 * - **One bloom, brightness is the signal.** Cells, sparks and flowing light are additive and their colour is their brightness, so the bloom
 *   lifts exactly what is bright; a dim memory has no halo with no second material.
 * - **Motion is data or it is off.** Light flows along a link that says something, a spark flies only to a cell that was recalled or is
 *   working, a cloud breathes faster only round a member at work. Every motion — flow, drift, sparks, flashes, the replay — runs on the
 *   scene's own clock, which `setMoving(false)` stops (WCAG 2.2.2): the picture keeps what it shows and draws a frame only for a change it is
 *   told of (a hover, a selection), and an event while still lights nothing that would move.
 * - **It stops when nobody is looking**, gives up the bloom once on a machine that cannot hold the frame rate, and treats a lost context
 *   as a normal event that may come back (`CONTEXT_WAIT_MS`) before the page goes to its flat picture.
 */

export interface RingView {
  /** The cells drawn: the rest stand where they stand, unseen. Null is every cell. */
  shown: ReadonlySet<string> | null;
  /** What a search lit: their names stand by them. */
  hits: ReadonlySet<string>;
  /** The cell whose drawer is open. */
  selected: string | null;
}

/** The parts of the canvas panels cover, in CSS pixels: the ring is centred in what is left. */
export interface RingFrame { left: number; right: number; top: number; bottom: number }

export interface RingCallbacks {
  /** The pointer came onto something or left it; x and y in the canvas's CSS pixels. */
  onHover: (hit: RingHit, x: number, y: number) => void;
  onMove: (x: number, y: number) => void;
  onOpen: (hit: Exclude<RingHit, null>) => void;
  /** The context is gone and did not come back. */
  onLost: () => void;
  /** A label's text for a cell a search lit. */
  nameOf?: (id: string) => string;
}

const CONTEXT_WAIT_MS = 4_000;
const SLOW_FRAME_MS = 34;
const REPLAY_S = 9;
const PICK_PX = 14;
const SPARK_S = 1.5;
const MAX_SPARKS = 48;
const NO_FRAME: RingFrame = { left: 0, right: 0, top: 0, bottom: 0 };
/** Host surfaces can override the ring's default label colours. */
const LABEL = "ring-label pointer-events-none whitespace-nowrap text-caption text-text";
const HIT_LABEL = "pointer-events-none max-w-56 truncate rounded border border-faint bg-star-panel px-2 py-0.5 text-caption text-text";

/** How many characters of a segment's word stand by the ring: a long project name is cut, and said whole in its tooltip. */
const LABEL_CHARS = 10;
const shortLabel = (text: string) => ([...text].length > LABEL_CHARS ? `${[...text].slice(0, LABEL_CHARS - 1).join("")}…` : text);

/** A token as a literal: a shader cannot read `var()`. */
function tokenColour(name: string): THREE.Color {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--star-${name}`).trim();
  const colour = new THREE.Color();
  try { colour.setStyle(value || "white"); } catch { colour.set("white"); }
  return colour;
}

const HALO_VERTEX = `attribute float size; attribute float alpha; attribute vec3 tint; varying float vAlpha; varying vec3 vTint; uniform float ratio;
  void main(){ vAlpha = alpha; vTint = tint; gl_PointSize = size * ratio; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const HALO_FRAGMENT = `varying float vAlpha; varying vec3 vTint;
  void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = (exp(-d * d * 9.0) + exp(-d * d * 2.2) * 0.45) * vAlpha; if (a < 0.003) discard; gl_FragColor = vec4(vTint * a, a); }`;
/** A link's own light: a resting glow, and while it flows a bright band that travels from its start to its end. */
const LINK_VERTEX = `attribute vec3 tint; attribute float along; attribute float seed; attribute float lit; attribute float flow; uniform float time;
  varying vec3 vTint; varying float vAlpha;
  void main(){ float band = flow > 0.5 ? pow(max(0.0, sin(6.2831853 * (along * 1.2 - time * 0.32 + seed))), 14.0) : 0.0;
    vAlpha = lit * (0.32 + 1.9 * band); vTint = tint; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const LINK_FRAGMENT = `varying vec3 vTint; varying float vAlpha; void main(){ gl_FragColor = vec4(vTint * vAlpha, vAlpha); }`;
const THREAD_VERTEX = `attribute vec3 tint; attribute float alpha; varying vec3 vTint; varying float vAlpha;
  void main(){ vTint = tint; vAlpha = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const THREAD_FRAGMENT = `varying vec3 vTint; varying float vAlpha; void main(){ gl_FragColor = vec4(vTint * vAlpha, vAlpha); }`;

interface Cell {
  spec: RingCell;
  index: number;
  angle: number;
  reach: number;
  colour: THREE.Color;
  lit: number;
  flash: number;
  /** Shown by the view, and not yet hidden by a replay. */
  visible: boolean;
  /** Its sparks' rhythm, from its id. */
  period: number;
  phase: number;
}
interface Particle { cell: number; cluster: number; base: THREE.Vector3; swirl: number; speed: number; wobble: number; size: number; colour: THREE.Color }
interface Link { from: string; to: string; points: Point[]; colour: THREE.Color; strength: number; flow: boolean; seed: number }
interface Spark { points: Point[]; start: number; colour: THREE.Color; target: number; targetId: string; from: string }

export class RingScene {
  readonly #host: HTMLElement;
  readonly #on: RingCallbacks;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #labels = new CSS2DRenderer();
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -4000, 4000);
  readonly #composer: EffectComposer;
  readonly #bloom: UnrealBloomPass;
  readonly #output = new OutputPass();
  /** The ring's own group: its origin the ring's centre, its unit the ring's radius. */
  readonly #ring = new THREE.Group();
  readonly #content = new THREE.Group();
  readonly #halo: THREE.ShaderMaterial;
  readonly #linkMaterial: THREE.ShaderMaterial;
  readonly #threadMaterial: THREE.ShaderMaterial;
  readonly #resize: ResizeObserver;
  readonly #sight: IntersectionObserver;
  readonly #clock = new THREE.Clock();
  readonly #tones = new Map<string, THREE.Color>();
  #spec: RingSpec = { segments: [], cells: [], clusters: [], links: [], particlesPerCell: 0, centre: { label: "", tone: "you" } };
  #layout: RingLayout = layoutRing({ segments: [], cells: [], clusters: [] });
  #cells: Cell[] = [];
  #byId = new Map<string, Cell>();
  #particles: Particle[] = [];
  #core: Particle[] = [];
  #links: Link[] = [];
  #sparks: Spark[] = [];
  #cellMesh: THREE.InstancedMesh | null = null;
  #tips: THREE.BufferGeometry | null = null;
  #cloud: THREE.BufferGeometry | null = null;
  #threads: THREE.BufferGeometry | null = null;
  #threadPairs: Array<[number, number]> = [];
  #linkGeometry: THREE.BufferGeometry | null = null;
  #flows: THREE.BufferGeometry | null = null;
  #sparkCloud: THREE.BufferGeometry | null = null;
  #coreHalo: THREE.BufferGeometry | null = null;
  #arcs: Array<{ id: string; mid: number; line: THREE.Line; label: CSS2DObject | null; code: HTMLElement | null; chars: { code: number; text: number } }> = [];
  #clusterLabels: CSS2DObject[] = [];
  #hitLabels: CSS2DObject[] = [];
  #sweep: THREE.Mesh | null = null;
  #view: RingView = { shown: null, hits: new Set(), selected: null };
  #hover: RingHit = null;
  #peek: string | null = null;
  #moving = true;
  #frame: RingFrame = NO_FRAME;
  #radius = 100;
  #time = 0;
  #lastSparkCheck = 0;
  #replay: { from: number; to: number; start: number; onDate: (at: number) => void; onEnd: () => void } | null = null;
  #cutoff: number | null = null;
  #raf = 0;
  #visible = true;
  #inView = true;
  #lostTimer: ReturnType<typeof setTimeout> | null = null;
  #lost = false;
  #bloomOn = true;
  #sampled = 0;
  #speedKnown = false;
  #sampleStart = 0;
  #down: [number, number] | null = null;

  constructor(host: HTMLElement, callbacks: RingCallbacks) {
    this.#host = host;
    this.#on = callbacks;
    this.#renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", failIfMajorPerformanceCaveat: true });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#renderer.toneMapping = THREE.NoToneMapping;
    host.appendChild(this.#renderer.domElement);
    Object.assign(this.#labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    host.appendChild(this.#labels.domElement);

    this.#scene.background = this.#tone("ground");
    this.#camera.position.set(0, 0, 1000);
    this.#scene.add(this.#ring);
    this.#ring.add(this.#content);
    this.#addSky();

    const additive = { transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending };
    this.#halo = new THREE.ShaderMaterial({ ...additive, uniforms: { ratio: { value: this.#renderer.getPixelRatio() } }, vertexShader: HALO_VERTEX, fragmentShader: HALO_FRAGMENT });
    this.#linkMaterial = new THREE.ShaderMaterial({ ...additive, uniforms: { time: { value: 0 } }, vertexShader: LINK_VERTEX, fragmentShader: LINK_FRAGMENT });
    this.#threadMaterial = new THREE.ShaderMaterial({ ...additive, vertexShader: THREAD_VERTEX, fragmentShader: THREAD_FRAGMENT });
    this.#addInstrument();

    this.#composer = new EffectComposer(this.#renderer);
    this.#composer.addPass(new RenderPass(this.#scene, this.#camera));
    this.#bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.0, 0.6, 0.16);
    this.#composer.addPass(this.#bloom);
    this.#composer.addPass(this.#output);

    const canvas = this.#renderer.domElement;
    canvas.addEventListener("pointermove", this.#onPointerMove);
    canvas.addEventListener("pointerleave", this.#onPointerLeave);
    canvas.addEventListener("pointerdown", this.#onPointerDown);
    canvas.addEventListener("pointerup", this.#onPointerUp);
    canvas.addEventListener("webglcontextlost", this.#onContextLost);
    canvas.addEventListener("webglcontextrestored", this.#onContextRestored);
    document.addEventListener("visibilitychange", this.#onVisibility);
    this.#resize = new ResizeObserver(() => this.#fit());
    this.#resize.observe(host);
    this.#sight = new IntersectionObserver((entries) => { this.#inView = entries.some((entry) => entry.isIntersecting); this.#schedule(); });
    this.#sight.observe(host);
    this.#fit();
    this.#schedule();
  }

  #tone(name: string): THREE.Color {
    let colour = this.#tones.get(name);
    if (!colour) { colour = tokenColour(name); this.#tones.set(name, colour); }
    return colour;
  }

  /** A field of faint stars behind everything: the same ones every time. */
  #addSky() {
    const count = 1400;
    const positions = new Float32Array(count * 3);
    const tints = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    const colour = new THREE.Color();
    for (let i = 0; i < count; i += 1) {
      positions.set([(unitHash(`sky${i}`, 1) - 0.5) * 4000, (unitHash(`sky${i}`, 2) - 0.5) * 2400, -500], i * 3);
      colour.setHSL(0.58 + unitHash(`sky${i}`, 4) * 0.1, 0.5, 0.6);
      tints.set([colour.r, colour.g, colour.b], i * 3);
      sizes[i] = 1.2 + unitHash(`sky${i}`, 5) * 1.6;
      alphas[i] = 0.12 + unitHash(`sky${i}`, 6) * 0.3;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("tint", new THREE.BufferAttribute(tints, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("alpha", new THREE.BufferAttribute(alphas, 1));
    const sky = new THREE.Points(geometry, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { ratio: { value: this.#renderer.getPixelRatio() } },
      vertexShader: HALO_VERTEX, fragmentShader: HALO_FRAGMENT,
    }));
    sky.frustumCulled = false;
    this.#scene.add(sky);
  }

  /** The instrument round the ring: guide circles, the tick ring, a dashed outer circle and the sweep. Drawn once. */
  #addInstrument() {
    const dim = this.#tone("hub").clone().multiplyScalar(0.22);
    const circle = (radius: number, colour: THREE.Color, opacity: number, dashed = false) => {
      const points = Array.from({ length: 241 }, (_, i) => new THREE.Vector3(...polar((i / 240) * TAU, radius), 0));
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = dashed
        ? new THREE.LineDashedMaterial({ color: colour, transparent: true, opacity, dashSize: 0.012, gapSize: 0.024 })
        : new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity });
      const line = new THREE.Line(geometry, material);
      if (dashed) line.computeLineDistances();
      this.#ring.add(line);
    };
    circle(RING.guide, dim, 0.9);
    circle(RING.cell - 0.012, dim, 0.7);
    circle(RING.ticks, dim, 0.9);
    circle(RING.ticks + 0.06, dim, 0.8, true);
    const ticks: THREE.Vector3[] = [];
    for (let degree = 0; degree < 360; degree += 2) {
      const angle = (degree / 360) * TAU;
      const reach = degree % 30 === 0 ? 0.045 : 0.018;
      ticks.push(new THREE.Vector3(...polar(angle, RING.ticks), 0), new THREE.Vector3(...polar(angle, RING.ticks + reach), 0));
    }
    this.#ring.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks), new THREE.LineBasicMaterial({ color: dim, transparent: true, opacity: 0.9 })));
    // The sweep: a soft wedge that turns while something is under way.
    const wedge = new THREE.CircleGeometry(RING.cell - 0.02, 48, Math.PI / 2 - 0.5, 0.5);
    const tint = this.#tone("hub");
    const sweep = new THREE.Mesh(wedge, new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.06, depthWrite: false, blending: THREE.AdditiveBlending }));
    sweep.visible = false;
    this.#sweep = sweep;
    this.#ring.add(sweep);
  }

  #points(count: number, material = this.#halo): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, count) * 3), 3));
    geometry.setAttribute("tint", new THREE.BufferAttribute(new Float32Array(Math.max(1, count) * 3), 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(new Float32Array(Math.max(1, count)), 1));
    geometry.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(Math.max(1, count)), 1));
    geometry.setDrawRange(0, count);
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.#content.add(points);
    return geometry;
  }

  /** Everything the spec says: drawn anew. */
  setData(spec: RingSpec) {
    // A spark in flight keeps flying to its cell across a new reading: only a cell the new spec no longer holds loses it.
    const flying = this.#sparks.map((spark) => ({ id: spark.targetId, from: spark.from, start: spark.start }));
    this.#clear();
    this.#spec = spec;
    const layout = layoutRing(spec);
    this.#layout = layout;
    const segmentTone = new Map(spec.segments.map((segment) => [segment.id, segment.tone]));
    const clusterSegments = new Map(spec.clusters.map((cluster) => [cluster.id, cluster.segment]));

    // ---- the cells: thin bars standing out of the ring ----
    this.#cells = spec.cells.filter((cell) => layout.angles.has(cell.id)).map((cell, index) => ({
      spec: cell, index, angle: layout.angles.get(cell.id) as number, reach: cellReach(cell.length), colour: this.#tone(cell.tone),
      lit: 1, flash: 0, visible: true, period: 3.6 + unitHash(cell.id, 21) * 3.2, phase: unitHash(cell.id, 22),
    }));
    this.#byId = new Map(this.#cells.map((cell) => [cell.spec.id, cell]));
    const bar = new THREE.PlaneGeometry(1, 1);
    bar.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(bar, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, toneMapped: false }), Math.max(1, this.#cells.length));
    mesh.count = this.#cells.length;
    mesh.frustumCulled = false;
    this.#cellMesh = mesh;
    this.#content.add(mesh);
    this.#tips = this.#points(this.#cells.length);

    // ---- the arcs and the labels ----
    const counts = new Map<string, number>();
    for (const cell of this.#cells) counts.set(cell.spec.segment, (counts.get(cell.spec.segment) ?? 0) + 1);
    this.#arcs = layout.segments.map((placed) => {
      const segment = spec.segments.find((item) => item.id === placed.id);
      const steps = Math.max(2, Math.ceil((placed.a1 - placed.a0) / 0.02));
      const points = Array.from({ length: steps + 1 }, (_, i) => new THREE.Vector3(...polar(placed.a0 + ((placed.a1 - placed.a0) * i) / steps, RING.arc), 0));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: this.#tone(segmentTone.get(placed.id) ?? "hub"), transparent: true, opacity: 0.6 }));
      this.#content.add(line);
      let label: CSS2DObject | null = null;
      let code: HTMLElement | null = null;
      // A count nothing reported reads “—”, never 0 (a stage nobody reached is not a stage that did nothing).
      const held = segment?.count ?? counts.get(placed.id) ?? 0;
      const number = held > 0 ? String(held) : "—";
      if (segment) {
        const element = document.createElement("div");
        element.className = LABEL;
        if (segment.code) {
          code = document.createElement("span");
          code.className = "ring-label-code mr-1.5 font-mono text-text-3";
          code.textContent = segment.code;
          element.appendChild(code);
        }
        element.appendChild(document.createTextNode(shortLabel(segment.label)));
        const count = document.createElement("span");
        count.className = "ring-label-count ml-1.5 tabular-nums text-text-2";
        count.textContent = number;
        element.appendChild(count);
        label = new CSS2DObject(element);
        this.#content.add(label);
      }
      // Widths in caption pixels: a Han character is about a line high, Latin and digits about half of one.
      const wide = (text: string) => [...text].reduce((sum, char) => sum + (/[\u2e80-\uffff]/.test(char) ? 12.5 : 7.2), 0);
      return { id: placed.id, mid: placed.mid, line, label, code, chars: { code: segment?.code ? wide(segment.code) + 6 : 0, text: wide(`${shortLabel(segment?.label ?? "")}${number}`) + 6 } };
    });
    // The radius depends on the labels' widths: fit again, which places the labels too.
    this.#fit();

    // ---- the clouds: each cell's own light in its segment, each cluster's, and the centre's ----
    this.#particles = [];
    const perCell = Math.max(0, Math.floor(spec.particlesPerCell));
    for (const cell of this.#cells) {
      const placed = layout.segments.find((segment) => segment.id === cell.spec.segment);
      if (!placed) continue;
      const spread = 0.06 + 0.11 * Math.sqrt(Math.min(1, (placed.a1 - placed.a0) / Math.PI));
      for (let k = 0; k < perCell; k += 1) {
        const salt = `${cell.spec.id}#${k}`;
        const radius = spread * Math.sqrt(-2 * Math.log(Math.max(1e-6, unitHash(salt, 1)))) * 0.5;
        const theta = unitHash(salt, 2) * TAU;
        this.#particles.push({
          cell: cell.index, cluster: -1,
          base: new THREE.Vector3(placed.anchor[0] + Math.cos(theta) * radius, placed.anchor[1] + Math.sin(theta) * radius, (unitHash(salt, 3) - 0.5) * 0.2),
          swirl: unitHash(salt, 4) * TAU, speed: (unitHash(salt, 5) - 0.5) * 0.5, wobble: 0.004 + unitHash(salt, 6) * 0.012, size: 3 + unitHash(salt, 7) * 5, colour: cell.colour,
        });
      }
    }
    spec.clusters.forEach((cluster, index) => {
      const at = layout.clusters.get(cluster.id);
      if (!at) return;
      const count = Math.max(10, Math.min(140, Math.round(cluster.mass)));
      for (let k = 0; k < count; k += 1) {
        const salt = `${cluster.id}#${k}`;
        const radius = 0.05 * Math.sqrt(-2 * Math.log(Math.max(1e-6, unitHash(salt, 1))));
        const theta = unitHash(salt, 2) * TAU;
        this.#particles.push({
          cell: -1, cluster: index, base: new THREE.Vector3(at[0] + Math.cos(theta) * radius, at[1] + Math.sin(theta) * radius, (unitHash(salt, 3) - 0.5) * 0.12),
          swirl: unitHash(salt, 4) * TAU, speed: (unitHash(salt, 5) - 0.5) * 0.7, wobble: 0.003 + unitHash(salt, 6) * 0.01, size: 3.5 + unitHash(salt, 7) * 5, colour: this.#tone(cluster.tone),
        });
      }
      if (cluster.label) {
        const element = document.createElement("div");
        element.className = LABEL;
        element.textContent = cluster.label;
        const label = new CSS2DObject(element);
        label.position.set(at[0], at[1] - 0.075, 0);
        this.#content.add(label);
        this.#clusterLabels.push(label);
      }
    });
    this.#cloud = this.#points(this.#particles.length);
    // Each particle's thread to its nearest neighbour of the same light: the cloud's neural look, moving with it.
    this.#threadPairs = [];
    const groups = new Map<string, number[]>();
    this.#particles.forEach((particle, index) => {
      const key = particle.cell >= 0 ? `s:${this.#cells[particle.cell].spec.segment}` : `c:${particle.cluster}`;
      groups.set(key, [...(groups.get(key) ?? []), index]);
    });
    for (const members of groups.values()) {
      members.forEach((index, position) => {
        let best = -1;
        let bestDistance = Infinity;
        for (let step = 1; step <= 8 && position + step < members.length; step += 1) {
          const other = members[position + step];
          const d = this.#particles[index].base.distanceTo(this.#particles[other].base);
          if (d < bestDistance) { best = other; bestDistance = d; }
        }
        if (best >= 0 && bestDistance < 0.12) this.#threadPairs.push([index, best]);
      });
    }
    const threads = new THREE.BufferGeometry();
    threads.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, this.#threadPairs.length) * 6), 3));
    threads.setAttribute("tint", new THREE.BufferAttribute(new Float32Array(Math.max(1, this.#threadPairs.length) * 6), 3));
    threads.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(Math.max(1, this.#threadPairs.length) * 2), 1));
    threads.setDrawRange(0, this.#threadPairs.length * 2);
    const threadLines = new THREE.LineSegments(threads, this.#threadMaterial);
    threadLines.frustumCulled = false;
    this.#content.add(threadLines);
    this.#threads = threads;

    this.#core = Array.from({ length: 260 }, (_, k) => {
      const salt = `core#${k}`;
      const radius = RING.core * Math.sqrt(-2 * Math.log(Math.max(1e-6, unitHash(salt, 1)))) * 0.5;
      const theta = unitHash(salt, 2) * TAU;
      return {
        cell: -1, cluster: -1, base: new THREE.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, (unitHash(salt, 3) - 0.5) * RING.core * 1.6),
        swirl: 0, speed: 0, wobble: 0.004, size: 2 + unitHash(salt, 7) * 3.5, colour: this.#tone(spec.centre.tone).clone().lerp(new THREE.Color(1, 1, 1), 0.5),
      };
    });
    this.#coreHalo = this.#points(this.#core.length + 1);
    if (spec.centre.label) {
      const element = document.createElement("div");
      element.className = LABEL;
      element.textContent = spec.centre.label;
      const label = new CSS2DObject(element);
      label.position.set(0, -RING.core - 0.06, 0);
      this.#content.add(label);
      this.#clusterLabels.push(label);
    }

    // ---- the links, sampled once; their light moves in the shader ----
    this.#links = spec.links.flatMap((link) => {
      const points = linkPath(layout, link.from, link.to, clusterSegments);
      return points ? [{ from: link.from, to: link.to, points, colour: this.#tone(link.tone), strength: link.strength, flow: link.flow, seed: unitHash(link.id, 31) }] : [];
    });
    const segmentsPerLink = 28;
    const geometry = new THREE.BufferGeometry();
    const size = Math.max(1, this.#links.length * segmentsPerLink * 2);
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(size * 3), 3));
    geometry.setAttribute("tint", new THREE.BufferAttribute(new Float32Array(size * 3), 3));
    geometry.setAttribute("along", new THREE.BufferAttribute(new Float32Array(size), 1));
    geometry.setAttribute("seed", new THREE.BufferAttribute(new Float32Array(size), 1));
    geometry.setAttribute("flow", new THREE.BufferAttribute(new Float32Array(size), 1));
    geometry.setAttribute("lit", new THREE.BufferAttribute(new Float32Array(size), 1));
    this.#links.forEach((link, l) => {
      for (let s = 0; s < link.points.length - 1; s += 1) {
        for (let end = 0; end < 2; end += 1) {
          const v = (l * segmentsPerLink + s) * 2 + end;
          const [x, y] = link.points[s + end];
          geometry.attributes.position.setXYZ(v, x, y, 0);
          geometry.attributes.tint.setXYZ(v, link.colour.r, link.colour.g, link.colour.b);
          geometry.attributes.along.setX(v, (s + end) / (link.points.length - 1));
          geometry.attributes.seed.setX(v, link.seed);
          geometry.attributes.flow.setX(v, link.flow ? 1 : 0);
        }
      }
    });
    geometry.setDrawRange(0, this.#links.length * segmentsPerLink * 2);
    const lines = new THREE.LineSegments(geometry, this.#linkMaterial);
    lines.frustumCulled = false;
    this.#content.add(lines);
    this.#linkGeometry = geometry;
    this.#flows = this.#points(this.#links.filter((link) => link.flow).length * 3);
    this.#sparkCloud = this.#points(MAX_SPARKS * 6);

    for (const spark of flying) {
      const cell = this.#byId.get(spark.id);
      if (cell) this.#launch(cell, spark.from, spark.start);
    }
    if (this.#sweep) this.#sweep.visible = Boolean(spec.live);
    // What the pointer or the keyboard held may be gone from what was just read.
    if (this.#hover && this.#hover.kind === "cell" && !this.#byId.has(this.#hover.id)) { this.#hover = null; this.#on.onHover(null, 0, 0); }
    if (this.#peek && !this.#byId.has(this.#peek)) { this.#peek = null; this.#on.onHover(null, 0, 0); }
    this.#paint();
    this.#paintHitLabels();
  }

  setView(view: RingView) {
    const before = this.#view;
    this.#view = view;
    this.#paint();
    if (view.hits !== before.hits || view.shown !== before.shown) this.#paintHitLabels();
  }

  /** Whether anything moves: off, the picture holds still and keeps everything it shows. */
  setMoving(moving: boolean) {
    this.#moving = moving;
    // A pause is no slow frame: the speed sample starts again with the motion, so a still minute never costs the bloom.
    this.#sampled = 0;
    if (!moving) {
      // Still: nothing is left half way. The sparks are gone, a flash is over, a replay holds its date until the picture moves again.
      this.#sparks = [];
      for (const cell of this.#cells) cell.flash = 0;
      this.#paintSparks();
    }
    this.#paint();
  }

  setFrame(frame: RingFrame) {
    this.#frame = frame;
    this.#fit();
  }

  /** A spark for something that just happened to a cell: a memory recalled, an operation begun. */
  pulse(cellId: string, from: string = "centre") {
    const cell = this.#byId.get(cellId);
    if (!cell || !cell.visible || !this.#moving) return;
    this.#launch(cell, from);
  }

  /** Light one cell from outside the canvas (the list a keyboard walks), with the tooltip at its place. */
  peek(id: string | null) {
    this.#peek = id;
    this.#paint();
    const cell = id ? this.#byId.get(id) : null;
    if (!cell) { this.#on.onHover(null, 0, 0); return; }
    const at = this.#toScreen(polar(cell.angle, RING.cell + cell.reach));
    this.#on.onHover({ kind: "cell", id: cell.spec.id }, at.x, at.y);
  }

  /** From the first cell to today, in nine seconds. False when no cell says when it began. */
  replay(onDate: (at: number) => void, onEnd: () => void): boolean {
    const from = replayStart(this.#cells.map((cell) => cell.spec));
    if (from === null) return false;
    const to = Math.max(Date.now(), ...this.#cells.map((cell) => cell.spec.at ?? 0));
    this.#replay = { from, to, start: this.#time, onDate, onEnd };
    this.#cutoff = from;
    this.#paint();
    this.#paintHitLabels();
    this.#schedule();
    return true;
  }

  stopReplay() {
    if (!this.#replay) return;
    const { onEnd } = this.#replay;
    this.#replay = null;
    this.#cutoff = null;
    this.#paint();
    this.#paintHitLabels();
    onEnd();
  }

  dispose() {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    if (this.#lostTimer) clearTimeout(this.#lostTimer);
    this.#resize.disconnect();
    this.#sight.disconnect();
    document.removeEventListener("visibilitychange", this.#onVisibility);
    const canvas = this.#renderer.domElement;
    canvas.removeEventListener("pointermove", this.#onPointerMove);
    canvas.removeEventListener("pointerleave", this.#onPointerLeave);
    canvas.removeEventListener("pointerdown", this.#onPointerDown);
    canvas.removeEventListener("pointerup", this.#onPointerUp);
    canvas.removeEventListener("webglcontextlost", this.#onContextLost);
    canvas.removeEventListener("webglcontextrestored", this.#onContextRestored);
    this.#clear();
    this.#scene.traverse((object) => {
      const held = object as THREE.Mesh;
      held.geometry?.dispose();
      const material = held.material as THREE.Material | undefined;
      material?.dispose();
    });
    this.#halo.dispose();
    this.#linkMaterial.dispose();
    this.#threadMaterial.dispose();
    this.#bloom.dispose();
    this.#output.dispose();
    this.#composer.dispose();
    this.#renderer.dispose();
    this.#renderer.forceContextLoss();
    canvas.remove();
    this.#labels.domElement.remove();
  }

  // ------------------------------------------------------------------------------------------------- painting a state

  /** The cells in focus: under the pointer or the keyboard, else the open drawer's, else what a search lit. */
  #focus(): Set<string> | null {
    const held: RingHit = this.#peek ? { kind: "cell", id: this.#peek } : this.#hover ?? (this.#view.selected ? { kind: "cell", id: this.#view.selected } : null);
    if (held) return neighbourhood(this.#spec, this.#layout, held);
    return this.#view.hits.size ? new Set(this.#view.hits) : null;
  }

  #paint() {
    const mesh = this.#cellMesh;
    const tips = this.#tips;
    if (!mesh || !tips) return;
    const focus = this.#focus();
    const held = this.#peek ?? (this.#hover?.kind === "cell" ? this.#hover.id : null) ?? this.#view.selected;
    const segmentFocus = this.#hover?.kind === "segment" ? this.#hover.id : null;
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    const colour = new THREE.Color();
    const axis = new THREE.Vector3(0, 0, 1);
    const width = Math.max(0.0035, Math.min(0.03, this.#layout.spacing * 0.58));
    const replaced = this.#tone("replaced");
    for (const cell of this.#cells) {
      const shown = !this.#view.shown || this.#view.shown.has(cell.spec.id);
      const born = this.#cutoff === null || cell.spec.at === null || cell.spec.at <= this.#cutoff;
      cell.visible = shown && born;
      cell.lit = cell.spec.id === held ? 2.4 : !focus ? 1 : focus.has(cell.spec.id) ? 1.7 : 0.16;
      const old = cell.spec.state === "replaced";
      const bright = old ? 0.28 : 0.25 + 0.75 * cell.spec.bright;
      const base = old ? replaced : cell.spec.state === "error" ? this.#tone("correction") : cell.colour;
      colour.copy(base).multiplyScalar(cell.visible ? bright * cell.lit * (1 + cell.flash * 1.6) : 0);
      const [x, y] = polar(cell.angle, RING.cell);
      position.set(x, y, 0);
      rotation.setFromAxisAngle(axis, -cell.angle);
      const grow = cell.visible ? 1 : 0;
      scale.set(width * (cell.lit > 1.5 ? 1.6 : 1) * grow, cell.reach * (1 + cell.flash * 0.35) * grow, 1);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(cell.index, matrix);
      mesh.setColorAt(cell.index, colour);
      const [tx, ty] = polar(cell.angle, RING.cell + cell.reach * (1 + cell.flash * 0.35) + 0.012);
      tips.attributes.position.setXYZ(cell.index, tx, ty, 0);
      tips.attributes.tint.setXYZ(cell.index, base.r, base.g, base.b);
      tips.attributes.size.setX(cell.index, (5 + 5 * cell.spec.bright) * (cell.lit > 1.5 ? 1.5 : 1) * (1 + cell.flash));
      tips.attributes.alpha.setX(cell.index, cell.visible ? Math.min(1.5, (old ? 0.12 : 0.15 + 0.6 * cell.spec.bright) * cell.lit * (1 + cell.flash * 2)) : 0);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    for (const name of ["position", "tint", "size", "alpha"]) tips.attributes[name].needsUpdate = true;

    if (this.#linkGeometry) {
      const lit = this.#linkGeometry.attributes.lit;
      this.#links.forEach((link, l) => {
        const ends = [this.#byId.get(link.from), this.#byId.get(link.to)];
        const gone = ends.some((cell) => cell && !cell.visible);
        const touched = focus ? focus.has(link.from) && focus.has(link.to) && (link.from === held || link.to === held || !held) : false;
        const segmentTouched = segmentFocus ? ends.some((cell) => cell?.spec.segment === segmentFocus) : false;
        const value = gone ? 0 : (touched || segmentTouched) ? Math.min(1.4, link.strength * 2.2 + 0.3) : (focus || segmentFocus) ? link.strength * 0.15 : link.strength;
        for (let v = 0; v < 56; v += 1) lit.setX(l * 56 + v, value);
      });
      lit.needsUpdate = true;
    }
    for (const arc of this.#arcs) {
      const material = arc.line.material as THREE.LineBasicMaterial;
      const on = segmentFocus === arc.id || (focus !== null && this.#layout.segments.find((segment) => segment.id === arc.id)?.cells.some((id) => focus.has(id)));
      material.opacity = on ? 1 : focus || segmentFocus ? 0.25 : 0.62;
      if (arc.label) arc.label.element.style.opacity = on || (!focus && !segmentFocus) ? "1" : "0.45";
    }
    // A still picture draws a frame for each change it is told of.
    this.#schedule();
  }

  /** What a search lit says its name beside the ring, the first dozen. */
  #paintHitLabels() {
    for (const label of this.#hitLabels) { this.#content.remove(label); label.element.remove(); }
    this.#hitLabels = [...this.#view.hits].slice(0, 12).flatMap((id) => {
      const cell = this.#byId.get(id);
      if (!cell || !cell.visible || this.#cutoff !== null) return [];
      const element = document.createElement("div");
      element.className = HIT_LABEL;
      element.textContent = this.#on.nameOf?.(id) ?? id;
      const label = new CSS2DObject(element);
      label.position.set(...polar(cell.angle, RING.cell + cell.reach + 0.12), 0);
      this.#content.add(label);
      return [label];
    });
  }

  #clear() {
    this.#content.traverse((object) => {
      const held = object as THREE.Mesh;
      if (object instanceof THREE.InstancedMesh) object.dispose();
      if (held.geometry) held.geometry.dispose();
      const material = held.material as THREE.Material | undefined;
      if (material && material !== this.#halo && material !== this.#linkMaterial && material !== this.#threadMaterial) material.dispose();
      if (object instanceof CSS2DObject) object.element.remove();
    });
    this.#content.clear();
    this.#cells = [];
    this.#byId = new Map();
    this.#particles = [];
    this.#core = [];
    this.#links = [];
    this.#sparks = [];
    this.#arcs = [];
    this.#clusterLabels = [];
    this.#hitLabels = [];
    this.#threadPairs = [];
    this.#cellMesh = null;
    this.#tips = this.#cloud = this.#threads = this.#linkGeometry = this.#flows = this.#sparkCloud = this.#coreHalo = null;
  }

  // ------------------------------------------------------------------------------------------------- the frame

  #fit() {
    const { clientWidth: width, clientHeight: height } = this.#host;
    if (!width || !height) return;
    this.#camera.left = -width / 2;
    this.#camera.right = width / 2;
    this.#camera.top = height / 2;
    this.#camera.bottom = -height / 2;
    this.#camera.updateProjectionMatrix();
    this.#renderer.setSize(width, height);
    this.#composer.setPixelRatio(this.#renderer.getPixelRatio());
    this.#composer.setSize(width, height);
    this.#labels.setSize(width, height);
    this.#halo.uniforms.ratio.value = this.#renderer.getPixelRatio();
    const { left, right, top, bottom } = this.#frame;
    const across = Math.max(80, width - left - right);
    const down = Math.max(80, height - top - bottom);
    // The labels at the sides read across the ring and reach out by their own width, which the frame must hold too: the ring gives up
    // radius until the widest of them fits beside it, and until the tick circle fits above and below.
    const widest = Math.max(0, ...this.#arcs.filter((arc) => arc.label).map((arc) => arc.chars.code + arc.chars.text));
    const byWidth = (across / 2 - widest * 0.9 - 8) / (RING.label + 0.1);
    const byHeight = down / 2 / RING.reach;
    this.#radius = Math.max(40, Math.min(byWidth, byHeight));
    this.#ring.position.set((left - right) / 2, (bottom - top) / 2, 0);
    this.#ring.scale.setScalar(this.#radius);
    this.#placeLabels();
    this.#schedule();
  }

  /** The segments' labels where they do not overlap, for the ring's radius now (`placeLabels`). */
  #placeLabels() {
    const unit = 1 / Math.max(1, this.#radius);
    const placed = placeLabels(this.#arcs.filter((arc) => arc.label).map((arc) => ({
      id: arc.id, mid: arc.mid, width: (arc.chars.code + arc.chars.text) * unit, short: arc.chars.text * unit, height: 18 * unit,
    })));
    for (const place of placed) {
      const arc = this.#arcs.find((item) => item.id === place.id);
      if (!arc?.label) continue;
      // CSS2DRenderer shows and hides the element by `visible` on every frame.
      arc.label.visible = place.shown;
      if (arc.code) arc.code.style.display = place.full ? "" : "none";
      arc.label.position.set(place.x, place.y, 0);
    }
  }

  #toScreen([x, y]: Point) {
    const { clientWidth: width, clientHeight: height } = this.#host;
    return { x: width / 2 + this.#ring.position.x + x * this.#radius, y: height / 2 - (this.#ring.position.y + y * this.#radius) };
  }

  #toRing(px: number, py: number): Point {
    const { clientWidth: width, clientHeight: height } = this.#host;
    return [(px - width / 2 - this.#ring.position.x) / this.#radius, (height / 2 - py - this.#ring.position.y) / this.#radius];
  }

  // ------------------------------------------------------------------------------------------------- the pointer

  #at(event: PointerEvent): [number, number] {
    const box = this.#renderer.domElement.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }

  #pick(px: number, py: number): RingHit {
    const [x, y] = this.#toRing(px, py);
    const hit = ringHit(this.#layout, x, y, PICK_PX / this.#radius, this.#visibleCells());
    if (hit?.kind === "cell" && !this.#byId.get(hit.id)?.visible) return null;
    return hit;
  }

  #visibleCells(): Set<string> {
    return new Set(this.#cells.filter((cell) => cell.visible).map((cell) => cell.spec.id));
  }

  #onPointerMove = (event: PointerEvent) => {
    const [x, y] = this.#at(event);
    const hit = event.buttons === 0 ? this.#pick(x, y) : null;
    this.#renderer.domElement.style.cursor = hit && hit.kind !== "centre" ? "pointer" : "default";
    const same = JSON.stringify(hit) === JSON.stringify(this.#hover);
    if (same) { if (hit) this.#on.onMove(x, y); return; }
    this.#hover = hit;
    this.#paint();
    this.#on.onHover(hit, x, y);
  };

  #onPointerLeave = () => {
    if (this.#hover === null) return;
    this.#hover = null;
    this.#paint();
    this.#on.onHover(null, 0, 0);
  };

  #onPointerDown = (event: PointerEvent) => {
    this.#down = [event.clientX, event.clientY];
  };

  #onPointerUp = (event: PointerEvent) => {
    const down = this.#down;
    this.#down = null;
    if (!down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return;
    const [x, y] = this.#at(event);
    const hit = this.#pick(x, y);
    if (hit) this.#on.onOpen(hit);
  };

  #onContextLost = (event: Event) => {
    event.preventDefault();
    this.#lost = true;
    this.#stop();
    this.#lostTimer = setTimeout(() => this.#on.onLost(), CONTEXT_WAIT_MS);
  };

  #onContextRestored = () => {
    if (this.#lostTimer) clearTimeout(this.#lostTimer);
    this.#lostTimer = null;
    this.#lost = false;
    this.#schedule();
  };

  #onVisibility = () => {
    this.#visible = document.visibilityState !== "hidden";
    this.#schedule();
  };

  // ------------------------------------------------------------------------------------------------- the loop

  #stop() {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#sampled = 0;
  }

  #schedule() {
    if (!this.#visible || !this.#inView || this.#lost) { this.#stop(); return; }
    if (!this.#raf) { this.#clock.getDelta(); this.#raf = requestAnimationFrame(this.#tick); }
  }

  #tick = () => {
    this.#raf = 0;
    const delta = Math.min(0.1, this.#clock.getDelta());
    // Still, the clock stands still: the flow bands, the drift, the sparks, the flashes and a replay stop where they are.
    if (this.#moving) this.#time += delta;
    const t = this.#time;
    if (this.#moving) this.#advanceReplay();
    let flashing = false;
    if (this.#moving) for (const cell of this.#cells) if (cell.flash > 0) { cell.flash = Math.max(0, cell.flash - delta * 1.4); flashing = true; }
    if (flashing || (this.#moving && this.#replay)) this.#paint();
    if (this.#moving) this.#scheduleSparks(t);
    this.#paintCloud(t);
    this.#paintFlows(t);
    this.#paintSparks();
    this.#linkMaterial.uniforms.time.value = t;
    if (this.#sweep?.visible) this.#sweep.rotation.z = -t * 0.9;
    if (this.#peek) {
      const cell = this.#byId.get(this.#peek);
      if (cell) { const at = this.#toScreen(polar(cell.angle, RING.cell + cell.reach)); this.#on.onMove(at.x, at.y); }
    }
    if (this.#bloomOn) this.#composer.render();
    else this.#renderer.render(this.#scene, this.#camera);
    this.#labels.render(this.#scene, this.#camera);
    this.#watchSpeed();
    // A still picture needs no frames once it is painted; `#paint` asks for one for each change it is told of.
    if (this.#moving) this.#schedule();
  };

  #paintCloud(t: number) {
    const cloud = this.#cloud;
    const threads = this.#threads;
    if (!cloud || !threads) return;
    const places = cloud.attributes.position;
    this.#particles.forEach((particle, index) => {
      const cell = particle.cell >= 0 ? this.#cells[particle.cell] : null;
      const cluster = particle.cluster >= 0 ? this.#spec.clusters[particle.cluster] : null;
      const live = Boolean(cluster?.live);
      const pace = live ? 2.2 : 1;
      const swirl = particle.swirl + t * particle.speed * pace;
      places.setXYZ(index, particle.base.x + Math.cos(swirl) * particle.wobble * 2, particle.base.y + Math.sin(swirl * 1.3) * particle.wobble * 2, particle.base.z);
      cloud.attributes.tint.setXYZ(index, particle.colour.r, particle.colour.g, particle.colour.b);
      cloud.attributes.size.setX(index, particle.size * (cell ? 1 + cell.flash : live ? 1.15 : 1));
      const seen = cell ? (cell.visible ? 1 : 0) : 1;
      const lit = cell ? cell.lit : 1;
      const breath = live ? 0.75 + 0.25 * Math.sin(t * 4 + particle.swirl) : 1;
      cloud.attributes.alpha.setX(index, seen * Math.min(1, (cell ? 0.2 + 0.5 * cell.spec.bright : 0.5) * Math.min(lit, 1.6) * breath * (cell?.spec.state === "replaced" ? 0.3 : 1)));
    });
    for (const name of ["position", "tint", "size", "alpha"]) cloud.attributes[name].needsUpdate = true;
    this.#threadPairs.forEach(([a, b], i) => {
      const particle = this.#particles[a];
      threads.attributes.position.setXYZ(i * 2, places.getX(a), places.getY(a), places.getZ(a));
      threads.attributes.position.setXYZ(i * 2 + 1, places.getX(b), places.getY(b), places.getZ(b));
      for (let end = 0; end < 2; end += 1) threads.attributes.tint.setXYZ(i * 2 + end, particle.colour.r, particle.colour.g, particle.colour.b);
      const alpha = Math.min(cloud.attributes.alpha.getX(a), cloud.attributes.alpha.getX(b)) * 0.35;
      threads.attributes.alpha.setX(i * 2, alpha);
      threads.attributes.alpha.setX(i * 2 + 1, alpha);
    });
    for (const name of ["position", "tint", "alpha"]) threads.attributes[name].needsUpdate = true;

    const halo = this.#coreHalo;
    if (!halo) return;
    const turn = t * 0.25;
    const cos = Math.cos(turn), sin = Math.sin(turn);
    const tone = this.#tone(this.#spec.centre.tone);
    this.#core.forEach((particle, index) => {
      // The centre's cloud turns in depth, so it reads as a body and not a disc.
      const x = particle.base.x * cos - particle.base.z * sin;
      const z = particle.base.x * sin + particle.base.z * cos;
      halo.attributes.position.setXYZ(index, x, particle.base.y, z);
      halo.attributes.tint.setXYZ(index, particle.colour.r, particle.colour.g, particle.colour.b);
      halo.attributes.size.setX(index, particle.size);
      halo.attributes.alpha.setX(index, 0.3 + 0.2 * Math.sin(t * 1.7 + index));
    });
    const last = this.#core.length;
    halo.attributes.position.setXYZ(last, 0, 0, 0);
    halo.attributes.tint.setXYZ(last, tone.r, tone.g, tone.b);
    halo.attributes.size.setX(last, Math.max(36, this.#radius * 0.32));
    halo.attributes.alpha.setX(last, 0.55 + 0.12 * Math.sin(t * 1.3));
    for (const name of ["position", "tint", "size", "alpha"]) halo.attributes[name].needsUpdate = true;
  }

  /** A bead of light travelling each flowing link, with a short tail, from its start to its end. */
  #paintFlows(t: number) {
    const flows = this.#flows;
    if (!flows || !this.#linkGeometry) return;
    const lit = this.#linkGeometry.attributes.lit;
    let index = 0;
    this.#links.forEach((link, l) => {
      if (!link.flow) return;
      const strength = lit.getX(l * 56);
      const k = (t * 0.12 + link.seed) % 1;
      for (let tail = 0; tail < 3; tail += 1) {
        const [x, y] = along(link.points, Math.max(0, k - tail * 0.025));
        flows.attributes.position.setXYZ(index, x, y, 0);
        flows.attributes.tint.setXYZ(index, link.colour.r, link.colour.g, link.colour.b);
        flows.attributes.size.setX(index, tail ? 4.5 - tail : 7);
        flows.attributes.alpha.setX(index, strength * (tail ? 0.45 / tail : 1) * Math.sin(Math.PI * k));
        index += 1;
      }
    });
    for (const name of ["position", "tint", "size", "alpha"]) flows.attributes[name].needsUpdate = true;
  }

  /** The cells that send sparks of their own (a recall lately, an operation under way) send one each period. */
  #scheduleSparks(t: number) {
    const before = this.#lastSparkCheck;
    this.#lastSparkCheck = t;
    if (this.#replay) return;
    for (const cell of this.#cells) {
      if (!cell.spec.spark || !cell.visible) continue;
      const beats = Math.floor((t + cell.phase * cell.period) / cell.period) - Math.floor((before + cell.phase * cell.period) / cell.period);
      if (beats > 0 && t > 0.5) this.#launch(cell, "centre");
    }
  }

  #launch(cell: Cell, from: string, start = this.#time) {
    const origin = this.#layout.clusters.has(from) ? from : "centre";
    const points = sparkPath(this.#layout, cell.spec.id, origin);
    if (!points || this.#sparks.length >= MAX_SPARKS) return;
    this.#sparks.push({ points, start, colour: this.#tone("spark").clone().lerp(cell.colour, 0.35), target: cell.index, targetId: cell.spec.id, from: origin });
    this.#schedule();
  }

  #paintSparks() {
    const cloud = this.#sparkCloud;
    if (!cloud) return;
    let index = 0;
    this.#sparks = this.#sparks.filter((spark) => {
      const cell = this.#cells[spark.target];
      // A cell the view has since hidden takes no spark: it would fly to an empty place.
      if (!cell || !cell.visible) return false;
      const k = (this.#time - spark.start) / SPARK_S;
      if (k >= 1) {
        cell.flash = 1;
        this.#paint();
        return false;
      }
      const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      for (let tail = 0; tail < 6; tail += 1) {
        const [x, y] = along(spark.points, Math.max(0, eased - tail * 0.03));
        cloud.attributes.position.setXYZ(index, x, y, 0.05);
        cloud.attributes.tint.setXYZ(index, spark.colour.r, spark.colour.g, spark.colour.b);
        cloud.attributes.size.setX(index, tail ? 9 - tail : 15);
        cloud.attributes.alpha.setX(index, (tail ? 0.6 / tail : 1.2) * Math.min(1, k * 6));
        index += 1;
      }
      return true;
    });
    for (let rest = index; rest < MAX_SPARKS * 6; rest += 1) cloud.attributes.alpha.setX(rest, 0);
    for (const name of ["position", "tint", "size", "alpha"]) cloud.attributes[name].needsUpdate = true;
  }

  #advanceReplay() {
    if (!this.#replay) return;
    const { from, to, start, onDate } = this.#replay;
    const k = Math.min(1, (this.#time - start) / REPLAY_S);
    const before = this.#cutoff ?? from;
    const cutoff = from + (to - from) * k;
    this.#cutoff = cutoff;
    for (const cell of this.#cells) {
      const at = cell.spec.at;
      // A cell born now flashes; it gets its spark only if the view shows its kind (hidden is not the same as not born yet).
      const shown = !this.#view.shown || this.#view.shown.has(cell.spec.id);
      if (at !== null && at > before && at <= cutoff && shown) { cell.flash = 1; this.#launch(cell, "centre"); }
    }
    onDate(cutoff);
    if (k >= 1) this.stopReplay();
  }

  /** The first sixty frames on screen say whether this machine holds the picture; if not it gives up the bloom and the density, once. */
  #watchSpeed() {
    if (!this.#bloomOn || this.#speedKnown) return;
    if (this.#sampled === 0) this.#sampleStart = performance.now();
    this.#sampled += 1;
    if (this.#sampled < 60) return;
    this.#speedKnown = true;
    if ((performance.now() - this.#sampleStart) / this.#sampled <= SLOW_FRAME_MS) return;
    this.#bloomOn = false;
    this.#renderer.setPixelRatio(1);
    this.#fit();
  }
}
