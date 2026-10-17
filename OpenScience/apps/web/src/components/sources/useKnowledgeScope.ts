import { useMemo } from "react";
import { FolderOpen, Library, Radar, UsersRound } from "lucide-react";
import { useGeoProjectIds } from "@/components/geo/useGeoProjectIds";
import { useVcrProjects } from "@/components/vcr/useVcrProjectIds";
import type { ScopeChoice, ScopeGroup, ScopeMenuProps } from "@/components/ui/ScopeMenu";
import { useGeoFeature } from "@/lib/geoClient";
import { labelOf, useProjectLabels } from "@/lib/projectNames";
import { useProjectStore } from "@/lib/projects";
import { SHARED_SCOPE } from "@/lib/knowledgeNav";
import type { SourceScope } from "@/lib/sourceClient";
import { useVcrFeature } from "@/lib/vcrClient";

/** The name of the scope that holds the account's shared documents. */
export const SHARED_SCOPE_NAME = "所有项目共享";

/**
 * Whose documents the knowledge base lists, as the header's scope menu (`ScopeMenu`, R19): a project's, grouped as the sidebar groups
 * them (the account's own projects, the 虚拟临床研究 studies, the 循证 GEO projects — each of those is an ordinary project
 * underneath), or the documents the account made available to every project.
 *
 * Choosing here changes what this page lists and nothing else: it does not move the tab to that project, the sidebar and the
 * conversation stay where they are. The groups come from the same readers the sidebar's project list uses, so the two cannot
 * disagree about which project is which. This was a component of its own (`KnowledgeScopeMenu`) beside the memory page's project
 * chip and the map's project filter; the three are one `ScopeMenu` now, and what is left here is only what the knowledge base knows:
 * which projects there are and what the shared scope is called.
 */
export function useKnowledgeScope(scope: SourceScope, onChange: (scope: SourceScope) => void): ScopeMenuProps {
  const projects = useProjectStore((state) => state.projects);
  // Two projects of one name are told apart here as everywhere a project is chosen (`projectLabels`).
  const labels = useProjectLabels();
  const projectsKey = projects.map((project) => project.id).join("\u0000");
  const geoOn = useGeoFeature() === "on";
  const vcrOn = useVcrFeature() === "on";
  const geoIds = useGeoProjectIds(geoOn, projectsKey);
  // A draft study (nobody has spoken in it yet) is not a place documents are filed; it is left out like the sidebar leaves it out.
  const { studies: vcrIds, drafts: vcrDrafts } = useVcrProjects(vcrOn, projectsKey);
  const groups = useMemo(() => {
    const own = projects.filter((project) => !geoIds.has(project.id) && !vcrIds.has(project.id));
    const studies = projects.filter((project) => vcrIds.has(project.id) && !vcrDrafts.has(project.id));
    const communication = projects.filter((project) => geoIds.has(project.id));
    const choices = (list: typeof projects, icon: ScopeChoice["icon"]): ScopeChoice[] => list.map((project) => ({ id: project.id, label: labelOf(labels, project), icon }));
    const kinds: Array<[string | undefined, ScopeChoice[]]> = [
      ["我的项目", choices(own, FolderOpen)], ["虚拟临床研究", choices(studies, UsersRound)], ["循证 GEO", choices(communication, Radar)],
    ];
    return [
      ...kinds.filter(([, list]) => list.length > 0).map(([heading, list]): ScopeGroup => ({ heading, choices: list })),
      { choices: [{ id: SHARED_SCOPE, label: SHARED_SCOPE_NAME, icon: Library }] },
    ];
  }, [projects, labels, geoIds, vcrIds, vcrDrafts]);
  // A scope whose project is not in the list (still loading, or deleted elsewhere) is named for what the tab is in.
  const chosen = scope.kind === "shared" ? SHARED_SCOPE : projects.some((project) => project.id === scope.projectId) ? scope.projectId : null;
  const withFallback = useMemo((): ScopeGroup[] => (chosen === null && scope.kind === "project"
    ? [{ choices: [{ id: scope.projectId, label: "当前项目", icon: FolderOpen }] }, ...groups]
    : groups), [chosen, scope, groups]);
  return {
    label: "范围",
    groups: withFallback,
    value: scope.kind === "shared" ? SHARED_SCOPE : scope.projectId,
    onChange: (id) => {
      if (id === null) return;
      onChange(id === SHARED_SCOPE ? { kind: "shared" } : { kind: "project", projectId: id });
    },
  };
}
