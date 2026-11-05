import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { createLocalDocumentReader, sheetsToText } from "../src/documentLocalReader.mjs";
import { DocumentParserClient } from "../src/documentParserClient.mjs";
import { vcrIntakeDirectory } from "../src/vcrIntakeController.mjs";
import { contractSamplePdf, SAMPLE_TEXT } from "../../../scripts/ops/record-parser-contract.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "../../../runtime/mcp/evimed-research/source_material_extract.py");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const python = spawnSync("python3", ["-c", "import pypdf, openpyxl"], { encoding: "utf8" });
const havePython = python.status === 0;

/**
 * The runtime controller's `materials` operation without the container: the same script, run on the same staged
 * attempt, by the host's python. What is not exercised here is Docker itself (the mounts, the network and memory
 * ceilings), which `vcrIntakeController.test.mjs` asserts over the launch plan and the live check covers.
 */
function scriptController(config, calls) {
  return {
    async runVcrIntake(kind, reference) {
      calls.push(kind);
      const dir = vcrIntakeDirectory(config, kind, reference.attemptId);
      await run("python3", [SCRIPT, "--request", path.join(dir, "input", "request.json"), "--input-dir", path.join(dir, "input"),
        "--output-dir", path.join(dir, "output"), "--deadline", "60"]);
      return { finished: true };
    },
  };
}

/** Real office files, written by the libraries that write them. */
async function officeFiles(directory) {
  const script = `
import sys, openpyxl, zipfile
d = sys.argv[1]
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Doses"
ws["A1"] = "drug"; ws["B1"] = "dose mg"; ws["A2"] = "rivaroxaban"; ws["B2"] = 15; ws["C3"] = "far cell"
wb.create_sheet("Empty")
wb.save(d + "/dose.xlsx")
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
with zipfile.ZipFile(d + "/note.docx", "w") as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="%s"><w:body><w:p><w:r><w:t>Methods</w:t></w:r></w:p><w:p><w:r><w:t>Rivaroxaban 15 mg qd</w:t></w:r></w:p></w:body></w:document>' % W)
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
with zipfile.ZipFile(d + "/deck.pptx", "w") as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    for n, t in ((1, "First slide"), (2, "Second slide")):
        z.writestr("ppt/slides/slide%d.xml" % n, '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="%s" xmlns:p="urn:p"><a:p><a:r><a:t>%s</a:t></a:r></a:p></p:sld>' % (A, t))
    z.writestr("ppt/presentation.xml", '<?xml version="1.0"?><p:presentation xmlns:p="urn:p"/>')
`;
  await run("python3", ["-c", script, directory]);
  return { xlsx: await readFile(path.join(directory, "dose.xlsx")), docx: await readFile(path.join(directory, "note.docx")), pptx: await readFile(path.join(directory, "deck.pptx")) };
}

async function setup(t) {
  const dataDir = await mkdtemp("/tmp/evimed-local-reader-");
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir };
  const calls = [];
  const reader = createLocalDocumentReader({ config, controller: scriptController(config, calls) });
  return { dataDir, config, calls, reader };
}

test("a real PDF is read page by page through the staged-attempt path, with [Page N] lines the page map is built on", { skip: !havePython }, async (t) => {
  const { reader, calls } = await setup(t);
  const pdf = contractSamplePdf();
  const read = await reader.read({ bytes: pdf, name: "sample.pdf", sha256: sha(pdf), format: "pdf" });
  assert.deepEqual(calls, ["materials"]);
  assert.equal(read.text, `[Page 1]\n${SAMPLE_TEXT}`);
  assert.deepEqual(read.pageMap, [{ page: 1, start: 9, end: 9 + SAMPLE_TEXT.length, status: "ok" }]);
  assert.equal(read.text.slice(read.pageMap[0].start, read.pageMap[0].end), SAMPLE_TEXT);
});

test("a real DOCX, PPTX and XLSX are read as text with the markers the service writes", { skip: !havePython }, async (t) => {
  const { reader, dataDir } = await setup(t);
  const files = await officeFiles(dataDir);
  const docx = await reader.read({ bytes: files.docx, name: "note.docx", sha256: sha(files.docx), format: "docx" });
  assert.equal(docx.text, "Methods\nRivaroxaban 15 mg qd");
  assert.equal("pageMap" in docx, false, "a Word file has no page source, and none is invented");
  const pptx = await reader.read({ bytes: files.pptx, name: "deck.pptx", sha256: sha(files.pptx), format: "pptx" });
  assert.equal(pptx.text, "[Slide 1]\nFirst slide\n\n[Slide 2]\nSecond slide");
  const xlsx = await reader.read({ bytes: files.xlsx, name: "dose.xlsx", sha256: sha(files.xlsx), format: "xlsx" });
  assert.equal(xlsx.text, "[Sheet: Doses]\ndrug\tdose mg\nrivaroxaban\t15\n\t\tfar cell\n\n[Sheet: Empty]\n");
});

test("a PDF with no text layer yields no text at all: not the page markers around nothing, and nothing made up", { skip: !havePython }, async (t) => {
  const { reader, dataDir } = await setup(t);
  // A page with no content stream, written by the library that writes PDFs: how a scan reads when its ink is an image.
  const file = path.join(dataDir, "blank.pdf");
  await run("python3", ["-c", "import sys; from pypdf import PdfWriter; w = PdfWriter(); w.add_blank_page(612, 792); w.write(sys.argv[1])", file]);
  const blank = await readFile(file);
  const read = await reader.read({ bytes: blank, name: "scan.pdf", sha256: sha(blank), format: "pdf" });
  assert.equal(read.text, "");
  assert.equal("pageMap" in read, false);
});

test("a document the container refuses is a named failure, and the container is told nothing of the file's content", { skip: !havePython }, async (t) => {
  const { reader } = await setup(t);
  const notPdf = Buffer.from("this is not a pdf at all");
  await assert.rejects(reader.read({ bytes: notPdf, name: "a.pdf", sha256: sha(notPdf), format: "pdf" }),
    (error) => error.code === "document_local_read_refused" && /not_pdf/.test(error.message) && !/this is not/.test(error.message));
  await assert.rejects(reader.read({ bytes: notPdf, name: "a.rtf", sha256: sha(notPdf), format: "rtf" }), { code: "document_local_read_unsupported" });
});

test("without an intake controller there is nothing to read with, and the client reports the service's own failure", async () => {
  const reader = createLocalDocumentReader({ config: { dataDir: "/tmp/none" }, controller: null });
  assert.equal(reader.available, false);
  await assert.rejects(reader.read({ bytes: Buffer.from("x"), name: "a.pdf", sha256: sha(Buffer.from("x")), format: "pdf" }), { code: "document_local_read_unavailable" });
  const parser = new DocumentParserClient({ localReader: reader });
  await assert.rejects(parser.parseBytes({ bytes: Buffer.from("%PDF-1.4"), filename: "a.pdf" }), { code: "source_parser_unconfigured" });
});

test("the whole fallback, end to end: no parser configured, a real PDF in, protocol v1 with its page map and the local label out", { skip: !havePython }, async (t) => {
  const { reader } = await setup(t);
  const pdf = contractSamplePdf();
  const result = await new DocumentParserClient({ localReader: reader }).parseBytes({ bytes: pdf, filename: "指南.pdf", sha256: sha(pdf) });
  assert.equal(result.protocolVersion, 1);
  assert.deepEqual([result.extractor.name, result.extractor.parser, result.extractor.fallbackFor], ["evimed-local-reader", "local-fallback", "source_parser_unconfigured"]);
  assert.equal(result.text, `[Page 1]\n${SAMPLE_TEXT}`);
  assert.equal(result.pageMap.length, 1);
  assert.equal(result.units[0].status, "extracted");
});

test("a sheet's cells are laid out by their addresses: rows in order, gaps as empty cells, a formula nobody computed as nothing", () => {
  const text = sheetsToText([{ name: "S", cells: [{ a: "B2", k: "n", v: 2 }, { a: "A1", k: "s", v: "x\ty" }, { a: "C2", k: "n", v: null }, { a: "A2", k: "s", v: "a" }] }]);
  assert.equal(text, "[Sheet: S]\nx y\na\t2");
});
