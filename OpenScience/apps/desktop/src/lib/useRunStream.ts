import { useCallback, useEffect, useRef, useState } from "react";
import { webApiBase } from "@/lib/apiClient";
import {
  applyRunFrame,
  emptyRunView,
  markInteractionAnswered,
  openRunStream,
  runIsSettled,
  transcriptToRunView,
  type RunStreamFrame,
  type RunTranscript,
  type RunView,
} from "@/lib/runStream";

/** How the browser's picture of a run is being kept up to date. */
export type RunStreamStatus = "idle" | "connecting" | "live" | "settled" | "error";

export interface RunStreamState {
  view: RunView;
  status: RunStreamStatus;
  /** Consecutive reconnect attempts. Shown, because a silent retry loop reads as a stall. */
  retries: number;
}

/**
 * Subscribes to one run's control-plane event stream.
 *
 * Hidden knowledge: three decisions that are not obvious from the frame list.
 *
 * The first is that the transcript is fetched *before* the stream opens, not
 * instead of it. A run that started before this page did has already emitted
 * everything interesting, and the replay buffer is bounded; without the
 * transcript, opening a finished run shows an empty thread and a "live"
 * indicator forever.
 *
 * The second is that reconnection resumes from `view.seq` rather than from
 * zero. Re-reading a run from the beginning on every dropped connection is not
 * merely wasteful — it re-applies frames whose effects are not idempotent, and
 * the attempt counter and the tool pairing both drift.
 *
 * The third is that a settled run closes its own stream. A finished run holds a
 * server-side channel open for as long as the tab is, and nothing more is
 * coming.
 */
export function useRunStream(
  runId: string | null,
  options: {
    /**
     * The run's status as the ledger already reported it.
     *
     * Passed in rather than inferred, because a transcript cannot answer it: a
     * transcript records a kernel session and a run's status belongs to the
     * ledger, so a finished run read from a transcript alone looks like one
     * that is still going. The caller has the run record; it has the status.
     */
    initialState?: string;
    /** Injectable for tests; defaults to the control plane's transcript route. */
    fetchTranscript?: (runId: string) => Promise<RunTranscript | null>;
    factory?: (url: string) => EventSource;
  } = {},
): RunStreamState & { reconnect: () => void; markAnswered: (eventId: string) => void } {
  // Held in refs, not read from the dependency array. A caller that passes an
  // inline arrow — which is every caller that does not think about it — would
  // otherwise tear down and reopen the subscription on every single render,
  // and each reopen resets the status back to "connecting". The symptom is a
  // view that never goes live while the server sees a new subscriber per frame.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [view, setView] = useState<RunView>(() => emptyRunView(runId ?? ""));
  const [status, setStatus] = useState<RunStreamStatus>("idle");
  const [retries, setRetries] = useState(0);
  const [generation, setGeneration] = useState(0);
  // The reducer needs the current sequence to resume from, and re-running the
  // effect on every frame would tear the stream down once per event.
  const seqRef = useRef(0);

  const reconnect = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    if (!runId) {
      setStatus("idle");
      setView(emptyRunView(""));
      seqRef.current = 0;
      return;
    }

    let closed = false;
    let handle: { close: () => void } | null = null;
    setStatus("connecting");

    const load = async () => {
      const { fetchTranscript, factory, initialState } = optionsRef.current;
      const transcript = fetchTranscript ? await fetchTranscript(runId).catch(() => null) : null;
      if (closed) return;
      const base = transcript ? transcriptToRunView(runId, transcript) : emptyRunView(runId);
      const seeded = initialState ? { ...base, state: initialState } : base;
      seqRef.current = seeded.seq;
      setView(seeded);
      if (runIsSettled(seeded)) {
        setStatus("settled");
        return;
      }

      handle = openRunStream(runId, {
        apiBase: webApiBase ? `${webApiBase}/api` : "/api",
        since: seqRef.current || undefined,
        factory,
        onFrame: (frame: RunStreamFrame) => {
          setRetries(0);
          setStatus("live");
          setView((current) => {
            const next = applyRunFrame(current, frame);
            seqRef.current = next.seq;
            if (runIsSettled(next)) {
              // A finished run has nothing further to send; holding the channel
              // open would keep a server-side subscription per open tab.
              handle?.close();
              handle = null;
              setStatus("settled");
            }
            return next;
          });
        },
        onError: () => {
          if (closed) return;
          setRetries((value) => value + 1);
          setStatus("error");
        },
      });
    };

    void load();
    return () => {
      closed = true;
      handle?.close();
    };
    // Only the run and an explicit reconnect may restart the subscription.
  }, [runId, generation]);

  /**
   * Marks one request answered without waiting for the round trip.
   *
   * An echo, not the record: the control plane publishes `status: "answered"`
   * to every listener, so a second tab settles on its own and this one would
   * too, a moment later. Applying both is the same result.
   */
  const markAnswered = useCallback((eventId: string) => {
    setView((current) => markInteractionAnswered(current, eventId));
  }, []);

  return { view, status, retries, reconnect, markAnswered };
}
