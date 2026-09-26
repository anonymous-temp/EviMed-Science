import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FilePreviewInspector as FilePreviewInspectorT } from "@ai4s/shared";
import { FilePreviewInspector, PreviewError } from "./FilePreviewInspector";
import { readArtifact, readClaimVerification } from "@/lib/artifactFile";

// The markdown tests below carry inline `content`, so they never hit
// readArtifact — this mock only feeds the binary-file test.
const probeLargeFile = vi.fn();
const downloadArtifact = vi.fn();
const downloadInlineArtifact = vi.fn();
const openArtifactExternally = vi.fn();
vi.mock("@/lib/apiClient", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/apiClient")>();
  return {
    ...mod,
    hasWebApi: true,
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
    readClaimVerification: vi.fn(async () => null),
    probeLargeFile: (...args: unknown[]) => probeLargeFile(...args),
    downloadArtifact: (...args: unknown[]) => downloadArtifact(...args),
    downloadInlineArtifact: (...args: unknown[]) => downloadInlineArtifact(...args),
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

  it("reads a clinical report's matrix beside it, so each finding opens what it rests on", async () => {
    vi.mocked(readArtifact).mockImplementationOnce(async (path: string) => path === "deliverables/d1/clinical-evidence-matrix.json"
      ? { path, mime: "application/json", encoding: "utf8", size: 1, data: JSON.stringify({ claims: [
        { claimId: "CLM-001", claim: "MIMIC-IV 是单一机构数据库。", claimType: "direct", supportQuote: "covering a decade", sourceTitle: "MIMIC-IV" },
      ] }) }
      : null);
    render(<FilePreviewInspector data={{ ...md, path: "deliverables/d1/clinical-evidence-report.md", filename: "clinical-evidence-report.md",
      content: "MIMIC-IV 为单一机构数据库 [1]<!-- claim:CLM-001 -->。" }} onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "查看这句话的依据（1 条主张）" }));
    // Scoped to the popover: the source cards under the report quote the same
    // passage, from the other end of the same citation system.
    const claim = await screen.findByText("MIMIC-IV 是单一机构数据库。");
    expect(within(claim.closest("[data-claim-id]") as HTMLElement).getByText("“covering a decade”")).toBeInTheDocument();
    expect(vi.mocked(readArtifact)).toHaveBeenCalledWith("deliverables/d1/clinical-evidence-matrix.json", undefined);
  });

  it("says above the report how much of it was checked, and flags the sentence whose quotation was not found", async () => {
    vi.mocked(readArtifact).mockImplementationOnce(async (path: string) => path === "deliverables/d1/clinical-evidence-matrix.json"
      ? { path, mime: "application/json", encoding: "utf8", size: 1, data: JSON.stringify({ claims: [
        { claimId: "CLM-001", claim: "MIMIC-IV 是单一机构数据库。", claimType: "direct", supportQuote: "covering a decade", sourceTitle: "MIMIC-IV" },
        { claimId: "CLM-002", claim: "队列为 50,920 人。", claimType: "direct", supportQuote: "50,920 unique patients", sourceTitle: "MIMIC-IV" },
      ] }) }
      : null);
    vi.mocked(readClaimVerification).mockResolvedValueOnce({
      claims: [
        { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [] },
        { claimId: "CLM-002", claimType: "direct", status: "quote_not_found", sources: [] },
      ],
      counts: { verified: 1, quote_not_found: 1 },
    });
    render(<FilePreviewInspector data={{ ...md, path: "deliverables/d1/clinical-evidence-report.md", filename: "clinical-evidence-report.md",
      content: "单一机构数据库 [1]<!-- claim:CLM-001 -->。队列 50,920 人 [1]<!-- claim:CLM-002 -->。" }} onClose={() => {}} />);
    expect(await screen.findByRole("note")).toHaveTextContent("⚠ 1 条待核对");
    expect(screen.getByRole("button", { name: "查看这句话的依据（1 条主张，其中有未核对上的引文）" })).toBeInTheDocument();
    // Every quotation of this sentence was found: the mark says so, in words.
    expect(screen.getByRole("button", { name: "查看这句话的依据（1 条主张，引文均已核对）" })).toHaveTextContent("依据 ✓");
    expect(vi.mocked(readClaimVerification)).toHaveBeenCalledWith("deliverables/d1/clinical-evidence-matrix.json", undefined);
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
    render(<FilePreviewInspector data={md} onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Findings" })).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /用本地应用打开/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "下载文件" }));

    expect(downloadInlineArtifact).toHaveBeenCalledWith(md.content, "report.md");
    expect(downloadArtifact).not.toHaveBeenCalled();
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

describe("FilePreviewInspector — a notebook, after the notebook editor", () => {
  it("reads a record that still names the deleted notebook kind as a file, with its JSON", async () => {
    // `notebook` left the artifact kinds on 2026-09-19. A record written before
    // that still says it, and must open as a generic file rather than fail.
    const notebook = JSON.stringify({ cells: [{ cell_type: "code", source: "print(42)" }], nbformat: 4 });
    vi.mocked(readArtifact).mockImplementationOnce(async (path: string) => ({
      path, mime: "application/json", encoding: "utf8", data: notebook, size: notebook.length,
    }));
    const legacy = {
      variant: "file",
      path: "analysis/run.ipynb",
      filename: "run.ipynb",
      artifact: "notebook",
      language: "json",
    } as unknown as FilePreviewInspectorT;
    render(<FilePreviewInspector data={legacy} onClose={() => {}} />);
    expect(await screen.findByText(/print\(42\)/)).toBeInTheDocument();
    expect(screen.getByText("文件")).toBeInTheDocument();
    expect(screen.queryByText("笔记本")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载文件" })).toBeInTheDocument();
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

describe("FilePreviewInspector — a knowledge-base document", () => {
  // 2026-09-24: an uploaded PDF was tagged 「报告」 (`extToKind("pdf")`), as if
  // a run had produced it, and nothing about the document sat with it.
  it("names the document's format instead of an artifact kind, and puts what is known about it above the preview", async () => {
    const pdf: FilePreviewInspectorT = { variant: "file", path: "knowledge-base/指南.pdf", filename: "指南.pdf", artifact: "report", root: "base" };
    const { unmount } = render(<FilePreviewInspector data={pdf} kindLabel="PDF" lead={<p>摘要：一份抗凝指南。</p>} onClose={() => {}} />);
    expect(await screen.findByText("PDF")).toBeInTheDocument();
    expect(screen.queryByText("报告")).not.toBeInTheDocument();
    expect(screen.getByText("摘要：一份抗凝指南。")).toBeInTheDocument();
    unmount();
    // `null` shows no tag at all; an unset label keeps the artifact kind.
    const bare = render(<FilePreviewInspector data={pdf} kindLabel={null} onClose={() => {}} />);
    expect(bare.container.textContent).not.toMatch(/报告|PDF/);
    bare.unmount();
    render(<FilePreviewInspector data={md} onClose={() => {}} />);
    expect(await screen.findByText("报告")).toBeInTheDocument();
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
    expect(screen.getByText("文件过大，无法预览")).toBeInTheDocument();
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
