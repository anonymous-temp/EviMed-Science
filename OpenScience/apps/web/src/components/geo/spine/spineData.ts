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
import { useSharedGeoLoad } from "../geoProjectData";

/**
 * The question group's reads, shared by every tab that draws a group (R19, audit C §2.4: the group is a record opened from
 * anywhere). They go through the project's cache like the diagnosis and the monitoring do — keyed by what they are of — so the
 * actions page, the 问题与回答 list and the drawer that opens over either read each group once, and a skip or a source swap reads
 * the actions again for all of them.
 */
export const useGeoClusters = (geoId: string) => useSharedGeoLoad<GeoClustersView>(`clusters:${geoId}`, () => getGeoClusters(geoId));
export const useGeoActions = (geoId: string) => useSharedGeoLoad<GeoActionsView>(`actions:${geoId}`, () => getGeoActions(geoId));
/** One group in full. The key carries the group's id: a drawer for another group is another read. */
export const useGeoCluster = (geoId: string, groupId: string) => useSharedGeoLoad<GeoClusterView>(`cluster:${geoId}:${groupId}`, () => getGeoCluster(geoId, groupId));
/** The latest question set (the one every group read is of): what turns a question id into its group. */
export const useGeoQuestionSet = (geoId: string) => useSharedGeoLoad<GeoQuestions>(`questions:${geoId}:latest`, () => getGeoQuestions(geoId, null));
