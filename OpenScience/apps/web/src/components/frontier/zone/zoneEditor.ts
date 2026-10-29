import type { ZoneDetail } from "@/lib/evidenceTopicClient";

/**
 * What the zone page asks of the drawer that creates and edits 我的专区 (`ZoneEditorDrawer`, ez-web-dir): the same props, declared here so
 * the page is written against the contract and not against a file that may not be there yet. A component that takes these is the editor.
 */
export interface ZoneEditorProps {
  mode: "create" | "edit";
  /** The zone being edited (`mode: "edit"`). */
  zone?: ZoneDetail;
  /** Where a new zone starts from: the reader's sentence, another zone to copy the definition of, or an item to take its tags from. */
  seed?: { text?: string; baseZoneId?: string; fromItemId?: string };
  onClose(): void;
  onSaved(zone: ZoneDetail): void;
}
