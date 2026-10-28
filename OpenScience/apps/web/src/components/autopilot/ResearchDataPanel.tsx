import { FileText, X } from "lucide-react";
import { Link } from "react-router";
import { LoadError } from "@/components/cards/LoadError";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Tag, type TagTone } from "@/components/ui/Tag";
import type { ResearchState } from "@/lib/autopilotClient";

/** Only a material that is not ready says so; a ready one needs no label. */
const MATERIAL_STATUS: Record<ResearchState["materials"][number]["state"], { label: string; tone: TagTone } | null> = {
  ready: null,
  reading: { label: "正在读取", tone: "neutral" },
  attention: { label: "需要处理", tone: "warn" },
  unavailable: { label: "无法使用", tone: "safety" },
};

/**
 * Anatomy: the research's own materials — datasets and documents from the knowledge base — and the three ways in.
 * Variants: empty (a recipe), loading, failed, populated.
 * States: each material says when it is still being read or cannot be used; the database entry appears only where the
 * deployment offers it.
 * Hit area: shared Button and IconButton controls.
 * Keyboard: native links and buttons.
 * Long content: names truncate visually and keep their accessible names.
 * Theme: semantic surface, text and status roles.
 * Responsive: actions wrap; names yield space to their state.
 * Verification: ResearchDataPanel.test.tsx.
 */
export function ResearchDataPanel({ materials, loading, error, busy, databaseAvailable = true, onUpload, onPick, onDatabase, onRemove, onRetry }: {
  materials: ResearchState["materials"];
  loading: boolean;
  error: string | null;
  busy: boolean;
  databaseAvailable?: boolean;
  onUpload: () => void;
  onPick: () => void;
  onDatabase: () => void;
  onRemove: (sourceId: string) => void;
  onRetry: () => void;
}) {
  return <section aria-label="研究资料" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-body font-semibold text-text">研究资料</h3>
      <div className="flex flex-wrap gap-1">
        <Button variant="secondary" size="sm" disabled={busy} onClick={onUpload}>上传资料</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={onPick}>从知识库选择</Button>
        {databaseAvailable && <Button variant="secondary" size="sm" disabled={busy} onClick={onDatabase}>从数据库导入</Button>}
      </div>
    </div>
    {error && <LoadError message={error} onRetry={onRetry} />}
    {loading && !error && <p role="status" className="text-ui text-text-3">正在载入</p>}
    {materials.length === 0 && !loading && !error
      ? <p className="text-ui text-text">还没有资料。上传数据集或文献，研究会优先使用它们。</p>
      : materials.length > 0 ? <ul className="space-y-1" aria-label="已加入的资料">{materials.map((item) => {
        const status = MATERIAL_STATUS[item.state];
        return <li key={item.sourceId} className="flex min-w-0 items-center gap-2 py-1">
          <FileText size={16} className="shrink-0 text-text-3" aria-hidden="true" />
          <Link to={`/app/files/${encodeURIComponent(item.sourceId)}`} className="min-w-0 flex-1 truncate text-ui text-accent underline">{item.name}</Link>
          {status && <Tag tone={status.tone}>{status.label}</Tag>}
          <IconButton icon={X} label={`移除 ${item.name}`} size="sm" disabled={busy} onClick={() => onRemove(item.sourceId)} />
        </li>;
      })}</ul> : null}
  </section>;
}
