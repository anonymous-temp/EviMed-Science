import { createBrowserRouter, Navigate, useParams, type RouteObject } from "react-router";
import { AppShell } from "./layout/AppShell";
import { SessionRoute } from "./routes/SessionRoute";
import { FilesPage } from "./routes/FilesPage";
import { CapabilitiesPage } from "./routes/CapabilitiesPage";
import { MemoryPage } from "./routes/MemoryPage";
import { SettingsPage } from "./routes/SettingsPage";
import { LoginPage } from "./routes/LoginPage";
import { AccountPage } from "./routes/AccountPage";
import { NotebooksPage } from "./routes/NotebooksPage";
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
      { path: "files", element: <FilesPage /> },
      { path: "notebooks", element: <NotebooksPage /> },
      { path: "memory", element: <MemoryPage /> },
      { path: "capabilities", element: <CapabilitiesPage /> },
      { path: "account", element: <AccountPage /> },
      { path: "settings", element: <SettingsPage /> },
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
  { path: "/notebooks", element: <Navigate to="/app/notebooks" replace /> },
  { path: "/memory", element: <Navigate to="/app/memory" replace /> },
  { path: "/agents", element: <Navigate to="/app/capabilities" replace /> },
  { path: "/settings", element: <Navigate to="/app/settings" replace /> },
  { path: "*", element: <NotFound /> },
];

/** `/live/:sessionId` → `/app/chat/:sessionId`, keeping the session. */
function ChatRedirect() {
  const { sessionId } = useParams();
  return <Navigate to={sessionId ? `/app/chat/${sessionId}` : "/app/chat"} replace />;
}

export const router = createBrowserRouter(routes);
