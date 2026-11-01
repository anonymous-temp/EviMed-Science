import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { MapEdge, MapNode } from "@/lib/memoryMapClient";
import { formatDay } from "@/lib/format";
import { markKindWord } from "../mapModel";
import { freshnessWord, type StarFamily } from "./starModel";
import { StarScene } from "./starScene";

/** What the card around the picture may ask of it. */
export interface StarHandle {
  home: () => void;
  replay: (onDate: (at: number) => void, onEnd: () => void) => boolean;
  stopReplay: () => void;
  peek: (id: string | null) => void;
}

/**
 * The canvas of the star map, in its own chunk with three.js (`StarMapView` loads it lazily). React holds a scene and hands it the document and the selection when they change:
 * the frames are the scene's own and no render of the page draws one. The tooltip moves by its style for the same reason.
 */
export default function StarCanvas({ handle, nodes, edges, now, shown, hits, selected, hiddenFamilies, rotating, label, onOpen, onLost }: {
  handle: Ref<StarHandle>;
  /** The whole document: where a mark stands does not depend on what the selection keeps. */
  nodes: readonly MapNode[];
  edges: readonly MapEdge[];
  now: number;
  shown: ReadonlySet<string>;
  hits: ReadonlySet<string>;
  selected: string | null;
  hiddenFamilies: ReadonlySet<StarFamily>;
  rotating: boolean;
  label: string;
  onOpen: (node: MapNode) => void;
  onLost: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const scene = useRef<StarScene | null>(null);
  const [hovered, setHovered] = useState<MapNode | null>(null);
  const opened = useRef(onOpen);
  const lost = useRef(onLost);
  useEffect(() => { opened.current = onOpen; lost.current = onLost; }, [onOpen, onLost]);

  useEffect(() => {
    if (!host.current) return undefined;
    const place = (x: number, y: number) => { if (tip.current) tip.current.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 12)}px)`; };
    let made: StarScene;
    try {
      made = new StarScene(host.current, {
        onHover: (node, x, y) => { setHovered(node); place(x, y); },
        onMove: place,
        onOpen: (node) => opened.current(node),
        onLost: () => lost.current(),
      });
    } catch {
      // The browser refused a context the check allowed (they are limited per page): the relation graph is the same marks.
      queueMicrotask(() => lost.current());
      return undefined;
    }
    scene.current = made;
    return () => { scene.current = null; made.dispose(); };
  }, []);

  useEffect(() => { scene.current?.setData(nodes, edges, now); }, [nodes, edges, now]);
  useEffect(() => { scene.current?.setView({ shown, hits, selected, hiddenFamilies }); }, [nodes, edges, now, shown, hits, selected, hiddenFamilies]);
  useEffect(() => { scene.current?.setRotating(rotating); }, [rotating]);
  useImperativeHandle(handle, () => ({
    home: () => scene.current?.home(),
    replay: (onDate, onEnd) => scene.current?.replay(onDate, onEnd) ?? false,
    stopReplay: () => scene.current?.stopReplay(),
    peek: (id) => scene.current?.peek(id),
  }), []);

  const facts = hovered ? [markKindWord(hovered), hovered.at ? formatDay(hovered.at) : "", freshnessWord(hovered), hovered.description ?? ""].filter(Boolean) : [];
  return (
    <>
      <div ref={host} role="img" aria-label={label} className="absolute inset-0" />
      <div ref={tip} className="pointer-events-none absolute left-0 top-0 z-popover max-w-xs" aria-hidden="true">
        {hovered && (
          <div className="rounded border border-faint bg-star-panel px-3 py-2 backdrop-blur-md">
            <div className="text-ui text-text">{hovered.label}</div>
            {facts.length > 0 && <div className="mt-0.5 text-caption text-text-3">{facts.join(" · ")}</div>}
          </div>
        )}
      </div>
    </>
  );
}
