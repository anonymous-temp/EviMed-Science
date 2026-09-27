import { Suspense, useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { Loader2, PanelLeft } from "lucide-react";
import { cn } from "@/lib/cn";
import { isChatPath } from "@/lib/runLocation";
import { isMacPlatform } from "@/lib/platform";
import { isEmbeddedShell } from "@/app/layout/embed";
import { SessionFrameHost } from "@/app/layout/SessionFrameHost";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { IconButton } from "@/components/ui/IconButton";
import { ShortcutHelp } from "@/components/ui/ShortcutHelp";
import { Toaster } from "@/components/ui/Toaster";
import { useProjectStore } from "@/lib/projects";
import { useUiStore } from "@/lib/store";
import { fetchWebMe, WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT } from "@/lib/apiClient";

export function AppShell() {
  const { sidebarCollapsed, setSidebarCollapsed } = useUiStore();
  const currentProjectId = useProjectStore((state) => state.currentId);
  const location = useLocation();
  const onChat = isChatPath(location.pathname);
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  // Inside the EviMed Vue shell (`?embed=1`): the content area and nothing
  // else — the host draws the sidebar. Decided once, from the entry address,
  // because a link inside an embedded page drops the query string.
  const [embedded] = useState(() => isEmbeddedShell(location.search));
  const mainRef = useRef<HTMLElement>(null);

  // Below `lg` the sidebar is a drawer over the content, not a column beside
  // it, so it starts closed: at 390 px it kept its full width and left the
  // content a sliver (2026-09-16 walk, U1). Only on mount, and only when the
  // viewport is narrow — a desktop browser keeps whatever the person chose.
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      useUiStore.getState().setSidebarCollapsed(true);
    }
  }, []);

  // Cmd/Ctrl+B toggles the sidebar, matching the button's tooltip. An
  // embedded shell has no sidebar to toggle, and the key is the host's.
  useEffect(() => {
    if (embedded) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useUiStore.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded]);

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
      <div className="flex h-dvh w-screen items-center justify-center bg-bg text-muted">
        <Loader2 size={20} className="animate-spin" aria-label="正在检查登录状态" />
      </div>
    );
  }
  if (authState === "unauthenticated") {
    return <Navigate to="/login" replace />;
  }

  return (
    // `h-dvh`, not `h-screen`: on a phone `100vh` is the viewport without the
    // browser's own toolbars, so the last row of every page sat under them.
    <div className="flex h-dvh w-screen overflow-hidden bg-bg text-text" data-embedded={embedded || undefined}>
      {/* The first thing Tab reaches on every page (spec §10.3, appendix E
          #3): invisible until focused, then top-left on the skip tier, above
          everything. It moves focus rather than the address — a `#main` hash
          would be a navigation the router has to hear about. Not when
          embedded: there is no sidebar to skip, and the host has its own. */}
      {!embedded && (
        <a
          href="#main"
          onClick={(event) => {
            event.preventDefault();
            mainRef.current?.focus();
          }}
          className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-skip focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:text-ui focus:text-text focus:shadow-e2"
        >
          跳到主要内容
        </a>
      )}
      {!embedded && (
        <>
          {/* The drawer's backdrop, below `lg` only, where the sidebar overlays
              the content. On the drawer tier and before the sidebar in the
              document, so the sidebar paints above it. */}
          {!sidebarCollapsed && (
            <button
              type="button"
              aria-label="关闭侧边栏"
              onClick={() => setSidebarCollapsed(true)}
              className="fixed inset-0 z-drawer bg-scrim lg:hidden"
            />
          )}
          <Sidebar />
        </>
      )}
      <main id="main" ref={mainRef} tabIndex={-1} className="flex min-w-0 flex-1 flex-col focus:outline-none">
        {!embedded && sidebarCollapsed && (
          <div className="flex h-12 shrink-0 items-center pl-2">
            {/* The chrome's 36 px icon button: below `lg` this is the only
                way off a page a phone was sent to. */}
            <IconButton
              icon={PanelLeft}
              label="展开侧边栏"
              title={`展开侧边栏 (${isMac ? "⌘B" : "Ctrl+B"})`}
              onClick={() => setSidebarCollapsed(false)}
              className="fade-in text-text"
            />
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {/* The conversation surface, above the router and hidden rather than
            * unmounted off it (`SessionFrameHost`). This is the one page that
            * costs a container document, a websocket and a kernel handshake to
            * mount, and putting it inside the router made every visit to any
            * other page pay for all three again on the way back. */}
          <SessionFrameHost />
          {/* Keyed by the project — but never on the conversation surface,
            * whose frame must survive a project switch. A switch remounts the
            * page under the new one: every other page reads the project when
            * it mounts (a header, a workspace path, a list) and none of them
            * listens for a change; the reload this replaced relied on exactly
            * that, and so does this. What sits outside it (the sidebar and the
            * bell) is either account-wide or follows `currentId` itself.
            * On the conversation surface the route renders overlays only, so
            * it floats above the frame and lets pointer events through. */}
          <div className={cn(onChat && "pointer-events-none absolute inset-0 z-20", !onChat && "h-full")}>
            <Suspense fallback={onChat ? null : <RouteFallback />}>
              <Outlet key={onChat ? "chat" : currentProjectId} />
            </Suspense>
          </div>
        </div>
      </main>
      {/* The shortcut sheet lists the sidebar's keys; an embedded shell has no
          sidebar, and its host owns the keyboard. */}
      {!embedded && <ShortcutHelp />}
      <Toaster />
    </div>
  );
}

/** What a route chunk's arrival looks like. Status text is 正在 + a verb and no
 *  ellipsis (spec §13.7, appendix E #26). */
function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-bg text-text-3" role="status" aria-live="polite">
      <Loader2 size={20} className="animate-spin" aria-hidden="true" />
      <span className="ml-2 text-ui">正在载入</span>
    </div>
  );
}
