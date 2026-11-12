import { useEffect, useRef, useState } from "react";
import type { WebPendingMemory } from "@/lib/apiClient";

/** How often the list is read again while something is still being written, in the first minute. */
export const PENDING_POLL_MS = 3_000;
/** After this long the row says the memory is slower than usual — and the page keeps reading, further apart each time. */
export const PENDING_SLOW_MS = 60_000;
/** The first wait after that, doubled each time up to the cap: 6, 12, 24, 48, 60, 60 … seconds. */
export const PENDING_BACKOFF_FIRST_MS = 6_000;
export const PENDING_BACKOFF_CAP_MS = 60_000;
/** After this long the page stops reading and says so: the memory may still write it, and the list shows it when it is opened again. */
export const PENDING_STALL_MS = 10 * 60_000;

/**
 * What 「记住这一条」 asked and the memory has not written yet, and whether it is taking longer than it should.
 *
 * The memory writes in about twelve seconds. The page reads its list again every three seconds while anything waits; past a minute the
 * row says it is slower than usual and the page keeps reading on a growing wait (2026-11-01 audit D8: it used to give up at a minute and
 * leave 「还在记」 on screen for a memory that was written two minutes later); past ten minutes it stops and the row says it is not
 * finished and can be looked at later. Waiting is counted from when the request was made (`at`), so a page opened a minute later does
 * not start a minute of polling afresh.
 */
export function usePendingMemory(pending: readonly WebPendingMemory[], reload: () => void, now: () => number = Date.now): { slow: boolean; stalled: boolean } {
  const [, setTick] = useState(0);
  const mounted = useRef(now());
  const writing = pending.filter(item => item.reason !== "instruction_origin_uncertain" && item.state !== "confirmation");
  const oldest = writing.reduce<number | null>((least, item) => {
    const at = Date.parse(item.at);
    return Number.isFinite(at) && (least === null || at < least) ? at : least;
  }, null);
  const waiting = writing.length > 0;
  // A request with no readable time is counted from when this page began to wait for it.
  const since = oldest ?? mounted.current;
  const age = now() - since;
  const slow = waiting && age >= PENDING_SLOW_MS;
  const stalled = waiting && age >= PENDING_STALL_MS;

  useEffect(() => {
    if (!waiting || stalled) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let slowReads = 0;
    const next = () => {
      const waited = now() - since;
      // `setTick` is what re-evaluates the words against the clock between two reads, and once more when the last wait has run out.
      if (waited >= PENDING_STALL_MS) { setTick((value) => value + 1); return; }
      const delay = waited < PENDING_SLOW_MS ? PENDING_POLL_MS : Math.min(PENDING_BACKOFF_CAP_MS, PENDING_BACKOFF_FIRST_MS * 2 ** slowReads++);
      timer = setTimeout(() => { setTick((value) => value + 1); reload(); next(); }, delay);
    };
    next();
    return () => clearTimeout(timer);
  // `now` is the clock the caller reads; it does not change what the wait is.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, stalled, reload, since]);

  return { slow, stalled };
}
