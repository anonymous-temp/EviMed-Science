import type { GeoProject } from "@/lib/geoClient";

/** STUB — package D2 writes the real tab; this placeholder is dropped at merge. */
export function ContentTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  return <div data-geo-tab-stub="Content" data-geo-id={geoId} data-project={project.id} />;
}
