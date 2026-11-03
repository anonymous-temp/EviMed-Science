import { sanitizeRuntimeUiHistoryState } from "@/lib/runtimeUiNavigation";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router";
import { ArrowLeft, ChartNoAxesCombined, ChevronDown, FileText, FolderOpen, MessageSquare, Settings } from "lucide-react";
import { listGeoProjects, type GeoProjectSummary } from "@/lib/geoClient";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { navItemClasses } from "@/components/ui/NavItem";
import { geoDestinationPath, geoTabPath, geoWorkArea, resolveGeoTab, type GeoTabKey } from "./geoTabs";
import { geoAnalysisDescriptor, geoAnalysisTabForView } from "./geoAnalysisMode";
import { geoPathWithContext } from "./useGeoPath";
import { withStartDate } from "./geoText";

/** Resolve only a single GEO project path; never derive the module identity from the global project. */
export function geoWorkspaceId(pathname: string): string | null {
  const match = /^\/app\/geo\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : null;
  } catch { return null; }
}

/**
 * Component: GeoWorkspaceNav; owner: H; rules: GEO V2 project navigation.
 * Anatomy: return to the platform, project chooser and four work destinations.
 * Variants: legacy chat, answer and existing result addresses share this navigation.
 * States: project list loading/failure leave the all-projects route usable.
 * Hit area: native links and shared menu controls.
 * Keyboard: shared menu and native links retain their usual navigation.
 * Long content: project names truncate; the menu scrolls.
 * Theme: existing sidebar and navigation tokens.
 * Responsive: uses the platform sidebar's existing overlay and resize behavior.
 * Verification: Sidebar.test.tsx; browser and assistive-technology checks remain separate.
 */
export function GeoWorkspaceNav({ geoId }: { geoId: string }) {
  const location = useLocation();
  const [projects, setProjects] = useState<GeoProjectSummary[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    void listGeoProjects().then((rows) => { if (live) setProjects(rows); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [geoId, attempt]);

  const labels = useMemo(() => withStartDate(projects), [projects]);
  const params = new URLSearchParams(location.search);
  const part = location.pathname.split("/")[4];
  const tab: GeoTabKey = part === "answers" ? "questions" : resolveGeoTab(part === "chat" ? params.get("result") : part).tab;
  const analysis = geoAnalysisDescriptor(location.search);
  const area = geoWorkArea(analysis ? geoAnalysisTabForView(analysis.viewId) : tab, analysis ? null : params.get("view"));
  const path = (target: string) => geoPathWithContext(target, location);
  const settings = new URLSearchParams(location.search);
  settings.set("panel", "settings");
  const settingsPath = `${location.pathname}?${settings.toString()}${location.hash}`;
  const choices: MenuEntry[] = [
    { label: "全部项目", to: "/app/geo", onSelect: () => {} },
    ...(projects.length ? ["separator" as const] : []),
    ...projects.map((project) => ({ label: labels.get(project.id) ?? project.name,
      ...(project.id === geoId ? {} : { to: geoTabPath(project.id, "overview") }), checked: project.id === geoId, onSelect: () => {} })),
  ];
  const current = projects.find((project) => project.id === geoId);
  const rows = [
    { area: "work", label: "项目工作", icon: MessageSquare, to: geoTabPath(geoId, "overview") },
    { area: "analytics", label: "AI 表现", icon: ChartNoAxesCombined, to: geoTabPath(geoId, "visibility") },
    { area: "content", label: "内容与发布", icon: FileText, to: geoTabPath(geoId, "actions") },
    { area: "context", label: "产品与资料", icon: FolderOpen, to: geoDestinationPath(geoId, { tab: "evidence" }) },
  ] as const;
  return <nav aria-label="循证 GEO 工作区" className="flex flex-col gap-1 px-3">
    <Link to="/app/home" className={navItemClasses()}><ArrowLeft size={16} aria-hidden="true" /><span>返回平台</span></Link>
    <div className="px-2 pb-1 pt-3 text-caption text-text-3">循证 GEO</div>
    <Menu label="选择 GEO 项目" align="start" items={choices}>
      <Button variant="secondary" aria-label={`选择项目：${current ? labels.get(current.id) ?? current.name : "当前项目"}`} className="mb-2 w-full justify-between">
        <span className="min-w-0 truncate">{current ? labels.get(current.id) ?? current.name : "当前项目"}</span><ChevronDown size={16} aria-hidden="true" />
      </Button>
    </Menu>
    {failed && <Button size="sm" variant="text" onClick={() => setAttempt((value) => value + 1)}>重试项目列表</Button>}
    {rows.map((row) => <Link key={row.area} to={path(row.to)} state={sanitizeRuntimeUiHistoryState(location.state)} aria-current={area === row.area ? "page" : undefined} className={navItemClasses({ current: area === row.area })}>
      <row.icon size={16} aria-hidden="true" /><span className="truncate">{row.label}</span>
    </Link>)}
    <Link to={settingsPath} state={sanitizeRuntimeUiHistoryState(location.state)} className={navItemClasses()}><Settings size={16} aria-hidden="true" /><span>项目设置</span></Link>
  </nav>;
}
