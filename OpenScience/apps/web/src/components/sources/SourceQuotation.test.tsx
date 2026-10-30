import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@/lib/sourceClient";
import { SourceQuotation } from "./SourceQuotation";
const mocks = vi.hoisted(() => ({ excerpt: vi.fn() }));
vi.mock("@/lib/sourceClient", () => ({ getSourceQuoteExcerpt: mocks.excerpt }));
vi.mock("./SourceOriginal", () => ({ SourceOriginal: () => <div>Original</div> }));
vi.mock("./SourcePdf", () => ({ SourcePdf: ({ path, projectId, sourceFileId }: { path: string; projectId: string; sourceFileId?: string }) =>
  <div data-testid="pdf" data-path={path} data-project={projectId} data-source-file={sourceFileId ?? ""} /> }));
it("offers only a currently available bounded excerpt to an unsent conversation", async () => {
  mocks.excerpt.mockResolvedValue({ status: "available", text: "prefix exact quote suffix", start: 7, end: 18, quote: "exact quote", page: 3 });
  const useExcerpt = vi.fn();
  render(<SourceQuotation source={{ id: "src_one", revision: 7, display: {}, payload: { paths: [] } } as unknown as SourceRecord} span={{ start: 123, end: 134, sha: "a".repeat(64) }} onNoteSaved={vi.fn()} onUseExcerpt={useExcerpt} />);
  await userEvent.click(await screen.findByRole("button", { name: "在对话中使用这段原文" }));
  expect(useExcerpt).toHaveBeenCalledWith({ text: "exact quote", start: 123, end: 134, textSha256: "a".repeat(64), page: 3 });
});
describe("unavailable excerpt", () => {
  it("does not offer stale text as a quotation", async () => {
    mocks.excerpt.mockResolvedValue({ status: "changed", text: null, start: null, end: null });
    render(<SourceQuotation source={{ id: "src_two", display: {}, payload: { paths: [] } } as unknown as SourceRecord} span={{ start: 1, end: 2, sha: "a".repeat(64) }} onNoteSaved={vi.fn()} onUseExcerpt={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/资料版本已变化/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "在对话中使用这段原文" })).toBeNull();
  });
});

describe("the cited page of a PDF", () => {
  const pdf = (over: Record<string, unknown> = {}) => ({ id: "src_pdf", projectId: "p1", revision: 2, display: { origin: "upload", kind: "literature" }, payload: { paths: ["knowledge-base/uploads/paper.pdf"] }, ...over }) as unknown as SourceRecord;
  const show = (source: SourceRecord) => render(<SourceQuotation source={source} span={{ start: 1, end: 2, sha: "a".repeat(64) }} onNoteSaved={vi.fn()} />);
  beforeEach(() => { mocks.excerpt.mockResolvedValue({ status: "available", text: "a cited line", start: 0, end: 5, quote: "a cited", page: 2 }); });

  it("opens a project's PDF from the project's folder", async () => {
    show(pdf());
    const view = await screen.findByTestId("pdf");
    expect(view).toHaveAttribute("data-project", "p1");
    expect(view).toHaveAttribute("data-source-file", "");
  });

  it("opens a PDF in personal storage by its own id, since the storage project is no folder a reader may name", async () => {
    show(pdf({ projectId: "evimed-library", personal: true }));
    expect(await screen.findByTestId("pdf")).toHaveAttribute("data-source-file", "src_pdf");
  });
});
