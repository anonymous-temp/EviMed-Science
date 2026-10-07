import { describe, expect, it } from "vitest";
import { artifactDisplayName, isReadableArtifact, splitArtifacts } from "./artifactNames";

describe("artifact display names", () => {
  it("names the documents a researcher reads and leaves machine files as they are", () => {
    expect(artifactDisplayName("deliverables/aspirin-70plus-evidence/clinical-evidence-report.md")).toBe("证据分析报告");
    expect(artifactDisplayName("clinical-evidence-matrix.json")).toBe("证据矩阵");
    expect(artifactDisplayName("deliverables/x/revision-notes.md")).toBe("修订说明");
    expect(artifactDisplayName("deliverables/x/meta-analysis-run.json")).toBe("meta-analysis-run.json");
    expect(artifactDisplayName("work/patch2.py")).toBe("patch2.py");
  });
});

describe("which of a run's files are documents", () => {
  const ref = (path: string) => ({ runId: "run-1", path });

  it("offers the report and the evidence matrix, and keeps scripts, intermediate JSON and logs apart", () => {
    const split = splitArtifacts([
      "deliverables/x/build_final.py", "deliverables/x/chk2.py", "deliverables/x/agenda-delta.json",
      "deliverables/x/clinical-evidence-matrix.json", "deliverables/x/clinical-evidence-report.md",
    ].map(ref));
    expect(split.readable.map(item => item.path)).toEqual(["deliverables/x/clinical-evidence-report.md", "deliverables/x/clinical-evidence-matrix.json"]);
    expect(split.other.map(item => item.path)).toEqual(["deliverables/x/build_final.py", "deliverables/x/chk2.py", "deliverables/x/agenda-delta.json"]);
  });

  it("ranks the report, its matrix, documents, sheets and pictures in that order, and a delivery summary last", () => {
    const { readable } = splitArtifacts(["notes.md", "delivery-summary.md", "plot.png", "table.xlsx", "meta-analysis-report.md", "clinical-evidence-matrix.json", "protocol.docx"].map(ref));
    expect(readable.map(item => item.path)).toEqual(["meta-analysis-report.md", "clinical-evidence-matrix.json", "notes.md", "protocol.docx", "table.xlsx", "plot.png", "delivery-summary.md"]);
    // A reporting checklist is a document, not the report; a spreadsheet that says report is a sheet.
    expect(splitArtifacts(["reporting-checklist.md", "report-data.csv", "report.md"].map(ref)).readable.map(item => item.path)).toEqual(["report.md", "reporting-checklist.md", "report-data.csv"]);
  });

  it("reads a closed list of formats, by extension and case, and JSON only when it is a matrix", () => {
    for (const path of ["a.MD", "b.pdf", "c.pptx", "d.html", "e.csv", "f.tsv", "g.jpeg", "h.svg", "i.txt", "dir/clinical-evidence-matrix.json", "Evidence-Matrix-v2.json"]) expect(isReadableArtifact(path), path).toBe(true);
    for (const path of ["a.py", "b.json", "c.log", "d.bib", "e", "agenda-delta.json", "f.zip", "work/revision-notes.md"]) expect(isReadableArtifact(path), path).toBe(false);
  });

  it("never loses a file: every ref is in exactly one of the two lists", () => {
    const refs = ["a.md", "b.py", "c.json", "d.xlsx", "e.log"].map(ref);
    const { readable, other } = splitArtifacts(refs);
    expect([...readable, ...other].map(item => item.path).sort()).toEqual(refs.map(item => item.path).sort());
  });
});
