import { useSyncExternalStore } from "react";
import { subscribeZoneCreate, zoneCreateAllowed } from "@/lib/evidenceTopicClient";

/**
 * Whether 「以此新建专区」 is offered on a page that is not the directory (a card's ⋯, a zone's own ⋯). The directory is where the
 * server says whether this reader may make a zone (`canCreate`); until it has been read nothing says no, so the entry stands, and the
 * editor answers for itself if the server then refuses. Once the directory has said no, the entry goes.
 */
export function useZoneCreate(): boolean {
  return useSyncExternalStore(subscribeZoneCreate, () => zoneCreateAllowed() !== false, () => true);
}
