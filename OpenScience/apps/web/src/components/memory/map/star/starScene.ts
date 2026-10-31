import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { unitHash } from "@/components/charts/map/layout";
import type { MapEdge, MapNode } from "@/lib/memoryMapClient";
import {
  YOU_HUB, brightnessOf, familyOf, fibresOf, homeDistance, isRecentlyRecalled, layoutStars, markAt, nearestMark, neighboursOf, replayStart, sizeOf, STAR_FAMILIES,
  type FibreKind, type Point3, type ScreenMark, type StarFamily, type StarFibre, type StarLayout, type StarShape,
} from "./starModel";

/**
 * The star map's painting, and nothing about what it means: `starModel.ts` decides, this draws, and `StarCanvas.tsx` holds it in the page. It is its own chunk with three.js
 * and the post-processing passes, so nobody who does not open the picture pays for them.
 *
 * Hidden knowledge:
 *
 * - **Instanced cells, one bloom.** One instanced mesh per shape; brightness is the instance's colour, and the bloom picks up what is bright, so a dim memory has no halo
 *   with no second material. Selective bloom on instances is a known trap, and this needs none.
 * - **The wheel belongs to the page.** A picture that takes the wheel traps a reader scrolling a long page, so it zooms on Ctrl/⌘ + wheel (a trackpad pinch is that
 *   too) and on the plain wheel only full-screen.
 * - **It stops when nobody is looking**: scrolled away or a hidden tab costs no frames. A machine that cannot hold the frame rate loses the bloom and the high-density
 *   pixels once, after the first second, and keeps the picture.
 * - **A lost context is a normal event** (a sleeping GPU, too many tabs): it is given the chance to come back and, after `CONTEXT_WAIT_MS`, the page goes to the relation graph.
 */

export interface StarView {
  /** The marks the selection keeps: everything else stands where it stands, unseen. */
  shown: ReadonlySet<string>;
  /** What the search lit. */
  hits: ReadonlySet<string>;
  /** The mark whose drawer is open. */
  selected: string | null;
  hiddenFamilies: ReadonlySet<StarFamily>;
}

export interface StarCallbacks {
  /** The pointer came onto a mark or left it; x and y in the canvas's CSS pixels. */
  onHover: (node: MapNode | null, x: number, y: number) => void;
  onMove: (x: number, y: number) => void;
  onOpen: (node: MapNode) => void;
  /** The context is gone and did not come back. */
  onLost: () => void;
}

const CONTEXT_WAIT_MS = 4_000;
const FOV = 52;
const SEGMENTS = 10;
const REPLAY_MS = 9_000;
const SLOW_FRAME_MS = 34;
/** Where the camera looks from the start: a little above the centre, so the picture stands below the legend over it. */
const HOME_TARGET = new THREE.Vector3(0, 46, 0);
const LABEL = "pointer-events-none whitespace-nowrap rounded border border-faint bg-star-panel px-2 py-0.5 text-caption text-text";

/** A token as a literal: a shader cannot read `var()`. */
function tokenColour(name: string): THREE.Color {
  return new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(`--star-${name}`).trim() || "#ffffff");
}
const FAMILY_TOKEN: Readonly<Record<StarFamily, string>> = {
  about: "about", preference: "preference", correction: "correction", fact: "fact", decision: "decision", method: "method", document: "document", entity: "entity",
};

const GEOMETRY: Readonly<Record<StarShape, () => THREE.BufferGeometry>> = {
  ball: () => new THREE.IcosahedronGeometry(1, 1),
  crystal: () => new THREE.OctahedronGeometry(1.25, 0),
  pyramid: () => new THREE.TetrahedronGeometry(1.35, 0),
  sheet: () => new THREE.BoxGeometry(1.5, 1.9, 0.35),
};

interface Mark {
  node: MapNode;
  position: THREE.Vector3;
  family: StarFamily;
  base: THREE.Color;
  size: number;
  bright: number;
  turn: THREE.Quaternion;
  mesh: THREE.InstancedMesh;
  slot: number;
  index: number;
  lit: number;
  flash: number;
  state: "absent" | "current" | "replaced";
}
interface Fibre { kind: FibreKind; spec: StarFibre; curve: THREE.QuadraticBezierCurve3; from: Mark | null; to: Mark | null; start: THREE.Color; end: THREE.Color }
interface Hub { id: string; node: MapNode; kind: "you" | "project"; position: THREE.Vector3; size: number; core: THREE.Mesh; membrane: THREE.Mesh; colour: THREE.Color }
type Cloud = THREE.BufferGeometry;

const point = (at: Point3) => new THREE.Vector3(at[0], at[1], at[2]);

export class StarScene {
  readonly #host: HTMLElement;
  readonly #on: StarCallbacks;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #labels = new CSS2DRenderer();
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(FOV, 1, 1, 7000);
  readonly #controls: OrbitControls;
  readonly #composer: EffectComposer;
  readonly #bloom: UnrealBloomPass;
  readonly #root = new THREE.Group();
  readonly #halo: THREE.ShaderMaterial;
  readonly #tokens: Record<string, THREE.Color>;
  readonly #resize: ResizeObserver;
  readonly #sight: IntersectionObserver;
  readonly #clock = new THREE.Clock();
  #marks: Mark[] = [];
  #byId = new Map<string, Mark>();
  #hubs: Hub[] = [];
  #fibres: Fibre[] = [];
  #specs: StarFibre[] = [];
  #sparks: Fibre[] = [];
  #cellHalo: Cloud | null = null;
  #sparkHalo: Cloud | null = null;
  #hubHalo: Cloud | null = null;
  #fibreGeometry: THREE.BufferGeometry | null = null;
  #hitLabels: CSS2DObject[] = [];
  #layout: StarLayout | null = null;
  #view: StarView = { shown: new Set(), hits: new Set(), selected: null, hiddenFamilies: new Set() };
  #hover: string | null = null;
  #peek: string | null = null;
  #hubGlow = 1;
  #rotating = true;
  #framed = false;
  #flight: { from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; start: number } | null = null;
  #replay: { from: number; to: number; start: number; onDate: (at: number) => void; onEnd: () => void } | null = null;
  #cutoff: number | null = null;
  #frame = 0;
  #visible = true;
  #inView = true;
  #lostTimer: ReturnType<typeof setTimeout> | null = null;
  #lost = false;
  #bloomOn = true;
  #sampled = 0;
  #sampleStart = 0;
  #down: [number, number] | null = null;
  #now = Date.now();

  constructor(host: HTMLElement, callbacks: StarCallbacks) {
    this.#host = host;
    this.#on = callbacks;
    this.#renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", failIfMajorPerformanceCaveat: true });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(this.#renderer.domElement);
    Object.assign(this.#labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    host.appendChild(this.#labels.domElement);

    this.#tokens = Object.fromEntries(["ground", "you", "hub", "replaced", "line-replaces", "line-conflicts", "line-rests", "line-relates", "spark", ...Object.values(FAMILY_TOKEN)].map((name) => [name, tokenColour(name)]));
    this.#scene.background = this.#tokens.ground;
    this.#scene.fog = new THREE.FogExp2(this.#tokens.ground.getHex(), 0.00045);
    this.#scene.add(this.#root);
    this.#scene.add(new THREE.AmbientLight(0xb8c4ff, 1.1));
    const head = new THREE.DirectionalLight(0xffffff, 2.2);
    head.position.set(0.4, 0.8, 1);
    this.#camera.add(head);
    this.#scene.add(this.#camera);
    this.#scene.add(new THREE.PointLight(this.#tokens.you, 3.5, 420, 1.2));
    this.#addSky();

    this.#halo = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { scale: { value: 500 } },
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 tint; varying float vAlpha; varying vec3 vTint; uniform float scale;
        void main(){ vAlpha = alpha; vTint = tint; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vAlpha; varying vec3 vTint;
        void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = (exp(-d * d * 9.0) + exp(-d * d * 2.2) * 0.45) * vAlpha; if (a < 0.003) discard; gl_FragColor = vec4(vTint * a, a); }`,
    });

    this.#controls = new OrbitControls(this.#camera, this.#renderer.domElement);
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.06;
    this.#controls.autoRotateSpeed = 0.35;
    this.#controls.enableZoom = false;
    this.#controls.minDistance = 60;

    this.#composer = new EffectComposer(this.#renderer);
    this.#composer.addPass(new RenderPass(this.#scene, this.#camera));
    this.#bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.95, 0.5, 0.16);
    this.#composer.addPass(this.#bloom);
    this.#composer.addPass(new OutputPass());

    const canvas = this.#renderer.domElement;
    canvas.addEventListener("pointermove", this.#onPointerMove);
    canvas.addEventListener("pointerleave", this.#onPointerLeave);
    canvas.addEventListener("pointerdown", this.#onPointerDown);
    canvas.addEventListener("pointerup", this.#onPointerUp);
    canvas.addEventListener("wheel", this.#onWheel, { passive: false });
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

  /** A sky of its own: the same stars every time, far beyond the fog. */
  #addSky() {
    const count = 3200;
    const positions = new Float32Array(count * 3);
    const colours = new Float32Array(count * 3);
    const colour = new THREE.Color();
    for (let i = 0; i < count; i += 1) {
      const id = `sky${i}`;
      const y = 2 * unitHash(id, 1) - 1;
      const r = Math.sqrt(1 - y * y);
      const a = unitHash(id, 2) * Math.PI * 2;
      const far = 1400 + unitHash(id, 3) * 1600;
      positions.set([Math.cos(a) * r * far, y * far, Math.sin(a) * r * far], i * 3);
      colour.setHSL(0.58 + unitHash(id, 4) * 0.12, 0.5, 0.55 + unitHash(id, 5) * 0.4);
      colours.set([colour.r, colour.g, colour.b], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("tint", new THREE.BufferAttribute(colours, 3));
    const sky = new THREE.Points(geometry, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { size: { value: 2.4 * this.#renderer.getPixelRatio() } },
      vertexShader: "attribute vec3 tint; varying vec3 vTint; uniform float size; void main(){ vTint = tint; gl_PointSize = size; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "varying vec3 vTint; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.1, d) * 0.5; if (a < 0.01) discard; gl_FragColor = vec4(vTint * a, a); }",
    }));
    sky.frustumCulled = false;
    this.#scene.add(sky);
  }

  #cloud(count: number): Cloud {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute("tint", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(new Float32Array(count), 1));
    geometry.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(count), 1));
    const points = new THREE.Points(geometry, this.#halo);
    points.frustumCulled = false;
    this.#root.add(points);
    return geometry;
  }

  /** Everything the document says: drawn anew, the camera left where the reader put it. */
  setData(nodes: readonly MapNode[], edges: readonly MapEdge[], now: number) {
    this.#clear();
    this.#now = now;
    const layout = layoutStars(nodes, edges);
    this.#layout = layout;
    const nodeOf = new Map(nodes.map((node) => [node.id, node]));

    // ---- hubs: a bright nucleus in a slowly turning membrane ----
    this.#hubs = layout.hubs.map((hub) => {
      const colour = hub.kind === "you" ? this.#tokens.you : this.#tokens.hub;
      const position = point(hub.position);
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(hub.size, 3), new THREE.MeshBasicMaterial({ color: colour.clone().multiplyScalar(1.6) }));
      core.position.copy(position);
      const membrane = new THREE.Mesh(new THREE.IcosahedronGeometry(hub.size * 2.1, 1), new THREE.MeshBasicMaterial({ color: colour, wireframe: true, transparent: true, opacity: 0.18 }));
      membrane.position.copy(position);
      this.#root.add(core, membrane);
      const element = document.createElement("div");
      element.className = LABEL;
      element.textContent = hub.label;
      const label = new CSS2DObject(element);
      label.position.copy(position).add(new THREE.Vector3(hub.size * 1.6, hub.size * 0.4, 0));
      this.#root.add(label);
      return { id: hub.id, node: nodeOf.get(hub.id) ?? { id: hub.id, type: hub.kind, label: hub.label }, kind: hub.kind, position, size: hub.size, core, membrane, colour };
    });
    this.#hubHalo = this.#cloud(this.#hubs.length);
    this.#hubs.forEach((hub, index) => {
      (this.#hubHalo as Cloud).attributes.position.setXYZ(index, hub.position.x, hub.position.y, hub.position.z);
      (this.#hubHalo as Cloud).attributes.tint.setXYZ(index, hub.colour.r, hub.colour.g, hub.colour.b);
      (this.#hubHalo as Cloud).attributes.size.setX(index, hub.size * (hub.kind === "you" ? 7.5 : 8));
    });

    // ---- the cells ----
    const marks = nodes.filter((node) => familyOf(node) && layout.positions.has(node.id));
    const shapes = new Map<StarShape, MapNode[]>();
    for (const node of marks) {
      const shape = STAR_FAMILIES[familyOf(node) as StarFamily].shape;
      shapes.set(shape, [...(shapes.get(shape) ?? []), node]);
    }
    this.#marks = [];
    for (const [shape, members] of shapes) {
      const mesh = new THREE.InstancedMesh(GEOMETRY[shape](), new THREE.MeshPhongMaterial({ color: 0xffffff, flatShading: true, shininess: 90, specular: 0x666677, emissive: 0x111522 }), members.length);
      mesh.frustumCulled = false;
      this.#root.add(mesh);
      members.forEach((node, slot) => {
        const family = familyOf(node) as StarFamily;
        this.#marks.push({
          node, family, mesh, slot, index: this.#marks.length, position: point(layout.positions.get(node.id) as Point3), base: this.#tokens[FAMILY_TOKEN[family]],
          size: sizeOf(node), bright: brightnessOf(node), turn: new THREE.Quaternion().setFromEuler(new THREE.Euler(unitHash(node.id, 1) * 6, unitHash(node.id, 2) * 6, 0)),
          lit: 1, flash: 0, state: "current",
        });
      });
    }
    this.#byId = new Map(this.#marks.map((mark) => [mark.node.id, mark]));
    this.#cellHalo = this.#cloud(this.#marks.length);

    // ---- the lines ----
    this.#specs = fibresOf(nodes, edges, layout);
    const curveOf = (from: THREE.Vector3, to: THREE.Vector3, salt: string) => {
      const middle = from.clone().add(to).multiplyScalar(0.5);
      const reach = from.distanceTo(to) * 0.28;
      middle.add(new THREE.Vector3(unitHash(salt, 7) - 0.5, unitHash(salt, 8) - 0.5, unitHash(salt, 9) - 0.5).multiplyScalar(reach));
      return new THREE.QuadraticBezierCurve3(from.clone(), middle, to.clone());
    };
    const lineColour = (kind: FibreKind) => this.#tokens[kind === "replaces" ? "line-replaces" : kind === "conflicts" ? "line-conflicts" : kind === "rests-on" ? "line-rests" : "line-relates"];
    this.#fibres = this.#specs.map((spec) => {
      const from = this.#byId.get(spec.from) ?? null;
      const to = this.#byId.get(spec.to) ?? null;
      const start = spec.kind === "axon" ? (spec.from === YOU_HUB ? this.#tokens.you : this.#tokens.hub) : spec.kind === "trunk" ? this.#tokens.you : lineColour(spec.kind);
      const end = spec.kind === "axon" ? to?.base ?? this.#tokens.hub : spec.kind === "trunk" ? this.#tokens.hub : lineColour(spec.kind);
      return { kind: spec.kind, spec, from, to, start, end, curve: curveOf(point(layout.positions.get(spec.from) as Point3), point(layout.positions.get(spec.to) as Point3), `${spec.from}>${spec.to}`) };
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.#fibres.length * SEGMENTS * 6), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.#fibres.length * SEGMENTS * 6), 3));
    this.#fibres.forEach((fibre, f) => {
      const along = fibre.curve.getPoints(SEGMENTS);
      for (let s = 0; s < SEGMENTS; s += 1) {
        geometry.attributes.position.setXYZ((f * SEGMENTS + s) * 2, along[s].x, along[s].y, along[s].z);
        geometry.attributes.position.setXYZ((f * SEGMENTS + s) * 2 + 1, along[s + 1].x, along[s + 1].y, along[s + 1].z);
      }
    });
    this.#fibreGeometry = geometry;
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    lines.frustumCulled = false;
    this.#root.add(lines);

    // ---- what was recalled lately sends a spark down its axon ----
    this.#sparks = this.#fibres.filter((fibre) => fibre.kind === "axon" && fibre.to && isRecentlyRecalled(fibre.to.node, now));
    this.#sparkHalo = this.#cloud(this.#sparks.length * 2);

    if (!this.#framed) { this.#framed = true; this.#placeHome(false); }
    this.#paint();
  }

  /** What the selection, the search and the legend say about the picture. */
  setView(view: StarView) {
    const before = this.#view;
    this.#view = view;
    this.#paint();
    if (view.hits !== before.hits || view.shown !== before.shown) this.#paintHitLabels();
    if (view.selected !== before.selected) {
      this.#shiftView(Boolean(view.selected));
      if (view.selected) this.#flyToMark(view.selected);
    } else if (view.hits !== before.hits && view.hits.size > 0 && !view.selected) {
      this.#flyToHits(view.hits);
    }
  }

  setRotating(rotating: boolean) {
    this.#rotating = rotating;
  }

  /** The way the picture began. */
  home() {
    this.#placeHome(true);
  }

  /** Light one mark from outside the canvas (the list a keyboard walks), with the tooltip at its place. */
  peek(id: string | null) {
    this.#peek = id;
    this.#paint();
    const mark = id ? this.#byId.get(id) : null;
    if (!mark) { this.#on.onHover(null, 0, 0); return; }
    const direction = this.#camera.position.clone().sub(mark.position).normalize();
    this.#fly(mark.position.clone().addScaledVector(direction, 300), mark.position.clone());
    const at = this.#toScreen(mark.position);
    this.#on.onHover(mark.node, at.x, at.y);
  }

  /** From the first mark to today, in nine seconds. Returns false when no mark says when it began. */
  replay(onDate: (at: number) => void, onEnd: () => void): boolean {
    const from = replayStart(this.#marks.map((mark) => mark.node));
    if (from === null) return false;
    this.#replay = { from, to: this.#now, start: performance.now(), onDate, onEnd };
    this.#cutoff = from;
    this.#paint();
    return true;
  }

  stopReplay() {
    if (!this.#replay) return;
    const { onEnd } = this.#replay;
    this.#replay = null;
    this.#cutoff = null;
    this.#paint();
    onEnd();
  }

  dispose() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    if (this.#lostTimer) clearTimeout(this.#lostTimer);
    this.#resize.disconnect();
    this.#sight.disconnect();
    document.removeEventListener("visibilitychange", this.#onVisibility);
    const canvas = this.#renderer.domElement;
    canvas.removeEventListener("pointermove", this.#onPointerMove);
    canvas.removeEventListener("pointerleave", this.#onPointerLeave);
    canvas.removeEventListener("pointerdown", this.#onPointerDown);
    canvas.removeEventListener("pointerup", this.#onPointerUp);
    canvas.removeEventListener("wheel", this.#onWheel);
    canvas.removeEventListener("webglcontextlost", this.#onContextLost);
    canvas.removeEventListener("webglcontextrestored", this.#onContextRestored);
    this.#clear();
    this.#controls.dispose();
    this.#halo.dispose();
    this.#composer.dispose();
    this.#renderer.dispose();
    this.#renderer.forceContextLoss();
    canvas.remove();
    this.#labels.domElement.remove();
  }

  // ------------------------------------------------------------------------------------------------- painting a state

  /** The marks in focus: under the pointer or the keyboard, else in the open drawer, else what the search found. */
  #focus(): Set<string> | null {
    const held = this.#hover ?? this.#peek ?? this.#view.selected;
    if (held) return neighboursOf(held, this.#specs);
    return this.#view.hits.size ? new Set(this.#view.hits) : null;
  }

  #paint() {
    if (!this.#cellHalo || !this.#fibreGeometry) return;
    const focus = this.#focus();
    const held = this.#hover ?? this.#peek ?? this.#view.selected;
    this.#hubGlow = focus ? 0.22 : 1;
    for (const hub of this.#hubs) (hub.core.material as THREE.MeshBasicMaterial).color.copy(hub.colour).multiplyScalar(focus && !focus.has(hub.id) ? 0.55 : 1.6);
    const matrix = new THREE.Matrix4();
    const colour = new THREE.Color();
    const scale = new THREE.Vector3();
    for (const mark of this.#marks) {
      const seen = this.#view.shown.has(mark.node.id) && !this.#view.hiddenFamilies.has(mark.family);
      mark.state = seen ? markAt(mark.node, this.#cutoff) : "absent";
      mark.lit = mark.node.id === held ? 2.6 : !focus ? 1 : focus.has(mark.node.id) ? 1.9 : 0.14;
      const shown = mark.state === "absent" ? 0 : 1;
      const old = mark.state === "replaced";
      const bright = old ? 0.3 : 0.2 + 0.8 * (this.#cutoff === null ? mark.bright : Math.max(mark.bright, 0.7));
      colour.copy(old ? this.#tokens.replaced : mark.base).multiplyScalar(bright * mark.lit * (1 + mark.flash * 2));
      const size = mark.size * shown * (1 + mark.flash * 1.2) * (mark.lit > 1 ? 1.35 : mark.lit < 0.5 ? 0.6 : 1);
      matrix.compose(mark.position, mark.turn, scale.set(size, size, size));
      mark.mesh.setMatrixAt(mark.slot, matrix);
      mark.mesh.setColorAt(mark.slot, colour);
      const halo = this.#cellHalo;
      halo.attributes.position.setXYZ(mark.index, mark.position.x, mark.position.y, mark.position.z);
      const tint = old ? this.#tokens.replaced : mark.base;
      halo.attributes.tint.setXYZ(mark.index, tint.r, tint.g, tint.b);
      halo.attributes.size.setX(mark.index, mark.size * (mark.node.type === "entity" ? 4.5 : 4.2) * (1 + mark.flash) * (mark.lit > 1 ? 1.5 : 1));
      halo.attributes.alpha.setX(mark.index, shown * Math.min(1.4, (old ? 0.1 : 0.06 + 0.42 * mark.bright) * mark.lit * (1 + mark.flash * 3)));
    }
    for (const mesh of new Set(this.#marks.map((mark) => mark.mesh))) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const name of ["position", "tint", "size", "alpha"]) this.#cellHalo.attributes[name].needsUpdate = true;

    const colours = this.#fibreGeometry.attributes.color;
    this.#fibres.forEach((fibre, f) => {
      let strength = 0.55;
      if (fibre.kind === "axon") {
        const mark = fibre.to as Mark;
        strength = (mark.state === "absent" ? 0 : 1) * (0.05 + 0.26 * mark.bright) * Math.min(mark.lit, 2.2);
      } else if (fibre.kind !== "trunk") {
        const ends = [fibre.from, fibre.to].filter((mark): mark is Mark => mark !== null);
        const gone = ends.some((mark) => mark.state === "absent") || (this.#cutoff !== null && fibre.spec.at ? Date.parse(fibre.spec.at) > this.#cutoff : false);
        const lit = ends.length ? Math.max(...ends.map((mark) => mark.lit)) : 1;
        const low = ends.length ? Math.min(...ends.map((mark) => mark.lit)) : 1;
        const base = fibre.kind === "replaces" || fibre.kind === "conflicts" ? 0.95 : fibre.kind === "rests-on" ? 0.2 : 0.12;
        strength = gone ? 0 : base * Math.min(lit, 2.2) * (low < 0.5 ? 0.3 : 1);
      } else if (focus) {
        strength = 0.2;
      }
      for (let s = 0; s < SEGMENTS; s += 1) {
        colour.copy(fibre.start).lerp(fibre.end, s / SEGMENTS).multiplyScalar(strength);
        colours.setXYZ((f * SEGMENTS + s) * 2, colour.r, colour.g, colour.b);
        colour.copy(fibre.start).lerp(fibre.end, (s + 1) / SEGMENTS).multiplyScalar(strength);
        colours.setXYZ((f * SEGMENTS + s) * 2 + 1, colour.r, colour.g, colour.b);
      }
    });
    colours.needsUpdate = true;
  }

  /** What the search lit says its name on the picture, the first dozen. */
  #paintHitLabels() {
    for (const label of this.#hitLabels) { this.#root.remove(label); label.element.remove(); }
    this.#hitLabels = [...this.#view.hits].slice(0, 12).flatMap((id) => {
      const mark = this.#byId.get(id);
      if (!mark || mark.state === "absent") return [];
      const element = document.createElement("div");
      element.className = LABEL;
      element.textContent = mark.node.label;
      const label = new CSS2DObject(element);
      label.position.copy(mark.position).add(new THREE.Vector3(mark.size * 1.6, mark.size, 0));
      this.#root.add(label);
      return [label];
    });
  }

  #clear() {
    this.#root.traverse((object) => {
      const held = object as THREE.Mesh;
      if (object instanceof THREE.InstancedMesh) object.dispose();
      if (held.geometry) held.geometry.dispose();
      const material = held.material as THREE.Material | undefined;
      if (material && material !== this.#halo) material.dispose();
      if (object instanceof CSS2DObject) object.element.remove();
    });
    this.#root.clear();
    this.#hitLabels = [];
    this.#marks = [];
    this.#hubs = [];
    this.#fibres = [];
    this.#specs = [];
    this.#sparks = [];
    this.#byId = new Map();
    this.#cellHalo = this.#sparkHalo = this.#hubHalo = null;
    this.#fibreGeometry = null;
  }

  // ------------------------------------------------------------------------------------------------- the camera

  #homePose() {
    const reach = this.#layout?.reach ?? 300;
    const distance = homeDistance(reach, FOV, this.#camera.aspect);
    this.#controls.maxDistance = distance * 2.6;
    return new THREE.Vector3(0.16, 0.44, 1).normalize().multiplyScalar(distance);
  }

  #placeHome(animated: boolean) {
    const pose = this.#homePose();
    if (animated) { this.#fly(pose.clone().add(HOME_TARGET), HOME_TARGET.clone()); return; }
    this.#camera.position.copy(pose).add(HOME_TARGET);
    this.#controls.target.copy(HOME_TARGET);
  }

  #fly(to: THREE.Vector3, toTarget: THREE.Vector3) {
    this.#flight = { from: this.#camera.position.clone(), to, fromTarget: this.#controls.target.clone(), toTarget, start: performance.now() };
  }

  #flyToMark(id: string) {
    const mark = this.#byId.get(id);
    if (!mark) return;
    const direction = this.#camera.position.clone().sub(mark.position).normalize();
    this.#fly(mark.position.clone().addScaledVector(direction, 300), mark.position.clone());
  }

  #flyToHits(hits: ReadonlySet<string>) {
    const places = [...hits].map((id) => this.#byId.get(id)?.position).filter((place): place is THREE.Vector3 => Boolean(place));
    if (!places.length) return;
    const centre = places.reduce((sum, place) => sum.add(place), new THREE.Vector3()).divideScalar(places.length);
    const direction = this.#camera.position.clone().sub(centre).normalize();
    this.#fly(centre.clone().addScaledVector(direction, places.length > 6 ? 460 : 300), centre);
  }

  /** With a drawer open the picture's centre moves left, so the mark in focus is not under it. */
  #shiftView(on: boolean) {
    const { clientWidth: width, clientHeight: height } = this.#host;
    if (on && width > 1000) this.#camera.setViewOffset(width, height, Math.round(width * 0.14), 0, width, height);
    else this.#camera.clearViewOffset();
    this.#camera.updateProjectionMatrix();
  }

  #fit() {
    const { clientWidth: width, clientHeight: height } = this.#host;
    if (!width || !height) return;
    this.#camera.aspect = width / height;
    if (this.#camera.view?.enabled) this.#shiftView(true);
    this.#camera.updateProjectionMatrix();
    this.#renderer.setSize(width, height);
    this.#composer.setPixelRatio(this.#renderer.getPixelRatio());
    this.#composer.setSize(width, height);
    this.#labels.setSize(width, height);
    this.#halo.uniforms.scale.value = height * 0.9 * this.#renderer.getPixelRatio();
    this.#schedule();
  }

  // ------------------------------------------------------------------------------------------------- the pointer

  #toScreen(at: THREE.Vector3) {
    const projected = at.clone().project(this.#camera);
    const { clientWidth: width, clientHeight: height } = this.#host;
    return { x: ((projected.x + 1) / 2) * width, y: ((1 - projected.y) / 2) * height, depth: projected.z };
  }

  #pick(x: number, y: number): MapNode | null {
    const height = this.#host.clientHeight;
    const unit = height / (2 * Math.tan((FOV * Math.PI) / 360));
    const screen: ScreenMark[] = [];
    const add = (id: string, at: THREE.Vector3, size: number) => {
      const place = this.#toScreen(at);
      if (place.depth >= 1) return;
      screen.push({ id, x: place.x, y: place.y, depth: place.depth, radius: (size * unit) / Math.max(1, at.distanceTo(this.#camera.position)) });
    };
    for (const hub of this.#hubs) add(hub.id, hub.position, hub.size);
    for (const mark of this.#marks) if (mark.state !== "absent") add(mark.node.id, mark.position, mark.size);
    const id = nearestMark(screen, x, y);
    return id ? this.#byId.get(id)?.node ?? this.#hubs.find((hub) => hub.id === id)?.node ?? null : null;
  }

  #at(event: PointerEvent): [number, number] {
    const box = this.#renderer.domElement.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }

  #onPointerMove = (event: PointerEvent) => {
    const [x, y] = this.#at(event);
    const node = event.buttons === 0 ? this.#pick(x, y) : null;
    const id = node?.id ?? null;
    this.#renderer.domElement.style.cursor = id ? "pointer" : "grab";
    if (id === this.#hover) { if (id) this.#on.onMove(x, y); return; }
    this.#hover = id;
    this.#paint();
    this.#on.onHover(node, x, y);
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
    const node = this.#pick(x, y);
    if (node) this.#on.onOpen(node);
  };

  #onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey && !document.fullscreenElement) return;
    event.preventDefault();
    const offset = this.#camera.position.clone().sub(this.#controls.target);
    const distance = Math.max(this.#controls.minDistance, Math.min(this.#controls.maxDistance, offset.length() * Math.exp(event.deltaY * 0.0015)));
    this.#camera.position.copy(this.#controls.target).addScaledVector(offset.normalize(), distance);
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
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  }

  #schedule() {
    if (!this.#visible || !this.#inView || this.#lost) { this.#stop(); return; }
    if (!this.#frame) { this.#clock.getDelta(); this.#frame = requestAnimationFrame(this.#tick); }
  }

  #tick = () => {
    this.#frame = 0;
    const t = this.#clock.getElapsedTime();
    this.#advanceFlight();
    this.#advanceReplay();
    let flashing = false;
    for (const mark of this.#marks) if (mark.flash > 0) { mark.flash = Math.max(0, mark.flash - 0.03); flashing = true; }
    if (flashing || this.#replay) this.#paint();
    this.#advanceSparks(t);
    // What a keyboard has lit keeps its words beside it while the camera comes round to it.
    if (this.#peek) {
      const mark = this.#byId.get(this.#peek);
      if (mark) { const at = this.#toScreen(mark.position); this.#on.onMove(at.x, at.y); }
    }
    this.#hubs.forEach((hub, index) => {
      hub.membrane.rotation.y = t * 0.12 * (index % 2 ? -1 : 1);
      hub.membrane.rotation.x = t * 0.05;
      this.#hubHalo?.attributes.alpha.setX(index, this.#hubGlow * (hub.kind === "you" ? 0.8 : 0.55) * (0.85 + 0.15 * Math.sin(t * 1.4 + index)));
    });
    if (this.#hubHalo) for (const name of ["position", "tint", "size", "alpha"]) this.#hubHalo.attributes[name].needsUpdate = true;
    // A slowly turning picture stops for a reader who has found something: a mark moving away under the pointer cannot be pressed.
    this.#controls.autoRotate = this.#rotating && !this.#hover && !this.#peek && !this.#view.selected && !this.#flight;
    this.#controls.update();
    if (this.#bloomOn) this.#composer.render();
    else this.#renderer.render(this.#scene, this.#camera);
    this.#labels.render(this.#scene, this.#camera);
    this.#watchSpeed();
    this.#schedule();
  };

  #advanceFlight() {
    if (!this.#flight) return;
    const k = Math.min(1, (performance.now() - this.#flight.start) / 1_100);
    const eased = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    this.#camera.position.lerpVectors(this.#flight.from, this.#flight.to, eased);
    this.#controls.target.lerpVectors(this.#flight.fromTarget, this.#flight.toTarget, eased);
    if (k >= 1) this.#flight = null;
  }

  #advanceReplay() {
    if (!this.#replay) return;
    const { from, to, start, onDate } = this.#replay;
    const k = Math.min(1, (performance.now() - start) / REPLAY_MS);
    const before = this.#cutoff ?? from;
    const cutoff = from + (to - from) * k;
    this.#cutoff = cutoff;
    for (const mark of this.#marks) {
      const at = Date.parse(mark.node.at ?? "");
      if (Number.isFinite(at) && at > before && at <= cutoff) mark.flash = 1;
    }
    onDate(cutoff);
    if (k >= 1) this.stopReplay();
  }

  #advanceSparks(t: number) {
    const halo = this.#sparkHalo;
    if (!halo) return;
    this.#sparks.forEach((fibre, i) => {
      const mark = fibre.to as Mark;
      const period = 2.4 + unitHash(mark.node.id, 21) * 1.6;
      const phase = ((t + unitHash(mark.node.id, 22) * period) % period) / period;
      const on = mark.state !== "absent" && mark.lit > 0.5 ? 1 : 0;
      for (let j = 0; j < 2; j += 1) {
        const place = fibre.curve.getPoint(Math.max(0, phase - j * 0.06));
        halo.attributes.position.setXYZ(i * 2 + j, place.x, place.y, place.z);
        halo.attributes.tint.setXYZ(i * 2 + j, this.#tokens.spark.r, this.#tokens.spark.g, this.#tokens.spark.b);
        halo.attributes.size.setX(i * 2 + j, j ? 7 : 11);
        halo.attributes.alpha.setX(i * 2 + j, on * (j ? 0.45 : 1) * Math.sin(Math.PI * phase));
      }
    });
    for (const name of ["position", "tint", "size", "alpha"]) halo.attributes[name].needsUpdate = true;
  }

  /** The first sixty frames on screen say whether this machine holds the picture; if not it gives up the bloom and the density, once. */
  #watchSpeed() {
    if (!this.#bloomOn) return;
    if (this.#sampled === 0) this.#sampleStart = performance.now();
    this.#sampled += 1;
    if (this.#sampled < 60) return;
    const average = (performance.now() - this.#sampleStart) / this.#sampled;
    this.#sampled = 0;
    if (average <= SLOW_FRAME_MS) return;
    this.#bloomOn = false;
    this.#renderer.setPixelRatio(1);
    this.#fit();
  }
}
