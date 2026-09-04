import { useCallback, useEffect, useState } from "react";
import { fetchWebMe, hasWebApi, webRuntimeProfile } from "@/lib/apiClient";
import { LiveSessionPage } from "./LiveSessionPage";
import { RunStreamSessionPage } from "./RunStreamSessionPage";
import { RuntimeUiFrame } from "./RuntimeUiFrame";

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
  const [uiOrigin, setUiOrigin] = useState(() => webRuntimeProfile().uiOrigin);
  const [uiUnreachable, setUiUnreachable] = useState(false);
  // Stable identity: the frame probes on this callback changing, and an inline
  // arrow would make it probe again on every render.
  const markUnreachable = useCallback(() => setUiUnreachable(true), []);

  useEffect(() => {
    if (!hasWebApi) return;
    let cancelled = false;
    void fetchWebMe()
      .then(() => {
        if (cancelled) return;
        setView(webRuntimeProfile().sessionView);
        setUiOrigin(webRuntimeProfile().uiOrigin);
      })
      .catch(() => {
        // isolated: an unreachable control plane leaves the page on the view it
        // already had rather than blanking the session.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A deployment that serves the kernel's application serves it as the session
  // surface; the built-in views are what a deployment without it renders, what
  // the desktop shell renders, and what this browser falls back to when it
  // cannot reach that origin. Falling back rather than spinning is the point:
  // the origin is a second port, and a port is what a firewall in front of
  // this deployment can refuse without either side being broken.
  if (uiOrigin && !uiUnreachable) {
    return <RuntimeUiFrame onUnreachable={markUnreachable} />;
  }
  return view === "run-stream" ? <RunStreamSessionPage /> : <LiveSessionPage />;
}
