import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Composer } from "@/components/thread/Composer";
import { EmptyState } from "@/components/cards/EmptyState";
import { RunStreamThread } from "@/components/run/RunStreamThread";
import { dispatchWebAgentRun, fetchWebRunTranscript, listWebAgentRuns } from "@/lib/apiClient";
import { useRunStream } from "@/lib/useRunStream";

/**
 * The session view for the DSH kernel.
 *
 * Hidden knowledge: why this is a second page rather than a rewrite of the
 * first. The retiring view is built around a store that mirrors a kernel's own
 * session objects, and this one consumes the control plane's `RunEvent` stream
 * — the browser no longer knows what a kernel is. Those are different data
 * models, not different renderings of one, so editing the old page in place
 * would mean holding both models in one component for however long the
 * acceptance takes. Two pages and a server-side switch means the retiring path
 * keeps working untouched until the new one is accepted, and then deleting it
 * is a deletion rather than an untangling (§16 #15).
 *
 * Which page a deployment gets is answered by `/api/me`, because the kernel is
 * a deployment decision and a rollback must not need a new bundle.
 */
export function RunStreamSessionPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [runId, setRunId] = useState<string | null>(null);
  const [runSessionId, setRunSessionId] = useState<string | null>(sessionId ?? null);
  // The ledger's own answer for whether this run is still going. Without it a
  // finished run reopened from a URL renders as one still in flight, because a
  // transcript cannot say what a run's status is.
  const [runStatus, setRunStatus] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The transcript is keyed by the run's session, not by the run: the control
  // plane records the run and the kernel records the session, and the URL
  // carries the one the user can bookmark.
  const fetchTranscript = useCallback(
    async () => (runSessionId ? fetchWebRunTranscript(runSessionId) : null),
    [runSessionId],
  );
  const { view, status, retries, reconnect } = useRunStream(runId, { fetchTranscript, initialState: runStatus });

  // Reopening a session from the URL has to find its run again; the run id is
  // not in the URL because a session can be asked more than one thing.
  useEffect(() => {
    if (!sessionId || runId) return;
    let cancelled = false;
    void listWebAgentRuns()
      .then((runs) => {
        if (cancelled) return;
        const found = runs.filter((run) => run.sessionId === sessionId).at(0);
        if (found) {
          setRunId(found.id);
          setRunSessionId(found.sessionId);
          setRunStatus(found.status);
        }
      })
      .catch(() => {
        // isolated: failing to find a previous run leaves a usable blank page
        // rather than an error screen.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, runId]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || sending) return;
      setSending(true);
      setError(null);
      try {
        const targetSession = runSessionId ?? sessionId ?? `session-${Date.now().toString(36)}`;
        const run = await dispatchWebAgentRun(targetSession, text, `dispatch-${Date.now().toString(36)}`);
        setRunSessionId(run.sessionId);
        setRunStatus(run.status);
        setRunId(run.id);
        if (run.sessionId !== sessionId) navigate(`/live/${encodeURIComponent(run.sessionId)}`, { replace: true });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSending(false);
      }
    },
    [navigate, runSessionId, sending, sessionId],
  );

  const working = status === "connecting" || status === "live";

  return (
    <div className="mx-auto flex h-full w-full max-w-content flex-col gap-4 p-4">
      <div className="flex-1 overflow-y-auto">
        {runId ? (
          // No `onAnswerInteraction`: the control plane does not forward the
          // kernel's `waterfall` frames and has no route that accepts a reply
          // for one, so there is nothing to hand an answer to. The thread still
          // shows the request and says the channel is missing — see
          // `RunInteractionPrompt`. Passing a sender here is the whole change
          // once the server half exists.
          <RunStreamThread view={view} status={status} retries={retries} onReconnect={reconnect} />
        ) : (
          <EmptyState
            title="开始一次研究"
            description="提出一个问题或研究任务，运行过程、分工与交付物的门禁意见都会实时显示在这里。"
          />
        )}
      </div>
      {error ? (
        <p role="alert" className="text-ui-sm text-error">
          {error}
        </p>
      ) : null}
      <Composer onSend={(text) => void send(text)} disabled={sending} working={working && sending} />
    </div>
  );
}
