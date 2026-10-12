import { useCallback, useEffect, useState } from "react";
import { MEMORY_CHANGED_EVENT, fetchProjectOverview, type ProjectOverview } from "@/lib/memoryClient";
import { OTHER_PROJECT } from "./memoryItems";

/**
 * The overview of the project the 项目 tab shows (`GET /api/memory/projects/:id/overview`), read when the project changes and
 * again whenever a memory changed on screen. `null` is no overview — not asked for, still being read, or not readable — and the
 * tab is its list of memories without it: the overview is an addition above the list, never a condition of it (principle 19).
 *
 * @param projectId the project shown; null for another tab, or for the memories that name no project the account still has
 */
export function useProjectOverview(projectId: string | null): { overview: ProjectOverview | null; reload: () => void } {
  const [state, setState] = useState<{ projectId: string; overview: ProjectOverview | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  const wanted = projectId && projectId !== OTHER_PROJECT ? projectId : null;

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    fetchProjectOverview(wanted).then(
      (overview) => { if (!cancelled) setState({ projectId: wanted, overview }); },
      () => { if (!cancelled) setState({ projectId: wanted, overview: null }); },
    );
    return () => { cancelled = true; };
  }, [wanted, attempt]);

  useEffect(() => {
    window.addEventListener(MEMORY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MEMORY_CHANGED_EVENT, reload);
  }, [reload]);

  // What was read for another project is not this one's.
  return { overview: wanted && state?.projectId === wanted ? state.overview : null, reload };
}
