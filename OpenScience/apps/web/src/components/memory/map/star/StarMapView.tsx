import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Maximize, Minimize, Pause, Play, RotateCcw, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useBlockHeadingLevel } from "@/components/ui/Section";
import { formatDate, formatNumber } from "@/lib/format";
import type { MapNode, MemoryMap } from "@/lib/memoryMapClient";
import { markKindWord, relationTitle, STRUCTURE, type NarrowedMap } from "../mapModel";
import type { GraphActions } from "../GraphView";
import type { StarHandle } from "./StarCanvas";
import { encodingWords, familyCounts, familyOf, replayStart, type StarFamily } from "./starModel";

const StarCanvas = lazy(() => import("./StarCanvas"));

/** A picture that cannot load (a chunk gone after a release, three.js refusing) is no reason for the page to fail: the page goes to the flat pictures. */
class StarBoundary extends Component<{ onFailed: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailed(); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Literal, so the stylesheet's scan finds each colour. */
const FAMILY_DOT: Readonly<Record<StarFamily, string>> = {
  about: "bg-star-about", preference: "bg-star-preference", correction: "bg-star-correction", fact: "bg-star-fact",
  decision: "bg-star-decision", method: "bg-star-method", document: "bg-star-document", entity: "bg-star-entity",
};

/**
 * 「记忆星图」: what the person's memory holds, as one night sky at the head of 总览 — the page's one brand moment (DESIGN.md), and the place a memory's life shows: bright when it
 * is new or used, dim when it has not been used for long, a spark along its line when a conversation has just been handed it, grey with an amber line to what replaced it.
 *
 * A dark window in either scheme, by `data-theme="dark"` on the card: inside it every token already answers for the dark ground, so its controls are the page's own.
 * Every mark opens the drawer the table's rows open. The selection of the page (range, what needs a look, a topic) decides what is shown and the search what is lit, as for the
 * relation graph; which kinds the legend has turned off is this card's own.
 *
 * Who does not see it (`useStarAllowed`, or a lost context through `onUnavailable`) gets the relation graph: the same document and the same drawers. A keyboard walks the same marks in
 * the list under the canvas (one tab stop, arrows, Enter), which is also what a screen reader reads; the turning stops on one press, for WCAG 2.2.2 as much as for taste.
 */
export function StarMapView({ layoutDoc, narrowed, selected, actions, meta, onUnavailable }: {
  /** The whole document, which is where a mark's place comes from. */
  layoutDoc: Pick<MemoryMap, "nodes" | "edges" | "truncated">;
  narrowed: NarrowedMap;
  selected: string | null;
  actions: GraphActions;
  /** The switch between the views. */
  meta?: ReactNode;
  onUnavailable: () => void;
}) {
  const Heading = `h${useBlockHeadingLevel()}` as "h2";
  const card = useRef<HTMLElement>(null);
  const canvas = useRef<StarHandle>(null);
  const [rotating, setRotating] = useState(true);
  const [replaying, setReplaying] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<StarFamily>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const change = () => setFull(document.fullscreenElement === card.current);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  const toggleFull = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void card.current?.requestFullscreen(); };
  // A drawer opens on the page and not in the full-screen card, so a press comes back to the page first.
  const open = useCallback((node: MapNode) => {
    if (document.fullscreenElement) void document.exitFullscreen();
    actions.onOpen(node);
  }, [actions]);

  const shown = useMemo(() => new Set(narrowed.nodes.map((node) => node.id)), [narrowed.nodes]);
  const counts = useMemo(() => familyCounts(narrowed.nodes), [narrowed.nodes]);
  const encodings = useMemo(() => encodingWords(narrowed.nodes, now), [narrowed.nodes, now]);
  const canReplay = useMemo(() => replayStart(narrowed.nodes) !== null, [narrowed.nodes]);
  const toggleFamily = (family: StarFamily) => setHidden((held) => {
    const next = new Set(held);
    if (next.has(family)) next.delete(family); else next.add(family);
    return next;
  });
  const replay = () => {
    if (replaying !== null) { canvas.current?.stopReplay(); return; }
    const started = canvas.current?.replay((at) => setReplaying(at), () => setReplaying(null));
    if (started) setRotating(true);
  };

  // ---- the same marks for a keyboard and a screen reader: one tab stop, the active one lit on the picture ----
  const listed = useMemo(() => narrowed.nodes
    .filter((node) => !STRUCTURE.has(node.type) && !hidden.has(familyOf(node) as StarFamily))
    .slice().sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0)), [narrowed.nodes, hidden]);
  const walk = (event: React.KeyboardEvent) => {
    const at = listed.findIndex((node) => node.id === active);
    const move = (index: number) => {
      event.preventDefault();
      const next = listed[(index + listed.length) % listed.length];
      if (!next) return;
      setActive(next.id);
      canvas.current?.peek(next.id);
    };
    if (event.key === "ArrowDown" || event.key === "ArrowRight") move(at + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") move(at < 0 ? -1 : at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(listed.length - 1);
    else if (event.key === "Enter" && at >= 0) { event.preventDefault(); open(listed[at]); }
    else if (event.key === "Escape") { setActive(null); canvas.current?.peek(null); }
  };

  const title = relationTitle(narrowed.nodes);
  return (
    <section ref={card} data-theme="dark" data-chart="stars" aria-label="记忆星图" className="relative isolate min-w-0 overflow-hidden rounded-card border border-border bg-star-ground text-text" style={{ height: full ? "100vh" : "clamp(480px, 70vh, 700px)" }}>
      <StarBoundary onFailed={onUnavailable}>
        <Suspense fallback={<div role="img" aria-label={title} className="absolute inset-0" />}>
          <StarCanvas
            handle={canvas} nodes={layoutDoc.nodes} edges={layoutDoc.edges} now={now} shown={shown} hits={narrowed.hits} selected={selected}
            hiddenFamilies={hidden} rotating={rotating} label={`记忆星图：${title}。同样的内容在下面的列表里。`} onOpen={open} onLost={onUnavailable}
          />
        </Suspense>
      </StarBoundary>

      {/* The legend and the controls stand in the card's head (T4), over the sky and out of its way. */}
      <div className="pointer-events-none absolute inset-x-4 top-4 flex flex-wrap items-start justify-between gap-3">
        <div className="pointer-events-auto max-w-md rounded-card border border-faint bg-star-panel px-4 py-3 backdrop-blur-md">
          <div className="text-caption text-text-3">记忆星图</div>
          <Heading className="mt-0.5 text-heading text-text">{title}</Heading>
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
        <div className="pointer-events-auto flex flex-col items-end gap-2">
          {meta && <div className="rounded-card border border-faint bg-star-panel px-2 backdrop-blur-md">{meta}</div>}
          <div className="flex flex-wrap justify-end gap-1 rounded-card border border-faint bg-star-panel p-1 backdrop-blur-md">
            {canReplay && <Button size="sm" variant="text" onClick={replay}>{replaying !== null ? <Square size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}{replaying !== null ? "停止回放" : "回放成长"}</Button>}
            <Button size="sm" variant="text" aria-pressed={rotating} onClick={() => setRotating((value) => !value)}>{rotating ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}{rotating ? "暂停转动" : "缓慢转动"}</Button>
            <Button size="sm" variant="text" onClick={() => canvas.current?.home()}><RotateCcw size={16} aria-hidden="true" />回正</Button>
            <Button size="sm" variant="text" onClick={toggleFull}>{full ? <Minimize size={16} aria-hidden="true" /> : <Maximize size={16} aria-hidden="true" />}{full ? "退出全屏" : "全屏"}</Button>
          </div>
        </div>
      </div>

      {replaying !== null && <div aria-hidden="true" className="pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2 text-metric tabular-nums text-star-you">{formatDate(replaying, "iso")}</div>}
      <div className="pointer-events-none absolute bottom-3 left-4 text-caption text-text-3">
        拖动旋转 · {full ? "滚轮" : "Ctrl 或 ⌘ 加滚轮"}缩放 · 悬停看它连着谁 · 点一颗打开{layoutDoc.truncated.nodes > 0 ? ` · 还有 ${layoutDoc.truncated.nodes} 条折叠在一组里` : ""}
      </div>

      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role -- a listbox over the same marks: the one tab stop of the picture */}
      <ul
        role="listbox" tabIndex={0} aria-label="星图里的记忆，用方向键选择，回车打开" aria-activedescendant={active ? `star-mark-${active}` : undefined} onKeyDown={walk}
        onBlur={() => { setActive(null); canvas.current?.peek(null); }}
        className="peer absolute bottom-3 right-4 size-px overflow-hidden opacity-0"
      >
        {listed.map((node) => <li key={node.id} id={`star-mark-${node.id}`} role="option" aria-selected={node.id === active}>{[markKindWord(node), node.label].filter(Boolean).join("：")}</li>)}
      </ul>
      {/* Where the keyboard is: the list above is invisible, so the card says it is focused and what the keys do. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-card peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-focus-input" />
    </section>
  );
}

