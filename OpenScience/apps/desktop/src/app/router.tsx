import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { AppShell } from "./layout/AppShell";
import { LiveSessionPage } from "./routes/LiveSessionPage";
import { FilesPage } from "./routes/FilesPage";
import { AgentsPage } from "./routes/AgentsPage";
import { MemoryPage } from "./routes/MemoryPage";
import { SettingsPage } from "./routes/SettingsPage";
import { LoginPage } from "./routes/LoginPage";
import { AccountPage } from "./routes/AccountPage";
import { NotebooksPage } from "./routes/NotebooksPage";
import { RunsPage } from "./routes/RunsPage";
import { NotFound } from "./routes/NotFound";
import { hasWebApi } from "@/lib/apiClient";
import { isTauri } from "@/lib/tauri";

export const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/live" replace /> },
      { path: "live", element: <LiveSessionPage /> },
      { path: "live/:sessionId", element: <LiveSessionPage /> },
      { path: "notebooks", element: <NotebooksPage /> },
      { path: "runs", element: <RunsPage /> },
      { path: "files", element: <FilesPage /> },
      { path: "memory", element: <MemoryPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "settings", element: hasWebApi && !isTauri ? <AccountPage /> : <SettingsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
