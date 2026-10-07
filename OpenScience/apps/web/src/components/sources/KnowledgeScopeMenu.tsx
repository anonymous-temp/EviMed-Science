import { useMemo } from "react";
import { ChevronDown, FolderOpen, Library, Radar, UsersRound } from "lucide-react";
import { useGeoProjectIds } from "@/components/geo/useGeoProjectIds";
import { useVcrProjects } from "@/components/vcr/useVcrProjectIds";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { useGeoFeature } from "@/lib/geoClient";
import { labelOf, useProjectLabels } from "@/lib/projectNames";
import { useProjectStore } from "@/lib/projects";
import type { SourceScope } from "@/lib/sourceClient";
import { useVcrFeature } from "@/lib/vcrClient";

/** The name of the scope that holds the account's shared documents. */
export const SHARED_SCOPE_NAME = "所有项目共享";

/**
 * Whose documents this page lists: a project's, grouped as the sidebar groups them (the account's own projects, the
 * 虚拟临床研究 studies, the 循证 GEO projects — each of those is an ordinary project underneath), or the documents the
 * account made available to every project.
 *
 * Choosing here changes what this page lists and nothing else: it does not move the tab to that project, the sidebar
 * and the conversation stay where they are. The groups come from the same readers the sidebar's project list uses,
 * so the two cannot disagree about which project is which.
 */
export function KnowledgeScopeMenu({ scope, onChange }: { scope: SourceScope; onChange: (scope: SourceScope) => void }) {
  const projects = useProjectStore((state) => state.projects);
  // Two projects of one name are told apart here as everywhere a project is chosen (`projectLabels`).
  const labels = useProjectLabels();
  const projectsKey = projects.map((project) => project.id).join("\u0000");
  const geoOn = useGeoFeature() === "on";
  const vcrOn = useVcrFeature() === "on";
  const geoIds = useGeoProjectIds(geoOn, projectsKey);
  // A draft study (nobody has spoken in it yet) is not a place documents are filed; it is left out like the sidebar leaves it out.
  const { studies: vcrIds, drafts: vcrDrafts } = useVcrProjects(vcrOn, projectsKey);
  const entries = useMemo(() => {
    const own = projects.filter((project) => !geoIds.has(project.id) && !vcrIds.has(project.id));
    const studies = projects.filter((project) => vcrIds.has(project.id) && !vcrDrafts.has(project.id));
    const communication = projects.filter((project) => geoIds.has(project.id));
    const chosen = scope.kind === "project" ? scope.projectId : null;
    const group = (heading: string, list: typeof projects): MenuEntry[] => list.length === 0 ? [] : [
      { heading },
      ...list.map((project) => ({ label: labelOf(labels, project), checked: project.id === chosen, onSelect: () => onChange({ kind: "project", projectId: project.id }) })),
    ];
    return [
      ...group("我的项目", own),
      ...group("虚拟临床研究", studies),
      ...group("循证 GEO", communication),
      "separator" as const,
      { label: SHARED_SCOPE_NAME, checked: scope.kind === "shared", onSelect: () => onChange({ kind: "shared" }) },
    ] satisfies MenuEntry[];
  }, [projects, labels, geoIds, vcrIds, vcrDrafts, scope, onChange]);
  const chosenProject = scope.kind === "project" ? projects.find((project) => project.id === scope.projectId) : undefined;
  const name = scope.kind === "shared" ? SHARED_SCOPE_NAME : chosenProject ? labelOf(labels, chosenProject) : "当前项目";
  const Icon = scope.kind === "shared" ? Library : vcrIds.has(scope.projectId) ? UsersRound : geoIds.has(scope.projectId) ? Radar : FolderOpen;
  return (
    <Menu label="选择范围" align="start" items={entries} className="max-h-96 overflow-y-auto">
      <Button variant="secondary" aria-label={`范围：${name}`} className="max-w-56">
        <Icon size={16} aria-hidden="true" />
        <span className="min-w-0 truncate">{name}</span>
        <ChevronDown size={16} className="shrink-0 text-text-3" aria-hidden="true" />
      </Button>
    </Menu>
  );
}
