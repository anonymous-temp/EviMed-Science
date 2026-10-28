import { FileText, X } from "lucide-react";
import { Link } from "react-router";
import { LoadError } from "@/components/cards/LoadError";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Tag, type TagTone } from "@/components/ui/Tag";
import type { ResearchState } from "@/lib/autopilotClient";

const MATERIAL_STATUS: Record<ResearchState["materials"][number]["state"], { label: string; tone: TagTone }> = {
  ready: { label: "可使用", tone: "neutral" },
  reading: { label: "正在读取", tone: "neutral" },
  attention: { label: "需要处理", tone: "warn" },
  unavailable: { label: "无法使用", tone: "safety" },
};

/**
 * Anatomy: associated project materials, source status, and intake actions.
 * Variants: empty, loading, failed, and populated lists.
 * States: an association is not proof that a run read the source.
 * Hit area: shared Button and IconButton controls.
 * Keyboard: native links and buttons.
 * Long content: names truncate visually and retain accessible names.
 * Theme: semantic surface, text and status roles.
 * Responsive: action controls wrap and list names yield space to state.
 * Verification: ResearchDataPanel.test.tsx; production source behavior requires a live acceptance run.
 */
export function ResearchDataPanel({ materials, loading, error, busy, onUpload, onPick, onDatabase, onRemove, onRetry }: {
  materials: ResearchState["materials"];
  loading: boolean;
  error: string | null;
  busy: boolean;
  onUpload: () => void;
  onPick: () => void;
  onDatabase: () => void;
  onRemove: (sourceId: string) => void;
  onRetry: () => void;
}) {
  return <section aria-label="研究资料" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-body font-semibold text-text">研究资料</h2>
      <div className="flex flex-wrap gap-1">
        <Button variant="secondary" size="sm" disabled={busy} onClick={onUpload}>上传资料</Button>
        <Button variant="text" size="sm" disabled={busy} onClick={onPick}>从知识库选择</Button>
        <Button variant="text" size="sm" disabled={busy} onClick={onDatabase}>连接数据库</Button>
      </div>
    </div>
    {error && <LoadError message={error} onRetry={onRetry} />}
    {loading && !error && <p role="status" className="text-ui text-text-3">正在加载研究资料</p>}
    {materials.length === 0 && !loading && !error ?
        <p className="text-ui text-text">尚未关联资料；也可以只用公开文献开展研究。</p> : materials.length > 0 ? <>
          <p className="text-caption text-text">已关联的资料可供研究使用，关联不代表已经阅读。</p>
          <ul className="space-y-1" aria-label="已关联资料">{materials.map((item) => {
            const status = MATERIAL_STATUS[item.state];
            return <li key={item.sourceId} className="flex min-w-0 items-center gap-2 py-1">
              <FileText size={16} className="shrink-0 text-text-3" aria-hidden="true" />
              <Link to={`/app/files/${encodeURIComponent(item.sourceId)}`} className="min-w-0 flex-1 truncate text-ui text-accent">{item.name}</Link>
              <Tag tone={status.tone}>{status.label}</Tag>
              <IconButton icon={X} label={`移除 ${item.name}`} size="sm" disabled={busy} onClick={() => onRemove(item.sourceId)} />
            </li>;
          })}</ul>
        </> : null}
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-ui">
      <Link to="/app/account?tab=connectors" className="text-accent">管理数据源</Link>
      <a href="https://pubmed.ncbi.nlm.nih.gov/" target="_blank" rel="noreferrer" className="text-accent">查找公开文献（PubMed）</a>
    </div>
  </section>;
}
