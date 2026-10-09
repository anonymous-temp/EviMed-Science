import { Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { Loader2, PanelLeft } from "lucide-react";
import { cn } from "@/lib/cn";
import { isChatPath } from "@/lib/runLocation";
import { isMacPlatform } from "@/lib/platform";
import { isEmbeddedShell } from "@/app/layout/embed";
import { SessionFrameHost } from "@/app/layout/SessionFrameHost";
import { useRouteFocus } from "@/app/layout/routeFocus";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { IconButton } from "@/components/ui/IconButton";
import { ShortcutHelp } from "@/components/ui/ShortcutHelp";
import { Toaster } from "@/components/ui/Toaster";
import { useProjectStore } from "@/lib/projects";
import { useUiStore } from "@/lib/store";
import { fetchWebMe, WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT } from "@/lib/apiClient";
import { loginAddress } from "@/lib/loginReturn";

/** Below Tailwind's `lg` the sidebar is a drawer over the content; from `lg` up it is a column beside it. */
const DRAWER_LAYOUT = "(max-width: 1023px)";

function useDrawerLayout(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(DRAWER_LAYOUT);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(DRAWER_LAYOUT).matches,
    () => false,
  );
}

export function AppShell() {
  const { sidebarCollapsed, setSidebarCollapsed } = useUiStore();
  const currentProjectId = useProjectStore((state) => state.currentId);
  const location = useLocation();
  const onChat = isChatPath(location.pathname);
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  // A person who signed out (or deleted the account) is not sent back to the page they left when they sign in again; one whose session
  // simply ended, or who opened a deep link without one, is (design reference §16.3).
  const signedOut = useRef(false);
  // Inside the EviMed Vue shell (`?embed=1`): the content area and nothing
  // else — the host draws the sidebar. Decided once, from the entry address,
  // because a link inside an embedded page drops the query string.
  const [embedded] = useState(() => isEmbeddedShell(location.search));
  const mainRef = useRef<HTMLElement>(null);
  // Where keyboard focus goes when the sidebar closes or opens, for the cases the DOM cannot tell afterwards: the scrim button and
  // the Escape key close it with focus on something that is gone or not in it, and a reader who opens it wants to be in it.
  const expandRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"expand" | "nav" | null>(null);
  const drawerLayout = useDrawerLayout();
  // The sidebar over the content (below `lg`, open): the page behind it is not there to be reached.
  const drawerOpen = !embedded && drawerLayout && !sidebarCollapsed;
  const closeSidebar = () => {
    focusAfter.current = "expand";
    setSidebarCollapsed(true);
  };

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
        // Opening it by key puts the reader in it; closing it leaves focus where the page has it unless it was in the sidebar.
        focusAfter.current = sidebarCollapsed ? "nav" : null;
        useUiStore.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded, sidebarCollapsed]);

  // Escape closes the drawer, as it closes every other layer over the page — unless a layer above it (a menu, a rename field, a
  // tooltip) has already taken the key.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      focusAfter.current = "expand";
      setSidebarCollapsed(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen, setSidebarCollapsed]);

  // Focus follows the sidebar. Closed, it is `inert` and what was focused in it is unreachable, so the reader lands on the button
  // that opens it again; opened by the expand button or the key, on its first destination. `preventScroll`: the column is still
  // 0 wide when this runs, and focusing into a clipped box would scroll it sideways.
  const wasCollapsed = useRef(sidebarCollapsed);
  useLayoutEffect(() => {
    if (wasCollapsed.current === sidebarCollapsed) return;
    wasCollapsed.current = sidebarCollapsed;
    const wanted = focusAfter.current;
    focusAfter.current = null;
    if (embedded) return;
    if (sidebarCollapsed) {
      const inSidebar = document.activeElement instanceof Element && document.activeElement.closest("[data-sidebar]") !== null;
      if (wanted === "expand" || inSidebar) expandRef.current?.focus({ preventScroll: true });
    } else if (wanted === "nav") {
      document.querySelector<HTMLElement>("[data-sidebar] nav a")?.focus({ preventScroll: true });
    }
  }, [sidebarCollapsed, embedded]);

  useEffect(() => {
    const clearSession = (event: Event) => {
      signedOut.current = (event as CustomEvent<{ deliberate?: boolean } | undefined>).detail?.deliberate === true;
      useProjectStore.getState().clear();
      setAuthState("unauthenticated");
    };
    const startSession = () => {
      signedOut.current = false;
      setAuthState("authenticated");
    };
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

  // A new page's heading takes focus when the path changes (spec §5.3). Called here, above the early returns, because it is a hook;
  // it waits until there is a page to move focus into.
  useRouteFocus(location.pathname, mainRef, authState === "authenticated");

  const isMac = isMacPlatform();

  if (authState === "checking") {
    return (
      <div className="flex h-dvh w-screen items-center justify-center bg-bg text-muted">
        <Loader2 size={20} className="animate-spin" aria-label="正在检查登录状态" />
      </div>
    );
  }
  if (authState === "unauthenticated") {
    return <Navigate to={signedOut.current ? "/login" : loginAddress(location)} replace />;
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
              onClick={closeSidebar}
              className="fixed inset-0 z-drawer bg-scrim lg:hidden"
            />
          )}
          <Sidebar />
        </>
      )}
      <main id="main" ref={mainRef} tabIndex={-1} inert={drawerOpen} className="flex min-w-0 flex-1 flex-col focus:outline-none">
        {!embedded && sidebarCollapsed && (
          <div className="flex h-12 shrink-0 items-center pl-2">
            {/* The chrome's 36 px icon button: below `lg` this is the only
                way off a page a phone was sent to. */}
            <IconButton
              ref={expandRef}
              icon={PanelLeft}
              label="展开侧边栏"
              title={`展开侧边栏 (${isMac ? "⌘B" : "Ctrl+B"})`}
              onClick={() => {
                focusAfter.current = "nav";
                setSidebarCollapsed(false);
              }}
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
          <div className={cn(onChat && "pointer-events-none absolute inset-0 z-sticky", !onChat && "h-full")}>
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
