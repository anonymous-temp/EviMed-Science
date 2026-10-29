import { Navigate, useSearchParams } from "react-router";
import { readZoneView } from "@/components/frontier/EvidenceZoneDirectory";

/**
 * `/app/frontier/zones`. The directory of evidence zones is a view of the feed page (the owner, 2026-10-22: 证据专区 opens in place,
 * under the same band and tab row as the other views), so this address hands over to `/app/frontier?view=zones` — a notification, a
 * bookmark or an older link lands on the same list. An older link's `scope=owned|following` is 我的 (`scope=mine`).
 *
 * The chooser of a zone for one frontier item (`?fromItem=`, 「整理为证据卡片」) is retired with the cards the platform used to write
 * (2026-10-29): that address too lands on the directory, where 「新建专区」 makes a zone of one's own.
 */
export function EvidenceZonesPage() {
  const [params] = useSearchParams();
  const next = new URLSearchParams({ view: "zones" });
  const view = readZoneView(params.get("scope"));
  if (view !== "recommended") next.set("scope", view);
  return <Navigate replace to={`/app/frontier?${next.toString()}`} />;
}
