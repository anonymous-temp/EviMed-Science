import { useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTitle } from "@/components/layout/PageTitle";
import { Disclosure } from "@/components/ui/Disclosure";
import { FilesPage } from "./FilesPage";
import { SourcesPage, type SourceProgress } from "./SourcesPage";

/** The two nouns this product keeps apart, printed under the title (plan §3.1). */
const DEFINITION = "你放进来的资料：文献、方案、数据。EviMed 回答和做研究时会去读。它自己记下的内容在「记忆胶囊」。";

/**
 * 知识库 — one page.
 *
 * It was two tabs, 文件 and 整理进度, over one body of material: the same
 * documents seen as a folder and as a job table. A researcher opening this page
 * wants to know what is in here and whether it is ready, which is one question,
 * so the documents are one list and each row carries its own state. 整理进度
 * survives only as the line at the top, and only when something actually needs
 * attention — a progress view that is always on screen is a job queue the
 * product asked somebody to watch.
 *
 * The raw folder is still reachable underneath, because uploading and reading a
 * file are real things to do with it; it is just not a peer of the list.
 */
export function KnowledgePage() {
  const [progress, setProgress] = useState<SourceProgress>({ needsAttention: 0, working: 0 });
  const notice = progress.needsAttention > 0
    ? `有 ${progress.needsAttention} 份资料需要你看一眼：下面标了「需要处理」的那几份。`
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
        <Disclosure summary="上传与浏览原始文件" summaryClassName="text-ui text-text">
          <div className="mt-3 h-96 overflow-hidden rounded-card border border-border">
            <FilesPage />
          </div>
        </Disclosure>
      </div>
    </div>
  );
}
