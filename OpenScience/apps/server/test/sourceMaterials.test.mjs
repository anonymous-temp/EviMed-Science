import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveMarkdownStructure, materialRowPage, materialTableValues } from "@evimed/domain";
import { HttpError } from "../src/security.mjs";
import { createSourceMaterials, materialsRecords, materialsRecordIds } from "../src/sourceMaterials.mjs";
import { localIntakeController, pythonCan, writeMaterialFixtures } from "./helpers/vcrIntakeLocal.mjs";

const fixtureText = name => readFileSync(new URL(`../../../packages/domain/test/fixtures/materials/${name}`, import.meta.url), "utf8");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const PARSER = "evimed-extract@0.5.0";
const python = pythonCan("pypdf", "openpyxl");

/** A PDF text layer is Latin-1 here: the rows' dashes and minus signs become ASCII, which the page match ignores either way. */
const ascii = text => text.replaceAll("−", "-").replaceAll("–", "-").replaceAll("±", "+/-");
/** @param {any} table */
function rowLines(table) {
  const rows = new Map();
  for (const cell of table.cells) rows.set(cell.r, [...(rows.get(cell.r) ?? []), cell]);
  return [...rows.values()].map(cells => ascii(cells.sort((a, b) => a.c - b.c).map(cell => cell.t).join(" ")));
}

async function world(t, extra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "materials-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { dataDir: path.join(root, "data"), runtimeContainerBin: "docker", runtimeContainerImage: "open-science-runtime:test", runtimeContainerUser: "1000:1000",
    runtimeDataVolume: "", vcrIntakeMemory: "768m", vcrIntakeTimeoutMs: 60_000, vcrIntakeMaxBytes: 25 * 1024 * 1024, sourceMaterialsEnabled: true, ...extra };
  await fs.mkdir(config.dataDir, { recursive: true });
  const calls = [];
  const reports = [];
  const controller = localIntakeController(config, { calls });
  const materials = createSourceMaterials({ config, controller, report: code => reports.push(code), now: () => new Date("2026-10-04T10:00:00.000Z") });
  return { root, config, calls, reports, controller, materials };
}

test("a PDF's tables are located on the pages its own text layer holds them, with the extraction version and the source hash in the ledger", { skip: !python }, async t => {
  const w = await world(t);
  const text = fixtureText("clinical-table.md");
  const structure = deriveMarkdownStructure({ text });
  const [baseline, outcomes] = structure.tables;
  const files = await writeMaterialFixtures(w.root, { pdfs: { "paper.pdf": [
    ["SAMPLE-1 trial", "Table 2. Baseline characteristics of the study population", ...rowLines(baseline)],
    ["Table 3. Primary and secondary outcomes at week 24", ...rowLines(outcomes).slice(0, -1)],
    [],
  ] } });
  const bytes = await fs.readFile(files["paper.pdf"]);
  const result = await w.materials.extract({ text, file: files["paper.pdf"], name: "paper.pdf", sha256: sha(bytes), parserRevision: PARSER });

  const { coverage } = result;
  assert.equal(coverage.status, "partial", "unextracted cells make an extraction partial, never failed");
  assert.equal(coverage.extraction.materials, "evimed-materials@1");
  assert.equal(coverage.extraction.parser, PARSER);
  assert.match(coverage.extraction.locator, /^evimed-source-material-extract@1\.0\.0 \(pypdf \d/);
  assert.equal(coverage.sourceSha256, sha(bytes));
  assert.equal(coverage.textSha256, sha(structure.text));
  assert.deepEqual(coverage.pages, { status: "mapped", pageCount: 3, textLayerPages: 2, noTextLayerPages: [3] });
  assert.equal(coverage.values.total, coverage.values.located + coverage.values.ambiguous + coverage.values.unlocated + coverage.values.unextracted + coverage.values.failed);
  assert.ok(coverage.values.located > 20, JSON.stringify(coverage.values));
  assert.equal(coverage.values.unextracted, 1, "the 1.1.2 cell");
  // The last row of Table 3 is on no page with a text layer, and one page has none: unknown, for that reason, and counted unlocated.
  assert.ok(coverage.values.unlocated > 0);
  const [first, second] = result.tables;
  assert.deepEqual(first.page, { status: "located", pages: [1], basis: "rows" });
  assert.deepEqual(second.page, { status: "located", pages: [2], basis: "rows" });
  assert.deepEqual(materialRowPage(second, 6), { status: "unknown", reason: "no_text_layer" });
  assert.deepEqual(materialRowPage(first, 3), { status: "located", pages: [1], basis: "row_text" });
  // Every located value resolves to its exact characters in the capture and to a page.
  for (const table of result.tables) {
    for (const cell of materialTableValues(table)) {
      assert.equal(structure.text.slice(cell.s, cell.e), cell.t);
      const page = materialRowPage(table, cell.r);
      assert.ok(["located", "unknown"].includes(page.status));
    }
  }
  // The container ran once, over one staged copy, and left nothing behind.
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].kind, "materials");
  assert.deepEqual(w.calls[0].files.sort(), ["document.pdf", "request.json"]);
  assert.deepEqual(await fs.readdir(path.join(w.config.dataDir, "vcr-intake", "materials")), []);
  assert.deepEqual(w.reports, []);
});

test("the records of a structure are a summary and one record per table, each inside the product ledger's bound", { skip: !python }, async t => {
  const w = await world(t);
  const result = await w.materials.extract({ text: fixtureText("clinical-table.md"), name: "paper.md", sha256: "a".repeat(64), parserRevision: PARSER });
  const records = materialsRecords(result, { sourceId: "src_0123456789abcdef0123456789abcdef", generation: 2 });
  const ids = materialsRecordIds("src_0123456789abcdef0123456789abcdef", 2);
  assert.deepEqual(records.map(record => record.id), [ids.summary, ids.table("tbl-1"), ids.table("tbl-2")]);
  assert.equal(records[0].payload.recordType, "source-structure");
  assert.equal(records[1].payload.recordType, "source-table");
  assert.equal(records[1].payload.textSha256, result.coverage.textSha256);
  assert.deepEqual(result.structure.tables.map(table => table.values.total), result.tables.map(table => materialTableValues(table).length + table.unextracted));
  for (const record of records) assert.ok(Buffer.byteLength(JSON.stringify(record.payload)) < 256 * 1024, record.id);
  // A text file is located by its tables' place in the text: values are located, there are no pages to give.
  assert.equal(result.coverage.pagination, "flow");
  assert.equal(result.coverage.values.unlocated, 0);
  assert.equal(result.coverage.pages.status, "not_paginated");
});

test("a table too large for one record loses its last cells to the bound, and says so in the ledger", async t => {
  const w = await world(t);
  const wide = Array.from({ length: 300 }, (_, index) => `| row ${index} | ${"x".repeat(900)} ${index} | ${index} |`).join("\n");
  const result = await w.materials.extract({ text: `| h | a | b |\n| - | - | - |\n${wide}\n`, name: "wide.md", sha256: "b".repeat(64), parserRevision: PARSER });
  const [table] = result.tables;
  assert.ok(Buffer.byteLength(JSON.stringify(table)) <= 230_000);
  assert.equal(table.truncated.reason, "record_size");
  assert.ok(table.cells.length < 900);
  assert.ok(result.coverage.values.unextracted > 0, "the values the bound dropped are counted, not lost");
  assert.equal(result.coverage.status, "partial");
});

test("past the total a source's tables may take, the rest are counted unextracted and the ledger says the table limit was reached", async t => {
  const w = await world(t);
  const text = fixtureText("clinical-table.md");
  const whole = await w.materials.extract({ text, name: "paper.md", sha256: "a".repeat(64), parserRevision: PARSER });
  // A limit that holds the first table and not the second.
  const small = createSourceMaterials({ config: w.config, tablesTotalLimit: Buffer.byteLength(JSON.stringify(whole.tables[0])) + 200 });
  const result = await small.extract({ text, name: "paper.md", sha256: "a".repeat(64), parserRevision: PARSER });
  assert.equal(result.tables.length, 1, "the first table fit; the second did not");
  assert.equal(result.coverage.tables.structured, 1);
  assert.equal(result.coverage.tables.unextracted, 1);
  assert.ok(result.coverage.reasons.includes("table_limit"));
  assert.equal(result.coverage.status, "partial");
  const overflow = result.structure.tables[1];
  assert.deepEqual([overflow.status, overflow.reason], ["unextracted", "table_limit"]);
  assert.ok(overflow.values.unextracted > 0, "its values are counted, not lost");
  assert.equal(result.coverage.values.total, result.structure.tables.reduce((total, table) => total + table.values.total, 0));
});

test("a scanned PDF has no text layer: its tables are the parser's OCR reading, every value is unlocated, and the ledger says so", { skip: !python }, async t => {
  const w = await world(t);
  const files = await writeMaterialFixtures(w.root, { pdfs: { "scan.pdf": [[], []] } });
  const bytes = await fs.readFile(files["scan.pdf"]);
  const result = await w.materials.extract({ text: fixtureText("scanned-page.md"), file: files["scan.pdf"], name: "scan.pdf", sha256: sha(bytes), parserRevision: PARSER });
  assert.equal(result.coverage.pages.status, "no_text_layer");
  assert.equal(result.coverage.origin, "ocr");
  assert.equal(result.coverage.uncertainty, "unknown");
  assert.equal(result.coverage.values.located, 0);
  assert.equal(result.coverage.values.unlocated, result.coverage.values.total - result.coverage.values.unextracted);
  assert.equal(result.coverage.values.unextracted, 1, "28.O");
  assert.ok(result.coverage.reasons.includes("scanned_or_image_source"));
  assert.equal(result.tables[0].page.reason, "no_text_layer");
  assert.equal(result.structure.uncertainty, "unknown");
});

test("a table continued over a page is one ambiguous continuation, and its rows are still on their own pages", { skip: !python }, async t => {
  const w = await world(t);
  const text = fixtureText("continued-table.md");
  const structure = deriveMarkdownStructure({ text });
  const [first, second] = structure.tables;
  const files = await writeMaterialFixtures(w.root, { pdfs: { "continued.pdf": [
    ["Table 4. Subgroup analysis of the primary outcome", ...rowLines(first)],
    [...rowLines(second)],
  ] } });
  const result = await w.materials.extract({ text, file: files["continued.pdf"], name: "continued.pdf", sha256: sha(await fs.readFile(files["continued.pdf"])), parserRevision: PARSER });
  assert.equal(result.coverage.tables.continued, 2);
  assert.equal(result.coverage.tables.continuedAmbiguous, 1, "same header: ambiguous; the document's own (continued): stated");
  const [one, two] = result.tables;
  assert.deepEqual(two.continuation, { prior: "tbl-1", basis: "same_header", certainty: "ambiguous" });
  // The header row appears on both pages: ambiguous, never resolved by order. Every body row is on exactly one page.
  assert.deepEqual(materialRowPage(one, 1), { status: "ambiguous", candidates: [1, 2], basis: "row_text" });
  assert.deepEqual(materialRowPage(one, 2), { status: "located", pages: [1], basis: "row_text" });
  assert.deepEqual(materialRowPage(two, 2), { status: "located", pages: [2], basis: "row_text" });
  assert.equal(result.coverage.tables.unextracted, 1, "the HTML table");
});

test("a spreadsheet's cells are read in the container and keep their sheet addresses; a formula nobody computed has no value", { skip: !python }, async t => {
  const w = await world(t);
  const files = await writeMaterialFixtures(w.root, { workbooks: { "supplement.xlsx": { sheets: [
    { name: "Table S2", cells: { A1: "Arm", B1: "Events, n (%)", C1: "Rate, %", A2: "Drug", B2: "12 (40.0)", C2: 0.4, A3: "Placebo", B3: "9 (30.0)", C3: "=B3/B2" }, merges: ["A5:C5"] },
    { name: "Hidden", state: "hidden", cells: { A1: "x" } },
  ] } } });
  const bytes = await fs.readFile(files["supplement.xlsx"]);
  const result = await w.materials.extract({ text: "(the parser's flattening of the workbook)", file: files["supplement.xlsx"], name: "supplement.xlsx", sha256: sha(bytes), parserRevision: PARSER });
  assert.equal(result.coverage.pagination, "sheet");
  assert.equal(result.coverage.pages.status, "not_paginated");
  assert.equal(result.coverage.tables.structured, 2);
  const [sheet, hidden] = result.tables;
  assert.equal(sheet.kind, "sheet");
  assert.equal(sheet.name, "Table S2");
  assert.deepEqual(sheet.merges, ["A5:C5"]);
  assert.equal(sheet.cells.find(cell => cell.a === "B2").v.kind, "count_percent");
  assert.equal(sheet.cells.find(cell => cell.a === "C2").v.numberFormat, undefined);
  const formula = sheet.cells.find(cell => cell.a === "C3");
  assert.equal(formula.formula, "=B3/B2");
  assert.equal(formula.v, undefined);
  assert.equal(hidden.sheetState, "hidden");
  // A sheet address is an exact location: its values are located.
  assert.equal(result.coverage.values.located, result.coverage.values.total);
  assert.match(result.coverage.extraction.locator, /^evimed-source-material-extract@/);
});

test("a delimited file is located by row and column, with no container at all", async t => {
  const w = await world(t, {});
  const noController = createSourceMaterials({ config: w.config, controller: null, now: () => new Date("2026-10-04T10:00:00.000Z") });
  const result = await noController.extract({ text: fixtureText("supplement.csv"), name: "supplement.csv", sha256: "c".repeat(64), parserRevision: "plain-text@1.0.0" });
  assert.equal(result.coverage.pagination, "delimited");
  assert.equal(result.coverage.values.located, result.coverage.values.total);
  assert.equal(result.tables[0].kind, "delimited");
  assert.equal(result.coverage.status, "extracted");
});

test("without a controller a PDF's values stay unlocated and the ledger says why; a Word file has no page source at all", async t => {
  const w = await world(t);
  const bare = createSourceMaterials({ config: w.config, controller: null });
  const text = fixtureText("clinical-table.md");
  const noPages = await bare.extract({ text, file: "/data/paper.pdf", name: "paper.pdf", sha256: "d".repeat(64), parserRevision: PARSER });
  assert.deepEqual(noPages.coverage.pages, { status: "unavailable", reason: "locator_unavailable" });
  assert.equal(noPages.coverage.values.located, 0);
  assert.ok(noPages.coverage.values.unlocated > 20);
  assert.equal(noPages.tables.length, 2, "the structure is still derived");
  const word = await bare.extract({ text, file: "/data/paper.docx", name: "paper.docx", sha256: "d".repeat(64), parserRevision: PARSER });
  assert.deepEqual(word.coverage.pages, { status: "unavailable", reason: "format_without_page_source" });
  assert.equal(word.coverage.values.located, 0);
});

test("a container that fails, is busy or answers nonsense leaves the document ingested and says so in the ledger", { skip: !python }, async t => {
  const w = await world(t);
  const text = fixtureText("clinical-table.md");
  const files = await writeMaterialFixtures(w.root, { pdfs: { "paper.pdf": [["x"]] } });
  const sha256 = sha(await fs.readFile(files["paper.pdf"]));
  /** @param {any} error */
  const failing = error => createSourceMaterials({ config: w.config, controller: { runVcrIntake: async () => { throw error; } }, report: code => w.reports.push(code) });
  const busy = await failing(new HttpError(429, "vcr_intake_busy", "busy")).extract({ text, file: files["paper.pdf"], name: "paper.pdf", sha256, parserRevision: PARSER });
  assert.deepEqual(busy.coverage.pages, { status: "failed", reason: "locator_unavailable" });
  assert.equal(busy.coverage.status, "partial");
  assert.equal(busy.tables.length, 2);
  const broken = await failing(new Error("the container exploded: secret patient name")).extract({ text, file: files["paper.pdf"], name: "paper.pdf", sha256, parserRevision: PARSER });
  assert.deepEqual(broken.coverage.pages, { status: "failed", reason: "locator_failed" });
  assert.ok(!JSON.stringify(broken).includes("secret patient name"), "an error message never reaches the ledger");
  assert.deepEqual(w.reports, ["vcr_intake_busy", "source_materials_measure_failed"]);
  // A refusal the script names is a page-less PDF with the reason, not an error.
  const refused = createSourceMaterials({ config: w.config, controller: { runVcrIntake: async (kind, reference) => {
    const dir = path.join(w.config.dataDir, "vcr-intake", "materials", reference.attemptId, "output");
    await fs.writeFile(path.join(dir, "result.json"), JSON.stringify({ protocol: 1, outcome: "refused", reason: "too_many_pages" }));
    return { finished: true };
  } } });
  const tooMany = await refused.extract({ text, file: files["paper.pdf"], name: "paper.pdf", sha256, parserRevision: PARSER });
  assert.deepEqual(tooMany.coverage.pages, { status: "unavailable", reason: "source_too_large" });
});

test("a file that is not the one that was registered never reaches a container", { skip: !python }, async t => {
  const w = await world(t);
  const files = await writeMaterialFixtures(w.root, { pdfs: { "paper.pdf": [["x"]] } });
  const result = await w.materials.extract({ text: fixtureText("clinical-table.md"), file: files["paper.pdf"], name: "paper.pdf", sha256: "0".repeat(64), parserRevision: PARSER });
  assert.deepEqual(result.coverage.pages, { status: "failed", reason: "locator_failed" });
  assert.equal(w.calls.length, 0, "the staged copy was refused before a container started");
  assert.deepEqual(await fs.readdir(path.join(w.config.dataDir, "vcr-intake", "materials")), [], "and nothing was left staged");
});

test("a PDF over the intake ceiling is not staged; a source with no tables asks for no container", { skip: !python }, async t => {
  const w = await world(t, { vcrIntakeMaxBytes: 1024 * 1024 });
  const files = await writeMaterialFixtures(w.root, { pdfs: { "paper.pdf": [["x"]] } });
  await fs.truncate(files["paper.pdf"], 11 * 1024 * 1024);
  const big = await w.materials.extract({ text: fixtureText("clinical-table.md"), file: files["paper.pdf"], name: "paper.pdf", sha256: "e".repeat(64), parserRevision: PARSER });
  assert.deepEqual(big.coverage.pages, { status: "unavailable", reason: "source_too_large" });
  assert.equal(w.calls.length, 0);
  const prose = await w.materials.extract({ text: "A paragraph of prose with no table in it.", file: files["paper.pdf"], name: "paper.pdf", sha256: "e".repeat(64), parserRevision: PARSER });
  assert.equal(w.calls.length, 0);
  assert.equal(prose.coverage.status, "extracted");
  assert.deepEqual(prose.coverage.tables, { total: 0, structured: 0, unextracted: 0, failed: 0, continued: 0, continuedAmbiguous: 0 });
  assert.deepEqual(prose.coverage.pages, { status: "unavailable", reason: "not_requested" });
});

test("a switched-off, empty or non-document source is a ledger that says none was attempted, never an error", async t => {
  const off = createSourceMaterials({ config: { sourceMaterialsEnabled: false } });
  assert.equal((await off.extract({ text: "| a |\n| - |\n| 1 |", name: "x.md", sha256: "a".repeat(64), parserRevision: PARSER })).coverage.unavailable, "materials_disabled");
  const w = await world(t);
  assert.equal((await w.materials.extract({ text: "  \n", name: "x.pdf", sha256: "a".repeat(64), parserRevision: PARSER })).coverage.unavailable, "no_text");
  const config = await w.materials.extract({ text: "{\"a\": 1}", name: "settings.json", sha256: "a".repeat(64), parserRevision: PARSER });
  assert.equal(config.coverage.unavailable, "not_a_document_format");
  assert.equal(config.structure, null);
  assert.equal(config.coverage.status, "unavailable");
  assert.deepEqual(config.tables, []);
});

test("the caller's own cancellation stops the extraction instead of becoming a ledger entry", { skip: !python }, async t => {
  const w = await world(t);
  const files = await writeMaterialFixtures(w.root, { pdfs: { "paper.pdf": [["x"]] } });
  const abort = new AbortController();
  const canceling = createSourceMaterials({ config: w.config, controller: { runVcrIntake: async () => { abort.abort(); throw new DOMException("Intake canceled.", "AbortError"); } } });
  await assert.rejects(canceling.extract({ text: fixtureText("clinical-table.md"), file: files["paper.pdf"], name: "paper.pdf", sha256: sha(await fs.readFile(files["paper.pdf"])), parserRevision: PARSER, signal: abort.signal }), { name: "AbortError" });
});
