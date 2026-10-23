import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { crc32, deflateRawSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactShapesMatch } from "@evimed/domain";
import { readArtifactShapes, shapeOfBytes, zipPackage } from "../src/artifactShapes.mjs";

/** A zip package from named entries, half of them deflated, as Office writes them. @param {Record<string, string>} entries */
function zipOf(entries) {
  /** @type {Buffer[]} */
  const parts = [];
  /** @type {Buffer[]} */
  const directory = [];
  let offset = 0;
  let index = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, "utf8");
    const method = index % 2 === 0 ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
    index += 1;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(index, 8); end.writeUInt16LE(index, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, central, end]));
}

const paragraph = (style, text) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

test("a Word file's shape is its headings, not its prose", () => {
  const docx = zipOf({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<w:document><w:body>${paragraph("Title", "Weekly report")}${paragraph("Normal", "Body text that is not a label")}`
      + `${paragraph("Heading1", "Summary")}${paragraph("Heading2", "Findings &amp; limits")}${paragraph("标题 1", "下周计划")}</w:body></w:document>`,
  });
  assert.deepEqual(shapeOfBytes("reports/weekly.docx", docx), { format: "docx", labels: ["weekly report", "summary", "findings & limits", "下周计划"] });
});

test("a deck's shape is its slide titles in order; a slide with no title shape adds none", () => {
  const slide = (title) => `<p:sld><p:cSld><p:spTree>${title ? `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` : ""}`
    + `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Not a title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const pptx = zipOf({
    "[Content_Types].xml": "<Types/>",
    "ppt/slides/slide10.xml": slide("Next steps"),
    "ppt/slides/slide2.xml": slide("Method"),
    "ppt/slides/slide1.xml": slide("Background"),
    "ppt/slides/slide3.xml": slide(""),
  });
  assert.deepEqual(shapeOfBytes("deck.pptx", pptx)?.labels, ["background", "method", "next steps"]);
});

test("a workbook's shape is its sheet names and the header row of the first sheet", () => {
  const xlsx = zipOf({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": `<workbook><sheets><sheet name="Budget" sheetId="1"/><sheet name="Notes" sheetId="2"/></sheets></workbook>`,
    "xl/sharedStrings.xml": "<sst><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Owner</t></r></si></sst>",
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Due</t></is></c></row>`
      + `<row r="2"><c r="A2" t="s"><v>2</v></c></row></sheetData></worksheet>`,
  });
  assert.deepEqual(shapeOfBytes("budget.xlsx", xlsx)?.labels, ["sheet budget", "sheet notes", "item", "cost", "due"]);
});

test("a script's shape is its top-level definitions, a table's its header, a note's its headings", () => {
  const code = (text) => new Uint8Array(Buffer.from(text));
  assert.deepEqual(shapeOfBytes("tools/clean.py", code("import os\n\ndef load(path):\n    def inner(): pass\nclass Cleaner:\n    def method(self): pass\nasync def run():\n"))?.labels, ["load", "cleaner", "run"]);
  assert.deepEqual(shapeOfBytes("app.mjs", code("export async function start() {}\nexport default class App {}\nfunction local() {}\n"))?.labels, ["start", "app", "local"]);
  assert.deepEqual(shapeOfBytes("trial.csv", code('"Subject ID",Arm,Visit 2\n1,A,3\n'))?.labels, ["subject id", "arm", "visit #"]);
  assert.deepEqual(shapeOfBytes("plan.md", code("# Plan\n\ntext\n## Risks ##\n### Mitigation\n"))?.labels, ["plan", "risks", "mitigation"]);
  assert.deepEqual(shapeOfBytes("rows.json", code('[{"id":1,"name":"a"},{"id":2}]'))?.labels, ["id", "name"]);
  assert.deepEqual(shapeOfBytes("calc.R", code("area <- function(r) pi * r^2\nx <- 3\n"))?.labels, ["area"]);
});

test("a format with no structure, a corrupt package and an empty file have the format and no labels", () => {
  assert.deepEqual(shapeOfBytes("paper.pdf", new Uint8Array(Buffer.from("%PDF-1.7"))), { format: "pdf", labels: [] });
  assert.deepEqual(shapeOfBytes("broken.docx", new Uint8Array(Buffer.from("not a zip at all, but long enough to read a directory from"))), { format: "docx", labels: [] });
  assert.deepEqual(shapeOfBytes("empty.md", new Uint8Array(0)), { format: "md", labels: [] });
  assert.equal(shapeOfBytes("README", new Uint8Array(0))?.format, "other");
  assert.equal(zipPackage(new Uint8Array(4)), null);
});

test("two weekly reports of the same sections are one shape, a differently built report is not", () => {
  const report = (...headings) => zipOf({ "[Content_Types].xml": "<Types/>", "word/document.xml": `<w:body>${headings.map((heading) => paragraph("Heading1", heading)).join("")}</w:body>` });
  const week3 = shapeOfBytes("w3.docx", report("Summary Week 3", "Findings", "Next steps"));
  const week4 = shapeOfBytes("w4.docx", report("Summary Week 4", "Findings", "Next steps", "Questions"));
  const budget = shapeOfBytes("b.docx", report("Budget", "Risks", "Timeline"));
  assert.equal(artifactShapesMatch([week3], [week4]), true);
  assert.equal(artifactShapesMatch([week3], [budget]), false);
});

test("a run's files are read from its workspace, and a link, a missing file or an escape has no shape", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "shapes-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, "out"), { recursive: true });
  await writeFile(path.join(workspace, "out/plan.md"), "# Plan\n## Risks\n");
  await symlink("/etc/hostname", path.join(workspace, "out/link.md"));
  const shapes = await readArtifactShapes({ workspaceDir: workspace }, ["out/plan.md", "out/link.md", "out/missing.md", "../outside.md"]);
  assert.deepEqual(Object.keys(shapes), ["out/plan.md"]);
  assert.deepEqual(shapes["out/plan.md"].labels, ["plan", "risks"]);
});
