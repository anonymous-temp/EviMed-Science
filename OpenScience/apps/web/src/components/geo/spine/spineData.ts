import {
  getGeoActions,
  getGeoCluster,
  getGeoClusters,
  getGeoQuestions,
  type GeoActionsView,
  type GeoClusterView,
  type GeoClustersView,
  type GeoQuestions,
} from "@/lib/geoClient";
import { useScopedGeoLoad, useSharedGeoLoad } from "../geoProjectData";
import { useGeoReadScope } from "../geoFrame";

/**
 * The question group's reads, shared by every tab that draws a group (R19, audit C §2.4: the group is a record opened from
 * anywhere). They go through the project's cache like the diagnosis and the monitoring do — keyed by what they are of — so the
 * actions page, the 问题与回答 list and the drawer that opens over either read each group once, and a skip or a source swap reads
 * the actions again for all of them.
 */
export const useGeoClusters = (geoId: string) => useScopedGeoLoad<GeoClustersView>(`clusters:${geoId}`, scope => scope ? getGeoClusters(geoId, scope) : getGeoClusters(geoId));
export const useGeoActions = (geoId: string) => useSharedGeoLoad<GeoActionsView>(`actions:${geoId}`, () => getGeoActions(geoId));
/** One group in full. The key carries the group's id: a drawer for another group is another read. */
export const useGeoCluster = (geoId: string, groupId: string) => useScopedGeoLoad<GeoClusterView>(`cluster:${geoId}:${groupId}`, scope => scope ? getGeoCluster(geoId, groupId, scope) : getGeoCluster(geoId, groupId));
/** The latest question set (the one every group read is of): what turns a question id into its group. */
export const useGeoQuestionSet = (geoId: string) => useScopedGeoLoad<GeoQuestions>(`questions:${geoId}:selected`, scope => getGeoQuestions(geoId, scope ?? null));

/** Filter choices come from the full selected question version, never the already narrowed metric rows. */
export function useGeoQuestionCatalog(geoId: string) {
  const version = useGeoReadScope()?.questionVersion ?? null;
  return useSharedGeoLoad<GeoQuestions>(`questions:${geoId}:${version ?? "latest"}`, () => getGeoQuestions(geoId, version));
}
