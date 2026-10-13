import { Button } from "@/components/ui/Button";
import type { KnowledgeStatus } from "@/lib/sourceClient";
import { statusLine } from "./knowledgeView";

/**
 * Where the project's pages stand, in one quiet line under the knowledge base's header: 整理中 · 正在整理页面, 已整理 · 上次整理于 …,
 * 资料不足, 页数已到上限, 知识引擎暂不可用 — and 「重新整理」 where a round can be asked for. It says nothing when the deployment does
 * not compile pages. Nothing in it blocks an upload or a conversation.
 */
export function KnowledgeStatusLine({ status, asking, onCompile }: { status: KnowledgeStatus | null; asking: boolean; onCompile: () => void }) {
  const line = statusLine(status);
  if (!line) return null;
  return (
    <div data-knowledge-status={status?.state} role="status" aria-label="知识页的整理情况"
      className={`mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption ${line.attention ? "text-warn-strong" : "text-text-3"}`}>
      <span>{line.text}</span>
      {line.canCompile && <Button variant="text" size="sm" loading={asking} disabled={asking} onClick={onCompile}>重新整理</Button>}
    </div>
  );
}
