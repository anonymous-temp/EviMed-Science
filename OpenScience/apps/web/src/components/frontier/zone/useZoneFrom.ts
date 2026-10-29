import { useMemo } from "react";
import { useLocation } from "react-router";

/**
 * Where an item, an event or a card opened from a zone's page returns to: the page as the reader left it (its tab, its filters), named
 * by the zone, handed over in the link's router state under `evidenceFrom` (`FrontierBack` reads it: 「‹ 肥胖」 goes back in one press).
 */
export function useZoneFrom(title: string): { to: string; label: string } {
  const location = useLocation();
  const to = `${location.pathname}${location.search}`;
  return useMemo(() => ({ to, label: title }), [to, title]);
}
