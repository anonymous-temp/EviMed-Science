import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from "react";
import type { ThreadBlock } from "@ai4s/shared";

/** Distance from the bottom (px) within which the conversation keeps following. */
export const FOLLOW_BOTTOM_PX = 120;

/**
 * Follow-the-tail scrolling for the live conversation, composing with
 * useScrollMemory (which owns remembering/restoring the offset):
 *
 * - While the user is at (or near) the bottom, new blocks and the working
 *   indicator keep the view pinned to the tail.
 * - Scrolling up pauses the follow; incoming user/agent messages are counted
 *   for the floating "back to bottom" button the page renders from the result.
 * - `restoreKey`/`ready` mirror useScrollMemory's restore inputs: the commit
 *   on which a remembered position is restored owns the scroll offset, so the
 *   follow never yanks a restored mid-thread position to the bottom.
 */
export function useChatScrollFollow(
  ref: RefObject<HTMLElement | null>,
  {
    restoreKey,
    ready,
    blocks,
    working,
  }: {
    /** The same key passed to useScrollMemory (per conversation). */
    restoreKey: string;
    /** The same readiness flag passed to useScrollMemory (history loaded). */
    ready: boolean;
    /** The conversation's blocks — a new array reference per store update. */
    blocks: readonly ThreadBlock[] | undefined;
    /** The "Working…" indicator row — its (dis)appearance changes the tail. */
    working: boolean;
  },
) {
  const [following, setFollowing] = useState(true);
  const [newCount, setNewCount] = useState(0);
  /** `${restoreKey}|${ready}` the follow effect last evaluated — a mismatch
   *  means this is the commit useScrollMemory restores on; follow stands down. */
  const restoreGen = useRef<string | null>(null);
  const prevBlocks = useRef<readonly ThreadBlock[]>([]);

  // A different conversation starts over: follow its tail, no pending count.
  // restoreGen is invalidated too — the re-render this reset triggers would
  // otherwise count as a "stable" commit and pin the tail before
  // useScrollMemory's restored position has settled. Mount is NOT a reset:
  // the first layout evaluation already stands down via the null restoreGen.
  const prevKey = useRef<string | null>(null);
  useEffect(() => {
    const isKeyChange = prevKey.current !== null && prevKey.current !== restoreKey;
    prevKey.current = restoreKey;
    if (!isKeyChange) return;
    setFollowing(true);
    setNewCount(0);
    prevBlocks.current = [];
    restoreGen.current = null;
  }, [restoreKey]);

  useLayoutEffect(() => {
    const gen = `${restoreKey}|${ready}`;
    const prev = prevBlocks.current;
    prevBlocks.current = blocks ?? [];
    if (restoreGen.current === gen) {
      const el = ref.current;
      if (following) {
        // Empty draft/specialty landing content is not a conversation tail.
        // Metadata can resolve after mount and re-render the page; scrolling
        // then would hide the very header/onboarding the user just opened.
        if (el && ((blocks?.length ?? 0) > 0 || working)) {
          el.scrollTop = el.scrollHeight;
        }
      } else if (blocks && blocks.length > prev.length) {
        // Only conversation messages count as "new" — tool steps stream by
        // the dozen and would inflate the badge into noise.
        const added = blocks
          .slice(prev.length)
          .filter((b) => b.kind === "agent" || b.kind === "user").length;
        if (added > 0) setNewCount((c) => c + added);
      }
    }
    restoreGen.current = gen;
    // `working` is a dep on purpose: the indicator row lives inside the
    // scroll container, so its (dis)appearance must re-pin the tail.
  }, [ref, restoreKey, ready, following, blocks, working]);

  const handleScroll = (e: UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_BOTTOM_PX;
    setFollowing(nearBottom);
    if (nearBottom) setNewCount(0);
  };

  const backToBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollowing(true);
    setNewCount(0);
  };

  return { following, newCount, handleScroll, backToBottom };
}
