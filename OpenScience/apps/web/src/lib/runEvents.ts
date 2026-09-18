import { useEffect, useRef, useState } from "react";
import { fetchWithWebAuth, webApiBase } from "./apiClient";

/**
 * The browser's one reader of `GET /api/runs/:id/events`.
 *
 * The control plane has served a run's own event stream since the kernel
 * migration — kernel frames decoded into `RunEvent`, plus the run's facts
 * (`deliverable/update`, `evidence/update`, `budget/update`, `run/state`) —
 * and until this module nothing in the page read it: the runs page polled
 * `planItems` every 20 s, and only for three running runs.
 *
 * The stream is read with `fetch` rather than `EventSource`, because an
 * `EventSource` cannot carry the `X-Open-Science-Project` header the route
 * scopes the run by. Resumption is by the envelope's `seq`, sent back as
 * `?since=`, so a dropped connection replays from where it stopped rather
 * than from the beginning.
 */

/** One envelope as the server writes it: `seq`, `time`, `type`, then the event's own fields. */
export interface RunStreamEvent {
  seq: number;
  time: string;
  type: string;
  [field: string]: unknown;
}

export interface RunEventSubscriptionOptions {
  /** Resume after this sequence number. */
  since?: number;
  /** Aborting ends the subscription; no reconnect follows. */
  signal?: AbortSignal;
  /** Called whenever the connection opens or drops. */
  onConnection?: (connected: boolean) => void;
  /** Reconnect delays in ms; the last one repeats. */
  backoffMs?: readonly number[];
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

function eventsUrl(runId: string, since: number): string {
  const apiRoot = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const query = since > 0 ? `?since=${since}` : "";
  return `${apiRoot}/runs/${encodeURIComponent(runId)}/events${query}`;
}

/**
 * Splits an SSE byte stream into events. Returns the unconsumed tail, because
 * a chunk boundary can fall anywhere, including inside a UTF-8 sequence (the
 * decoder is streaming for that reason).
 */
export function parseSseChunk(buffer: string, emit: (event: RunStreamEvent) => void): string {
  let rest = buffer.replace(/\r\n/g, "\n");
  let boundary = rest.indexOf("\n\n");
  while (boundary >= 0) {
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf("\n\n");
    let type = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      // Comment lines (`: open`, `: ping`) are the heartbeat, not events.
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") type = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) continue;
    try {
      const parsed = JSON.parse(data.join("\n")) as Record<string, unknown>;
      const seq = Number(parsed.seq);
      if (!Number.isSafeInteger(seq)) continue;
      emit({ ...parsed, seq, time: String(parsed.time ?? ""), type });
    } catch {
      // A malformed frame is dropped rather than ending the subscription: one
      // bad event must not blind the page to the rest of the run.
    }
  }
  return rest;
}

/**
 * Subscribes to one run's stream and keeps reconnecting until `signal`
 * aborts or the server says the run is not there (404/403). Returns the
 * unsubscribe function.
 */
export function subscribeRunEvents(
  runId: string,
  onEvent: (event: RunStreamEvent) => void,
  options: RunEventSubscriptionOptions = {},
): () => void {
  const controller = new AbortController();
  const outer = options.signal;
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const backoff = options.backoffMs?.length ? options.backoffMs : DEFAULT_BACKOFF_MS;
  let since = options.since ?? 0;
  let failures = 0;

  const wait = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  void (async () => {
    while (!controller.signal.aborted) {
      let connected = false;
      try {
        const response = await fetchWithWebAuth(eventsUrl(runId, since), {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (response.status === 404 || response.status === 403 || response.status === 401) return;
        if (!response.ok || !response.body) throw new Error(`run_events_${response.status}`);
        connected = true;
        failures = 0;
        options.onConnection?.(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = parseSseChunk(buffer + decoder.decode(value, { stream: true }), (event) => {
            if (event.seq <= since) return;
            since = event.seq;
            onEvent(event);
          });
        }
      } catch {
        if (controller.signal.aborted) return;
      } finally {
        if (connected) options.onConnection?.(false);
      }
      if (controller.signal.aborted) return;
      await wait(backoff[Math.min(failures, backoff.length - 1)]);
      failures += 1;
    }
  })();

  return () => controller.abort();
}

export interface RunEventsState {
  /** Events received so far, oldest first, bounded to the last `limit`. */
  events: RunStreamEvent[];
  /** The most recent event, or null before the first one. */
  lastEvent: RunStreamEvent | null;
  connected: boolean;
}

/**
 * React binding: subscribes while `runId` is set and `enabled` is not false.
 * The buffer is bounded like the server's replay buffer, so a long run left
 * open in a tab does not grow the page without limit.
 */
export function useRunEvents(runId: string | null | undefined, options: { enabled?: boolean; limit?: number } = {}): RunEventsState {
  const { enabled = true, limit = 500 } = options;
  const [state, setState] = useState<RunEventsState>({ events: [], lastEvent: null, connected: false });
  const limitRef = useRef(limit);
  limitRef.current = limit;

  useEffect(() => {
    setState({ events: [], lastEvent: null, connected: false });
    if (!runId || !enabled) return undefined;
    return subscribeRunEvents(runId, (event) => {
      setState((previous) => {
        const events = previous.events.length >= limitRef.current
          ? [...previous.events.slice(previous.events.length - limitRef.current + 1), event]
          : [...previous.events, event];
        return { ...previous, events, lastEvent: event };
      });
    }, {
      onConnection: (connected) => setState((previous) => ({ ...previous, connected })),
    });
  }, [runId, enabled]);

  return state;
}
