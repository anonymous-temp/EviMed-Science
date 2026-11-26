import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { RingHit, RingSpec } from "./ringModel";
import { RingScene, type RingFrame, type RingView } from "./ringScene";

/** What the card around the picture may ask of it. */
export interface RingHandle {
  /** From the first cell to today; false when nothing says when it began. */
  replay: (onDate: (at: number) => void, onEnd: () => void) => boolean;
  stopReplay: () => void;
  /** Light one cell from the keyboard's list, with its tooltip. */
  peek: (id: string | null) => void;
  /** A spark to a cell for something that just happened to it, from the centre or from a cluster. */
  pulse: (cellId: string, from?: string) => void;
}

/** What the tooltip says of what the pointer is on, or null to say nothing. */
export type RingDescribe = (hit: Exclude<RingHit, null>) => { title: string; facts: string[] } | null;

/**
 * A ring picture's canvas, in its own chunk with three.js (each card loads it lazily). React holds a scene and hands it the spec and the
 * view when they change: the frames are the scene's own and no render of the page draws one. The tooltip moves by its style for the same
 * reason.
 */
export default function RingCanvas({ handle, spec, view, moving, frame, label, describe, onOpen, onLost }: {
  handle: Ref<RingHandle>;
  spec: RingSpec;
  view: RingView;
  moving: boolean;
  frame: RingFrame;
  /** What the picture is, for a screen reader. */
  label: string;
  describe: RingDescribe;
  onOpen: (hit: Exclude<RingHit, null>) => void;
  onLost: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const scene = useRef<RingScene | null>(null);
  // What the pointer is on, and not what was said of it then: the words are read again from the newest data on each render, so an
  // operation that ends under a still pointer says so, and a thing that left the picture takes its tooltip with it.
  const [hovered, setHovered] = useState<RingHit>(null);
  const callbacks = useRef({ describe, onOpen, onLost });
  useEffect(() => { callbacks.current = { describe, onOpen, onLost }; }, [describe, onOpen, onLost]);

  useEffect(() => {
    if (!host.current) return undefined;
    const place = (x: number, y: number) => { if (tip.current) tip.current.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 12)}px)`; };
    let made: RingScene;
    try {
      made = new RingScene(host.current, {
        onHover: (hit, x, y) => { setHovered(hit); place(x, y); },
        onMove: place,
        onOpen: (hit) => callbacks.current.onOpen(hit),
        onLost: () => callbacks.current.onLost(),
        nameOf: (id) => callbacks.current.describe({ kind: "cell", id })?.title ?? "",
      });
    } catch {
      // The browser refused a context the check allowed (they are limited per page): the card's flat picture is the same things.
      queueMicrotask(() => callbacks.current.onLost());
      return undefined;
    }
    scene.current = made;
    return () => { scene.current = null; made.dispose(); };
  }, []);

  useEffect(() => { scene.current?.setData(spec); }, [spec]);
  useEffect(() => { scene.current?.setView(view); }, [spec, view]);
  useEffect(() => { scene.current?.setMoving(moving); }, [moving]);
  useEffect(() => { scene.current?.setFrame(frame); }, [frame]);
  useImperativeHandle(handle, () => ({
    replay: (onDate, onEnd) => scene.current?.replay(onDate, onEnd) ?? false,
    stopReplay: () => scene.current?.stopReplay(),
    peek: (id) => scene.current?.peek(id),
    pulse: (cellId, from) => scene.current?.pulse(cellId, from),
  }), []);

  const said = hovered ? describe(hovered) : null;
  return (
    <>
      <div ref={host} role="img" aria-label={label} className="absolute inset-0" />
      <div ref={tip} className="pointer-events-none absolute left-0 top-0 z-popover max-w-xs" aria-hidden="true">
        {said && (
          <div className="rounded border border-faint bg-star-panel px-3 py-2 backdrop-blur-md">
            <div className="text-ui text-text">{said.title}</div>
            {said.facts.length > 0 && <div className="mt-0.5 text-caption text-text-3">{said.facts.join(" · ")}</div>}
          </div>
        )}
      </div>
    </>
  );
}
