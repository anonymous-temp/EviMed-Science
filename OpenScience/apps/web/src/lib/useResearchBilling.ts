import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  fetchWebResearchAllowance, webErrorMessage, WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT,
  type WebResearchAllowance,
} from "@/lib/apiClient";

export interface ResearchBilling {
  /** True only once the deployment has said research billing is on. */
  enabled: boolean;
  /** The newest answer, or null until one has come. */
  allowance: WebResearchAllowance | null;
  /** A read this surface asked for is on its way. The answer held, if any, may be out of date. */
  loading: boolean;
  /** Why the read this surface was waiting for failed, in the reader's words. */
  error: string | null;
  /** Ask again — the retry. Joins a read already on its way. */
  reload: () => void;
}

let shared: WebResearchAllowance | null = null;
let inflight: Promise<void> | null = null;
let watching = false;
const listeners = new Set<() => void>();

function publish(next: WebResearchAllowance | null): void {
  if (shared === next) return;
  shared = next;
  for (const listener of listeners) listener();
}

/**
 * Forget the answer: the account changed (the session events below), or a test
 * is starting from nothing. A read still on its way is dropped when it lands —
 * it was asked for someone who is no longer here.
 */
export function forgetResearchBilling(): void {
  inflight = null;
  publish(null);
}

/** From the first read on, an account change forgets the answer even with no surface open to hear it. */
function watchSession(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener(WEB_SESSION_ENDED_EVENT, forgetResearchBilling);
  window.addEventListener(WEB_SESSION_STARTED_EVENT, forgetResearchBilling);
}

/** One request however many surfaces ask: the read on its way is the answer to all of them. */
function read(): Promise<void> {
  if (inflight) return inflight;
  watchSession();
  const request: Promise<void> = fetchWebResearchAllowance()
    .then((allowance) => { if (inflight === request) publish(allowance); })
    .finally(() => { if (inflight === request) inflight = null; });
  inflight = request;
  return request;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const current = () => shared;

/** Whether a surface opening now has to ask: nothing is known, or it shows numbers that billing makes move. */
const mustAsk = (fresh: boolean) => shared === null || (fresh && shared.enabled);

/**
 * Whether this deployment bills research, from the one allowance read every
 * surface that words itself by it shares.
 *
 * Research billing is a deployment switch and it is off by default. A page for
 * a subsystem that is switched off must not present it, so three surfaces
 * follow the answer: 设置's tab (用量, or 科研额度 where billing is on), the
 * section behind it (the month's usage, or the allowance), and the chat
 * frame's button when a spend ceiling refused a conversation. They ask the same
 * question of `/api/account/allowance`, so they share one read the way
 * `fetchWebMe` shares `/api/me`: a read already on its way is joined and never
 * doubled, the answer is kept for the life of the page, and a login or logout
 * forgets it — it was about the account that left.
 *
 * Unknown reads as off. While the first read is on its way, and when it could
 * not be read, `enabled` is false: the wording that is true on every
 * deployment is the one that does not name billing, so a deployment without it
 * never sees 科研额度 flash, and one with it shows 用量 for a moment.
 *
 * Which answers are asked again. `enabled: false` is the deployment's own
 * setting — nothing a session does changes it — so it is final for the page's
 * life, and a surface that finds it is never held up by another read.
 * `enabled: true` carries numbers that move (the balance, the month's spend),
 * so a surface that shows them passes `fresh` and reads again when it opens;
 * until the new answer lands it is `loading`, and the answer it holds is only
 * good for the wording (`enabled`), not for drawing the numbers. A failure is
 * never kept: it is reported to the surface that was waiting, and the next
 * surface to open asks again.
 *
 * Presentation only, like `useOperator`: the allowance routes authorize
 * themselves and charging happens server-side, so a browser that flips this
 * changes words, not what is billed.
 */
export function useResearchBilling({ fresh = false }: { fresh?: boolean } = {}): ResearchBilling {
  const allowance = useSyncExternalStore(subscribe, current);
  const [error, setError] = useState<string | null>(null);
  // True from the first render when the effect below is about to ask, so the
  // answer held is never drawn for a frame before the read that replaces it.
  const [loading, setLoading] = useState(() => mustAsk(fresh));
  const reload = useCallback(() => {
    setError(null);
    setLoading(true);
    read()
      .then(undefined, (caught: unknown) => setError(webErrorMessage(caught)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (mustAsk(fresh)) reload();
  }, [fresh, reload]);
  return { enabled: allowance?.enabled === true, allowance, loading, error, reload };
}
