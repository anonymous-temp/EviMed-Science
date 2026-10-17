import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { cn } from "@/lib/cn";
import { geoDestinationPath, type GeoTabKey } from "../geoTabs";
import { GEO_ACTION_PARAM, GEO_ENGINE_PARAM, GEO_ERROR_PARAM, GEO_GROUP_PARAM, searchWith } from "./drawerParams";

/**
 * A question group's name as a link to the group (R19, audit C §2.4): it opens the cluster drawer over the page the person is on.
 *
 * The address is the page's own with `?group=<id>` added — every other parameter (the view, the filters) is kept, and an action
 * drawer that was open (an action's, a wrong claim's) gives way to it — so the list stays where it was and Back closes the drawer. A page that cannot host the
 * drawer names the tab that can (`tab`: the plan, the overview): the link then goes there with the drawer open.
 *
 * Without a `groupId` (a project-level action, a name the plan could not resolve to a group) it is the name as text.
 */
export function ClusterLink({
  groupId,
  geoId,
  tab,
  engine,
  className,
  children,
}: {
  groupId: string | null | undefined;
  /** Needed with `tab`. */
  geoId?: string;
  /** The tab that hosts the drawer, when the page this is on does not. */
  tab?: GeoTabKey;
  /** The engine the drawer rests on. */
  engine?: string | null;
  className?: string;
  children: ReactNode;
}) {
  const location = useLocation();
  if (!groupId) return <span className={className}>{children}</span>;
  const to = tab && geoId
    ? geoDestinationPath(geoId, { tab }, { [GEO_GROUP_PARAM]: groupId, ...(engine ? { [GEO_ENGINE_PARAM]: engine } : {}) })
    : {
      pathname: location.pathname,
      search: searchWith(location.search, { [GEO_GROUP_PARAM]: groupId, [GEO_ACTION_PARAM]: null, [GEO_ERROR_PARAM]: null, ...(engine ? { [GEO_ENGINE_PARAM]: engine } : {}) }),
    };
  return (
    <Link to={to} data-geo-cluster-link={groupId} className={cn("rounded text-link hover:underline hover:underline-offset-4", className)}>
      {children}
    </Link>
  );
}
