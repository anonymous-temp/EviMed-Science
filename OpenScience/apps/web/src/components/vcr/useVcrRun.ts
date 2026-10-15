import { useCallback, useContext, useRef, useState } from "react";
import { runtimeLockMessage } from "@evimed/domain";
import { webErrorMessage, WebApiError } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import type { VcrRunAnswer } from "@/lib/vcrClient";
import { StudyFrameContext } from "./studyFrameContext";

/**
 * Kept so that a test written against the old flow still compiles. A step that could not start now no longer says a sentence in a
 * toast and leaves: it is in line, and the page's activity strip says what for (「排队中 · 等「证据」做完」).
 * @deprecated Nothing shows it.
 */
export const VCR_DEFERRED_SENTENCE = "已排队，前一个运行结束后开始";

/**
 * The sentence a refused start says. A project whose runtime is held answers 423 with the reason it is held (`details.reason`), and
 * the sentence says what is actually running: the study's own step is not 「你设定的定时任务」, and it is ended on the study's page,
 * not on the tasks page. Every other refusal is the dictionary's.
 */
export function startFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof WebApiError && error.code === "runtime_reserved_for_autopilot") return runtimeLockMessage(error.reason);
  return webErrorMessage(error, { fallback });
}

/**
 * Start something the study does — a step, an export, a patient's trials — and say so once it was taken. **It never navigates.**
 *
 * Until R19 this hook started the work and then took the person to the conversation of the run the platform opened for it, which
 * they could neither leave nor take part in (the owner: 「点了生成虚拟患者，就进入对话了，就回不去了」). Now it is the start and
 * nothing else: the answer says what was taken and what waits (`VcrRunAnswer`), the frame reads the study again at once, and the
 * page's activity strip — under the tabs, with 取消 — says what is happening until it is done, when the tab that holds the result
 * updates itself. A start that is in line behind another is one sentence in the strip, not a toast and a page that stays silent.
 *
 * Hidden knowledge:
 *  - **One at a time.** `busy` is held from the click to the answer, and a second click while it is held does nothing: a step asked
 *    for twice is two runs.
 *  - `start` returns the route's answer; `after` runs once it was taken. A refusal is a toast (`startFailureMessage`) and `busy`
 *    is released: nothing was started, and nothing is left half-open.
 *  - The first argument is what the hook used to read the study's project and conversation from. It is kept as a parameter so the
 *    call sites do not change, and it is not used: the start does not need to know where the conversation is.
 */
export function useVcrRun(_study?: unknown, options: { refresh?: () => void } = {}) {
  const frame = useContext(StudyFrameContext);
  const refresh = options.refresh ?? frame?.refresh;
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const run = useCallback(async (start: () => Promise<VcrRunAnswer | void>, failure: string, after?: () => void): Promise<VcrRunAnswer | undefined> => {
    if (holding.current) return undefined;
    holding.current = true;
    setBusy(true);
    try {
      const answer = (await start()) as VcrRunAnswer | undefined;
      // The study is read now, so the strip is there before the next tick, and the page begins to read it by itself.
      refresh?.();
      after?.();
      return answer ?? undefined;
    } catch (error) {
      toast.error(startFailureMessage(error, failure));
      return undefined;
    } finally {
      holding.current = false;
      setBusy(false);
    }
  }, [refresh]);
  return { run, busy };
}
