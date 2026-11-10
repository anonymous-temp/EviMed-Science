import type { LucideIcon } from "lucide-react";
import { Link, useLocation } from "react-router";
import { navItemClasses } from "@/components/ui/NavItem";
import { sanitizeRuntimeUiHistoryState } from "@/lib/runtimeUiNavigation";

/** One entry of a module's nested directory: the view it opens, by the address the page already reads. */
export interface ModuleDirectoryRow {
  key: string;
  label: string;
  icon: LucideIcon;
  to: string;
  current: boolean;
}

/**
 * Anatomy: A module's peer views as links nested under its sidebar row, the same shape as the VCR and GEO directories.
 * Variants: One component for 前沿动态, 医学检索, 知识库 and 记忆胶囊; each module supplies its rows.
 * States: The current view is marked; a page that belongs to no view (an article, a reading page) marks none.
 * Hit area: Shared full-width navigation links.
 * Keyboard: Native links preserve keyboard and modified-click navigation.
 * Long content: Labels truncate within the existing sidebar width.
 * Theme: Existing NavItem tokens and the `pl-7 pr-3` indentation of the other nested directories.
 * Responsive: Uses the platform sidebar overlay and resize behavior.
 * Verification: ModuleDirectoryNav.test.tsx and the module wrappers' tests; browser geometry and real AT remain separate.
 */
export function ModuleDirectoryNav({ label, rows }: { label: string; rows: readonly ModuleDirectoryRow[] }) {
  const location = useLocation();
  return <nav aria-label={label} className="flex flex-col gap-1 pl-7 pr-3">
    {rows.map(row => <Link key={row.key} to={row.to} state={sanitizeRuntimeUiHistoryState(location.state)} aria-current={row.current ? "page" : undefined} className={navItemClasses({ current: row.current })}>
      <row.icon size={16} aria-hidden="true" /><span className="truncate">{row.label}</span>
    </Link>)}
  </nav>;
}
