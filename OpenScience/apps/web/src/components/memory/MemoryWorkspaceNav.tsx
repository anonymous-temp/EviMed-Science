import { Inbox, LayoutDashboard, ListChecks, UserRound } from "lucide-react";
import { useLocation } from "react-router";
import { ModuleDirectoryNav, type ModuleDirectoryRow } from "@/components/sidebar/ModuleDirectoryNav";
import { MEMORY_TAB_NAMES, memoryTabAddress, type MemoryPageTab } from "./memoryTabs";

const ICONS: Record<MemoryPageTab, typeof Inbox> = { overview: LayoutDashboard, self: UserRound, methods: ListChecks, received: Inbox };
const ORDER: readonly MemoryPageTab[] = ["overview", "self", "methods", "received"];

/**
 * The section an address is at, or null where the page itself chooses (`/app/memory` with no tab, on a deployment without the overview).
 * `?method=` is 做法's link, a share link or a delivery is the preview of what was received.
 */
export function memoryNavTab(pathname: string, search: string): MemoryPageTab | null {
  if (pathname.startsWith("/app/memory/overview")) return "overview";
  if (pathname.startsWith("/app/memory/shared/") || pathname.startsWith("/app/memory/delivered/")) return "received";
  if (pathname !== "/app/memory" && pathname !== "/app/memory/") return null;
  const params = new URLSearchParams(search);
  if (params.get("method")) return "methods";
  const named = params.get("tab");
  return named === "self" || named === "methods" || named === "received" ? named : null;
}

/** 总览 leads where the deployment draws it (it is the section in force wherever it is open); the three lists follow. */
export function memoryDirectoryRows(pathname: string, search: string, overviewOffered: boolean): ModuleDirectoryRow[] {
  const active = memoryNavTab(pathname, search);
  return ORDER.filter(tab => tab !== "overview" || overviewOffered || active === "overview")
    .map(tab => ({ key: tab, label: MEMORY_TAB_NAMES[tab], icon: ICONS[tab], to: memoryTabAddress(tab), current: tab === active }));
}

/** Anatomy: the sections of 记忆胶囊 nested under its sidebar row (see ModuleDirectoryNav). Verification: MemoryWorkspaceNav.test.tsx. */
export function MemoryWorkspaceNav({ overviewOffered }: { overviewOffered: boolean }) {
  const location = useLocation();
  return <ModuleDirectoryNav label="记忆胶囊的内容" rows={memoryDirectoryRows(location.pathname, location.search, overviewOffered)} />;
}
