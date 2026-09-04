import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router";
import { Loader2, PanelLeft } from "lucide-react";
import { isMacPlatform } from "@/lib/platform";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { CommandPalette } from "@/components/command-palette/CommandPalette";
import { ShortcutHelp } from "@/components/ui/ShortcutHelp";
import { Toaster } from "@/components/ui/Toaster";
import { useProjectStore } from "@/lib/projects";
import { useUiStore } from "@/lib/store";
import { fetchWebMe, WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT } from "@/lib/apiClient";

export function AppShell() {
  const { sidebarCollapsed, setSidebarCollapsed } = useUiStore();
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "unauthenticated">("checking");

  // Cmd/Ctrl+B toggles the sidebar, matching the button's tooltip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useUiStore.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const clearSession = () => {
      useProjectStore.getState().clear();
      setAuthState("unauthenticated");
    };
    const startSession = () => setAuthState("authenticated");
    window.addEventListener(WEB_SESSION_ENDED_EVENT, clearSession);
    window.addEventListener(WEB_SESSION_STARTED_EVENT, startSession);
    return () => {
      window.removeEventListener(WEB_SESSION_ENDED_EVENT, clearSession);
      window.removeEventListener(WEB_SESSION_STARTED_EVENT, startSession);
    };
  }, []);

  useEffect(() => {
    let active = true;
    void fetchWebMe()
      .then((me) => {
        if (active) setAuthState(me ? "authenticated" : "unauthenticated");
      })
      .catch(() => {
        if (active) setAuthState("unauthenticated");
      });
    return () => {
      active = false;
    };
  }, []);

  const isMac = isMacPlatform();

  if (authState === "checking") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg text-muted">
        <Loader2 size={18} className="animate-spin" aria-label="正在检查登录状态" />
      </div>
    );
  }
  if (authState === "unauthenticated") {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {sidebarCollapsed && (
          <div className="flex h-12 shrink-0 items-center pl-2">
            <button
              onClick={() => setSidebarCollapsed(false)}
              aria-label="展开侧边栏"
              title={`展开侧边栏 (${isMac ? "⌘B" : "Ctrl+B"})`}
              className="fade-in rounded p-1 text-text hover:bg-surface-2"
            >
              <PanelLeft size={14} strokeWidth={1.5} />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
      {/* Every shell form gets the palette and the shortcut cheat sheet — the
          palette trims itself to hosted-safe entries internally. */}
      <CommandPalette />
      <ShortcutHelp />
      <Toaster />
    </div>
  );
}
