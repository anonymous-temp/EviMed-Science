import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourcePdf } from "./SourcePdf";

const mocks = vi.hoisted(() => ({ getDocument: vi.fn(), previewUrl: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument: mocks.getDocument, GlobalWorkerOptions: {}, TextLayer: class {} }));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.js" }));
vi.mock("@/lib/artifactFile", () => ({
  previewUrl: mocks.previewUrl,
  sourceFileUrl: (id: string, mode: string) => `/api/sources/${id}/file?mode=${mode}`,
}));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mocks.getDocument.mockReset().mockReturnValue({ promise: new Promise(() => {}), destroy: vi.fn() });
  mocks.previewUrl.mockReset().mockResolvedValue("/api/files/preview/paper.pdf?projectId=p1");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("reads a project's PDF through the project's folder", async () => {
  render(<SourcePdf path="knowledge-base/uploads/paper.pdf" projectId="p1" initialPage={2} quote="a cited line" />);
  await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledWith({ url: "/api/files/preview/paper.pdf?projectId=p1", withCredentials: true }));
  expect(mocks.previewUrl).toHaveBeenCalledWith("knowledge-base/uploads/paper.pdf", "base", "p1");
});

it("reads a personal PDF by its source id and never asks for the storage project's folder, which the server does not serve", async () => {
  render(<SourcePdf path="knowledge-base/uploads/paper.pdf" projectId="evimed-library" sourceFileId="src_pdf" initialPage={2} quote="a cited line" />);
  await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledWith({ url: "/api/sources/src_pdf/file?mode=preview", withCredentials: true }));
  expect(mocks.previewUrl).not.toHaveBeenCalled();
});
