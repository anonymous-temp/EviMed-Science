import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { Loader2, PanelLeft } from "lucide-react";
import { cn } from "@/lib/cn";
import { isMacPlatform } from "@/lib/platform";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { CommandPalette } from "@/components/command-palette/CommandPalette";
import { ShortcutHelp } from "@/components/ui/ShortcutHelp";
import { Toaster } from "@/components/ui/Toaster";
import { useRuntimeStore } from "@/lib/runtime";
import { useUiStore } from "@/lib/store";
import { ensureJupyter, isTauri, openExternal } from "@/lib/tauri";
import {
  fetchWebMe,
  hasWebApi,
  WEB_SESSION_ENDED_EVENT,
  WEB_SESSION_STARTED_EVENT,
} from "@/lib/apiClient";

export function AppShell() {
  const { sidebarCollapsed, setSidebarCollapsed } = useUiStore();
  const location = useLocation();
  const hostedWeb = hasWebApi && !isTauri;
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "unauthenticated">(
    hostedWeb ? "checking" : "authenticated",
  );

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
      useRuntimeStore.getState().clearHostedSession();
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
    if (!hostedWeb) return;
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
  }, [hostedWeb]);

  // Start the selected runtime after the hosted auth gate. Only the packaged
  // desktop app owns Jupyter provisioning and may restore that sidecar.
  useEffect(() => {
    if (hostedWeb && authState !== "authenticated") return;
    void useRuntimeStore.getState().bootstrap();
    if (isTauri) void ensureJupyter();
  }, [authState, hostedWeb]);

  // External links open in the system browser. Navigating the webview away
  // from the app would strand the user — there is no back button.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest?.("a[href]");
      const href = anchor?.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        void openExternal(href);
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // The live session page's own header doubles as the titlebar when the
  // sidebar is collapsed; every other route gets this fallback strip so the
  // macOS traffic lights don't overlap content, the window stays draggable,
  // and the sidebar can be re-expanded.
  const isMac = isMacPlatform();
  const overlayTitlebar = isTauri && isMac;
  const pageOwnsTitlebar = location.pathname.startsWith("/live");

  if (hostedWeb && authState === "checking") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg text-muted">
        <Loader2 size={18} className="animate-spin" aria-label="正在检查登录状态" />
      </div>
    );
  }
  if (hostedWeb && authState === "unauthenticated") {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {sidebarCollapsed && !pageOwnsTitlebar && (
          <div
            data-tauri-drag-region={overlayTitlebar || undefined}
            className={cn(
              "flex h-12 shrink-0 items-center",
              overlayTitlebar ? "pl-[78px]" : "pl-2",
            )}
          >
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
