import { useMemo } from "react";
import { Navigate } from "react-router";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";

/**
 * 「定时任务」: the kernel's own page, in the frame of the project on screen. A blank conversation is what the frame opens on anyway; the
 * intent asks it to show the page over it. What a task does and where its results go is the kernel's and the run ledger's.
 */
export function ScheduledTasksPage() {
  const runtimeUiIntent = useMemo(() => ({ ...newRuntimeUiIntent(), panel: "schedules" as const }), []);
  return <Navigate to="/app/chat" replace state={{ runtimeUiIntent }} />;
}
