// Which file a stopped run hands over as its main document (terminalPresentation.mjs).
//
// DeepResearch Bench task 65 was cancelled at its cap with a 52 KB report and the Word file built from it already on disk,
// among build scripts, figures and the five pieces the report was assembled from, and its record presented none of them.
// The rule is closed and deterministic: these cases are its fixtures, and the last one is that run's file list.
import assert from "node:assert/strict";
import test from "node:test";

import { MAIN_DOCUMENT_LIMIT, pickMainDocuments } from "../src/terminalPresentation.mjs";

const T = Date.parse("2026-10-28T12:00:00.000Z");
/** @param {string} path @param {number} size @param {number} [age] minutes before T */
const file = (path, size, age = 0) => ({ path, size, mtimeMs: T - age * 60_000 });

test("a report in two formats is one hand-over, the larger of the two first, whatever their stems", () => {
  const picked = pickMainDocuments([
    file("study/report/report.md", 52_000),
    file("study/report/Design_Report_Final.docx", 410_000),
    file("study/report/build.py", 9_000),
    file("study/figures/fig01.png", 90_000),
  ]);
  assert.deepEqual(picked, ["study/report/Design_Report_Final.docx", "study/report/report.md"]);
  assert.equal(picked.length <= MAIN_DOCUMENT_LIMIT, true);
});

test("the pieces a report was assembled from, scratch, dot directories and scripts are never the document", () => {
  assert.deepEqual(pickMainDocuments([
    file("report/parts/p1.md", 90_000),
    file("report/Parts/p2.md", 90_000),
    file("report/sections/s1.md", 90_000),
    file("report/drafts/v1.md", 90_000),
    file("tmp/notes.md", 90_000),
    file("work/plan.md", 90_000),
    file(".hidden/report.md", 90_000),
    file("node_modules/pkg/README.md", 90_000),
    file("knowledge-base/wiki/page.md", 90_000),
    file("report/build.py", 90_000),
    file("report/results.json", 90_000),
    file("report/fig.png", 90_000),
    file("deliverables/d1/revision-notes.md", 90_000),
  ]), [], "every one of these is something other than the document");
  assert.deepEqual(pickMainDocuments([file("report/parts/p1.md", 90_000), file("report/report.md", 2_000)]), ["report/report.md"],
    "a small report outranks the larger piece it was built from");
});

test("the order is: a report by name, then the larger, then the newer, then the path", () => {
  // A file the classifier calls a report leads the larger one that is not.
  assert.deepEqual(pickMainDocuments([file("out/notes.docx", 80_000), file("out/final_report.md", 1_000)]), ["out/final_report.md", "out/notes.docx"]);
  assert.deepEqual(pickMainDocuments([file("out/notes.md", 80_000), file("out/final_report.md", 1_000)]), ["out/final_report.md"]);
  // A checklist that contains the word is not a report (the classifier's own exception), and the delivery summary comes last.
  assert.deepEqual(pickMainDocuments([file("d/reporting-checklist.md", 500), file("d/delivery-summary.md", 90_000), file("d/answer.md", 400)]),
    ["d/reporting-checklist.md"], "the larger of the equal-lead documents; the summary is behind both; one markdown family, so one file");
  // The larger, and for equal sizes the newer, and for equal times the path.
  assert.deepEqual(pickMainDocuments([file("a/x.docx", 10, 5), file("a/y.docx", 20, 9)]), ["a/y.docx"]);
  assert.deepEqual(pickMainDocuments([file("a/x.docx", 10, 5), file("a/y.docx", 10, 1)]), ["a/y.docx"]);
  assert.deepEqual(pickMainDocuments([file("a/b.docx", 10), file("a/a.docx", 10)]), ["a/a.docx"]);
  const forward = pickMainDocuments([file("a/x.pdf", 7), file("a/y.pdf", 7), file("b/z.pdf", 7)]);
  const backward = pickMainDocuments([file("b/z.pdf", 7), file("a/y.pdf", 7), file("a/x.pdf", 7)]);
  assert.deepEqual(forward, backward, "the choice does not depend on the order the files were listed in");
});

test("the second file is a rendition of the first: same directory, another format family, a document", () => {
  assert.deepEqual(pickMainDocuments([file("r/summary.md", 5_000), file("r/summary.docx", 30_000), file("r/summary.html", 4_000)]),
    ["r/summary.docx", "r/summary.md"], "at most two, the first of the others");
  assert.deepEqual(pickMainDocuments([file("r/a.md", 5_000), file("r/b.md", 4_000)]), ["r/a.md"], "two markdown files are not two formats");
  assert.deepEqual(pickMainDocuments([file("r/a.html", 5_000), file("r/b.htm", 4_000)]), ["r/a.html"], "html and htm are one family");
  assert.deepEqual(pickMainDocuments([file("r/report.docx", 5_000), file("other/report.md", 4_000)]), ["r/report.docx"], "another directory is not a rendition");
  assert.deepEqual(pickMainDocuments([file("r/report.docx", 5_000), file("r/table.xlsx", 4_000)]), ["r/report.docx"], "a workbook is not a second rendition of a document");
  assert.deepEqual(pickMainDocuments([file("r/budget.xlsx", 5_000), file("r/budget.md", 1_000)]), ["r/budget.xlsx", "r/budget.md"]);
});

test("an empty file, an unreadable size and a format outside the list are not candidates; nothing eligible is nothing", () => {
  assert.deepEqual(pickMainDocuments([file("r/report.md", 0), file("r/report.txt", 5_000), file("r/data.csv", 5_000), file("r/pic.png", 5_000)]), []);
  assert.deepEqual(pickMainDocuments([{ path: "r/report.md", size: Number.NaN, mtimeMs: T }, { path: "", size: 1, mtimeMs: T }]), []);
  assert.deepEqual(pickMainDocuments([]), []);
  assert.deepEqual(pickMainDocuments(/** @type {any} */ (null)), []);
  assert.deepEqual(pickMainDocuments([file("r/slides.pptx", 1_000), file("r/paper.PDF", 900)]), ["r/slides.pptx", "r/paper.PDF"], "an upper-case extension is read as its format, and presentations count");
});

test("DeepResearch Bench task 65: the report and its Word file, not the five pieces or the scripts", () => {
  const picked = pickMainDocuments([
    file("grain-3d-control/analysis/figures.py", 14_562),
    file("grain-3d-control/analysis/g3d_estim.py", 14_510),
    file("grain-3d-control/analysis/g3d_model.py", 27_262),
    file("grain-3d-control/analysis/run_all.py", 18_101),
    file("grain-3d-control/figures/fig01_architecture.png", 96_898),
    file("grain-3d-control/figures/fig02_plant_bode.png", 75_902),
    file("grain-3d-control/results/results.json", 8_000),
    file("grain-3d-control/report/build.py", 6_000),
    file("grain-3d-control/report/build_values.py", 3_000),
    file("grain-3d-control/report/style_docx.py", 3_000),
    file("grain-3d-control/report/parts/p1.md", 9_000),
    file("grain-3d-control/report/parts/p2.md", 11_000),
    file("grain-3d-control/report/parts/p3.md", 12_000),
    file("grain-3d-control/report/parts/p4.md", 10_000),
    file("grain-3d-control/report/parts/p5.md", 10_000),
    file("grain-3d-control/report/report.md", 52_000),
    file("grain-3d-control/report/Grain_3D_Reconstruction_Control_Design_Report.docx", 380_000),
  ]);
  assert.deepEqual(picked, [
    "grain-3d-control/report/Grain_3D_Reconstruction_Control_Design_Report.docx",
    "grain-3d-control/report/report.md",
  ]);
});
