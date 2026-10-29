import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { KnowledgeOpenPage } from "./KnowledgeOpenPage";

const mocks = vi.hoisted(() => ({ pageAt: vi.fn() }));
vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()), getKnowledgePageAt: mocks.pageAt }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<object>()), getWebProjectId: () => "home" }));

function Where() { const location = useLocation(); return <p data-testid="where">{location.pathname}{location.search}</p>; }
function open(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/files/open${search}`]}>
      <Routes><Route path="/app/files/open" element={<><KnowledgeOpenPage /><Where /></>} /><Route path="/app/files/:sourceId" element={<Where />} /></Routes>
    </MemoryRouter>,
  );
}

describe("a compiled file named by its place", () => {
  // A hook body that returns the mock would be run as a teardown, and call it once more with nobody to answer.
  beforeEach(() => { mocks.pageAt.mockReset(); });
  afterEach(cleanup);

  it("goes to the document's own page, in the project the file is of", async () => {
    mocks.pageAt.mockResolvedValue({ sourceId: `src_${"a".repeat(32)}` });
    open("?project=p1&tree=kg&path=entities%2Falpha.md");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/app/files/src_${"a".repeat(32)}?scope=p1&kind=wiki`));
    expect(mocks.pageAt).toHaveBeenCalledWith("p1", "kg", "entities/alpha.md");
  });

  it("names the tab's own project in the address too: without a scope the way back lists the account's materials, which have no pages", async () => {
    mocks.pageAt.mockResolvedValue({ sourceId: `src_${"b".repeat(32)}` });
    open("?project=home&tree=wiki&path=concept%2FA.md");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/app/files/src_${"b".repeat(32)}?scope=home&kind=wiki`));
  });

  it("says in one sentence that a file is gone, with the way to the pages", async () => {
    mocks.pageAt.mockRejectedValue(new WebApiError("gone", { status: 404, code: "knowledge_page_not_found" }));
    open("?project=p1&tree=kg&path=entities%2Fgone.md");
    expect(await screen.findByText("这一页现在没有找到，可能已被重新整理。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回到知识页" })).toHaveAttribute("href", "/app/files?scope=p1&kind=wiki");
  });

  it("sends an address it cannot read back to the tab's own project's pages, not to the account's materials", async () => {
    open("?project=&tree=kg&path=entities%2Fx.md");
    expect(await screen.findByText("这一页现在没有找到，可能已被重新整理。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回到知识页" })).toHaveAttribute("href", "/app/files?scope=home&kind=wiki");
  });

  it("never asks for an address it cannot read", async () => {
    open("?project=p1&tree=kg&path=..%2Fx.md");
    expect(await screen.findByText("这一页现在没有找到，可能已被重新整理。")).toBeInTheDocument();
    expect(mocks.pageAt).not.toHaveBeenCalled();
  });
});

it("retains the selected logical alias and page receipt when opening its shared source id", async () => {
  const address = { projectId: "p1", tree: "wiki", path: "concept/zz-duplicate.md", generationId: `kg_${"a".repeat(32)}`, pageId: "page-alias", pageRevision: 4 };
  mocks.pageAt.mockResolvedValue({ sourceId: `src_${"c".repeat(32)}`, address });
  open("?project=p1&tree=wiki&path=concept%2Fzz-duplicate.md");
  await waitFor(() => expect(screen.getByTestId("where").textContent).toContain("kpPath=concept%2Fzz-duplicate.md"));
  expect(screen.getByTestId("where").textContent).toContain("kpId=page-alias&kpRevision=4");
});
