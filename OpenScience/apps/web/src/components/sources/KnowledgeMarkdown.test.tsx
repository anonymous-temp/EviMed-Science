import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgePage } from "@/lib/sourceClient";
import pageMine from "./knowledgeFixtures/page-analysis-mine.json";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";

vi.mock("@/components/markdown-viewer/MarkdownViewer", () => ({ MarkdownViewer: () => { throw new Error("cannot draw"); } }));

describe("KnowledgeMarkdown when the page cannot be drawn", () => {
  it("shows what the page says as it is written, without the engine's address, and no error", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<MemoryRouter><KnowledgeMarkdown page={pageMine as unknown as KnowledgePage} /></MemoryRouter>);
    const raw = document.querySelector("[data-knowledge-raw]") as HTMLElement;
    expect(raw).not.toBeNull();
    expect(raw.textContent).toContain("type: analysis");
    expect(raw.textContent).toContain("事实时间线");
    expect(raw.textContent).not.toContain("viking://");
    expect(screen.queryByRole("alert")).toBeNull();
    quiet.mockRestore();
  });

  it("shows the graph's relation file as it is, not as a page", () => {
    const relations = { ...(pageMine as unknown as KnowledgePage), type: "relations", markdown: '{"from":"a","relation":"uses","to":"b"}\n', editable: false } as KnowledgePage;
    render(<MemoryRouter><KnowledgeMarkdown page={relations} /></MemoryRouter>);
    expect(document.querySelector("[data-knowledge-raw]")?.textContent).toContain('"relation":"uses"');
  });
});
