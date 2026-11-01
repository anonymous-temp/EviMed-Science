/**
 * One account of whether a research run is still going (2026-11-01 audit D2: 主动科研 had two, and they disagreed for as long as a
 * poll took to catch up — the observatory said a run had ended while the button beside it still read 停止本次).
 *
 * The run's event stream is the closer witness: while it is open for the run on screen and has said what state the run is in, that is
 * the answer. Where there is no open stream — nothing is shown, the stream is reconnecting, or it has not yet reported — the poll's
 * answer stands. The page uses this for the buttons, the queue's words and the activity strip alike.
 */
export interface ObservedRun {
  runId: string;
  /** The state the stream has reported (`running`, `succeeded`, `failed`, `canceled`), or null before it has reported one. */
  state: string | null;
  /** Whether the stream is open now. */
  connected: boolean;
}

/** The stream's word for the run, when it is the one to trust. */
function streamState(runId: string | null | undefined, observed: ObservedRun | null): string | null {
  return runId && observed && observed.runId === runId && observed.connected && observed.state ? observed.state : null;
}

/** Whether the run is going: the open stream's answer, else what the poll said (`polledLive`). */
export function runLive(runId: string | null | undefined, polledLive: boolean, observed: ObservedRun | null): boolean {
  const state = streamState(runId, observed);
  return state === null ? polledLive : state === "running";
}

/** A goal round's mode in the queue, from the stream where it is open and from the round's own record otherwise. */
export function roundModeOf(run: { id: string; status: string }, observed: ObservedRun | null): "running" | "done" | "failed" | "ended" {
  const status = streamState(run.id, observed) ?? run.status;
  return status === "running" ? "running" : status === "succeeded" ? "done" : status === "failed" ? "failed" : "ended";
}

/** Whether the stream has just told the page that the run on screen is over, which is the page's cue to read the records again. */
export function streamEnded(observed: ObservedRun | null): boolean {
  return Boolean(observed?.connected && observed.state && observed.state !== "running");
}
