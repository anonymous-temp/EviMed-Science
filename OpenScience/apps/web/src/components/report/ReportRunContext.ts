import { createContext, useContext } from "react";
import type { WebAgentRun } from "@/lib/apiClient";

/**
 * The run a previewed file belongs to, when the surface opening it knows.
 *
 * A report read from the runs page can open its preserved sources in the
 * run's reader and show the run's model and its clinical-safety findings; the
 * same report opened from the file tree knows none of that and says 「未注明」.
 * A context rather than a field on the shared inspector type, because only the
 * reader needs it and the type is shared with the frame.
 */
export const ReportRunContext = createContext<{ runId: string; run: WebAgentRun | null } | null>(null);

export function useReportRun() {
  return useContext(ReportRunContext);
}
