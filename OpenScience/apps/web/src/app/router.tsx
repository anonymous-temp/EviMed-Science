import { lazy } from "react";
import { createBrowserRouter, Navigate, useParams, type RouteObject } from "react-router";
import { AppShell } from "./layout/AppShell";
import { LoginPage } from "./routes/LoginPage";
import { NotFound } from "./routes/NotFound";

/**
 * Every workbench page is its own chunk.
 *
 * Until 2026-09-16 there were none: one entry chunk of 1,874,636 B carried
 * three.js, highlight.js and react-markdown, and the login page downloaded all
 * of it before it could show a password field (2026-09-16 walk, D1). Login and
 * the 404 stay eager — they are what a browser lands on before it has an
 * account, and a spinner there would be the first thing anyone sees.
 *
 * `AppShell` renders the fallback for these (`Suspense`), so a chunk still in
 * flight shows the shell with its navigation rather than a blank page.
 */
const SessionRoute = lazy(() => import("./routes/SessionRoute").then((m) => ({ default: m.SessionRoute })));
const KnowledgePage = lazy(() => import("./routes/KnowledgePage").then((m) => ({ default: m.KnowledgePage })));
const AutopilotPage = lazy(() => import("./routes/AutopilotPage").then((m) => ({ default: m.AutopilotPage })));
const CapabilitiesPage = lazy(() => import("./routes/CapabilitiesPage").then((m) => ({ default: m.CapabilitiesPage })));
const InboxPage = lazy(() => import("./routes/InboxPage").then((m) => ({ default: m.InboxPage })));
const MemoryHubPage = lazy(() => import("./routes/MemoryHubPage").then((m) => ({ default: m.MemoryHubPage })));
const AccountPage = lazy(() => import("./routes/AccountPage").then((m) => ({ default: m.AccountPage })));
const RunsPage = lazy(() => import("./routes/RunsPage").then((m) => ({ default: m.RunsPage })));
const RunFilePage = lazy(() => import("./routes/RunFilePage").then((m) => ({ default: m.RunFilePage })));

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
      // One file of one run in the reader: where the frame's 交付物 / 依据
      // tabs land (`open-artifact`, contract C9) and where a claim's preserved
      // source opens with its quotation marked.
      { path: "runs/:runId/files/*", element: <RunFilePage /> },
      { path: "files", element: <KnowledgePage /> },
      { path: "autopilot", element: <AutopilotPage /> },
      { path: "memory", element: <MemoryHubPage /> },
      { path: "inbox", element: <InboxPage /> },
      { path: "capabilities", element: <CapabilitiesPage /> },
      { path: "account", element: <AccountPage /> },
      // Seven destinations, six of them above (2026-09-15 walk, C8). The rows
      // below were top-level pages until then; each is now a view of one of the
      // six, and each keeps its address, because these are in people's
      // bookmarks, in notification links and in this shell's own history.
      // `notebooks` is the exception: the computational notebook was deleted on
      // 2026-09-19, and its address lands on the files it used to sit beside,
      // which is where a run's `.ipynb` deliverables still are.
      { path: "sources", element: <Navigate to="/app/files?tab=sources" replace /> },
      { path: "notebooks", element: <Navigate to="/app/files" replace /> },
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
  { path: "/notebooks", element: <Navigate to="/app/files" replace /> },
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
