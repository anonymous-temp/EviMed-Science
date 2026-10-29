import { useCallback, useEffect, useRef, useState } from "react";
import { frontierErrorMessage, hideFrontierItem, unhideFrontierItem, type FrontierHideReason, type FrontierItem } from "@/lib/frontierClient";
import { flushFrontierEvents, trackFrontierItemAction, type FrontierTrackSurface } from "@/lib/frontierTracking";
import { toast } from "@/lib/toast";
import { muteSourceOf } from "./frontierHide";

/**
 * 「不感兴趣」 on a card, with its reason (c2-hide, 2026-10-25). The owner's order of things: the card goes at once — the hide is
 * sent the moment it is chosen — and in its place stands one line that asks why, which the reader may ignore.
 *
 * Hidden knowledge:
 *
 * - **The item stays in its list while the line stands.** The page removes it (`onClosed`) only when the line closes, so 撤销 is
 *   the card coming back where it was, and nothing has to be put back at an index. The line closes after
 *   `FRONTIER_HIDE_STRIP.waitMs` with no choice, `notedMs` after one, and when it is scrolled out of sight (its component says so);
 *   the hide stands whichever way it closes.
 * - **One `hide` event per hide, sent when the line closes** — so it can carry the reason as its detail — and none when the hide
 *   is undone before then (a hide taken back is not a hide of the feed's ranking). A page that is hiding or being left settles
 *   the lines still open first, with no reason, and flushes.
 * - **The server calls of one hide are one queue**: the hide, then the reason, then — if the reader changes their mind — the
 *   unhide and the unmute, never overtaking each other. A hide that fails brings the card back with the error; a reason that
 *   fails is told, and the hide stands without it.
 *
 * Which model capability would make it deletable: none — this is the reader's own decision, recorded.
 */

/** How long the line waits for a choice, and how long it says 「已记下」. */
export const FRONTIER_HIDE_STRIP = Object.freeze({ waitMs: 8_000, notedMs: 1_500 });

/** What a card's line needs: whether a reason was taken, and the three things the reader can do. */
export interface FrontierHideStripControls {
  noted: boolean;
  onReason: (reason: FrontierHideReason) => void;
  onUndo: () => void;
  onClose: () => void;
}

interface Session {
  item: FrontierItem;
  surface: FrontierTrackSurface;
  reason: FrontierHideReason | null;
  noted: boolean;
  tracked: boolean;
  /** Taken back, or never took: nothing more is sent for it. */
  undone: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
  unmute: (() => Promise<void>) | null;
}

export function useFrontierHide({ surface, onClosed }: {
  /** Where the cards are, as the events name it. */
  surface: FrontierTrackSurface;
  /** The line closed and the hide stands: the item leaves its list. */
  onClosed: (item: FrontierItem) => void;
}): { start: (item: FrontierItem) => void; strip: (itemId: string) => FrontierHideStripControls | null } {
  const sessions = useRef(new Map<string, Session>());
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;

  const sync = useCallback(() => setOpen(new Map([...sessions.current].map(([id, session]) => [id, session.noted]))), []);

  const track = useCallback((session: Session): boolean => {
    if (session.tracked || session.undone) return false;
    session.tracked = true;
    trackFrontierItemAction("hide", session.item.id, { surface: session.surface, ...(session.reason ? { detail: session.reason } : {}) });
    return true;
  }, []);

  const finish = useCallback((id: string): Session | null => {
    const session = sessions.current.get(id);
    if (!session) return null;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    sessions.current.delete(id);
    sync();
    return session;
  }, [sync]);

  const close = useCallback((id: string) => {
    const session = finish(id);
    if (!session) return;
    track(session);
    closedRef.current(session.item);
  }, [finish, track]);

  const arm = useCallback((id: string, ms: number) => {
    const session = sessions.current.get(id);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => close(id), ms);
  }, [close]);

  const start = useCallback((item: FrontierItem) => {
    if (sessions.current.has(item.id)) return;
    const session: Session = { item, surface: surfaceRef.current, reason: null, noted: false, tracked: false, undone: false, timer: null,
      chain: Promise.resolve(), unmute: null };
    sessions.current.set(item.id, session);
    session.chain = hideFrontierItem(item.id).then(() => undefined, (error: unknown) => {
      // The hide did not happen: the card is what it was, and nothing else is sent for it.
      session.undone = true;
      if (sessions.current.get(item.id) === session) finish(item.id);
      toast.error(frontierErrorMessage(error));
    });
    arm(item.id, FRONTIER_HIDE_STRIP.waitMs);
    sync();
  }, [arm, finish, sync]);

  const choose = useCallback((id: string, reason: FrontierHideReason) => {
    const session = sessions.current.get(id);
    if (!session || session.noted || session.undone) return;
    session.reason = reason;
    session.noted = true;
    arm(id, FRONTIER_HIDE_STRIP.notedMs);
    sync();
    session.chain = session.chain.then(async () => {
      if (session.undone) return;
      try { await hideFrontierItem(id, reason); } catch (error) { toast.error(frontierErrorMessage(error)); return; }
      if (reason !== "source" || session.undone) return;
      try { session.unmute = await muteSourceOf(session.item); } catch (error) { toast.error(frontierErrorMessage(error)); }
    });
  }, [arm, sync]);

  const undo = useCallback((id: string) => {
    const session = sessions.current.get(id);
    if (!session || session.undone) return;
    session.undone = true;
    const reported = session.tracked;
    finish(id);
    session.chain = session.chain.then(async () => {
      try {
        await unhideFrontierItem(id);
        if (reported) trackFrontierItemAction("unhide", id, { surface: session.surface });
        await session.unmute?.();
      } catch (error) { toast.error(frontierErrorMessage(error)); }
    });
  }, [finish]);

  // A page that is hiding or being left settles the lines still open, with the reason they have, and sends what is queued.
  useEffect(() => {
    const settle = () => {
      let any = false;
      for (const session of sessions.current.values()) any = track(session) || any;
      if (any) flushFrontierEvents("unload");
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") settle(); };
    window.addEventListener("pagehide", settle);
    document.addEventListener("visibilitychange", onVisibility);
    const live = sessions.current;
    return () => {
      window.removeEventListener("pagehide", settle);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const session of live.values()) {
        if (session.timer) clearTimeout(session.timer);
        track(session);
      }
      live.clear();
    };
  }, [track]);

  const strip = useCallback((itemId: string): FrontierHideStripControls | null => {
    const noted = open.get(itemId);
    if (noted === undefined) return null;
    return { noted, onReason: (reason) => choose(itemId, reason), onUndo: () => undo(itemId), onClose: () => close(itemId) };
  }, [open, choose, undo, close]);

  return { start, strip };
}
