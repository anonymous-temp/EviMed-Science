import { useCallback, useEffect, useRef, useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { getVcrStudy, isVcrMissing, isVcrOff, type VcrStudy } from "@/lib/vcrClient";
import { pollInterval } from "./vcrActivity";

/** What the page holds, and for which study: an answer for another id is not this page's. */
export type StudyLoad =
  | { kind: "loading" }
  | { kind: "off"; id: string }
  | { kind: "missing"; id: string }
  | { kind: "error"; id: string; message: string }
  | { kind: "ready"; id: string; study: VcrStudy };

/**
 * Said by anything that knows a study has moved and is not the page that shows it — a finished-run notice whose target is the tab
 * the reader is on (`useVcrFinishedToasts`). The page that shows that study reads it again, in place.
 */
export const VCR_STUDY_REFRESH_EVENT = "evimed:vcr-study-refresh";

export function announceVcrStudyRefresh(studyId: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(VCR_STUDY_REFRESH_EVENT, { detail: { studyId } }));
}

/**
 * The last answer for each study this page load has read. The shell remounts a page when its project changes (`AppShell` keys the
 * routed page by it), and opening a study moves the shell to the study's project — so the page that asked would otherwise show its
 * skeleton twice for one visit. A remount paints this at once and reads again underneath.
 */
const lastRead = new Map<string, VcrStudy>();

/** The study as it was last read in this page load, or null. For tests that mount the page twice, and for nothing else. */
export function forgetStudies(): void {
  lastRead.clear();
}

/**
 * One study, read — and kept read while something about it moves.
 *
 * Hidden knowledge:
 *  - **Starting work is the page's to see, not to navigate to.** While a run, a step in line or an engine job moves
 *    (`activity`), the study is read every four seconds and the dots, the strip and — through `version` — the tabs follow; when
 *    nothing moves any more the reading stops (`pollInterval`). A page that reads on a clock for ever is a request per tab per
 *    four seconds for as long as somebody leaves it open.
 *  - **The conversation view reads a little slower**, and so does a study that is still a draft: a sentence said there names the
 *    study, and the page and the sidebar learn it from this read.
 *  - **A poll that fails does not take the page away.** The study that was on screen stays; only a first read that fails, or an
 *    answer that says the study is gone, replaces it.
 *  - **An answer that did not change is not a new object**, so what is memoized on the study (the tab's element, the toolbar)
 *    holds still across reads that found nothing.
 */
export function useStudy(studyId: string, enabled: boolean, view: string): { loaded: StudyLoad; reload: () => void } {
  const [loaded, setLoaded] = useState<StudyLoad>(() => {
    const study = lastRead.get(studyId);
    return study ? { kind: "ready", id: studyId, study } : { kind: "loading" };
  });
  const [reloads, setReloads] = useState(0);
  // Counts the answers that came back, whether or not they changed anything: the next read is scheduled from the last one.
  const [answers, setAnswers] = useState(0);
  const shown = useRef<VcrStudy | null>(lastRead.get(studyId) ?? null);
  const reload = useCallback(() => setReloads((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void getVcrStudy(studyId).then(
      (study) => {
        if (!live) return;
        const same = shown.current !== null && shown.current.id === study.id && JSON.stringify(shown.current) === JSON.stringify(study);
        const next = same ? shown.current as VcrStudy : study;
        shown.current = next;
        lastRead.set(studyId, next);
        setLoaded((previous) => (previous.kind === "ready" && previous.study === next ? previous : { kind: "ready", id: studyId, study: next }));
        setAnswers((value) => value + 1);
      },
      (error: unknown) => {
        if (!live) return;
        if (isVcrOff(error)) { lastRead.delete(studyId); setLoaded({ kind: "off", id: studyId }); }
        else if (isVcrMissing(error)) { lastRead.delete(studyId); setLoaded({ kind: "missing", id: studyId }); }
        else {
          // A page that has the study keeps it; one that never had it says why.
          setLoaded((previous) => (previous.kind === "ready" && previous.id === studyId
            ? previous : { kind: "error", id: studyId, message: webErrorMessage(error, { fallback: "研究暂时无法读取。" }) }));
          setAnswers((value) => value + 1);
        }
      },
    );
    return () => { live = false; };
  }, [enabled, studyId, reloads]);

  // The next read, from the last answer: soon while something moves, never when nothing does.
  useEffect(() => {
    if (loaded.kind !== "ready" || loaded.id !== studyId) return undefined;
    const wait = pollInterval(loaded.study, view);
    if (wait === null) return undefined;
    const read = () => { if (document.visibilityState === "visible") reload(); };
    const timer = setTimeout(read, wait);
    // A tab brought back to the front does not wait out the rest of its interval.
    document.addEventListener("visibilitychange", read);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", read); };
  }, [loaded, answers, view, studyId, reload]);

  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ studyId?: string }>).detail;
      if (!detail?.studyId || detail.studyId === studyId) reload();
    };
    window.addEventListener(VCR_STUDY_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(VCR_STUDY_REFRESH_EVENT, onRefresh);
  }, [studyId, reload]);

  // Moving to another study shows the skeleton — or that study's own last answer — never the previous one's header under the new address.
  let current: StudyLoad = loaded;
  if (loaded.kind !== "loading" && loaded.id !== studyId) {
    const remembered = lastRead.get(studyId);
    current = remembered ? { kind: "ready", id: studyId, study: remembered } : { kind: "loading" };
  }
  return { loaded: current, reload };
}
