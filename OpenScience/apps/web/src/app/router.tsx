import { createBrowserRouter, Navigate, useParams, type RouteObject } from "react-router";
import { AppShell } from "./layout/AppShell";
import { SessionRoute } from "./routes/SessionRoute";
import { KnowledgePage } from "./routes/KnowledgePage";
import { AutopilotPage } from "./routes/AutopilotPage";
import { CapabilitiesPage } from "./routes/CapabilitiesPage";
import { InboxPage } from "./routes/InboxPage";
import { MemoryHubPage } from "./routes/MemoryHubPage";
import { LoginPage } from "./routes/LoginPage";
import { AccountPage } from "./routes/AccountPage";
import { RunsPage } from "./routes/RunsPage";
import { NotFound } from "./routes/NotFound";

/**
 * One prefix for the workbench, so that everything outside it — the login
 * page, and whatever a browser lands on before it has an account — is
 * distinguishable from a page of the product by its URL alone.
 *
 * No route carries a project id. The project is an account-level selection the
 * API client sends as a header; a URL that named it would make every link
 * someone shares carry a project their reader may not have.
 */
export const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  {
    path: "/app",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/app/chat" replace /> },
      { path: "chat", element: <SessionRoute /> },
      { path: "chat/:sessionId", element: <SessionRoute /> },
      { path: "runs", element: <RunsPage /> },
      { path: "files", element: <KnowledgePage /> },
      { path: "autopilot", element: <AutopilotPage /> },
      { path: "memory", element: <MemoryHubPage /> },
      { path: "inbox", element: <InboxPage /> },
      { path: "capabilities", element: <CapabilitiesPage /> },
      { path: "account", element: <AccountPage /> },
      // Seven destinations, six of them above (2026-09-15 walk, C8). The four
      // below were top-level rows until then; each is now a view of one of the
      // six, and each keeps its address, because these are in people's
      // bookmarks, in notification links and in this shell's own history.
      { path: "sources", element: <Navigate to="/app/files?tab=sources" replace /> },
      { path: "notebooks", element: <Navigate to="/app/files?tab=notebooks" replace /> },
      { path: "capsules", element: <Navigate to="/app/memory?tab=capsules" replace /> },
      { path: "settings", element: <Navigate to="/app/account?tab=settings" replace /> },
      { path: "ops", element: <Navigate to="/app/account?tab=ops" replace /> },
      { path: "*", element: <NotFound /> },
    ],
  },
  { path: "/", element: <Navigate to="/app/chat" replace /> },
  // The paths this shell used before it had a prefix. They were linked to from
  // runs, from notification mail and from people's bookmarks, and a redirect
  // costs one route each; dropping them would turn every one of those into a
  // 404 that says nothing about where the page went.
  { path: "/live", element: <ChatRedirect /> },
  { path: "/live/:sessionId", element: <ChatRedirect /> },
  { path: "/runs", element: <Navigate to="/app/runs" replace /> },
  { path: "/files", element: <Navigate to="/app/files" replace /> },
  { path: "/sources", element: <Navigate to="/app/files?tab=sources" replace /> },
  { path: "/notebooks", element: <Navigate to="/app/files?tab=notebooks" replace /> },
  { path: "/memory", element: <Navigate to="/app/memory" replace /> },
  { path: "/agents", element: <Navigate to="/app/capabilities" replace /> },
  { path: "/settings", element: <Navigate to="/app/account?tab=settings" replace /> },
  { path: "*", element: <NotFound /> },
];

/** `/live/:sessionId` → `/app/chat/:sessionId`, keeping the session. */
function ChatRedirect() {
  const { sessionId } = useParams();
  return <Navigate to={sessionId ? `/app/chat/${sessionId}` : "/app/chat"} replace />;
}

export const router = createBrowserRouter(routes);
