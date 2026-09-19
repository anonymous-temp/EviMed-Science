import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { KnowledgePage } from "./KnowledgePage";

vi.mock("./FilesPage", () => ({ FilesPage: () => <p>文件视图</p> }));
vi.mock("./SourcesPage", () => ({ SourcesPage: () => <p>整理进度视图</p> }));

describe("KnowledgePage", () => {
  // The computational notebook was deleted on 2026-09-19. Its tab link is what
  // the command palette and the old `/app/notebooks` redirect produced, so it
  // is in people's history and bookmarks; it opens the files, where a run's
  // `.ipynb` deliverables still are.
  it("opens the files for the retired notebook tab, and offers no notebook", () => {
    render(
      <MemoryRouter initialEntries={["/app/files?tab=notebooks"]}>
        <KnowledgePage />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["文件", "整理进度"]);
    expect(screen.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("文件视图");
    expect(screen.queryByText(/笔记本/)).toBeNull();
  });
});
