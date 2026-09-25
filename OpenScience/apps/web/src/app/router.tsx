import { lazy, useEffect, useState } from "react";
import { createBrowserRouter, Navigate, useParams, useSearchParams, type RouteObject } from "react-router";
import { chatPath, findRunSession } from "@/lib/runLocation";
import { AppShell } from "./layout/AppShell";
import { FrameSkeleton } from "./routes/RuntimeUiFrame";
import { LoginPage } from "./routes/LoginPage";
import { NotFound } from "./routes/NotFound";
import { RouteError } from "./routes/RouteError";

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
const RunFilePage = lazy(() => import("./routes/RunFilePage").then((m) => ({ default: m.RunFilePage })));
const FrontierPage = lazy(() => import("./routes/FrontierPage").then((m) => ({ default: m.FrontierPage })));
const FrontierEventPage = lazy(() => import("./routes/FrontierEventPage").then((m) => ({ default: m.FrontierEventPage })));
const GeoHomePage = lazy(() => import("./routes/GeoHomePage").then((m) => ({ default: m.GeoHomePage })));
const GeoProjectPage = lazy(() => import("./routes/GeoProjectPage").then((m) => ({ default: m.GeoProjectPage })));
const GeoAnswerPage = lazy(() => import("./routes/GeoAnswerPage").then((m) => ({ default: m.GeoAnswerPage })));

/**
 * One prefix for the workbench, so that everything outside it — the login
 * page, and whatever a browser lands on before it has an account — is
 * distinguishable from a page of the product by its URL alone.
 *
 * No route carries a project id. The project is an account-level selection the
 * API client sends as a header; a URL that named it would make every link
 * someone shares carry a project their reader may not have.
 *
 * Every route that renders something has an error element (`RouteError`):
 * without one React Router's own English error page stands in (UI plan §2.1).
 */
export const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage />, errorElement: <RouteError /> },
  {
    path: "/app",
    element: <AppShell />,
    // The shell itself failing: nothing of it is left to keep.
    errorElement: <RouteError />,
    children: [{
      // Every page, under one pathless route whose error element renders
      // inside the shell: a page that fails — most often a chunk a release
      // has replaced — becomes one sentence and a button, and the sidebar and
      // the conversation frame stay where they were.
      errorElement: <RouteError />,
      children: [
        { index: true, element: <Navigate to="/app/chat" replace /> },
        // One route, with or without the conversation's id. Two route objects
        // made `/app/chat` → `/app/chat/:id` a remount, and the surface resumes
        // the last conversation on arrival, so every plain visit paid for one
        // (2026-09-20 review B §C item 3).
        { path: "chat/:sessionId?", element: <SessionRoute /> },
        // 「前沿动态」: the feed, and one event of it. Both answer for themselves
        // when the module is off here — a bookmark gets one sentence, not a 404.
        { path: "frontier", element: <FrontierPage /> },
        { path: "frontier/events/:eventId", element: <FrontierEventPage /> },
        // 「循证 GEO」: the projects, one project's tabs (概览 when none is
        // named), and one AI answer. Like the frontier feed, each answers for
        // itself when the module is off here.
        { path: "geo", element: <GeoHomePage /> },
        { path: "geo/:geoId/answers/:snapshotId", element: <GeoAnswerPage /> },
        { path: "geo/:geoId/:tab?", element: <GeoProjectPage /> },
        // The run ledger page was deleted on 2026-09-20: a run is read in the
        // conversation it happened in. Its address survives because it is in
        // notification mail, in Feishu cards and in people's bookmarks.
        { path: "runs", element: <RunRedirect /> },
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
        { path: "settings", element: <Navigate to="/app/account?tab=appearance" replace /> },
        { path: "ops", element: <Navigate to="/app/account?tab=ops" replace /> },
        { path: "*", element: <NotFound /> },
      ],
    }],
  },
  { path: "/", element: <Navigate to="/app/chat" replace /> },
  // The paths this shell used before it had a prefix. They were linked to from
  // runs, from notification mail and from people's bookmarks, and a redirect
  // costs one route each; dropping them would turn every one of those into a
  // 404 that says nothing about where the page went.
  { path: "/live", element: <ChatRedirect /> },
  { path: "/live/:sessionId", element: <ChatRedirect /> },
  { path: "/runs", element: <RunRedirect /> },
  { path: "/files", element: <Navigate to="/app/files" replace /> },
  { path: "/sources", element: <Navigate to="/app/files?tab=sources" replace /> },
  { path: "/notebooks", element: <Navigate to="/app/files" replace /> },
  { path: "/memory", element: <Navigate to="/app/memory" replace /> },
  { path: "/agents", element: <Navigate to="/app/capabilities" replace /> },
  { path: "/settings", element: <Navigate to="/app/account?tab=appearance" replace /> },
  { path: "*", element: <NotFound />, errorElement: <RouteError /> },
];

/** `/live/:sessionId` → `/app/chat/:sessionId`, keeping the conversation. */
function ChatRedirect() {
  const { sessionId } = useParams();
  return <Navigate to={chatPath(sessionId)} replace />;
}

/**
 * `/app/runs?run=<id>` → the conversation that run happened in.
 *
 * The ledger page is gone, but its address is what a Feishu card, a pushed
 * notice and a bookmark carry, and a run id is not a conversation id — the
 * ledger is the only thing that knows which conversation a run belongs to, and
 * that run may be in another of the account's projects. So this resolves
 * rather than rewrites, and lands on the bare surface when it cannot: a run
 * nothing can be found for is not a 404 the reader can act on.
 */
function RunRedirect() {
  const [params] = useSearchParams();
  const runId = params.get("run") ?? "";
  const [to, setTo] = useState<string | null>(runId ? null : "/app/chat");
  useEffect(() => {
    if (!runId) return;
    let live = true;
    void findRunSession(runId)
      .then((sessionId) => { if (live) setTo(chatPath(sessionId)); })
      .catch(() => { if (live) setTo("/app/chat"); });
    return () => { live = false; };
  }, [runId]);
  return to ? <Navigate to={to} replace /> : <FrameSkeleton />;
}

export const router = createBrowserRouter(routes);
