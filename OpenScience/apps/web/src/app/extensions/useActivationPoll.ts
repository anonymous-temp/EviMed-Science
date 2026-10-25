import { useEffect, useRef } from "react";
import { ACTIVATION_POLL_DELAYS_MS } from "./catalogueModel";

/**
 * Re-read while an apply is under way (`pending`), each wait longer than the last (`ACTIVATION_POLL_DELAYS_MS`), and stop
 * when the waits run out. `observed` is what the last read returned: a new answer arms the next wait. `round` names the
 * reader's own change (a saved revision): a new one starts the waits again from the first.
 */
export function useActivationPoll(pending: boolean, refresh: () => void, observed: unknown, round: string) {
  const attempt = useRef(0), latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; }, [refresh]);
  useEffect(() => { attempt.current = 0; }, [round]);
  useEffect(() => {
    if (!pending) { attempt.current = 0; return; }
    const delay = ACTIVATION_POLL_DELAYS_MS[attempt.current];
    if (delay === undefined) return;
    const timer = setTimeout(() => { attempt.current += 1; latest.current(); }, delay);
    return () => clearTimeout(timer);
  }, [pending, observed, round]);
}
