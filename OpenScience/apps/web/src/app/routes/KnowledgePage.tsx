import { WorkbenchTabs, type WorkbenchTab } from "@/components/layout/WorkbenchTabs";
import { FilesPage } from "./FilesPage";
import { SourcesPage } from "./SourcesPage";

/**
 * The knowledge base: the files, and how far their parsing got.
 *
 * These were separate top-level navigation rows over one body of material —
 * 「知识库」 uploaded files, and 「资料整理」 the same files' parse state under a
 * page titled 「资料整理台」 (2026-09-15 walk, C1/C3). One destination, two
 * views. A third view, 「计算笔记本」 (Jupyter `.ipynb` documents with cells
 * executed on the server), was deleted on 2026-09-19: it was not what the
 * product is for, and it sat deep enough that almost nobody reached it. A
 * run's `.ipynb` deliverable still opens under 文件, read-only, like any file.
 */
const TABS: readonly WorkbenchTab[] = [
  { key: "files", label: "文件", render: () => <FilesPage /> },
  { key: "sources", label: "整理进度", render: () => <SourcesPage embedded /> },
];

export function KnowledgePage() {
  return (
    <WorkbenchTabs
      title="知识库"
      description="上传与整理研究资料，查看解析进度。"
      tabs={TABS}
    />
  );
}
