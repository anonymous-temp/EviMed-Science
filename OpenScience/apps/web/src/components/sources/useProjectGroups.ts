import { useMemo } from "react";
import { useGeoProjectIds } from "@/components/geo/useGeoProjectIds";
import { useVcrProjects } from "@/components/vcr/useVcrProjectIds";
import { LIBRARY_PROJECT_ID } from "@/lib/knowledgeNav";
import { useGeoFeature } from "@/lib/geoClient";
import { labelOf, useProjectLabels } from "@/lib/projectNames";
import { useProjectStore } from "@/lib/projects";
import { useVcrFeature } from "@/lib/vcrClient";

/** A project as a place is chosen: its id and the name it is read by (two projects of one name are told apart, `projectLabels`). */
export interface ProjectChoice {
  id: string;
  label: string;
}

/**
 * The account's projects, grouped as the sidebar groups them: the ones it works in (`own`; `applicable` is the part of them a document can be
 * told to take effect in — a 循证 GEO project and a 虚拟临床研究 study are projects of their own kind), those studies and those GEO projects. Personal
 * storage is a place the knowledge base keeps documents, never a project, and a draft study (nobody has spoken in it yet) is left out like
 * the sidebar leaves it out. `labels` names every project there is, whatever its kind, for a document that is held in one.
 *
 * The groups come from the same readers the sidebar's project list uses, so the two cannot disagree about which project is which.
 */
export interface ProjectGroups {
  own: ProjectChoice[];
  /**
   * The projects a document can be told to take effect in: `own`, less the ones the server refuses for it (`assertOrdinaryProject`,
   * `libraryScope.mjs`) — a project that is put away, and a 虚拟临床研究 study nobody has spoken in yet or one kept for a task, which the
   * sidebar lists with the account's own projects yet which belong to the module. Offering them ended in a refusal of the whole save.
   */
  applicable: ProjectChoice[];
  studies: ProjectChoice[];
  communication: ProjectChoice[];
  labels: ReadonlyMap<string, string>;
}

export function useProjectGroups(): ProjectGroups {
  const projects = useProjectStore((state) => state.projects);
  const labels = useProjectLabels();
  const projectsKey = projects.map((project) => project.id).join("\u0000");
  const geoOn = useGeoFeature() === "on";
  const vcrOn = useVcrFeature() === "on";
  const geoIds = useGeoProjectIds(geoOn, projectsKey);
  const { studies: vcrIds, drafts: vcrDrafts, tasks: vcrTasks } = useVcrProjects(vcrOn, projectsKey);
  return useMemo(() => {
    // A project the person named `evimed-library-…` is theirs; only the reserved id is the storage.
    const visible = projects.filter((project) => project.id !== LIBRARY_PROJECT_ID);
    const choices = (list: typeof projects): ProjectChoice[] => list.map((project) => ({ id: project.id, label: labelOf(labels, project) }));
    const own = visible.filter((project) => !geoIds.has(project.id) && !vcrIds.has(project.id));
    return {
      own: choices(own),
      applicable: choices(own.filter((project) => !project.archivedAt && !vcrDrafts.has(project.id) && !vcrTasks.has(project.id))),
      studies: choices(visible.filter((project) => vcrIds.has(project.id) && !vcrDrafts.has(project.id))),
      communication: choices(visible.filter((project) => geoIds.has(project.id))),
      labels,
    };
  }, [projects, labels, geoIds, vcrIds, vcrDrafts, vcrTasks]);
}
