import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { KnowledgePage } from "./KnowledgePage";
import type { SourceProgress } from "./SourcesPage";

vi.mock("./SourcesPage", () => ({
  SourcesPage: ({ onProgress }: { onProgress?: (progress: SourceProgress) => void }) => {
    onProgress?.(progress);
    return <p>资料清单</p>;
  },
}));

let progress: SourceProgress = { needsAttention: 0, working: 0 };

function open(next: SourceProgress = { needsAttention: 0, working: 0 }) {
  progress = next;
  return render(
    <MemoryRouter initialEntries={["/app/files?tab=notebooks"]}>
      <KnowledgePage />
    </MemoryRouter>,
  );
}

describe("知识库", () => {
  // It was two tabs over one body of material, then one list of cards over a
  // second view of the same folder as a file tree beside a preview pane
  // (「上传与浏览原始文件」), so an empty knowledge base showed three empty
  // states at once (2026-09-22). One page, one list: the documents are the
  // list, each row carries its own state and opens its own preview.
  it("is one page with the two nouns printed under its title, one list and no second view of the folder", () => {
    open();
    expect(screen.getByRole("heading", { name: "知识库", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/你放进来的资料/)).toBeInTheDocument();
    expect(screen.getByText(/它自己记下的内容在「记忆胶囊」/)).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toEqual([]);
    expect(screen.getByText("资料清单")).toBeInTheDocument();
    expect(screen.queryByText("上传与浏览原始文件")).toBeNull();
    expect(screen.queryByText("个人知识库")).toBeNull();
    expect(screen.queryByText(/笔记本/)).toBeNull();
  });

  it("says 整理进度 only when something actually needs it", () => {
    open();
    expect(screen.queryByRole("status")).toBeNull();

    open({ needsAttention: 2, working: 1 });
    expect(screen.getAllByRole("status").at(-1)).toHaveTextContent("有 2 份资料需要你看一眼");

    open({ needsAttention: 0, working: 3 });
    expect(screen.getAllByRole("status").at(-1)).toHaveTextContent("正在整理 3 份资料，完成后会自动可用，不需要等在这里。");
  });
});
