import { useEffect, useState } from "react";
import { fetchWebMe, hasWebApi, webRuntimeProfile } from "@/lib/apiClient";
import { LiveSessionPage } from "./LiveSessionPage";
import { RunStreamSessionPage } from "./RunStreamSessionPage";

/**
 * Picks the session view the deployment serves.
 *
 * The choice belongs to the server, not to a build flag: the two views read
 * different sources, and only the deployment knows which one it serves.
 * `/api/me` answers it, and until it has, the retiring view is what renders —
 * which is also the answer for the desktop shell, where there is no `/api/me`
 * and no other view.
 *
 * The switch lives here rather than inside `LiveSessionPage` for a mundane but
 * decisive reason: the profile arrives after the first render, and a branch
 * inside the page would change which hooks run between renders. Swapping the
 * component is something React already handles.
 */
export function SessionRoute() {
  const [view, setView] = useState(() => webRuntimeProfile().sessionView);

  useEffect(() => {
    if (!hasWebApi) return;
    let cancelled = false;
    void fetchWebMe()
      .then(() => {
        if (!cancelled) setView(webRuntimeProfile().sessionView);
      })
      .catch(() => {
        // isolated: an unreachable control plane leaves the page on the view it
        // already had rather than blanking the session.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return view === "run-stream" ? <RunStreamSessionPage /> : <LiveSessionPage />;
}
