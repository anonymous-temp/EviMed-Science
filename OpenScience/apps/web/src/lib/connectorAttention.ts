import { useEffect, useState } from "react";
import { fetchWebConnectors, type WebConnector } from "@/lib/apiClient";

/**
 * The researcher's data sources — for each, whether anything serves it for
 * this account — kept current across the places that read them.
 *
 * It used to feed a count in the sidebar and a banner across seven pages
 * (review B §7); the count left the sidebar on 2026-09-23 because it is a
 * standing, non-urgent fact about the deployment and not the reader's work. The
 * list is read now for the one moment it matters: a conversation whose run went
 * without a source (`ConnectorNeedNotice`), which needs to know whether that
 * source has been configured since.
 *
 * `null` until read, and again on a read that failed — a deployment without the
 * credential store, or a hiccup, is no reason to interrupt anyone.
 */
export const CONNECTORS_CHANGED_EVENT = "evimed:connectors-changed";

export function announceConnectorsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CONNECTORS_CHANGED_EVENT));
}

/**
 * @param enabled read the list only while something needs it: a conversation with
 *   nothing left out asks nothing of the server.
 */
export function useConnectors(enabled = true): WebConnector[] | null {
  const [connectors, setConnectors] = useState<WebConnector[] | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    const load = () =>
      fetchWebConnectors()
        .then((list) => { if (active) setConnectors(list); })
        .catch(() => { if (active) setConnectors(null); });
    void load();
    window.addEventListener(CONNECTORS_CHANGED_EVENT, load);
    return () => {
      active = false;
      window.removeEventListener(CONNECTORS_CHANGED_EVENT, load);
    };
  }, [enabled]);
  return connectors;
}
