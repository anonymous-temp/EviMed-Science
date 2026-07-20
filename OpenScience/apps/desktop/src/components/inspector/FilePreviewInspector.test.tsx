import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FilePreviewInspector as FilePreviewInspectorT } from "@ai4s/shared";
import { FilePreviewInspector, PreviewError } from "./FilePreviewInspector";

// The markdown tests below carry inline `content`, so they never hit
// readArtifact — this mock only feeds the binary-file test.
const probeLargeFile = vi.fn();
const downloadArtifact = vi.fn();
const openArtifactExternally = vi.fn();
vi.mock("@/lib/apiClient", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/apiClient")>();
  return {
    ...mod,
    hasCommandBackend: true,
    hasWebApi: true,
    isTauri: false,
  };
});
vi.mock("@/lib/artifactFile", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/artifactFile")>();
  return {
    ...mod,
    readArtifact: vi.fn(async () => ({
      path: "data/blob.bin",
      mime: "application/octet-stream",
      encoding: "base64",
      data: "AAEC",
      size: 3,
    })),
    previewUrl: vi.fn(async () => null),
    probeLargeFile: (...args: unknown[]) => probeLargeFile(...args),
    downloadArtifact: (...args: unknown[]) => downloadArtifact(...args),
    openArtifactExternally: (...args: unknown[]) => openArtifactExternally(...args),
  };
});

const md: FilePreviewInspectorT = {
  variant: "file",
  path: "notes/report.md",
  filename: "report.md",
  artifact: "report",
  content: "# Findings\n\nDose–response holds. `p < 0.01`.",
};

describe("FilePreviewInspector — markdown", () => {
  it("renders markdown as a formatted document by default", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} />);
    // The heading is real document markup, not raw "# Findings" text.
    expect(await screen.findByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(screen.queryByText("# Findings")).not.toBeInTheDocument();
  });

  it("toggles to the raw source under the source tab", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} />);
    await screen.findByRole("heading", { name: "Findings" });
    await userEvent.click(screen.getByRole("button", { name: /源文件/ }));
    expect(screen.getByText(/# Findings/)).toBeInTheDocument();
  });

  it("shows the newly opened file, not the previous one (no stale bleed)", async () => {
    // The same inspector instance is reused across files; opening a second
    // file with its own inline content must replace the first, not keep it.
    const a: FilePreviewInspectorT = { ...md, path: "a.md", filename: "a.md", content: "# Alpha" };
    const b: FilePreviewInspectorT = { ...md, path: "b.md", filename: "b.md", content: "# Beta" };
    const { rerender } = render(<FilePreviewInspector data={a} onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();

    rerender(<FilePreviewInspector data={b} onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Alpha" })).not.toBeInTheDocument();
  });

  it("uses browser download instead of the desktop open action in hosted web", async () => {
    downloadArtifact.mockResolvedValueOnce(undefined);
    render(<FilePreviewInspector data={md} onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Findings" })).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /用本地应用打开/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "下载文件" }));

    expect(downloadArtifact).toHaveBeenCalledWith("notes/report.md", undefined, "report.md");
    expect(openArtifactExternally).not.toHaveBeenCalled();
  });
});

describe("FilePreviewInspector — binary file behind a text preview", () => {
  it("says the file is binary instead of the misleading 'desktop app' note", async () => {
    // A text-kind preview whose read comes back base64 (genuinely binary
    // bytes) must say so — not claim the preview needs the desktop app.
    const bin: FilePreviewInspectorT = {
      variant: "file",
      path: "data/blob.bin",
      filename: "blob.bin",
      artifact: "data",
    };
    render(<FilePreviewInspector data={bin} onClose={() => {}} />);
    expect(await screen.findByText(/二进制文件，暂不支持预览/)).toBeInTheDocument();
    expect(screen.queryByText(/桌面应用/)).not.toBeInTheDocument();
  });
});

describe("FilePreviewInspector — HTML sandbox", () => {
  it("previews uploaded HTML without granting script execution", async () => {
    const html: FilePreviewInspectorT = {
      variant: "file",
      path: "reports/preview.html",
      filename: "preview.html",
      artifact: "report",
      content: "<!doctype html><script>window.__ran = true</script><h1>Preview</h1>",
    };
    render(<FilePreviewInspector data={html} onClose={() => {}} />);

    const frame = await screen.findByTitle("HTML 预览");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("sandbox") ?? "").not.toContain("allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  });
});

describe("PreviewError", () => {
  it("shows a helpful card with Open-externally for a too-large file", async () => {
    const onOpen = vi.fn();
    render(
      <PreviewError
        error="file too large to preview (>25 MB)"
        filename="huge.nc"
        path="data/huge.nc"
        onOpenExternally={onOpen}
      />,
    );
    expect(screen.getByText(/huge\.nc 文件过大，无法直接预览/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /用本地应用打开/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("inspects a too-large file without loading it and renders the pointer", async () => {
    probeLargeFile.mockResolvedValueOnce({
      format: "fastq",
      size: "90.0 GB",
      approx_reads: 450_000_000,
      read_length: { min: 150, max: 150, mean: 150 },
      gzipped: true,
      note: "Memory pointer — file introspected/sampled, not loaded.",
    });
    render(
      <PreviewError
        error="file too large to preview (>25 MB)"
        filename="reads.fastq.gz"
        path="data/reads.fastq.gz"
        onOpenExternally={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /轻量检查文件/ }));
    // The pointer's key facts render — the format value, the read count, and
    // that it was sampled, not loaded.
    expect(await screen.findByText("fastq")).toBeInTheDocument(); // the Format cell, exact
    expect(screen.getByText(/450,000,000/)).toBeInTheDocument();
    expect(screen.getByText(/not loaded/i)).toBeInTheDocument();
    expect(probeLargeFile).toHaveBeenCalledWith("data/reads.fastq.gz", undefined);
  });

  it("shows the probe's error if introspection fails", async () => {
    probeLargeFile.mockRejectedValueOnce(new Error("no Python found"));
    render(
      <PreviewError error="file too large to preview" filename="x.bam" path="x.bam" onOpenExternally={() => {}} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /轻量检查文件/ }));
    expect(await screen.findByText(/no Python found/)).toBeInTheDocument();
  });

  it("renders other errors as a plain line, no card", () => {
    render(<PreviewError error="Preview is available in the desktop app." filename="x.bin" onOpenExternally={() => {}} />);
    expect(screen.getByText(/available in the desktop app/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /用本地应用打开/ })).not.toBeInTheDocument();
  });
});
