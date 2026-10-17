import { useMemo } from "react";
import { useGeoProjectIds } from "@/components/geo/useGeoProjectIds";
import { useVcrProjectIds } from "@/components/vcr/useVcrProjectIds";
import { useGeoFeature } from "@/lib/geoClient";
import { useProjectStore } from "@/lib/projects";
import { useVcrFeature } from "@/lib/vcrClient";
import { projectChoices, type FactItem, type ProjectChoice } from "./memoryItems";

/**
 * The projects the memory pages can be about, as the header's scope menu lists them (`projectScopeGroups`): the researcher's own, the
 * 虚拟临床研究 studies and the 循证 GEO projects, each an ordinary project underneath — the readers the sidebar and the knowledge base
 * use, so the pages cannot disagree about which project is which. The 项目 tab passes its facts, so a 「其他」 holds the ones that name
 * a project the account no longer has; the map has no such facts and passes none.
 */
export function useProjectChoices(facts: readonly FactItem[] = []): ProjectChoice[] {
  const projects = useProjectStore((state) => state.projects);
  const geoOn = useGeoFeature() === "on";
  const vcrOn = useVcrFeature() === "on";
  const projectsKey = projects.map((project) => project.id).join("\u0000");
  const geoIds = useGeoProjectIds(geoOn, projectsKey);
  const vcrIds = useVcrProjectIds(vcrOn, projectsKey);
  return useMemo(() => projectChoices(projects, { vcr: vcrIds, geo: geoIds }, facts), [projects, vcrIds, geoIds, facts]);
}
