import { useCallback, useEffect, useRef, useState } from "react";
import { ACTIVATION_POLL_DELAYS_MS } from "./catalogueModel";

/**
 * Re-read while an apply is under way (`pending`), each wait longer than the last (`ACTIVATION_POLL_DELAYS_MS`), and stop
 * when the waits run out. `observed` is what the last read returned: a new answer arms the next wait. `round` names the
 * reader's own change (a saved revision): a new one starts the waits again from the first.
 *
 * `gaveUp` is true once the waits have run out with the apply still pending: the page then says so (「还没生效，可以稍后刷新」) and
 * `again` reads once more and starts the waits afresh. It used to stop with the last state, 「等待当前任务结束后生效」, still on screen
 * and nothing to say that nobody was looking any more.
 */
export function useActivationPoll(pending: boolean, refresh: () => void, observed: unknown, round: string) {
  const attempt = useRef(0), latest = useRef(refresh);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => { latest.current = refresh; }, [refresh]);
  useEffect(() => { attempt.current = 0; setGaveUp(false); }, [round]);
  useEffect(() => {
    if (!pending) { attempt.current = 0; setGaveUp(false); return; }
    const delay = ACTIVATION_POLL_DELAYS_MS[attempt.current];
    if (delay === undefined) { setGaveUp(true); return; }
    // The last wait is the last look: once it has been taken the page says so, whether or not the answer arrives as a new object.
    const timer = setTimeout(() => { attempt.current += 1; latest.current(); if (attempt.current >= ACTIVATION_POLL_DELAYS_MS.length) setGaveUp(true); }, delay);
    return () => clearTimeout(timer);
  }, [pending, observed, round]);
  const again = useCallback(() => { attempt.current = 0; setGaveUp(false); latest.current(); }, []);
  return { gaveUp: pending && gaveUp, again };
}
