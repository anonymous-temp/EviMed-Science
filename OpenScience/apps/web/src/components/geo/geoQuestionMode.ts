import type { GeoProject } from "@/lib/geoClient";

/** The question tab's long modes, held in the address (`?questionMode=`): importing a set, or editing the open one as a new version. */
export type GeoQuestionMode = "import" | "edit";

/** Whether the person may write questions in this project (a viewer reads them only). */
export const geoCanEditQuestions = (project: Pick<GeoProject, "access">): boolean => !project.access || project.access.abilities.includes("edit");

/**
 * The mode the address asks for, honoured only for someone who can edit: a view-only member who follows a copied
 * `?questionMode=import` link reads the list, not an empty tab with a form they cannot use.
 */
export function geoQuestionMode(params: URLSearchParams, canEdit: boolean): GeoQuestionMode | null {
  const mode = params.get("questionMode");
  return canEdit && (mode === "import" || mode === "edit") ? mode : null;
}
