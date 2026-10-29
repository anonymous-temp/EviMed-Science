/**
 * The addresses of the topic zones, kept apart from the pages that draw them so the reader's column, a card's menu and the
 * directory share one spelling.
 *
 * A zone opens on `/app/frontier/zones/:id`, or by its slug on `/app/frontier/zones/s/:slug`. Making a zone from somewhere else
 * (a card's or the reader's ⋯: 「以此新建专区」) goes to the directory with the editor open: `?view=zones&new=1`, and the
 * seed in `fromItem`, `base` or `text`. The page opens the editor and lets go of those, so Back and a reload do not open it again.
 */
import type { ZoneEditorSeed } from "./ZoneEditorDrawer";

/** A zone's address: by its slug where it has one, else by its id. */
export const zonePath = (zone: { id: string; slug?: string | null }) =>
  zone.slug ? `/app/frontier/zones/s/${encodeURIComponent(zone.slug)}` : `/app/frontier/zones/${encodeURIComponent(zone.id)}`;

/** The directory with the editor open on a seed. */
export function newZonePath(seed: ZoneEditorSeed = {}): string {
  const params = new URLSearchParams({ view: "zones", new: "1" });
  if (seed.fromItemId) params.set("fromItem", seed.fromItemId);
  if (seed.baseZoneId) params.set("base", seed.baseZoneId);
  if (seed.text) params.set("text", seed.text.slice(0, 200));
  if (seed.generate) params.set("generate", "1");
  return `/app/frontier?${params.toString()}`;
}

/** The seed an address asks the editor to open with, or null when it asks for none. */
export function readNewZone(params: URLSearchParams): ZoneEditorSeed | null {
  if (params.get("new") !== "1") return null;
  const seed: ZoneEditorSeed = {};
  const fromItemId = params.get("fromItem");
  const baseZoneId = params.get("base");
  const text = params.get("text");
  if (fromItemId) seed.fromItemId = fromItemId.slice(0, 200);
  if (baseZoneId) seed.baseZoneId = baseZoneId.slice(0, 200);
  if (text) seed.text = text.slice(0, 200);
  if (params.get("generate") === "1") seed.generate = true;
  return seed;
}
