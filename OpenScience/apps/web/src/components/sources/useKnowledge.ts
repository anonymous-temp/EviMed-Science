import { useCallback, useEffect, useState } from "react";
import { getKnowledgeStatus, getKnowledgeTree, type KnowledgeStatus, type KnowledgeTree } from "@/lib/sourceClient";
import { statusLine } from "./knowledgeView";

/** How often a round that is under way (or waiting) is asked about again. */
const STATUS_POLL_MS = 5000;

/**
 * Where the project's compile is, read when the page opens and again every few seconds while a round is under way or
 * waiting. A read that fails leaves the status as it was: the pages stand without it, and nothing here blocks anything.
 */
export function useKnowledgeStatus(projectId: string | null, enabled: boolean) {
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setStatus(null); }, [projectId]);
  const busy = statusLine(status)?.busy ?? false;
  useEffect(() => {
    if (!projectId || !enabled) return undefined;
    let active = true;
    getKnowledgeStatus(projectId).then((value) => { if (active) setStatus(value); }, () => { /* the page stands without it */ });
    return () => { active = false; };
  }, [projectId, enabled, attempt]);
  useEffect(() => {
    if (!busy || !enabled) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(() => setAttempt((value) => value + 1), STATUS_POLL_MS);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [busy, enabled, status]);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  return { status, setStatus, refresh };
}

/** What a round left, as a key: the tree is read again when it changes. */
export function roundKey(status: KnowledgeStatus | null): string {
  return status ? `${status.round}:${status.compiledAt ?? ""}:${status.pages}:${status.graphFiles}:${status.stale}` : "";
}

/** The compiled files of the project, read when asked for and again after a round ends. A failed read is `failed`, and the page falls back to its list. */
export function useKnowledgeTree(projectId: string | null, enabled: boolean, version: string) {
  const [tree, setTree] = useState<KnowledgeTree | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!projectId || !enabled) return undefined;
    let active = true;
    getKnowledgeTree(projectId).then(
      (value) => { if (active) { setTree(value); setFailed(false); } },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [projectId, enabled, version, attempt]);
  return { tree, failed, retry: useCallback(() => setAttempt((value) => value + 1), []) };
}
