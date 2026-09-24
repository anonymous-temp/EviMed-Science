// The reporting checklist a declared study type attaches (owner ruling
// 2026-09-24: 「计划阶段先声明研究类型再挂，同时交付物里也放上」).
//
// One fact lives in three places, each for a reason, and this file holds them
// together: the domain's study-type table says which guideline a design is
// written to (the runtime reads it, to tell the writer); the control plane's
// reviewChecklists.json holds the reviewer's condensed items (the run never
// reads them — runtime-can-read-the-gate); and the published item tables the
// writer fills ship with the capability skills. Then the review's use of
// them: the union a package is asked, the schema the editor answers in, the
// message that names the design, and the report an author's checklist must
// never be mistaken for.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_KINDS,
  REPORTING_CHECKLIST_FILE,
  REPORTING_GUIDELINES,
  STUDY_TYPES,
  reportingGuidelineFor,
  reviewEditorSchema,
} from "@evimed/domain";

import { checklistFor, editorMessage, packageReport } from "../src/reviewService.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHECKLISTS = JSON.parse(readFileSync(path.join(repoRoot, "apps/server/src/reviewChecklists.json"), "utf8"));

/** The item numbers of a published table, in order: the second cell of every data row. @param {string} markdown */
function tableItems(markdown) {
  return markdown.split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---") && !line.startsWith("| Section/topic"))
    .map((line) => line.split(" | ").map((cell) => cell.replace(/^\| ?| ?\|$/g, "").trim()));
}

test("every list loads, and every item id is unique and in the shape the editor's answers are read by", () => {
  const ids = [];
  for (const [name, list] of Object.entries(CHECKLISTS.checklists)) {
    assert.ok(String(list.title).trim(), `${name} has no title`);
    assert.ok(String(list.source).trim(), `${name} names no source`);
    assert.ok(Array.isArray(list.items) && list.items.length > 0, `${name} has no items`);
    for (const item of list.items) {
      // `answeredItem` in reviewFindings.mjs reads an answer's id as letters
      // then digits; an id of another shape could never be matched back.
      assert.match(item.id, /^[A-Za-z]{1,4}\d{1,3}$/, `${name}: ${item.id}`);
      assert.match(item.text, /[一-鿿]/, `${name}: ${item.id} is not in the file's language`);
      ids.push(item.id);
    }
  }
  assert.ok(ids.length >= 140, `only ${ids.length} items read — the walk read nothing`);
  assert.equal(new Set(ids).size, ids.length, "two lists share an item id, and a package asked both could not tell them apart");

  for (const [kind, lists] of Object.entries(CHECKLISTS.byContractKind)) {
    assert.ok(CONTRACT_KINDS.includes(/** @type {any} */ (kind)), `byContractKind names ${kind}, which is no contract kind`);
    for (const id of lists) assert.ok(CHECKLISTS.checklists[id], `${kind} names a list ${id} that does not exist`);
  }
  assert.deepEqual(Object.keys(CHECKLISTS.byStudyType), [...STUDY_TYPES], "every study type the plan may declare has a row, even an empty one");
  for (const [type, lists] of Object.entries(CHECKLISTS.byStudyType)) {
    for (const id of lists) assert.ok(CHECKLISTS.checklists[id], `${type} names a list ${id} that does not exist`);
  }
});

test("CONSORT 2025 and TRIPOD+AI are asked one line per numbered item, and say where they were read", () => {
  const consort = CHECKLISTS.checklists["consort-2025"];
  assert.deepEqual(consort.items.map((/** @type {any} */ item) => item.id), Array.from({ length: 30 }, (_, index) => `C${index + 1}`));
  assert.equal(consort.url, "https://doi.org/10.1136/bmj-2024-081123");
  assert.match(consort.source, /BMJ 2025;389:e081123/);
  const tripod = CHECKLISTS.checklists["tripod-ai"];
  assert.deepEqual(tripod.items.map((/** @type {any} */ item) => item.id), Array.from({ length: 27 }, (_, index) => `T${index + 1}`));
  assert.equal(tripod.url, "https://doi.org/10.1136/bmj-2023-078378");
  assert.match(tripod.source, /BMJ 2024;385:e078378/);
});

test("a study type's guideline is the same in the domain, in the reviewer's lists and in the writer's item table", () => {
  /** Rows each published table has: its numbered items with their lettered parts. */
  const rows = { "consort-2025": 42, "tripod-ai": 52, "prisma-2020": 42, "strobe-mr": 44 };
  let compared = 0;
  for (const type of STUDY_TYPES) {
    const guideline = reportingGuidelineFor(type);
    assert.deepEqual(CHECKLISTS.byStudyType[type], guideline ? [guideline.id] : [], `${type}: the reviewer attaches what the domain says it is written to`);
    if (!guideline) continue;
    compared += 1;
    const list = CHECKLISTS.checklists[guideline.id];
    assert.equal(list.url, guideline.url, `${guideline.id}: one guideline, one source`);

    const file = path.join(repoRoot, "capability-skills", guideline.template);
    assert.ok(existsSync(file), `${guideline.id}: the writer is sent to ${guideline.template}, which does not ship`);
    const table = readFileSync(file, "utf8");
    assert.ok(table.startsWith(`# ${guideline.name} — `), `${guideline.id}: the table does not open with the guideline's name`);
    assert.ok(table.includes(guideline.url), `${guideline.id}: the table does not cite where it was published`);
    const items = tableItems(table);
    assert.equal(items.length, rows[/** @type {keyof typeof rows} */ (guideline.id)], `${guideline.id}: ${items.length} rows`);
    for (const cells of items) {
      assert.match(cells[1], /^\d{1,2}[a-g]?$/, `${guideline.id}: "${cells[1]}" is not an item number as printed`);
      assert.equal(cells.at(-1), "", `${guideline.id} ${cells[1]}: the table ships with 报告位置 empty, for the writer to fill`);
    }
    // The reviewer's lines and the published table cover the same numbered
    // items: C18 is CONSORT item 18, parts and all.
    const numbered = [...new Set(items.map((cells) => Number.parseInt(cells[1], 10)))];
    const reviewed = list.items.map((/** @type {any} */ item) => Number.parseInt(item.id.replace(/^[A-Za-z]+/, ""), 10));
    assert.deepEqual(reviewed, numbered, `${guideline.id}: the reviewer's items are not the guideline's numbered items`);
  }
  assert.equal(compared, Object.keys(REPORTING_GUIDELINES).length, "every guideline the domain names was compared");
});

test("a package is asked its contract kind's lists, then its study type's, each list once", () => {
  const ids = (/** @type {string} */ kind, /** @type {string} */ type = "") => checklistFor(kind, type).map((item) => item.id);
  const consort = Array.from({ length: 30 }, (_, index) => `C${index + 1}`);
  assert.deepEqual(ids("manuscript-section"), ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"], "no study type, the lists it always had");
  assert.deepEqual(ids("manuscript-section", "rct"), [...ids("manuscript-section"), ...consort]);
  assert.deepEqual(ids("grant-proposal-package", "rct"), consort, "a proposal designing a trial is asked the trial's list");
  assert.deepEqual(ids("meta-analysis-report", "systematic-review"), ids("meta-analysis-report"), "PRISMA 2020 is not asked twice");
  assert.equal(new Set(ids("meta-analysis-report", "systematic-review")).size, ids("meta-analysis-report").length);
  assert.deepEqual(ids("manuscript-section", "prediction-model").slice(9, 11), ["T1", "T2"]);
  assert.deepEqual(ids("grant-proposal-package", "observational"), [], "a design with no guideline yet adds nothing");
  assert.deepEqual(ids("manuscript-section", "cohort"), ids("manuscript-section"), "a value outside the vocabulary adds nothing (the gateway refuses it first)");
  assert.equal(checklistFor("manuscript-section", "rct").find((item) => item.id === "C18")?.list, "CONSORT 2025");

  // The editor answers in a schema built from exactly these ids.
  const asked = ids("manuscript-section", "rct");
  const schema = /** @type {any} */ (reviewEditorSchema({ checklistIds: asked, acceptanceCount: 10 }));
  assert.deepEqual(schema.properties.checklist.items.properties.item.enum, asked);
  assert.equal(schema.properties.checklist.minItems, 39);
  assert.equal(schema.properties.checklist.maxItems, 39);
});

test("the longest list any package can be asked stays inside the editor's answer budget", () => {
  // The editor answers every item it is asked, one entry each, beside at most
  // REVIEW_EDITOR_FINDINGS_LIMIT (25) findings, in at most 32,000 answer tokens
  // (reviewMaxOutputTokens; its thinking is budgeted apart). An answer is ~20
  // tokens of structure plus a copied sentence of evidence for `present`; at a
  // generous 200 tokens an item, 70 items and 25 findings of ~400 tokens each
  // come to ~24,000. The largest real combination is a meta-analysis report
  // (PRISMA 2020 + SAMPL, 36) — the largest reachable one pairs a contract's
  // lists with a study type it was never meant for, and is bounded here so a
  // new list that would push an answer into truncation fails this first.
  let largest = { size: 0, kind: "", type: "" };
  for (const kind of CONTRACT_KINDS) {
    for (const type of ["", ...STUDY_TYPES]) {
      const size = checklistFor(kind, type).length;
      if (size > largest.size) largest = { size, kind, type };
    }
  }
  assert.ok(largest.size >= 36, `the walk found at most ${largest.size} items — it read nothing`);
  assert.ok(largest.size <= 70, `${largest.kind} + ${largest.type} asks ${largest.size} checklist items`);
});

test("the editor is told the declared design, and asked after an author's checklist only when the package has one", () => {
  /** @param {Record<string, any>} overrides */
  const message = (overrides = {}) => editorMessage({
    contractKind: "manuscript-section", deliverableId: "results", tier: { tier: "L2", safety: true },
    files: new Map([["manuscript-section.md", "## 结果\n共 412 例随机分组。"], [REPORTING_CHECKLIST_FILE, "| Results — Recruitment | 23a | Dates defining … | 结果 › 招募 |"]]),
    claims: [], sources: [], checklist: checklistFor("manuscript-section", "rct"), acceptanceItems: [],
    deterministic: { references: null, referenceFindings: [], numeric: null, stats: [] }, previousFindings: [],
    today: "2026-09-24", studyType: "rct", ...overrides,
  });
  const declared = message();
  assert.match(declared, /^<submission contract="manuscript-section" deliverable="results" tier="L2" clinical="true" study-type="rct">/);
  assert.ok(declared.includes("研究类型：随机对照试验（作者声明），报告规范 CONSORT 2025。"), declared);
  assert.ok(declared.includes(`作者附了填好的报告规范清单（${REPORTING_CHECKLIST_FILE}）`));
  assert.match(declared, /写一条 missing_item 发现，location 写清单里的条目号（如 17a），evidence 逐字复制清单里那一行/);
  assert.ok(declared.indexOf("研究类型") < declared.indexOf("<checklist>"), "the design is named before the items it explains");
  assert.ok(declared.includes("C18（CONSORT 2025）"), "the trial's items are in the checklist the editor answers");

  const noFile = message({ files: new Map([["manuscript-section.md", "## 结果"]]) });
  assert.ok(noFile.includes("研究类型：随机对照试验"));
  assert.equal(noFile.includes("作者附了"), false, "no checklist in the package, nothing to hold it to");

  const noGuideline = message({ studyType: "observational", checklist: checklistFor("manuscript-section", "observational") });
  assert.ok(noGuideline.includes("研究类型：观察性研究（作者声明）。"), noGuideline);

  const undeclared = message({ studyType: "", files: new Map([["manuscript-section.md", "## 结果"]]), checklist: checklistFor("manuscript-section") });
  assert.equal(/研究类型|study-type/.test(undeclared), false, "a package that declares nothing reads as it always did");
});

test("an author's checklist is never read as the report its references are parsed from", () => {
  const checklist = "| Other information — Registration | 24a | Provide registration information … | 其他信息 › 注册 |";
  assert.equal(packageReport(new Map([
    ["manuscript-section.md", "## 结果\n正文 [1]。\n\n## 参考文献\n1. A trial. doi:10.1000/x"],
    [REPORTING_CHECKLIST_FILE, checklist],
  ])), "## 结果\n正文 [1]。\n\n## 参考文献\n1. A trial. doi:10.1000/x", "its name matches `report`; it is set aside by name");
  assert.equal(packageReport(new Map([
    [REPORTING_CHECKLIST_FILE, checklist],
    ["specific-aims.md", "# 具体目标"],
    ["proposal-outline.md", "# 研究方案"],
  ])), "# 具体目标", "first in the package, it is still not the first document");
  assert.equal(packageReport(new Map([["clinical-evidence-report.md", "# 报告"], ["clinical-evidence-matrix.json", "{}"]])), "# 报告");
  assert.equal(packageReport(new Map([[REPORTING_CHECKLIST_FILE, checklist]])), "", "a package of nothing but the checklist has no report");
});
