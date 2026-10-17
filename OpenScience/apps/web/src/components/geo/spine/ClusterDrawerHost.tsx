import type { GeoProject } from "@/lib/geoClient";
import { ClusterDrawer } from "./ClusterDrawer";
import { useGeoDrawerAddress } from "./drawerParams";

/**
 * Where `?group=<id>` becomes the cluster drawer. A tab that can show a group — 行动, 问题与回答, 可见度, 准确与安全, 信源 and one
 * answer — draws this once at its foot, so a group's name opens the drawer in place on any of them. The drawer closes by taking the
 * parameter out of the address, so Back and a reload mean what they say.
 */
export function ClusterDrawerHost({ geoId, project }: { geoId: string; project: GeoProject }) {
  const address = useGeoDrawerAddress();
  if (!address.group) return null;
  return <ClusterDrawer key={address.group} geoId={geoId} project={project} groupId={address.group} engine={address.engine} onClose={address.close} />;
}
