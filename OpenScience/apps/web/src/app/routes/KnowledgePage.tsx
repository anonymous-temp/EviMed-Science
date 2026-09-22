import { useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTitle } from "@/components/layout/PageTitle";
import { SourcesPage, type SourceProgress } from "./SourcesPage";

/** The two nouns this product keeps apart, printed under the title (plan §3.1). */
const DEFINITION = "你放进来的资料：文献、方案、数据。EviMed 回答和做研究时会去读。它自己记下的内容在「记忆胶囊」。";

/**
 * 知识库 — one page, one list.
 *
 * It was the documents as cards over a second view of the same folder as a
 * file tree with a preview pane (「上传与浏览原始文件」), so an empty knowledge
 * base showed three empty states at once (2026-09-22, 「乱」). The list is
 * the page now: each row carries its own state and opens its own preview;
 * upload is the one primary action at the top. The line above the list says
 * what still needs someone, and only when something does.
 */
export function KnowledgePage() {
  const [progress, setProgress] = useState<SourceProgress>({ needsAttention: 0, working: 0 });
  const notice = progress.needsAttention > 0
    ? `有 ${progress.needsAttention} 份资料需要你看一眼：下面标了「需要你看一下」的那几份。`
    : progress.working > 0
      ? `正在整理 ${progress.working} 份资料，完成后会自动可用，不需要等在这里。`
      : "";

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <PageTitle page="知识库" />
      <div className="mx-auto w-full max-w-content-wide space-y-5 px-6 py-6">
        <PageHeader title="知识库" description={DEFINITION} />
        {notice && (
          <p role="status" className="rounded-card border border-border bg-surface px-4 py-3 text-ui text-text">{notice}</p>
        )}
        <SourcesPage embedded onProgress={setProgress} />
      </div>
    </div>
  );
}
