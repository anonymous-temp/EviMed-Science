import { BookMarked, FileText, Network, PackageOpen } from "lucide-react";
import { useLocation } from "react-router";
import { ModuleDirectoryNav, type ModuleDirectoryRow } from "@/components/sidebar/ModuleDirectoryNav";
import { listPath, readListState, stateForView, viewOf, type KnowledgeView } from "@/lib/knowledgeNav";

const VIEWS: ReadonlyArray<{ id: KnowledgeView; label: string; icon: typeof FileText }> = [
  { id: "documents", label: "资料", icon: FileText },
  { id: "pages", label: "知识页", icon: BookMarked },
  { id: "graph", label: "图谱", icon: Network },
  { id: "outputs", label: "对话产出", icon: PackageOpen },
];

/**
 * The four views of 知识库, each the page's own address for it (`listPath(stateForView(...))`, so a project in the address and the search
 * go along as they did in the page's links). The pages and the graph are one offer: where the deployment compiles them, or where either
 * is open, both show.
 */
export function knowledgeDirectoryRows(search: string, pagesOffered: boolean): ModuleDirectoryRow[] {
  const state = readListState(new URLSearchParams(search));
  const active = viewOf(state);
  const compiled = pagesOffered || active === "pages" || active === "graph";
  return VIEWS.filter(view => compiled || (view.id !== "pages" && view.id !== "graph"))
    .map(view => ({ key: view.id, label: view.label, icon: view.icon, to: listPath(stateForView(state, view.id)), current: view.id === active }));
}

/** Anatomy: the four views of 知识库 nested under its sidebar row (see ModuleDirectoryNav). Verification: KnowledgeWorkspaceNav.test.tsx. */
export function KnowledgeWorkspaceNav({ pagesOffered }: { pagesOffered: boolean }) {
  const location = useLocation();
  return <ModuleDirectoryNav label="知识库的内容" rows={knowledgeDirectoryRows(location.search, pagesOffered)} />;
}
