import { useSyncExternalStore } from "react";

/**
 * The study whose page is open, told to whoever lists conversations (R19, plan §5.3).
 *
 * A study is one project and one conversation, and the sidebar lists a project's conversations from the run ledger — where a
 * conversation nobody has spoken in has no row, so the study that was made a second ago had nothing to point at. The page knows the
 * conversation it holds (its `conversation.sessionId`) and the sidebar does not, so the page says it here while it is open: the
 * sidebar then marks that conversation as the study's (its row opens the study's conversation view) and gives it a row of its own
 * before its first sentence.
 */
export interface OpenStudy {
  studyId: string;
  projectId: string;
  /** The study's conversation, when the kernel has one for it. */
  sessionId: string | null;
}

let current: OpenStudy | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Says that this study's page is open. Returns the withdrawal; a newer announcement replaces this one. */
export function announceOpenStudy(study: OpenStudy): () => void {
  if (current && current.studyId === study.studyId && current.projectId === study.projectId && current.sessionId === study.sessionId) {
    // Nothing changed: not an event.
    return () => undefined;
  }
  current = study;
  notify();
  return () => {
    if (current !== study) return;
    current = null;
    notify();
  };
}

export function useOpenStudy(): OpenStudy | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
    () => null,
  );
}
