import { Crosshair, Flame, Heart, Layers, List, Newspaper, Sparkles } from "lucide-react";
import { useLocation } from "react-router";
import { ModuleDirectoryNav, type ModuleDirectoryRow } from "@/components/sidebar/ModuleDirectoryNav";

/** The seven peer views of 前沿动态, in the order the page has always listed them; the key is the page's `?view=` value. */
const VIEWS = [
  { key: "selected", label: "精选", icon: Sparkles },
  { key: "all", label: "全部", icon: List },
  { key: "following", label: "关注", icon: Heart },
  { key: "hot", label: "热榜", icon: Flame },
  { key: "track", label: "追踪", icon: Crosshair },
  { key: "daily", label: "简报", icon: Newspaper },
  { key: "zones", label: "证据专区", icon: Layers },
] as const;

type FrontierNavView = typeof VIEWS[number]["key"];

/**
 * The view an address is at, or null on a page that is none of them. `/app/frontier` reads `?view=` as the page does (an older
 * `foryou` is 关注, `weekly` is 简报's second period, anything unknown is 精选); the zone and author pages belong to 证据专区; the
 * article, event, topic and congress reading pages carry no view and mark nothing.
 */
export function frontierNavView(pathname: string, search: string): FrontierNavView | null {
  if (pathname === "/app/frontier" || pathname === "/app/frontier/") {
    const value = new URLSearchParams(search).get("view");
    if (value === "foryou") return "following";
    if (value === "weekly") return "daily";
    return VIEWS.some(view => view.key === value) ? value as FrontierNavView : "selected";
  }
  return pathname.startsWith("/app/frontier/zones") || pathname.startsWith("/app/frontier/authors") ? "zones" : null;
}

/**
 * The rows: 精选 is the page's address with no view, the others name theirs. 简报 pressed on its weekly stays on the weekly, as
 * the tab did: the period chip is the way between the two.
 */
export function frontierDirectoryRows(pathname: string, search: string): ModuleDirectoryRow[] {
  const active = frontierNavView(pathname, search);
  const weekly = active === "daily" && new URLSearchParams(search).get("view") === "weekly";
  return VIEWS.map(view => ({ key: view.key, label: view.label, icon: view.icon,
    to: view.key === "daily" && weekly ? `${pathname}${search}` : view.key === "selected" ? "/app/frontier" : `/app/frontier?view=${view.key}`, current: active === view.key }));
}

/** Anatomy: the seven views of 前沿动态 nested under its sidebar row (see ModuleDirectoryNav). Verification: FrontierWorkspaceNav.test.tsx. */
export function FrontierWorkspaceNav() {
  const location = useLocation();
  return <ModuleDirectoryNav label="前沿动态视图" rows={frontierDirectoryRows(location.pathname, location.search)} />;
}
