import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@/lib/sourceClient";
import { SourceQuotation } from "./SourceQuotation";
const mocks = vi.hoisted(() => ({ excerpt: vi.fn() }));
vi.mock("@/lib/sourceClient", () => ({ getSourceQuoteExcerpt: mocks.excerpt }));
vi.mock("./SourceOriginal", () => ({ SourceOriginal: () => <div>Original</div> }));
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
