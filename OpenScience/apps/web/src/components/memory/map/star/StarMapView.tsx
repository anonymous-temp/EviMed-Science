import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { FolderKanban, Layers, Maximize, Minimize, Pause, Play, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useBlockHeadingLevel } from "@/components/ui/Section";
import type { RingHandle, RingDescribe } from "@/components/charts/ring/RingCanvas";
import type { RingHit } from "@/components/charts/ring/ringModel";
import type { RingFrame, RingView } from "@/components/charts/ring/ringScene";
import { formatDate, formatDay, formatNumber } from "@/lib/format";
import type { MapNode, MemoryMap } from "@/lib/memoryMapClient";
import { markKindWord, relationTitle, STRUCTURE, type NarrowedMap } from "../mapModel";
import type { GraphActions } from "../GraphView";
import { MemoryRingPanels } from "./MemoryRingPanels";
import { StarBoundary } from "./StarBoundary";
import { freshSignals, memoryRingSpec, ringMarks, type RingBy } from "./memoryRing";
import { encodingWords, familyCounts, familyOf, freshnessWord, replayStart, type StarFamily } from "./starModel";

const RingCanvas = lazy(() => import("@/components/charts/ring/RingCanvas"));

/** Literal, so the stylesheet's scan finds each colour. */
export const FAMILY_DOT: Readonly<Record<StarFamily, string>> = {
  person: "bg-star-entity", note: "bg-star-document", about: "bg-star-about", preference: "bg-star-preference", correction: "bg-star-correction", fact: "bg-star-fact",
  decision: "bg-star-decision", method: "bg-star-method", document: "bg-star-document", entity: "bg-star-entity",
};

/** How often a full-screen ring reads the document again, so what happens in a conversation reaches it. */
const REFRESH_MS = 60_000;
/** Under this width the legend stands over the ring and not beside it. */
const BESIDE_FROM = 760;
/** Full screen, the instrument's two columns and its figures need this much width to leave the ring its room; under it the card keeps its column. */
const PANELS_FROM = 1100;
const NO_FRAME: RingFrame = { left: 0, right: 0, top: 0, bottom: 0 };

/** A box's place inside the card, kept current as either changes size. */
function useInset(card: RefObject<HTMLElement | null>, part: RefObject<HTMLElement | null>, active: boolean): DOMRect | null {
  const [box, setBox] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!active || !card.current || !part.current || typeof ResizeObserver === "undefined") { setBox(null); return undefined; }
    const measure = () => {
      if (!card.current || !part.current) return;
      const outer = card.current.getBoundingClientRect();
      const inner = part.current.getBoundingClientRect();
      setBox(new DOMRect(inner.left - outer.left, inner.top - outer.top, inner.width, inner.height));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(card.current);
    watch.observe(part.current);
    return () => watch.disconnect();
  }, [card, part, active]);
  return box;
}

/**
 * 「记忆星环」: what the person's memory holds, as one ring at the head of 总览 — the page's one brand moment (DESIGN.md, owner 2026-10-31 and
 * 2026-11-26). A cell for each thing remembered, standing in its kind's segment (or, switched, its project's) in the order it was written:
 * long when it weighs much, bright when it is new or used, grey when it was replaced; inside, each segment's cloud of its cells' own light;
 * between them the relations the document holds, with light travelling along them; and a spark from the centre to a memory a conversation
 * was handed lately, or the moment one is written or recalled while the page is open.
 *
 * A dark window in either scheme, by `data-theme="dark"` on the card: inside it every token already answers for the dark ground, so its controls
 * are the page's own. Every cell hands its selection to the overview, which shows its preview or opens its drawer. The page's selection decides
 * what is shown and the search what is lit, as for the relation graph; which kinds the legend has turned off is this card's own. Full screen, the
 * card becomes the instrument the owner asked for: the kinds down the left, the last day's activity and the memory's log on the right, the
 * figures along the bottom, the document read again each minute.
 *
 * Who does not see it (`useRingAllowed`, or a lost context through `onUnavailable`) gets the relation graph: the same document and the same
 * drawers. A keyboard walks the same cells in the list under the canvas (one tab stop, arrows, Enter), which is also what a screen reader reads;
 * the flow stops on one press, for WCAG 2.2.2 as much as for taste.
 *
 * Anatomy: animated ring, legend, view switch, motion controls, keyboard list; full screen adds the kinds, activity, log and figures.
 * Variants: embedded or full-screen, by kind or by project, with optional growth replay.
 * States: selected and hidden kinds follow the map data and the reader's controls.
 * Hit area: cells, segments and shared buttons own their interactive targets.
 * Keyboard: one listbox supports arrows, Home, End, Enter and Escape.
 * Long content: legend, log and controls wrap or scroll within the window.
 * Theme: fixed dark scientific canvas using the star palette and dark semantic roles.
 * Responsive: beside the legend from 760 px, under it below; full screen uses the viewport height, and its panels from 1100 px.
 * Verification: StarMapView tests, memoryRing tests and browser checks of WebGL, controls and fallback.
 */
export function StarMapView({ layoutDoc, narrowed, selected, actions, meta, onUnavailable, onRefresh }: {
  /** The whole document, which is where a cell's place comes from. */
  layoutDoc: Pick<MemoryMap, "nodes" | "edges" | "truncated"> & Partial<Pick<MemoryMap, "events" | "missing" | "facets">>;
  narrowed: NarrowedMap;
  selected: string | null;
  actions: GraphActions;
  /** The switch between the views. */
  meta?: ReactNode;
  onUnavailable: () => void;
  /** Read the document again: asked each minute while the ring is full screen. */
  onRefresh?: () => void;
}) {
  const Heading = `h${useBlockHeadingLevel()}` as "h2";
  const card = useRef<HTMLElement>(null);
  const side = useRef<HTMLDivElement>(null);
  const ring = useRef<RingHandle>(null);
  const [moving, setMoving] = useState(true);
  const [replaying, setReplaying] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const [by, setBy] = useState<RingBy>("kind");
  const [hidden, setHidden] = useState<ReadonlySet<StarFamily>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const events = useMemo(() => layoutDoc.events ?? [], [layoutDoc.events]);
  // The moment the document was read: a recall's three days and the log's hours are counted from it, and a new reading moves it.
  const [read, setRead] = useState(() => ({ doc: layoutDoc, at: Date.now() }));
  if (read.doc !== layoutDoc) setRead({ doc: layoutDoc, at: Date.now() });
  const now = read.at;

  useEffect(() => {
    const change = () => setFull(document.fullscreenElement === card.current);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  useLayoutEffect(() => {
    if (!card.current || typeof ResizeObserver === "undefined") return undefined;
    const watch = new ResizeObserver(() => setWidth(card.current?.clientWidth ?? 0));
    watch.observe(card.current);
    setWidth(card.current.clientWidth);
    return () => watch.disconnect();
  }, []);
  const toggleFull = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void card.current?.requestFullscreen(); };
  // A preview or drawer belongs to the page, so a press leaves full screen first.
  const open = useCallback((node: MapNode) => {
    if (document.fullscreenElement) void document.exitFullscreen();
    actions.onOpen(node);
  }, [actions]);

  // Full screen reads the document again each minute while the tab is seen: a memory written or recalled in a conversation arrives as a spark.
  useEffect(() => {
    if (!full || !onRefresh) return undefined;
    const timer = setInterval(() => { if (!document.hidden) onRefresh(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [full, onRefresh]);
  const before = useRef<{ nodes: MapNode[]; events: typeof events } | null>(null);
  useEffect(() => {
    const next = { nodes: layoutDoc.nodes, events };
    for (const cell of freshSignals(before.current, next)) ring.current?.pulse(cell);
    before.current = next;
  }, [layoutDoc.nodes, events]);

  const spec = useMemo(() => memoryRingSpec(layoutDoc.nodes, layoutDoc.edges, { by, now }), [layoutDoc.nodes, layoutDoc.edges, by, now]);
  const nodeOf = useMemo(() => new Map(layoutDoc.nodes.map((node) => [node.id, node])), [layoutDoc.nodes]);
  const shown = useMemo(() => new Set(narrowed.nodes.filter((node) => familyOf(node) && !hidden.has(familyOf(node) as StarFamily)).map((node) => node.id)), [narrowed.nodes, hidden]);
  const view = useMemo<RingView>(() => ({ shown, hits: narrowed.hits, selected }), [shown, narrowed.hits, selected]);
  const counts = useMemo(() => familyCounts(narrowed.nodes), [narrowed.nodes]);
  const encodings = useMemo(() => encodingWords(narrowed.nodes, now, narrowed.edges.some((edge) => edge.type !== "belongs-to")), [narrowed.nodes, narrowed.edges, now]);
  const canReplay = useMemo(() => replayStart(narrowed.nodes) !== null, [narrowed.nodes]);
  const toggleFamily = useCallback((family: StarFamily) => setHidden((held) => {
    const next = new Set(held);
    if (next.has(family)) next.delete(family); else next.add(family);
    return next;
  }), []);
  const replay = () => {
    if (replaying !== null) { ring.current?.stopReplay(); return; }
    const started = ring.current?.replay((at) => setReplaying(at), () => setReplaying(null));
    if (started) setMoving(true);
  };

  // ---- where the ring stands: beside the legend, under it on a narrow card, between the panels full screen ----
  const beside = width >= BESIDE_FROM;
  const panels = full && width >= PANELS_FROM;
  const sideBox = useInset(card, side, !panels);
  const frame = useMemo<RingFrame>(() => {
    if (panels) return { left: 330, right: 370, top: 64, bottom: 136 };
    if (!sideBox) return NO_FRAME;
    return beside ? { left: sideBox.x + sideBox.width + 12, right: 8, top: 8, bottom: 30 } : { left: 0, right: 0, top: sideBox.y + sideBox.height + 8, bottom: 30 };
  }, [panels, sideBox, beside]);

  const title = relationTitle(narrowed.nodes);
  const describe = useCallback<RingDescribe>((hit) => {
    if (hit.kind === "cell") {
      const node = nodeOf.get(hit.id);
      if (!node) return null;
      return { title: node.label, facts: [markKindWord(node), node.at ? formatDay(node.at) : "", freshnessWord(node), node.description ?? ""].filter(Boolean) };
    }
    if (hit.kind === "segment") {
      const segment = spec.segments.find((item) => item.id === hit.id);
      if (!segment) return null;
      const held = spec.cells.filter((cell) => cell.segment === segment.id && shown.has(cell.id)).length;
      return { title: segment.label, facts: [`${formatNumber(held)} 条`] };
    }
    if (hit.kind === "centre") return { title: spec.centre.label, facts: [title] };
    return null;
  }, [nodeOf, spec, shown, title]);
  const pressed = useCallback((hit: Exclude<RingHit, null>) => {
    if (hit.kind !== "cell") return;
    const node = nodeOf.get(hit.id);
    if (node) open(node);
  }, [nodeOf, open]);

  // ---- the same cells for a keyboard and a screen reader: one tab stop, the active one lit on the picture ----
  const listed = useMemo(() => ringMarks(narrowed.nodes)
    .filter((node) => !STRUCTURE.has(node.type) && !hidden.has(familyOf(node) as StarFamily))
    .slice().sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0)), [narrowed.nodes, hidden]);
  const walk = (event: React.KeyboardEvent) => {
    const at = listed.findIndex((node) => node.id === active);
    const move = (index: number) => {
      event.preventDefault();
      const next = listed[(index + listed.length) % listed.length];
      if (!next) return;
      setActive(next.id);
      ring.current?.peek(next.id);
    };
    if (event.key === "ArrowDown" || event.key === "ArrowRight") move(at + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") move(at < 0 ? -1 : at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(listed.length - 1);
    else if (event.key === "Enter" && at >= 0) { event.preventDefault(); open(listed[at]); }
    else if (event.key === "Escape") { setActive(null); ring.current?.peek(null); }
  };

  const controls = (
    <div className="flex flex-wrap gap-1 rounded-card border border-faint bg-star-panel p-1 backdrop-blur-md">
      {canReplay && <Button size="sm" variant="text" data-text-action="view" onClick={replay}>{replaying !== null ? <Square size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}{replaying !== null ? "停止回放" : "回放成长"}</Button>}
      <Button size="sm" variant="text" data-text-action="view" aria-pressed={!moving} onClick={() => setMoving((value) => !value)}>{moving ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}{moving ? "暂停流动" : "继续流动"}</Button>
      <Button size="sm" variant="text" data-text-action="view" aria-pressed={by === "project"} onClick={() => setBy((value) => (value === "kind" ? "project" : "kind"))}>{by === "kind" ? <FolderKanban size={16} aria-hidden="true" /> : <Layers size={16} aria-hidden="true" />}{by === "kind" ? "按项目分段" : "按类型分段"}</Button>
      <Button size="sm" variant="text" data-text-action="view" onClick={toggleFull}>{full ? <Minimize size={16} aria-hidden="true" /> : <Maximize size={16} aria-hidden="true" />}{full ? "退出全屏" : "全屏"}</Button>
    </div>
  );

  return (
    <section ref={card} data-theme="dark" data-chart="stars" aria-label="记忆星环" className="relative isolate min-w-0 overflow-hidden rounded-card border border-border bg-star-ground text-text" style={{ height: full ? "100vh" : "clamp(460px, 62vh, 660px)" }}>
      <StarBoundary onFailed={onUnavailable}>
        <Suspense fallback={<div role="img" aria-label={title} className="absolute inset-0" />}>
          <RingCanvas
            handle={ring} spec={spec} view={view} moving={moving} frame={frame} label={`记忆星环：${title}。同样的内容在下面的列表里。`}
            describe={describe} onOpen={pressed} onLost={onUnavailable}
          />
        </Suspense>
      </StarBoundary>

      {panels ? (
        <MemoryRingPanels
          nodes={layoutDoc.nodes} edges={layoutDoc.edges} events={events} missing={layoutDoc.missing} documentTypes={layoutDoc.facets?.documentTypes}
          now={now} counts={counts} hidden={hidden} onToggle={toggleFamily} title={title} controls={controls} meta={meta}
          onOpen={(id) => { const node = nodeOf.get(id); if (node) open(node); }}
        />
      ) : (
        // The legend and the controls stand in the card's head (T4): a column beside the ring, or a band over it on a narrow card.
        <div ref={side} className={`pointer-events-none absolute left-4 top-4 flex flex-col gap-2 ${beside ? "bottom-10 w-80" : "right-4"}`}>
          <div className="pointer-events-auto rounded-card border border-faint bg-star-panel px-4 py-3 backdrop-blur-md">
            <div className="text-caption text-text-3">记忆星环</div>
            <Heading className="mt-0.5 break-keep text-balance text-heading text-text">{title}</Heading>
            {counts.length > 0 && (
              <div role="group" aria-label="图例，按一下隐藏这一类" className="mt-2 flex flex-wrap gap-x-2 gap-y-1">
                {counts.map((entry) => (
                  <button
                    key={entry.family} type="button" aria-pressed={!hidden.has(entry.family)} onClick={() => toggleFamily(entry.family)}
                    className={`inline-flex min-h-6 items-center gap-1.5 rounded px-1 text-caption transition-opacity duration-fast hover:bg-surface-2 ${hidden.has(entry.family) ? "text-text-3 opacity-disabled" : "text-text"}`}
                  >
                    <span aria-hidden="true" className={`size-2 rounded-full ${FAMILY_DOT[entry.family]}`} />
                    {entry.word} <span className="text-text-2">{formatNumber(entry.count)}</span>
                  </button>
                ))}
              </div>
            )}
            {encodings.length > 0 && <div className="mt-2 border-t border-faint pt-2 text-caption text-text-3">{encodings.join(" · ")}</div>}
          </div>
          <div className="pointer-events-auto flex flex-wrap items-start gap-2">
            {meta && <div className="rounded-card border border-faint bg-star-panel px-2 backdrop-blur-md">{meta}</div>}
            {controls}
          </div>
        </div>
      )}

      {replaying !== null && <div aria-hidden="true" className="pointer-events-none absolute bottom-10 right-6 text-metric tabular-nums text-star-you">{formatDate(replaying, "iso")}</div>}
      {!full && (
        <div className="pointer-events-none absolute bottom-3 right-4 text-caption text-text">
          悬停看它连着谁 · 点一格打开{layoutDoc.truncated.nodes > 0 ? ` · 还有 ${layoutDoc.truncated.nodes} 条折叠在一组里` : ""}
        </div>
      )}

      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role -- a listbox over the same cells: the one tab stop of the picture */}
      <ul
        role="listbox" tabIndex={0} aria-label="星环里的记忆，用方向键选择，回车打开" aria-activedescendant={active ? `star-mark-${active}` : undefined} onKeyDown={walk}
        onBlur={() => { setActive(null); ring.current?.peek(null); }}
        className="peer absolute bottom-3 left-4 size-px overflow-hidden opacity-0"
      >
        {listed.map((node) => <li key={node.id} id={`star-mark-${node.id}`} role="option" aria-selected={node.id === active}>{[markKindWord(node), node.label].filter(Boolean).join("：")}</li>)}
      </ul>
      {/* Where the keyboard is: the list above is invisible, so the card says it is focused and what the keys do. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-card peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-focus-input" />
    </section>
  );
}
