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
const GalleryPage = lazy(() => import("./routes/GalleryPage").then((m) => ({ default: m.GalleryPage })));
const AutopilotPage = lazy(() => import("./routes/AutopilotPage").then((m) => ({ default: m.AutopilotPage })));
const CapabilitiesPage = lazy(() => import("./routes/CapabilitiesPage").then((m) => ({ default: m.CapabilitiesPage })));
const InboxPage = lazy(() => import("./routes/InboxPage").then((m) => ({ default: m.InboxPage })));
const MemoryHubPage = lazy(() => import("./routes/MemoryHubPage").then((m) => ({ default: m.MemoryHubPage })));
const AccountPage = lazy(() => import("./routes/AccountPage").then((m) => ({ default: m.AccountPage })));
const SimulatedWalletPage = lazy(() => import("./routes/SimulatedWalletPage").then((m) => ({ default: m.SimulatedWalletPage })));
const RunFilePage = lazy(() => import("./routes/RunFilePage").then((m) => ({ default: m.RunFilePage })));
const FrontierPage = lazy(() => import("./routes/FrontierPage").then((m) => ({ default: m.FrontierPage })));
const FrontierEventPage = lazy(() => import("./routes/FrontierEventPage").then((m) => ({ default: m.FrontierEventPage })));
const VcrHomePage = lazy(() => import("./virtual-research/VcrHomePage").then((m) => ({ default: m.VcrHomePage })));
const VcrStudyPage = lazy(() => import("./virtual-research/VcrStudyPage").then((m) => ({ default: m.VcrStudyPage })));
const EvidenceZonesPage = lazy(() => import("./routes/EvidenceZonesPage").then((m) => ({ default: m.EvidenceZonesPage })));
const EvidenceZonePage = lazy(() => import("./routes/EvidenceZonePage").then((m) => ({ default: m.EvidenceZonePage })));
const EvidenceReadingPage = lazy(() => import("./routes/EvidenceReadingPage").then((m) => ({ default: m.EvidenceReadingPage })));
const EvidenceAuthorPage = lazy(() => import("./routes/EvidenceAuthorPage").then((m) => ({ default: m.EvidenceAuthorPage })));
const GeoHomePage = lazy(() => import("./routes/GeoHomePage").then((m) => ({ default: m.GeoHomePage })));
const GeoProjectPage = lazy(() => import("./routes/GeoProjectPage").then((m) => ({ default: m.GeoProjectPage })));
const GeoAnswerPage = lazy(() => import("./routes/GeoAnswerPage").then((m) => ({ default: m.GeoAnswerPage })));
const HandoffRoute = lazy(() => import("./routes/HandoffRoute").then((m) => ({ default: m.HandoffRoute })));
const SkillsPage = lazy(() => import("./extensions/SkillsPage").then((m) => ({ default: m.SkillsPage })));
const SkillDetailPage = lazy(() => import("./extensions/SkillDetailPage").then((m) => ({ default: m.SkillDetailPage })));
const PluginsPage = lazy(() => import("./extensions/PluginsPage").then((m) => ({ default: m.PluginsPage })));
const PluginDetailPage = lazy(() => import("./extensions/PluginDetailPage").then((m) => ({ default: m.PluginDetailPage })));

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
        // 「转为深度研究」 from EviMed's AI search: the payload is the fragment,
        // and the page ends on the conversation it opens.
        { path: "handoff", element: <HandoffRoute /> },
        // 「前沿动态」: the feed, and one event of it. Both answer for themselves
        // when the module is off here — a bookmark gets one sentence, not a 404.
        { path: "frontier", element: <FrontierPage /> },
        { path: "frontier/events/:eventId", element: <FrontierEventPage /> },
        // 「虚拟临研」: the module's home, and one study's seven tabs (总览
        // when none is named). A study package is read at `?package=<id>` on
        // the study's own address rather than at a route of its own — it is a
        // view of the study, and a third route would make it a place people
        // can arrive at without the study around it.
        { path: "virtual-research", element: <VcrHomePage /> },
        { path: "virtual-research/:studyId/:tab?", element: <VcrStudyPage /> },
        { path: "frontier/zones", element: <EvidenceZonesPage /> },
        { path: "frontier/zones/:zoneId", element: <EvidenceZonePage /> },
        { path: "frontier/zones/:zoneId/evidence/:cardId", element: <EvidenceReadingPage /> },
        { path: "frontier/authors/:userId", element: <EvidenceAuthorPage /> },
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
        // The simulated wallet's four commerce pages — 模拟充值, 模拟会员, 模拟订单,
        // 模拟退款 — at the addresses the domain names (`SIMULATED_WALLET_PAGES`),
        // which is where the control plane's commerce links point on a
        // deployment whose wallet is simulated. The page answers for itself
        // where the wallet is not: one sentence, not a 404.
        { path: "account/simulated/:page", element: <SimulatedWalletPage /> },
        { path: "extensions", element: <Navigate to="/app/extensions/plugins" replace /> },
        { path: "extensions/plugins", element: <PluginsPage /> },
        { path: "extensions/plugins/:extensionId", element: <PluginDetailPage /> },
        { path: "extensions/skills", element: <SkillsPage /> },
        { path: "extensions/skills/:skillId", element: <SkillDetailPage /> },
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
  // The component gallery: every primitive in every state, outside the shell
  // and outside a session. CI screenshots it and diffs the result, which is how
  // changing a component's look becomes a review with a picture in it. Under
  // `/app` it would have needed a login and drawn the sidebar around itself —
  // neither of which is the thing being compared. Not in a production build —
  // except the one CI builds for the comparison (`VITE_EVIMED_GALLERY=1`,
  // served by `vite preview`), which is never deployed.
  ...(import.meta.env.PROD && import.meta.env.VITE_EVIMED_GALLERY !== "1"
    ? []
    : [{ path: "/__gallery", element: <GalleryPage />, errorElement: <RouteError /> }]),
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
