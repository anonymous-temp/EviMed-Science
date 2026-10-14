import { useMemo, useState, type ReactNode } from "react";
import type { GeoProject } from "@/lib/geoClient";
import { Toolbar, type ToolbarProps } from "@/components/ui/Toolbar";
import { GeoFrameContext, type GeoFrameApi } from "../geoFrame";
import { GeoDataCache } from "../geoProjectData";
import type { GeoTabKey } from "../geoTabs";

/** Module-level, so the frame's value is the same object from one render to the next: a new function each render would re-render the tab. */
const NOOP = () => undefined;

/**
 * A GEO tab in the place the layout gives it, for tests: the frame's context, the project's data cache, and the one toolbar the tab
 * asks for (`useGeoToolbar`), drawn above it as the layout's band draws it. A tab's tests ask the same questions of its filters
 * and its search as they did when the tab drew them itself — by role and by name — and the tab is read through the cache it is read
 * through in the product.
 *
 * `reload` and `openPanel` are the calls the layout would make; a test that cares passes its own.
 */
export function GeoFrameHarness({
  project,
  geoId = "geo_1",
  tab = "overview",
  reload = NOOP,
  openPanel = NOOP,
  children,
}: {
  project: GeoProject;
  geoId?: string;
  tab?: GeoTabKey;
  reload?: () => void;
  openPanel?: GeoFrameApi["openPanel"];
  children: ReactNode;
}) {
  const [toolbar, setToolbar] = useState<ToolbarProps | null | undefined>(undefined);
  const [data] = useState(() => new GeoDataCache());
  const api = useMemo<GeoFrameApi>(
    () => ({ geoId, project, tab, reload, openPanel, data, setToolbar }),
    [geoId, project, tab, reload, openPanel, data],
  );
  return (
    <GeoFrameContext.Provider value={api}>
      {toolbar ? <Toolbar {...toolbar} /> : null}
      {children}
    </GeoFrameContext.Provider>
  );
}
