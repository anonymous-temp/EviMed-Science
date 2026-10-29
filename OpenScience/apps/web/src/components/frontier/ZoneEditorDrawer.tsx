import { Drawer } from "@/components/ui/Drawer";
import type { ZoneDetail } from "@/lib/evidenceTopicClient";

/** Where a new zone starts from: a sentence, a platform zone to copy, or a frontier item whose tags are the draft. */
export interface ZoneEditorSeed {
  text?: string;
  baseZoneId?: string;
  fromItemId?: string;
}

export interface ZoneEditorDrawerProps {
  mode: "create" | "edit";
  /** The zone being edited (`edit`). */
  zone?: ZoneDetail;
  seed?: ZoneEditorSeed;
  onClose: () => void;
  onSaved: (zone: ZoneDetail) => void;
}

/** Skeleton: the real screen (draft, preview, borderline marks, 建立 / 保存) lands in the next commit. */
export function ZoneEditorDrawer({ mode, onClose }: ZoneEditorDrawerProps) {
  return <Drawer title={mode === "edit" ? "编辑专区" : "新建专区"} onClose={onClose}><p /></Drawer>;
}
