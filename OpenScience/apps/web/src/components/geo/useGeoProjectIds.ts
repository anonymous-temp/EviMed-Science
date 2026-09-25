import { useEffect, useState } from "react";
import { listGeoProjects } from "@/lib/geoClient";

const NONE: ReadonlySet<string> = new Set();

/**
 * Which of the account's control-plane projects are GEO projects, so the
 * project list can give them the radar icon.
 *
 * Read only when the module is offered (`enabled`), and again whenever the
 * account's project list changes (`projectsKey`) — a GEO project is created as
 * an ordinary project first, so a new one arrives the same way any other
 * project does. A list that cannot be read costs the icons, never the list.
 */
export function useGeoProjectIds(enabled: boolean, projectsKey: string): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    if (!enabled) {
      setIds(NONE);
      return undefined;
    }
    let live = true;
    void listGeoProjects()
      .then((projects) => { if (live) setIds(new Set(projects.map((project) => project.projectId))); })
      .catch(() => { /* the folders stay folders */ });
    return () => { live = false; };
  }, [enabled, projectsKey]);
  return ids;
}
