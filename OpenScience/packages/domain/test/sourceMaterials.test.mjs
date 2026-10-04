import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  deriveDelimitedStructure,
  deriveMarkdownStructure,
  deriveSheetStructure,
  locateQuoteInText,
  locateUnitsOnPages,
  materialAddress,
  materialAddressParts,
  materialCaptureText,
  materialRowPage,
  materialSkeleton,
  materialTableCounts,
  materialTableValues,
  normalizeSourceText,
  parseMaterialCell,
  sourceMaterialsCoverage,
  sourceMaterialsCoverageIssues,
  sourceMaterialsPagination,
} from "../index.mjs";
import { quoteIsPresent } from "../src/clinicalEvidence.mjs";

/** @param {string} name */
const fixture = (name) => readFileSync(new URL(`./fixtures/materials/${name}`, import.meta.url), "utf8");

const clinical = deriveMarkdownStructure({ text: fixture("clinical-table.md") });
/** @param {any[]} tables @param {string} id */
const table = (tables, id) => tables.find((entry) => entry.id === id);
/** @param {any} entry @param {number} r @param {number} c */
const cellAt = (entry, r, c) => entry.cells.find((cell) => cell.r === r && cell.c === c);

test("every cell of a parsed table resolves to its exact characters in the captured text", () => {
  const raw = fixture("clinical-table.md");
  // The capture folds line endings and drops a BOM; offsets are into that text, and the two agree.
  const crlf = `\uFEFF${raw.replaceAll("\n", "\r\n")}`;
  assert.equal(materialCaptureText(crlf), normalizeSourceText({ sourceId: "s", generation: 1, docType: "published-paper", depth: "index_only", text: crlf }).text);
  const shifted = deriveMarkdownStructure({ text: crlf });
  assert.deepEqual(shifted.tables.map((entry) => entry.cells.length), clinical.tables.map((entry) => entry.cells.length));
  let checked = 0;
  for (const found of shifted.tables.filter((entry) => entry.status === "structured")) {
    for (const cell of found.cells) {
      assert.equal(shifted.text.slice(cell.s, cell.e), cell.t, `${found.id} r${cell.r}c${cell.c}`);
      checked += 1;
    }
    // The table's own span starts at its header row and ends with its last row.
    assert.ok(shifted.text.slice(found.start, found.end).startsWith("|"));
  }
  assert.ok(checked >= 60, `only ${checked} cells were checked`);
});

test("a clinical table keeps its caption, header, spans and what Markdown cannot say as unknown", () => {
  const baseline = table(clinical.tables, "tbl-1");
  assert.equal(baseline.status, "structured");
  assert.equal(baseline.caption.label, "Table 2");
  assert.equal(baseline.caption.placement, "before");
  assert.equal(baseline.rows, 9, "the header row is row 1");
  assert.equal(baseline.columns, 4);
  assert.deepEqual(baseline.header.map((cell) => cell.t), ["Characteristic", "Placebo (n=120)", "Study drug (n=118)", "P value"]);
  // Markdown has no merged cells and one header row; both are said to be unknown rather than assumed.
  assert.equal(baseline.spans, "unknown");
  assert.equal(baseline.headerLevels, "unknown");
  assert.equal(baseline.labelColumn, 1);
  assert.equal(table(clinical.tables, "tbl-2").caption.label, "Table 3");
});

test("unit, denominator, timepoint and statistic are read from the header and the row label, by closed vocabularies", () => {
  const baseline = table(clinical.tables, "tbl-1");
  assert.deepEqual(cellAt(baseline, 2, 2).v, { kind: "mean_sd", mean: 61.2, sd: 9.8, unit: "years" });
  // `n (%)` in the row label and N in the column header: the count, its percentage and the arithmetic against N.
  assert.deepEqual(cellAt(baseline, 3, 2).v, { kind: "count_percent", n: 72, percent: 60, percentCheck: { computed: 60, consistent: true }, denominator: { n: 120, basis: "header" } });
  assert.equal(cellAt(baseline, 3, 3).v.denominator.n, 118);
  // n/N (%) carries its own denominator.
  assert.deepEqual(cellAt(baseline, 6, 2).v.denominator, { n: 120, basis: "cell" });
  assert.equal(cellAt(baseline, 6, 3).v.percentCheck.consistent, true);
  // A percentage that is not the count's share is recorded as such, not corrected.
  assert.equal(cellAt(baseline, 8, 2).v.percentCheck.consistent, false);
  assert.equal(cellAt(baseline, 8, 2).v.percentCheck.computed, 25);
  // The unit a row states is the unit of its measurements; "n (%)" is not a unit.
  assert.equal(cellAt(baseline, 7, 2).v.unit, "%");
  assert.equal(cellAt(baseline, 3, 2).v.unit, undefined);
  assert.equal(cellAt(baseline, 5, 2).v.unit, "y");
  // A row label that is itself a timepoint is the timepoint of its cells.
  assert.deepEqual(cellAt(baseline, 9, 2).v.timepoint, { unit: "week", n: 12 });
  // A p-value column is read as p-values, including a bound.
  assert.deepEqual(cellAt(baseline, 9, 4).v, { kind: "p_value", operator: "<", p: 0.001, timepoint: { unit: "week", n: 12 } });
  // The row label column is a label, never a value.
  assert.equal(cellAt(baseline, 2, 1).v, undefined);
  // An interval column carries its level from its header, and no unit it does not state.
  const outcomes = table(clinical.tables, "tbl-2");
  assert.deepEqual(cellAt(outcomes, 2, 4).v, { kind: "estimate_interval", estimate: 0.52, lower: 0.31, upper: 0.88, level: 95 });
});

test("a footnote marker is linked to its note by the cells that carry it, and an unlinked note is counted", () => {
  const baseline = table(clinical.tables, "tbl-1");
  const linked = baseline.footnotes.find((note) => note.marker === "a");
  assert.deepEqual(linked.cells, ["4:1"]);
  assert.match(linked.text, /^Systolic blood pressure/);
  assert.deepEqual(cellAt(baseline, 4, 1).fn, ["a"]);
  assert.equal(clinical.text.slice(linked.start, linked.end).includes("Systolic blood pressure"), true);
  // The `*` line has no cell carrying `*`: it stays a note, unlinked, and the table says so.
  assert.deepEqual(baseline.footnotes.find((note) => note.marker === "*").cells, []);
  assert.equal(baseline.orphanNotes, 1);
  assert.deepEqual(baseline.orphanMarkers, []);
  // A table-level note is kept as text, never read for meaning.
  assert.match(baseline.notes[0].text, /^Data are n \(%\) unless stated/);
});

test("a cell that looks numeric and fits no closed format is counted unextracted, with its text kept", () => {
  const outcomes = table(clinical.tables, "tbl-2");
  assert.equal(outcomes.unextracted, 1);
  const stray = cellAt(outcomes, 6, 4);
  assert.equal(stray.t, "1.1.2");
  assert.equal(stray.v, undefined);
  // "not estimable" is a missing marker, a typed cell that is not a value.
  assert.deepEqual(cellAt(outcomes, 5, 4).v, { kind: "missing", mark: "not estimable" });
  assert.ok(!materialTableValues(outcomes).some((cell) => cell.v.kind === "missing"));
});

test("closed formats: what each cell shape parses to, and what it never guesses", () => {
  const parse = (text, context, row) => parseMaterialCell(text, context, row)?.value;
  assert.deepEqual(parse("12 (34.5%)"), { kind: "count_percent", n: 12, percent: 34.5 });
  assert.deepEqual(parse("1,234"), { kind: "number", x: 1234 });
  assert.deepEqual(parse("−0.5"), { kind: "number", x: -0.5 });
  assert.deepEqual(parse("34.5 %"), { kind: "percent", x: 34.5 });
  assert.deepEqual(parse("0.82 (0.64 to 0.97)"), { kind: "estimate_interval", estimate: 0.82, lower: 0.64, upper: 0.97 });
  assert.deepEqual(parse("1.37 (1·16, 1·59)"), { kind: "estimate_interval", estimate: 1.37, lower: 1.16, upper: 1.59 });
  assert.deepEqual(parse("61.2 ± 9.8"), { kind: "mean_sd", mean: 61.2, sd: 9.8 });
  assert.deepEqual(parse("5–12"), { kind: "interval", lower: 5, upper: 12 });
  assert.deepEqual(parse("P<0.05"), { kind: "p_value", operator: "<", p: 0.05 });
  assert.deepEqual(parse("3/4"), { kind: "fraction", n: 3, N: 4, denominator: { n: 4, basis: "cell" } });
  assert.deepEqual(parse("NA"), { kind: "missing", mark: "NA" });
  // A parenthesis whose meaning nothing states stays a pair; a header that says SD makes it mean and SD.
  assert.deepEqual(parse("7.2 (0.9)"), { kind: "paren_pair", lead: 7.2, inner: 0.9 });
  assert.deepEqual(parse("7.2 (0.9)", { hints: new Set(["mean_sd"]) }), { kind: "mean_sd", mean: 7.2, sd: 0.9 });
  // With the header's N the pair carries the arithmetic as a fact, not as a meaning.
  assert.equal(parse("12 (10.0)", { denominator: 120, hints: new Set() }).asPercentOfDenominator.consistent, true);
  // A hyphen between digits is not an interval (it may be a sign, an id or a date): it stays text, and is counted unextracted by the table.
  assert.equal(parse("12-34"), null);
  // A decimal comma and a bare word are not guessed.
  assert.equal(parse("12,5"), null);
  assert.equal(parse("improved"), null);
  assert.equal(parseMaterialCell("   "), undefined);
  // A trailing footnote marker is not part of the number.
  assert.deepEqual(parseMaterialCell("0.03*").value, { kind: "number", x: 0.03 });
  assert.deepEqual(parseMaterialCell("0.03*").markers, ["*"]);
  assert.deepEqual(parseMaterialCell("12<sup>a,b</sup>").markers, ["a", "b"]);
  assert.deepEqual(parseMaterialCell("12ᵃ").markers, ["a"]);
});

test("a table that continues over a page is a possible continuation unless the text says so", () => {
  const found = deriveMarkdownStructure({ text: fixture("continued-table.md") });
  // Same header, only a page footer between them: possibly one table, said as ambiguous.
  assert.deepEqual(table(found.tables, "tbl-2").continuation, { prior: "tbl-1", basis: "same_header", certainty: "ambiguous" });
  assert.equal(table(found.tables, "tbl-1").continuedBy, "tbl-2");
  // "(continued)" in the caption is the document's own statement.
  assert.deepEqual(table(found.tables, "tbl-4").continuation, { prior: "tbl-3", basis: "caption_marker", certainty: "stated" });
  // A caption belongs to the table below it; the next table's caption is not taken as the previous table's.
  assert.equal(table(found.tables, "tbl-2").caption, undefined);
  assert.equal(table(found.tables, "tbl-3").caption.label, "Table 5");
  assert.equal(table(found.tables, "tbl-3").caption.placement, "before");
  // Two tables of unlike headers are not continuations of each other.
  assert.equal(table(found.tables, "tbl-3").continuation, undefined);
});

test("an HTML table is not read: it is a unit counted unextracted, with the digits it held", () => {
  const found = deriveMarkdownStructure({ text: fixture("continued-table.md") });
  const html = table(found.tables, "tbl-5");
  assert.equal(html.status, "unextracted");
  assert.equal(html.reason, "html_table");
  assert.equal(html.valueCandidates, 2);
  const counts = materialTableCounts(html, "flow");
  assert.deepEqual(counts, { total: 2, located: 0, ambiguous: 0, unlocated: 0, unextracted: 2, failed: 0 });
});

test("figures need a caption in a closed format; their axes and values are unknown, never invented", () => {
  assert.equal(clinical.figures.length, 1);
  const [figure] = clinical.figures;
  assert.equal(figure.label, "Figure 2");
  assert.equal(clinical.text.slice(figure.caption.start, figure.caption.end).startsWith("Figure 2."), true);
  assert.deepEqual(figure.axes, { status: "unknown", reason: "no_digitization" });
  assert.deepEqual(figure.values, { status: "unknown", reason: "no_digitization" });
  // "Figure 3 shows ..." is a sentence that mentions a figure, not a caption.
  assert.ok(!clinical.figures.some((entry) => entry.label === "Figure 3"));
  const image = deriveMarkdownStructure({ text: "![Kaplan-Meier curve](figs/km.png)\n\nFig. 4: Survival by arm.\n" });
  assert.equal(image.figures.length, 2);
  assert.equal(image.figures[0].image.ref, "figs/km.png");
  assert.equal(image.figures[1].label, "Fig. 4");
});

test("a supplement reference is listed unlinked with its reason, and linked only to a table the text itself holds", () => {
  assert.deepEqual(clinical.supplements.map((entry) => [entry.label, entry.linked, entry.reason]), [
    ["Supplementary Table S2", "unknown", "supplement_not_attached"],
    ["Supplementary Figure S1", "unknown", "supplement_not_attached"],
  ]);
  const own = deriveMarkdownStructure({ text: "See Supplementary Table S1.\n\nSupplementary Table S1. Details\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n" });
  assert.deepEqual(own.supplements[0].linked, { tableId: "tbl-1" });
});

test("tables inside a code fence are not tables, and a table past the cap is counted, not dropped", () => {
  assert.equal(deriveMarkdownStructure({ text: "```\n| a | b |\n| - | - |\n| 1 | 2 |\n```\n" }).tables.length, 0);
  const row = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n";
  const many = deriveMarkdownStructure({ text: row.repeat(402) });
  assert.equal(many.tables.length, 402);
  assert.equal(many.tables.filter((entry) => entry.status === "structured").length, 400);
  const overflow = many.tables[401];
  assert.deepEqual([overflow.status, overflow.reason, overflow.valueCandidates], ["unextracted", "table_limit", 2]);
  assert.ok(many.limits.includes("table_limit"));
});

test("a table too large for one record keeps its first cells and counts the rest", () => {
  const rows = Array.from({ length: 2000 }, (_, index) => `| row ${index} | ${index} | ${index + 1} |`).join("\n");
  const found = deriveMarkdownStructure({ text: `| h | a | b |\n| - | - | - |\n${rows}\n` });
  const [big] = found.tables;
  assert.equal(big.cells.length, 3000);
  assert.ok(big.truncated.rows < 2000 && big.truncated.of === 2000);
  assert.ok(big.unextracted > 0, "the cells past the cap with numbers in them are counted");
  assert.ok(found.limits.includes("cell_limit"));
});

test("delimited text: exact addresses and spans, quoted newlines, a header read as a candidate only", () => {
  const raw = fixture("supplement.csv");
  const found = deriveDelimitedStructure({ text: raw });
  const [sheet] = found.tables;
  assert.equal(sheet.kind, "delimited");
  assert.deepEqual(sheet.header, { row: 1, basis: "first_row_text_then_numbers", declared: false });
  for (const cell of sheet.cells) assert.equal(found.text.slice(cell.s, cell.e).replace(/^"|"$/g, "").replaceAll('""', '"'), cell.t);
  assert.equal(cellAt(sheet, 5, 6).t, "two\nlines");
  assert.equal(cellAt(sheet, 5, 6).a, "F5");
  assert.deepEqual(cellAt(sheet, 2, 4).v, { kind: "number", x: 7.1, unit: "%", timepoint: { unit: "week", n: 12 } });
  assert.equal(cellAt(sheet, 2, 3).v.unit, "years");
  // An empty field has no cell, and an identifier that has digits in it is a label.
  assert.equal(cellAt(sheet, 5, 3), undefined);
  assert.equal(sheet.unextracted, 0);
  assert.equal(sheet.spans, "none");
});

test("spreadsheet cells: the sheet address is the location, a formula nobody computed has no value, merged ranges are recorded", () => {
  const found = deriveSheetStructure({
    sheets: [
      {
        name: "Table S2", state: "visible", merges: ["A1:C1"], dimensions: { rows: 4, cols: 3 },
        cells: [
          { a: "A1", k: "s", v: "Arm" }, { a: "B1", k: "s", v: "n (%)" }, { a: "C1", k: "s", v: "Rate, %" },
          { a: "A2", k: "s", v: "Drug" }, { a: "B2", k: "s", v: "12 (40.0)" }, { a: "C2", k: "n", v: 0.4, nf: "0.0%" },
          { a: "A3", k: "s", v: "Placebo" }, { a: "B3", k: "n", v: 9 }, { a: "C3", k: "n", v: 9.5, f: "=SUM(B3:B4)" },
          { a: "A4", k: "s", v: "Total" }, { a: "B4", k: "e", v: "#DIV/0!" }, { a: "C4", k: "n", v: null, f: "=B4/B3" },
        ],
      },
      { name: "Hidden", state: "hidden", cells: [{ a: "A1", k: "s", v: "x" }] },
    ],
  });
  const [first, second] = found.tables;
  assert.equal(first.kind, "sheet");
  assert.equal(first.name, "Table S2");
  assert.deepEqual(first.merges, ["A1:C1"]);
  assert.equal(first.spans, "merged_ranges");
  assert.deepEqual(first.header, { row: 1, basis: "first_row_text_then_numbers", declared: false });
  assert.equal(cellAt(first, 2, 2).a, "B2");
  // The number the workbook stores is the number; its display format is kept beside it.
  assert.deepEqual(cellAt(first, 2, 3).v, { kind: "number", x: 0.4, numberFormat: "0.0%", unit: "%" });
  assert.equal(cellAt(first, 2, 2).v.kind, "count_percent");
  assert.deepEqual(cellAt(first, 4, 2).v, { kind: "error", code: "#DIV/0!" });
  // A formula with no cached value is a cell with its formula and no value.
  const uncomputed = cellAt(first, 4, 3);
  assert.equal(uncomputed.formula, "=B4/B3");
  assert.equal(uncomputed.v, undefined);
  assert.equal(cellAt(first, 3, 3).formula, "=SUM(B3:B4)");
  assert.equal(second.sheetState, "hidden");
  assert.equal(second.start, null, "a sheet has no character span");
  assert.equal(materialAddress(27, 12), "AA12");
  assert.deepEqual(materialAddressParts("AA12"), { r: 12, c: 27 });
  assert.equal(materialAddressParts("12A"), null);
});

test("a format is located by page, sheet address, delimited position, place in the text, or not at all (an image)", () => {
  assert.deepEqual(["pdf", "docx", "xlsx", "csv", "md", "html", "png"].map(sourceMaterialsPagination), ["paginated", "paginated", "sheet", "delimited", "flow", "flow", "image"]);
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** The text layer of a table's rows, one line per row, as a PDF writes a row. @param {any} found @param {(cell:any)=>string} [map] */
function rowsText(found, map = (cell) => cell.t) {
  const lines = new Map();
  for (const cell of found.cells) lines.set(cell.r, [...(lines.get(cell.r) ?? []), cell]);
  return [...lines.values()].map((cells) => cells.sort((a, b) => a.c - b.c).map(map).join(" ")).join("\n");
}

test("a row found on exactly one page is on that page; on several it is ambiguous with the candidates; nowhere, unknown", () => {
  const baseline = table(clinical.tables, "tbl-1");
  const outcomes = table(clinical.tables, "tbl-2");
  const pages = [
    { page: 1, text: `SAMPLE-1 trial\nTable 2. Baseline characteristics of the study population\n${rowsText(baseline)}` },
    // Page 2 repeats the first table's "Smoker" row (as a running total) and holds the outcomes table, minus its last row.
    { page: 2, text: `Table 3. Primary and secondary outcomes at week 24\n${rowsText(outcomes).split("\n").slice(0, -1).join("\n")}\n${rowsText(baseline).split("\n")[7]}` },
    { page: 3, text: "Discussion of the findings, nothing tabular." },
  ];
  const located = locateUnitsOnPages({ tables: clinical.tables, figures: clinical.figures, pages });
  const first = located.tables[0];
  assert.deepEqual(first.page, { status: "located", pages: [1], basis: "rows" });
  assert.deepEqual(materialRowPage(first, 3), { status: "located", pages: [1], basis: "row_text" });
  // The repeated row is on two pages: ambiguous, never resolved by order.
  assert.deepEqual(materialRowPage(first, 8), { status: "ambiguous", candidates: [1, 2], basis: "row_text" });
  assert.deepEqual(located.tables[1].page, { status: "located", pages: [2], basis: "rows" });
  // The outcomes table's last row is on no page with a text layer: unknown, with no scan to blame.
  assert.deepEqual(materialRowPage(located.tables[1], 6), { status: "unknown", reason: "no_match" });
  // The HTML table is not requested.
  assert.deepEqual(located.tables[0].rowPages.at(0), { from: 1, to: 1, status: "located", pages: [1], basis: "row_text" });
  assert.equal(located.info.status, "mapped");
  assert.equal(located.info.pageCount, 3);
  // The figure's caption is found on no page: unknown.
  assert.equal(located.figures[0].page.status, "unknown");
});

test("a row whose cells come out of the text layer in another order is placed by its cells, as a weaker basis", () => {
  const baseline = table(clinical.tables, "tbl-1");
  const lines = new Map();
  for (const cell of baseline.cells) lines.set(cell.r, [...(lines.get(cell.r) ?? []), cell.t]);
  // Each row's cells reach the text layer last-column-first.
  const scrambled = [...lines.values()].map((cells) => cells.reverse().join(" ")).join("\n");
  const located = locateUnitsOnPages({ tables: [baseline], pages: [{ page: 4, text: scrambled }] });
  const page = materialRowPage(located.tables[0], 3);
  assert.equal(page.status, "located");
  assert.deepEqual(page.pages, [4]);
  assert.equal(page.basis, "cell_text");
});

test("a scan has no text layer: the page is unknown for that reason, and the document is said to have none", () => {
  const scanned = deriveMarkdownStructure({ text: fixture("scanned-page.md") });
  const none = locateUnitsOnPages({ tables: scanned.tables, pages: [{ page: 1, text: "", hasTextLayer: false }, { page: 2, text: "   " }] });
  assert.equal(none.info.status, "no_text_layer");
  assert.deepEqual(none.info.noTextLayerPages, [1, 2]);
  assert.deepEqual(none.tables[0].page, { status: "unknown", reason: "no_text_layer" });
  // A mixed document: a row not found while some page has no text layer may sit on that page.
  const mixed = locateUnitsOnPages({ tables: scanned.tables, pages: [{ page: 1, text: "A page of prose with nothing tabular in it at all." }, { page: 2, text: "", hasTextLayer: false }] });
  assert.equal(mixed.info.status, "mapped");
  assert.deepEqual(materialRowPage(mixed.tables[0], 3), { status: "unknown", reason: "no_text_layer" });
});

test("the locator spends a bounded number of row lookups and says when it stopped", () => {
  const baseline = table(clinical.tables, "tbl-1");
  const big = { ...baseline, cells: Array.from({ length: 31_000 }, (_, index) => ({ r: index + 1, c: 1, t: `row number ${index}` })) };
  const located = locateUnitsOnPages({ tables: [big], pages: [{ page: 1, text: "nothing relevant here" }] });
  assert.equal(located.info.budgetSpent, true);
  assert.equal(materialRowPage(located.tables[0], 30_500).reason, "locator_budget");
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test("the ledger counts values as located, ambiguous, unlocated, unextracted and failed, and always adds up", () => {
  const baseline = table(clinical.tables, "tbl-1");
  const outcomes = table(clinical.tables, "tbl-2");
  const pages = [
    { page: 1, text: rowsText(baseline) },
    { page: 2, text: rowsText(outcomes).split("\n").slice(0, 4).join("\n") + "\n" + rowsText(baseline).split("\n")[2] },
  ];
  const located = locateUnitsOnPages({ tables: clinical.tables, figures: clinical.figures, pages });
  const coverage = sourceMaterialsCoverage({
    tables: located.tables, figures: located.figures, supplements: clinical.supplements, pagination: "paginated", format: "pdf",
    pages: located.info.status === "mapped" ? { status: "mapped", pageCount: 2, textLayerPages: 2 } : { status: "no_text_layer" },
    extraction: { parser: "evimed-extract@0.5.0" }, sourceSha256: "a".repeat(64), textSha256: "b".repeat(64),
  });
  assert.deepEqual(sourceMaterialsCoverageIssues(coverage), []);
  assert.equal(coverage.extraction.materials, "evimed-materials@1");
  assert.equal(coverage.extraction.parser, "evimed-extract@0.5.0");
  assert.equal(coverage.sourceSha256, "a".repeat(64));
  assert.equal(coverage.values.total, coverage.values.located + coverage.values.ambiguous + coverage.values.unlocated + coverage.values.unextracted + coverage.values.failed);
  // Rows on one page are located; the repeated Male row is ambiguous (pages 1 and 2); the outcomes table's two last rows are on no page.
  assert.ok(coverage.values.located > 20);
  assert.ok(coverage.values.ambiguous > 0);
  assert.ok(coverage.values.unlocated > 0);
  assert.equal(coverage.values.unextracted, 1, "the 1.1.2 cell");
  assert.equal(coverage.values.failed, 0);
  assert.equal(coverage.status, "partial", "an unextracted value is a partial extraction");
  assert.deepEqual(coverage.tables, { total: 2, structured: 2, unextracted: 0, failed: 0, continued: 0, continuedAmbiguous: 0 });
  assert.deepEqual(coverage.figures, { total: 1, captioned: 1, valuesKnown: 0 });
  assert.deepEqual(coverage.footnotes, { linked: 1, orphanMarkers: 0, orphanNotes: 1 });
  assert.equal(coverage.origin, "reported");
  assert.ok(coverage.reasons.includes("figures_not_digitized"));
});

test("without pages a PDF's values are unlocated, not located: their table and cell are known, which is not a place in the document", () => {
  const coverage = sourceMaterialsCoverage({
    tables: clinical.tables, figures: [], pagination: "paginated", format: "pdf",
    pages: { status: "unavailable", reason: "locator_unavailable" }, extraction: {},
  });
  assert.equal(coverage.values.located, 0);
  assert.equal(coverage.values.unlocated, coverage.values.total - coverage.values.unextracted);
  assert.ok(coverage.reasons.includes("locator_unavailable"));
  // The same tables in a spreadsheet or a text file are located by their address.
  const flow = sourceMaterialsCoverage({ tables: clinical.tables, pagination: "flow", format: "md", pages: { status: "not_paginated" }, extraction: {} });
  assert.equal(flow.values.unlocated, 0);
  assert.equal(flow.values.located, flow.values.total - flow.values.unextracted);
});

test("a scanned document or an image says its values are OCR readings of unknown uncertainty and puts them unlocated", () => {
  const scanned = deriveMarkdownStructure({ text: fixture("scanned-page.md") });
  const image = sourceMaterialsCoverage({ tables: scanned.tables, pagination: "image", format: "png", pages: { status: "not_paginated" }, extraction: {} });
  assert.equal(image.origin, "ocr");
  assert.equal(image.uncertainty, "unknown");
  assert.equal(image.values.located, 0);
  assert.equal(image.values.unlocated, image.values.total - image.values.unextracted);
  assert.equal(image.values.unextracted, 1, "28.O is digits and a letter: the OCR's reading, kept as text");
  assert.ok(image.reasons.includes("scanned_or_image_source"));
  const pdf = sourceMaterialsCoverage({ tables: scanned.tables, pagination: "paginated", format: "pdf", pages: { status: "no_text_layer", pageCount: 3 }, extraction: {} });
  assert.equal(pdf.origin, "ocr");
  assert.equal(pdf.values.located, 0);
});

test("a failed derivation is counted failed, and the ledger refuses what does not add up", () => {
  const failed = { kind: "table", status: "unextracted", reason: "derivation_failed", valueCandidates: 5 };
  const coverage = sourceMaterialsCoverage({ tables: [failed], pagination: "flow", format: "md", pages: { status: "not_paginated" }, extraction: {} });
  assert.deepEqual(coverage.values, { total: 5, located: 0, ambiguous: 0, unlocated: 0, unextracted: 0, failed: 5 });
  assert.equal(coverage.tables.failed, 1);
  const broken = { ...coverage, values: { ...coverage.values, located: 1 } };
  assert.match(sourceMaterialsCoverageIssues(broken).join(" "), /does not add up/);
  assert.match(sourceMaterialsCoverageIssues({ ...coverage, sourceSha256: "nope" }).join(" "), /SHA-256/);
  assert.match(sourceMaterialsCoverageIssues({ ...coverage, pages: { status: "pretty" } }).join(" "), /pages.status/);
  assert.match(sourceMaterialsCoverageIssues(null).join(" "), /object/);
});

// ---------------------------------------------------------------------------
// Where a quotation sits
// ---------------------------------------------------------------------------

test("a quotation inside one cell resolves to that table, row and cell; across a row, to the row", () => {
  const text = fixture("clinical-table.md");
  const found = locateQuoteInText({ text, quote: "69 (58.5)", matches: quoteIsPresent });
  assert.equal(found.status, "located");
  assert.equal(found.table.label, "Table 2");
  assert.equal(found.row, 3);
  assert.deepEqual(found.cell, { row: 3, column: 3, header: "Study drug (n=118)" });
  assert.deepEqual(found.page, { status: "unknown", reason: "no_page_markers" });
  const across = locateQuoteInText({ text, quote: "Male sex, n (%) 72 (60.0)", matches: quoteIsPresent });
  assert.equal(across.row, 3);
  assert.equal(across.cell, undefined);
  assert.equal(across.table.id, "tbl-1");
});

test("a quotation that appears in prose has no table and says so; one in two tables is ambiguous, not picked", () => {
  const text = fixture("clinical-table.md");
  const prose = locateQuoteInText({ text, quote: "Participants were randomised 1:1 to the study drug or placebo for 24 weeks", matches: quoteIsPresent });
  assert.deepEqual(prose, { status: "unknown", page: { status: "unknown", reason: "no_page_markers" }, reason: "not_in_a_table" });
  const twice = locateQuoteInText({ text: "| a | b |\n| - | - |\n| shared value 42 | x |\n\n| c | d |\n| - | - |\n| shared value 42 | y |\n", quote: "shared value 42", matches: quoteIsPresent });
  assert.equal(twice.status, "ambiguous");
  assert.deepEqual(twice.candidates.map((entry) => entry.id), ["tbl-1", "tbl-2"]);
});

test("a text with page markers gives a quotation its page, and a quotation spanning a page break none", () => {
  const text = "<!-- page 1 -->\nIntro line one.\n<!-- page 2 -->\n| a | b |\n| - | - |\n| Total events | 41 (34.7) |\n<!-- page 3 -->\nClosing remarks about adverse events.\n";
  const cell = locateQuoteInText({ text, quote: "41 (34.7)", matches: quoteIsPresent });
  assert.deepEqual(cell.page, { status: "located", pages: [2], basis: "page_marker" });
  assert.equal(cell.cell.address, undefined);
  assert.equal(cell.cell.column, 2);
  const prose = locateQuoteInText({ text, quote: "Closing remarks about adverse events.", matches: quoteIsPresent });
  assert.equal(prose.status, "located");
  assert.deepEqual(prose.page.pages, [3]);
  const split = locateQuoteInText({ text, quote: "Intro line one. | a | b |", matches: quoteIsPresent });
  assert.equal(split.page.status, "unknown");
});

test("a stored page for a row is reported with the cell it places", () => {
  const baseline = table(clinical.tables, "tbl-1");
  const located = locateUnitsOnPages({ tables: [baseline], pages: [{ page: 7, text: rowsText(baseline) }] });
  const found = locateQuoteInText({ text: clinical.text, quote: "69 (58.5)", matches: quoteIsPresent, structure: { tables: located.tables } });
  assert.deepEqual(found.page, { status: "located", pages: [7], basis: "row_text" });
});

test("a skeleton compares letters and digits and nothing else", () => {
  assert.equal(materialSkeleton("Dis-\nease  (n = 12)."), "disease" + "n12");
  assert.equal(materialSkeleton("ﬁrst １２ 表 2"), "first12表2");
});
