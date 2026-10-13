import { useEffect, useRef, useState } from "react";
import type { WebPendingMemory } from "@/lib/apiClient";

/** How often the list is read again while something is still being written, and how long that goes on. */
export const PENDING_POLL_MS = 3_000;
export const PENDING_GIVE_UP_MS = 60_000;

/**
 * What 「记住这一条」 asked and the memory has not written yet, and whether it is taking longer than it should.
 *
 * The memory writes in about twelve seconds. The page reads its list again every three seconds while anything waits, and stops
 * after a minute: from then on the row says it is taking longer instead of spinning for ever, and the list is read again the
 * next time the page is opened. Waiting is counted from when the request was made (`at`), so a page opened a minute later does
 * not start a minute of polling afresh.
 */
export function usePendingMemory(pending: readonly WebPendingMemory[], reload: () => void, now: () => number = Date.now): { slow: boolean } {
  const [, setTick] = useState(0);
  const mounted = useRef(now());
  const oldest = pending.reduce<number | null>((least, item) => {
    const at = Date.parse(item.at);
    return Number.isFinite(at) && (least === null || at < least) ? at : least;
  }, null);
  const waiting = pending.length > 0;
  // A request with no readable time is counted from when this page began to wait for it.
  const slow = waiting && now() - (oldest ?? mounted.current) >= PENDING_GIVE_UP_MS;

  useEffect(() => {
    if (!waiting || slow) return undefined;
    const timer = setInterval(() => { setTick((value) => value + 1); reload(); }, PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, slow, reload]);

  // `setTick` is what re-evaluates `slow` against the clock between two reads.
  return { slow };
}
