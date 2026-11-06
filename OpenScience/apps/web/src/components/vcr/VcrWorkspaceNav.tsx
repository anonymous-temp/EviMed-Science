import { Link, useLocation } from "react-router";
import { ClipboardList, FlaskConical, GitCompareArrows, UserRound, UsersRound, UserSearch } from "lucide-react";
import { navItemClasses } from "@/components/ui/NavItem";
import { sanitizeRuntimeUiHistoryState } from "@/lib/runtimeUiNavigation";
import { vcrWorkspaceCurrentArea, vcrWorkspaceDestinationPath, type VcrWorkspaceArea } from "@/lib/vcrWorkspaceNavigation";

const rows = [
  { area: "records", label: "研究记录", icon: ClipboardList },
  { area: "virtual-cohort", label: "虚拟队列", icon: UsersRound },
  { area: "virtual-patient", label: "虚拟患者", icon: UserRound },
  { area: "synthetic-control", label: "合成对照臂", icon: GitCompareArrows },
  { area: "virtual-trial", label: "虚拟试验", icon: FlaskConical },
  { area: "patient-matching", label: "患者匹配", icon: UserSearch },
] satisfies Array<{ area: VcrWorkspaceArea; label: string; icon: typeof ClipboardList }>;

/**
 * Anatomy: Six directory links nested under the primary VCR destination; owner H.
 * Variants: Module directories or results in the explicitly addressed study.
 * States: Selected directory, study result, or no selection for libraries/drafts.
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
