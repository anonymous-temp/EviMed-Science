import { Link, useLocation } from "react-router";
import { FlaskConical, GitCompareArrows, Route, UsersRound, UserSearch } from "lucide-react";
import { navItemClasses } from "@/components/ui/NavItem";
import { sanitizeRuntimeUiHistoryState } from "@/lib/runtimeUiNavigation";
import { vcrWorkspaceCurrentArea, vcrWorkspaceDestinationPath, type VcrWorkspaceArea } from "@/lib/vcrWorkspaceNavigation";

const rows = [
  { area: "virtual-population", label: "虚拟人群", icon: UsersRound },
  { area: "patient-trajectory", label: "患者轨迹预测", icon: Route },
  { area: "virtual-lab", label: "虚拟实验室", icon: FlaskConical },
  { area: "synthetic-control", label: "合成对照臂", icon: GitCompareArrows },
  { area: "patient-matching", label: "患者匹配", icon: UserSearch },
] satisfies Array<{ area: VcrWorkspaceArea; label: string; icon: typeof UsersRound }>;

/**
 * Anatomy: Five entrance links nested under the primary VCR destination; owner H. Past research is the sidebar's lower history, not a row here.
 * Variants: Module entrances or results in the explicitly addressed study.
 * States: Selected entrance, study result, or no selection for libraries/drafts/the archive.
 * Hit area: Shared full-width navigation links.
 * Keyboard: Native links preserve keyboard and modified-click navigation.
 * Long content: Labels truncate within the existing sidebar width.
 * Theme: Existing NavItem tokens and sidebar indentation.
 * Responsive: Uses the platform sidebar overlay and resize behavior.
 * Verification: VcrWorkspaceNav.test.tsx; browser geometry and real AT remain separate.
 */
export function VcrWorkspaceNav() {
  const location = useLocation();
  const active = vcrWorkspaceCurrentArea(location.pathname, location.search);
  return <nav aria-label="虚拟临床研究工作区" className="flex flex-col gap-1 pl-7 pr-3">
    {rows.map(row => <Link key={row.area} to={vcrWorkspaceDestinationPath(row.area, location)} state={sanitizeRuntimeUiHistoryState(location.state)} aria-current={active === row.area ? "page" : undefined} className={navItemClasses({ current: active === row.area })}>
      <row.icon size={16} aria-hidden="true" /><span className="truncate">{row.label}</span>
    </Link>)}
  </nav>;
}
