import { useCallback, useEffect, useRef, useState } from "react";
import { listWebAgentRuns, type WebAgentRun } from "@/lib/apiClient";
import { RUNS_CHANGED_EVENT, runState } from "@/lib/runPresentation";

/** How often the watched ledgers are read again while the tab is visible. */
const POLL_MS = 20_000;

/** One project's task list as the sidebar holds it. */
export type ProjectRuns =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; runs: WebAgentRun[] };

export function isRunning(run: WebAgentRun): boolean {
  return runState(run).key === "running";
}

/**
 * The sidebar's task lists, one per project, each read with that project's
 * own header (`listWebAgentRuns({ projectId })`) — never the tab's, which a
 * switch moves while a read may still be out.
 *
 * Read when wanted and not before: the current project, and a group someone
 * opened. Never every project on load — each project is its own ledger behind
 * its own runtime, and an account with ten of them would pay ten reads for a
 * list it has not looked at.
 *
 * A project whose last read had a task running stays watched after its group
 * is closed, so its header's running mark goes out when the task finishes
 * instead of pulsing on from a stale read. Everything watched is kept fresh
 * the way the single list before this one was: every 20 s while the tab is
 * visible, at once when a page announces a change (`RUNS_CHANGED_EVENT` — a
 * rename or a cancel on the runs page), and when the tab comes back.
 *
 * `known` is the account's project ids once the list has loaded (null before):
 * a group remembered from a project deleted elsewhere is not read.
 */
export function useProjectRuns(wanted: readonly string[], known: ReadonlySet<string> | null) {
  const [byProject, setByProject] = useState<Record<string, ProjectRuns>>({});
  // The newest request per project: an older answer arriving last is dropped.
  const latest = useRef(new Map<string, number>());

  const read = useCallback((projectId: string) => {
    const request = (latest.current.get(projectId) ?? 0) + 1;
    latest.current.set(projectId, request);
    setByProject((current) => (current[projectId] ? current : { ...current, [projectId]: { status: "loading" } }));
    void listWebAgentRuns({ projectId }).then(
      (runs) => {
        if (latest.current.get(projectId) !== request) return;
        setByProject((current) => ({ ...current, [projectId]: { status: "ready", runs } }));
      },
      () => {
        if (latest.current.get(projectId) !== request) return;
        // A ledger that cannot be read leaves the rows already read — a
        // sidebar is not where someone should first learn the API is down.
        // Only a first read that fails says so, and says it as a failure:
        // shown as an empty list it would tell someone their work is gone.
        setByProject((current) => (
          current[projectId]?.status === "ready" ? current : { ...current, [projectId]: { status: "failed" } }
        ));
      },
    );
  }, []);

  const watched = [...new Set([
    ...wanted,
    ...Object.entries(byProject)
      .filter(([, entry]) => entry.status === "ready" && entry.runs.some(isRunning))
      .map(([projectId]) => projectId),
  ])].filter((projectId) => !known || known.has(projectId));
  const watchedRef = useRef(watched);
  watchedRef.current = watched;
  const watchedKey = watched.join("\n");

  // A project is read the first time it is wanted; after that the timer and
  // the events below keep it fresh.
  useEffect(() => {
    for (const projectId of watchedRef.current) {
      if (!latest.current.has(projectId)) read(projectId);
    }
  }, [watchedKey, read]);

  useEffect(() => {
    const readAll = () => {
      for (const projectId of watchedRef.current) read(projectId);
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") readAll();
    }, POLL_MS);
    // A catch-up when the tab comes back, so returning to it does not show a
    // list frozen at whatever it said when the reader left.
    const onVisible = () => {
      if (document.visibilityState === "visible") readAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(RUNS_CHANGED_EVENT, readAll);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(RUNS_CHANGED_EVENT, readAll);
    };
  }, [read]);

  return { byProject, read };
}
