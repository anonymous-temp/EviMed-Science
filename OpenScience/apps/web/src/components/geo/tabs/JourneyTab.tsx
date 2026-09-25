import type { GeoProject } from "@/lib/geoClient";

/** STUB — package D2 writes the real tab; this placeholder is dropped at merge. */
export function JourneyTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  return <div data-geo-tab-stub="Journey" data-geo-id={geoId} data-project={project.id} />;
}
