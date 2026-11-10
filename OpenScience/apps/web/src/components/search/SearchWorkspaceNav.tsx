import { BookOpen, ClipboardList, FlaskConical, Pill } from "lucide-react";
import { useLocation } from "react-router";
import { ModuleDirectoryNav, type ModuleDirectoryRow } from "@/components/sidebar/ModuleDirectoryNav";
import { EVIMED_SEARCH_CATEGORIES, evimedSearchCategory, type EvimedSearchCategory } from "@/lib/evimedSearchClient";

const ICONS: Record<EvimedSearchCategory, typeof BookOpen> = { literature: BookOpen, guidelines: ClipboardList, drugs: Pill, trials: FlaskConical };

/**
 * The four categories of 医学检索 at `/app/search/<category>`. Switching keeps the keyword of a search that is on screen (`?q=`), as the
 * page's own switch did; filters, page and an open detail belong to the category they were made in and are not carried (the page brings back what a
 * category was left at). The open category's own row returns to its list as it is, filters and page kept, leaving an open detail.
 */
export function searchDirectoryRows(pathname: string, search: string): ModuleDirectoryRow[] {
  const active = evimedSearchCategory(/^\/app\/search\/([^/]+)/.exec(pathname)?.[1]);
  const q = new URLSearchParams(search).get("q")?.trim();
  const suffix = q ? `?${new URLSearchParams({ q })}` : "";
  const own = new URLSearchParams(search); own.delete("detail");
  const ownSuffix = own.size ? `?${own}` : "";
  return EVIMED_SEARCH_CATEGORIES.map(category => ({ key: category.value, label: category.label, icon: ICONS[category.value], to: `/app/search/${category.value}${category.value === active ? ownSuffix : suffix}`, current: category.value === active }));
}

/** Anatomy: the four categories of 医学检索 nested under its sidebar row (see ModuleDirectoryNav). Verification: SearchWorkspaceNav.test.tsx. */
export function SearchWorkspaceNav() {
  const location = useLocation();
  return <ModuleDirectoryNav label="医学检索类别" rows={searchDirectoryRows(location.pathname, location.search)} />;
}
