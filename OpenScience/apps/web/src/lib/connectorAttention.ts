import { useEffect, useState } from "react";
import { fetchWebConnectors } from "@/lib/apiClient";

/**
 * How many data sources nothing serves for this account — no deployment
 * credential, no key of the researcher's own, and not one that works without
 * one (`needsAttention`, computed by the control plane).
 *
 * This used to be a banner across the top of seven of the eight pages, on an
 * account's first screen, before any run had needed any of them (review B §7).
 * It is a standing, non-urgent fact about the deployment, so it is a count on
 * the account row now — the way the bell carries unread work — and the prompt
 * that matters moves to the one run that actually stopped on a missing key.
 */
export const CONNECTORS_CHANGED_EVENT = "evimed:connectors-changed";

export function announceConnectorsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CONNECTORS_CHANGED_EVENT));
}

export function useConnectorAttention(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () =>
      fetchWebConnectors()
        .then((list) => { if (active) setCount(list.filter((connector) => connector.needsAttention).length); })
        // A deployment without the credential store, or a read that failed, is
        // no badge — never a reason to interrupt anyone.
        .catch(() => { if (active) setCount(0); });
    void load();
    window.addEventListener(CONNECTORS_CHANGED_EVENT, load);
    return () => {
      active = false;
      window.removeEventListener(CONNECTORS_CHANGED_EVENT, load);
    };
  }, []);
  return count;
}
