import { WorkbenchTabs, type WorkbenchTab } from "@/components/layout/WorkbenchTabs";
import { FilesPage } from "./FilesPage";
import { SourcesPage } from "./SourcesPage";
import { NotebooksPage } from "./NotebooksPage";

/**
 * The knowledge base: the files, how far their parsing got, and the notebooks
 * computed over them.
 *
 * These were three top-level navigation rows over one body of material —
 * 「知识库」 uploaded files, 「资料整理」 the same files' parse state under a
 * page titled 「资料整理台」, and 「科研笔记本」, which is not a notebook in the
 * note-taking sense at all but Jupyter `.ipynb` documents (2026-09-15 walk,
 * C1/C3). One destination, three views; the third is renamed to what it is.
 */
const TABS: readonly WorkbenchTab[] = [
  { key: "files", label: "文件", render: () => <FilesPage /> },
  { key: "sources", label: "整理进度", render: () => <SourcesPage embedded /> },
  { key: "notebooks", label: "计算笔记本", render: () => <NotebooksPage embedded /> },
];

export function KnowledgePage() {
  return (
    <WorkbenchTabs
      title="知识库"
      description="上传与整理研究资料，查看解析进度，并在计算笔记本里对它们做分析。"
      tabs={TABS}
    />
  );
}
