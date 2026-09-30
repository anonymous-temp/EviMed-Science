import { useCallback, useRef, useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import type { VcrRunAnswer } from "@/lib/vcrClient";
import { useOpenVcrConversation } from "./useOpenVcrConversation";

/** What a run that could not start now says: the previous run is still going. */
export const VCR_DEFERRED_SENTENCE = "已排队，前一个运行结束后开始";

/**
 * Whether a run's answer means it started. A run that could not start now —
 * another one holds the study — answers no `runId` and, usually, a reason; the
 * reader stays where they are with one sentence, and is not sent into a
 * conversation that has nothing new in it (contract review CW-19).
 */
export function runDeferred(answer: VcrRunAnswer | null | undefined): boolean {
  if (!answer) return false;
  return answer.runId == null && (answer.deferred != null || answer.sessionId == null);
}

/**
 * Start something that ends in the study's own conversation — a step, an
 * export — and go there once it has actually started.
 *
 * Hidden knowledge:
 *  - **One at a time.** `busy` is held from the click to the answer, and a
 *    second click while it is held does nothing (CW-18): a step asked for
 *    twice is two runs.
 *  - The conversation opens only for a run that started; a deferred one is a
 *    toast, and the page stays.
 */
export function useVcrRun(study: { projectId: string; sessionId: string | null }) {
  const open = useOpenVcrConversation();
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const run = useCallback(async (start: () => Promise<VcrRunAnswer | void>, failure: string, after?: () => void) => {
    if (holding.current) return;
    holding.current = true;
    setBusy(true);
    try {
      const answer = (await start()) as VcrRunAnswer | undefined;
      if (runDeferred(answer)) {
        toast.success(VCR_DEFERRED_SENTENCE);
        after?.();
        return;
      }
      await open({ projectId: study.projectId, sessionId: answer?.sessionId ?? study.sessionId });
    } catch (error) {
      toast.error(webErrorMessage(error, { fallback: failure }));
    } finally {
      holding.current = false;
      setBusy(false);
    }
  }, [open, study.projectId, study.sessionId]);
  return { run, busy };
}
