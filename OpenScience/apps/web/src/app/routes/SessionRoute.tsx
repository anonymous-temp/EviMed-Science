import { useEffect, useState } from "react";
import { PanelRight } from "lucide-react";
import { fetchWebMe, webRuntimeProfile } from "@/lib/apiClient";
import { RuntimeUiFrame } from "./RuntimeUiFrame";
import { RunSidePanel } from "@/components/run/RunSidePanel";
import { Button } from "@/components/ui/Button";

const PANEL_KEY = "evimed.chat.runPanel";

/** The native application is the session surface, including its failure state. */
export function SessionRoute() {
  const [uiOrigin, setUiOrigin] = useState(() => webRuntimeProfile().uiOrigin);
  const [loading, setLoading] = useState(() => !webRuntimeProfile().uiOrigin);
  const [attempt, setAttempt] = useState(0);
  const [panelOpen, setPanelOpen] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(PANEL_KEY) !== "0",
  );
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => { if (active) setLoading(false); }, 15_000);
    void fetchWebMe().then(() => { if (active) setUiOrigin(webRuntimeProfile().uiOrigin); })
      .catch(() => { /* The visible unavailable state offers retry when no profile was loaded. */ })
      .finally(() => { clearTimeout(timer); if (active) setLoading(false); });
    return () => { active = false; clearTimeout(timer); };
  }, [attempt]);

  const togglePanel = () => {
    setPanelOpen((open) => {
      const next = !open;
      if (typeof window !== "undefined") window.localStorage.setItem(PANEL_KEY, next ? "1" : "0");
      return next;
    });
  };

  return (
    <div className="flex h-full w-full">
      <div className="relative min-w-0 flex-1">
        {uiOrigin ? <RuntimeUiFrame /> : loading ? (
          <div role="status" className="flex h-full items-center justify-center text-ui-sm text-muted">正在启动研究运行时…</div>
        ) : (
          <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 text-ui-sm text-error">
            <p>研究会话暂时无法连接</p>
            <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>重试</Button>
          </div>
        )}
        {!panelOpen && (
          <Button onClick={togglePanel} aria-label="打开运行面板" title="运行记录" variant="ghost"
            className="absolute right-3 top-3" size="sm">
            <PanelRight size={14} strokeWidth={1.5} />
          </Button>
        )}
      </div>
      {panelOpen && <RunSidePanel onClose={togglePanel} />}
    </div>
  );
}
