import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenomeView } from "./GenomeView";

// The feature limit is 50,000 lines: a file that long takes seconds to draw, so the parser is told to report the cut instead.
const parser = vi.hoisted(() => ({ cut: false }));
vi.mock("@/lib/genome", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/genome")>();
  return { ...actual, parseGenome: (text: string, format: Parameters<typeof actual.parseGenome>[1]) => ({ ...actual.parseGenome(text, format), ...(parser.cut ? { truncated: true } : {}) }) };
});
afterEach(() => { parser.cut = false; });

const BED = "chr1\t0\t100\tgeneA\t500\t+\nchr1\t150\t260\tgeneB\t0\t-\nchr2\t0\t50\tgeneC";

describe("GenomeView", () => {
  it("renders features from a BED file as track rects with a format badge", () => {
    const { container } = render(<GenomeView filename="ann.bed" text={BED} />);
    expect(screen.getByText("BED")).toBeInTheDocument();
    // chr1 is busiest (2 features) → default contig; both features drawn as rects.
    const rects = container.querySelectorAll("svg rect");
    expect(rects.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/2 个特征/)).toBeInTheDocument();
  });

  it("offers a contig selector when multiple contigs are present", () => {
    render(<GenomeView filename="ann.bed" text={BED} />);
    const select = screen.getByRole("combobox", { name: /序列片段/ });
    expect(select).toBeInTheDocument();
    // Two contigs listed; chr1 first (busiest).
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["chr1 (2)", "chr2 (1)"]);
  });

  it("switches contigs", async () => {
    render(<GenomeView filename="ann.bed" text={BED} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /序列片段/ }), "1");
    expect(screen.getByText(/1 个特征/)).toBeInTheDocument(); // chr2 has one
  });

  it("shows an empty state for a file with no features", () => {
    render(<GenomeView filename="empty.gff" text="##gff-version 3\n# nothing else\n" />);
    expect(screen.getByText(/未找到特征/)).toBeInTheDocument();
  });

  it("says in Chinese how to move around the contig", () => {
    render(<GenomeView filename="ann.bed" text={BED} />);
    expect(screen.getByText(/拖动平移 · 滚轮缩放/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Drag|scroll|showing|truncated/);
  });

  it("says in Chinese when only the first rows of a crowded contig are drawn", () => {
    const crowded = Array.from({ length: 70 }, (_, index) => `chr1\t0\t100\tgene${index}`).join("\n");
    render(<GenomeView filename="ann.bed" text={crowded} />);
    expect(screen.getByText(/拖动平移/)).toHaveTextContent("拖动平移 · 滚轮缩放 · 共 70 行，显示前 60 行");
    expect(document.body.textContent).not.toMatch(/showing|rows/);
  });

  it("says in Chinese when the file was cut at the feature limit", () => {
    parser.cut = true;
    render(<GenomeView filename="ann.bed" text={BED} />);
    expect(screen.getByText(/拖动平移/)).toHaveTextContent("拖动平移 · 滚轮缩放 · 文件太大，只读取了前 50,000 个特征");
    expect(document.body.textContent).not.toMatch(/truncated|features/);
  });
});

