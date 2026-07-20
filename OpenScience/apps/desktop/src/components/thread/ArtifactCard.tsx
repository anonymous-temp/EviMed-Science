import {
  Box,
  FileBarChart,
  FileCode2,
  FileText,
  Image as ImageIcon,
  NotebookPen,
  Paperclip,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { ArtifactBlock, ArtifactKind } from "@ai4s/shared";
import { cn } from "@/lib/cn";

const ICON: Record<ArtifactKind, React.ReactNode> = {
  figure: <ImageIcon size={15} />,
  script: <FileCode2 size={15} />,
  report: <FileText size={15} />,
  table: <FileBarChart size={15} />,
  notebook: <NotebookPen size={15} />,
  model: <Box size={15} />,
  data: <Paperclip size={15} />,
};

const LABEL: Record<ArtifactKind, string> = {
  figure: "图表",
  script: "脚本",
  report: "报告",
  table: "表格",
  notebook: "计算文档",
  model: "模型",
  data: "数据",
};

/** A file the agent produced, surfaced live in the thread and openable in the inspector. */
export function ArtifactCard({
  block,
  onOpen,
}: {
  block: ArtifactBlock;
  onOpen?: (a: ArtifactBlock) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-input border border-border bg-surface px-3 py-2.5 text-sm",
        onOpen && "cursor-pointer hover:bg-surface-2",
      )}
      onClick={onOpen ? () => onOpen(block) : undefined}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={
        onOpen
          ? (e) => {
              // Keyboard parity with click (spec §2.1 keyboard/mouse equality).
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(block);
              }
            }
          : undefined
      }
    >
      <span className="shrink-0 text-accent">{ICON[block.artifact]}</span>
      <span className="truncate font-medium text-text">{block.filename}</span>
      <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted ring-1 ring-border">
        {LABEL[block.artifact]}
      </span>
      <span className="shrink-0 truncate text-xs text-muted">· 由 {block.tool} 生成</span>
      <div className="flex-1" />
      {onOpen && (
        <span className="flex shrink-0 items-center gap-1 rounded-input px-2 py-1 text-xs text-link">
          <SquareArrowOutUpRight size={13} /> 打开
        </span>
      )}
    </div>
  );
}
