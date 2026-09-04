import { useCallback, useEffect, useState } from "react";
import { PanelRight } from "lucide-react";
import { fetchWebMe, webRuntimeProfile } from "@/lib/apiClient";
import { RunStreamSessionPage } from "./RunStreamSessionPage";
import { RuntimeUiFrame } from "./RuntimeUiFrame";
import { RunSidePanel } from "@/components/run/RunSidePanel";

const PANEL_KEY = "evimed.chat.runPanel";

/**
 * The session surface: the kernel's own browser application when this
 * deployment serves it, this shell's own view when it does not.
 *
 * The choice belongs to the server, not to a build flag — `/api/me` names the
 * origin the application is served on, and a deployment without one renders
 * the built-in view. A browser that cannot reach that origin falls back to the
 * same place: the origin is a second port, and a port is what a firewall in
 * front of this deployment can refuse without either side being broken.
 */
export function SessionRoute() {
  const [uiOrigin, setUiOrigin] = useState(() => webRuntimeProfile().uiOrigin);
  const [uiUnreachable, setUiUnreachable] = useState(false);
  const [panelOpen, setPanelOpen] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(PANEL_KEY) !== "0",
  );
  // Stable identity: the frame probes on this callback changing, and an inline
  // arrow would make it probe again on every render.
  const markUnreachable = useCallback(() => setUiUnreachable(true), []);

  useEffect(() => {
    let cancelled = false;
    void fetchWebMe()
      .then(() => {
        if (cancelled) return;
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

  const togglePanel = () => {
    setPanelOpen((open) => {
      const next = !open;
      if (typeof window !== "undefined") window.localStorage.setItem(PANEL_KEY, next ? "1" : "0");
      return next;
    });
  };

  const framed = uiOrigin && !uiUnreachable;

  return (
    <div className="flex h-full w-full">
      <div className="relative min-w-0 flex-1">
        {framed ? <RuntimeUiFrame onUnreachable={markUnreachable} /> : <RunStreamSessionPage />}
        {!panelOpen && (
          <button
            onClick={togglePanel}
            aria-label="打开运行面板"
            title="运行记录"
            className="absolute right-3 top-3 rounded-input border border-border bg-surface/90 p-1.5 text-muted shadow-card backdrop-blur hover:text-text"
          >
            <PanelRight size={14} strokeWidth={1.5} />
          </button>
        )}
      </div>
      {panelOpen && <RunSidePanel onClose={togglePanel} />}
    </div>
  );
}
