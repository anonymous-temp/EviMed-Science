// The virtual lab in the exported Word and PDF package (round 2, R14): a study with a comparison and a design search prints the laboratory
// section, every number of it rendered from the frozen report model by reference (never typed), and the files are read back.
//
// The Word and PDF are made by the real renderer (`runtime/skills/office/shared/render_document.py`, Pandoc and Chromium) and read with
// python-docx and pypdf, the way the renderer's own tests read them; where the renderer's tools are absent the file checks skip and the
// markdown ones still run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalVcrDocument } from "../src/vcrDocumentExport.mjs";
import { labDocumentRoot, labSectionTemplate, renderLabSection } from "../src/vcrLabReport.mjs";
import { vcrReportModel } from "../src/vcrRender.mjs";
import { typedNumberSpans } from "@evimed/domain";

const measure = (name, value, mcse, unit = "%") => ({ name, label: name, value, mcse, unit, simulated: true, source: "synthetic", precision: 1 });
const PREMISE = { key: "lab:aligned", label: "比较的前提", value: "各组用同一个终点和同一套分析设置。", source: "given", decisive: true };
/** The two kinds of entry `VcrExperiments.reportBlock` writes: a comparison of designs and a finished design search. */
const lab = [
  { id: "exp_1", kind: "experiment", experimentKind: "design", question: "每组 100 人和每组 140 人哪个把握更大", purpose: "compare", status: "complete",
    arms: [{ name: "每组 100", status: "complete", design: { design: { nTreat: 100 } } }, { name: "每组 140", status: "complete", design: { design: { nTreat: 140 } } }],
    comparison: [{ measure: "power", label: "功效", arms: [
      { name: "每组 100", status: "complete", value: measure("power", 71.2, 0.31) }, { name: "每组 140", status: "complete", value: measure("power", 86.7, 0.24) }],
    contrasts: [{ arm: "每组 140", against: "每组 100", coupling: "paired", couplingText: "两个方案用同一批随机数，差值的误差比各自的误差小。", difference: measure("power", 15.5, 0.12) }] }],
    incomplete: [], alignment: [], premises: [PREMISE], createdAt: "2026-11-09T00:00:00Z" },
  { id: "cmp_1", kind: "campaign", question: "达到 80% 功效的最小样本量", method: "design.simulate", status: "stopped",
    stop: { reason: "converged", text: "搜索已经停下：候选里已经找出了满足全部约束的最小方案。" },
    objective: { measure: "expected_sample_size", direction: "minimize", truth: "alternative", label: "期望样本量" },
    constraints: [{ measure: "power", label: "功效", op: ">=", bound: 0.8, kind: "design" }, { measure: "type_one_error", label: "I 类错误", op: "<=", bound: 0.025, kind: "error_control" }],
    best: { index: 2, design: { "design.nTreat": 140, "analysis.alpha": 0.025 }, objective: measure("expected_sample_size", 280, 0, null) },
    undecided: null,
    finalists: [
      { index: 2, design: { "design.nTreat": 140, "analysis.alpha": 0.025 }, status: "final", objective: measure("expected_sample_size", 280, 0, null),
        constraints: [{ measure: "power", label: "功效", op: ">=", bound: 0.8, verdict: { statusText: "满足" } }, { measure: "type_one_error", label: "I 类错误", op: "<=", bound: 0.025, verdict: { statusText: "满足" } }], resultIds: [] },
      { index: 14, design: { "design.nTreat": 180, "analysis.alpha": 0.02 }, status: "final", objective: measure("expected_sample_size", 360, 0, null),
        constraints: [{ measure: "power", label: "功效", op: ">=", bound: 0.8, verdict: { statusText: "满足" } }, { measure: "type_one_error", label: "I 类错误", op: "<=", bound: 0.025, verdict: { statusText: "满足" } }], resultIds: [] }],
    budget: {}, premises: [{ key: "alpha", label: "第一类错误", value: "约束固定为 2.5%，搜索中不能放宽。", source: "given", decisive: true }], createdAt: "2026-11-09T00:00:00Z" },
];
const study = { id: "std_1", name: "EV-301", question: "", dataTier: "T0", intendedUse: "exploratory" };
const model = { ...vcrReportModel({ study, results: [] }), lab };
const document = () => canonicalVcrDocument(study, { kind: "study_package", cover: { results: model, reports: [{ section: "main", template: "方法见下。" }] } });

test("the section prints each comparison and design search with every number rendered from the frozen block", () => {
  const section = renderLabSection(model);
  assert.deepEqual(section.issues, [], "every reference resolved");
  const text = section.markdown;
  assert.match(text, /^## 虚拟实验室/);
  assert.match(text, /### 方案比较：每组 100 人和每组 140 人哪个把握更大/, "the researcher's own words keep their numbers");
  assert.match(text, /\| 功效 \| 71\.2%（模拟误差 ±0\.3%） \| 86\.7%（模拟误差 ±0\.2%） \|/);
  assert.match(text, /差值 15\.5%（模拟误差 ±0\.1%）/);
  assert.match(text, /### 设计搜索：达到 80% 功效的最小样本量/);
  assert.match(text, /功效不低于80\.0%；I 类错误不高于2\.5%/, "a bound is the frozen constraint, shown in the measure's unit");
  assert.match(text, /最优设计：试验组人数 140，检验水准 0\.025；期望样本量 280/);
  assert.match(text, /\| 14 \| 试验组人数 180，检验水准 0\.020 \| 360 \|/);
  assert.match(text, /这些结论的前提：\n\n- 比较的前提：各组用同一个终点和同一套分析设置。/);
  for (const word of ["design.nTreat", "analysis.alpha", "labDoc", "TEXT_", "LAB_PREMISES"]) assert.ok(!text.includes(word), `back-office word ${word}`);
});

test("no number of the section is typed: its template holds none, and changing the frozen value changes the printed one", () => {
  const { template } = labSectionTemplate(labDocumentRoot(lab));
  assert.deepEqual(typedNumberSpans(template.replace(/\{\{n:[^}]*\}\}/g, " ")), [], "every digit of the template is inside a reference");
  const changed = structuredClone(model);
  changed.lab[0].comparison[0].arms[0].value.value = 55.5;
  changed.lab[1].best.design["design.nTreat"] = 150;
  const text = renderLabSection(changed).markdown;
  assert.match(text, /55\.5%（模拟误差 ±0\.3%）/);
  assert.match(text, /最优设计：试验组人数 150/);
  assert.equal(renderLabSection({ ...model, lab: [] }), null, "a study with no lab work has no section, and no other export changes");
});

test("the package document carries the section after the run's own words, and a package of a study with no lab work is unchanged", () => {
  const withLab = document();
  assert.ok(withLab.canonicalMarkdown.indexOf("方法见下。") < withLab.canonicalMarkdown.indexOf("## 虚拟实验室"));
  const plain = canonicalVcrDocument(study, { kind: "study_package", cover: { results: { ...model, lab: undefined }, reports: [{ section: "main", template: "方法见下。" }] } });
  assert.ok(!plain.canonicalMarkdown.includes("虚拟实验室"));
  assert.notEqual(withLab.revision, plain.revision, "the frozen model with a lab block is another revision");
});

const read = `
import sys, json, zipfile
from docx import Document
from pypdf import PdfReader
out = sys.argv[1]
doc = Document(out + "/document.docx")
words = [p.text for p in doc.paragraphs] + [c.text for t in doc.tables for r in t.rows for c in r.cells]
pdf = "".join(page.extract_text() for page in PdfReader(out + "/document.pdf").pages)
print(json.dumps({"docx": "\\n".join(words), "pdf": pdf, "tables": len(doc.tables)}))
`;

test("the exported Word and PDF files contain the laboratory section, read back from the files", (t) => {
  const tools = spawnSync("sh", ["-c", "command -v pandoc && command -v google-chrome"], { encoding: "utf8" });
  const libraries = spawnSync("python3", ["-c", "import docx, pypdf"], { encoding: "utf8" });
  if (tools.status !== 0 || libraries.status !== 0) return t.skip("pandoc, Chrome, python-docx or pypdf is absent");
  const directory = mkdtempSync(join(tmpdir(), "vcr-lab-doc-"));
  try {
    const { title, canonicalMarkdown, revision } = document();
    writeFileSync(join(directory, "document.json"), JSON.stringify({ version: 1, rendererVersion: "pandoc-chromium-v1", sourceDigest: revision, title, canonicalMarkdown, assets: [], formats: ["docx", "pdf"] }));
    const renderer = new URL("../../../runtime/skills/office/shared/render_document.py", import.meta.url).pathname;
    const made = spawnSync("python3", [renderer, "--input", join(directory, "document.json"), "--output-dir", join(directory, "out")], { encoding: "utf8", timeout: 240_000 });
    assert.equal(made.status, 0, made.stderr);
    const files = spawnSync("python3", ["-c", read, join(directory, "out")], { encoding: "utf8" });
    assert.equal(files.status, 0, files.stderr);
    const { docx, pdf, tables } = JSON.parse(files.stdout);
    assert.ok(tables >= 2, "the comparison and the finalists are tables in the Word file");
    for (const [name, text] of [["docx", docx], ["pdf", pdf.normalize("NFKC")]]) {
      for (const expected of ["虚拟实验室", "方案比较", "71.2%", "86.7%", "设计搜索", "试验组人数 140", "期望样本量", "各组用同一个终点和同一套分析设置"]) assert.ok(text.includes(expected), `${name}: ${expected}`);
      assert.ok(!text.includes("未计算"), `${name}: nothing is left unbound`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
